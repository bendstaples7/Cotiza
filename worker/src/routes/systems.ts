import { Hono } from 'hono';
import type { Bindings } from '../bindings.js';
import type { User, SystemsStatusResponse } from 'shared';
import { sessionMiddleware } from '../middleware/session.js';
import { JobberTokenStore } from '../services/jobber-token-store.js';
import { JobberIntegration, ActivityLogService } from '../services/index.js';
import { JobberWebSession } from '../services/jobber-web-session.js';

const app = new Hono<{ Bindings: Bindings; Variables: { user: User } }>();

app.use('*', sessionMiddleware);

const JOBBER_PING_TIMEOUT_MS = 3_000;

async function pingJobber(jobber: JobberIntegration): Promise<boolean> {
  try {
    await Promise.race([
      jobber.graphqlRequest('{ account { name } }', {}),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Jobber health check timed out')), JOBBER_PING_TIMEOUT_MS);
      }),
    ]);
    return jobber.isAvailable();
  } catch {
    return false;
  }
}

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

  // ── Jobber OAuth token validity (fail-closed — same in local dev and production) ──
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
      jobberAvailable = await pingJobber(jobber);

      if (jobberAvailable && !isLocalDev) {
        c.executionCtx.waitUntil(
          jobber.syncProductCatalog(db, userId).catch(() => {
            // Sync failure is non-blocking — syncProductCatalog already logs errors internally
          }),
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
    jobber: { available: jobberAvailable },
    jobberSession,
    instagram: instagramStatus,
  };

  return c.json(response);
});

export default app;
