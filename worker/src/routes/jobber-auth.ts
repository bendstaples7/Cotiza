/**
 * Jobber OAuth Authorization Routes
 *
 * Provides a local OAuth flow to obtain fresh Jobber access/refresh tokens.
 * Hit GET /api/jobber-auth/authorize in your browser to start the flow.
 * The callback exchanges the code for tokens and persists them to D1.
 */
import { Hono } from 'hono';
import type { Bindings } from '../bindings.js';
import { JobberTokenStore } from '../services/jobber-token-store.js';
import { JobberWebSession } from '../services/jobber-web-session.js';

const app = new Hono<{ Bindings: Bindings }>();

const JOBBER_AUTHORIZE_URL = 'https://api.getjobber.com/api/oauth/authorize';
const JOBBER_TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';
const OAUTH_STATE_TTL_MINUTES = 15;

async function createJobberOAuthState(db: D1Database): Promise<string> {
  const userRow = await db.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').first<{ id: string }>();
  if (!userRow?.id) {
    throw new Error('No users found — cannot start Jobber OAuth flow');
  }

  const state = crypto.randomUUID();
  await db.prepare(
    "INSERT INTO oauth_states (id, user_id, created_at) VALUES (?, ?, datetime('now'))",
  ).bind(state, userRow.id).run();
  return state;
}

