/**
 * Jobber Web Session Service (Worker variant)
 *
 * Uses stored session cookies to access Jobber's internal GraphQL fields
 * (like `requestDetails.form`) that aren't available through the public API.
 *
 * Cookie extraction is handled by the sync-cookies.mjs startup script
 * (which uses Puppeteer to log into Jobber and store cookies in D1).
 * This service only reads cookies from D1 and uses them for API calls.
 */
import { sanitizeLogText, summarizeUpstreamBody } from './jobber-log-sanitize.mjs';

export interface RequestFormData {
  sections: Array<{
    label: string;
    sortOrder: number;
    answers: Array<{ label: string; value: string | null }>;
  }>;
  text: string;
  truncated?: boolean;
}

const INTERNAL_GQL_URL = 'https://api.getjobber.com/api/graphql?location=j';

const REQUEST_DETAILS_QUERY = `
  query FetchRequestDetail($id: EncodedId!) {
    request(id: $id) {
      id
      title
      requestDetails {
        form {
          sections(first: 10) {
            pageInfo { hasNextPage }
            nodes {
              label
              sortOrder
              items(first: 20) {
                pageInfo { hasNextPage }
                nodes {
                  ... on FormTextInput { label reportableAnswer { value } }
                  ... on FormMultipleChoice { label reportableAnswer { value } }
                  ... on FormDateInput { label reportableAnswer { value } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const ACCOUNT_PROBE_QUERY = '{ account { id } }';

/**
 * How long a successful keep-alive check keeps the session marked valid.
 * The cron runs every 30 minutes, so this survives a couple of missed runs.
 */
export const KEEPALIVE_TTL_MS = 2 * 60 * 60 * 1000;

export type KeepAliveResult = 'extended' | 'expired' | 'missing' | 'error';

/** Read Set-Cookie headers individually (a joined header breaks on Expires dates). */
function readSetCookies(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  return typeof getSetCookie === 'function' ? getSetCookie.call(headers) : [];
}

/**
 * Apply Set-Cookie updates to a "name=value; name2=value2" cookie string so a
 * session Jobber rotates on use stays current. Cookies Jobber deletes are dropped.
 */
export function mergeSetCookies(cookieString: string, setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const part of cookieString.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  for (const header of setCookies) {
    const [pair, ...attributes] = header.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const deleted = value === '' || attributes.some((a) => {
      const [key, raw] = a.split('=');
      const attr = key.trim().toLowerCase();
      if (attr === 'max-age') return Number(raw) <= 0;
      if (attr === 'expires') return new Date(a.slice(a.indexOf('=') + 1).trim()).getTime() <= Date.now();
      return false;
    });
    if (deleted) jar.delete(name);
    else jar.set(name, value);
  }
  return Array.from(jar, ([name, value]) => `${name}=${value}`).join('; ');
}

export class JobberWebSession {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Check if we have valid session cookies.
   */
  async isConfigured(): Promise<boolean> {
    const cookies = await this.loadCookies();
    return cookies !== null;
  }

  /**
   * Get the current status of stored session cookies.
   * Returns configured/expired flags based on the cookie row in D1.
   */
  async getStatus(): Promise<{ configured: boolean; expired: boolean }> {
    try {
      const row = await this.db.prepare(
        "SELECT expires_at FROM jobber_web_session WHERE id = 'default'"
      ).first() as { expires_at: string } | null;

      if (!row) return { configured: false, expired: false };

      const expiresAt = new Date(row.expires_at).getTime();
      const expired = Date.now() > expiresAt;
      return { configured: true, expired };
    } catch {
      return { configured: false, expired: false };
    }
  }

  /**
   * Store session cookies in D1 (called by sync-cookies.mjs or set-cookies endpoint).
   */
  async setCookies(cookies: string, ttlMs: number = 4 * 60 * 60 * 1000): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await this.db.prepare(
      `INSERT INTO jobber_web_session (id, cookies, expires_at, updated_at)
       VALUES ('default', ?, ?, datetime('now'))
       ON CONFLICT (id) DO UPDATE SET
         cookies = excluded.cookies,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`
    ).bind(cookies, expiresAt).run();
  }

  /**
   * Ask Jobber whether the stored cookies still work, and extend the local
   * expiry when they do. Our 4-hour expiry is a local guess, not Jobber's;
   * this runs on a Cloudflare cron so a still-valid session is not thrown
   * away and a dead one is cleared instead of trusted until its timestamp.
   * Uses plain API calls only (no browser), so Jobber's login captcha is not involved.
   */
  async keepAlive(): Promise<KeepAliveResult> {
    let row: { cookies: string; expires_at: string } | null;
    try {
      row = await this.db.prepare(
        "SELECT cookies, expires_at FROM jobber_web_session WHERE id = 'default'"
      ).first() as { cookies: string; expires_at: string } | null;
    } catch {
      return 'error';
    }
    if (!row?.cookies) return 'missing';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(INTERNAL_GQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': row.cookies },
        body: JSON.stringify({ query: ACCOUNT_PROBE_QUERY }),
        signal: controller.signal,
      });

      if (resp.status === 401 || resp.status === 403) {
        await this.clearCookies();
        return 'expired';
      }
      if (!resp.ok) return 'error';

      const data = await resp.json() as any;
      const errorText = (data?.errors ?? []).map((e: any) => String(e?.message ?? '')).join(', ');
      if (errorText.includes('unauthenticated') || errorText.includes('hidden') || (!errorText && !data?.data?.account?.id)) {
        await this.clearCookies();
        return 'expired';
      }
      if (errorText) return 'error';

      const cookies = mergeSetCookies(row.cookies, readSetCookies(resp.headers));
      const currentExpiry = new Date(row.expires_at).getTime();
      const extendedExpiry = Date.now() + KEEPALIVE_TTL_MS;
      const expiresAt = new Date(Number.isFinite(currentExpiry) ? Math.max(currentExpiry, extendedExpiry) : extendedExpiry).toISOString();
      await this.db.prepare(
        "UPDATE jobber_web_session SET cookies = ?, expires_at = ?, updated_at = datetime('now') WHERE id = 'default'"
      ).bind(cookies, expiresAt).run();
      return 'extended';
    } catch (err) {
      console.error(`[JobberWebSession] keepAlive failed operation=keepAlive ${sanitizeLogText(err instanceof Error ? err.message : err, [row.cookies])}`);
      return 'error';
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Load valid (non-expired) cookies from D1.
   */
  async loadCookies(): Promise<string | null> {
    try {
      const row = await this.db.prepare(
        "SELECT cookies, expires_at FROM jobber_web_session WHERE id = 'default'"
      ).first() as { cookies: string; expires_at: string } | null;

      if (!row) return null;

      const expiresAt = new Date(row.expires_at).getTime();
      if (Date.now() > expiresAt) return null;

      return row.cookies;
    } catch {
      return null;
    }
  }

  /**
   * Fetch form submission data for a Jobber request using the internal API.
   * Returns both the form data and whether the session has expired.
   */
  async fetchRequestFormData(requestId: string): Promise<{ formData: RequestFormData | null; sessionExpired: boolean }> {
    const cookies = await this.loadCookies();
    if (!cookies) return { formData: null, sessionExpired: true };

    try {
      const result = await this.queryInternalApi(requestId, cookies);

      if (result.authFailed) {
        // Cookies expired — clear them so sync-cookies.mjs refreshes on next dev start
        await this.clearCookies();
        return { formData: null, sessionExpired: true };
      }

      return { formData: result.data, sessionExpired: false };
    } catch (err) {
      console.error(`[JobberWebSession] fetchRequestFormData failed operation=fetchRequestFormData ${sanitizeLogText(err instanceof Error ? err.message : err, cookies ? [cookies] : [])}`);
      return { formData: null, sessionExpired: false };
    }
  }

  private async queryInternalApi(requestId: string, cookies: string): Promise<{ data: RequestFormData | null; authFailed: boolean }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const resp = await fetch(INTERNAL_GQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookies,
        },
        body: JSON.stringify({
          query: REQUEST_DETAILS_QUERY,
          variables: { id: requestId },
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) {
          return { data: null, authFailed: true };
        }
        return { data: null, authFailed: false };
      }

      const data = await resp.json() as any;

      if (data?.errors?.length > 0) {
        const msg = sanitizeLogText(data.errors.map((e: any) => e.message).join(', '), [cookies]);
        console.error(`[JobberWebSession] queryInternalApi failed operation=queryInternalApi http=${resp.status} ${summarizeUpstreamBody(JSON.stringify({ errors: data.errors }), [cookies])}`);
        if (msg.includes('unauthenticated') || msg.includes('hidden')) {
          return { data: null, authFailed: true };
        }
        return { data: null, authFailed: false };
      }

      return { data: this.parseFormResponse(data), authFailed: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseFormResponse(data: any): RequestFormData | null {
    const sections = data?.data?.request?.requestDetails?.form?.sections?.nodes;
    if (!sections || !Array.isArray(sections)) return null;

    const formSections = sections
      .filter((s: any) => s != null)
      .sort((a: any, b: any) => a.sortOrder - b.sortOrder)
      .map((s: any) => ({
        label: s.label,
        sortOrder: s.sortOrder,
        answers: (s.items?.nodes ?? [])
          .filter((item: any) => item?.reportableAnswer?.value != null)
          .map((item: any) => ({
            label: item.label,
            value: item.reportableAnswer.value,
          })),
      }))
      .filter((s: any) => s.answers.length > 0);

    if (formSections.length === 0) return null;

    const textParts: string[] = [];
    for (const section of formSections) {
      for (const answer of section.answers) {
        if (answer.value) {
          textParts.push(`${answer.label}: ${answer.value}`);
        }
      }
    }

    return {
      sections: formSections,
      text: textParts.join('\n'),
      truncated: data?.data?.request?.requestDetails?.form?.sections?.pageInfo?.hasNextPage !== false
        || sections.some((s: any) => s?.items?.pageInfo?.hasNextPage !== false),
    };
  }

  private async clearCookies(): Promise<void> {
    try {
      await this.db.prepare("DELETE FROM jobber_web_session WHERE id = 'default'").run();
    } catch { /* ignore */ }
  }

  /**
   * Sync cookies from remote (production) D1 to local D1 via the Cloudflare D1 HTTP API.
   * Used during local development when the "Refresh Cookies" button is pressed.
   * Returns true if valid cookies were found remotely and written locally.
   */
  async syncFromRemote(opts: {
    accountId: string;
    apiToken: string;
    databaseId: string;
  }): Promise<{ synced: boolean; error?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/d1/database/${opts.databaseId}/query`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${opts.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sql: "SELECT cookies, expires_at FROM jobber_web_session WHERE id = 'default'",
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text();
        const hint = (resp.status === 401 || resp.status === 403)
          ? ' (CLOUDFLARE_API_TOKEN may be expired or lack D1 read permission)'
          : '';
        return { synced: false, error: sanitizeLogText(`Cloudflare D1 API error (${resp.status})${hint}: ${summarizeUpstreamBody(text, [opts.apiToken])}`, [opts.apiToken]) };
      }

      const data = await resp.json() as {
        success: boolean;
        errors?: Array<{ message: string }>;
        result: Array<{
          success: boolean;
          errors?: Array<{ message: string }>;
          results: Array<{ cookies: string; expires_at: string }>;
        }>;
      };

      // Validate top-level D1 API success
      if (!data.success) {
        const msgs = (data.errors ?? []).map((e) => e.message).join(', ');
        return { synced: false, error: sanitizeLogText(`D1 API error: ${msgs || 'unknown error'}`, [opts.apiToken]) };
      }

      // Validate query-level success
      if (!data.result?.[0]?.success) {
        const msgs = (data.result?.[0]?.errors ?? []).map((e) => e.message).join(', ');
        return { synced: false, error: sanitizeLogText(`D1 query error: ${msgs || 'unknown error'}`, [opts.apiToken]) };
      }

      const rows = data.result[0].results ?? [];
      if (rows.length === 0) {
        return { synced: false, error: 'No cookies found in remote D1' };
      }

      const row = rows[0];
      const expiresAt = new Date(row.expires_at).getTime();
      if (Number.isNaN(expiresAt) || !Number.isFinite(expiresAt)) {
        return { synced: false, error: `Invalid expires_at value: "${row.expires_at}"` };
      }
      if (Date.now() > expiresAt) {
        return { synced: false, error: 'Remote cookies are also expired' };
      }

      // Write the remote cookies to local D1
      await this.db.prepare(
        `INSERT INTO jobber_web_session (id, cookies, expires_at, updated_at)
         VALUES ('default', ?, ?, datetime('now'))
         ON CONFLICT (id) DO UPDATE SET
           cookies = excluded.cookies,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`
      ).bind(row.cookies, row.expires_at).run();

      console.log('[JobberWebSession] Synced cookies from remote D1 to local');
      return { synced: true };
    } catch (err) {
      const msg = sanitizeLogText(err instanceof Error ? err.message : 'Unknown error', [opts.apiToken]);
      return { synced: false, error: msg };
    } finally {
      clearTimeout(timeout);
    }
  }
}
