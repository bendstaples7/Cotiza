import { Hono } from 'hono';
import type { Bindings } from '../bindings.js';
import type { User, SystemsStatusResponse } from 'shared';
import { sessionMiddleware } from '../middleware/session.js';
import { JobberTokenStore } from '../services/jobber-token-store.js';
import { JobberIntegration, ActivityLogService } from '../services/index.js';
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

  // ── LOCAL-DEV: Skip all Jobber checks if ENABLE_LOCAL_SYNC is set ──
  if (c.env.ENABLE_LOCAL_SYNC === 'true') {
    const response: SystemsStatusResponse = {
      jobber: { available: true },
      jobberSession: { configured: true, expired: false },
      instagram: { status: 'not_connected' },
    };
    return c.json(response);
  }

  // ── Jobber OAuth token validity (fail-closed: unavailable on error) ──
  let jobberAvailable = false;
  try {
    const tokenStore = new JobberTokenStore(db);
    const tokens = await tokenStore.load();
    if (tokens) {
      const activityLog = new ActivityLogService(db);
      const jobber = new JobberIntegration(activityLog, {
        clientId: c.env.JOBBER_CLIENT_ID || '',
        clientSecret: c.env.JOBBER_CLIENT_SECRET || '',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenStore,
      });
      await jobber.graphqlRequest('{ account { name } }', {});
      jobberAvailable = jobber.isAvailable();

      if (jobberAvailable) {
        // Background sync: register with waitUntil so the CF Workers runtime
        // keeps the isolate alive until the sync completes (or fails).
        c.executionCtx.waitUntil(
          jobber.syncProductCatalog(db, userId).catch(() => {
            // Sync failure is non-blocking — syncProductCatalog already logs errors internally
          })
        );
      }
    }
  } catch {
    jobberAvailable = false;
  }

  // ── Jobber web session cookies ──
  // CRITICAL: These cookies are REQUIRED for the app to function. Without them,
  // the app cannot fetch customer request form submissions (requestDetails.form)
  // from Jobber's internal API. The client treats expired/missing cookies as a
  // BLOCKING gate — the user cannot proceed until cookies are refreshed.
  // Do NOT change this to a non-blocking/optional check.
  // Cookie refresh is handled by the GitHub Actions workflow (triggered on-demand
  // from the client or on a cron schedule). The worker only checks status here.
  let jobberSession: SystemsStatusResponse['jobberSession'] = { configured: false, expired: false };
  try {
    const webSession = new JobberWebSession(db);
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
    jobber: { available: jobberAvailable },
    jobberSession,
    instagram: instagramStatus,
  };

  return c.json(response);
});

export default app;
