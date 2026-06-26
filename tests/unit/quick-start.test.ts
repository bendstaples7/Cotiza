import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentType, AdvisorMode } from '../../shared/src/types/enums.js';
import { buildMediaThumbnailPath } from '../../shared/src/media-urls.js';
import type { ContentSuggestion } from '../../shared/src/types/content.js';
import type { UserSettings } from '../../shared/src/types/user.js';
import type { MediaItem } from '../../shared/src/types/media.js';
import type { ChannelConstraints } from '../../shared/src/types/channel.js';
import { createMockD1 } from './helpers/mock-d1.js';
import { createMockR2 } from './helpers/mock-r2.js';
import type { MockD1Database } from './helpers/mock-d1.js';
import type { MockR2Bucket } from './helpers/mock-r2.js';

import { ContentAdvisor } from '../../worker/src/services/content-advisor.js';
import { MediaService } from '../../worker/src/services/media-service.js';
import { UserSettingsService } from '../../worker/src/services/user-settings-service.js';
import { InstagramChannel } from '../../worker/src/services/instagram-channel.js';

// Test fixtures

const ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const CONSTRAINTS: ChannelConstraints = {
  maxCaptionLength: 2200,
  maxHashtags: 30,
  maxCarouselImages: 10,
  maxReelDuration: 90,
  supportedMediaTypes: ['image/jpeg', 'image/png', 'video/mp4'],
  recommendedDimensions: {
    square: { width: 1080, height: 1080 },
    portrait: { width: 1080, height: 1350 },
    landscape: { width: 1080, height: 566 },
  },
};

const SMART_SETTINGS: UserSettings = {
  id: 'settings-1',
  userId: 'user-1',
  advisorMode: AdvisorMode.Smart,
  approvalMode: 'manual_review',
  updatedAt: new Date(),
};

const MANUAL_SETTINGS: UserSettings = {
  ...SMART_SETTINGS,
  advisorMode: AdvisorMode.Manual,
};

const SUGGESTION: ContentSuggestion = {
  contentType: ContentType.Testimonial,
  reason: "You haven't posted a Testimonial in 5 days -- time to mix it up!",
};

const MEDIA_ITEMS: MediaItem[] = [
  {
    id: 'media-1',
    userId: 'user-1',
    filename: 'kitchen.jpg',
    mimeType: 'image/jpeg',
    fileSizeBytes: 1024,
    storageKey: 'media/user-1/kitchen.jpg',
    thumbnailUrl: buildMediaThumbnailPath('media/user-1/kitchen.jpg'),
    source: 'uploaded',
    width: 1080,
    height: 1080,
    createdAt: new Date(),
  },
];

/**
 * Simulates the quick-start endpoint logic: fetches user settings,
 * runs advisor suggestion + media list in parallel, returns smart defaults.
 */
async function quickStart(
  userId: string,
  deps: {
    userSettingsService: UserSettingsService;
    contentAdvisor: ContentAdvisor;
    mediaService: MediaService;
    instagramChannel: InstagramChannel;
  },
) {
  const settings = await deps.userSettingsService.getSettings(userId);

  const [suggestion, mediaThumbnails] = await Promise.all([
    deps.contentAdvisor.suggest(userId, settings.advisorMode),
    deps.mediaService.list(userId, { page: 1, limit: 20 }),
  ]);

  const constraints = deps.instagramChannel.getConstraints();
  const preSelectedContentType = suggestion?.contentType ?? null;

  return {
    suggestion,
    mediaThumbnails,
    defaults: {
      contentType: preSelectedContentType,
      hashtagCount: constraints.maxHashtags,
      instagramFormat: {
        recommendedDimensions: constraints.recommendedDimensions,
        maxCaptionLength: constraints.maxCaptionLength,
        maxCarouselImages: constraints.maxCarouselImages,
        maxReelDuration: constraints.maxReelDuration,
        supportedMediaTypes: constraints.supportedMediaTypes,
      },
    },
  };
}

// Tests

