import { Hono } from 'hono';
import type { Bindings } from '../bindings.js';
import type { User, ProductCatalogEntry, QuoteTemplate, JobberCustomerRequest, SimilarQuote, StructuredRule, RuleCondition, RuleAction, TriggerMode, ActionItem, CreateManualRequestPayload, UpdateProductivityRatePayload, DepositSchedule, DraftEmailContextResponse } from 'shared';
import { extractCustomerEmailFromRequestBody, splitEmailContextFromCustomerText, parseEmailMessages } from 'shared';
import { sessionMiddleware } from '../middleware/session.js';
import { PlatformError } from '../errors/index.js';
import { JobberWebSession } from '../services/jobber-web-session.js';
import {
  QuoteEngine,
  JobberIntegration,
  QuoteDraftService,
  ActivityLogService,
  RulesService,
  RevisionEngine,
  EmbeddingService,
  SimilarityEngine,
  QuoteSyncService,
  JobberQuotePushService,
  ManualRequestService,
  QuantityEngine,
  ProductivityRatesService,
  UserSettingsService,
  EmailContextService,
  resolveJobberRequestForGenerate,
  enrichJobberRequest,
  enrichSparseQueueRows,
  loadBestWebhookRow,
} from '../services/index.js';
import { JobberWebhookService } from '../services/jobber-webhook-service.js';
import { JobberTokenStore } from '../services/jobber-token-store.js';
import { RulesSyncService } from '../services/rules-sync.js';
import { JobberQuoteImportService } from '../services/jobber-quote-importer.js';
import { buildJobberImportCustomerContext } from '../services/jobber-import-context.js';
import type { ImportableQuote } from '../services/jobber-quote-importer.js';
import { resolveRequestQuote, fetchJobberQuotesForRequests } from '../services/request-quote-resolve-service.js';
import { invalidateDeathclockCache, invalidateTrendsCache } from './dashboard.js';
import { computeDeathclock } from '../services/deathclock-service.js';

function createRulesSync(env: Bindings): RulesSyncService {
  const isLocal = env.ENABLE_LOCAL_SYNC === 'true';
  return new RulesSyncService({
    accountId: env.CLOUDFLARE_ACCOUNT_ID || '',
    apiToken: env.CLOUDFLARE_API_TOKEN || '',
    databaseId: env.D1_DATABASE_ID || '',
    isLocal,
  });
}

/**
 * Merge new action items with old ones, preserving `completed: true` for items
 * that match on `lineItemId` + `description`.
 */
function mergeActionItems(
  oldItems: ActionItem[],
  newItems: ActionItem[],
): ActionItem[] {
  return newItems.map(newItem => {
    const match = oldItems.find(
      old => old.lineItemId === newItem.lineItemId && old.description === newItem.description
    );
    return {
      ...newItem,
      completed: match?.completed ?? false,
    };
  });
}

const app = new Hono<{ Bindings: Bindings; Variables: { user: User } }>();

// ── Catalog sync TTL cache ──────────────────────────────────────
// Track last sync time per user to avoid syncing on every GET /catalog request.
// Resets on worker cold start, which is acceptable — first request triggers a sync.
const catalogSyncTimestamps = new Map<string, number>();
const CATALOG_SYNC_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Helper: create a JobberIntegration with D1-persisted tokens ──

async function createJobberIntegration(db: D1Database, env: Bindings): Promise<{ jobberIntegration: JobberIntegration; tokenStore: JobberTokenStore; activityLog: ActivityLogService }> {
  const activityLog = new ActivityLogService(db);
  const tokenStore = new JobberTokenStore(db);
  const jobberIntegration = new JobberIntegration(activityLog, {
    clientId: env.JOBBER_CLIENT_ID || '',
    clientSecret: env.JOBBER_CLIENT_SECRET || '',
    accessToken: env.JOBBER_ACCESS_TOKEN || '',
    refreshToken: env.JOBBER_REFRESH_TOKEN || '',
    apiUrl: env.JOBBER_API_URL || undefined,
    tokenStore,
  });
  await jobberIntegration.loadPersistedTokens();
  return { jobberIntegration, tokenStore, activityLog };
}

app.use('*', sessionMiddleware);

// ── Rules CRUD endpoints ──────────────────────────────────────

/**
 * GET /rules/extraction-presets
 * Return available extraction presets for context-aware quantity rules.
 */
app.get('/rules/extraction-presets', async (c) => {
  const { getExtractionPresets } = await import('../services/extraction-presets.js');
  const presets = getExtractionPresets();
  return c.json({ presets });
});

/**
 * GET /rules
 * List all rule groups with their nested rules.
 */
app.get('/rules', async (c) => {
  const rulesService = new RulesService(c.env.DB);
  const groups = await rulesService.getAllGroupedRules();
  return c.json(groups);
});

/**
 * POST /rules
 * Create a new rule.
 */
app.post('/rules', async (c) => {
  const db = c.env.DB;
  const rulesService = new RulesService(db);
  const { name, description, ruleGroupId, isActive, conditionJson, actionJson, triggerMode } = await c.req.json() as {
    name?: string;
    description?: string;
    ruleGroupId?: string;
    isActive?: boolean;
    conditionJson?: RuleCondition;
    actionJson?: RuleAction[];
    triggerMode?: TriggerMode;
  };

  // Fetch catalog names for AI-powered structured rule generation
  let catalogNames: string[] = [];
  if (!conditionJson && !actionJson) {
    try {
      const userId = c.get('user').id;
      const catalogResult = await db.prepare(
        'SELECT name FROM product_catalog WHERE user_id = ? ORDER BY name ASC'
      ).bind(userId).all();
      catalogNames = (catalogResult.results as Array<{ name: string }>).map(r => r.name);
    } catch { /* graceful degradation */ }
  }

  const rule = await rulesService.createRule({
    name: name ?? '',
    description: description ?? '',
    ruleGroupId: ruleGroupId ?? undefined,
    isActive,
    conditionJson,
    actionJson,
    triggerMode,
    catalogNames: catalogNames.length > 0 ? catalogNames : undefined,
    apiKey: c.env.AI_TEXT_API_KEY,
    apiUrl: c.env.AI_TEXT_API_URL,
  });

  // Fire-and-forget: sync to remote D1
  const sync = createRulesSync(c.env);
  if (sync.canSync()) {
    const groupRow = await db.prepare(
      'SELECT id, name, description, display_order, created_at FROM rule_groups WHERE id = ?'
    ).bind(rule.ruleGroupId).first() as { id: string; name: string; description: string | null; display_order: number; created_at: string } | null;
    const group = groupRow ? { id: groupRow.id, name: groupRow.name, description: groupRow.description, displayOrder: groupRow.display_order, createdAt: new Date(groupRow.created_at) } : undefined;
    sync.pushRule(rule, group).catch(() => {});
  }

  return c.json(rule, 201);
});

/**
 * PUT /rules/:id
 * Update an existing rule.
 */
app.put('/rules/:id', async (c) => {
  const rulesService = new RulesService(c.env.DB);
  const { name, description, ruleGroupId, isActive, conditionJson, actionJson, triggerMode } = await c.req.json() as {
    name?: string;
    description?: string;
    ruleGroupId?: string;
    isActive?: boolean;
    conditionJson?: RuleCondition | null;
    actionJson?: RuleAction[] | null;
    triggerMode?: TriggerMode;
  };
  const rule = await rulesService.updateRule(c.req.param('id'), {
    name,
    description,
    ruleGroupId,
    isActive,
    conditionJson,
    actionJson,
    triggerMode,
  });

  // Fire-and-forget: sync to remote D1
  const sync = createRulesSync(c.env);
  if (sync.canSync()) {
    const groupRow = await c.env.DB.prepare(
      'SELECT id, name, description, display_order, created_at FROM rule_groups WHERE id = ?'
    ).bind(rule.ruleGroupId).first() as { id: string; name: string; description: string | null; display_order: number; created_at: string } | null;
    const group = groupRow ? { id: groupRow.id, name: groupRow.name, description: groupRow.description, displayOrder: groupRow.display_order, createdAt: new Date(groupRow.created_at) } : undefined;
    sync.pushRule(rule, group).catch(() => {});
  }

  return c.json(rule);
});

/**
 * PUT /rules/:id/deactivate
 * Deactivate a rule (soft delete).
 */
app.put('/rules/:id/deactivate', async (c) => {
  const rulesService = new RulesService(c.env.DB);
  const rule = await rulesService.deactivateRule(c.req.param('id'));

  // Fire-and-forget: sync to remote D1
  const sync = createRulesSync(c.env);
  if (sync.canSync()) {
    const groupRow = await c.env.DB.prepare(
      'SELECT id, name, description, display_order, created_at FROM rule_groups WHERE id = ?'
    ).bind(rule.ruleGroupId).first() as { id: string; name: string; description: string | null; display_order: number; created_at: string } | null;
    const group = groupRow ? { id: groupRow.id, name: groupRow.name, description: groupRow.description, displayOrder: groupRow.display_order, createdAt: new Date(groupRow.created_at) } : undefined;
    sync.pushRule(rule, group).catch(() => {});
  }

  return c.json(rule);
});

/**
 * POST /rules/groups
 * Create a new rule group.
 */
app.post('/rules/groups', async (c) => {
  const rulesService = new RulesService(c.env.DB);
  const { name, description } = await c.req.json() as { name?: string; description?: string };
  const group = await rulesService.createGroup({
    name: name ?? '',
    description,
  });
  return c.json(group, 201);
});

/**
 * PUT /rules/groups/:id
 * Update an existing rule group.
 */
app.put('/rules/groups/:id', async (c) => {
  const rulesService = new RulesService(c.env.DB);
  const { name, description, displayOrder } = await c.req.json() as {
    name?: string;
    description?: string;
    displayOrder?: number;
  };
  const group = await rulesService.updateGroup(c.req.param('id'), {
    name,
    description,
    displayOrder,
  });
  return c.json(group);
});

/**
 * DELETE /rules/groups/:id
 * Delete a rule group (reassigns its rules to the "General" group).
 */
app.delete('/rules/groups/:id', async (c) => {
  const rulesService = new RulesService(c.env.DB);
  await rulesService.deleteGroup(c.req.param('id'));
  return c.json({ success: true });
});

/**
 * POST /rules/summarize-title
 * Generate an AI-summarized title for a rule description.
 */
app.post('/rules/summarize-title', async (c) => {
  const rulesService = new RulesService(c.env.DB);
  const { description } = await c.req.json() as { description?: string };
  if (!description || description.trim() === '') {
    return c.json({ title: '' }, 400);
  }
  const title = await rulesService.summarizeRuleTitle(
    description.trim(),
    c.env.AI_TEXT_API_KEY,
    c.env.AI_TEXT_API_URL,
  );
  return c.json({ title });
});

/**
 * POST /rules/regenerate-titles
 * Regenerate AI-summarized titles for all rules with truncated names.
 */
app.post('/rules/regenerate-titles', async (c) => {
  const rulesService = new RulesService(c.env.DB);
  const result = await rulesService.regenerateAllTitles(
    c.env.AI_TEXT_API_KEY,
    c.env.AI_TEXT_API_URL,
  );
  return c.json(result);
});

/**
 * POST /rules/auto-categorize
 * Auto-categorize rules into trade-based groups by matching descriptions
 * against known trade keywords.
 */
app.post('/rules/auto-categorize', async (c) => {
  const rulesService = new RulesService(c.env.DB);
  const result = await rulesService.autoCategorizeRules();
  return c.json(result);
});

// ── Manual Request endpoints ──────────────────────────────────

/**
 * GET /manual-requests
 * List manual requests for the authenticated user.
 *
 * Query params:
 *   ?include_deathclock=true — embed a {@link DeathclockState} object in each item
 *   ?sort_by=age_asc         — sort by age, oldest first
 *   ?sort_by=age_desc        — sort by age, newest first
 */
app.get('/manual-requests', async (c) => {
  const userId = c.get('user').id;
  const db = c.env.DB;

  const includeDeathclock = c.req.query('include_deathclock') === 'true';
  const sortBy = c.req.query('sort_by') as 'age_asc' | 'age_desc' | undefined;

  if (sortBy && sortBy !== 'age_asc' && sortBy !== 'age_desc') {
    return c.json({ error: "sort_by must be 'age_asc' or 'age_desc'" }, 400);
  }

  const manualRequestService = new ManualRequestService(db);
  let rows = await manualRequestService.list({ userId, sortBy, includeDeathclock });

  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil((async () => {
      try {
        const { jobberIntegration } = await createJobberIntegration(db, c.env);
        await enrichSparseQueueRows(db, rows, jobberIntegration, 3, 2_000);
      } catch {
        // Best-effort background enrichment — never block the queue list
      }
    })());
  }

  if (includeDeathclock) {
    const items = rows.map(row => ({
      ...row,
      // Use the SQL-computed ageSeconds from the list query rather than
      // re-computing from createdAt, which would produce a slightly different
      // value (SQL NOW() vs JS Date() — different moments of evaluation).
      deathclock: computeDeathclock(row.createdAt, row.quoteSentAt, row.ageSeconds),
    }));
    return c.json({ requests: items });
  }

  return c.json({ requests: rows });
});

