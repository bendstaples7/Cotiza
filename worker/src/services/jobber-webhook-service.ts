import { ActivityLogService } from './activity-log-service.js';
import type { JobberTokenStore } from './jobber-token-store.js';
import type { JobberCustomerRequest } from 'shared';
import { isPlaceholderJobberClientName } from 'shared';

const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';

/** Thrown when the Jobber API returns 401, signalling the access token has expired. */
class TokenExpiredError extends Error {
  constructor() { super('Jobber access token expired'); }
}

export interface JobberWebhookPayload {
  data: {
    webHookEvent: {
      topic: string;
      appId: string;
      accountId: string;
      itemId: string;
      occurredAt: string;
    };
  };
}

interface RequestDetail {
  id: string;
  title: string | null;
  companyName: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  requestStatus: string;
  createdAt: string;
  jobberWebUri: string;
  client?: { id: string; firstName: string | null; lastName: string | null; companyName: string | null } | null;
  notes: {
    edges: Array<{
      node: {
        message?: string;
        createdAt?: string;
        createdBy?: { __typename: string };
      };
    }>;
  };
  noteAttachments: {
    edges: Array<{
      node: { url: string; fileName: string; contentType: string };
    }>;
  };
}

const REQUEST_DETAIL_QUERY = `
  query FetchRequestDetail($id: EncodedId!) {
    request(id: $id) {
      id
      title
      companyName
      contactName
      phone
      email
      requestStatus
      createdAt
      jobberWebUri
      client { id firstName lastName companyName }
      notes(first: 20) {
        edges {
          node {
            ... on RequestNote {
              message
              createdAt
              createdBy {
                __typename
              }
            }
          }
        }
      }
      noteAttachments(first: 20) {
        edges {
          node {
            url
            fileName
            contentType
          }
        }
      }
    }
  }
`;

export class JobberWebhookService {
  private db: D1Database;
  private activityLog: ActivityLogService;
  private accessToken: string;
  private clientSecret: string;
  private clientId: string;
  private refreshToken: string;
  private tokenStore: JobberTokenStore | null;

  constructor(db: D1Database, activityLog: ActivityLogService, opts: {
    accessToken: string;
    clientSecret: string;
    clientId?: string;
    refreshToken?: string;
    tokenStore?: JobberTokenStore;
  }) {
    this.db = db;
    this.activityLog = activityLog;
    this.accessToken = opts.accessToken;
    this.clientSecret = opts.clientSecret;
    this.clientId = opts.clientId || '';
    this.refreshToken = opts.refreshToken || '';
    this.tokenStore = opts.tokenStore ?? null;
  }

  /**
   * Load the latest tokens from D1 if a token store is configured.
   */
  async loadPersistedTokens(): Promise<void> {
    if (!this.tokenStore) return;
    try {
      const stored = await this.tokenStore.load();
      if (stored) {
        this.accessToken = stored.accessToken;
        this.refreshToken = stored.refreshToken;
      }
    } catch (err) {
      console.warn('[WebhookService] Failed to load persisted tokens, falling back to env:', err);
    }
  }

