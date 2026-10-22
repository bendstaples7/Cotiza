import { describe, expect, it, vi } from 'vitest';
import { AssistantReceiptStore, boundedBytes, MAX_RECEIPT_BYTES, receiptMime } from '../../worker/src/services/assistant-receipts.js';
const pdf = new TextEncoder().encode('%PDF-1.7\nprivate receipt\n%%EOF');
function setup() {
  const rows = new Map<string, any>(); const grants = new Map<string, any>(); const files = new Map<string, Uint8Array>();
  const db = { prepare(sql: string) { return { bind(...args: any[]) { return {
    async run() {
      if (sql.startsWith('INSERT INTO assistant_receipts')) rows.set(args[0], { id: args[0], user_id: args[1], storage_key: args[2], file_name: args[3], content_type: args[4], size: args[5], sha256: args[6], expires_at: args[7] });
      if (sql.startsWith('INSERT INTO assistant_receipt_grants')) grants.set(args[0], { receipt_id: args[1], expires_at: args[2] });
      if (sql.startsWith('DELETE FROM assistant_receipt_grants')) for (const [key, value] of grants) if (value.receipt_id === args[0]) grants.delete(key);
      if (sql.startsWith('DELETE FROM assistant_receipts')) rows.delete(args[0]);
      return { meta: { changes: 1 } };
    },
    async first() {
      const row = rows.get(args[0]); if (!row) return null;
      if (sql.includes('JOIN')) { const grant = grants.get(args[1]); return grant?.receipt_id === row.id && Date.parse(grant.expires_at) > Date.now() ? row : null; }
      return row.user_id === args[1] ? row : null;
    },
    async all() { return { results: [...rows.values()].filter(r => Date.parse(r.expires_at) < Date.now()) }; },
  }; } }; } };
  const bucket = { put: vi.fn(async (key: string, bytes: Uint8Array) => { files.set(key, bytes); }), get: vi.fn(async (key: string) => files.has(key) ? { body: new Response(files.get(key)).body } : null), delete: vi.fn(async (key: string) => { files.delete(key); }) };
  return { store: new AssistantReceiptStore(db as never, bucket as never, 'https://worker.example'), rows, grants, bucket, files };
}
describe('private receipt transfer', () => {
  it('detects supported file bytes and rejects HTML and oversized uploads', () => {
    expect(receiptMime(pdf)).toBe('application/pdf');
    expect(receiptMime(Uint8Array.from([255, 216, 255, 1]))).toBe('image/jpeg');
    expect(receiptMime(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe('image/png');
    expect(receiptMime(new TextEncoder().encode('RIFF1234WEBP'))).toBe('image/webp');
    expect(() => receiptMime(new TextEncoder().encode('<html>fake.pdf</html>'))).toThrow();
    expect(() => receiptMime(new Uint8Array(MAX_RECEIPT_BYTES + 1))).toThrow();
  });
  it('keeps bytes private, enforces ownership, and requires a live download grant', async () => {
    const { store, bucket, rows, grants } = setup();
    const receipt = await store.stage('u', '../../private.pdf', pdf);
    expect(receipt.fileName).toBe('private.pdf');
    expect(bucket.put.mock.calls[0][0]).toMatch(/^assistant-private-receipts\/u\//);
    expect(JSON.stringify(receipt)).not.toContain('http');
    await expect(store.owned('other', receipt.receiptId)).rejects.toThrow();
    const url = new URL(await store.grant('u', receipt.receiptId)); const key = url.searchParams.get('key')!;
    expect(await store.download(receipt.receiptId, 'x'.repeat(72))).toBeNull();
    const response = await store.download(receipt.receiptId, key);
    expect(await response!.text()).toContain('private receipt');
    expect(response!.headers.get('Cache-Control')).toBe('no-store');
    expect([...grants.keys()][0]).not.toBe(key);
    [...grants.values()][0].expires_at = '2000-01-01';
    expect(await store.download(receipt.receiptId, key)).toBeNull();
    rows.get(receipt.receiptId).expires_at = '2000-01-01';
    await expect(store.owned('u', receipt.receiptId)).rejects.toThrow();
  });
  it('does not invalidate a prior Jobber grant when the same file is used again', async () => {
    const { store } = setup(); const r = await store.stage('u', 'receipt.pdf', pdf);
    const first = new URL(await store.grant('u', r.receiptId));
    const second = new URL(await store.grant('u', r.receiptId));
    expect(await store.download(r.receiptId, first.searchParams.get('key')!)).not.toBeNull();
    expect(await store.download(r.receiptId, second.searchParams.get('key')!)).not.toBeNull();
  });
  it('gives identical bytes a stable receipt reference and purges expired private files', async () => {
    const { store, rows, files, grants } = setup(); const a = await store.stage('u', 'one.pdf', pdf); const b = await store.stage('u', 'two.pdf', pdf);
    expect(a.receiptReference).toBe(b.receiptReference);
    await store.grant('u', a.receiptId); rows.get(a.receiptId).expires_at = '2000-01-01'; await store.cleanup();
    expect(files.size).toBe(1); expect(grants.size).toBe(0); expect(rows.has(a.receiptId)).toBe(false);
  });
  it('cancels oversized streams without trusting Content-Length', async () => {
    let canceled = false;
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(20)); }, cancel() { canceled = true; } });
    await expect(boundedBytes(stream, 10)).rejects.toThrow('size'); expect(canceled).toBe(true);
  });
  it('rejects internal sources and rechecks every redirect host', async () => {
    const { store } = setup(); const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })); vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(store.stageSource('u', { fileName: 'a.pdf', sourceUrl: 'https://127.0.0.1/a' })).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(store.stageSource('u', { fileName: 'a.pdf', sourceUrl: 'https://files.oaiusercontent.com/a' })).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it('accepts email attachment bytes without a remote URL', async () => {
    const { store } = setup();
    const result = await store.stageSource('u', { fileName: 'invoice.pdf', contentBase64: btoa(new TextDecoder().decode(pdf)) });
    expect(result.contentType).toBe('application/pdf');
  });
});
