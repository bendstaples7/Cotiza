import { PlatformError } from '../errors/index.js';
import { safeBind } from '../db/safe-bind.js';
import type { Post, PostStatus, ContentType, PostMedia, PaginationParams } from 'shared';

const VALID_TRANSITIONS: Record<string, PostStatus[]> = {
  draft: ['awaiting_approval'],
  awaiting_approval: ['approved', 'draft'],
  approved: ['publishing'],
  publishing: ['published', 'failed'],
  failed: ['publishing', 'draft'],
};

export interface CreatePostParams {
  userId: string;
  /** Null when the draft has no channel selected yet (the column is nullable). */
  channelConnectionId: string | null;
  contentType: ContentType;
  caption?: string;
  hashtags?: string[];
  templateFields?: Record<string, string>;
  mediaItemIds?: string[];
}

export interface UpdatePostParams {
  caption?: string;
  hashtags?: string[];
  contentType?: ContentType;
  /** `undefined` leaves the channel unchanged; `null` clears it. */
  channelConnectionId?: string | null;
  templateFields?: Record<string, string>;
  mediaItemIds?: string[];
}

const POST_COLUMNS = 'id, user_id, channel_connection_id, content_type, caption, hashtags_json, status, external_post_id, template_fields, created_at, updated_at, published_at';

export class PostService {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async create(params: CreatePostParams): Promise<Post> {
    const postId = crypto.randomUUID();
    const hashtagsJson = params.hashtags ? JSON.stringify(params.hashtags) : null;
    const templateFields = params.templateFields ? JSON.stringify(params.templateFields) : null;

    const statements: D1PreparedStatement[] = [
      safeBind(
        this.db.prepare(
          'INSERT INTO posts (id, user_id, channel_connection_id, content_type, caption, hashtags_json, status, template_fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ),
        postId, params.userId, params.channelConnectionId ?? null, params.contentType, params.caption ?? null, hashtagsJson, 'draft', templateFields
      ),
    ];

    if (params.mediaItemIds && params.mediaItemIds.length > 0) {
      for (let i = 0; i < params.mediaItemIds.length; i++) {
        statements.push(
          safeBind(
            this.db.prepare(
              'INSERT INTO post_media (id, post_id, media_item_id, display_order) VALUES (?, ?, ?, ?)'
            ),
            crypto.randomUUID(), postId, params.mediaItemIds[i], i
          )
        );
      }
    }

    await this.db.batch(statements);

    const row = await this.db.prepare(
      'SELECT ' + POST_COLUMNS + ' FROM posts WHERE id = ?'
    ).bind(postId).first() as any;

    return this.mapRow(row);
  }

  async getById(postId: string, userId: string): Promise<Post> {
    const row = await this.db.prepare(
      'SELECT ' + POST_COLUMNS + ' FROM posts WHERE id = ? AND user_id = ?'
    ).bind(postId, userId).first() as any;

    if (!row) {
      throw new PlatformError({
        severity: 'error',
        component: 'PostService',
        operation: 'getById',
        description: 'The post was not found or you do not have permission to view it.',
        recommendedActions: ['Verify the post exists in your dashboard'],
      });
    }

    return this.mapRow(row);
  }

  async list(userId: string, pagination: PaginationParams, statusFilter?: PostStatus): Promise<Post[]> {
    const offset = (pagination.page - 1) * pagination.limit;

    let sql = 'SELECT ' + POST_COLUMNS + ' FROM posts WHERE user_id = ?';
    const params: unknown[] = [userId];

    if (statusFilter) {
      sql += ' AND status = ?';
      params.push(statusFilter);
    }

    sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    params.push(pagination.limit, offset);

    const result = await this.db.prepare(sql).bind(...params).all();
    return (result.results as any[]).map((row) => this.mapRow(row));
  }