/**
 * POST /manual-requests/enrich
 * Backfill sparse Jobber queue rows (names/notes) without blocking the full list.
 */
app.post('/manual-requests/enrich', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json() as { jobberRequestIds?: string[] };
  const ids = (body.jobberRequestIds ?? []).filter((id) => typeof id === 'string' && id.trim()).slice(0, 10);
  if (ids.length === 0) {
    return c.json({ enriched: [] });
  }

  const { jobberIntegration } = await createJobberIntegration(db, c.env);
  const enriched: Array<{
    jobberRequestId: string;
    customerName: string;
    requestTitle: string | null;
    requestBodyText: string;
    noteHighlights: Array<{ label: string; message: string }>;
    serviceDescription: string;
  }> = [];

  await Promise.allSettled(ids.map(async (jobberRequestId) => {
    try {
      const result = await Promise.race([
        enrichJobberRequest(db, jobberRequestId, jobberIntegration),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 6_000)),
      ]);
      if (!result) return;
      enriched.push({
        jobberRequestId,
        customerName: result.resolved.customerName,
        requestTitle: result.resolved.requestTitle,
        requestBodyText: result.resolved.requestBodyText,
        noteHighlights: result.resolved.noteHighlights,
        serviceDescription: result.resolved.serviceDescription,
      });
    } catch {
      // Skip failed row
    }
  }));

  return c.json({ enriched });
});

/**
 * POST /manual-requests/resolve-quote
 * Resolve whether to import a Jobber quote, open a Cotiza draft, or generate new.
 */
app.post('/manual-requests/resolve-quote', async (c) => {
  const userId = c.get('user').id;
  const db = c.env.DB;
  const body = await c.req.json() as { jobberRequestId?: string };
  const jobberRequestId = body.jobberRequestId?.trim();

  if (!jobberRequestId) {
    throw new PlatformError({
      severity: 'error',
      component: 'QuoteRoutes',
      operation: 'resolveRequestQuote',
      description: 'jobberRequestId is required.',
      recommendedActions: ['Provide a valid Jobber request ID.'],
      statusCode: 400,
    });
  }

  const { jobberIntegration, activityLog } = await createJobberIntegration(db, c.env);
  const quoteDraftService = new QuoteDraftService(db);
  const importer = new JobberQuoteImportService(db, quoteDraftService, jobberIntegration, activityLog);
  const fetchRequestQuotes = (id: string) => importer.fetchQuotesForRequest(id);

  const result = await resolveRequestQuote(db, userId, jobberRequestId, fetchRequestQuotes);

  const cotizaDraft = result.cotizaDraft
    ? {
        id: result.cotizaDraft.id,
        draftNumber: result.cotizaDraft.draftNumber,
        jobberQuoteId: result.cotizaDraft.jobberQuoteId,
      }
    : null;

  return c.json({
    jobberQuotes: result.jobberQuotes,
    cotizaDraft,
    recommendedAction: result.recommendedAction,
    ...(result.jobberLookupFailed ? { jobberLookupFailed: true } : {}),
  });
});

/**
 * POST /manual-requests/jobber-quotes
 * Batch fetch active Jobber quotes for queue card badges (max 10 IDs).
 */
app.post('/manual-requests/jobber-quotes', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json() as { jobberRequestIds?: string[] };
  const ids = (body.jobberRequestIds ?? [])
    .filter((id) => typeof id === 'string' && id.trim())
    .slice(0, 10);

  if (ids.length === 0) {
    return c.json({ quotesByRequest: {} });
  }

  const { jobberIntegration, activityLog } = await createJobberIntegration(db, c.env);
  const quoteDraftService = new QuoteDraftService(db);
  const importer = new JobberQuoteImportService(db, quoteDraftService, jobberIntegration, activityLog);
  const fetchRequestQuotes = (id: string) => importer.fetchQuotesForRequest(id);

  const quotesByRequest = await fetchJobberQuotesForRequests(ids, fetchRequestQuotes);
  return c.json({ quotesByRequest });
});

/**
 * POST /manual-requests
 * Create a manual customer request.
 */
app.post('/manual-requests', async (c) => {
  const userId = c.get('user').id;
  const db = c.env.DB;
  const body = await c.req.json() as CreateManualRequestPayload;

  const manualRequestService = new ManualRequestService(db);
  const manualRequest = await manualRequestService.create(userId, body);
  return c.json(manualRequest, 201);
});

/**
 * GET /manual-requests/:id
 * Get a manual request by ID, scoped to authenticated user.
 */
app.get('/manual-requests/:id', async (c) => {
  const userId = c.get('user').id;
  const db = c.env.DB;

  const manualRequestService = new ManualRequestService(db);
  const manualRequest = await manualRequestService.getById(c.req.param('id'), userId);
  return c.json(manualRequest);
});

/**
 * GET /manual-requests/:id/deathclock
 * Get live deathclock state for a single manual request.
 *
 * Fetches the request (returns 404 if not found), retrieves quote_sent_at
 * from the earliest sent quote draft (if any), and returns the computed
 * DeathclockState. When a quote has been sent the clock freezes at that
 * point in time (isComplete=true, frozen=true); otherwise the clock ticks
 * live from the request's created_at timestamp.
 */
app.get('/manual-requests/:id/deathclock', async (c) => {
  const userId = c.get('user').id;
  const db = c.env.DB;
  const requestId = c.req.param('id');

  const manualRequestService = new ManualRequestService(db);

  // Resolves the request; throws 404 via PlatformError if not found
  const manualRequest = await manualRequestService.getById(requestId, userId);

  // Fetch quote_sent_at, first_draft_created_at, and request_to_quote_seconds from quote drafts
  const quoteRow = await db.prepare(
    `SELECT MIN(quote_sent_at) AS quote_sent_at,
            MAX(quote_sent_at) AS last_quote_sent_at,
            MIN(first_draft_created_at) AS first_draft_created_at,
            MIN(request_to_quote_seconds) AS request_to_quote_seconds
       FROM quote_drafts
      WHERE manual_request_id = ?`
  ).bind(requestId).first<{ quote_sent_at: string | null; last_quote_sent_at: string | null; first_draft_created_at: string | null; request_to_quote_seconds: number | null }>();

  const quoteSentAt = quoteRow?.quote_sent_at ?? null;
  const lastQuoteSentAt = quoteRow?.last_quote_sent_at ?? null;
  const firstDraftCreatedAt = quoteRow?.first_draft_created_at ?? null;
  const requestToQuoteSeconds = quoteRow?.request_to_quote_seconds ?? undefined;

  const deathclock = computeDeathclock(manualRequest.createdAt, quoteSentAt);

  // Compute creation lag and send lag from the raw timestamps
  const requestCreatedAt = new Date(manualRequest.createdAt).getTime();
  let quoteCreationLagSeconds: number | undefined;
  let sendLagSeconds: number | undefined;

  if (firstDraftCreatedAt) {
    quoteCreationLagSeconds = Math.floor(
      (new Date(firstDraftCreatedAt).getTime() - requestCreatedAt) / 1000,
    );
    if (quoteSentAt) {
      sendLagSeconds = Math.floor(
        (new Date(quoteSentAt).getTime() - new Date(firstDraftCreatedAt).getTime()) / 1000,
      );
    }
  }

  // Fetch QuoteSendEvents for this request
  const sendEventRows = await db.prepare(
    `SELECT id, quote_id, request_id, sent_at, elapsed_seconds_from_request, send_type
       FROM quote_send_events
      WHERE request_id = ?
      ORDER BY sent_at ASC`
  ).bind(requestId).all<{ id: number; quote_id: string; request_id: string; sent_at: string; elapsed_seconds_from_request: number; send_type: string }>();

  const sendEvents = sendEventRows.results?.map((row) => ({
    id: row.id,
    quoteId: row.quote_id,
    requestId: row.request_id,
    sentAt: row.sent_at,
    elapsedSecondsFromRequest: row.elapsed_seconds_from_request,
    sendType: row.send_type as 'first' | 'resend',
  })) ?? [];

  // Fetch sibling quotes — all quote drafts belonging to this request
  const siblingRows = await db.prepare(
    `SELECT id, draft_number, quote_sent_at, first_draft_created_at, request_to_quote_seconds
       FROM quote_drafts
      WHERE manual_request_id = ?
      ORDER BY created_at ASC`
  ).bind(requestId).all<{ id: string; draft_number: number; quote_sent_at: string | null; first_draft_created_at: string | null; request_to_quote_seconds: number | null }>();

  const siblingQuotes = siblingRows.results?.map((row) => ({
    id: row.id,
    draftNumber: row.draft_number,
    quoteSentAt: row.quote_sent_at,
    firstDraftCreatedAt: row.first_draft_created_at,
    requestToQuoteSeconds: row.request_to_quote_seconds,
  })) ?? [];

  return c.json({ ...deathclock, quoteCreationLagSeconds, sendLagSeconds, requestToQuoteSeconds, lastQuoteSentAt, sendEvents, siblingQuotes });
});

/**
 * POST /requests/:id/mark-sent
 * Mark a manual request's quote as sent (for manual/offline sends).
 *
 * This endpoint is used when a quote is sent to the customer outside of the
 * app (e.g., email, in-person). It records the send event for deathclock
 * analytics and freezes the deathclock timer.
 *
 * NOTE: quote_sent_at is set on ALL quote drafts linked to this request,
 * not a single specific draft. The semantic meaning is "a quote for this
 * request was sent," not "this specific draft was sent." All drafts for the
 * same request share the same quote_sent_at timestamp.
 *
 * Body (optional):
 *   { "sentAt": "2025-06-01T12:00:00Z" }  — ISO 8601 UTC timestamp.
 *     Defaults to datetime('now') if omitted.
 *
 * Returns the updated manual request with the send event details.
 */
app.post('/requests/:id/mark-sent', async (c) => {
  const userId = c.get('user').id;
  const db = c.env.DB;
  const requestId = c.req.param('id');

  // Parse optional body — graceful if empty or not JSON
  let sentAt: string | undefined;
  try {
    const body = await c.req.json<{ sentAt?: string }>();
    sentAt = body?.sentAt;
  } catch {
    // No body provided — will default to now
  }

  // Resolve the manual request (throws 404 if not found)
  const manualRequestService = new ManualRequestService(db);
  const manualRequest = await manualRequestService.getById(requestId, userId);

  // Use provided timestamp or default to SQLite datetime('now')
  const nowIso = sentAt
    ? sentAt
    : new Date().toISOString();

  // Set quote_sent_at on all quote drafts linked to this manual request
  await db.prepare(
    `UPDATE quote_drafts
        SET quote_sent_at = ?,
            last_quote_sent_at = ?
      WHERE manual_request_id = ?`
  ).bind(nowIso, nowIso, requestId).run();

  // Compute elapsed seconds from request creation to sent time
  const createdAt = manualRequest.createdAt instanceof Date
    ? manualRequest.createdAt
    : new Date(manualRequest.createdAt);
  const sentDate = new Date(nowIso);
  const elapsedSeconds = Math.floor((sentDate.getTime() - createdAt.getTime()) / 1000);

  // Also update request_to_quote_seconds on drafts where not already set
  await db.prepare(
    `UPDATE quote_drafts
        SET request_to_quote_seconds = ?
      WHERE manual_request_id = ?
        AND request_to_quote_seconds IS NULL`
  ).bind(elapsedSeconds, requestId).run();

  // Fetch the IDs of all quote drafts linked to this request
  const draftRows = await db.prepare(
    `SELECT id FROM quote_drafts WHERE manual_request_id = ?`
  ).bind(requestId).all<{ id: string }>();

  // Create a QuoteSendEvent for each associated draft
  if (draftRows.results && draftRows.results.length > 0) {
    const insertStmt = db.prepare(
      `INSERT INTO quote_send_events (quote_id, request_id, sent_at, elapsed_seconds_from_request, send_type)
       VALUES (?, ?, ?, ?, 'first')`
    );

    for (const row of draftRows.results) {
      // Use INSERT OR IGNORE to gracefully handle the unique constraint
      // on uq_quote_send_events_first_send (prevents double-counting).
      const insertOrIgnoreStmt = db.prepare(
        `INSERT OR IGNORE INTO quote_send_events (quote_id, request_id, sent_at, elapsed_seconds_from_request, send_type)
         VALUES (?, ?, ?, ?, 'first')`
      );
      await insertOrIgnoreStmt.bind(row.id, requestId, nowIso, elapsedSeconds).run();
    }
  }

  // Invalidate deathclock and trends caches for this user
  invalidateDeathclockCache(userId);
  invalidateTrendsCache(userId);

  // Return the updated request data
  return c.json({
    ...manualRequest,
    quoteSentAt: nowIso,
    elapsedSecondsFromRequest: elapsedSeconds,
  });
});