  /**
   * Verify the HMAC signature on an incoming Jobber webhook.
   * Uses the Web Crypto API (available in Workers).
   */
  async verifySignature(rawBody: string, signature: string): Promise<boolean> {
    if (!this.clientSecret) return false;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.clientSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
    const calculated = btoa(String.fromCharCode(...new Uint8Array(sig)));

    // Constant-time comparison
    if (calculated.length !== signature.length) return false;
    let mismatch = 0;
    for (let i = 0; i < calculated.length; i++) {
      mismatch |= calculated.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return mismatch === 0;
  }

  async processWebhook(payload: JobberWebhookPayload): Promise<void> {
    const { topic, itemId, accountId } = payload.data.webHookEvent;
    if (!topic.startsWith('REQUEST_')) return;

    try {
      const detail = await this.fetchRequestDetail(itemId);

      if (!detail) {
        await this.storeWebhookData(itemId, topic, accountId, null, payload);
        return;
      }

      const { imageUrls, description, clientName } = this.parseRequestDetail(detail);

      await this.storeWebhookData(itemId, topic, accountId, {
        title: detail.title,
        clientName,
        description,
        imageUrls,
        detail,
      }, payload);
    } catch (err) {
      console.error('Webhook processing error:', err);
    }
  }

  /**
   * Extract image URLs, description, and client name from a RequestDetail.
   * Shared by processWebhook, backfill-on-read, and backfillFromApi.
   */
  private parseRequestDetail(detail: RequestDetail): { imageUrls: string[]; description: string; clientName: string | null } {
    const imageUrls = (detail.noteAttachments?.edges ?? [])
      .filter((e) => e.node.contentType.startsWith('image/'))
      .map((e) => e.node.url);

    const description = detail.notes.edges
      .map((e) => e.node?.message)
      .filter((m): m is string => !!m)
      .join('\n\n');

    const clientDetail = detail.client;
    const fromClient = clientDetail
      ? `${clientDetail.firstName || ''} ${clientDetail.lastName || ''}`.trim() || clientDetail.companyName
      : null;
    let clientName: string | null = null;
    for (const candidate of [detail.contactName, fromClient, detail.companyName]) {
      const trimmed = candidate?.trim();
      if (trimmed && !isPlaceholderJobberClientName(trimmed)) {
        clientName = trimmed;
        break;
      }
    }

    return { imageUrls, description, clientName };
  }

  private async fetchRequestDetail(requestId: string): Promise<RequestDetail | null> {
    if (!this.accessToken) return null;

    try {
      const result = await this.attemptFetchDetail(requestId);
      return result;
    } catch (err) {
      // Token expired — try refreshing and retry once
      if (err instanceof TokenExpiredError && this.refreshToken) {
        const refreshed = await this.refreshAccessToken();
        if (refreshed) {
          try {
            return await this.attemptFetchDetail(requestId);
          } catch {
            return null;
          }
        }
      }
      return null;
    }
  }

  private async attemptFetchDetail(requestId: string): Promise<RequestDetail | null> {
    const res = await fetch(JOBBER_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
        'X-JOBBER-GRAPHQL-VERSION': '2025-04-16',
      },
      body: JSON.stringify({
        query: REQUEST_DETAIL_QUERY,
        variables: { id: requestId },
      }),
    });

