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

const app = new Hono<{ Bindings: Bindings }>();

// Webhook routes — no CORS or auth, verified via HMAC signature
app.route('/api/webhooks', webhookRoutes);

// CORS – allow the Pages frontend to call the Worker API
app.use('*', cors({
  origin: ['https://cotiza-e4h.pages.dev'],
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