// ── Helper functions ──────────────────────────────────────────

/**
 * Fetch the unified product catalog from the product_catalog table.
 */
async function fetchCatalog(db: D1Database, userId: string): Promise<ProductCatalogEntry[]> {
  const result = await db.prepare(
    'SELECT id, name, unit_price, description, category, sort_order, keywords, scope, source, quantity_mode, default_hours FROM product_catalog WHERE user_id = ? ORDER BY sort_order ASC, name ASC'
  ).bind(userId).all();

  return (result.results as any[]).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    unitPrice: Number(row.unit_price),
    description: (row.description as string) ?? '',
    category: (row.category as string) ?? undefined,
    sortOrder: Number(row.sort_order ?? 500),
    keywords: (row.keywords as string) ?? undefined,
    scope: (row.scope as import('shared').Scope) ?? null,
    source: (row.source as 'jobber' | 'manual') ?? 'manual',
    quantityMode: (row.quantity_mode as import('shared').QuantityMode) ?? null,
    defaultHours: row.default_hours != null ? Number(row.default_hours) : null,
  }));
}

async function fetchManualTemplates(db: D1Database, userId: string): Promise<QuoteTemplate[]> {
  const result = await db.prepare(
    'SELECT id, name, content, category, line_items_json FROM manual_templates WHERE user_id = ? ORDER BY created_at ASC'
  ).bind(userId).all();

  return (result.results as any[]).map((row) => {
    let lineItems: QuoteTemplate['lineItems'] = [];
    try {
      const parsed = JSON.parse((row.line_items_json as string) || '[]');
      if (Array.isArray(parsed)) lineItems = parsed;
    } catch { /* ignore parse errors */ }

    return {
      id: row.id as string,
      name: row.name as string,
      content: row.content as string,
      category: (row.category as string) ?? undefined,
      lineItems,
      source: 'manual' as const,
    };
  });
}

/**
 * POST /generate
 * Submit a customer request and generate a quote draft.
 */
app.post('/generate', async (c) => {
  const userId = c.get('user').id;
  const db = c.env.DB;
  const body = await c.req.json() as {
    customerText?: string;
    mediaItemIds?: string[];
    manualCatalog?: ProductCatalogEntry[];
    manualTemplates?: QuoteTemplate[];
    jobberRequestId?: string;
    manualRequestId?: string;
  };

  // Validate that the request has enough input to generate a quote.
  // Trim string inputs so whitespace-only values don't bypass validation.
  // Allow through if jobberRequestId is provided — Jobber image URLs will be
  // fetched during enrichment and may be the sole image source.
  const trimmedCustomerTextForValidation = (body.customerText ?? '').trim();
  const trimmedJobberRequestId = (body.jobberRequestId ?? '').trim();
  const trimmedManualRequestId = (body.manualRequestId ?? '').trim();
  if (trimmedJobberRequestId) {
    body.jobberRequestId = trimmedJobberRequestId;
  } else {
    body.jobberRequestId = undefined;
  }
  if (trimmedManualRequestId) {
    body.manualRequestId = trimmedManualRequestId;
  } else {
    body.manualRequestId = undefined;
  }
  if (!trimmedCustomerTextForValidation && (!body.mediaItemIds || body.mediaItemIds.length === 0) && !trimmedJobberRequestId && !trimmedManualRequestId) {
    throw new PlatformError({
      severity: 'error',
      component: 'QuoteRoutes',
      operation: 'generate',
      description: 'Please provide customer request text or at least one image.',
      recommendedActions: ['Enter customer text or upload images'],
    });
  }

  const quoteEngine = new QuoteEngine(c.env.AI_TEXT_API_KEY, c.env.AI_TEXT_API_URL, new QuantityEngine(db), c.env.R2_BUCKET, db);
  const quoteDraftService = new QuoteDraftService(db);

  // Unified catalog: always read from product_catalog (manualCatalog override still supported)
  const catalog: ProductCatalogEntry[] = body.manualCatalog ?? await fetchCatalog(db, userId);
  // Templates always come from D1 — Jobber's public API does not expose quote templates
  const templates: QuoteTemplate[] = body.manualTemplates ?? await fetchManualTemplates(db, userId);

  // Fetch structured rules for the deterministic rules engine (graceful degradation)
  const rulesService = new RulesService(db);
  let structuredRules: StructuredRule[] = [];
  try {
    structuredRules = await rulesService.getActiveStructuredRules();
  } catch {
    structuredRules = [];
  }

  // Fetch manual request once and cache for reuse across address/email/clientName
  let cachedManualRequest: any = null;
  let manualRequestAddress: string | null = null;
  if (body.manualRequestId) {
    try {
      const manualRequestService = new ManualRequestService(db);
      cachedManualRequest = await manualRequestService.getById(body.manualRequestId, userId);
      manualRequestAddress = (cachedManualRequest as any).customerAddress ?? null;
      if (!(body.customerText ?? '').trim()) {
        body.customerText = (cachedManualRequest as any).serviceDescription ?? '';
      }
    } catch {
      // Graceful degradation
    }
  }

  // Fetch user settings to check material price mode (graceful degradation)
  let materialPriceMode = false;
  try {
    const userSettingsService = new UserSettingsService(db);
    const userSettings = await userSettingsService.getSettings(userId);
    materialPriceMode = userSettings.materialPriceMode;
  } catch {
    // Graceful degradation — settings fetch failure must not block quote generation
  }

  // Populate customerText from Jobber request notes when not provided (queue flow).
  let resolvedJobberFields: Awaited<ReturnType<typeof resolveJobberRequestForGenerate>> = null;
  if (body.jobberRequestId && !(body.customerText ?? '').trim()) {
    try {
      const { jobberIntegration } = await createJobberIntegration(db, c.env);
      resolvedJobberFields = await resolveJobberRequestForGenerate(
        db,
        body.jobberRequestId,
        jobberIntegration,
      );
      if (resolvedJobberFields) {
        body.customerText = resolvedJobberFields.serviceDescription;
      }
    } catch {
      // Graceful degradation — missing notes must not block quote generation
    }
  }

  if (body.jobberRequestId && !(body.customerText ?? '').trim()) {
    throw new PlatformError({
      severity: 'error',
      component: 'QuoteRoutes',
      operation: 'generate',
      description: 'Could not load Jobber request details for this quote. The request may still be syncing — try again in a moment.',
      recommendedActions: ['Wait a few seconds and try again', 'Open the request in Jobber to confirm it has notes or a description'],
      statusCode: 422,
    });
  }

  // Find similar past quotes from the corpus (graceful degradation)
  let similarQuotes: SimilarQuote[] = [];
  const trimmedCustomerText = (body.customerText ?? '').trim();
  if (trimmedCustomerText) {
    try {
      const embeddingService = new EmbeddingService(c.env.AI_TEXT_API_KEY);
      const similarityEngine = new SimilarityEngine(db, embeddingService);
      const results = await similarityEngine.findSimilar(trimmedCustomerText);
      similarQuotes = results.map((sq) => ({
      jobberQuoteId: sq.jobberQuoteId,
      quoteNumber: sq.quoteNumber,
      title: sq.title,
      message: sq.message,
      similarityScore: sq.similarityScore,
    }));
    } catch {
      similarQuotes = [];
    }
  }

  // Resolve property address and Jobber image URLs for sqft pipeline (graceful degradation)
  let jobberPropertyAddress: string | null = null;
  let jobberImageUrls: string[] = [];

  if (body.jobberRequestId) {
    try {
      const jobberRow = await loadBestWebhookRow(db, body.jobberRequestId);

      if (jobberRow?.request_body) {
        const detail = JSON.parse(jobberRow.request_body as string);
        const property = detail?.property;
        if (property) {
          const parts = [
            property.street1,
            property.street2,
            property.city,
            property.province,
            property.postalCode,
          ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
          if (parts.length > 0) {
            jobberPropertyAddress = parts.join(', ');
          }
        }
      }
    } catch {
      // Graceful degradation — address resolution failure must not block quote generation
    }

    // Always fetch live from Jobber API to get fresh attachment URLs (Tier 2 vision)
    // and to fill in property address if the webhook row didn't have it (Tier 3).
    try {
      const { jobberIntegration } = await createJobberIntegration(db, c.env);
      if (jobberIntegration.isAvailable()) {
        const liveData = await jobberIntegration.graphqlRequest<Record<string, unknown>>(
          `query FetchRequestForSqft($id: EncodedId!) {
            request(id: $id) {
              noteAttachments(first: 20) { edges { node { url contentType } } }
              property {
                address { street1 street2 city province postalCode }
              }
              client {
                clientProperties(first: 1) {
                  nodes {
                    address { street1 street2 city province postalCode }
                  }
                }
              }
            }
          }`,
          { id: body.jobberRequestId },
        );

        const requestPropertyAddress = (liveData as any)?.request?.property?.address;
        const clientPropertyAddress = (liveData as any)?.request?.client?.clientProperties?.nodes?.[0]?.address;
        const liveAddress = requestPropertyAddress ?? clientPropertyAddress;
        if (liveAddress) {
          const parts = [
            liveAddress.street1,
            liveAddress.street2,
            liveAddress.city,
            liveAddress.province,
            liveAddress.postalCode,
          ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
          if (parts.length > 0) {
            jobberPropertyAddress = parts.join(', ');
            try {
              const existingRow = await loadBestWebhookRow(db, body.jobberRequestId);
              if (existingRow?.request_body) {
                const parsed = JSON.parse(existingRow.request_body as string);
                parsed.property = {
                  street1: liveAddress.street1 ?? null,
                  street2: liveAddress.street2 ?? null,
                  city: liveAddress.city ?? null,
                  province: liveAddress.province ?? null,
                  postalCode: liveAddress.postalCode ?? null,
                };
                await db.prepare(
                  `UPDATE jobber_webhook_requests SET request_body = ? WHERE id = ?`
                ).bind(JSON.stringify(parsed), existingRow.id as string).run();
              }
            } catch {
              // Enrichment write failure must not block generation
            }
          }
        }

        const attachmentEdges = (liveData as any)?.request?.noteAttachments?.edges ?? [];
        jobberImageUrls = attachmentEdges
          .filter((e: any) => e.node?.contentType?.startsWith('image/'))
          .map((e: any) => e.node.url as string);
      }
    } catch {
      // Graceful degradation — live fetch failure must not block quote generation
    }
  }

  // Email context enrichment: fetch recent Gmail conversations with the customer (graceful degradation)
  let emailContext = '';
  try {
    let customerEmail: string | null = null;
    if (body.jobberRequestId) {
      const jobberRow = await loadBestWebhookRow(db, body.jobberRequestId);
      if (jobberRow?.request_body) {
        customerEmail = extractCustomerEmailFromRequestBody(jobberRow.request_body);
      }
    } else if (body.manualRequestId && cachedManualRequest) {
      customerEmail = (cachedManualRequest as any).customerEmail ?? null;
    }

    if (customerEmail) {
      const emailService = new EmailContextService(
        c.env.GMAIL_CLIENT_ID,
        c.env.GMAIL_CLIENT_SECRET,
        c.env.GMAIL_REFRESH_TOKEN,
      );
      if (emailService.isAvailable()) {
        const enrichmentStarted = Date.now();
        emailContext = await Promise.race<string>([
          emailService.fetchContext(customerEmail),
          new Promise<string>((resolve) => setTimeout(() => resolve(''), 6000)),
        ]);
        if (emailContext) {
          body.customerText = emailContext + '\n\n' + (body.customerText ?? '');
        } else {
          console.warn(
            '[quotes/generate] Email enrichment empty after',
            Date.now() - enrichmentStarted,
            'ms',
          );
        }
      } else {
        console.warn('[quotes/generate] Gmail credentials not configured — skipping email enrichment');
      }
    }
  } catch {
    // Graceful degradation — email context failure must not block quote generation
  }

  const result = await quoteEngine.generateQuote(
    {
      customerText: body.customerText ?? '',
      mediaItemIds: body.mediaItemIds ?? [],
      jobberImageUrls,
      userId,
      manualCatalog: catalog,
      manualTemplates: templates,
      similarQuotes,
      jobberPropertyAddress,
      manualRequestAddress,
      materialPriceMode,
    },
    catalog,
    templates,
    structuredRules,
  );

  if (body.jobberRequestId) {
    result.draft.jobberRequestId = body.jobberRequestId;
    if (!result.draft.clientName && resolvedJobberFields) {
      result.draft.clientName = resolvedJobberFields.customerName !== 'Unknown'
        ? resolvedJobberFields.customerName
        : null;
    } else if (!result.draft.clientName) {
      try {
        const { jobberIntegration } = await createJobberIntegration(db, c.env);
        const resolved = await resolveJobberRequestForGenerate(
          db,
          body.jobberRequestId,
          jobberIntegration,
        );
        if (resolved) {
          result.draft.clientName = resolved.customerName !== 'Unknown' ? resolved.customerName : null;
        }
      } catch {
        // Graceful degradation
      }
    }
  }

  if (body.manualRequestId) {
    result.draft.manualRequestId = body.manualRequestId;
    // Populate clientName from the cached manual request
    if (cachedManualRequest) {
      result.draft.clientName = (cachedManualRequest as any).customerName ?? null;
    }
  }

  const saved = await quoteDraftService.save(result.draft);
  return c.json(saved, 201);
});

/**
 * GET /drafts
 * List saved quote drafts for the authenticated user.
 */
app.get('/drafts', async (c) => {
  const quoteDraftService = new QuoteDraftService(c.env.DB);
  const drafts = await quoteDraftService.list(c.get('user').id);
  return c.json({ drafts });
});

/**
 * GET /drafts/:id
 * Get a single quote draft by ID.
 * Supports ?reviewAccess=true for review workflows (bypasses user-ownership check).
 */
app.get('/drafts/:id', async (c) => {
  const quoteDraftService = new QuoteDraftService(c.env.DB);
  const id = c.req.param('id');
  const reviewAccess = c.req.query('reviewAccess') === 'true';
  const draft = reviewAccess
    ? await quoteDraftService.getByIdForReview(id)
    : await quoteDraftService.getById(id, c.get('user').id);
  return c.json(draft);
});

/**
 * GET /drafts/:id/email-context
 * Fetch Gmail conversation history for the draft's customer (lazy load + optional persist).
 */
app.get('/drafts/:id/email-context', async (c) => {
  const userId = c.get('user').id;
  const db = c.env.DB;
  const draftId = c.req.param('id');
  const quoteDraftService = new QuoteDraftService(db);
  const draft = await quoteDraftService.getById(draftId, userId);

  const { emailContext: cachedContext } = splitEmailContextFromCustomerText(draft.customerRequestText || '');
  if (cachedContext) {
    const response: DraftEmailContextResponse = {
      status: 'cached',
      customerEmail: null,
      messages: parseEmailMessages(cachedContext),
      gmailConfigured: true,
    };
    return c.json(response);
  }

  let customerEmail: string | null = null;
  if (draft.jobberRequestId) {
    let jobberRow = await loadBestWebhookRow(db, draft.jobberRequestId);
    if (jobberRow?.request_body) {
      customerEmail = extractCustomerEmailFromRequestBody(jobberRow.request_body);
    }
    if (!customerEmail) {
      try {
        const { jobberIntegration } = await createJobberIntegration(db, c.env);
        await enrichJobberRequest(db, draft.jobberRequestId, jobberIntegration);
        jobberRow = await loadBestWebhookRow(db, draft.jobberRequestId);
        if (jobberRow?.request_body) {
          customerEmail = extractCustomerEmailFromRequestBody(jobberRow.request_body);
        }
      } catch {
        // Graceful degradation
      }
    }
  } else if (draft.manualRequestId) {
    try {
      const manualRequestService = new ManualRequestService(db);
      const manualRequest = await manualRequestService.getById(draft.manualRequestId, userId);
      customerEmail = (manualRequest as { customerEmail?: string | null }).customerEmail ?? null;
    } catch {
      customerEmail = null;
    }
  }

  const emailService = new EmailContextService(
    c.env.GMAIL_CLIENT_ID,
    c.env.GMAIL_CLIENT_SECRET,
    c.env.GMAIL_REFRESH_TOKEN,
  );
  const gmailConfigured = emailService.isAvailable();

  if (!gmailConfigured) {
    const response: DraftEmailContextResponse = {
      status: 'not_configured',
      customerEmail,
      messages: [],
      gmailConfigured: false,
    };
    return c.json(response);
  }

  if (!customerEmail && draft.clientName?.trim()) {
    customerEmail = await Promise.race<string | null>([
      emailService.findCustomerEmailByName(draft.clientName.trim()),
      new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 8_000)),
    ]);
  }

  if (!customerEmail) {
    const response: DraftEmailContextResponse = {
      status: 'no_customer_email',
      customerEmail: null,
      messages: [],
      gmailConfigured: true,
    };
    return c.json(response);
  }

  const fetchedContext = await Promise.race<string>([
    emailService.fetchContext(customerEmail),
    new Promise<string>((resolve) => setTimeout(() => resolve(''), 8_000)),
  ]);

  if (!fetchedContext.trim()) {
    const response: DraftEmailContextResponse = {
      status: 'not_found',
      customerEmail,
      messages: [],
      gmailConfigured: true,
    };
    return c.json(response);
  }

  const messages = parseEmailMessages(fetchedContext);
  if (messages.length > 0) {
    await quoteDraftService.prependEmailContext(draftId, userId, fetchedContext);
  }

  const response: DraftEmailContextResponse = {
    status: 'found',
    customerEmail,
    messages,
    gmailConfigured: true,
  };
  return c.json(response);
});

