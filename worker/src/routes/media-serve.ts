import { Hono } from 'hono';
import { storageKeyFromThumbnailPath, MEDIA_THUMBNAIL_ROUTE } from 'shared';
import type { Bindings } from '../bindings.js';

/**
 * Public media delivery — serves R2 objects at the thumbnail_url paths stored in
 * D1 (e.g. /media/thumbnail/media/{userId}/{file}). No session auth: img/video
 * tags cannot send Authorization headers. Keys contain UUIDs so URLs are
 * unguessable.
 */
const app = new Hono<{ Bindings: Bindings }>();

app.get(MEDIA_THUMBNAIL_ROUTE, async (c) => {
  const storageKey = storageKeyFromThumbnailPath(c.req.path);
  if (!storageKey) {
    return c.text('Not found', 404);
  }

  const object = await c.env.R2_BUCKET.get(storageKey);
  if (!object) {
    return c.text('Not found', 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=86400');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
});

export default app;
