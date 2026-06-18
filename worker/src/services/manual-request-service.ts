import { PlatformError } from '../errors/index.js';
import type { ManualRequest, CreateManualRequestPayload, DeathclockState } from 'shared';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A manual-request row returned by list(), optionally enriched with deathclock data. */
export interface ManualRequestListRow extends ManualRequest {
  ageSeconds: number;
  quoteSentAt?: string | null;
  deathclock?: DeathclockState;
  jobberRequestId?: string | null;
}

/** Bucket counts returned by the deathclock stats endpoint. */
export interface DeathclockBucketCounts {
  green: number;
  yellow: number;
  orange: number;
  red: number;
  totalActive: number;
}

/** One day in the bucket history for trend visualization. */
export interface BucketHistoryEntry {
  date: string;
  green: number;
  yellow: number;
  orange: number;
  red: number;
}

/** Response shape for GET /trends. */
export interface DeathclockTrends {
  avg7Days: number;
  avg30Days: number;
  bucketHistory: BucketHistoryEntry[];
}

export class ManualRequestService {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * List manual requests for a user, with optional age computation and sorting.
   *
   * When `includeDeathclock` is true the query LEFT JOINs quote_drafts to
   * retrieve `quote_sent_at` (the frozen-timer timestamp) so the caller can
   * construct a full DeathclockState.  Age is computed in SQL in all cases
   * via `unixepoch('now') - unixepoch(created_at)`.
   *
   * `sortBy` controls the ORDER BY clause:
   *   - `'age_asc'`  → oldest first (ORDER BY age_seconds ASC)
   *   - `'age_desc'` → newest first (ORDER BY age_seconds DESC)
   *   - omitted       → no ORDER BY (natural table order)
   */
  async list(params: {
    userId: string;
    sortBy?: 'age_asc' | 'age_desc';
    includeDeathclock?: boolean;
  }): Promise<ManualRequestListRow[]> {
    const { userId, sortBy, includeDeathclock } = params;

    // Compute age_seconds in SQL: NOW() - created_at
    const ageExpr = "CAST((unixepoch('now') - unixepoch(created_at)) AS INTEGER)";

    let orderClause = '';
    if (sortBy === 'age_asc') {
      // age_seconds = NOW - created_at, so larger value = older request.
      // "Oldest first" (most urgent) requires DESC so highest age_seconds comes first.
      orderClause = `ORDER BY age_seconds DESC`;
    } else if (sortBy === 'age_desc') {
      // "Newest first" = smallest age_seconds first = ASC.
      orderClause = `ORDER BY age_seconds ASC`;
    }

    const deathclockManualCols = includeDeathclock ? `
               ,(SELECT MIN(qd.quote_sent_at)
                   FROM quote_drafts qd
                  WHERE qd.manual_request_id = mr.id
                    AND qd.quote_sent_at IS NOT NULL
                ) AS quote_sent_at
               ,(SELECT qd.jobber_request_id
                   FROM quote_drafts qd
                  WHERE qd.manual_request_id = mr.id
                  LIMIT 1
                ) AS jobber_request_id` : `, NULL AS quote_sent_at, NULL AS jobber_request_id`;

    const deathclockJobberCols = includeDeathclock ? `
               ,(SELECT MIN(qd.quote_sent_at)
                   FROM quote_drafts qd
                  WHERE qd.jobber_request_id = jwr.jobber_request_id
                    AND qd.quote_sent_at IS NOT NULL
                ) AS quote_sent_at
               ,jwr.jobber_request_id AS jobber_request_id` : `, NULL AS quote_sent_at, jwr.jobber_request_id AS jobber_request_id`;

    // UNION manual_requests + jobber_webhook_requests so the queue shows all sources.
    // Wrapped in outer SELECT so ORDER BY can reference the computed age_seconds alias.
    const sql = `
      SELECT * FROM (
        SELECT mr.id,
               mr.user_id,
               mr.customer_name,
               mr.customer_phone,
               mr.customer_email,
               mr.customer_address,
               mr.service_description,
               mr.media_item_ids_json,
               mr.created_at,
               CAST((unixepoch('now') - unixepoch(mr.created_at)) AS INTEGER) AS age_seconds,
               'manual' AS request_source
               ${deathclockManualCols}
        FROM manual_requests mr
        WHERE mr.user_id = ?

        UNION ALL

        SELECT jwr.id,
               ? AS user_id,
               COALESCE(jwr.client_name, jwr.title, 'Unknown') AS customer_name,
               NULL AS customer_phone,
               NULL AS customer_email,
               NULL AS customer_address,
               COALESCE(jwr.description, jwr.title, '') AS service_description,
               '[]' AS media_item_ids_json,
               jwr.received_at AS created_at,
               CAST((unixepoch('now') - unixepoch(jwr.received_at)) AS INTEGER) AS age_seconds,
               'jobber' AS request_source
               ${deathclockJobberCols}
        FROM jobber_webhook_requests jwr
        -- Scope to user via quote_drafts: only surface webhook requests that
        -- this user has already drafted (or is drafting). Without this JOIN,
        -- ALL webhook requests across all users would be returned.
        INNER JOIN quote_drafts qd_scope
          ON qd_scope.jobber_request_id = jwr.jobber_request_id
         AND qd_scope.user_id = ?
      )
      ${orderClause}
    `;

    const rows = await this.db.prepare(sql).bind(userId, userId, userId).all<Record<string, unknown>>();

    return (rows.results ?? []).map(row => this.mapListRow(row));
  }

