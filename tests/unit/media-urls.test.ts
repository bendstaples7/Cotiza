import { describe, it, expect } from 'vitest';
import {
  buildMediaThumbnailPath,
  storageKeyFromThumbnailPath,
  resolveMediaUrl,
  MEDIA_PUBLIC_MOUNT,
  PUBLIC_MEDIA_ROUTE_PREFIXES,
} from '../../shared/src/media-urls.js';

describe('media-urls (shared contract)', () => {
  it('buildMediaThumbnailPath round-trips through storageKeyFromThumbnailPath', () => {
    const key = 'media/user-1/ai-generated-abc.png';
    const path = buildMediaThumbnailPath(key);
    expect(path).toBe('/media/thumbnail/media/user-1/ai-generated-abc.png');
    expect(storageKeyFromThumbnailPath(path)).toBe(key);
  });

  it('rejects path traversal in storageKeyFromThumbnailPath', () => {
    expect(storageKeyFromThumbnailPath('/media/thumbnail/../etc/passwd')).toBeNull();
    expect(storageKeyFromThumbnailPath('/api/media/x')).toBeNull();
  });

  it('resolveMediaUrl passes through blob, data, and http(s) URLs unchanged', () => {
    expect(resolveMediaUrl('blob:http://localhost/x')).toBe('blob:http://localhost/x');
    expect(resolveMediaUrl('data:image/png;base64,abc')).toBe('data:image/png;base64,abc');
    expect(resolveMediaUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
  });

  it('resolveMediaUrl maps bare storage keys to the canonical thumbnail path', () => {
    expect(resolveMediaUrl('media/user-1/file.jpg')).toBe('/media/thumbnail/media/user-1/file.jpg');
  });

  it('PUBLIC_MEDIA_ROUTE_PREFIXES covers the thumbnail mount', () => {
    expect(PUBLIC_MEDIA_ROUTE_PREFIXES).toContain(MEDIA_PUBLIC_MOUNT);
    expect(buildMediaThumbnailPath('x').startsWith(MEDIA_PUBLIC_MOUNT)).toBe(true);
  });
});