/**
 * GET /drafts/:id/manual-request
 * Get the manual request associated with a draft.
 */
app.get('/drafts/:id/manual-request', async (c) => {
  const userId = c.get('user').id;
  const db = c.env.DB;

  const manualRequestService = new ManualRequestService(db);
  const manualRequest = await manualRequestService.getByDraftId(c.req.param('id'), userId);
  return c.json({ manualRequest });
});

/**
 * PUT /drafts/:id
 * Update a quote draft.
 */
app.put('/drafts/:id', async (c) => {
  const body = await c.req.json() as {
    lineItems?: any[];
    unresolvedItems?: any[];
    selectedTemplateId?: string | null;
    status?: 'draft' | 'finalized';
    actionItems?: any[];
    depositSchedule?: DepositSchedule | null;
  };

  // Validate action items if provided
  if (body.actionItems !== undefined) {
    if (!Array.isArray(body.actionItems)) {
      throw new PlatformError({
        severity: 'error',
        component: 'QuoteRoutes',
        operation: 'updateDraft',
        description: 'actionItems must be an array.',
        recommendedActions: ['Provide actionItems as an array of action item objects'],
      });
    }
    for (let i = 0; i < body.actionItems.length; i++) {
      const item = body.actionItems[i];
      if (item == null || typeof item !== 'object') {
        throw new PlatformError({
          severity: 'error',
          component: 'QuoteRoutes',
          operation: 'updateDraft',
          description: `Action item at index ${i} must be a non-null object.`,
          recommendedActions: ['Provide valid action item objects in the actionItems array'],
        });
      }
      if (typeof item.id !== 'string' || item.id.trim() === '') {
        throw new PlatformError({
          severity: 'error',
          component: 'QuoteRoutes',
          operation: 'updateDraft',
          description: `Action item at index ${i} has an invalid or missing "id". Each action item must have a non-empty string id.`,
          recommendedActions: ['Provide a non-empty string id for each action item'],
        });
      }
      if (typeof item.lineItemId !== 'string' || item.lineItemId.trim() === '') {
        throw new PlatformError({
          severity: 'error',
          component: 'QuoteRoutes',
          operation: 'updateDraft',
          description: `Action item at index ${i} has an invalid or missing "lineItemId". Each action item must have a non-empty string lineItemId.`,
          recommendedActions: ['Provide a non-empty string lineItemId for each action item'],
        });
      }
      if (typeof item.description !== 'string' || item.description.trim() === '') {
        throw new PlatformError({
          severity: 'error',
          component: 'QuoteRoutes',
          operation: 'updateDraft',
          description: `Action item at index ${i} has an invalid or missing "description". Each action item must have a non-empty string description.`,
          recommendedActions: ['Provide a non-empty string description for each action item'],
        });
      }
      if (typeof item.completed !== 'boolean') {
        throw new PlatformError({
          severity: 'error',
          component: 'QuoteRoutes',
          operation: 'updateDraft',
          description: `Action item at index ${i} has an invalid or missing "completed" field. Each action item must have a boolean completed value.`,
          recommendedActions: ['Provide a boolean completed value for each action item'],
        });
      }
    }

    // Validate lineItemIds reference actual line items in the draft
    const quoteDraftServiceForValidation = new QuoteDraftService(c.env.DB);
    const currentDraft = await quoteDraftServiceForValidation.getById(c.req.param('id'), c.get('user').id);
    const validLineItemIds = new Set([
      ...currentDraft.lineItems.map(li => li.id),
      ...currentDraft.unresolvedItems.map(li => li.id),
      // Also accept IDs from incoming lineItems if they're being updated simultaneously
      ...(body.lineItems ?? []).map((li: any) => li.id).filter(Boolean),
      ...(body.unresolvedItems ?? []).map((li: any) => li.id).filter(Boolean),
    ]);
    for (let i = 0; i < body.actionItems.length; i++) {
      const item = body.actionItems[i];
      if (!validLineItemIds.has(item.lineItemId)) {
        throw new PlatformError({
          severity: 'error',
          component: 'QuoteRoutes',
          operation: 'updateDraft',
          description: `Action item at index ${i} references lineItemId "${item.lineItemId}" which does not exist in this draft's line items.`,
          recommendedActions: ['Ensure each action item references a valid line item ID from this draft'],
        });
      }
    }
  }

  const quoteDraftService = new QuoteDraftService(c.env.DB);
  const draft = await quoteDraftService.update(c.req.param('id'), c.get('user').id, {
    lineItems: body.lineItems,
    unresolvedItems: body.unresolvedItems,
    selectedTemplateId: body.selectedTemplateId,
    status: body.status,
    actionItems: body.actionItems,
    depositSchedule: body.depositSchedule,
  });
  return c.json(draft);
});

/**
 * DELETE /drafts/:id
 * Delete a quote draft.
 */
app.delete('/drafts/:id', async (c) => {
  const quoteDraftService = new QuoteDraftService(c.env.DB);
  await quoteDraftService.delete(c.req.param('id'), c.get('user').id);
  return c.json({ success: true });
});

/**
 * PATCH /drafts/:id
 * Apply or clear a manual square footage override on a quote draft.
 * Accepts { sqftOverride: number | null } in the request body.
 */
app.patch('/drafts/:id', async (c) => {
  const userId = c.get('user').id;
  const draftId = c.req.param('id');
  const body = await c.req.json() as { sqftOverride?: number | null };

  if (!('sqftOverride' in body)) {
    throw new PlatformError({
      severity: 'error',
      component: 'QuoteRoutes',
      operation: 'patchDraft',
      description: 'Request body must include a "sqftOverride" field.',
      recommendedActions: ['Provide sqftOverride as a positive number or null to clear'],
    });
  }

  const { sqftOverride } = body;

  // Validate: must be a positive number ≤ 100,000 or null (to clear)
  if (sqftOverride !== null && sqftOverride !== undefined) {
    if (typeof sqftOverride !== 'number' || !Number.isFinite(sqftOverride)) {
      throw new PlatformError({
        severity: 'error',
        component: 'QuoteRoutes',
        operation: 'patchDraft',
        description: 'Enter a valid number for square footage.',
        recommendedActions: ['Provide a numeric value for sqftOverride'],
      });
    }
    if (sqftOverride <= 0) {
      throw new PlatformError({
        severity: 'error',
        component: 'QuoteRoutes',
        operation: 'patchDraft',
        description: 'Square footage must be a positive number.',
        recommendedActions: ['Enter a value greater than 0'],
      });
    }
    if (sqftOverride > 100_000) {
      throw new PlatformError({
        severity: 'error',
        component: 'QuoteRoutes',
        operation: 'patchDraft',
        description: 'Square footage value seems unreasonably large.',
        recommendedActions: ['Enter a value of 100,000 or less'],
      });
    }
  }

  const quoteDraftService = new QuoteDraftService(c.env.DB);
  const draft = await quoteDraftService.updateSqftResolution(draftId, userId, sqftOverride ?? null);
  return c.json(draft);
});

