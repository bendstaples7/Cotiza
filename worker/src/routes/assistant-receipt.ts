import { Hono } from 'hono';
import type { Bindings } from '../bindings.js';

const RECEIPT_NAME = /^\d{13}-[A-Za-z0-9_-]{43}\.pdf$/;
const app = new Hono<{ Bindings: Bindings }>();

app.get('/assistant-receipt/:name', async (c) => {
  const name = c.req.param('name');
  if (!RECEIPT_NAME.test(name) || Number(name.slice(0, 13)) < Date.now()) return c.text('Not found', 404);
  const object = await c.env.R2_BUCKET.get(`assistant-receipts/${name}`);
  if (!object) return c.text('Not found', 404);
  return new Response(object.body, { headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
});

/** Deletes assistant-receipts/ objects whose expiry prefix is in the past (scheduled sweep). */
export async function sweepExpiredReceipts(bucket: R2Bucket): Promise<void> {
  const prefix = 'assistant-receipts/';
  const now = Date.now();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    const expired = page.objects
      .map((o) => o.key)
      .filter((key) => RECEIPT_NAME.test(key.slice(prefix.length)) && Number(key.slice(prefix.length, prefix.length + 13)) < now);
    if (expired.length) await bucket.delete(expired);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export default app;
