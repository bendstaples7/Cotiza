import { Hono } from 'hono';
import type { Bindings } from '../bindings.js';
import type { User } from 'shared';
import { sessionMiddleware } from '../middleware/session.js';
import { ManualRequestService } from '../services/index.js';

// ── Deathclock stats: in-memory cache ──────────────────────────
// Simple 60s TTL cache keyed by userId. Resets on worker cold start,
// which is acceptable — first request after cold start fetches fresh.
const cacheStore = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL_MS = 60_000;
const TRENDS_CACHE_TTL_MS = 300_000; // 5 minutes

/**
 * Invalidate the deathclock stats cache for a user.
 * Called by quote-send endpoints (mark-sent, push) when a quote is sent.
 */
export function invalidateDeathclockCache(userId: string): void {
  cacheStore.delete(userId);
}

/**
 * Invalidate the trends cache for a user.
 * Called by quote-send endpoints when a quote is sent.
 */
export function invalidateTrendsCache(userId: string): void {
  cacheStore.delete(`trends:${userId}`);
}

const app = new Hono<{ Bindings: Bindings; Variables: { user: User } }>();

app.use('*', sessionMiddleware);

/**
 * GET /deathclock-stats
 * Returns aggregate deathclock bucket counts for the authenticated user.
 *
 * Buckets:
 *   green  →  age < 24h
 *   yellow →  24h ≤ age < 48h
 *   orange →  48h ≤ age < 72h
 *   red    →  age ≥ 72h
 *
 * Cached server-side for 60 seconds. Cache is invalidated on any
 * quote-send event (mark-sent or push endpoints).
 */
app.get('/deathclock-stats', async (c) => {
  const userId = c.get('user').id;

  // Check cache
  const cached = cacheStore.get(userId);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return c.json(cached.data);
  }

  const manualRequestService = new ManualRequestService(c.env.DB);
  const stats = await manualRequestService.getDeathclockStats(userId);

  // Populate cache
  cacheStore.set(userId, { data: stats, timestamp: Date.now() });

  return c.json(stats);
});

/**
 * GET /trends
 * Returns rolling averages and daily bucket history for deathclock trend
 * visualization.
 *
 * Response shape:
 *   {
 *     avg7Days: number,       // rolling 7-day average request-to-quote seconds
 *     avg30Days: number,      // rolling 30-day average request-to-quote seconds
 *     bucketHistory: [         // per-day bucket snapshot for last 7 days
 *       { date: string, green: number, yellow: number, orange: number, red: number }
 *     ]
 *   }
 *
 * Cached server-side for 5 minutes. Cache is invalidated on quote-send
 * events via invalidateTrendsCache().
 */
app.get('/trends', async (c) => {
  const userId = c.get('user').id;
  const cacheKey = `trends:${userId}`;

  // Check cache
  const cached = cacheStore.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < TRENDS_CACHE_TTL_MS) {
    return c.json(cached.data);
  }

  const manualRequestService = new ManualRequestService(c.env.DB);
  const trends = await manualRequestService.getTrends(userId);

  // Populate cache
  cacheStore.set(cacheKey, { data: trends, timestamp: Date.now() });

  return c.json(trends);
});

export default app;