/**
 * POST /drafts/:id/push
 * Push a quote draft to Jobber as a real Jobber quote.
 */
app.post('/drafts/:id/push', async (c) => {
  const userId = c.get('user').id;
  const db = c.env.DB;
  const draftId = c.req.param('id');

  const quoteDraftService = new QuoteDraftService(db);
  const draft = await quoteDraftService.getById(draftId, userId);

  // Prevent duplicate pushes
  if (draft.jobberQuoteId) {
    throw new PlatformError({
      severity: 'warning',
      component: 'QuoteRoutes',
      operation: 'pushToJobber',
      description: `This draft has already been pushed to Jobber as quote ${draft.jobberQuoteNumber}.`,
      recommendedActions: ['View the existing Jobber quote'],
    });
  }

  // Block push while under review (must go through review completion)
  if (draft.reviewStatus === 'pending_review') {
    throw new PlatformError({
      severity: 'error',
      component: 'QuoteRoutes',
      operation: 'pushToJobber',
      description: 'Cannot push directly while quote is under review. Complete the review first.',
      recommendedActions: ['Use the review flow to push this quote to Jobber'],
      statusCode: 400,
    });
  }

  const { jobberIntegration } = await createJobberIntegration(db, c.env);
  const pushService = new JobberQuotePushService(db, jobberIntegration);
  const result = await pushService.pushToJobber(draft);

  // ── Deathclock: record send event ───────────────────────────────────────
  // After successful push, update the draft's sent timestamps and (if linked
  // to a manual request) insert a send event with elapsed time from request.
  await db.prepare(
    `UPDATE quote_drafts
        SET quote_sent_at = datetime('now'),
            last_quote_sent_at = datetime('now')
      WHERE id = ?`
  ).bind(draftId).run();

  if (draft.manualRequestId) {
    const sendType = (draft.status === 'finalized' || draft.jobberQuoteId) ? 'resend' : 'first';
    await db.prepare(
      `INSERT INTO quote_send_events (quote_id, request_id, sent_at, elapsed_seconds_from_request, send_type)
       VALUES (?, ?, datetime('now'),
               CAST((unixepoch('now') - unixepoch((SELECT created_at FROM manual_requests WHERE id = ?))) AS INTEGER),
               ?)`
    ).bind(draftId, draft.manualRequestId, draft.manualRequestId, sendType).run();
  }

  // Invalidate deathclock and trends caches for this user
  invalidateDeathclockCache(userId);
  invalidateTrendsCache(userId);

  return c.json(result);
});

/**
 * POST /drafts/:id/push-update
 * Push improvements to an existing Jobber quote (update, not create).
 * Requires the draft to have a jobberQuoteId (from import or previous push).
 */
app.post('/drafts/:id/push-update', async (c) => {
  const userId = c.get('user').id;
  const db = c.env.DB;
  const draftId = c.req.param('id');

  const quoteDraftService = new QuoteDraftService(db);
  const draft = await quoteDraftService.getById(draftId, userId);

  // Require an existing Jobber quote to update
  if (!draft.jobberQuoteId) {
    throw new PlatformError({
      severity: 'error',
      component: 'QuoteRoutes',
      operation: 'pushUpdateToJobber',
      description: 'This draft has no linked Jobber quote to update. Use POST /drafts/:id/push to create a new quote instead.',
      recommendedActions: ['Use push (not push-update) for drafts without a Jobber quote link'],
      statusCode: 400,
    });
  }

  // Block push-update while under review
  if (draft.reviewStatus === 'pending_review') {
    throw new PlatformError({
      severity: 'error',
      component: 'QuoteRoutes',
      operation: 'pushUpdateToJobber',
      description: 'Cannot push updates while quote is under review. Complete the review first.',
      recommendedActions: ['Use the review flow to push this quote to Jobber'],
      statusCode: 400,
    });
  }

  const { jobberIntegration } = await createJobberIntegration(db, c.env);
  const pushService = new JobberQuotePushService(db, jobberIntegration);
  const result = await pushService.pushUpdateToJobber(draft);

  // ── Deathclock: record send event ───────────────────────────────────────
  await db.prepare(
    `UPDATE quote_drafts
        SET quote_sent_at = datetime('now'),
            last_quote_sent_at = datetime('now')
      WHERE id = ?`
  ).bind(draftId).run();

  if (draft.manualRequestId) {
    const sendType = 'resend';
    await db.prepare(
      `INSERT INTO quote_send_events (quote_id, request_id, sent_at, elapsed_seconds_from_request, send_type)
       VALUES (?, ?, datetime('now'),
               CAST((unixepoch('now') - unixepoch((SELECT created_at FROM manual_requests WHERE id = ?))) AS INTEGER),
               ?)`
    ).bind(draftId, draft.manualRequestId, draft.manualRequestId, sendType).run();
  }

  invalidateDeathclockCache(userId);
  invalidateTrendsCache(userId);

  return c.json(result);
});

/**
 * POST /drafts/:id/revise
 * Submit feedback and get a revised draft.
 */
app.post('/drafts/:id/revise', async (c) => {
  const userId = c.get('user').id;
  const db = c.env.DB;
  const draftId = c.req.param('id');
  const { feedbackText, createRule: shouldCreateRule } = await c.req.json() as {
    feedbackText?: string;
    createRule?: boolean;
  };

  const trimmed = (feedbackText ?? '').trim();
  if (!trimmed) {
    throw new PlatformError({
      severity: 'error',
      component: 'QuoteRoutes',
      operation: 'revise',
      description: 'Feedback text cannot be empty.',
      recommendedActions: ['Enter feedback describing the changes you want'],
    });
  }

  const quoteDraftService = new QuoteDraftService(db);
  const revisionEngine = new RevisionEngine(c.env.AI_TEXT_API_KEY, c.env.AI_TEXT_API_URL);
  const rulesService = new RulesService(db);

  // Load the current draft (verifies ownership)
  const draft = await quoteDraftService.getById(draftId, userId);

  // Unified catalog: always read from product_catalog
  const catalog: ProductCatalogEntry[] = await fetchCatalog(db, userId);

  // Fetch structured rules for the deterministic rules engine (graceful degradation)
  let structuredRules: StructuredRule[] = [];
  try {
    structuredRules = await rulesService.getActiveStructuredRules();
  } catch {
    structuredRules = [];
  }

  // Create the rule BEFORE revision so it's included in the structured rules
  let ruleCreated: { id: string; name: string } | undefined;
  let ruleCreationError: string | undefined;
  if (shouldCreateRule) {
    try {
      const catalogNames = catalog.map(c => c.name);
      const newRule = await rulesService.createRuleFromFeedback(
        trimmed,
        c.env.AI_TEXT_API_KEY,
        c.env.AI_TEXT_API_URL,
        catalogNames,
      );
      ruleCreated = { id: newRule.id, name: newRule.name };
      // Re-fetch structured rules so the newly created rule is included
      try {
        structuredRules = await rulesService.getActiveStructuredRules();
      } catch { /* keep the previously fetched rules */ }
    } catch (ruleErr) {
      ruleCreationError = ruleErr instanceof PlatformError
        ? ruleErr.description
        : ruleErr instanceof Error
          ? ruleErr.message
          : 'Unknown error creating rule';
    }
  }

  // Revise the draft
  const revised = await revisionEngine.revise({
    feedbackText: trimmed,
    customerRequestText: draft.customerRequestText,
    currentLineItems: draft.lineItems,
    currentUnresolvedItems: draft.unresolvedItems,
    catalog,
    structuredRules,
  });

  // If the AI response couldn't be parsed, inform the user
  if (revised.revisionFailed) {
    throw new PlatformError({
      severity: 'warning',
      component: 'QuoteRoutes',
      operation: 'revise',
      description: 'The AI could not process your feedback. Your draft was not changed. Please try rephrasing your feedback.',
      recommendedActions: ['Rephrase your feedback and try again'],
    });
  }

  // Build action items from AI output by matching product names to revised line items (case-insensitive)
  const allRevisedItems = [...revised.lineItems, ...revised.unresolvedItems];
  const newActionItems: ActionItem[] = [];
  for (const aiAction of revised.actionItems ?? []) {
    if (!aiAction.lineItemProductName) continue;
    const normalizedName = aiAction.lineItemProductName.trim().toLowerCase().replace(/\s+/g, ' ');
    const matchedLineItem = allRevisedItems.find(
      (li) => li.productName.trim().toLowerCase().replace(/\s+/g, ' ') === normalizedName,
    );
    if (matchedLineItem) {
      newActionItems.push({
        id: crypto.randomUUID(),
        quoteDraftId: draftId,
        lineItemId: matchedLineItem.id,
        description: aiAction.description,
        completed: false,
      });
    }
  }

  // Merge with old action items to preserve completion status
  const oldActionItems = draft.actionItems ?? [];
  const mergedActionItems = mergeActionItems(oldActionItems, newActionItems);

  // Update the draft with revised line items and merged action items
  const updated = await quoteDraftService.update(draftId, userId, {
    lineItems: revised.lineItems,
    unresolvedItems: revised.unresolvedItems,
    actionItems: mergedActionItems,
    ...(revised.customerNote !== undefined && revised.customerNote !== null ? { customerNote: revised.customerNote } : {}),
    ...(revised.depositSchedule !== undefined ? { depositSchedule: revised.depositSchedule } : {}),
  });

  // Persist the revision history entry (after successful update)
  await quoteDraftService.addRevisionEntry(draftId, userId, trimmed);

  return c.json({
    ...updated,
    ...(ruleCreated ? { ruleCreated } : {}),
    ...(ruleCreationError ? { ruleCreationError } : {}),
    ...(revised.rulesEngineAuditTrail ? { rulesEngineAuditTrail: revised.rulesEngineAuditTrail } : {}),
  });
});

/**
 * GET /catalog
 * Get the current product catalog (from Jobber or manual entries).
 */
app.get('/catalog', async (c) => {
  const db = c.env.DB;
  const userId = c.get('user').id;
  const { jobberIntegration } = await createJobberIntegration(db, c.env);

  // Sync Jobber products into product_catalog if stale (TTL-gated)
  if (jobberIntegration.isAvailable()) {
    const lastSync = catalogSyncTimestamps.get(userId) ?? 0;
    if (Date.now() - lastSync > CATALOG_SYNC_TTL_MS) {
      try {
        await jobberIntegration.syncProductCatalog(db, userId);
        catalogSyncTimestamps.set(userId, Date.now());
      } catch {
        // Sync failure is non-blocking — continue with existing catalog data
      }
    }
  }

  // Unified catalog: always read from product_catalog after sync
  const catalog = await fetchCatalog(db, userId);
  return c.json({ catalog });
});

/**
 * POST /catalog
 * Bulk import catalog entries into the unified product_catalog.
 */
app.post('/catalog', async (c) => {
  const db = c.env.DB;
  const userId = c.get('user').id;
  const body = await c.req.json() as {
    entries: Array<{ name: string; unitPrice: number; description?: string; category?: string; keywords?: string }>;
  };

  if (!Array.isArray(body.entries) || body.entries.length === 0) {
    throw new PlatformError({
      severity: 'error',
      component: 'QuoteRoutes',
      operation: 'saveCatalog',
      description: 'Please provide at least one catalog entry.',
      recommendedActions: ['Add product entries with name and unit price'],
    });
  }

  const statements: D1PreparedStatement[] = [
    // Only delete manual-source entries so Jobber-synced products (with their
    // customised sort_order, keywords, and locally_modified_at) are preserved.
    db.prepare("DELETE FROM product_catalog WHERE user_id = ? AND source = 'manual'").bind(userId),
  ];

  for (const entry of body.entries) {
    // Sanitize keywords if provided
    let keywords: string | null = null;
    if (entry.keywords !== undefined && entry.keywords !== null) {
      if (typeof entry.keywords === 'string') {
        const trimmed = entry.keywords.trim();
        keywords = trimmed && trimmed.length <= 500 ? trimmed : null;
      }
    }

    statements.push(
      db.prepare(
        "INSERT INTO product_catalog (id, user_id, name, unit_price, description, category, keywords, source, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 500)"
      ).bind(
        crypto.randomUUID(),
        userId,
        entry.name,
        entry.unitPrice,
        entry.description ?? null,
        entry.category ?? null,
        keywords,
      ),
    );
  }

  await db.batch(statements);

  const catalog = await fetchCatalog(db, userId);
  return c.json({ catalog });
});

/**
 * PATCH /catalog/:id
 * Update a single catalog entry's name and/or description.
 */
