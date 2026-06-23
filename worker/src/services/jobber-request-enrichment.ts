import { resolveJobberRequestFields, isAbsentStoredValue, isPlaceholderJobberClientName } from 'shared';
import type { JobberRequestDisplayFields } from 'shared';
import type { JobberIntegration } from './jobber-integration.js';
import { JobberWebSession } from './jobber-web-session.js';
import type { ManualRequestListRow } from './manual-request-service.js';

/** SQL: treat NULL, blank, and literal "null"/"undefined" as absent. */
function sqlStoredText(column: string): string {
  return `NULLIF(NULLIF(NULLIF(TRIM(COALESCE(${column}, '')), ''), 'null'), 'undefined')`;
}

const JOBBER_DETAIL_QUERY = `query FetchRequestDetail($id: EncodedId!) {
  request(id: $id) {
    id title companyName contactName phone email requestStatus createdAt jobberWebUri
    client { id firstName lastName companyName }
    notes(first: 20) { edges { node { ... on RequestNote { message createdAt createdBy { __typename } } } } }
    noteAttachments(first: 20) { edges { node { url fileName contentType } } }
  }
}`;

export interface EnrichedJobberRow {
  title: string | null;
  clientName: string | null;
  description: string | null;
  requestBody: string | null;
  formText: string | null;
  resolved: JobberRequestDisplayFields;
}

/** True when a queue row needs live Jobber backfill. */
export function queueRowNeedsEnrichment(row: ManualRequestListRow): boolean {
  if (row.requestSource !== 'jobber' || !row.jobberRequestId) return false;
  const name = row.customerName?.trim();
  if (!name || isPlaceholderJobberClientName(name) || isAbsentStoredValue(name)) return true;
  if (!row.requestBodyText?.trim() && !row.noteHighlights?.length) return true;
  return false;
}

export async function loadBestWebhookRow(
  db: D1Database,
  jobberRequestId: string,
): Promise<Record<string, unknown> | null> {
  return db.prepare(
    `SELECT id, title, client_name, description, request_body FROM jobber_webhook_requests
     WHERE jobber_request_id = ?
     ORDER BY
       CASE WHEN processed_at IS NOT NULL THEN 0 ELSE 1 END,
       processed_at DESC,
       length(COALESCE(${sqlStoredText('request_body')}, '')) DESC,
       length(COALESCE(${sqlStoredText('client_name')}, '')) DESC,
       received_at DESC
     LIMIT 1`,
  ).bind(jobberRequestId).first() as Promise<Record<string, unknown> | null>;
}

/**
 * Fetch live Jobber request detail, persist to D1, and optionally load form submission text.
 */