async function consumeJobberOAuthState(db: D1Database, state: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT id FROM oauth_states
     WHERE id = ?
       AND datetime(created_at) > datetime('now', '-${OAUTH_STATE_TTL_MINUTES} minutes')`,
  ).bind(state).first<{ id: string }>();

  if (!row) return false;

  await db.prepare('DELETE FROM oauth_states WHERE id = ?').bind(state).run();
  return true;
}

/** Stable OAuth callback URL — must match a redirect URI registered in the Jobber app. */
function oauthRedirectUri(c: { req: { url: string }; env: Bindings }): string {
  const frontend = c.env.FRONTEND_URL || '';
  if (frontend.includes('localhost')) {
    return 'http://localhost:8787/api/jobber-auth/callback';
  }
  return new URL('/api/jobber-auth/callback', c.req.url).toString();
}

function appReturnPath(c: { env: Bindings }): string {
  return c.env.FRONTEND_URL?.includes('localhost') ? '/quotes/requests' : '/social/dashboard';
}

/**
 * Middleware: redirect to a simple message page if Jobber is not configured.
 * This allows the dev server to start without JOBBER_CLIENT_ID in local dev.
 */
app.use('*', async (c, next) => {
  if (!c.env.JOBBER_CLIENT_ID) {
    return c.html(`
      <html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:20px;">
        <h2>⚙️ Jobber Not Configured</h2>
        <p>JOBBER_CLIENT_ID is not set. This is expected in local dev without Jobber.</p>
        <p><a href="/">Return to app</a></p>
      </body></html>
    `);
  }
  await next();
});

/**
 * GET /authorize
 * Redirects the user to Jobber's OAuth authorization page.
 */
app.get('/authorize', async (c) => {
  const clientId = c.env.JOBBER_CLIENT_ID;
  const clientSecret = c.env.JOBBER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return c.json({ error: 'JOBBER_CLIENT_ID and JOBBER_CLIENT_SECRET must be configured' }, 500);
  }

  let state: string;
  try {
    state = await createJobberOAuthState(c.env.DB);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to initialize OAuth flow';
    return c.json({ error: msg }, 500);
  }

  // Callback URL must match Jobber app redirect URIs exactly
  const redirectUri = oauthRedirectUri(c);

  const authUrl = new URL(JOBBER_AUTHORIZE_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'read:account read:clients read:quotes');
  authUrl.searchParams.set('state', state);

  return c.redirect(authUrl.toString());
});

/**
 * GET /callback
 * Handles the OAuth callback from Jobber, exchanges the authorization code
 * for access + refresh tokens, persists them to D1, and redirects back to the app.
 */
app.get('/callback', async (c) => {
  const frontendUrl = c.env.FRONTEND_URL;
  if (!frontendUrl) {
    console.error('[jobber-auth] FRONTEND_URL is not configured. OAuth callback cannot redirect.');
    return c.json({ error: 'FRONTEND_URL is not configured. Set it via wrangler secret or wrangler.toml vars.' }, 500);
  }
  const returnPath = appReturnPath(c);

  // Jobber may redirect back with an error parameter instead of a code
  const jobberError = c.req.query('error');
  if (jobberError) {
    const desc = c.req.query('error_description') || jobberError;
    return c.redirect(frontendUrl + returnPath + '?oauth_error=' + encodeURIComponent(desc));
  }

  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code) {
    return c.redirect(frontendUrl + returnPath + '?oauth_error=' + encodeURIComponent('Missing authorization code'));
  }

  const clientId = c.env.JOBBER_CLIENT_ID;
  const clientSecret = c.env.JOBBER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return c.redirect(frontendUrl + returnPath + '?oauth_error=' + encodeURIComponent('Server configuration error'));
  }

  if (!state || !(await consumeJobberOAuthState(c.env.DB, state))) {
    return c.redirect(frontendUrl + returnPath + '?oauth_error=' + encodeURIComponent('Invalid OAuth state'));
  }

  const redirectUri = oauthRedirectUri(c);

  // Exchange authorization code for tokens
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch(JOBBER_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorMsg = `Token exchange failed (${response.status})`;
    return c.redirect(frontendUrl + returnPath + '?oauth_error=' + encodeURIComponent(errorMsg));
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
  };

  if (!data.access_token || !data.refresh_token) {
    return c.redirect(frontendUrl + returnPath + '?oauth_error=' + encodeURIComponent('Token response missing required fields'));
  }

  // Persist to D1 so the worker picks them up on next request
  try {
    const tokenStore = new JobberTokenStore(c.env.DB);
    await tokenStore.save(data.access_token, data.refresh_token);
  } catch (saveErr) {
    const msg = saveErr instanceof Error ? saveErr.message : 'Unknown error saving tokens';
    return c.redirect(frontendUrl + returnPath + '?oauth_error=' + encodeURIComponent('Failed to save tokens: ' + msg));
  }

  return c.redirect(frontendUrl + returnPath);
});

/**
 * POST /trigger-cookie-refresh
 * Refreshes Jobber session cookies.
 *
 * Local dev: syncs valid cookies from remote (production) D1 to local D1 via
 * the Cloudflare API. This is instant and doesn't require a GitHub workflow.
 *
 * Production: triggers the GitHub Actions workflow to run Puppeteer on a VM,
 * log into Jobber, and write fresh cookies to remote D1.
 *
 * CRITICAL: This is the primary recovery mechanism for expired cookies.
 */
app.post('/trigger-cookie-refresh', async (c) => {
  const db = c.env.DB;
  const isLocal = c.env.ENABLE_LOCAL_SYNC === 'true';

  // ── Local dev: try syncing from remote D1 first ──
  if (isLocal) {
    const accountId = c.env.CLOUDFLARE_ACCOUNT_ID;
    // CLOUDFLARE_API_TOKEN grants D1 read access to production — only set in .dev.vars, never in production secrets.
    const apiToken = c.env.CLOUDFLARE_API_TOKEN;
    if (accountId && apiToken) {
      const webSession = new JobberWebSession(db);
      const result = await webSession.syncFromRemote({
        accountId,
        apiToken,
        databaseId: c.env.D1_DATABASE_ID,
      });
      if (result.synced) {
        return c.json({ triggered: true, message: 'Cookies synced from production. Re-checking now…' });
      }
      console.warn(`[jobber-auth] Remote sync failed: ${result.error}. Falling back to GitHub workflow.`);
    }
  }

  // ── Production (or remote sync failed): trigger GitHub Actions workflow ──
  const githubPat = c.env.GITHUB_PAT;
  if (!githubPat) {
    return c.json({ error: 'GITHUB_PAT not configured' }, 500);
  }

  try {
    const resp = await fetch(
      'https://api.github.com/repos/bendstaples7/Cotiza/actions/workflows/refresh-jobber-cookies.yml/dispatches',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${githubPat}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'cotiza-worker',
        },
        body: JSON.stringify({ ref: 'main' }),
      },
    );

    if (resp.status === 204) {
      return c.json({ triggered: true, message: 'Cookie refresh workflow triggered. Please wait ~60 seconds and re-check.' });
    }

    const text = await resp.text();
    console.error(`[jobber-auth] GitHub workflow dispatch failed (${resp.status}): ${text}`);
    return c.json({ triggered: false, error: `GitHub API returned ${resp.status}` }, 500);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[jobber-auth] Failed to trigger workflow:', msg);
    return c.json({ triggered: false, error: msg }, 500);
  }
});

/**
 * POST /set-cookies
 * Manually set Jobber web session cookies. Fallback when automated refresh fails.
 * CRITICAL: The app is completely unusable without valid session cookies.
 */
app.post('/set-cookies', async (c) => {
  const contentType = c.req.header('content-type') || '';
  let cookies: string | undefined;

  if (contentType.includes('application/json')) {
    const body = await c.req.json() as { cookies?: string };
    cookies = body.cookies;
  } else {
    const body = await c.req.parseBody();
    cookies = body.cookies as string;
  }

  if (!cookies || typeof cookies !== 'string' || cookies.trim().length === 0) {
    return c.json({ error: 'Please provide a cookies string' }, 400);
  }

  const webSession = new JobberWebSession(c.env.DB);
  await webSession.setCookies(cookies.trim());

  return c.html(`
    <html>
      <body style="font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2>✅ Session Cookies Saved</h2>
        <p>Jobber web session cookies have been stored. You can close this tab and return to the app.</p>
        <p style="color: #666; font-size: 14px;">Cookies expire after ~4 hours. They are refreshed automatically when possible.</p>
      </body>
    </html>
  `);
});

/**
 * GET /set-cookies
 * Form to paste Jobber web session cookies. Last-resort fallback.
 * CRITICAL: The app is completely unusable without valid session cookies.
 */
app.get('/set-cookies', async (c) => {
  const webSession = new JobberWebSession(c.env.DB);
  const { configured, expired } = await webSession.getStatus();

  return c.html(`
    <html>
      <body style="font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2>Set Jobber Session Cookies</h2>
        <p>These cookies are needed to fetch customer request form submissions from Jobber's internal API.</p>
        <p><strong>Status:</strong> ${configured && !expired ? '🟢 Cookies configured' : configured && expired ? '🟡 Cookies expired' : '🔴 No cookies set'}</p>
        <h3>How to get cookies:</h3>
        <ol>
          <li>Open <a href="https://app.getjobber.com" target="_blank">app.getjobber.com</a> and log in</li>
          <li>Open DevTools (F12) → Console tab</li>
          <li>Run: <code>copy(document.cookie)</code></li>
          <li>Paste below and submit</li>
        </ol>
        <form method="POST" action="/api/jobber-auth/set-cookies">
          <textarea name="cookies" rows="6" style="width: 100%; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-family: monospace; font-size: 0.85rem; box-sizing: border-box;" placeholder="Paste cookies here..."></textarea>
          <button type="submit" style="margin-top: 0.5rem; padding: 0.5rem 1rem; background: #00a89d; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9rem;">Save Cookies</button>
        </form>
      </body>
    </html>
  `);
});

/**
 * GET /session-cookies/status
 * Check if Jobber web session cookies are configured and valid.
 */
app.get('/session-cookies/status', async (c) => {
  const webSession = new JobberWebSession(c.env.DB);
  const { configured, expired } = await webSession.getStatus();
  return c.json({ configured, expired });
});

export default app;
