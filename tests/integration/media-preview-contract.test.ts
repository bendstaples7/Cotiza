import { describe, it, expect, vi } from 'vitest';
import mediaServe from '../../worker/src/routes/media-serve.js';
import mediaRoutes from '../../worker/src/routes/media.js';
import { buildMediaThumbnailPath, resolveMediaUrl } from '../../shared/src/media-urls.js';
import { createMockD1, configurePrepareResults } from '../unit/helpers/mock-d1.js';

const NOW = new Date().toISOString();

function sessionRow() {
  return {
    session_id: 'sess-1',
    last_active_at: NOW,
    id: 'user-1',
    email: 'ben@chicago-reno.com',
    name: 'Ben',
    created_at: NOW,
    user_last_active: NOW,
  };
}

/** Minimal valid 1×1 PNG for serve-route tests. */
const MINI_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

function mockR2(objects: Record<string, Uint8Array>) {
  return {
    get: vi.fn(async (key: string) => {
      const bytes = objects[key];
      if (!bytes) return null;
      return {
        body: bytes,
        writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', 'image/png'),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    }),
    put: vi.fn(),
  };
}

describe('media preview contract (generate → preview → attach)', () => {
  it('serves generated images at the canonical thumbnail path with image/* content-type', async () => {
    const storageKey = 'media/user-1/ai-generated-test.png';
    const r2 = mockR2({ [storageKey]: MINI_PNG });

    const res = await mediaServe.request(buildMediaThumbnailPath(storageKey), {}, { R2_BUCKET: r2 } as never);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('image/');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBeGreaterThan(0);
    expect(r2.get).toHaveBeenCalledWith(storageKey);
  });

  it('maps a completed generate-status mediaItem to a resolvable preview URL', async () => {
    const storageKey = 'media/user-1/ai-generated-xyz.png';
    const mediaItem = {
      id: 'media-1',
      storageKey,
      thumbnailUrl: buildMediaThumbnailPath(storageKey),
      mimeType: 'image/png',
      width: 1024,
      height: 1024,
      aiDescription: 'A bright living room',
    };

    const previewUrl = resolveMediaUrl(mediaItem.thumbnailUrl || mediaItem.storageKey);
    expect(previewUrl).toBe(buildMediaThumbnailPath(storageKey));

    const r2 = mockR2({ [storageKey]: MINI_PNG });
    const res = await mediaServe.request(previewUrl, {}, { R2_BUCKET: r2 } as never);
    expect(res.status).toBe(200);
  });

  it('rejects save-generated for queue-persisted thumbnail paths (attach uses mediaItem directly)', async () => {
    const storageKey = 'media/user-1/ai-generated-xyz.png';
    const db = createMockD1();
    configurePrepareResults(db, [
      { first: sessionRow() },
      { run: { success: true } },
    ]);

    const res = await mediaRoutes.request(
      '/temp/save-generated',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          url: buildMediaThumbnailPath(storageKey),
          format: 'png',
          width: 1024,
          height: 1024,
          description: 'Already stored in R2 by the queue consumer',
        }),
      },
      { DB: db } as never,
    );

    // Queue pipeline already persisted the file — re-saving via temp/save-generated
    // must fail so callers use the returned mediaItem instead.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
