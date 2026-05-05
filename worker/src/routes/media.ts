import { Hono } from 'hono';
import type { Bindings } from '../bindings.js';
import type { User, ImageGenerationRequest, GeneratedImage } from 'shared';
import { sessionMiddleware } from '../middleware/session.js';
import { MediaService } from '../services/media-service.js';
import { ImageGenerator } from '../services/image-generator.js';
import { PlatformError } from '../errors/index.js';

const app = new Hono<{ Bindings: Bindings; Variables: { user: User } }>();

/** Infer MIME type from filename extension when Content-Type is missing or generic. */
function inferMimeType(headerType: string, filename: string): string {
  if (headerType && headerType !== 'application/octet-stream') {
    return headerType;
  }
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    case 'mp4':
      return 'video/mp4';
    default:
      return headerType || 'application/octet-stream';
  }
}

app.use('*', sessionMiddleware);

/**
 * GET /
 * List media library for the authenticated user.
 */
app.get('/', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10) || 20));
  const mediaService = new MediaService(c.env.DB, c.env.R2_BUCKET);
  const items = await mediaService.list(c.get('user').id, { page, limit });
  return c.json({ items, page, limit });
});

/**
 * POST /upload
 * Upload a media file (expects raw body with Content-Type header).
 */
app.post('/upload', async (c) => {
  const rawContentType = (c.req.header('Content-Type') || '').split(';')[0].trim();
  const filename = c.req.header('X-Filename') || 'upload';

  // Infer MIME type from filename extension when Content-Type is missing or generic
  const contentType = inferMimeType(rawContentType, filename);

  // Preflight size check using Content-Length header
  const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50 MB
  const contentLength = c.req.header('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > MAX_UPLOAD_SIZE) {
    throw new PlatformError({
      severity: 'warning',
      component: 'MediaService',
      operation: 'upload',
      description: 'The file exceeds the 50 MB size limit.',
      recommendedActions: ['Reduce the file size and try again'],
      statusCode: 413,
    });
  }

  const buffer = await c.req.arrayBuffer();
  if (buffer.byteLength > MAX_UPLOAD_SIZE) {
    throw new PlatformError({
      severity: 'warning',
      component: 'MediaService',
      operation: 'upload',
      description: 'The file exceeds the 50 MB size limit.',
      recommendedActions: ['Reduce the file size and try again'],
      statusCode: 413,
    });
  }

  const mediaService = new MediaService(c.env.DB, c.env.R2_BUCKET);
  const item = await mediaService.upload(
    {
      originalname: filename,
      mimetype: contentType,
      size: buffer.byteLength,
      buffer,
    },
    c.get('user').id,
  );

  return c.json(item, 201);
});

/**
 * POST /generate
 * Enqueue an image generation job to the Cloudflare Queue.
 * Returns a jobId for polling.
 */
