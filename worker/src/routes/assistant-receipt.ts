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

export default app;
