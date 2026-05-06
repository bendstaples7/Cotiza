/**
 * Scheduled handler for automatic corpus sync.
 * Runs on a Cloudflare Cron Trigger to keep the quote corpus and quantity history up to date.
 */

import type { Bindings } from '../bindings.js';
import { ActivityLogService } from '../services/activity-log-service.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { JobberIntegration } from '../services/jobber-integration.js';
import { JobberTokenStore } from '../services/jobber-token-store.js';
import { QuoteSyncService } from '../services/quote-sync-service.js';
import { QuantityEngine } from '../services/quantity-engine.js';

export async function handleScheduledSync(env: Bindings, ctx: ExecutionContext): Promise<void> {
  const db = env.DB;

  // Concurrency guard — same as the manual sync route
  const claimResult = await db.prepare(
    `UPDATE quote_corpus_sync_status
     SET last_sync_at = datetime('now'), last_sync_error = '__RUNNING__'
     WHERE id = 1 AND (last_sync_error != '__RUNNING__' OR last_sync_error IS NULL
       OR last_sync_at < datetime('now', '-10 minutes'))`
  ).run();

  if (!claimResult.meta.changes || claimResult.meta.changes === 0) {
    console.log('[scheduled] Corpus sync already in progress, skipping.');
    return;
  }

  const activityLog = new ActivityLogService(db);
  const tokenStore = new JobberTokenStore(db);
  const jobberIntegration = new JobberIntegration(activityLog, {
    clientId: env.JOBBER_CLIENT_ID || '',
    clientSecret: env.JOBBER_CLIENT_SECRET || '',
    accessToken: env.JOBBER_ACCESS_TOKEN || '',
    refreshToken: env.JOBBER_REFRESH_TOKEN || '',
    apiUrl: env.JOBBER_API_URL || undefined,
    tokenStore,
  });
  await jobberIntegration.loadPersistedTokens();

  const embeddingService = new EmbeddingService(env.AI_TEXT_API_KEY);
  const quantityEngine = new QuantityEngine(db);
  const quoteSyncService = new QuoteSyncService(db, embeddingService, activityLog, jobberIntegration, quantityEngine);

  try {
    const result = await quoteSyncService.sync();
    console.log(`[scheduled] Corpus sync completed: ${result.totalFetched} fetched, ${result.newQuotes} new, ${result.updatedQuotes} updated.`);
  } catch (err) {
    console.error('[scheduled] Corpus sync failed:', err instanceof Error ? err.message : err);
  } finally {
    // Release lock if still held
    try {
      const stillRunning = await db.prepare(
        "SELECT 1 FROM quote_corpus_sync_status WHERE id = 1 AND last_sync_error = '__RUNNING__'"
      ).first();
      if (stillRunning) {
        await db.prepare(
          "UPDATE quote_corpus_sync_status SET last_sync_error = 'Scheduled sync terminated unexpectedly' WHERE id = 1 AND last_sync_error = '__RUNNING__'"
        ).run();
      }
    } catch { /* best-effort cleanup */ }
  }
}
