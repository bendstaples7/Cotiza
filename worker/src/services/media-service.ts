import { PlatformError } from '../errors/index.js';
import { buildMediaThumbnailPath } from 'shared';
import type { MediaItem, PaginationParams, GeneratedImage } from 'shared';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'video/mp4'];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: ArrayBuffer;
}

export class MediaService {
  private readonly db: D1Database;
  private readonly r2: R2Bucket;

  constructor(db: D1Database, r2: R2Bucket) {
    this.db = db;
    this.r2 = r2;
  }

  async upload(file: UploadedFile, userId: string): Promise<MediaItem> {
    this.validateFile(file);

    const storageKey = 'media/' + userId + '/' + crypto.randomUUID() + '-' + file.originalname;
    const thumbnailUrl = buildMediaThumbnailPath(storageKey);

    await this.r2.put(storageKey, file.buffer, {
      httpMetadata: { contentType: file.mimetype },
    });

    const id = crypto.randomUUID();
    await this.db.prepare(
      'INSERT INTO media_items (id, user_id, filename, mime_type, file_size_bytes, storage_key, thumbnail_url, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, userId, file.originalname, file.mimetype, file.size, storageKey, thumbnailUrl, 'uploaded').run();

    const row = await this.db.prepare(
      'SELECT id, user_id, filename, mime_type, file_size_bytes, storage_key, thumbnail_url, source, ai_description, width, height, created_at FROM media_items WHERE id = ?'
    ).bind(id).first() as any;

    return this.mapRow(row);
  }

  async storeGenerated(image: GeneratedImage, userId: string): Promise<MediaItem> {
    let bytes: Uint8Array;

    if (image.url.startsWith('data:')) {
      const commaIdx = image.url.indexOf(',');
      if (commaIdx === -1) {
        throw new PlatformError({
          severity: 'error',
          component: 'MediaService',
          operation: 'storeGenerated',
          description: 'Invalid base64 data URI.',
          recommendedActions: ['Try generating the image again'],
        });
      }
      const b64 = image.url.substring(commaIdx + 1);
      const binaryStr = atob(b64);
      bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
    } else {
      const MAX_DOWNLOAD_SIZE = 20 * 1024 * 1024; // 20 MB max download
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(image.url, { signal: controller.signal });
        if (!response.ok) {
          throw new PlatformError({
            severity: 'error',
            component: 'MediaService',
            operation: 'storeGenerated',
            description: 'Failed to download the generated image for storage.',
            recommendedActions: ['Try generating the image again'],
          });
        }
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_SIZE) {
          throw new PlatformError({
            severity: 'error',
            component: 'MediaService',
            operation: 'storeGenerated',
            description: 'Generated image exceeds the 20 MB download size limit.',
            recommendedActions: ['Try generating a smaller image'],
          });
        }
        bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > MAX_DOWNLOAD_SIZE) {
          throw new PlatformError({
            severity: 'error',
            component: 'MediaService',
            operation: 'storeGenerated',
            description: 'Generated image exceeds the 20 MB download size limit.',
            recommendedActions: ['Try generating a smaller image'],
          });
        }
      } catch (err) {
        if (err instanceof PlatformError) throw err;
        if (err instanceof Error && err.name === 'AbortError') {
          throw new PlatformError({
            severity: 'error',
            component: 'MediaService',
            operation: 'storeGenerated',
            description: 'Image download timed out.',
            recommendedActions: ['Try generating the image again'],
          });
        }
        throw err;
      } finally {
        clearTimeout(timeout);
      }
    }

    const mimeType = image.format === 'png' ? 'image/png' : image.format === 'webp' ? 'image/webp' : 'image/jpeg';
    const ext = image.format === 'png' ? 'png' : image.format === 'webp' ? 'webp' : 'jpg';
    const filename = 'ai-generated-' + crypto.randomUUID() + '.' + ext;
    const storageKey = 'media/' + userId + '/' + filename;
    const thumbnailUrl = buildMediaThumbnailPath(storageKey);

    await this.r2.put(storageKey, bytes.buffer as ArrayBuffer, {
      httpMetadata: { contentType: mimeType },
    });

    const id = crypto.randomUUID();
    await this.db.prepare(
      "INSERT INTO media_items (id, user_id, filename, mime_type, file_size_bytes, storage_key, thumbnail_url, source, ai_description, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, 'ai_generated', ?, ?, ?)"
    ).bind(id, userId, filename, mimeType, bytes.length, storageKey, thumbnailUrl, image.description, image.width, image.height).run();

    const row = await this.db.prepare(
      'SELECT id, user_id, filename, mime_type, file_size_bytes, storage_key, thumbnail_url, source, ai_description, width, height, created_at FROM media_items WHERE id = ?'
    ).bind(id).first() as any;

    return this.mapRow(row);
  }

  async delete(mediaId: string, userId: string): Promise<void> {
    const row = await this.db.prepare(
      'SELECT storage_key FROM media_items WHERE id = ? AND user_id = ?'
    ).bind(mediaId, userId).first() as any;

    if (!row) {
      throw new PlatformError({
        severity: 'error',
        component: 'MediaService',
        operation: 'delete',
        description: 'The media item was not found or you do not have permission to delete it.',
        recommendedActions: ['Verify the media item exists in your library'],
      });
    }

    await this.r2.delete(row.storage_key);
    await this.db.prepare('DELETE FROM media_items WHERE id = ? AND user_id = ?').bind(mediaId, userId).run();
  }

  async list(userId: string, pagination: PaginationParams): Promise<MediaItem[]> {
    const offset = (pagination.page - 1) * pagination.limit;
    const result = await this.db.prepare(
      'SELECT id, user_id, filename, mime_type, file_size_bytes, storage_key, thumbnail_url, source, ai_description, width, height, created_at FROM media_items WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).bind(userId, pagination.limit, offset).all();

    return (result.results as any[]).map((row) => this.mapRow(row));
  }

  async getById(mediaId: string, userId: string): Promise<MediaItem | null> {
    const row = await this.db.prepare(
      'SELECT id, user_id, filename, mime_type, file_size_bytes, storage_key, thumbnail_url, source, ai_description, width, height, created_at FROM media_items WHERE id = ? AND user_id = ?'
    ).bind(mediaId, userId).first() as any;

    if (!row) return null;
    return this.mapRow(row);
  }

  private validateFile(file: UploadedFile): void {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new PlatformError({
        severity: 'warning',
        component: 'MediaService',
        operation: 'upload',
        description: 'This file format is not supported. The platform accepts JPEG, PNG, WebP, HEIC, HEIF, and MP4 files.',
        recommendedActions: ['Convert the file to JPEG, PNG, WebP, HEIC, HEIF, or MP4 and try again'],
      });
    }
    if (file.size > MAX_FILE_SIZE) {
      throw new PlatformError({
        severity: 'warning',
        component: 'MediaService',
        operation: 'upload',
        description: 'The file exceeds the 50 MB size limit.',
        recommendedActions: ['Reduce the file size and try again'],
      });
    }
  }

  private mapRow(row: Record<string, unknown>): MediaItem {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      filename: row.filename as string,
      mimeType: row.mime_type as string,
      fileSizeBytes: row.file_size_bytes as number,
      storageKey: row.storage_key as string,
      thumbnailUrl: row.thumbnail_url as string,
      source: row.source as MediaItem['source'],
      aiDescription: (row.ai_description as string) ?? undefined,
      width: (row.width as number) ?? 0,
      height: (row.height as number) ?? 0,
      createdAt: new Date(row.created_at as string),
    };
  }
}
