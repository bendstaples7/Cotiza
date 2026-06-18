import { ActivityLogService } from './activity-log-service.js';
import type { JobberTokenStore } from './jobber-token-store.js';
import type { ProductCatalogEntry, JobberCustomerRequest } from 'shared';

const DEFAULT_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const API_TIMEOUT_MS = 10_000;
const DEFAULT_PAGE_SIZE = 50;

// ── Internal GraphQL response types ──────────────────────────────────

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

interface RelayConnection<T> {
  edges: Array<{ node: T }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface JobberProductNode {
  id: string;
  name: string;
  description: string | null;
  defaultUnitCost: number;
  category: string;
}

interface JobberRequestNode {
  id: string;
  title: string | null;
  companyName: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  requestStatus: string;
  createdAt: string;
  jobberWebUri: string;
  client?: { id: string; firstName: string | null; lastName: string | null; companyName: string | null };
  notes: {
    edges: Array<{ node: { message?: string; createdAt?: string; createdBy?: { __typename: string } } }>;
  };
  noteAttachments: {
    edges: Array<{ node: { url: string; fileName: string; contentType: string } }>;
  };
}

// ── Cache helper ─────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

// ── GraphQL queries ──────────────────────────────────────────────────

const PRODUCTS_QUERY = `
  query FetchProducts($first: Int!, $after: String) {
    productOrServices(first: $first, after: $after) {
      edges {
        node {
          id
          name
          description
          defaultUnitCost
          category
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const REQUESTS_QUERY = `
  query FetchRequests($first: Int!, $after: String) {
    requests(first: $first, after: $after, sort: [{ key: REQUESTED_AT, direction: DESCENDING }]) {
      edges {
        node {
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
          notes(first: 5) {
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
          noteAttachments(first: 5) {
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
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// ── Main class ───────────────────────────────────────────────────────

export class JobberIntegration {
  private activityLog: ActivityLogService;
  private available: boolean = true;
  private cacheTtlMs: number;

  private productCatalogCache: CacheEntry<ProductCatalogEntry[]> | null = null;
  private customerRequestsCache: CacheEntry<JobberCustomerRequest[]> | null = null;

  private clientId: string;
  private clientSecret: string;
  private accessToken: string;
  private refreshToken: string;
  private apiUrl: string;
  private tokenStore: JobberTokenStore | null;

  constructor(
    activityLog: ActivityLogService,
    opts: {
      clientId: string;
      clientSecret: string;
      accessToken: string;
      refreshToken?: string;
      apiUrl?: string;
      cacheTtlMs?: number;
      tokenStore?: JobberTokenStore;
    },
  ) {
    this.activityLog = activityLog;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.accessToken = opts.accessToken;
    this.refreshToken = opts.refreshToken || '';
    this.apiUrl = opts.apiUrl || 'https://api.getjobber.com/api/graphql';
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.tokenStore = opts.tokenStore ?? null;
  }

  /**
   * Load the latest tokens from D1 if a token store is configured.
   * Call this before making API requests to ensure we have the freshest tokens.
   */
  async loadPersistedTokens(): Promise<void> {
    if (!this.tokenStore) return;
    try {
      const stored = await this.tokenStore.load();
      if (stored) {
        this.accessToken = stored.accessToken;
        this.refreshToken = stored.refreshToken;
        console.log(`[DEBUG] loadPersistedTokens: loaded token ${this.accessToken.substring(0, 15)}... len=${this.accessToken.length}`);
      } else {
        console.log(`[DEBUG] loadPersistedTokens: no stored tokens, using env vars: ${this.accessToken.substring(0, 15)}...`);
      }
    } catch {
      console.log(`[DEBUG] loadPersistedTokens: FAILED, falling back to env vars: ${this.accessToken.substring(0, 15)}...`);
    }
  }

  /**
   * Check whether the Jobber API is currently reachable.
   * Returns false after an API error until a successful fetch restores it.
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Clear all cached data, forcing fresh fetches on next call.
   */
  invalidateCache(): void {
    this.productCatalogCache = null;
    this.customerRequestsCache = null;
  }

  /**
   * Get the timestamp when the customer requests cache was last populated.
   * Returns null if no cache exists.
   */
  getRequestsCacheFetchedAt(): number | null {
    return this.customerRequestsCache?.fetchedAt ?? null;
  }

  // ── Product Catalog ──────────────────────────────────────────────

  /**
   * Fetch the product catalog from Jobber, returning cached data when within TTL.
   * On API failure, logs the error, sets available = false, and returns an empty array.
   */
  async fetchProductCatalog(): Promise<ProductCatalogEntry[]> {
    if (this.productCatalogCache && !this.isCacheExpired(this.productCatalogCache)) {
      return this.productCatalogCache.data;
    }

    try {
      const nodes = await this.fetchAllPages<JobberProductNode>(
        PRODUCTS_QUERY,
        { first: DEFAULT_PAGE_SIZE, after: null },
        ['productOrServices'],
      );

      const catalog: ProductCatalogEntry[] = nodes.map((p) => ({
        id: p.id,
        name: p.name,
        unitPrice: p.defaultUnitCost,
        description: p.description ?? '',
        category: p.category ?? undefined,
        source: 'jobber' as const,
      }));

      this.productCatalogCache = { data: catalog, fetchedAt: Date.now() };
      this.available = true;
      return catalog;
    } catch (err) {
      await this.handleApiError('fetchProductCatalog', err);
      return [];
    }
  }

  // ── Product Catalog Sync ──────────────────────────────────────────

  /**
   * Sync Jobber products into the unified product_catalog table.
   *
   * - Inserts new products with ON CONFLICT(user_id, name) DO NOTHING — never overwrites existing rows.
   * - Updates jobber_active: 1 for products in the Jobber response, 0 for Jobber-sourced products no longer in Jobber.
   *
   * @returns counts of inserted and deactivated products, plus total Jobber products fetched.
   */
  async syncProductCatalog(
    db: D1Database,
    userId: string,
  ): Promise<{ inserted: number; deactivated: number; total: number }> {
    try {
      const jobberProducts = await this.fetchProductCatalog();

      if (jobberProducts.length === 0) {
        return { inserted: 0, deactivated: 0, total: 0 };
      }

      const total = jobberProducts.length;
      let inserted = 0;

      // Batch inserts in groups of 50 to stay within D1 limits
      const BATCH_SIZE = 50;
      for (let i = 0; i < jobberProducts.length; i += BATCH_SIZE) {
        const batch = jobberProducts.slice(i, i + BATCH_SIZE);
        const stmts = batch.map((product) => {
          return db
            .prepare(
              `INSERT INTO product_catalog (id, user_id, name, unit_price, description, category, sort_order, keywords, source, jobber_active)
               VALUES (?, ?, ?, ?, ?, ?, 500, NULL, 'jobber', 1)
               ON CONFLICT(user_id, name) DO NOTHING`,
            )
            .bind(
              crypto.randomUUID(),
              userId,
              product.name,
              product.unitPrice,
              product.description,
              product.category ?? null,
            );
        });

        const results = await db.batch(stmts);

        for (const result of results) {
          if (result.meta?.changes && result.meta.changes > 0) {
            inserted++;
          }
        }
      }

      // Update jobber_active flags:
      // 1. Set jobber_active=1 for all products whose names match the Jobber response
      // 2. Set jobber_active=0 for Jobber-sourced products NOT in the response
      const jobberNames = jobberProducts.map((p) => p.name);
      const placeholders = jobberNames.map(() => '?').join(', ');

      const activateStmt = db
        .prepare(
          `UPDATE product_catalog SET jobber_active = 1, updated_at = datetime('now')
           WHERE user_id = ? AND name IN (${placeholders})`,
        )
        .bind(userId, ...jobberNames);

      const deactivateStmt = db
        .prepare(
          `UPDATE product_catalog SET jobber_active = 0, updated_at = datetime('now')
           WHERE user_id = ? AND source = 'jobber' AND name NOT IN (${placeholders})`,
        )
        .bind(userId, ...jobberNames);

      const [, deactivateResult] = await db.batch([activateStmt, deactivateStmt]);
      const deactivated = deactivateResult.meta?.changes ?? 0;

      // Log the sync result
      try {
        await this.activityLog.log({
          userId,
          component: 'JobberIntegration',
          operation: 'syncProductCatalog',
          severity: 'info',
          description: `Synced ${total} Jobber products: ${inserted} new, ${deactivated} deactivated.`,
        });
      } catch {
        // Activity log failure should not break sync
      }

      return { inserted, deactivated, total };
    } catch (err) {
      const description =
        err instanceof Error
          ? `Product catalog sync failed: ${err.message}`
          : 'Product catalog sync failed: Unknown error';

      console.error(`[JobberIntegration] syncProductCatalog failed: ${description}`);

      try {
        await this.activityLog.log({
          userId,
          component: 'JobberIntegration',
          operation: 'syncProductCatalog',
          severity: 'error',
          description,
          recommendedAction: 'Check Jobber API connectivity and D1 database availability.',
        });
      } catch {
        // Activity log failure should not break error handling
      }

      return { inserted: 0, deactivated: 0, total: 0 };
    }
  }

  // ── Customer Requests ────────────────────────────────────────────

  /**
   * Fetch customer requests from Jobber, returning cached data when within TTL.
   * On failure, logs the error and returns [] but does NOT set available = false.
   */
  async fetchCustomerRequests(): Promise<JobberCustomerRequest[]> {
    if (this.customerRequestsCache && !this.isCacheExpired(this.customerRequestsCache)) {
      return this.customerRequestsCache.data;
    }

    try {
      // Only fetch the first page of requests (sorted by REQUESTED_AT DESC in the query).
      // Using fetchAllPages previously pulled every request ever created (potentially thousands),
      // including very old archived/converted ones that are no longer actionable.
      const data = await this.graphqlRequest<Record<string, unknown>>(REQUESTS_QUERY, {
        first: DEFAULT_PAGE_SIZE,
        after: null,
      });
      const connection = (data as any).requests as { edges: Array<{ node: JobberRequestNode }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | undefined;
      const nodes: JobberRequestNode[] = connection?.edges?.map((e) => e.node) ?? [];

      const requests: JobberCustomerRequest[] = nodes.map((r) => {
        const structuredNotes = r.notes.edges
          .filter((e) => e.node?.message)
          .map((e) => {
            const typeName = e.node.createdBy?.__typename ?? '';
            let createdBy: 'team' | 'client' | 'system' = 'system';
            if (typeName === 'User') createdBy = 'team';
            else if (typeName === 'Client') createdBy = 'client';
            return {
              message: e.node.message!,
              createdBy,
              createdAt: e.node.createdAt ?? r.createdAt,
            };
          });

        const clientDetail = r.client;
        const clientName = r.companyName
          || r.contactName
          || (clientDetail ? `${clientDetail.firstName || ''} ${clientDetail.lastName || ''}`.trim() || clientDetail.companyName : null)
          || 'Unknown';

        return {
          id: r.id,
          title: r.title || `Request from ${clientName}`,
          clientName,
          description: r.notes.edges[0]?.node?.message || '',
          notes: r.notes.edges
            .map((e) => e.node?.message)
            .filter((m): m is string => !!m),
          structuredNotes,
          imageUrls: (r.noteAttachments?.edges ?? [])
            .filter((e) => e.node.contentType.startsWith('image/'))
            .map((e) => e.node.url),
          jobberWebUri: r.jobberWebUri,
          createdAt: r.createdAt,
        };
      });

      // Sort by createdAt descending (newest first)
      requests.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      this.customerRequestsCache = { data: requests, fetchedAt: Date.now() };
      return requests;
    } catch (err) {
      // Log error but do NOT set available = false
      const description =
        err instanceof Error && err.name === 'AbortError'
          ? 'Jobber API request timed out during fetchCustomerRequests'
          : `Jobber API error during fetchCustomerRequests: ${err instanceof Error ? err.message : 'Unknown error'}`;

      console.error(`[JobberIntegration] fetchCustomerRequests failed: ${description}`);

      try {
        await this.activityLog.log({
          userId: 'system',
          component: 'JobberIntegration',
          operation: 'fetchCustomerRequests',
          severity: 'error',
          description,
          recommendedAction: 'Check Jobber API credentials and connectivity. Customer requests are unavailable but manual entry still works.',
        });
      } catch (logErr) {
        console.error('Failed to write to activity log:', logErr);
      }

      return [];
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private isCacheExpired<T>(entry: CacheEntry<T>): boolean {
    return Date.now() - entry.fetchedAt >= this.cacheTtlMs;
  }

  /**
   * Send a GraphQL query to the Jobber API and return the parsed data.
   * Automatically refreshes the access token on 401 and retries once.
   * Retries on throttle errors with exponential backoff.
   */
  async graphqlRequest<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 2000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const result = await this.executeGraphql<T>(query, variables);

      // If we got a 401 and have a refresh token, try refreshing and retry once
      if (result.status === 401 && this.refreshToken) {
        const refreshed = await this.refreshAccessToken();
        if (refreshed) {
          const retry = await this.executeGraphql<T>(query, variables);
          if (retry.status !== undefined) {
            throw new Error(`Jobber API error (${retry.status}): ${retry.errorText}`);
          }
          if (!retry.throttled) {
            return retry.data!;
          }
          // If the retry was throttled, fall through to the throttle backoff logic below
        }
      }

      if (result.status !== undefined) {
        throw new Error(`Jobber API error (${result.status}): ${result.errorText}`);
      }

      if (result.throttled && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`[JobberIntegration] Throttled, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (result.throttled) {
        throw new Error('Jobber API throttled after max retries');
      }

      return result.data!;
    }

    throw new Error('Jobber API: unexpected retry loop exit');
  }

  private async executeGraphql<T>(query: string, variables?: Record<string, unknown>): Promise<{
    data?: T;
    status?: number;
    errorText?: string;
    throttled?: boolean;
  }> {
    if (!this.accessToken) {
      throw new Error('JOBBER_ACCESS_TOKEN is not configured');
    }

    // DEBUG: log token prefix and query cost hint
    const tokenStart = this.accessToken.substring(0, 5);
    const tokenEnd = this.accessToken.substring(this.accessToken.length - 5);
    const tokenSum = tokenStart.split('').reduce((a, c) => a + c.charCodeAt(0), 0) + tokenEnd.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    console.log(`[DEBUG] executeGraphql token_checksum=${tokenSum} len=${this.accessToken.length}`);
    console.log(`[DEBUG] query hint: ${query.substring(0, 60).replace(/\n/g, ' ')}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'X-JOBBER-GRAPHQL-VERSION': '2025-04-16',
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        console.log(`[DEBUG] Jobber HTTP ${response.status}: ${text.substring(0, 100)}`);
        return { status: response.status, errorText: text };
      }

      const json = (await response.json()) as GraphQLResponse<T>;

      if (json.errors && json.errors.length > 0) {
        console.log(`[DEBUG] Jobber GraphQL errors: ${JSON.stringify(json.errors)}`);
        const isThrottled = json.errors.some((e) => /throttle/i.test(e.message));
        if (isThrottled) {
          return { throttled: true };
        }
        throw new Error(`Jobber GraphQL error: ${json.errors[0].message}`);
      }

      if (!json.data) {
        throw new Error('Jobber GraphQL response missing data field');
      }

      console.log(`[DEBUG] Jobber success, data keys: ${Object.keys(json.data as object).join(',')}`);
      return { data: json.data };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Refresh the Jobber access token using the refresh token.
   * Returns true if the refresh succeeded.
   */
  private async refreshAccessToken(): Promise<boolean> {
    try {
      const tokenUrl = 'https://api.getjobber.com/api/oauth/token';
      const body = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
      });

      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!response.ok) {
        console.error(`[JobberIntegration] Token refresh failed (${response.status}): ${await response.text()}`);
        return false;
      }

      const data = (await response.json()) as { access_token: string; refresh_token?: string };

      if (!data.access_token) {
        console.error('[JobberIntegration] Token refresh response missing access_token');
        return false;
      }

      this.accessToken = data.access_token;

      // If refresh token rotation is enabled, Jobber returns a new refresh token
      if (data.refresh_token) {
        this.refreshToken = data.refresh_token;
      }

      // Persist refreshed tokens to D1 so they survive cold starts
      if (this.tokenStore) {
        try {
          await this.tokenStore.save(this.accessToken, this.refreshToken);
        } catch (err) {
          console.error('[JobberIntegration] Token refresh succeeded but failed to persist to D1:', err);
        }
      }

      console.log('[JobberIntegration] Access token refreshed successfully');
      return true;
    } catch (err) {
      console.error('[JobberIntegration] Token refresh error:', err);
      return false;
    }
  }

  /**
   * Paginate through a Relay-style connection, accumulating all nodes.
   */
  private async fetchAllPages<TNode>(
    query: string,
    variables: Record<string, unknown>,
    connectionPath: string[],
    pageSize: number = DEFAULT_PAGE_SIZE,
  ): Promise<TNode[]> {
    const allNodes: TNode[] = [];
    let after: string | null = null;

    do {
      const vars = { ...variables, first: pageSize, after };
      const data = await this.graphqlRequest<Record<string, unknown>>(query, vars);

      // Navigate to the connection object using the path
      let connection: unknown = data;
      for (const key of connectionPath) {
        connection = (connection as Record<string, unknown>)[key];
      }

      const typed = connection as RelayConnection<TNode>;
      if (!typed || !typed.edges) {
        break;
      }

      for (const edge of typed.edges) {
        allNodes.push(edge.node);
      }

      if (typed.pageInfo.hasNextPage && typed.pageInfo.endCursor) {
        after = typed.pageInfo.endCursor;
      } else {
        break;
      }
    } while (true);

    return allNodes;
  }

  private async handleApiError(operation: string, err: unknown): Promise<void> {
    this.available = false;

    const description =
      err instanceof Error && err.name === 'AbortError'
        ? `Jobber API request timed out during ${operation}`
        : `Jobber API error during ${operation}: ${err instanceof Error ? err.message : 'Unknown error'}`;

    try {
      await this.activityLog.log({
        userId: 'system',
        component: 'JobberIntegration',
        operation,
        severity: 'error',
        description,
        recommendedAction: 'Check Jobber API credentials and connectivity. Using manual fallback mode.',
      });
    } catch (logErr) {
      console.error('Failed to write to activity log:', logErr);
    }
  }
}