  /**
   * Get deathclock bucket counts for the authenticated user.
   *
   * Only counts requests that are still active (no sent quote draft).
   * Buckets are computed in SQL via unixepoch arithmetic:
   *   green  →  age < 24h
   *   yellow →  24h ≤ age < 48h
   *   orange →  48h ≤ age < 72h
   *   red    →  age ≥ 72h
   */
  async getDeathclockStats(userId: string): Promise<DeathclockBucketCounts> {
    // Unified request source: UNION of Jobber webhook requests and manual requests.
    // Jobber webhook requests are the primary source of real customer requests.
    // A request is "active" (still needs a quote sent) when no linked quote draft
    // has been sent (quote_sent_at IS NOT NULL).
    const sql = `
      WITH all_requests AS (
        -- Jobber webhook requests (primary source)
        SELECT
          jwr.jobber_request_id AS request_key,
          'jobber' AS source,
          jwr.received_at AS created_at
        FROM jobber_webhook_requests jwr
        WHERE NOT EXISTS (
          SELECT 1 FROM quote_drafts qd
          WHERE qd.jobber_request_id = jwr.jobber_request_id
            AND qd.quote_sent_at IS NOT NULL
        )
        UNION ALL
        -- Manual requests
        SELECT
          mr.id AS request_key,
          'manual' AS source,
          mr.created_at AS created_at
        FROM manual_requests mr
        WHERE mr.user_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM quote_drafts qd
            WHERE qd.manual_request_id = mr.id
              AND qd.quote_sent_at IS NOT NULL
          )
      )
      SELECT
        SUM(CASE WHEN CAST((unixepoch('now') - unixepoch(created_at)) AS INTEGER) < 86400  THEN 1 ELSE 0 END) AS green,
        SUM(CASE WHEN CAST((unixepoch('now') - unixepoch(created_at)) AS INTEGER) >= 86400  AND CAST((unixepoch('now') - unixepoch(created_at)) AS INTEGER) < 172800 THEN 1 ELSE 0 END) AS yellow,
        SUM(CASE WHEN CAST((unixepoch('now') - unixepoch(created_at)) AS INTEGER) >= 172800 AND CAST((unixepoch('now') - unixepoch(created_at)) AS INTEGER) < 259200 THEN 1 ELSE 0 END) AS orange,
        SUM(CASE WHEN CAST((unixepoch('now') - unixepoch(created_at)) AS INTEGER) >= 259200 THEN 1 ELSE 0 END) AS red,
        COUNT(*) AS total_active
      FROM all_requests
    `;

    const row = await this.db.prepare(sql).bind(userId).first<Record<string, unknown>>();

    return {
      green: Number(row?.green ?? 0),
      yellow: Number(row?.yellow ?? 0),
      orange: Number(row?.orange ?? 0),
      red: Number(row?.red ?? 0),
      totalActive: Number(row?.total_active ?? 0),
    };
  }