    if (res.status === 401) throw new TokenExpiredError();
    if (!res.ok) return null;
    const json = await res.json() as { data?: { request?: RequestDetail } };
    return json.data?.request ?? null;
  }

  /**
   * Refresh the Jobber access token using the OAuth refresh token.
   * Updates the in-memory token for subsequent calls within this request.
   */
  private async refreshAccessToken(): Promise<boolean> {
    if (!this.clientId || !this.clientSecret || !this.refreshToken) return false;

    try {
      const body = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
      });

      const response = await fetch('https://api.getjobber.com/api/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!response.ok) {
        console.error(`[WebhookService] Token refresh failed (${response.status})`);
        return false;
      }

      const data = (await response.json()) as { access_token: string; refresh_token?: string };

      if (!data.access_token) {
        console.error('[WebhookService] Token refresh response missing access_token');
        return false;
      }

      this.accessToken = data.access_token;
      if (data.refresh_token) {
        this.refreshToken = data.refresh_token;
      }

      // Persist refreshed tokens to D1 so they survive cold starts
      if (this.tokenStore) {
        try {
          await this.tokenStore.save(this.accessToken, this.refreshToken);
        } catch (err) {
          console.error('[WebhookService] Token refresh succeeded but failed to persist to D1:', err);
        }
      }

      console.log('[WebhookService] Access token refreshed successfully');
      return true;
    } catch (err) {
      console.error('[WebhookService] Token refresh error:', err);
      return false;
    }
  }

  private async storeWebhookData(
    jobberRequestId: string,
    topic: string,
    accountId: string,
    detail: {
      title: string | null;
      clientName: string | null;
      description: string;
      imageUrls: string[];
      detail: RequestDetail;
    } | null,
    rawPayload: JobberWebhookPayload,
  ): Promise<void> {
    await this.db.prepare(
      `INSERT INTO jobber_webhook_requests
        (id, jobber_request_id, topic, account_id, title, client_name, description, request_body, image_urls, raw_payload, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (jobber_request_id, topic) DO UPDATE SET
         title = COALESCE(excluded.title, jobber_webhook_requests.title),
         client_name = COALESCE(excluded.client_name, jobber_webhook_requests.client_name),
         description = COALESCE(excluded.description, jobber_webhook_requests.description),
         request_body = COALESCE(excluded.request_body, jobber_webhook_requests.request_body),
         image_urls = COALESCE(excluded.image_urls, jobber_webhook_requests.image_urls),
         raw_payload = excluded.raw_payload,
         processed_at = COALESCE(excluded.processed_at, jobber_webhook_requests.processed_at)`
    ).bind(
      crypto.randomUUID(),
      jobberRequestId,
      topic,
      accountId,
      detail?.title ?? null,
      detail?.clientName ?? null,
      detail?.description ?? null,
      detail ? JSON.stringify(detail.detail) : null,
      detail ? JSON.stringify(detail.imageUrls) : '[]',
      JSON.stringify(rawPayload),
      detail ? new Date().toISOString() : null,
    ).run();
  }

  async getWebhookRequests(): Promise<JobberCustomerRequest[]> {
    // Include all webhook requests, preferring rows with full detail (processed_at IS NOT NULL)
    // but falling back to unprocessed rows so new requests aren't lost.
    const result = await this.db.prepare(
      `SELECT w.jobber_request_id, w.title, w.client_name, w.description, w.image_urls, w.request_body, w.received_at
       FROM jobber_webhook_requests w
       INNER JOIN (
         SELECT jobber_request_id,
           MAX(CASE WHEN processed_at IS NOT NULL THEN received_at ELSE NULL END) as best_received,
           MAX(received_at) as any_received
         FROM jobber_webhook_requests
         GROUP BY jobber_request_id
       ) latest ON w.jobber_request_id = latest.jobber_request_id
         AND w.received_at = COALESCE(latest.best_received, latest.any_received)
       ORDER BY w.received_at DESC`
    ).all();

    const rows = result.results as any[];
    console.log(`[WebhookService] getWebhookRequests: ${rows.length} rows from D1`);

    // Backfill on read: for rows missing request_body, try fetching detail now.
    // This handles cases where the initial webhook processing failed (e.g., expired token).
    // Limit to 3 per request to avoid slow responses when many rows are incomplete.
    // Wrapped in a top-level try/catch so backfill failures never prevent returning stored data.
    try {
      const incompleteIds = rows
        .filter((r) => !r.request_body)
        .map((r) => r.jobber_request_id as string)
        .slice(0, 3);

      if (incompleteIds.length > 0 && this.accessToken) {
        console.log(`[WebhookService] Backfilling ${incompleteIds.length} incomplete rows`);
        for (const id of incompleteIds) {
          try {
            const detail = await this.fetchRequestDetail(id);
            if (!detail) continue;

            const { imageUrls, description, clientName } = this.parseRequestDetail(detail);

            await this.db.prepare(
              `UPDATE jobber_webhook_requests
               SET title = ?, client_name = ?, description = ?, request_body = ?, image_urls = ?, processed_at = ?
               WHERE jobber_request_id = ? AND request_body IS NULL`
            ).bind(
              detail.title ?? null,
              clientName,
              description || null,
              JSON.stringify(detail),
              JSON.stringify(imageUrls),
              new Date().toISOString(),
              id,
            ).run();

            const row = rows.find((r) => r.jobber_request_id === id);
            if (row) {
              row.title = detail.title;
              row.client_name = clientName;
              row.description = description;
              row.request_body = JSON.stringify(detail);
              row.image_urls = JSON.stringify(imageUrls);
            }
          } catch (err) {
            console.warn(`[WebhookService] Backfill-on-read failed for ${id}:`, err instanceof Error ? err.message : err);
          }
        }
      }
    } catch (err) {
      console.warn('[WebhookService] Backfill-on-read crashed, continuing with stored data:', err instanceof Error ? err.message : err);
    }

    return rows.map((row): JobberCustomerRequest | null => {
      let structuredNotes: { message: string; createdBy: 'team' | 'client' | 'system'; createdAt: string }[] = [];
      let imageUrls: string[] = [];

      try {
        imageUrls = JSON.parse(row.image_urls || '[]');
      } catch { imageUrls = []; }

      // Parse the stored request body to extract notes and the original Jobber createdAt
      let jobberCreatedAt: string | null = null;
      let jobberWebUri = '';
      if (row.request_body) {
        try {
          const detail = JSON.parse(row.request_body) as RequestDetail;
          jobberCreatedAt = detail.createdAt ?? null;
          jobberWebUri = detail.jobberWebUri ?? '';
          structuredNotes = detail.notes.edges
            .filter((e) => e.node?.message)
            .map((e) => {
              const typeName = e.node.createdBy?.__typename ?? '';
              let createdBy: 'team' | 'client' | 'system' = 'system';
              if (typeName === 'User') createdBy = 'team';
              else if (typeName === 'Client') createdBy = 'client';
              return {
                message: e.node.message!,
                createdBy,
                createdAt: e.node.createdAt ?? row.received_at,
              };
            });
        } catch { /* ignore */ }
      }

      // If we don't have the real Jobber createdAt, skip this request entirely.
      // Using received_at (webhook receipt time) as a substitute caused old requests
      // to appear with recent dates and sort to the top of the list.
      if (!jobberCreatedAt) {
        return null;
      }

      return {
        id: row.jobber_request_id as string,
        title: (row.title as string) || `Request from ${(row.client_name as string) || 'Unknown'}`,
        clientName: (row.client_name as string) || 'Unknown',
        description: (row.description as string) || '',
        notes: structuredNotes.map((n) => n.message),
        structuredNotes,
        imageUrls,
        jobberWebUri,
        createdAt: jobberCreatedAt,
      };
    }).filter((r): r is JobberCustomerRequest => r !== null);
  }

  /**
   * Backfill: fetch full details for all requests directly from the API
   * and store them in the webhook table.
   */
  async backfillFromApi(accessToken: string): Promise<{ processed: number; failed: number; total: number; lastError?: string }> {
    let processed = 0;
    let failed = 0;
    let total = 0;
    let lastError: string | undefined;
    let after: string | null = null;
    let hasMore = true;

    while (hasMore) {
      let edges: any[];
      let pageInfo: { hasNextPage: boolean; endCursor: string | null };

      try {
        const res = await fetch(JOBBER_GRAPHQL_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'X-JOBBER-GRAPHQL-VERSION': '2025-04-16',
          },
          body: JSON.stringify({
            query: `query($first: Int!, $after: String) {
              requests(first: $first, after: $after) {
                edges {
                  node {
                    id
                    title
                    companyName
                    contactName
                    requestStatus
                    createdAt
                    jobberWebUri
                    client { id firstName lastName companyName }
                    notes(first: 20) {
                      edges {
                        node {
                          ... on RequestNote {
                            message
                            createdAt
                            createdBy { __typename }
                          }
                        }
                      }
                    }
                    noteAttachments(first: 20) {
                      edges {
                        node { url fileName contentType }
                      }
                    }
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }`,
            variables: { first: 25, after },
          }),
        });

        if (!res.ok) { failed++; break; }
        const json = await res.json() as any;
        edges = json?.data?.requests?.edges ?? [];
        pageInfo = json?.data?.requests?.pageInfo ?? { hasNextPage: false, endCursor: null };
      } catch {
        break;
      }

      for (const edge of edges) {
        total++;
        const node = edge.node;
        try {
          // Check if already stored
          const existing = await this.db.prepare(
            'SELECT id FROM jobber_webhook_requests WHERE jobber_request_id = ? AND processed_at IS NOT NULL LIMIT 1'
          ).bind(node.id).first();
          if (existing) { processed++; continue; }

          const imageUrls = (node.noteAttachments?.edges ?? [])
            .filter((e: any) => e.node.contentType.startsWith('image/'))
            .map((e: any) => e.node.url);

          const description = (node.notes?.edges ?? [])
            .map((e: any) => e.node?.message)
            .filter((m: any): m is string => !!m)
            .join('\n\n');

          await this.db.prepare(
            `INSERT INTO jobber_webhook_requests
              (id, jobber_request_id, topic, account_id, title, client_name, description, request_body, image_urls, raw_payload, processed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            crypto.randomUUID(),
            node.id,
            'BACKFILL',
            '',
            node.title ?? null,
            node.companyName || node.contactName || (node.client ? `${node.client.firstName || ''} ${node.client.lastName || ''}`.trim() || node.client.companyName : null) || null,
            description,
            JSON.stringify(node),
            JSON.stringify(imageUrls),
            JSON.stringify({ backfill: true }),
            new Date().toISOString(),
          ).run();
          processed++;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          failed++;
        }
      }

      hasMore = pageInfo.hasNextPage && !!pageInfo.endCursor;
      after = pageInfo.endCursor;
    }

    return { processed, failed, total, lastError };
  }
}