app.post('/generate', async (c) => {
  const body = await c.req.json() as Partial<ImageGenerationRequest> & { topic?: string };
  const userId = c.get('user').id;

  let description = (body.description || '').trim();

  // If a topic is provided, convert it to a visual scene description first
  if (body.topic && body.topic.trim().length > 0) {
    const imageGenerator = new ImageGenerator(c.env.AI_TEXT_API_KEY);
    description = await imageGenerator.describeScene(body.topic.trim());
  }

  if (!description || description.length === 0) {
    throw new PlatformError({
      severity: 'warning',
      component: 'ImageGenerator',
      operation: 'generate',
      description: 'A text description or topic is required to generate images.',
      recommendedActions: ['Provide a description or topic'],
    });
  }

  const jobId = crypto.randomUUID();
  const sanitizedCount = Math.min(4, Math.max(1, Math.floor(Number(body.count) || 1)));

  // Create job record in D1
  await c.env.DB.prepare(
    'INSERT INTO image_generation_jobs (id, user_id, status, description, style, count, topic, result_media_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(jobId, userId, 'queued', description, body.style || null, sanitizedCount, body.topic || null, '[]').run();

  // Enqueue the job — clean up DB row on failure
  try {
    await c.env.IMAGE_QUEUE.send({
      jobId,
      userId,
      request: {
        description,
        style: body.style,
        count: sanitizedCount,
      },
    });
  } catch (err) {
    await c.env.DB.prepare(
      "UPDATE image_generation_jobs SET status = 'failed', error = 'Failed to enqueue job', updated_at = datetime('now') WHERE id = ?"
    ).bind(jobId).run();
    throw err;
  }

  return c.json({ jobId });
});

/**
 * GET /generate-status/:jobId
 * Poll for image generation job status.
 */
app.get('/generate-status/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  const userId = c.get('user').id;

  const row = await c.env.DB.prepare(
    'SELECT id, user_id, status, description, style, result_media_id, error, created_at, updated_at FROM image_generation_jobs WHERE id = ? AND user_id = ?'
  ).bind(jobId, userId).first() as any;

  if (!row) {
    throw new PlatformError({
      severity: 'error',
      component: 'ImageGenerator',
      operation: 'generateStatus',
      description: 'Image generation job not found.',
      recommendedActions: ['Check the job ID'],
    });
  }

  const result: Record<string, unknown> = {
    jobId: row.id,
    status: row.status,
    description: row.description,
    error: row.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  // If completed, include the resulting media items
  if (row.status === 'completed' && row.result_media_id) {
    const mediaService = new MediaService(c.env.DB, c.env.R2_BUCKET);
    let mediaIds: string[] = [];
    try {
      mediaIds = JSON.parse(row.result_media_id as string);
    } catch {
      // Legacy single-ID format
      mediaIds = [row.result_media_id as string];
    }

    if (mediaIds.length > 0) {
      // Return first media item for backward compat
      const mediaItem = await mediaService.getById(mediaIds[0], userId);
      if (mediaItem) {
        result.mediaItem = mediaItem;
      }
      // Return all media items
      if (mediaIds.length > 1) {
        const allItems = [];
        for (const mid of mediaIds) {
          const item = await mediaService.getById(mid, userId);
          if (item) allItems.push(item);
        }
        result.mediaItems = allItems;
      }
    }
  }

  return c.json(result);
});

/**
 * POST /temp/save-generated
 * Save an AI-generated image to the media library.
 */
app.post('/temp/save-generated', async (c) => {
  const body = await c.req.json() as Partial<GeneratedImage>;

  if (!body.url || !body.format || !body.width || !body.height || !body.description) {
    throw new PlatformError({
      severity: 'warning',
      component: 'MediaService',
      operation: 'storeGenerated',
      description: 'Missing required fields for saving the generated image.',
      recommendedActions: ['Provide url, format, width, height, and description'],
    });
  }

  // Validate URL: only allow data: URIs or trusted hosts
  const url = body.url.trim();
  if (!url.startsWith('data:')) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new PlatformError({
        severity: 'warning',
        component: 'MediaService',
        operation: 'storeGenerated',
        description: 'Invalid image URL.',
        recommendedActions: ['Provide a valid URL or data URI'],
      });
    }
    const trustedHosts = ['oaidalleapiprodscus.blob.core.windows.net', 'dalleprodsec.blob.core.windows.net'];
    if (parsedUrl.protocol !== 'https:' || !trustedHosts.some((h) => parsedUrl.hostname === h || parsedUrl.hostname.endsWith('.' + h))) {
      throw new PlatformError({
        severity: 'warning',
        component: 'MediaService',
        operation: 'storeGenerated',
        description: 'Image URL is not from a trusted source.',
        recommendedActions: ['Use images generated by the platform'],
      });
    }
  }

  // Validate format
  const validFormats = ['jpeg', 'png', 'webp'];
  if (!validFormats.includes(body.format)) {
    throw new PlatformError({
      severity: 'warning',
      component: 'MediaService',
      operation: 'storeGenerated',
      description: 'Unsupported image format: ' + body.format + '. Supported: ' + validFormats.join(', '),
      recommendedActions: ['Use a supported image format'],
    });
  }

  // Coerce and validate dimensions
  const width = Math.floor(Number(body.width));
  const height = Math.floor(Number(body.height));
  if (!width || width <= 0 || !height || height <= 0) {
    throw new PlatformError({
      severity: 'warning',
      component: 'MediaService',
      operation: 'storeGenerated',
      description: 'Width and height must be positive integers.',
      recommendedActions: ['Provide valid image dimensions'],
    });
  }

  // Trim and validate description
  const description = (body.description || '').trim();
  if (!description) {
    throw new PlatformError({
      severity: 'warning',
      component: 'MediaService',
      operation: 'storeGenerated',
      description: 'A non-empty description is required.',
      recommendedActions: ['Provide a description for the generated image'],
    });
  }

  const mediaService = new MediaService(c.env.DB, c.env.R2_BUCKET);
  const item = await mediaService.storeGenerated(
    { url, format: body.format, width, height, description } as GeneratedImage,
    c.get('user').id,
  );
  return c.json(item, 201);
});

/**
 * DELETE /:id
 * Delete a media item from the library.
 */
app.delete('/:id', async (c) => {
  const mediaService = new MediaService(c.env.DB, c.env.R2_BUCKET);
  await mediaService.delete(c.req.param('id'), c.get('user').id);
  return c.json({ success: true });
});

export default app;
