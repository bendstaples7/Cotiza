import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Post } from '../../shared/src/types/post.js';
import { ContentType } from '../../shared/src/types/enums.js';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';
import type { MockD1Database } from './helpers/mock-d1.js';
import { PostService } from '../../worker/src/services/post-service.js';
import { PlatformError } from '../../worker/src/errors/platform-error.js';

const NOW = '2024-06-15T10:00:00Z';

function makePostRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'post-1',
    user_id: 'user-1',
    channel_connection_id: 'chan-1',
    content_type: 'education',
    caption: 'Test caption',
    hashtags_json: '["#reno"]',
    status: 'draft',
    external_post_id: null,
    template_fields: null,
    created_at: NOW,
    updated_at: NOW,
    published_at: null,
    ...overrides,
  };
}

describe('PostService', () => {
  let db: MockD1Database;
  let service: PostService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockD1();
    service = new PostService(db as unknown as D1Database);
  });

  describe('create()', () => {
    it('creates a draft post and returns it', async () => {
      const row = makePostRow();
      // prepare() is called for each batch statement (1 INSERT), then for the SELECT
      // We need a dummy result for the batch INSERT prepare, then the real row for SELECT
      db.batch.mockResolvedValueOnce([]);
      configurePrepareResults(db, [
        {}, // INSERT INTO posts prepare (consumed by batch building)
        { first: row }, // SELECT after batch
      ]);

      const post = await service.create({
        userId: 'user-1',
        channelConnectionId: 'chan-1',
        contentType: ContentType.Education,
        caption: 'Test caption',
        hashtags: ['#reno'],
      });

      expect(post.id).toBe('post-1');
      expect(post.status).toBe('draft');
      expect(post.contentType).toBe('education');
      expect(db.batch).toHaveBeenCalledTimes(1);
    });

    it('attaches media items when provided', async () => {
      const row = makePostRow();
      db.batch.mockResolvedValueOnce([]);
      configurePrepareResults(db, [
        {}, // INSERT INTO posts
        {}, // INSERT INTO post_media 1
        {}, // INSERT INTO post_media 2
        { first: row }, // SELECT after batch
      ]);

      await service.create({
        userId: 'user-1',
        channelConnectionId: 'chan-1',
        contentType: ContentType.Education,
        mediaItemIds: ['media-1', 'media-2'],
      });

      // batch should receive 3 statements: 1 post INSERT + 2 post_media INSERTs
      const batchArg = db.batch.mock.calls[0][0] as unknown[];
      expect(batchArg).toHaveLength(3);
    });

    it('rolls back on error (batch is atomic)', async () => {
      db.batch.mockRejectedValueOnce(new Error('db error'));

      await expect(
        service.create({
          userId: 'user-1',
          channelConnectionId: 'chan-1',
          contentType: ContentType.Education,
        }),
      ).rejects.toThrow('db error');
    });

    it('binds NULL (never undefined) when no channel is selected', async () => {
      // Regression: picking a content idea with no connected channel sends a
      // null/empty channel. Previously the route coerced this to `undefined`,
      // which D1 rejects with "D1_TYPE_ERROR: Type 'undefined' not supported".
      const row = makePostRow({ channel_connection_id: null });
      db.batch.mockResolvedValueOnce([]);
      configurePrepareResults(db, [
        {}, // INSERT INTO posts
        { first: row }, // SELECT after batch
      ]);

      const post = await service.create({
        userId: 'user-1',
        channelConnectionId: null,
        contentType: ContentType.Education,
        caption: 'Idea caption',
        hashtags: [],
      });

      // INSERT is the first prepared statement; channel_connection_id is bind index 2.
      const boundArgs = db._stmts[0].bind.mock.calls[0];
      expect(boundArgs[2]).toBeNull();
      expect(boundArgs[2]).not.toBeUndefined();
      expect(post.id).toBe('post-1');
    });

    it('coerces an undefined channel to NULL via safeBind (caller backstop)', async () => {
      const row = makePostRow({ channel_connection_id: null });
      db.batch.mockResolvedValueOnce([]);
      configurePrepareResults(db, [{}, { first: row }]);

      await expect(
        service.create({
          userId: 'user-1',
          channelConnectionId: undefined as unknown as null,
          contentType: ContentType.Education,
        }),
      ).resolves.toBeDefined();

      expect(db._stmts[0].bind.mock.calls[0][2]).toBeNull();
    });
  });

  describe('getById()', () => {
    it('returns the post when found', async () => {
      configurePrepareResults(db, [{ first: makePostRow() }]);

      const post = await service.getById('post-1', 'user-1');

      expect(post.id).toBe('post-1');
      expect(post.userId).toBe('user-1');
    });

    it('throws PlatformError when not found', async () => {
      configurePrepareResults(db, [{ first: null }]);

      await expect(service.getById('missing', 'user-1')).rejects.toThrow(PlatformError);
    });
  });

  describe('list()', () => {
    it('returns posts with pagination', async () => {
      configurePrepareResults(db, [
        { all: { results: [makePostRow(), makePostRow({ id: 'post-2' })] } },
      ]);

      const posts = await service.list('user-1', { page: 1, limit: 10 });

      expect(posts).toHaveLength(2);
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT'),
      );
    });

    it('applies status filter when provided', async () => {
      configurePrepareResults(db, [{ all: { results: [] } }]);

      await service.list('user-1', { page: 1, limit: 10 }, 'draft');

      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('AND status = ?'),
      );
      // Verify the bound values include the status filter
      const stmt = db._stmts[0];
      expect(stmt.bind).toHaveBeenCalledWith('user-1', 'draft', 10, 0);
    });
  });


  describe('transitionStatus()', () => {
    const validTransitions: [string, string][] = [
      ['draft', 'awaiting_approval'],
      ['awaiting_approval', 'approved'],
      ['awaiting_approval', 'draft'],
      ['approved', 'publishing'],
      ['publishing', 'published'],
      ['publishing', 'failed'],
      ['failed', 'publishing'],
      ['failed', 'draft'],
    ];

    it.each(validTransitions)(
      'allows transition from %s to %s',
      async (from, to) => {
        // getById call returns post with current status, then UPDATE run, then SELECT first for result
        configurePrepareResults(db, [
          { first: makePostRow({ status: from }) },
          { run: { success: true } },
          { first: makePostRow({ status: to }) },
        ]);

        const post = await service.transitionStatus('post-1', 'user-1', to as any);
        expect(post.status).toBe(to);
      },
    );

    const invalidTransitions: [string, string][] = [
      ['draft', 'approved'],
      ['draft', 'publishing'],
      ['draft', 'published'],
      ['draft', 'failed'],
      ['awaiting_approval', 'publishing'],
      ['awaiting_approval', 'published'],
      ['awaiting_approval', 'failed'],
      ['approved', 'draft'],
      ['approved', 'awaiting_approval'],
      ['approved', 'published'],
      ['approved', 'failed'],
      ['publishing', 'draft'],
      ['publishing', 'awaiting_approval'],
      ['publishing', 'approved'],
      ['published', 'draft'],
      ['published', 'awaiting_approval'],
      ['published', 'approved'],
      ['published', 'publishing'],
      ['published', 'failed'],
      ['failed', 'awaiting_approval'],
      ['failed', 'approved'],
      ['failed', 'published'],
    ];

    it.each(invalidTransitions)(
      'rejects transition from %s to %s',
      async (from, to) => {
        configurePrepareResults(db, [
          { first: makePostRow({ status: from }) },
        ]);

        await expect(
          service.transitionStatus('post-1', 'user-1', to as any),
        ).rejects.toThrow(PlatformError);
      },
    );

    it('sets published_at when transitioning to published', async () => {
      configurePrepareResults(db, [
        { first: makePostRow({ status: 'publishing' }) },
        { run: { success: true } },
        { first: makePostRow({ status: 'published', published_at: NOW }) },
      ]);

      await service.transitionStatus('post-1', 'user-1', 'published');

      // The UPDATE statement should contain published_at
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('published_at'),
      );
    });
  });

  describe('update()', () => {
    it('throws when post is not a draft', async () => {
      configurePrepareResults(db, [
        { first: makePostRow({ status: 'awaiting_approval' }) },
      ]);

      await expect(
        service.update('post-1', 'user-1', { caption: 'new' }),
      ).rejects.toThrow(PlatformError);
    });
  });

  describe('getPostMedia()', () => {
    it('returns media items ordered by display_order', async () => {
      configurePrepareResults(db, [
        {
          all: {
            results: [
              { id: 'pm-1', post_id: 'post-1', media_item_id: 'media-1', display_order: 0 },
              { id: 'pm-2', post_id: 'post-1', media_item_id: 'media-2', display_order: 1 },
            ],
          },
        },
      ]);

      const media = await service.getPostMedia('post-1', 'user-1');

      expect(media).toHaveLength(2);
      expect(media[0].mediaItemId).toBe('media-1');
      expect(media[0].displayOrder).toBe(0);
      expect(media[1].displayOrder).toBe(1);
    });
  });

  describe('mapRow()', () => {
    it('parses template_fields from TEXT/JSON string', async () => {
      configurePrepareResults(db, [
        { first: makePostRow({ template_fields: JSON.stringify({ topic_title: 'Flooring' }) }) },
      ]);

      const post = await service.getById('post-1', 'user-1');
      expect(post.templateFields).toEqual({ topic_title: 'Flooring' });
    });

    it('handles null template_fields', async () => {
      configurePrepareResults(db, [
        { first: makePostRow({ template_fields: null }) },
      ]);

      const post = await service.getById('post-1', 'user-1');
      expect(post.templateFields).toBeUndefined();
    });
  });
});
