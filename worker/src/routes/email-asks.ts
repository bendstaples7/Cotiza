import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Bindings } from '../bindings.js';

const app = new Hono<{ Bindings: Bindings }>();

/** 404 when EMAIL_ASKS_KEY is unset, 401 on a missing/wrong bearer key (same shape as DEV_SECRETS_KEY). */
function unauthorized(c: Context<{ Bindings: Bindings }>): Response | null {
  const expected = (c.env.EMAIL_ASKS_KEY || '').trim();
  if (!expected) return c.json({ error: 'Not found' }, 404);
  const header = c.req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || token !== expected) return c.json({ error: 'Unauthorized' }, 401);
  return null;
}

/** GET / - open asks (needs_you or drafted), newest first. */
app.get('/', async (c) => {
  const denied = unauthorized(c);
  if (denied) return denied;
  const rows = await c.env.DB.prepare(
    "SELECT * FROM email_asks WHERE status IN ('needs_you', 'drafted') ORDER BY received_at DESC, created_at DESC LIMIT 200",
  ).all();
  c.header('Cache-Control', 'no-store');
  return c.json({ items: rows.results ?? [] });
});

/** POST /:messageId/status - Ben marks a row done or dismissed. */
app.post('/:messageId/status', async (c) => {
  const denied = unauthorized(c);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => null)) as { status?: unknown } | null;
  const status = body?.status;
  if (status !== 'done' && status !== 'dismissed') {
    return c.json({ error: "status must be 'done' or 'dismissed'" }, 400);
  }
  const messageId = c.req.param('messageId');
  const result = await c.env.DB.prepare(
    "UPDATE email_asks SET status = ?, updated_at = datetime('now') WHERE message_id = ?",
  ).bind(status, messageId).run();
  if (!result.meta.changes) return c.json({ error: 'Not found' }, 404);
  return c.json({ messageId, status });
});

export default app;
