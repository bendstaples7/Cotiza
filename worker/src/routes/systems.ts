import { Hono } from 'hono';
import type { Bindings } from '../bindings.js';
import type { User, SystemsStatusResponse } from 'shared';
import { sessionMiddleware } from '../middleware/session.js';
import { openJobberIntegration } from '../services/jobber-integration.js';
import { jobberStatusPayload } from '../services/jobber-read.js';
import { JobberWebSession } from '../services/jobber-web-session.js';

const app = new Hono<{ Bindings: Bindings; Variables: { user: User } }>();

app.use('*', sessionMiddleware);

/**
 * GET /status
 * Returns aggregated status of all external service connections.
 * Jobber OAuth: makes a lightweight API call to verify tokens are valid.
 * Jobber Session: checks cookies, auto-refreshes via Browser Rendering if expired.
 * Instagram: checks channel_connections for the authenticated user.
 */
app.get('/status', async (c) => {
  const db = c.env.DB;
  const userId = c.get('user').id;
  const isLocalDev = c.env.ENABLE_LOCAL_SYNC === 'true';

  // ── Jobber live probe (same contract as GET /api/quotes/jobber/status) ──
  let jobber: SystemsStatusResponse['jobber'] = {
    available: false,
    webhookActive: false,
    read: {
      status: 'failed',
      source: 'none',
      fetchedAt: null,
      liveLookupFailed: true,
      error: { code: 'unavailable', message: 'Jobber is not configured.' },
    },
  };
  try {
    let webhookActive = false;
    try {
      const result = await db.prepare(
        `SELECT COUNT(*) as count FROM jobber_webhook_requests WHERE processed_at IS NOT NULL`,
      ).first() as { count: number } | null;
      webhookActive = (result?.count ?? 0) > 0;
    } catch { /* table may not exist yet */ }

    const { jobberIntegration } = await openJobberIntegration(db, c.env);
    const probe = await jobberIntegration.probeLive();
    jobber = jobberStatusPayload(probe, webhookActive);

    if (jobber.available && !isLocalDev) {
      c.executionCtx.waitUntil(
        jobberIntegration.syncProductCatalog(db, userId).catch(() => {
          // Sync failure is non-blocking — syncProductCatalog already logs errors internally
        }),
      );
    }
  } catch {
    // keep failed jobber payload above
  }

  // ── Jobber web session cookies ──
  // CRITICAL: These cookies are REQUIRED for the app to function. Without them,
  // the app cannot fetch customer request form submissions (requestDetails.form)
  // from Jobber's internal API. The client treats expired/missing cookies as a
  // BLOCKING gate — the user cannot proceed until cookies are refreshed.
  // Do NOT change this to a non-blocking/optional check.
  let jobberSession: SystemsStatusResponse['jobberSession'] = { configured: false, expired: false };
  try {
    const webSession = new JobberWebSession(db);

    // Local dev: pull valid session cookies from production when local copy is stale.
    // Same source-of-truth sync as sync-cookies.mjs on startup — not an auth bypass.
    if (isLocalDev && c.env.CLOUDFLARE_ACCOUNT_ID && c.env.CLOUDFLARE_API_TOKEN && c.env.D1_DATABASE_ID) {
      const before = await webSession.getStatus();
      if (!before.configured || before.expired) {
        await webSession.syncFromRemote({
          accountId: c.env.CLOUDFLARE_ACCOUNT_ID,
          apiToken: c.env.CLOUDFLARE_API_TOKEN,
          databaseId: c.env.D1_DATABASE_ID,
        });
      }
    }

    jobberSession = await webSession.getStatus();
  } catch {
    // D1 error — fail-open, report not configured
  }

  // ── Instagram channel status (fail-open: not_connected on error) ──
  let instagramStatus: SystemsStatusResponse['instagram'] = { status: 'not_connected' };
  try {
    const row = await db.prepare(
      "SELECT status, external_account_name FROM channel_connections WHERE user_id = ? AND channel_type = 'instagram' ORDER BY updated_at DESC LIMIT 1"
    ).bind(userId).first() as { status: string; external_account_name: string | null } | null;

    if (row) {
      const status = row.status === 'connected'
        ? 'connected' as const
        : row.status === 'expired'
          ? 'expired' as const
          : 'not_connected' as const;

      instagramStatus = {
        status,
        ...(row.external_account_name ? { accountName: row.external_account_name } : {}),
      };
    }
  } catch {
    // D1 error — fail-open, report not_connected
  }

  const response: SystemsStatusResponse = {
    jobber,
    jobberSession,
    instagram: instagramStatus,
  };

  return c.json(response);
});

export default app;
