import { Hono } from 'hono';
import type { Bindings } from '../bindings.js';
import { ContentType } from 'shared';
import type { User, PostStatus } from 'shared';
import { sessionMiddleware } from '../middleware/session.js';
import { emptyToNull, emptyToNullOptional } from '../http/normalize.js';
import {
  PostService,
  PublishApprovalService,
  InstagramChannel,
  ActivityLogService,
  CrossPoster,
  ContentAdvisor,
  MediaService,
  UserSettingsService,
} from '../services/index.js';

const app = new Hono<{ Bindings: Bindings; Variables: { user: User } }>();

app.use('*', sessionMiddleware);

/**
 * GET /
 * List posts for the authenticated user with optional status filter.
 */
app.get('/', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10) || 20));
  const rawStatus = c.req.query('status');
  const validStatuses = ['draft', 'awaiting_approval', 'approved', 'publishing', 'published', 'failed'];
  const status = rawStatus && validStatuses.includes(rawStatus) ? rawStatus as PostStatus : undefined;
  const postService = new PostService(c.env.DB);
  const posts = await postService.list(c.get('user').id, { page, limit }, status);
  return c.json({ posts, page, limit });
});

/**
 * POST /quick-start
 * Initialize the quick-post workflow.
 * Also triggers a non-blocking Instagram sync so the advisor has fresh data.
 */
app.post('/quick-start', async (c) => {
  const userId = c.get('user').id;
  const db = c.env.DB;

  // Background Instagram sync via waitUntil so it completes even after response is sent.
  // Rate-limited to once per 5 minutes, failures logged.
  const syncPromise = import('../services/instagram-sync-service.js')
    .then(({ InstagramSyncService }) => new InstagramSyncService(db, c.env.CHANNEL_ENCRYPTION_KEY).syncRecentPosts(userId))
    .catch((err) => {
      if (err && err.severity === 'warning') return;
      console.error('[InstagramSync] Background sync failed for user %s:', userId, err);
    });
  c.executionCtx.waitUntil(syncPromise);

  const userSettingsService = new UserSettingsService(db);
  const settings = await userSettingsService.getSettings(userId);

  const contentAdvisor = new ContentAdvisor(db);
  const mediaService = new MediaService(db, c.env.R2_BUCKET);
  const instagramChannel = new InstagramChannel({
    db,
    encryptionKey: c.env.CHANNEL_ENCRYPTION_KEY,
    publicUrl: c.env.S3_PUBLIC_URL,
  });

  const [suggestion, mediaThumbnails] = await Promise.all([
    contentAdvisor.suggest(userId, settings.advisorMode),
    mediaService.list(userId, { page: 1, limit: 20 }),
  ]);

  const constraints = instagramChannel.getConstraints();
  const preSelectedContentType = suggestion?.contentType ?? null;

  return c.json({
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
  });
});

/**
 * POST /
 * Create a new post.
 */
app.post('/', async (c) => {
  const body = await c.req.json() as {
    channelConnectionId?: string;
    contentType: string;
    caption?: string;
    hashtags?: string[];
    templateFields?: Record<string, string>;
    mediaItemIds?: string[];
  };

  // Validate contentType
  const validContentTypes = Object.values(ContentType);
  if (!body.contentType || !(validContentTypes as string[]).includes(body.contentType)) {
    return c.json({
      severity: 'warning',
      component: 'PostService',
      operation: 'create',
      message: 'A valid contentType is required. Valid types: ' + validContentTypes.join(', '),
      actions: ['Provide a valid contentType'],
    }, 400);
  }

  const postService = new PostService(c.env.DB);
  const post = await postService.create({
    userId: c.get('user').id,
    channelConnectionId: emptyToNull(body.channelConnectionId),
    contentType: body.contentType as ContentType,
    caption: body.caption,
    hashtags: body.hashtags,
    templateFields: body.templateFields,
    mediaItemIds: body.mediaItemIds,
  });
  return c.json(post, 201);
});

/**
 * GET /:id
 * Get a single post by ID.
 */
app.get('/:id', async (c) => {
  const postService = new PostService(c.env.DB);
  const post = await postService.getById(c.req.param('id'), c.get('user').id);
  return c.json(post);
});

/**
 * PUT /:id
 * Update an existing post.
 */
app.put('/:id', async (c) => {
  const body = await c.req.json() as {
    caption?: string;
    hashtags?: string[];
    contentType?: string;
    channelConnectionId?: string;
    templateFields?: Record<string, string>;
    mediaItemIds?: string[];
  };
  const postService = new PostService(c.env.DB);
  const post = await postService.update(c.req.param('id'), c.get('user').id, {
    caption: body.caption,
    hashtags: body.hashtags,
    contentType: body.contentType as any,
    channelConnectionId: emptyToNullOptional(body.channelConnectionId),
    templateFields: body.templateFields,
    mediaItemIds: body.mediaItemIds,
  });
  return c.json(post);
});

/**
 * POST /:id/approve
 * Approve a post for publishing.
 */
app.post('/:id/approve', async (c) => {
  const postId = c.req.param('id');
  const userId = c.get('user').id;
  const db = c.env.DB;

  const postService = new PostService(db);
  const approvalService = new PublishApprovalService(db);

  // Validate post status — only draft and awaiting_approval are allowed
  const post = await postService.getById(postId, userId);
  if (post.status !== 'draft' && post.status !== 'awaiting_approval') {
    return c.json({ error: 'Cannot approve a post with status \'' + post.status + '\'.' }, 409);
  }

  // If the post is still a draft, transition to awaiting_approval first
  if (post.status === 'draft') {
    await postService.transitionStatus(postId, userId, 'awaiting_approval');
  }

  await approvalService.approve(postId, userId);
  return c.json({ success: true });
});

/**
 * POST /:id/publish
 * Publish a post to its target channel.
 */
app.post('/:id/publish', async (c) => {
  const userId = c.get('user').id;
  const db = c.env.DB;

  const postService = new PostService(db);
  const approvalService = new PublishApprovalService(db);
  const activityLog = new ActivityLogService(db);
  const instagramChannel = new InstagramChannel({
    db,
    encryptionKey: c.env.CHANNEL_ENCRYPTION_KEY,
    publicUrl: c.env.S3_PUBLIC_URL,
  });
  const crossPoster = new CrossPoster({
    db,
    postService,
    approvalService,
    channel: instagramChannel,
    activityLog,
  });

  const result = await crossPoster.publish(c.req.param('id'), userId);
  return c.json(result);
});

export default app;
