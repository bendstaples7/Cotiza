import { describe, it, expect, afterEach } from 'vitest';
import { InstagramChannel, encrypt } from '../../worker/src/services/instagram-channel.js';
import { installFetchMock, type FetchMock } from '../helpers/fetch-mock.js';
import { createMockD1, configurePrepareResults } from '../unit/helpers/mock-d1.js';
import type { FormattedPost, Post } from 'shared';

const KEY = '0'.repeat(64); // 32-byte AES-256 key in hex

function channelWith(db: ReturnType<typeof createMockD1>, publicUrl = 'https://pub.r2.dev') {
  return new InstagramChannel({ db: db as never, encryptionKey: KEY, publicUrl });
}

function formatted(overrides: Partial<FormattedPost> = {}): FormattedPost {
  return {
    postId: 'post-1',
    channelType: 'instagram',
    caption: 'New kitchen reveal',
    hashtags: ['reno'],
    mediaUrls: ['https://pub.r2.dev/media/u/p.jpg'],
    metadata: { formatType: 'IMAGE', mimeTypes: ['image/jpeg'] },
    ...overrides,
  };
}

describe('Instagram publish pipeline (InstagramChannel.publish + Graph boundary)', () => {
  let fetchMock: FetchMock | null = null;
  afterEach(() => {
    fetchMock?.restore();
    fetchMock = null;
  });

  it('publishes a single image and prefixes hashtags with # in the caption', async () => {
    const token = await encrypt('tok-abc', KEY);
    const db = createMockD1();
    configurePrepareResults(db, [
      { first: { access_token_encrypted: token, external_account_id: 'ig-123' } },
    ]);
    // media_publish must be matched before the broader "/media" create handler.
    fetchMock = installFetchMock()
      .on('media_publish', { json: { id: 'ig-post-1' } })
      .on('/media', { json: { id: 'creation-1' } });

    const result = await channelWith(db).publish(formatted());

    expect(result).toEqual({ success: true, externalPostId: 'ig-post-1' });
    const createCall = fetchMock.calls.find((c) => c.url.includes('/media') && !c.url.includes('media_publish'));
    expect(createCall?.body).toContain('#reno');
  });

  it('returns a friendly message (not raw JSON) on a Graph API error', async () => {
    const token = await encrypt('tok-abc', KEY);
    const db = createMockD1();
    configurePrepareResults(db, [
      { first: { access_token_encrypted: token, external_account_id: 'ig-123' } },
    ]);
    fetchMock = installFetchMock().on('/media', {
      status: 400,
      json: { error: { message: 'Media URL is not reachable' } },
    });

    const result = await channelWith(db).publish(formatted());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Instagram error: Media URL is not reachable');
  });

  it('guards an empty media list before calling the Graph API', async () => {
    const token = await encrypt('tok-abc', KEY);
    const db = createMockD1();
    configurePrepareResults(db, [
      { first: { access_token_encrypted: token, external_account_id: 'ig-123' } },
    ]);
    fetchMock = installFetchMock();

    const result = await channelWith(db).publish(formatted({ mediaUrls: [] }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('no image or video');
    expect(fetchMock.calls).toHaveLength(0);
  });

  it('URL-encodes storage keys when building public media URLs (formatPost)', async () => {
    const db = createMockD1();
    configurePrepareResults(db, [
      { all: { results: [{ storage_key: 'media/u/my photo.jpg', mime_type: 'image/jpeg' }] } },
    ]);

    const post = { id: 'post-1', caption: '', hashtagsJson: '[]' } as Post;
    const result = await channelWith(db).formatPost(post);

    expect(result.mediaUrls).toEqual(['https://pub.r2.dev/media/u/my%20photo.jpg']);
  });
});
