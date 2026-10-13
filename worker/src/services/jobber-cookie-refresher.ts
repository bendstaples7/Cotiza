/**
 * Jobber Cookie Refresher
 *
 * Uses Cloudflare Browser Rendering CDP (Chrome DevTools Protocol) sessions
 * to automatically log into Jobber and extract session cookies — including
 * HttpOnly cookies that aren't accessible via document.cookie.
 *
 * Flow: create browser session → open tab → navigate to login → fill form
 * via CDP → submit → extract cookies via Network.getAllCookies → validate → store.
 *
 * Requires: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets.
 */
import { JobberWebSession } from './jobber-web-session.js';
import { sanitizeLogText, summarizeUpstreamBody } from './jobber-log-sanitize.mjs';

const COOKIE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const REFRESH_BACKOFF_MS = 60 * 1000; // 60s negative cache after failed refresh
const REQUEST_TIMEOUT_MS = 30 * 1000; // 30s per HTTP request
const INTERNAL_GQL_URL = 'https://api.getjobber.com/api/graphql?location=j';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

interface CDPResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface CDPCookie {
  name: string;
  value: string;
  domain: string;
}

export class JobberCookieRefresher {
  private db: D1Database;
  private email: string;
  private password: string;
  private accountId: string;
  private apiToken: string;

  constructor(
    db: D1Database,
    opts: {
      email: string;
      password: string;
      accountId: string;
      apiToken: string;
    },
  ) {
    this.db = db;
    this.email = opts.email;
    this.password = opts.password;
    this.accountId = opts.accountId;
    this.apiToken = opts.apiToken;
  }

  /**
   * Check if a recent refresh attempt failed (negative cache).
   * Prevents hammering Browser Rendering on every /status call.
   */
  async shouldSkipRefresh(): Promise<boolean> {
    try {
      const row = await this.db.prepare(
        "SELECT updated_at FROM jobber_web_session WHERE id = 'refresh_failed'"
      ).first() as { updated_at: string } | null;
      if (!row) return false;
      const failedAt = new Date(row.updated_at).getTime();
      return Date.now() - failedAt < REFRESH_BACKOFF_MS;
    } catch {
      return false;
    }
  }

  private async markRefreshFailed(): Promise<void> {
    try {
      await this.db.prepare(
        `INSERT INTO jobber_web_session (id, cookies, expires_at, updated_at)
         VALUES ('refresh_failed', '', datetime('now'), datetime('now'))
         ON CONFLICT (id) DO UPDATE SET updated_at = datetime('now')`
      ).run();
    } catch { /* best effort */ }
  }

  private async clearRefreshFailed(): Promise<void> {
    try {
      await this.db.prepare("DELETE FROM jobber_web_session WHERE id = 'refresh_failed'").run();
    } catch { /* best effort */ }
  }