describe('POST /posts/quick-start logic', () => {
  let db: MockD1Database;
  let r2: MockR2Bucket;
  let contentAdvisor: ContentAdvisor;
  let mediaService: MediaService;
  let userSettingsService: UserSettingsService;
  let instagramChannel: InstagramChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockD1();
    r2 = createMockR2();
    contentAdvisor = new ContentAdvisor(db as unknown as D1Database);
    mediaService = new MediaService(db as unknown as D1Database, r2 as unknown as R2Bucket);
    userSettingsService = new UserSettingsService(db as unknown as D1Database);
    instagramChannel = new InstagramChannel({
      db: db as unknown as D1Database,
      encryptionKey: ENCRYPTION_KEY,
      publicUrl: '',
    });

    vi.spyOn(instagramChannel, 'getConstraints').mockReturnValue(CONSTRAINTS);
  });

  it('returns suggestion, media thumbnails, and smart defaults for Smart mode', async () => {
    vi.spyOn(userSettingsService, 'getSettings').mockResolvedValue(SMART_SETTINGS);
    vi.spyOn(contentAdvisor, 'suggest').mockResolvedValue(SUGGESTION);
    vi.spyOn(mediaService, 'list').mockResolvedValue(MEDIA_ITEMS);

    const result = await quickStart('user-1', {
      userSettingsService,
      contentAdvisor,
      mediaService,
      instagramChannel,
    });

    expect(result.suggestion).toEqual(SUGGESTION);
    expect(result.mediaThumbnails).toHaveLength(1);
    expect(result.defaults.contentType).toBe(ContentType.Testimonial);
    expect(result.defaults.hashtagCount).toBe(30);
    expect(result.defaults.instagramFormat.maxCaptionLength).toBe(2200);
    expect(result.defaults.instagramFormat.recommendedDimensions).toEqual(CONSTRAINTS.recommendedDimensions);
  });

  it('returns null suggestion and null contentType for Manual mode', async () => {
    vi.spyOn(userSettingsService, 'getSettings').mockResolvedValue(MANUAL_SETTINGS);
    vi.spyOn(contentAdvisor, 'suggest').mockResolvedValue(null);
    vi.spyOn(mediaService, 'list').mockResolvedValue([]);

    const result = await quickStart('user-1', {
      userSettingsService,
      contentAdvisor,
      mediaService,
      instagramChannel,
    });

    expect(result.suggestion).toBeNull();
    expect(result.defaults.contentType).toBeNull();
    expect(result.mediaThumbnails).toEqual([]);
  });

  it('calls ContentAdvisor.suggest with the correct advisor mode', async () => {
    const suggestSpy = vi.spyOn(contentAdvisor, 'suggest').mockResolvedValue(SUGGESTION);
    vi.spyOn(userSettingsService, 'getSettings').mockResolvedValue(SMART_SETTINGS);
    vi.spyOn(mediaService, 'list').mockResolvedValue([]);

    await quickStart('user-1', {
      userSettingsService,
      contentAdvisor,
      mediaService,
      instagramChannel,
    });

    expect(suggestSpy).toHaveBeenCalledWith('user-1', AdvisorMode.Smart);
  });

  it('fetches first page of media with limit 20', async () => {
    vi.spyOn(userSettingsService, 'getSettings').mockResolvedValue(SMART_SETTINGS);
    vi.spyOn(contentAdvisor, 'suggest').mockResolvedValue(null);
    const listSpy = vi.spyOn(mediaService, 'list').mockResolvedValue([]);

    await quickStart('user-1', {
      userSettingsService,
      contentAdvisor,
      mediaService,
      instagramChannel,
    });

    expect(listSpy).toHaveBeenCalledWith('user-1', { page: 1, limit: 20 });
  });

  it('includes all Instagram format constraints in defaults', async () => {
    vi.spyOn(userSettingsService, 'getSettings').mockResolvedValue(SMART_SETTINGS);
    vi.spyOn(contentAdvisor, 'suggest').mockResolvedValue(null);
    vi.spyOn(mediaService, 'list').mockResolvedValue([]);

    const result = await quickStart('user-1', {
      userSettingsService,
      contentAdvisor,
      mediaService,
      instagramChannel,
    });

    const format = result.defaults.instagramFormat;
    expect(format.maxCaptionLength).toBe(2200);
    expect(format.maxCarouselImages).toBe(10);
    expect(format.maxReelDuration).toBe(90);
    expect(format.supportedMediaTypes).toEqual(['image/jpeg', 'image/png', 'video/mp4']);
  });

  it('uses Random mode advisor suggestion when settings are Random', async () => {
    const randomSettings: UserSettings = {
      ...SMART_SETTINGS,
      advisorMode: AdvisorMode.Random,
    };
    const randomSuggestion: ContentSuggestion = {
      contentType: ContentType.Education,
      reason: 'Randomly selected Education.',
    };

    vi.spyOn(userSettingsService, 'getSettings').mockResolvedValue(randomSettings);
    const suggestSpy = vi.spyOn(contentAdvisor, 'suggest').mockResolvedValue(randomSuggestion);
    vi.spyOn(mediaService, 'list').mockResolvedValue([]);

    const result = await quickStart('user-1', {
      userSettingsService,
      contentAdvisor,
      mediaService,
      instagramChannel,
    });

    expect(suggestSpy).toHaveBeenCalledWith('user-1', AdvisorMode.Random);
    expect(result.defaults.contentType).toBe(ContentType.Education);
  });
});