  /**
   * Get rolling average request-to-quote times and bucket history for trend
   * visualization over the last 7 days.
   *
   * Two aggregate queries:
   *   1. 7-day and 30-day rolling average of request_to_quote_seconds
   *      (scoped to drafts that have been sent within those windows).
   *   2. Per-day bucket counts based on request age at end of each day.
   */
  async getTrends(userId: string): Promise<DeathclockTrends> {
    // ── Query 1: rolling averages ──────────────────────────────
    // Include both Jobber-request-linked drafts and manual-request-linked drafts
    const avgSql = `
      SELECT
        (SELECT ROUND(AVG(request_to_quote_seconds), 1)
           FROM quote_drafts qd
          WHERE qd.user_id = ?1
            AND qd.request_to_quote_seconds IS NOT NULL
            AND qd.quote_sent_at >= datetime('now', '-7 days')
            AND (qd.manual_request_id IS NOT NULL OR qd.jobber_request_id IS NOT NULL)
        ) AS avg_7_days,
        (SELECT ROUND(AVG(request_to_quote_seconds), 1)
           FROM quote_drafts qd
          WHERE qd.user_id = ?1
            AND qd.request_to_quote_seconds IS NOT NULL
            AND qd.quote_sent_at >= datetime('now', '-30 days')
            AND (qd.manual_request_id IS NOT NULL OR qd.jobber_request_id IS NOT NULL)
        ) AS avg_30_days
    `;

    const avgRow = await this.db.prepare(avgSql).bind(userId).first<Record<string, unknown>>();

    // ── Query 2: bucket history ────────────────────────────────
    // For each of the last 7 days, count ALL active requests (Jobber + manual)
    // grouped by deathclock bucket as-of the end of that day.
    const bucketSql = `
      WITH RECURSIVE dates(d) AS (
        SELECT date('now')
        UNION ALL
        SELECT date(d, '-1 day') FROM dates WHERE d > date('now', '-6 days')
      ),
      all_requests AS (
        -- Jobber webhook requests
        SELECT jwr.received_at AS created_at, jwr.jobber_request_id AS req_key, 'jobber' AS src
        FROM jobber_webhook_requests jwr
        UNION ALL
        -- Manual requests
        SELECT mr.created_at AS created_at, mr.id AS req_key, 'manual' AS src
        FROM manual_requests mr
        WHERE mr.user_id = ?1
      )
      SELECT
        d AS date,
        COALESCE(SUM(CASE
          WHEN CAST((unixepoch(datetime(d || 'T23:59:59Z')) - unixepoch(ar.created_at)) AS INTEGER) < 86400
          THEN 1 ELSE 0 END), 0) AS green,
        COALESCE(SUM(CASE
          WHEN CAST((unixepoch(datetime(d || 'T23:59:59Z')) - unixepoch(ar.created_at)) AS INTEGER) >= 86400
           AND CAST((unixepoch(datetime(d || 'T23:59:59Z')) - unixepoch(ar.created_at)) AS INTEGER) < 172800
          THEN 1 ELSE 0 END), 0) AS yellow,
        COALESCE(SUM(CASE
          WHEN CAST((unixepoch(datetime(d || 'T23:59:59Z')) - unixepoch(ar.created_at)) AS INTEGER) >= 172800
           AND CAST((unixepoch(datetime(d || 'T23:59:59Z')) - unixepoch(ar.created_at)) AS INTEGER) < 259200
          THEN 1 ELSE 0 END), 0) AS orange,
        COALESCE(SUM(CASE
          WHEN CAST((unixepoch(datetime(d || 'T23:59:59Z')) - unixepoch(ar.created_at)) AS INTEGER) >= 259200
          THEN 1 ELSE 0 END), 0) AS red
      FROM dates
      CROSS JOIN all_requests ar
      WHERE ar.created_at < datetime(d || 'T23:59:59Z')
        AND NOT EXISTS (
          SELECT 1 FROM quote_send_events qse
          JOIN quote_drafts qd ON qd.id = qse.quote_id
          WHERE (
            (ar.src = 'manual' AND qd.manual_request_id = ar.req_key) OR
            (ar.src = 'jobber' AND qd.jobber_request_id = ar.req_key)
          )
          AND qse.sent_at < datetime(d || 'T23:59:59Z')
        )
      GROUP BY d
      ORDER BY d ASC
    `;

    const bucketRows = await this.db.prepare(bucketSql).bind(userId).all<Record<string, unknown>>();

    const bucketHistory: BucketHistoryEntry[] = (bucketRows.results ?? []).map(r => ({
      date: r.date as string,
      green: Number(r.green),
      yellow: Number(r.yellow),
      orange: Number(r.orange),
      red: Number(r.red),
    }));

    return {
      avg7Days: Number(avgRow?.avg_7_days ?? 0),
      avg30Days: Number(avgRow?.avg_30_days ?? 0),
      bucketHistory,
    };
  }