  /**
   * Refresh Jobber session cookies using Cloudflare Browser Rendering CDP sessions.
   * Uses WebSocket-based Chrome DevTools Protocol for full browser control,
   * including access to HttpOnly cookies via Network.getAllCookies.
   */
  async refresh(): Promise<{ success: boolean; error?: string }> {
    if (!this.email || !this.password) {
      return { success: false, error: 'JOBBER_WEB_EMAIL or JOBBER_WEB_PASSWORD not configured' };
    }
    if (!this.accountId || !this.apiToken) {
      return { success: false, error: 'CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN not configured' };
    }

    // Check negative cache — skip if a recent refresh failed
    if (await this.shouldSkipRefresh()) {
      return { success: false, error: 'Skipping refresh — recent attempt failed (backoff)' };
    }

    const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/browser-rendering`;
    let sessionId: string | null = null;

    try {
      // Step 1: Create a browser session (keep alive for 60s)
      const sessionResp = await this.fetchWithTimeout(
        `${baseUrl}/devtools/browser?keep_alive=60000`,
        { method: 'POST', headers: this.authHeaders() },
      );
      if (!sessionResp.ok) {
        const text = await sessionResp.text();
        const summary = summarizeUpstreamBody(text, [this.apiToken, this.email, this.password]);
        await this.markRefreshFailed();
        console.error(`[JobberCookieRefresher] refresh failed operation=createBrowserSession http=${sessionResp.status} refreshSucceeded=false ${summary}`);
        return { success: false, error: `Failed to create browser session (${sessionResp.status}): ${summary}` };
      }
      const sessionData = await sessionResp.json() as { sessionId: string; webSocketDebuggerUrl: string };
      sessionId = sessionData.sessionId;
      const wsUrl = sessionData.webSocketDebuggerUrl;

      // Step 2: Open a tab to the Jobber login page
      const tabResp = await this.fetchWithTimeout(
        `${baseUrl}/devtools/browser/${sessionId}/json/new?url=${encodeURIComponent('https://secure.getjobber.com/login')}`,
        { method: 'PUT', headers: this.authHeaders() },
      );
      if (!tabResp.ok) {
        await this.markRefreshFailed();
        return { success: false, error: `Failed to open tab (${tabResp.status})` };
      }
      const tabData = await tabResp.json() as { id: string; webSocketDebuggerUrl: string };
      const pageWsUrl = tabData.webSocketDebuggerUrl;

      // Step 3: Connect to the page via WebSocket and drive the login
      const cookieString = await this.driveLoginViaCDP(pageWsUrl);

      if (!cookieString) {
        await this.markRefreshFailed();
        return { success: false, error: 'Failed to extract cookies from login session' };
      }

      // Step 4: Validate cookies
      const valid = await this.validateCookies(cookieString);
      if (!valid) {
        await this.markRefreshFailed();
        return { success: false, error: 'Cookie validation failed — cookies may not be authenticated' };
      }

      // Step 5: Store in D1
      const webSession = new JobberWebSession(this.db);
      await webSession.setCookies(cookieString, COOKIE_TTL_MS);
      await this.clearRefreshFailed();

      console.log('[JobberCookieRefresher] Cookies refreshed successfully via CDP');
      return { success: true };
    } catch (err) {
      const message = sanitizeLogText(err instanceof Error ? err.message : 'Unknown error', [this.email, this.password, this.apiToken]);
      console.error(`[JobberCookieRefresher] refresh failed operation=refreshCookies refreshSucceeded=false ${message}`);
      await this.markRefreshFailed();
      return { success: false, error: message };
    } finally {
      // Clean up: close the browser session
      if (sessionId) {
        try {
          await fetch(`${baseUrl}/devtools/browser/${sessionId}`, {
            method: 'DELETE',
            headers: this.authHeaders(),
          });
        } catch { /* best effort cleanup */ }
      }
    }
  }

  /**
   * Drive the Jobber login flow via CDP WebSocket commands.
   * Returns the cookie string on success, null on failure.
   */
  private async driveLoginViaCDP(wsUrl: string): Promise<string | null> {
    // Use the WebSocket API available in Cloudflare Workers
    const ws = new WebSocket(wsUrl);
    let cmdId = 1;

    const sendCommand = (method: string, params?: Record<string, unknown>): Promise<CDPResponse> => {
      return new Promise((resolve, reject) => {
        const id = cmdId++;
        const timeout = setTimeout(() => reject(new Error(`CDP command ${method} timed out`)), 15000);

        const handler = (event: MessageEvent) => {
          const data = JSON.parse(event.data as string) as CDPResponse;
          if (data.id === id) {
            clearTimeout(timeout);
            ws.removeEventListener('message', handler);
            if (data.error) {
              reject(new Error(`CDP ${method} error (${data.error.code}): ${data.error.message}`));
            } else {
              resolve(data);
            }
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    try {
      // Wait for WebSocket to open
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebSocket connection timed out')), 10000);
        ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); });
        ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('WebSocket connection failed')); });
      });

      // Enable Network domain (needed for getAllCookies)
      await sendCommand('Network.enable');

      // Wait for the page to load (login form)
      await new Promise(r => setTimeout(r, 5000));

      // Helper to extract the string value from a Runtime.evaluate result
      const evalValue = (resp: CDPResponse): string =>
        (resp.result as any)?.result?.value as string ?? '';

      // Fill the username field
      const usernameResult = await sendCommand('Runtime.evaluate', {
        expression: `
          const field = document.querySelector('#username')
            || document.querySelector('input[name="username"]')
            || document.querySelector('input[type="text"]')
            || document.querySelector('input[type="email"]');
          if (field) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(field, ${JSON.stringify(this.email)});
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
            'ok';
          } else { 'no_field'; }
        `,
      });
      if (evalValue(usernameResult) === 'no_field') {
        console.error('[JobberCookieRefresher] Username field not found on login page');
        return null;
      }

      // Fill the password field
      const passwordResult = await sendCommand('Runtime.evaluate', {
        expression: `
          const field = document.querySelector('#password')
            || document.querySelector('input[name="password"]')
            || document.querySelector('input[type="password"]');
          if (field) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(field, ${JSON.stringify(this.password)});
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
            'ok';
          } else { 'no_field'; }
        `,
      });
      if (evalValue(passwordResult) === 'no_field') {
        console.error('[JobberCookieRefresher] Password field not found on login page');
        return null;
      }

      // Click submit
      const submitResult = await sendCommand('Runtime.evaluate', {
        expression: `
          const btn = document.querySelector('button[type="submit"]')
            || document.querySelector('button[name="action"]');
          if (btn) { btn.click(); 'ok'; } else { 'no_button'; }
        `,
      });
      if (evalValue(submitResult) === 'no_button') {
        console.error('[JobberCookieRefresher] Submit button not found on login page');
        return null;
      }

      // Wait for navigation after login
      await new Promise(r => setTimeout(r, 8000));

      // Check if we're still on the login page
      const urlResult = await sendCommand('Runtime.evaluate', {
        expression: 'window.location.href',
      });
      const currentUrl = (urlResult.result as any)?.result?.value as string || '';
      if (currentUrl.includes('login')) {
        console.error('[JobberCookieRefresher] Still on login page after submit — credentials may be invalid');
        return null;
      }

      // Extract ALL cookies (including HttpOnly) via CDP
      const cookieResult = await sendCommand('Network.getAllCookies');
      const allCookies = ((cookieResult.result as any)?.cookies ?? []) as CDPCookie[];

      const jobberCookies = allCookies.filter(c =>
        c.domain.includes('getjobber.com') || c.domain.includes('jobber.com')
      );

      if (jobberCookies.length === 0) {
        console.error('[JobberCookieRefresher] No Jobber cookies found after login');
        return null;
      }

      const cookieString = jobberCookies.map(c => `${c.name}=${c.value}`).join('; ');
      console.log(`[JobberCookieRefresher] Extracted ${jobberCookies.length} Jobber cookies via CDP`);
      return cookieString;
    } finally {
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  private authHeaders(): Record<string, string> {
    return { 'Authorization': `Bearer ${this.apiToken}` };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async validateCookies(cookieString: string): Promise<boolean> {
    try {
      const resp = await this.fetchWithTimeout(INTERNAL_GQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookieString,
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify({ query: '{ account { id } }' }),
      });

      if (!resp.ok) return false;

      const data = await resp.json() as { data?: { account?: { id?: string } }; errors?: unknown[] };
      if (data?.errors && (data.errors as unknown[]).length > 0) return false;
      if (!data?.data?.account?.id) return false;

      return true;
    } catch {
      return false;
    }
  }
}