export async function enrichJobberRequest(
  db: D1Database,
  jobberRequestId: string,
  jobberIntegration: JobberIntegration,
): Promise<EnrichedJobberRow | null> {
  let formText: string | null = null;

  if (jobberIntegration.isAvailable()) {
    try {
      const detail = await jobberIntegration.graphqlRequest<Record<string, unknown>>(
        JOBBER_DETAIL_QUERY,
        { id: jobberRequestId },
      );
      const request = (detail as { request?: Record<string, unknown> })?.request;
      if (request) {
        const noteMessages = ((request.notes as any)?.edges ?? [])
          .map((e: { node?: { message?: string } }) => e.node?.message)
          .filter((m: unknown): m is string => typeof m === 'string' && m.trim().length > 0);
        const description = noteMessages.join('\n\n');
        const imageUrls = ((request.noteAttachments as any)?.edges ?? [])
          .filter((e: { node?: { contentType?: string } }) => e.node?.contentType?.startsWith('image/'))
          .map((e: { node?: { url?: string } }) => e.node?.url);
        const client = request.client as {
          firstName?: string;
          lastName?: string;
          companyName?: string;
        } | undefined;
        const clientName = (request.companyName as string)
          || (request.contactName as string)
          || (client
            ? `${client.firstName || ''} ${client.lastName || ''}`.trim() || client.companyName
            : null)
          || null;
        const jobberCreatedAt = (request.createdAt as string) || null;

        await db.prepare(
          `INSERT INTO jobber_webhook_requests
            (id, jobber_request_id, topic, account_id, title, client_name, description, request_body, image_urls, raw_payload, processed_at, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (jobber_request_id, topic) DO UPDATE SET
             title = excluded.title,
             client_name = excluded.client_name,
             description = excluded.description,
             request_body = excluded.request_body,
             image_urls = excluded.image_urls,
             processed_at = excluded.processed_at,
             received_at = COALESCE(
               NULLIF(json_extract(excluded.request_body, '$.createdAt'), ''),
               jobber_webhook_requests.received_at
             )`,
        ).bind(
          crypto.randomUUID(),
          jobberRequestId,
          'API_FETCH',
          '',
          request.title ?? null,
          clientName,
          description || null,
          JSON.stringify(request),
          JSON.stringify(imageUrls),
          JSON.stringify({ source: 'api_fetch_enrichment' }),
          new Date().toISOString(),
          jobberCreatedAt ?? new Date().toISOString(),
        ).run();
      }
    } catch (err) {
      console.warn(
        '[JobberRequestEnrichment] Public API fetch failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  const row = await loadBestWebhookRow(db, jobberRequestId);
  let resolved = resolveJobberRequestFields({
    clientName: (row?.client_name as string) ?? null,
    title: (row?.title as string) ?? null,
    description: (row?.description as string) ?? null,
    requestBody: row?.request_body ?? null,
    formText,
  });

  if (!resolved.requestBodyText.trim()) {
    try {
      const webSession = new JobberWebSession(db);
      const { formData } = await webSession.fetchRequestFormData(jobberRequestId);
      if (formData?.text?.trim()) {
        formText = formData.text.trim();
        resolved = resolveJobberRequestFields({
          clientName: (row?.client_name as string) ?? null,
          title: (row?.title as string) ?? null,
          description: (row?.description as string) ?? null,
          requestBody: row?.request_body ?? null,
          formText,
        });
      }
    } catch {
      // Graceful degradation
    }
  }

  if (
    isPlaceholderJobberClientName(resolved.customerName)
    && !resolved.requestBodyText.trim()
    && !resolved.requestTitle
  ) {
    return null;
  }

  return {
    title: (row?.title as string) ?? resolved.requestTitle,
    clientName: !isPlaceholderJobberClientName(resolved.customerName)
      ? resolved.customerName
      : (row?.client_name as string) ?? null,
    description: (row?.description as string) ?? null,
    requestBody: (row?.request_body as string) ?? null,
    formText,
    resolved,
  };
}

/** Apply resolved enrichment fields onto a queue list row. */
export function applyEnrichmentToListRow(
  row: ManualRequestListRow,
  enriched: EnrichedJobberRow,
): ManualRequestListRow {
  const { resolved } = enriched;
  return {
    ...row,
    customerName: resolved.customerName,
    requestTitle: resolved.requestTitle,
    requestBodyText: resolved.requestBodyText,
    serviceDescription: resolved.serviceDescription,
    noteHighlights: resolved.noteHighlights,
  };
}

/**
 * Backfill up to `cap` sparse Jobber queue rows from live Jobber API / form data.
 */
export async function enrichSparseQueueRows(
  db: D1Database,
  rows: ManualRequestListRow[],
  jobberIntegration: JobberIntegration,
  cap = 5,
  timeoutMs = 8_000,
): Promise<ManualRequestListRow[]> {
  const sparseIndices: number[] = [];
  for (let i = 0; i < rows.length && sparseIndices.length < cap; i++) {
    if (queueRowNeedsEnrichment(rows[i])) {
      sparseIndices.push(i);
    }
  }

  if (sparseIndices.length === 0) return rows;

  const updated = [...rows];

  const enrichOne = async (idx: number): Promise<void> => {
    const row = updated[idx];
    if (!row.jobberRequestId) return;
    try {
      const enriched = await Promise.race([
        enrichJobberRequest(db, row.jobberRequestId, jobberIntegration),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 6_000)),
      ]);
      if (enriched) {
        updated[idx] = applyEnrichmentToListRow(row, enriched);
      }
    } catch {
      // Skip failed enrichment — keep original row
    }
  };

  await Promise.race([
    Promise.allSettled(sparseIndices.map((idx) => enrichOne(idx))),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);

  return updated;
}

/** Load and resolve the best stored row for quote generation. */
export async function resolveJobberRequestForGenerate(
  db: D1Database,
  jobberRequestId: string,
  jobberIntegration: JobberIntegration,
): Promise<JobberRequestDisplayFields | null> {
  let row = await loadBestWebhookRow(db, jobberRequestId);
  let resolved = resolveJobberRequestFields({
    clientName: (row?.client_name as string) ?? null,
    title: (row?.title as string) ?? null,
    description: (row?.description as string) ?? null,
    requestBody: row?.request_body ?? null,
  });

  const needsFetch =
    isPlaceholderJobberClientName(resolved.customerName)
    || !row?.request_body
    || isAbsentStoredValue(row.request_body as string)
    || (!resolved.requestBodyText.trim() && !resolved.noteHighlights.length);

  if (needsFetch) {
    const enriched = await enrichJobberRequest(db, jobberRequestId, jobberIntegration);
    if (enriched) return enriched.resolved;
  }

  return resolved;
}