app.patch('/catalog/:id', async (c) => {
  const db = c.env.DB;
  const userId = c.get('user').id;
  const entryId = c.req.param('id');
  const body = await c.req.json() as { name?: string; description?: string; keywords?: string | null };

  // Validate inputs
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new PlatformError({
        severity: 'error',
        component: 'QuoteRoutes',
        operation: 'updateCatalogEntry',
        description: 'Name cannot be empty.',
        recommendedActions: ['Provide a non-empty name'],
      });
    }
    body.name = body.name.trim();
    if (body.name.length > 200) {
      throw new PlatformError({
        severity: 'error',
        component: 'QuoteRoutes',
        operation: 'updateCatalogEntry',
        description: 'Name must be 200 characters or fewer.',
        recommendedActions: ['Shorten the name'],
      });
    }
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') {
      throw new PlatformError({
        severity: 'error',
        component: 'QuoteRoutes',
        operation: 'updateCatalogEntry',
        description: 'Description must be a string.',
        recommendedActions: ['Provide a valid description'],
      });
    }
    body.description = body.description.trim();
    if (body.description.length > 1000) {
      throw new PlatformError({
        severity: 'error',
        component: 'QuoteRoutes',
        operation: 'updateCatalogEntry',
        description: 'Description must be 1000 characters or fewer.',
        recommendedActions: ['Shorten the description'],
      });
    }
  }

  if (body.keywords !== undefined) {
    if (body.keywords === null) {
      // Explicit null — clear keywords (skip string validation)
    } else if (typeof body.keywords !== 'string') {
      throw new PlatformError({
        severity: 'error',
        component: 'QuoteRoutes',
        operation: 'updateCatalogEntry',
        description: 'Keywords must be a string or null.',
        recommendedActions: ['Provide comma-separated keywords or null to clear'],
      });
    } else {
      body.keywords = body.keywords.trim();
      if (body.keywords.length > 500) {
        throw new PlatformError({
          severity: 'error',
          component: 'QuoteRoutes',
          operation: 'updateCatalogEntry',
          description: 'Keywords must be 500 characters or fewer.',
          recommendedActions: ['Shorten the keywords'],
        });
      }
      // Coerce empty string to null so the DB column is cleared
      if (!body.keywords) body.keywords = null;
    }
  }

  // Verify ownership — all product_catalog entries can be updated
  const existing = await db.prepare(
    'SELECT id, source FROM product_catalog WHERE id = ? AND user_id = ?'
  ).bind(entryId, userId).first() as { id: string; source: string } | null;

  if (!existing) {
    throw new PlatformError({
      severity: 'error',
      component: 'QuoteRoutes',
      operation: 'updateCatalogEntry',
      description: 'Catalog entry not found.',
      recommendedActions: ['Verify the entry exists'],
    });
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];

  // Track whether a Jobber-owned field is being edited
  let editingJobberField = false;

  if (body.name !== undefined) {
    setClauses.push('name = ?');
    values.push(body.name);
  }
  if (body.description !== undefined) {
    setClauses.push('description = ?');
    values.push(body.description);
    editingJobberField = true;
  }
  if (body.keywords !== undefined) {
    setClauses.push('keywords = ?');
    values.push(body.keywords ?? null);
  }

  if (setClauses.length > 0) {
    // Always update updated_at
    setClauses.push("updated_at = datetime('now')");

    // Set locally_modified_at when editing Jobber-owned fields (description)
    if (editingJobberField) {
      setClauses.push("locally_modified_at = datetime('now')");
    }

    values.push(entryId, userId);
    await db.prepare(
      'UPDATE product_catalog SET ' + setClauses.join(', ') + ' WHERE id = ? AND user_id = ?'
    ).bind(...values).run();
  }

  return c.json({ success: true });
});

/**
 * PUT /catalog/reorder
 * Update the sort order of catalog entries based on the provided ordered list of IDs.
 */
app.put('/catalog/reorder', async (c) => {
  const db = c.env.DB;
  const userId = c.get('user').id;
  const { orderedIds } = await c.req.json() as { orderedIds: string[] };

  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw new PlatformError({
      severity: 'error',
      component: 'QuoteRoutes',
      operation: 'reorderCatalog',
      description: 'Please provide an ordered list of catalog entry IDs.',
      recommendedActions: ['Provide orderedIds array'],
    });
  }

  const uniqueIds = new Set(orderedIds);
  if (uniqueIds.size !== orderedIds.length) {
    throw new PlatformError({
      severity: 'error',
      component: 'QuoteRoutes',
      operation: 'reorderCatalog',
      description: 'orderedIds contains duplicate entries.',
      recommendedActions: ['Each catalog entry ID should appear exactly once'],
    });
  }

  // Fetch all current catalog entry IDs for this user
  const userEntriesResult = await db.prepare(
    'SELECT id FROM product_catalog WHERE user_id = ?'
  ).bind(userId).all();
  const userEntryIds = new Set((userEntriesResult.results as Array<{ id: string }>).map(r => r.id));

  // Validate that every ID in orderedIds belongs to the user
  const foreignIds = orderedIds.filter(id => !userEntryIds.has(id));
  if (foreignIds.length > 0) {
    throw new PlatformError({
      severity: 'error',
      component: 'QuoteRoutes',
      operation: 'reorderCatalog',
      description: `orderedIds contains IDs that do not belong to this user: ${foreignIds.join(', ')}`,
      recommendedActions: ['Only include your own catalog entry IDs'],
    });
  }

  // Validate that orderedIds contains all user entries (no missing)
  if (orderedIds.length !== userEntryIds.size) {
    throw new PlatformError({
      severity: 'error',
      component: 'QuoteRoutes',
      operation: 'reorderCatalog',
      description: `orderedIds has ${orderedIds.length} entries but user has ${userEntryIds.size}. All entries must be included.`,
      recommendedActions: ['Include all catalog entry IDs in the ordered list'],
    });
  }

  // Assign contiguous sort_order values (0, 1, 2, ...) in a single batch
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < orderedIds.length; i++) {
    statements.push(
      db.prepare(
        "UPDATE product_catalog SET sort_order = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
      ).bind(i, orderedIds[i], userId),
    );
  }

  await db.batch(statements);

  const catalog = await fetchCatalog(db, userId);
  return c.json({ catalog });
});

/**
 * GET /templates
 * Get the current template library (always from D1 manual_templates).
 * Jobber's public API does not expose quote templates.
 */
app.get('/templates', async (c) => {
  const db = c.env.DB;
  const userId = c.get('user').id;
  const templates = await fetchManualTemplates(db, userId);
  return c.json({ templates });
});

/**
 * POST /templates
 * Save manual template entries (for fallback mode).
 */
app.post('/templates', async (c) => {
  const db = c.env.DB;
  const userId = c.get('user').id;
  const body = await c.req.json() as {
    entries: Array<{ name: string; content: string; category?: string; lineItems?: Array<{ name: string; description: string; quantity: number; unitPrice: number }> }>;
  };

  if (!Array.isArray(body.entries) || body.entries.length === 0) {
    throw new PlatformError({
      severity: 'error',
      component: 'QuoteRoutes',
      operation: 'saveTemplates',
      description: 'Please provide at least one template entry.',
      recommendedActions: ['Add template entries with name and content'],
    });
  }

  // Check for duplicate names within the batch
  const nameSet = new Set<string>();
  for (const entry of body.entries) {
    if (!entry.name || typeof entry.name !== 'string' || !entry.name.trim()) {
      throw new PlatformError({
        severity: 'error',
        component: 'QuoteRoutes',
        operation: 'saveTemplates',
        description: 'Each template entry must have a non-empty name.',
        recommendedActions: ['Provide a name for every template entry'],
      });
    }
    const normalized = entry.name.trim().toLowerCase();
    if (nameSet.has(normalized)) {
      throw new PlatformError({
        severity: 'error',
        component: 'QuoteRoutes',
        operation: 'saveTemplates',
        description: `Duplicate template name: "${entry.name.trim()}".`,
        recommendedActions: ['Remove or rename duplicate template entries'],
      });
    }
    nameSet.add(normalized);
  }

  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM manual_templates WHERE user_id = ?').bind(userId),
  ];

  for (const entry of body.entries) {
    statements.push(
      db.prepare(
        "INSERT INTO manual_templates (id, user_id, name, content, category, line_items_json) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(
        crypto.randomUUID(),
        userId,
        entry.name,
        entry.content,
        entry.category ?? null,
        JSON.stringify(entry.lineItems ?? []),
      ),
    );
  }

  await db.batch(statements);

  const templates = await fetchManualTemplates(db, userId);
  return c.json({ templates });
});

/**
 * POST /templates/from-draft
 * Save a quote draft as a reusable template.
 */
app.post('/templates/from-draft', async (c) => {
  const db = c.env.DB;
  const userId = c.get('user').id;
  const body = await c.req.json() as {
    draftId: string;
    name: string;
    category?: string;
  };

  if (!body.draftId || !body.name?.trim()) {
    throw new PlatformError({
      severity: 'error',
      component: 'QuoteRoutes',
      operation: 'saveTemplateFromDraft',
      description: 'Please provide a draft ID and template name.',
      recommendedActions: ['Provide both draftId and name fields'],
    });
  }

  // Check for duplicate template name
  const existing = await db.prepare(
    'SELECT id FROM manual_templates WHERE user_id = ? AND name = ? COLLATE NOCASE'
  ).bind(userId, body.name.trim()).first();
  if (existing) {
    throw new PlatformError({
      severity: 'warning',
      component: 'QuoteRoutes',
      operation: 'saveTemplateFromDraft',
      description: `A template named "${body.name.trim()}" already exists.`,
      recommendedActions: ['Choose a different name or delete the existing template first'],
    });
  }

  const quoteDraftService = new QuoteDraftService(db);
  const draft = await quoteDraftService.getById(body.draftId, userId);

  // Convert draft line items to template line items
  const lineItems = [...draft.lineItems, ...draft.unresolvedItems].map((li) => ({
    name: li.productName,
    description: li.originalText || '',
    quantity: li.quantity,
    unitPrice: li.unitPrice,
  }));

  const templateId = crypto.randomUUID();
  try {
    await db.prepare(
      "INSERT INTO manual_templates (id, user_id, name, content, category, line_items_json) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(
      templateId,
      userId,
      body.name.trim(),
      draft.customerRequestText || '',
      body.category ?? null,
      JSON.stringify(lineItems),
    ).run();
  } catch (dbErr) {
    const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
    if (msg.includes('UNIQUE constraint failed') || msg.includes('SQLITE_CONSTRAINT')) {
      throw new PlatformError({
        severity: 'warning',
        component: 'QuoteRoutes',
        operation: 'saveTemplateFromDraft',
        description: `A template named "${body.name.trim()}" already exists.`,
        recommendedActions: ['Choose a different name or delete the existing template first'],
      });
    }
    throw dbErr;
  }

  const templates = await fetchManualTemplates(db, userId);
  return c.json({ template: templates.find((t) => t.id === templateId), templates });
});

/**
 * DELETE /templates/:id
 * Delete a single template by ID.
 */
app.delete('/templates/:id', async (c) => {
  const db = c.env.DB;
  const userId = c.get('user').id;
  const templateId = c.req.param('id');

  await db.prepare(
    'DELETE FROM manual_templates WHERE id = ? AND user_id = ?'
  ).bind(templateId, userId).run();

  const templates = await fetchManualTemplates(db, userId);
  return c.json({ templates });
});

/**
 * POST /corpus/sync
 * Trigger a manual corpus synchronization with Jobber.
 */
app.post('/corpus/sync', async (c) => {
  const db = c.env.DB;

  // Atomic concurrency guard: claim the lock only if not already running (or stale > 10 min)
  const claimResult = await db.prepare(
    `UPDATE quote_corpus_sync_status
     SET last_sync_at = datetime('now'), last_sync_error = '__RUNNING__'
     WHERE id = 1 AND (last_sync_error != '__RUNNING__' OR last_sync_error IS NULL
       OR last_sync_at < datetime('now', '-10 minutes'))`
  ).run();

  if (!claimResult.meta.changes || claimResult.meta.changes === 0) {
    return c.json({ error: 'A corpus sync is already in progress. Please wait and try again.' }, 409);
  }

  const { jobberIntegration, activityLog } = await createJobberIntegration(db, c.env);
  const embeddingService = new EmbeddingService(c.env.AI_TEXT_API_KEY);
  const quantityEngine = new QuantityEngine(db);
  const quoteSyncService = new QuoteSyncService(db, embeddingService, activityLog, jobberIntegration, quantityEngine);

  try {
    const result = await quoteSyncService.sync();
    return c.json(result);
  } finally {
    // Clear the running marker — sync() already calls updateSyncStatus on success/failure,
    // but if something unexpected throws before that, ensure the lock is released.
    try {
      const stillRunning = await db.prepare(
        "SELECT 1 FROM quote_corpus_sync_status WHERE id = 1 AND last_sync_error = '__RUNNING__'"
      ).first();
      if (stillRunning) {
        await db.prepare(
          "UPDATE quote_corpus_sync_status SET last_sync_error = 'Sync terminated unexpectedly' WHERE id = 1 AND last_sync_error = '__RUNNING__'"
        ).run();
      }
    } catch { /* best-effort cleanup */ }
  }
});