  async update(postId: string, userId: string, updates: UpdatePostParams): Promise<Post> {
    const existing = await this.getById(postId, userId);

    if (existing.status !== 'draft') {
      throw new PlatformError({
        severity: 'warning',
        component: 'PostService',
        operation: 'update',
        description: 'Only draft posts can be edited. Change the post status to draft first.',
        recommendedActions: ['Move the post back to draft status before editing'],
      });
    }

    const setClauses: string[] = ["updated_at = datetime('now')"];
    const values: unknown[] = [];

    if (updates.caption !== undefined) {
      setClauses.push('caption = ?');
      values.push(updates.caption);
    }
    if (updates.hashtags !== undefined) {
      setClauses.push('hashtags_json = ?');
      values.push(JSON.stringify(updates.hashtags));
    }
    if (updates.contentType !== undefined) {
      setClauses.push('content_type = ?');
      values.push(updates.contentType);
    }
    if (updates.channelConnectionId !== undefined) {
      setClauses.push('channel_connection_id = ?');
      values.push(updates.channelConnectionId);
    }
    if (updates.templateFields !== undefined) {
      setClauses.push('template_fields = ?');
      values.push(JSON.stringify(updates.templateFields));
    }

    values.push(postId, userId);

    const statements: D1PreparedStatement[] = [
      safeBind(
        this.db.prepare(
          'UPDATE posts SET ' + setClauses.join(', ') + ' WHERE id = ? AND user_id = ?'
        ),
        ...values
      ),
    ];

    if (updates.mediaItemIds !== undefined) {
      statements.push(
        safeBind(this.db.prepare('DELETE FROM post_media WHERE post_id = ?'), postId)
      );
      for (let i = 0; i < updates.mediaItemIds.length; i++) {
        statements.push(
          safeBind(
            this.db.prepare(
              'INSERT INTO post_media (id, post_id, media_item_id, display_order) VALUES (?, ?, ?, ?)'
            ),
            crypto.randomUUID(), postId, updates.mediaItemIds[i], i
          )
        );
      }
    }

    await this.db.batch(statements);

    const row = await this.db.prepare(
      'SELECT ' + POST_COLUMNS + ' FROM posts WHERE id = ?'
    ).bind(postId).first() as any;

    return this.mapRow(row);
  }

  async transitionStatus(postId: string, userId: string, newStatus: PostStatus): Promise<Post> {
    const post = await this.getById(postId, userId);
    const allowed = VALID_TRANSITIONS[post.status];

    if (!allowed || !allowed.includes(newStatus)) {
      throw new PlatformError({
        severity: 'error',
        component: 'PostService',
        operation: 'transitionStatus',
        description: 'Cannot transition post from \'' + post.status + '\' to \'' + newStatus + '\'. This status change is not allowed.',
        recommendedActions: [
          'Valid transitions from \'' + post.status + '\': ' + (allowed ? allowed.join(', ') : 'none'),
        ],
      });
    }

    const publishedClause = newStatus === 'published' ? ", published_at = datetime('now')" : '';
    await this.db.prepare(
      "UPDATE posts SET status = ?, updated_at = datetime('now')" + publishedClause + ' WHERE id = ? AND user_id = ?'
    ).bind(newStatus, postId, userId).run();

    const row = await this.db.prepare(
      'SELECT ' + POST_COLUMNS + ' FROM posts WHERE id = ?'
    ).bind(postId).first() as any;

    return this.mapRow(row);
  }

  async setExternalPostId(postId: string, userId: string, externalPostId: string): Promise<void> {
    await this.db.prepare(
      "UPDATE posts SET external_post_id = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
    ).bind(externalPostId, postId, userId).run();
  }

  async getPostMedia(postId: string, userId: string): Promise<PostMedia[]> {
    const result = await this.db.prepare(
      'SELECT pm.id, pm.post_id, pm.media_item_id, pm.display_order FROM post_media pm JOIN posts p ON p.id = pm.post_id WHERE pm.post_id = ? AND p.user_id = ? ORDER BY pm.display_order ASC'
    ).bind(postId, userId).all();

    return (result.results as any[]).map((row) => ({
      id: row.id as string,
      postId: row.post_id as string,
      mediaItemId: row.media_item_id as string,
      displayOrder: row.display_order as number,
    }));
  }

  private mapRow(row: Record<string, unknown>): Post {
    let templateFields: Record<string, string> | undefined;
    if (row.template_fields) {
      templateFields = typeof row.template_fields === 'string'
        ? JSON.parse(row.template_fields as string)
        : row.template_fields as Record<string, string>;
    }

    return {
      id: row.id as string,
      userId: row.user_id as string,
      channelConnectionId: (row.channel_connection_id as string | null) ?? null,
      contentType: row.content_type as ContentType,
      caption: (row.caption as string) ?? '',
      hashtagsJson: (row.hashtags_json as string) ?? '[]',
      status: row.status as PostStatus,
      externalPostId: (row.external_post_id as string) ?? undefined,
      templateFields,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      publishedAt: row.published_at ? new Date(row.published_at as string) : undefined,
    };
  }
}
