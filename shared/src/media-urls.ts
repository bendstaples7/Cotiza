/**
 * Canonical media URL paths — single source of truth.
 *
 * Thumbnail paths stored in D1 must match the worker's public serve route and
 * must be reachable from the client via vite proxy (dev) and _redirects (Pages).
 * Do not hand-assemble `/media/thumbnail/...` elsewhere; use these helpers.
 */

/** Hono route pattern for the public thumbnail handler. */
export const MEDIA_THUMBNAIL_ROUTE = '/media/thumbnail/*' as const;

/** Public path prefix for R2-backed thumbnails (stored in media_items.thumbnail_url). */
export const MEDIA_THUMBNAIL_PREFIX = '/media/thumbnail/' as const;

/** Top-level mount proxied in dev and redirected on Pages (covers all /media/* routes). */
export const MEDIA_PUBLIC_MOUNT = '/media' as const;

/** Prefixes that must be wired in client/vite.config.ts proxy and client/public/_redirects. */
export const PUBLIC_MEDIA_ROUTE_PREFIXES = [MEDIA_PUBLIC_MOUNT] as const;

/** Build the thumbnail_url value persisted for a given R2 storage key. */
export function buildMediaThumbnailPath(storageKey: string): string {
  return MEDIA_THUMBNAIL_PREFIX + storageKey;
}

/** Extract the R2 storage key from a thumbnail path, or null if invalid. */
export function storageKeyFromThumbnailPath(thumbnailPath: string): string | null {
  if (!thumbnailPath.startsWith(MEDIA_THUMBNAIL_PREFIX)) return null;
  const key = thumbnailPath.slice(MEDIA_THUMBNAIL_PREFIX.length);
  if (!key || key.includes('..')) return null;
  return key;
}

/**
 * Resolve a media reference for use in img/video src attributes.
 * Handles bare storage keys, thumbnail paths, blob/data/http URLs.
 */
export function resolveMediaUrl(url: string): string {
  if (!url) return url;
  if (
    url.startsWith('blob:') ||
    url.startsWith('data:') ||
    url.startsWith('http://') ||
    url.startsWith('https://')
  ) {
    return url;
  }
  if (url.startsWith(MEDIA_THUMBNAIL_PREFIX)) return url;
  if (!url.startsWith('/')) return buildMediaThumbnailPath(url);
  return url;
}