/**
 * GET /corpus/status
 * Get the current corpus status (quote count and last sync timestamp).
 */
app.get('/corpus/status', async (c) => {
  const db = c.env.DB;
  const { jobberIntegration, activityLog } = await createJobberIntegration(db, c.env);
  const embeddingService = new EmbeddingService(c.env.AI_TEXT_API_KEY);
  const quoteSyncService = new QuoteSyncService(db, embeddingService, activityLog, jobberIntegration);
  const status = await quoteSyncService.getStatus();
  return c.json(status);
});

/**
 * GET /jobber/requests/:id
 * Fetch stored details for a single Jobber request.
 * If no webhook row exists, falls back to a live Jobber public API fetch and stores the result.
 * Re-fetches attachment URLs from Jobber API since stored URLs are signed and expire.
 */
app.get('/jobber/requests/:id', async (c) => {
  const db = c.env.DB;
  const requestId = c.req.param('id');

  let row = await db.prepare(
    `SELECT jobber_request_id, title, client_name, description, image_urls, request_body
     FROM jobber_webhook_requests
     WHERE jobber_request_id = ?
     ORDER BY processed_at DESC, received_at DESC
     LIMIT 1`
  ).bind(requestId).first() as Record<string, unknown> | null;

  // No webhook row — attempt a live fetch from the Jobber public API and store it
  if (!row) {
    try {
      const { jobberIntegration } = await createJobberIntegration(db, c.env);
      if (jobberIntegration.isAvailable()) {
        const detail = await jobberIntegration.graphqlRequest<Record<string, unknown>>(
          `query FetchRequestDetail($id: EncodedId!) {
            request(id: $id) {
              id title companyName contactName phone email requestStatus createdAt jobberWebUri
              client { id firstName lastName companyName }
              notes(first: 20) { edges { node { ... on RequestNote { message createdAt createdBy { __typename } } } } }
              noteAttachments(first: 20) { edges { node { url fileName contentType } } }
            }
          }`,
          { id: requestId },
        );
        const request = (detail as any)?.request;
        if (request) {
          const noteMessages = (request.notes?.edges ?? [])
            .map((e: any) => e.node?.message)
            .filter((m: unknown): m is string => typeof m === 'string' && (m as string).trim().length > 0);
          const description = noteMessages.join('\n\n');
          const imageUrls = (request.noteAttachments?.edges ?? [])
            .filter((e: any) => e.node?.contentType?.startsWith('image/'))
            .map((e: any) => e.node.url);
          const clientName = request.companyName || request.contactName
            || (request.client ? `${request.client.firstName || ''} ${request.client.lastName || ''}`.trim() || request.client.companyName : null)
            || null;

          await db.prepare(
            `INSERT INTO jobber_webhook_requests
              (id, jobber_request_id, topic, account_id, title, client_name, description, request_body, image_urls, raw_payload, processed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (jobber_request_id, topic) DO UPDATE SET
               title = excluded.title, client_name = excluded.client_name, description = excluded.description,
               request_body = excluded.request_body, image_urls = excluded.image_urls, processed_at = excluded.processed_at`
          ).bind(
            crypto.randomUUID(), requestId, 'API_FETCH', '',
            request.title ?? null, clientName, description || null,
            JSON.stringify(request), JSON.stringify(imageUrls),
            JSON.stringify({ source: 'api_fetch' }), new Date().toISOString(),
          ).run();

          row = await db.prepare(
            `SELECT jobber_request_id, title, client_name, description, image_urls, request_body
             FROM jobber_webhook_requests
             WHERE jobber_request_id = ?
             ORDER BY processed_at DESC, received_at DESC
             LIMIT 1`
          ).bind(requestId).first() as Record<string, unknown> | null;
        }
      }
    } catch (fetchErr) {
      console.warn('[quotes/requests/:id] Live API fallback failed:', fetchErr instanceof Error ? fetchErr.message : fetchErr);
    }
  }

  if (!row) {
    return c.json({ request: null });
  }

  // Extract notes from the stored request_body
  let notes: Array<{ message: string; createdBy: string; createdAt: string }> = [];
  let propertyAddress: string | null = null;
  if (row.request_body) {
    try {
      const detail = JSON.parse(row.request_body as string);
      const noteEdges = detail?.notes?.edges ?? [];
      notes = noteEdges
        .map((e: any) => e.node)
        .filter((n: any) => n?.message && typeof n.message === 'string' && n.message.trim().length > 0)
        .map((n: any) => {
          const typeName = n.createdBy?.__typename ?? '';
          let createdBy: 'team' | 'client' | 'system' = 'system';
          if (typeName === 'User') createdBy = 'team';
          else if (typeName === 'Client') createdBy = 'client';
          return {
            message: n.message,
            createdBy,
            createdAt: n.createdAt ?? '',
          };
        });

      // Extract property address (same logic as POST /generate)
      const property = detail?.property;
      if (property) {
        const parts = [
          property.street1,
          property.street2,
          property.city,
          property.province,
          property.postalCode,
        ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
        if (parts.length > 0) {
          propertyAddress = parts.join(', ');
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // Re-fetch fresh attachment URLs from Jobber API (stored URLs are signed S3 URLs that expire).
  // Falls back to stored URLs only if the refresh fails or times out — not when the request
  // genuinely has no images (successful empty response means no images exist).
  let imageUrls: string[] = [];
  let refreshSucceeded = false;
  try {
    const { jobberIntegration } = await createJobberIntegration(db, c.env);
    if (jobberIntegration.isAvailable()) {
      // Race the API call against a 5-second timeout to avoid blocking the response.
      // If the timeout wins, push the orphaned promise into waitUntil so the Worker
      // lets it finish in the background rather than abandoning it mid-flight.
      const apiPromise = jobberIntegration.graphqlRequest<Record<string, unknown>>(
        `query FetchAttachmentsAndProperty($id: EncodedId!) {
          request(id: $id) {
            noteAttachments(first: 20) { edges { node { url fileName contentType } } }
            property {
              address { street1 street2 city province postalCode }
            }
            client {
              clientProperties(first: 1) {
                nodes {
                  address { street1 street2 city province postalCode }
                }
              }
            }
          }
        }`,
        { id: requestId },
      );
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));

      const freshResult = await Promise.race([apiPromise, timeoutPromise]);
      if (freshResult === null) {
        // Timeout won — let the API call finish in the background
        c.executionCtx.waitUntil(apiPromise.catch(() => {}));
      } else {
        refreshSucceeded = true;
        const freshUrls = ((freshResult as any)?.request?.noteAttachments?.edges ?? [])
          .filter((e: any) => e.node?.contentType?.startsWith('image/'))
          .map((e: any) => e.node.url);
        imageUrls = freshUrls;
        // Update stored URLs so other consumers get fresh ones too
        await db.prepare(
          'UPDATE jobber_webhook_requests SET image_urls = ? WHERE jobber_request_id = ?'
        ).bind(JSON.stringify(imageUrls), requestId).run();

        // Prefer request.property.address (the job-site address on the request) over
        // client.clientProperties (the client's billing/home address on their account).
        const requestPropertyAddress = (freshResult as any)?.request?.property?.address;
        const clientPropertyAddress = (freshResult as any)?.request?.client?.clientProperties?.nodes?.[0]?.address;
        const liveAddress = requestPropertyAddress ?? clientPropertyAddress;
        if (liveAddress) {
          const parts = [
            liveAddress.street1,
            liveAddress.street2,
            liveAddress.city,
            liveAddress.province,
            liveAddress.postalCode,
          ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
          if (parts.length > 0) {
            propertyAddress = parts.join(', ');
          }
        }
      }
    }
  } catch {
    // Graceful fallback — use stored URLs
  }

  // Fallback to stored URLs only when the refresh failed or timed out.
  // If the refresh succeeded with 0 images, that's the truth — don't serve stale URLs.
  if (!refreshSucceeded && row.image_urls) {
    try {
      const parsed = typeof row.image_urls === 'string' ? JSON.parse(row.image_urls) : row.image_urls;
      imageUrls = Array.isArray(parsed) ? parsed : [];
    } catch {
      imageUrls = [];
    }
  }

  return c.json({
    request: {
      id: row.jobber_request_id as string,
      title: (row.title as string) ?? '',
      clientName: (row.client_name as string) ?? '',
      description: (row.description as string) ?? '',
      imageUrls,
      notes,
      propertyAddress,
    },
  });
});

/**
 * GET /jobber/requests/:id/form-data
 * Fetch the form submission data for a specific Jobber request.
 * Primary: Jobber internal API via web session cookies (requestDetails.form).
 * Fallback: D1 stored data → Jobber public API fetch + store → null.
 */
app.get('/jobber/requests/:id/form-data', async (c) => {
  const db = c.env.DB;
  const requestId = c.req.param('id');

  // Step 1: Try the internal Jobber API using web session cookies
  // This is the only way to get requestDetails.form (customer form submissions)
  try {
    const webSession = new JobberWebSession(db);
    const result = await webSession.fetchRequestFormData(requestId);
    if (result.formData) {
      return c.json({ formData: result.formData });
    }
    // If sessionExpired or no data, fall through to fallback
  } catch (err) {
    console.warn('[quotes/form-data] Web session fetch failed:', err instanceof Error ? err.message : err);
  }

  // Step 2: Fallback — check D1 for stored webhook/API data
  let row = await db.prepare(
    `SELECT title, client_name, description, request_body, image_urls
     FROM jobber_webhook_requests
     WHERE jobber_request_id = ?
     ORDER BY processed_at DESC, received_at DESC
     LIMIT 1`
  ).bind(requestId).first() as Record<string, unknown> | null;

  // Step 3: If not in D1, fetch from Jobber public GraphQL API and store
  if (!row || row.request_body == null) {
    try {
      const { jobberIntegration } = await createJobberIntegration(db, c.env);
      const detail = await jobberIntegration.graphqlRequest<Record<string, unknown>>(
        `query FetchRequestDetail($id: EncodedId!) {
          request(id: $id) {
            id title companyName contactName phone email requestStatus createdAt jobberWebUri
            client { id firstName lastName companyName }
            notes(first: 20) { edges { node { ... on RequestNote { message createdAt createdBy { __typename } } } } }
            noteAttachments(first: 20) { edges { node { url fileName contentType } } }
          }
        }`,
        { id: requestId },
      );
      const request = (detail as any)?.request;
      if (request) {
        const noteMessages = (request.notes?.edges ?? [])
          .map((e: any) => e.node?.message)
          .filter((m: unknown): m is string => typeof m === 'string' && (m as string).trim().length > 0);
        const description = noteMessages.join('\n\n');
        const imageUrls = (request.noteAttachments?.edges ?? [])
          .filter((e: any) => e.node?.contentType?.startsWith('image/'))
          .map((e: any) => e.node.url);
        const clientName = request.companyName || request.contactName
          || (request.client ? `${request.client.firstName || ''} ${request.client.lastName || ''}`.trim() || request.client.companyName : null)
          || null;

        await db.prepare(
          `INSERT INTO jobber_webhook_requests
            (id, jobber_request_id, topic, account_id, title, client_name, description, request_body, image_urls, raw_payload, processed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (jobber_request_id, topic) DO UPDATE SET
             title = excluded.title, client_name = excluded.client_name, description = excluded.description,
             request_body = excluded.request_body, image_urls = excluded.image_urls, processed_at = excluded.processed_at`
        ).bind(
          crypto.randomUUID(), requestId, 'API_FETCH', '',
          request.title ?? null, clientName, description || null,
          JSON.stringify(request), JSON.stringify(imageUrls),
          JSON.stringify({ source: 'api_fetch' }), new Date().toISOString(),
        ).run();

        row = await db.prepare(
          `SELECT title, client_name, description, request_body, image_urls
           FROM jobber_webhook_requests WHERE jobber_request_id = ?
           ORDER BY processed_at DESC, received_at DESC LIMIT 1`
        ).bind(requestId).first() as Record<string, unknown> | null;
      }
    } catch (fetchErr) {
      console.error('[quotes/form-data] API fallback failed:', fetchErr instanceof Error ? fetchErr.message : fetchErr);
    }
  }

  // Step 4: Build form data from D1 row (notes + description)
  if (!row) {
    return c.json({ formData: null });
  }

  const sections: Array<{ label: string; sortOrder: number; answers: Array<{ label: string; value: string | null }> }> = [];
  const textParts: string[] = [];

  if (row.request_body) {
    try {
      const detail = JSON.parse(row.request_body as string);
      const noteEdges = detail?.notes?.edges ?? [];
      const noteMessages = noteEdges
        .map((e: any) => e.node?.message)
        .filter((m: unknown): m is string => typeof m === 'string' && (m as string).trim().length > 0);
      if (noteMessages.length > 0) {
        sections.push({
          label: 'Notes',
          sortOrder: 2,
          answers: noteMessages.map((msg: string, i: number) => ({ label: `Note ${i + 1}`, value: msg })),
        });
        textParts.push(...noteMessages);
      }
    } catch { /* ignore parse errors */ }
  }

  const description = ((row.description as string) || '').trim();
  const descriptionAlreadyCovered = description.length > 0 && textParts.some(t =>
    t.includes(description) || description.includes(t)
  );
  if (description && !descriptionAlreadyCovered) {
    sections.unshift({ label: 'Request Description', sortOrder: 1, answers: [{ label: 'Description', value: description }] });
    textParts.unshift(description);
  }

  if (sections.length === 0) {
    return c.json({ formData: null });
  }

  return c.json({ formData: { sections, text: textParts.join('\n\n') } });
});

/**
 * GET /jobber/requests
 * Fetch customer requests from Jobber, enriched with webhook data.
 */
app.get('/jobber/requests', async (c) => {
  const db = c.env.DB;
  const { jobberIntegration, tokenStore, activityLog } = await createJobberIntegration(db, c.env);

  // Support ?fresh=true to bypass the in-memory cache
  const freshParam = c.req.query('fresh');
  if (freshParam === 'true') {
    jobberIntegration.invalidateCache();
  }

  // Webhook-aware cache invalidation: if a webhook arrived after the cache was populated,
  // invalidate so we fetch fresh data from Jobber that includes the new request
  const cacheFetchedAt = jobberIntegration.getRequestsCacheFetchedAt();
  if (cacheFetchedAt !== null) {
    try {
      // Convert epoch ms to SQLite datetime format (YYYY-MM-DD HH:MM:SS) to match received_at column
      const cacheDate = new Date(cacheFetchedAt);
      const sqliteTimestamp = cacheDate.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
      const newerWebhook = await db.prepare(
        `SELECT 1 FROM jobber_webhook_requests WHERE received_at > ? LIMIT 1`
      ).bind(sqliteTimestamp).first();
      if (newerWebhook) {
        console.log('[quotes/requests] Webhook arrived after cache, invalidating');
        jobberIntegration.invalidateCache();
      }
    } catch {
      // Best-effort — if the table doesn't exist or query fails, skip
    }
  }

  let requests: JobberCustomerRequest[] = [];
  let available = false;

  if (jobberIntegration.isAvailable()) {
    requests = await jobberIntegration.fetchCustomerRequests();
    available = jobberIntegration.isAvailable();
    console.log(`[quotes/requests] GraphQL returned ${requests.length} requests, available=${available}`);
  } else {
    console.log('[quotes/requests] Jobber API not available, skipping GraphQL call');
  }

  // Merge webhook data
  try {
    const webhookService = new JobberWebhookService(db, activityLog, {
      accessToken: c.env.JOBBER_ACCESS_TOKEN || '',
      clientSecret: c.env.JOBBER_CLIENT_SECRET || '',
      clientId: c.env.JOBBER_CLIENT_ID || '',
      refreshToken: c.env.JOBBER_REFRESH_TOKEN || '',
      tokenStore,
    });
    try {
      await webhookService.loadPersistedTokens();
    } catch (tokenErr) {
      console.warn('[quotes/requests] Failed to load persisted tokens for webhook service:', tokenErr instanceof Error ? tokenErr.message : tokenErr);
    }
    const webhookRequests = await webhookService.getWebhookRequests();
    console.log(`[quotes/requests] Webhook merge: ${webhookRequests.length} webhook requests, ${requests.length} API requests`);
    const apiIds = new Set(requests.map((r) => r.id));

    for (const wr of webhookRequests) {
      if (apiIds.has(wr.id)) {
        const existing = requests.find((r) => r.id === wr.id)!;
        if (wr.imageUrls.length > existing.imageUrls.length) {
          existing.imageUrls = wr.imageUrls;
        }
        if (wr.description && (!existing.description || existing.description.length < wr.description.length)) {
          existing.description = wr.description;
        }
        if (wr.structuredNotes.length > existing.structuredNotes.length) {
          existing.structuredNotes = wr.structuredNotes;
          existing.notes = wr.structuredNotes.map((n) => n.message);
        }
      } else {
        requests.push(wr);
      }
    }

    requests.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    if (webhookRequests.length > 0) available = true;
  } catch (webhookErr) {
    console.error('[quotes/requests] Webhook enrichment failed:', webhookErr instanceof Error ? webhookErr.message : webhookErr);
    // Webhook enrichment is best-effort
  }

  // Background enrichment: identify incomplete requests and fetch full details from Jobber API
  const incomplete = requests.filter(
    (r) => !r.description && r.structuredNotes.length === 0 && r.imageUrls.length === 0
  );
  const toEnrich = incomplete.slice(0, 5);

  if (toEnrich.length > 0 && jobberIntegration.isAvailable() && c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(
      Promise.allSettled(
        toEnrich.map(async (req) => {
          try {
            const detail = await jobberIntegration.graphqlRequest<Record<string, unknown>>(
              `query FetchRequestDetail($id: EncodedId!) {
                request(id: $id) {
                  id title companyName contactName phone email requestStatus createdAt jobberWebUri
                  client { id firstName lastName companyName }
                  notes(first: 20) { edges { node { ... on RequestNote { message createdAt createdBy { __typename } } } } }
                  noteAttachments(first: 20) { edges { node { url fileName contentType } } }
                }
              }`,
              { id: req.id },
            );
            const request = (detail as any)?.request;
            if (!request) return;

            const noteMessages = (request.notes?.edges ?? [])
              .map((e: any) => e.node?.message)
              .filter((m: unknown): m is string => typeof m === 'string' && (m as string).trim().length > 0);
            const description = noteMessages.join('\n\n');
            const imageUrls = (request.noteAttachments?.edges ?? [])
              .filter((e: any) => e.node?.contentType?.startsWith('image/'))
              .map((e: any) => e.node.url);
            const clientName = request.companyName || request.contactName
              || (request.client ? `${request.client.firstName || ''} ${request.client.lastName || ''}`.trim() || request.client.companyName : null)
              || null;

            await db.prepare(
              `INSERT INTO jobber_webhook_requests
                (id, jobber_request_id, topic, account_id, title, client_name, description, request_body, image_urls, raw_payload, processed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (jobber_request_id, topic) DO UPDATE SET
                 title = excluded.title,
                 client_name = excluded.client_name,
                 description = excluded.description,
                 request_body = excluded.request_body,
                 image_urls = excluded.image_urls,
                 processed_at = excluded.processed_at`
            ).bind(
              crypto.randomUUID(), req.id, 'API_FETCH', '',
              request.title ?? null, clientName, description || null,
              JSON.stringify(request), JSON.stringify(imageUrls),
              JSON.stringify({ source: 'background_enrichment' }), new Date().toISOString(),
            ).run();

            console.log(`[quotes/requests] Enriched request ${req.id}`);
          } catch (err) {
            console.error(`[quotes/requests] Enrichment failed for ${req.id}:`, err instanceof Error ? err.message : err);
          }
        })
      )
    );
  }

  return c.json({ requests, available });
});

/**
 * GET /jobber/status
 * Check Jobber API availability.
 */
app.get('/jobber/status', async (c) => {
  const db = c.env.DB;
  const { jobberIntegration } = await createJobberIntegration(db, c.env);

  let webhookActive = false;
  try {
    const result = await db.prepare(
      `SELECT COUNT(*) as count FROM jobber_webhook_requests WHERE processed_at IS NOT NULL`
    ).first() as { count: number } | null;
    webhookActive = (result?.count ?? 0) > 0;
  } catch { /* table may not exist yet */ }

  return c.json({ available: jobberIntegration.isAvailable() || webhookActive, webhookActive });
});

/**
 * GET /productivity-rates
 * Return all productivity rates ordered by display_name ascending.
 */
app.get('/productivity-rates', async (c) => {
  const service = new ProductivityRatesService(c.env.DB);
  const rates = await service.getAllRates();
  return c.json({ rates });
});

/**
 * PUT /productivity-rates/:id
 * Update sqft_per_hour, display_name, and/or description for a rate.
 */
app.put('/productivity-rates/:id', async (c) => {
  const service = new ProductivityRatesService(c.env.DB);
  const body = await c.req.json() as UpdateProductivityRatePayload;
  const rate = await service.updateRate(c.req.param('id'), body);
  return c.json(rate);
});

// ── Jobber Quote Import ─────────────────────────────────────────────

/**
 * GET /jobber/quotes/in-progress
 * Fetch in-progress (draft + sent) quotes from Jobber that are importable as Cotiza drafts.
 * Returns the list of quotes and whether the Jobber API is available.
 */
app.get('/jobber/quotes/in-progress', async (c) => {
  const db = c.env.DB;
  const { jobberIntegration } = await createJobberIntegration(db, c.env);

  let quotes: ImportableQuote[] = [];
  let available = false;
  let scopeError = false;

  // Gate on whether Jobber is configured (client ID present), not on isAvailable()
  // isAvailable() only becomes true after syncProductCatalog() which isn't called here
  if (c.env.JOBBER_CLIENT_ID) {
    const activityLog = new ActivityLogService(db);
    const quoteDraftService = new QuoteDraftService(db);
    const importer = new JobberQuoteImportService(db, quoteDraftService, jobberIntegration, activityLog);
    try {
      quotes = await importer.fetchImportableQuotes();
      available = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/throttl|401|403|unauthorized|forbidden|scope/i.test(msg)) {
        scopeError = true;
        console.warn('[quotes] Jobber throttled on quotes fetch. Re-auth may be required.');
      } else {
        console.error('[quotes] fetchImportableQuotes error:', msg);
      }
    }
  }

  return c.json({ quotes, available, scopeError });
});

/**
 * POST /jobber/quotes/:jobberQuoteId/import
 * Import a Jobber quote as a Cotiza quote draft.
 *
 * Returns 201 with the created draft and any warnings.
 * Returns 409 if the quote has already been imported.
 * Returns 404 if the quote doesn't exist in Jobber.
 */
app.post('/jobber/quotes/:jobberQuoteId/import', async (c) => {
  const userId = c.get('user').id;
  const db = c.env.DB;
  const jobberQuoteId = c.req.param('jobberQuoteId');
  const { jobberIntegration, activityLog } = await createJobberIntegration(db, c.env);

  if (!jobberIntegration.isAvailable()) {
    throw new PlatformError({
      severity: 'error',
      component: 'QuoteRoutes',
      operation: 'importJobberQuote',
      description: 'Jobber API is not available. Check credentials and connectivity.',
      recommendedActions: ['Verify Jobber API credentials and try again.'],
      statusCode: 503,
    });
  }

  const quoteDraftService = new QuoteDraftService(db);
  const catalog = await fetchCatalog(db, userId);
  const quoteEngine = new QuoteEngine(c.env.AI_TEXT_API_KEY, c.env.AI_TEXT_API_URL);
  const importer = new JobberQuoteImportService(db, quoteDraftService, jobberIntegration, activityLog);
  const result = await importer.importQuote(jobberQuoteId, userId, {
    scoreImportedLineItems: async (ctx) => {
      const customerText = await buildJobberImportCustomerContext(
        db,
        ctx.linkedRequestId,
        ctx.customerRequestText,
        jobberIntegration,
        {
          gmailClientId: c.env.GMAIL_CLIENT_ID,
          gmailClientSecret: c.env.GMAIL_CLIENT_SECRET,
          gmailRefreshToken: c.env.GMAIL_REFRESH_TOKEN,
        },
      );
      return quoteEngine.scoreLineItemsAgainstRequest({
        customerText,
        lineItems: ctx.lineItems,
        catalog,
        preserveSourceFields: true,
        requireCatalogForResolved: false,
      });
    },
  });

  return c.json(result, 201);
});

export default app;
