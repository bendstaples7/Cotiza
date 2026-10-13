import { Hono } from 'hono';
import type { Bindings } from '../bindings.js';
import { JobberWebhookService, type JobberWebhookPayload } from '../services/jobber-webhook-service.js';
import { JobberTokenStore } from '../services/jobber-token-store.js';
import { ActivityLogService } from '../services/index.js';
import { sanitizeLogText } from '../services/jobber-log-sanitize.mjs';

const app = new Hono<{ Bindings: Bindings }>();

/**
 * POST /jobber
 *
 * Receives Jobber webhook events. No session auth — verified via HMAC.
 * Responds immediately, processes via waitUntil for async handling.
 */
app.post('/jobber', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('x-jobber-hmac-sha256') || '';

  // Verify HMAC signature before doing any DB work
  if (c.env.JOBBER_CLIENT_SECRET) {
    // Use the client secret directly for HMAC — no need for token store yet
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(c.env.JOBBER_CLIENT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
    const calculated = btoa(String.fromCharCode(...new Uint8Array(sig)));

    let mismatch = calculated.length !== (signature || '').length ? 1 : 0;
    for (let i = 0; i < calculated.length; i++) {
      mismatch |= calculated.charCodeAt(i) ^ (signature || '').charCodeAt(i);
    }
    if (!signature || mismatch !== 0) {
      return c.json({ error: 'Invalid signature' }, 401);
    }
  }

  let payload: JobberWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as JobberWebhookPayload;
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!payload?.data?.webHookEvent?.topic || !payload?.data?.webHookEvent?.itemId) {
    return c.json({ error: 'Invalid webhook payload' }, 400);
  }

  // Only load tokens and create services after validation passes
  const activityLog = new ActivityLogService(c.env.DB);
  const tokenStore = new JobberTokenStore(c.env.DB);
  const webhookService = new JobberWebhookService(c.env.DB, activityLog, {
    accessToken: c.env.JOBBER_ACCESS_TOKEN || '',
    clientSecret: c.env.JOBBER_CLIENT_SECRET || '',
    clientId: c.env.JOBBER_CLIENT_ID || '',
    refreshToken: c.env.JOBBER_REFRESH_TOKEN || '',
    tokenStore,
  });
  await webhookService.loadPersistedTokens();

  // Process asynchronously via waitUntil (keeps worker alive after response)
  c.executionCtx.waitUntil(
    webhookService.processWebhook(payload).catch((err) => {
      console.error(`[webhooks] processWebhook failed operation=processWebhook ${sanitizeLogText(err instanceof Error ? err.message : err)}`);
    })
  );

  return c.json({ received: true }, 200);
});

/**
 * POST /backfill
 *
 * One-time backfill: fetches all existing requests from Jobber API,
 * then fetches full details for each and stores in the webhook table.
 * Protected by JOBBER_CLIENT_SECRET in the Authorization header.
 */
app.post('/backfill', async (c) => {
  // Simple secret-based auth for this admin endpoint
  const authHeader = c.req.header('Authorization') || '';
  const secret = c.env.JOBBER_CLIENT_SECRET;
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Prevent concurrent backfills — check if one ran recently
  const db = c.env.DB;
  try {
    const recent = await db.prepare(
      `SELECT COUNT(*) as count FROM jobber_webhook_requests WHERE topic = 'BACKFILL' AND received_at > datetime('now', '-5 minutes')`
    ).first() as { count: number } | null;
    if ((recent?.count ?? 0) > 0) {
      return c.json({ error: 'Backfill ran recently. Wait 5 minutes before retrying.' }, 429);
    }
  } catch { /* table may not exist yet, proceed */ }

  const activityLog = new ActivityLogService(db);
  const tokenStore = new JobberTokenStore(db);
  const webhookService = new JobberWebhookService(db, activityLog, {
    accessToken: c.env.JOBBER_ACCESS_TOKEN || '',
    clientSecret: c.env.JOBBER_CLIENT_SECRET || '',
    clientId: c.env.JOBBER_CLIENT_ID || '',
    refreshToken: c.env.JOBBER_REFRESH_TOKEN || '',
    tokenStore,
  });
  await webhookService.loadPersistedTokens();

  const result = await webhookService.backfillFromApi(c.env.JOBBER_ACCESS_TOKEN || '');
  return c.json({ message: 'Backfill complete', ...result });
});

export default app;
