/**
 * Jobber OAuth and shared-connection recovery routes.
 *
 * Management routes require a signed-in Chicago Reno user (see
 * jobber-connection-policy). GET /callback stays public so Jobber can send
 * the browser back, and it only accepts a one-time state row created by
 * that user.
 */
import { Hono } from 'hono';
import type { User } from 'shared';
import type { Bindings } from '../bindings.js';
import { EXTERNAL, getGithubRepo, getCookieRefreshDispatchUrl } from '../config.js';
import { sessionMiddleware } from '../middleware/session.js';
import { canManageSharedJobberConnection } from '../services/jobber-connection-policy.js';
import { JobberTokenStore } from '../services/jobber-token-store.js';
import { JobberWebSession } from '../services/jobber-web-session.js';
import { sanitizeLogText, summarizeUpstreamBody } from '../services/jobber-log-sanitize.mjs';

const app = new Hono<{ Bindings: Bindings; Variables: { user: User } }>();

const JOBBER_AUTHORIZE_URL = 'https://api.getjobber.com/api/oauth/authorize';
const JOBBER_TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';
const OAUTH_STATE_TTL_MINUTES = 15;

/**
 * Delete a stored state only when it was issued to a manager and is still
 * inside the TTL. The DELETE is the one-time consume. There is no signed
 * fallback: a signature alone is not tied to a user and can be replayed.
 */
const CONSUME_OAUTH_STATE_SQL = `DELETE FROM oauth_states
     WHERE id = ?
       AND datetime(created_at) > datetime('now', '-${OAUTH_STATE_TTL_MINUTES} minutes')
       AND EXISTS (
         SELECT 1 FROM users
         WHERE users.id = oauth_states.user_id
           AND users.id != 'system'
           AND lower(users.email) GLOB '*@chicago-reno.com'
       )
     RETURNING id`;

async function createJobberOAuthState(db: D1Database, userId: string): Promise<string> {
  const state = crypto.randomUUID();
  await db.prepare(
    "INSERT INTO oauth_states (id, user_id, created_at) VALUES (?, ?, datetime('now'))",
  ).bind(state, userId).run();
  return state;
}

async function consumeJobberOAuthState(db: D1Database, state: string): Promise<boolean> {
  const consumed = await db.prepare(CONSUME_OAUTH_STATE_SQL).bind(state).first<{ id: string }>();
  return Boolean(consumed?.id);
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

// Do not mount session middleware on the whole router. /callback is a browser
// redirect from Jobber and does not carry the app's Authorization header.
const managedPaths = ['/authorize', '/trigger-cookie-refresh', '/set-cookies', '/session-cookies/status'] as const;
for (const path of managedPaths) {
  app.use(path, sessionMiddleware);
  app.use(path, async (c, next) => {
    if (!canManageSharedJobberConnection(c.get('user'))) {
      return c.json({ error: 'You are not allowed to manage the shared Jobber connection.' }, 403);
    }
    await next();
  });
}

/**
 * GET /authorize
 * Starts the Jobber OAuth flow for the signed-in user.
 * JSON callers receive { authorizationUrl } so the app can navigate there
 * without putting the session token in the URL. Other callers are redirected.
 */
app.get('/authorize', async (c) => {
  const clientId = c.env.JOBBER_CLIENT_ID;
  const clientSecret = c.env.JOBBER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return c.json({ error: 'JOBBER_CLIENT_ID and JOBBER_CLIENT_SECRET must be configured' }, 500);
  }

  const user = c.get('user');
  let state: string;
  try {
    state = await createJobberOAuthState(c.env.DB, user.id);
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

  const accept = c.req.header('accept') || '';
  if (accept.includes('application/json')) {
    return c.json({ authorizationUrl: authUrl.toString() });
  }
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
    const desc = sanitizeLogText(c.req.query('error_description') || jobberError);
    console.error(`[jobber-auth] oauth callback failed operation=oauthCallback ${desc}`);
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
    const summary = summarizeUpstreamBody(await response.text(), [clientSecret]);
    console.error(`[jobber-auth] token exchange failed operation=oauthCallback http=${response.status} ${summary}`);
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
    const msg = sanitizeLogText(saveErr instanceof Error ? saveErr.message : 'Unknown error saving tokens', [data.access_token, data.refresh_token, clientSecret]);
    console.error(`[jobber-auth] token save failed operation=oauthCallback ${msg}`);
    return c.redirect(frontendUrl + returnPath + '?oauth_error=' + encodeURIComponent('Failed to save tokens'));
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
      console.warn(`[jobber-auth] Remote sync failed operation=syncFromRemote. Falling back to GitHub workflow. ${sanitizeLogText(result.error, [apiToken])}`);
    }
  }

  // ── Production (or remote sync failed): trigger GitHub Actions workflow ──
  const githubPat = c.env.GITHUB_PAT;
  if (!githubPat) {
    return c.json({ error: 'GITHUB_PAT not configured' }, 500);
  }

  // Repo slug + dispatch URL come from config so the target can't silently
  // drift from the actual repository (ESLint blocks re-hardcoding it here).
  const repo = getGithubRepo(c.env);

  try {
    const resp = await fetch(
      getCookieRefreshDispatchUrl(c.env),
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${githubPat}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'cotiza-worker',
        },
        body: JSON.stringify({ ref: EXTERNAL.github.workflowRef }),
      },
    );

    if (resp.status === 204) {
      return c.json({ triggered: true, message: 'Cookie refresh workflow triggered. Please wait ~60 seconds and re-check.' });
    }

    const text = await resp.text();
    const summary = summarizeUpstreamBody(text, [githubPat]);
    console.error(`[jobber-auth] GitHub workflow dispatch failed operation=triggerCookieRefresh http=${resp.status} repo=${repo} ${summary}`);
    const detail = summary;
    const hint = resp.status === 404
      ? ` — verify the repo "${repo}" and workflow "${EXTERNAL.github.cookieRefreshWorkflow}" exist and GITHUB_PAT has workflow scope`
      : '';
    return c.json(
      { triggered: false, error: `GitHub API returned ${resp.status}${hint}`, ...(detail ? { detail } : {}) },
      500,
    );
  } catch (err) {
    const msg = sanitizeLogText(err instanceof Error ? err.message : 'Unknown error', [githubPat]);
    console.error(`[jobber-auth] Failed to trigger workflow operation=triggerCookieRefresh ${msg}`);
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

  if (contentType.includes('application/json')) {
    return c.json({ saved: true });
  }

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
          <li>Paste them into the Refresh Jobber Session screen in the app and save</li>
        </ol>
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
