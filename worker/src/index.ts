import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import type { Bindings } from './bindings.js';
import { errorHandler } from './middleware/error-handler.js';
import { handleImageQueue } from './queue/image-consumer.js';
import type { ImageJobMessage } from './queue/image-consumer.js';
import { handleScheduledSync } from './scheduled/corpus-sync.js';
import authRoutes from './routes/auth.js';
import mediaRoutes from './routes/media.js';
import postRoutes from './routes/posts.js';
import channelRoutes from './routes/channels.js';
import contentRoutes from './routes/content.js';
import settingsRoutes from './routes/settings.js';
import activityLogRoutes from './routes/activity-log.js';
import contentIdeasRoutes from './routes/content-ideas.js';
import quoteRoutes from './routes/quotes.js';
import webhookRoutes from './routes/webhooks.js';
import jobberAuthRoutes from './routes/jobber-auth.js';
import systemsRoutes from './routes/systems.js';
import dashboardRoutes from './routes/dashboard.js';
import reviewRoutes from './routes/reviews.js';

const app = new Hono<{ Bindings: Bindings }>();

// Webhook routes — no CORS or auth, verified via HMAC signature
app.route('/api/webhooks', webhookRoutes);

// CORS – allow the Pages frontend to call the Worker API
app.use('*', cors({
  origin: ['https://cotiza-e4h.pages.dev', 'http://localhost:5173', 'http://192.168.0.31:5173'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Default 10 MB body size limit for non-upload routes
app.use('*', bodyLimit({ maxSize: 10 * 1024 * 1024 }));

// Override with 50 MB limit for media upload endpoints
app.use('/api/media/*', bodyLimit({ maxSize: 50 * 1024 * 1024 }));

// Health check — validates critical environment bindings and DB connectivity
app.get('/health', async (c) => {
  const checks: Record<string, string> = {};

  // Check critical env vars
  const missing: string[] = [];
  const critical = [
    'AI_TEXT_API_KEY',
    'CHANNEL_ENCRYPTION_KEY',
    'FB_PAGE_ACCESS_TOKEN',
    'IG_BUSINESS_ACCOUNT_ID',
    'INSTAGRAM_CLIENT_ID',
    'INSTAGRAM_CLIENT_SECRET',
    'JOBBER_CLIENT_ID',
    'JOBBER_CLIENT_SECRET',
    'JOBBER_ACCESS_TOKEN',
    'JOBBER_REFRESH_TOKEN',
  ] as const;

  for (const key of critical) {
    if (!c.env[key]) missing.push(key);
  }
  if (missing.length > 0) {
    console.warn(`[health] Missing env vars: ${missing.join(', ')}`);
  }
  checks.env = missing.length > 0 ? 'degraded' : 'ok';
  checks.gmail = [
    c.env.GMAIL_CLIENT_ID,
    c.env.GMAIL_CLIENT_SECRET,
    c.env.GMAIL_REFRESH_TOKEN,
  ].every((value) => value?.trim())
    ? 'ok'
    : 'missing';

  // Check DB connectivity
  try {
    const result = await c.env.DB.prepare('SELECT COUNT(*) as count FROM rule_groups').first() as { count: number } | null;
    checks.db = result ? 'ok' : 'error';
  } catch (err) {
    console.warn(`[health] DB check failed: ${err instanceof Error ? err.message : 'unknown'}`);
    checks.db = 'error';
  }

  const status = Object.values(checks).every(v => v.startsWith('ok')) ? 'ok' : 'degraded';

  if (status !== 'ok') {
    console.warn(`[health] ${JSON.stringify(checks)}`);
  }

  return c.json({ status, checks });
});

/**
 * POST /api/admin/backfill-deathclock
 * One-shot endpoint to backfill deathclock metrics for pre-existing requests.
 *
 * Protected by a secret key passed in the `Authorization: Bearer <key>` header.
 * The key must match the `BACKFILL_SECRET_KEY` env var.
 *
 * Response:
 *   { success: true, summary: { totalRequests, markedRequests, noDataDrafts, unchangedDrafts, sentDrafts, errors } }
 */
app.post('/api/admin/backfill-deathclock', async (c) => {
  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token || token !== c.env.BACKFILL_SECRET_KEY) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { runBackfill } = await import('./scripts/backfill-deathclock.js');
  try {
    const summary = await runBackfill(c.env.DB);
    return c.json({ success: true, summary });
  } catch (err) {
    console.error(`[backfill] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return c.json({ success: false, error: 'Backfill failed. See server logs.' }, 500);
  }
});

/**
 * GET /api/admin/dev-secrets/gmail
 * Export Gmail OAuth credentials for local .dev.vars setup.
 * Protected by Authorization: Bearer <DEV_SECRETS_KEY> — a dedicated secret,
 * not CLOUDFLARE_API_TOKEN. Route returns 404 when DEV_SECRETS_KEY is unset.
 */
app.get('/api/admin/dev-secrets/gmail', async (c) => {
  const expected = (c.env.DEV_SECRETS_KEY || '').trim();
  if (!expected) {
    return c.json({ error: 'Not found' }, 404);
  }

  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token || token !== expected) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = c.env;
  if (!GMAIL_CLIENT_ID?.trim() || !GMAIL_CLIENT_SECRET?.trim() || !GMAIL_REFRESH_TOKEN?.trim()) {
    return c.json({ error: 'Gmail secrets not configured on this worker' }, 404);
  }

  return c.json({
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    GMAIL_REFRESH_TOKEN,
  }, 200, {
    'Cache-Control': 'no-store',
  });
});

// API routes
app.route('/api/auth', authRoutes);
app.route('/api/media', mediaRoutes);
app.route('/api/posts', postRoutes);
app.route('/api/channels', channelRoutes);
app.route('/api', contentRoutes);
app.route('/api', settingsRoutes);
app.route('/api/activity-log', activityLogRoutes);
app.route('/api/content-ideas', contentIdeasRoutes);
app.route('/api/quotes', quoteRoutes);
app.route('/api/jobber-auth', jobberAuthRoutes);
app.route('/api/systems', systemsRoutes);
app.route('/api', reviewRoutes);
app.route('/api/dashboard', dashboardRoutes);

// Error handler (must be registered after routes)
app.onError(errorHandler);

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<ImageJobMessage>, env: Bindings): Promise<void> {
    await handleImageQueue(batch, env);
  },
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext): Promise<void> {
    await handleScheduledSync(env, ctx);
  },
};
