/** Private receipt storage. Jobber receives a short-lived capability URL, never a public bucket URL. */
export const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
export class ReceiptInputError extends Error {}
const UUID = /^[a-f0-9-]{36}$/;
export interface ReceiptRow { id: string; user_id: string; storage_key: string; file_name: string; content_type: string; size: number; expires_at: string; sha256: string }
export async function digest(value: Uint8Array | string) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function receiptMime(bytes: Uint8Array): string {
  if (!bytes.length || bytes.length > MAX_RECEIPT_BYTES) throw new ReceiptInputError('Receipt must be between 1 byte and 8 MiB.');
  const head = new TextDecoder().decode(bytes.slice(0, 12));
  if (head.startsWith('%PDF-')) return 'application/pdf';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((x, i) => bytes[i] === x)) return 'image/png';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  throw new ReceiptInputError('Upload a PDF, JPEG, PNG or WebP receipt.');
}
export async function boundedBytes(stream: ReadableStream<Uint8Array> | null, limit: number) {
  if (!stream) throw new ReceiptInputError('File body is missing.');
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > limit) { await reader.cancel(); throw new ReceiptInputError('File exceeds size limit.'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; } return out;
}
function trustedSource(raw: string) {
  let url: URL; try { url = new URL(raw); } catch { throw new ReceiptInputError('Invalid receipt source URL.'); }
  const host = url.hostname;
  const trusted = host === 'squareup.com' || host === 'a.squareupmessaging.com' || /(^|\.)oaiusercontent\.com$/.test(host) || /^(?:oais|sdmnt)[a-z0-9-]*\.blob\.core\.windows\.net$/.test(host) || /^(?:oais|sdmnt)[a-z0-9-]*.*\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(host);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !trusted) throw new ReceiptInputError('Use a ChatGPT file link or upload the receipt bytes. Other source hosts are not fetched.');
  return url;
}
export class AssistantReceiptStore {
  constructor(private db: D1Database, private bucket: R2Bucket, private origin: string) {}
  async stage(userId: string, fileName: string, bytes: Uint8Array) {
    const contentType = receiptMime(bytes); const id = crypto.randomUUID();
    const name = fileName.split(/[\\/]/).pop()!.replace(/[^a-zA-Z0-9 ._()-]/g, '_').slice(0, 120) || 'receipt';
    const storageKey = `assistant-private-receipts/${userId}/${id}`;
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const checksum = await digest(bytes);
    await this.bucket.put(storageKey, bytes, { httpMetadata: { contentType } });
    try {
      await this.db.prepare('INSERT INTO assistant_receipts (id, user_id, storage_key, file_name, content_type, size, sha256, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, userId, storageKey, name, contentType, bytes.length, checksum, expires).run();
    } catch (error) { await this.bucket.delete(storageKey); throw error; }
    return { receiptId: id, receiptReference: `receipt-${checksum}`, fileName: name, contentType, size: bytes.length, expiresAt: expires };
  }
  async stageSource(userId: string, args: Record<string, unknown>) {
    if (typeof args.fileName !== 'string' || args.fileName.length > 200) throw new ReceiptInputError('fileName is required.');
    if (typeof args.contentBase64 === 'string' && args.sourceUrl === undefined) {
      if (args.contentBase64.length > Math.ceil(MAX_RECEIPT_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.contentBase64)) throw new ReceiptInputError('Invalid or oversized base64 receipt.');
      let binary: string; try { binary = atob(args.contentBase64); } catch { throw new ReceiptInputError('Invalid base64 receipt.'); }
      return this.stage(userId, args.fileName, Uint8Array.from(binary, ch => ch.charCodeAt(0)));
    }
    if (typeof args.sourceUrl !== 'string' || args.contentBase64 !== undefined) throw new ReceiptInputError('Provide either receipt bytes or a temporary sourceUrl.');
    let url = trustedSource(args.sourceUrl);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if ([301, 302, 303, 307, 308].includes(res.status)) { const next = res.headers.get('location'); await res.body?.cancel(); if (!next) break; url = trustedSource(new URL(next, url).href); continue; }
      if (!res.ok) { await res.body?.cancel(); throw new ReceiptInputError('Receipt source could not be downloaded. Upload the file bytes instead.'); }
      return this.stage(userId, args.fileName, await boundedBytes(res.body, MAX_RECEIPT_BYTES));
    }
    throw new ReceiptInputError('Receipt source redirected too many times.');
  }
  async owned(userId: string, id: string) {
    if (!UUID.test(id)) throw new ReceiptInputError('Invalid receiptId.');
    const row = await this.db.prepare('SELECT * FROM assistant_receipts WHERE id = ? AND user_id = ?').bind(id, userId).first<ReceiptRow>();
    if (!row || Date.parse(row.expires_at) <= Date.now()) throw new ReceiptInputError('Receipt is missing, expired, or belongs to another user.');
    return row;
  }
  async preview(userId: string, id: string) { const row = await this.owned(userId, id); return this.file(row); }
  async grant(userId: string, id: string) {
    await this.owned(userId, id);
    const secret = crypto.randomUUID() + crypto.randomUUID();
    await this.db.prepare('INSERT INTO assistant_receipt_grants (token_hash, receipt_id, expires_at) VALUES (?, ?, ?)')
      .bind(await digest(secret), id, new Date(Date.now() + 30 * 60 * 1000).toISOString()).run();
    return `${this.origin}/api/assistant/receipt-download/${id}?key=${secret}`;
  }
  async download(id: string, secret: string) {
    if (!UUID.test(id) || secret.length !== 72) return null;
    const row = await this.db.prepare('SELECT r.* FROM assistant_receipts r JOIN assistant_receipt_grants g ON g.receipt_id = r.id WHERE r.id = ? AND g.token_hash = ? AND g.expires_at > ?')
      .bind(id, await digest(secret), new Date().toISOString()).first<ReceiptRow>();
    if (!row || Date.parse(row.expires_at) <= Date.now()) return null;
    return this.file(row);
  }
  private async file(row: ReceiptRow) {
    const object = await this.bucket.get(row.storage_key); if (!object) return null;
    return new Response(object.body, { headers: { 'Content-Type': row.content_type, 'Content-Length': String(row.size), 'Content-Disposition': `attachment; filename="${row.file_name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Referrer-Policy': 'no-referrer' } });
  }
  async cleanup() {
    const rows = await this.db.prepare('SELECT id, storage_key FROM assistant_receipts WHERE expires_at < ? LIMIT 100').bind(new Date().toISOString()).all<{ id: string; storage_key: string }>();
    for (const row of rows.results ?? []) { await this.bucket.delete(row.storage_key); await this.db.prepare('DELETE FROM assistant_receipt_grants WHERE receipt_id = ?').bind(row.id).run(); await this.db.prepare('DELETE FROM assistant_receipts WHERE id = ?').bind(row.id).run(); }
  }
}
