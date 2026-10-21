import type { JobberReadClient } from './ops-assistant-read.js';

// Same live attachment source as the Cotiza request page/enrichment flow.
// Re-fetch on every read: stored Jobber S3 signatures expire.
export const REQUEST_PHOTOS_QUERY = `query AssistantRequestPhotos($id: EncodedId!, $after: String) {
  request(id: $id) {
    id
    noteAttachments(first: 20, after: $after) {
      edges { node { url fileName contentType } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
export interface PhotoAttachment { url?: string; fileName?: string; contentType?: string }

/** Images must be MCP image blocks, never base64 embedded in the JSON text block. */
export function photoToolContent(result: unknown) {
  const { image, ...metadata } = (result ?? {}) as Record<string, unknown> & {
    image?: { type: 'image'; data: string; mimeType: string };
  };
  return [{ type: 'text' as const, text: JSON.stringify(metadata) }, ...(image ? [image] : [])];
}
export interface RequestPhotos {
  id: string;
  noteAttachments?: {
    edges?: Array<{ node?: PhotoAttachment }>;
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  };
}

export async function loadRequestPhotos(jobber: JobberReadClient, requestId: string, after: string | null) {
  const data = await jobber.graphqlRequest<{ request?: RequestPhotos | null }>(REQUEST_PHOTOS_QUERY, { id: requestId, after });
  return data.request ?? null;
}

function safePhotoUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const jobber = host === 'getjobber.com' || host.endsWith('.getjobber.com');
  const s3 = /^(?:[a-z0-9-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || (!jobber && !s3)) {
    throw new Error('unsupported_photo_host');
  }
  return url;
}

/** Fetch only a fresh Jobber-returned URL; never forward Jobber auth or follow redirects. */
export async function downloadRequestPhoto(attachment: PhotoAttachment) {
  if (!attachment.url) throw new Error('photo_url_missing');
  const url = safePhotoUrl(attachment.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url.toString(), { redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error('photo_download_failed');
    const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new Error('unsupported_photo_type');
    if (Number(response.headers.get('content-length')) > MAX_PHOTO_BYTES) {
      await response.body.cancel();
      throw new Error('photo_too_large');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_PHOTO_BYTES) throw new Error('photo_too_large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
    const webp = size >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    if (!(mimeType === 'image/jpeg' ? jpeg : mimeType === 'image/png' ? png : webp)) throw new Error('invalid_photo_bytes');
    let binary = '';
    for (let i = 0; i < size; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { type: 'image' as const, mimeType, data: btoa(binary) };
  } finally {
    clearTimeout(timer);
  }
}
