/**
 * Open leads, read live from Jobber: requests from the last N days that Jobber still shows as
 * new or in assessment. Shared by the list_open_leads assistant tool and the Cotiza request queue,
 * so both agree on what "open" means. Cotiza's own tables only know a quote was sent when it was
 * built in Cotiza, so they cannot answer this.
 */
import type { JobberReadClient } from './ops-assistant-read.js';
import type { ManualRequestListRow } from './manual-request-service.js';

/** Jobber request statuses that mean the lead is handled: a quote or job was made, or it was dropped. */
export const CLOSED_REQUEST_STATUSES = new Set(['converted', 'archived']);
export const LEAD_PAGE_SIZE = 50;
export const LEAD_MAX_PAGES = 10;

export const OPEN_LEADS_QUERY = `
  query AssistantOpenLeads($first: Int!, $after: String) {
    requests(first: $first, after: $after, sort: [{ key: REQUESTED_AT, direction: DESCENDING }]) {
      edges { node { id title requestStatus createdAt jobberWebUri companyName contactName client { firstName lastName companyName } } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export type LeadNode = {
  id: string; title?: string | null; requestStatus?: string | null; createdAt?: string | null; jobberWebUri?: string | null;
  companyName?: string | null; contactName?: string | null; client?: { firstName?: string | null; lastName?: string | null; companyName?: string | null } | null;
};
type LeadPage = { requests?: { edges?: Array<{ node: LeadNode }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } };

export function leadClientName(node: LeadNode): string | null {
  const person = [node.client?.firstName, node.client?.lastName].map((part) => (part ?? '').trim()).filter(Boolean).join(' ');
  return person || (node.contactName ?? '').trim() || (node.client?.companyName ?? node.companyName ?? '').trim() || null;
}

/** Reads requests newest first until one is older than the window, keeping the ones not yet converted or archived. */
export async function loadOpenLeads(jobber: JobberReadClient, days: number, now: number): Promise<{ open: LeadNode[]; complete: boolean }> {
  const cutoff = now - days * 86400_000;
  const open: LeadNode[] = [];
  let after: string | null = null;
  for (let page = 0; page < LEAD_MAX_PAGES; page++) {
    const data: LeadPage = await jobber.graphqlRequest<LeadPage>(OPEN_LEADS_QUERY, { first: LEAD_PAGE_SIZE, after });
    // A missing or malformed page is a failed read, never an empty list of leads.
    if (!data?.requests || !Array.isArray(data.requests.edges) || typeof data.requests.pageInfo?.hasNextPage !== 'boolean') {
      throw new Error('Jobber returned no requests page.');
    }
    const edges = data.requests.edges;
    for (const { node } of edges) {
      const created = Date.parse(node.createdAt ?? '');
      if (Number.isFinite(created) && created < cutoff) return { open, complete: true };
      if (!CLOSED_REQUEST_STATUSES.has(String(node.requestStatus ?? '').toLowerCase())) open.push(node);
    }
    if (!data.requests?.pageInfo?.hasNextPage || !data.requests.pageInfo.endCursor) return { open, complete: true };
    after = data.requests.pageInfo.endCursor;
  }
  return { open, complete: false };
}

/** Default window for the request queue and list_open_leads. */
export const OPEN_LEAD_DAYS = 60;

/**
 * Builds the request queue from manual requests plus Jobber's open leads. Stored Jobber rows are
 * kept only when Jobber still shows the request open (their stored notes/body are reused, with the
 * live name and title); open leads Cotiza never stored get a row of their own.
 */
export function mergeQueueWithOpenLeads(
  rows: ManualRequestListRow[],
  open: LeadNode[],
  sortBy: 'age_asc' | 'age_desc',
  userId: string,
  now: number,
): ManualRequestListRow[] {
  const stored = new Map<string, ManualRequestListRow>();
  for (const row of rows) {
    if (row.requestSource === 'jobber' && row.jobberRequestId && !stored.has(row.jobberRequestId)) stored.set(row.jobberRequestId, row);
  }
  const manual = rows.filter((row) => row.requestSource !== 'jobber');
  const leads = open.map((node): ManualRequestListRow => {
    const created = Date.parse(node.createdAt ?? '');
    const ageSeconds = Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / 1000)) : 0;
    const name = leadClientName(node);
    const title = node.title?.trim() || null;
    const base = stored.get(node.id);
    if (base) {
      // Age and order follow Jobber's own createdAt, not the stored row's anchor.
      return {
        ...base,
        customerName: name ?? base.customerName,
        requestTitle: title ?? base.requestTitle ?? null,
        createdAt: Number.isFinite(created) ? new Date(created) : base.createdAt,
        ageSeconds: Number.isFinite(created) ? ageSeconds : base.ageSeconds,
        quoteSentAt: null,
      };
    }
    return {
      id: node.id,
      userId,
      customerName: name ?? 'Unknown',
      customerPhone: null,
      customerEmail: null,
      customerAddress: null,
      serviceDescription: title ?? '',
      mediaItemIds: [],
      requestSource: 'jobber',
      createdAt: Number.isFinite(created) ? new Date(created) : new Date(now),
      ageSeconds,
      quoteSentAt: null,
      jobberRequestId: node.id,
      requestTitle: title,
    };
  });
  const merged = [...manual, ...leads];
  merged.sort((x, y) => (sortBy === 'age_asc' ? y.ageSeconds - x.ageSeconds : x.ageSeconds - y.ageSeconds));
  return merged;
}
