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

export interface RequestFormData {
  sections: Array<{
    label: string;
    sortOrder: number;
    answers: Array<{ label: string; value: string | null }>;
  }>;
  text: string;
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
            nodes {
              label
              sortOrder
              items(first: 20) {
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
      console.error('[JobberWebSession] Failed to fetch form data:', err instanceof Error ? err.message : err);
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
        const msg = data.errors.map((e: any) => e.message).join(', ');
        console.error('[JobberWebSession] GraphQL errors:', msg);
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
      .filter((s: any) => s.sortOrder > 0 && s.sortOrder < 999)
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
        return { synced: false, error: `Cloudflare D1 API error (${resp.status})${hint}: ${text.slice(0, 200)}` };
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
        return { synced: false, error: `D1 API error: ${msgs || 'unknown error'}` };
      }

      // Validate query-level success
      if (!data.result?.[0]?.success) {
        const msgs = (data.result?.[0]?.errors ?? []).map((e) => e.message).join(', ');
        return { synced: false, error: `D1 query error: ${msgs || 'unknown error'}` };
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
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return { synced: false, error: msg };
    } finally {
      clearTimeout(timeout);
    }
  }
}
