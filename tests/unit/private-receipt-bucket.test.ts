import { describe, expect, it, vi } from 'vitest';
import { ensurePrivateReceiptsBucket } from '../../worker/scripts/ensure-private-receipts-bucket.mjs';
const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }));
describe('private receipt bucket deployment gate', () => {
  it('creates a missing bucket and verifies that neither managed nor custom public access is enabled', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(ok({ name: 'receipts' })).mockResolvedValueOnce(ok({ enabled: false })).mockResolvedValueOnce(ok({ domains: [] }));
    expect(await ensurePrivateReceiptsBucket({ accountId: 'a', token: 'secret', bucketName: 'receipts', fetchImpl })).toEqual({ private: true });
    expect(fetchImpl.mock.calls[1][1].method).toBe('POST');
    expect(fetchImpl.mock.calls.every(([, init]) => init.method !== 'PUT')).toBe(true);
  });
  it('does not interpret a permission failure as a missing bucket', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    await expect(ensurePrivateReceiptsBucket({ accountId: 'a', token: 'secret', bucketName: 'receipts', fetchImpl })).rejects.toThrow('No bucket was created');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('fails closed for public receipt storage', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(ok({})).mockResolvedValueOnce(ok({ enabled: true })).mockResolvedValueOnce(ok({ domains: [] }));
    await expect(ensurePrivateReceiptsBucket({ accountId: 'a', token: 'secret', bucketName: 'receipts', fetchImpl })).rejects.toThrow('public access');
  });
});