  /**
   * Create and persist a manual request. Returns the saved record.
   */
  async create(userId: string, payload: CreateManualRequestPayload): Promise<ManualRequest> {
    this.validate(payload);

    const id = crypto.randomUUID();
    const customerName = payload.customerName.trim();
    const serviceDescription = payload.serviceDescription.trim();
    const customerPhone = payload.customerPhone?.trim() || null;
    const customerEmail = payload.customerEmail?.trim() || null;
    const customerAddress = payload.customerAddress?.trim() || null;
    const mediaItemIds = payload.mediaItemIds ?? [];
    const mediaItemIdsJson = JSON.stringify(mediaItemIds);

    try {
      await this.db.prepare(
        `INSERT INTO manual_requests (id, user_id, customer_name, customer_phone, customer_email, customer_address, service_description, media_item_ids_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        userId,
        customerName,
        customerPhone,
        customerEmail,
        customerAddress,
        serviceDescription,
        mediaItemIdsJson,
      ).run();
    } catch (err) {
      throw new PlatformError({
        severity: 'error',
        component: 'ManualRequestService',
        operation: 'create',
        description: 'Failed to save request. Please try again',
        recommendedActions: ['Try submitting the request again'],
        statusCode: 500,
      });
    }

    return {
      id,
      userId,
      customerName,
      customerPhone,
      customerEmail,
      customerAddress,
      serviceDescription,
      mediaItemIds,
      requestSource: 'manual',
      createdAt: new Date(),
    };
  }

  /**
   * Get a manual request by ID, scoped to user.
   */
  async getById(id: string, userId: string): Promise<ManualRequest> {
    const row = await this.db.prepare(
      'SELECT id, user_id, customer_name, customer_phone, customer_email, customer_address, service_description, media_item_ids_json, created_at FROM manual_requests WHERE id = ? AND user_id = ?'
    ).bind(id, userId).first() as Record<string, unknown> | null;

    if (!row) {
      throw new PlatformError({
        severity: 'error',
        component: 'ManualRequestService',
        operation: 'getById',
        description: 'Manual request not found',
        recommendedActions: ['Verify the request ID is correct'],
        statusCode: 404,
      });
    }

    return this.mapRow(row);
  }

  /**
   * Get a manual request by its associated quote draft ID.
   */
  async getByDraftId(draftId: string, userId: string): Promise<ManualRequest | null> {
    const row = await this.db.prepare(
      `SELECT mr.id, mr.user_id, mr.customer_name, mr.customer_phone, mr.customer_email, mr.customer_address, mr.service_description, mr.media_item_ids_json, mr.created_at
       FROM manual_requests mr
       JOIN quote_drafts qd ON qd.manual_request_id = mr.id
       WHERE qd.id = ? AND mr.user_id = ? AND qd.user_id = ?`
    ).bind(draftId, userId, userId).first() as Record<string, unknown> | null;

    if (!row) {
      return null;
    }

    return this.mapRow(row);
  }

  /**
   * Validate the create payload. Throws PlatformError on invalid input.
   */
  private validate(payload: CreateManualRequestPayload): void {
    // Runtime type guards
    const customerName = typeof payload.customerName === 'string' ? payload.customerName.trim() : '';
    const serviceDescription = typeof payload.serviceDescription === 'string' ? payload.serviceDescription.trim() : '';
    const customerEmail = typeof payload.customerEmail === 'string' ? payload.customerEmail.trim() : null;
    const customerPhone = typeof payload.customerPhone === 'string' ? payload.customerPhone.trim() : null;
    const customerAddress = typeof payload.customerAddress === 'string' ? payload.customerAddress.trim() : null;

    // customerName: required, non-empty after trim, max 200 chars
    if (!customerName) {
      throw new PlatformError({
        severity: 'error',
        component: 'ManualRequestService',
        operation: 'create',
        description: 'Enter a customer name',
        recommendedActions: ['Provide a non-empty customer name'],
        statusCode: 400,
      });
    }
    if (customerName.length > 200) {
      throw new PlatformError({
        severity: 'error',
        component: 'ManualRequestService',
        operation: 'create',
        description: 'Customer name must be 200 characters or less',
        recommendedActions: ['Shorten the customer name to 200 characters or less'],
        statusCode: 400,
      });
    }

    // serviceDescription: required, non-empty after trim, max 10000 chars
    if (!serviceDescription) {
      throw new PlatformError({
        severity: 'error',
        component: 'ManualRequestService',
        operation: 'create',
        description: 'Enter a service description',
        recommendedActions: ['Provide a non-empty service description'],
        statusCode: 400,
      });
    }
    if (serviceDescription.length > 10000) {
      throw new PlatformError({
        severity: 'error',
        component: 'ManualRequestService',
        operation: 'create',
        description: 'Service description must be 10,000 characters or less',
        recommendedActions: ['Shorten the service description to 10,000 characters or less'],
        statusCode: 400,
      });
    }

    // customerEmail: optional, basic email regex validation
    if (customerEmail && customerEmail.length > 0) {
      if (!EMAIL_REGEX.test(customerEmail)) {
        throw new PlatformError({
          severity: 'error',
          component: 'ManualRequestService',
          operation: 'create',
          description: 'Enter a valid email address',
          recommendedActions: ['Provide a valid email address or leave the field empty'],
          statusCode: 400,
        });
      }
    }

    // customerPhone: optional, max 30 chars
    if (customerPhone && customerPhone.length > 30) {
      throw new PlatformError({
        severity: 'error',
        component: 'ManualRequestService',
        operation: 'create',
        description: 'Phone number must be 30 characters or less',
        recommendedActions: ['Shorten the phone number to 30 characters or less'],
        statusCode: 400,
      });
    }

    // customerAddress: optional, max 500 chars
    if (customerAddress && customerAddress.length > 500) {
      throw new PlatformError({
        severity: 'error',
        component: 'ManualRequestService',
        operation: 'create',
        description: 'Address must be 500 characters or less',
        recommendedActions: ['Shorten the address to 500 characters or less'],
        statusCode: 400,
      });
    }

    // mediaItemIds: optional array, max 10 items
    if (payload.mediaItemIds !== undefined && payload.mediaItemIds !== null) {
      if (!Array.isArray(payload.mediaItemIds)) {
        throw new PlatformError({
          severity: 'error',
          component: 'ManualRequestService',
          operation: 'create',
          description: 'mediaItemIds must be an array',
          recommendedActions: ['Provide mediaItemIds as an array of strings'],
          statusCode: 400,
        });
      }
      if (payload.mediaItemIds.length > 10) {
        throw new PlatformError({
          severity: 'error',
          component: 'ManualRequestService',
          operation: 'create',
          description: 'Maximum 10 images allowed',
          recommendedActions: ['Remove some images to stay within the 10-image limit'],
          statusCode: 400,
        });
      }
    }
  }

  /**
   * Map a database row to a ManualRequest object.
   */
  private mapRow(row: Record<string, unknown>): ManualRequest {
    let mediaItemIds: string[] = [];
    try {
      const raw = row.media_item_ids_json as string;
      mediaItemIds = raw ? JSON.parse(raw) : [];
    } catch {
      mediaItemIds = [];
    }

    return {
      id: row.id as string,
      userId: row.user_id as string,
      customerName: row.customer_name as string,
      customerPhone: (row.customer_phone as string) || null,
      customerEmail: (row.customer_email as string) || null,
      customerAddress: (row.customer_address as string) || null,
      serviceDescription: row.service_description as string,
      mediaItemIds,
      requestSource: (row.request_source as 'manual' | 'jobber') ?? 'manual',
      createdAt: new Date(row.created_at as string),
    };
  }

  /**
   * Map a database row (from list()) to a ManualRequestListRow, preserving
   * the extra age_seconds and quote_sent_at columns returned by the list query.
   */
  private mapListRow(row: Record<string, unknown>): ManualRequestListRow {
    const base = this.mapRow(row);
    return {
      ...base,
      ageSeconds: Number(row.age_seconds),
      ...(row.quote_sent_at !== undefined ? { quoteSentAt: (row.quote_sent_at as string) || null } : {}),
      ...(row.jobber_request_id !== undefined ? { jobberRequestId: (row.jobber_request_id as string) || null } : {}),
    };
  }
}
