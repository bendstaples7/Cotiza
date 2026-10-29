/**
 * Read-only Jobber job + visit queries for the ops assistant.
 * Used for schedule audits: quoted scope vs. scheduled length vs. actual progress.
 * Fixed queries only; nothing here writes to Jobber.
 */

export const JOB_STATUSES = new Set([
  'active',
  'action_required',
  'archived',
  'late',
  'on_hold',
  'requires_invoicing',
  'today',
  'unscheduled',
  'upcoming',
]);

/** Visits fetched per job in list results. Enough for most renovation jobs; truncation is flagged. */
export const LIST_VISITS_PER_JOB = 30;
/** Visits fetched per page by read_job. */
export const DETAIL_VISITS_PER_PAGE = 50;

const VISIT_FIELDS = 'id title startAt endAt completedAt visitStatus';

const JOBS_QUERY = `
  query AssistantJobs($first: Int!, $after: String) {
    jobs(first: $first, after: $after) {
      edges {
        node {
          id
          jobNumber
          title
          jobStatus
          jobType
          startAt
          endAt
          completedAt
          createdAt
          total
          jobberWebUri
          client { id firstName lastName companyName }
          quote { id quoteNumber }
          visits(first: ${LIST_VISITS_PER_JOB}) {
            nodes { ${VISIT_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const JOB_DETAIL_QUERY = `
  query AssistantJobDetail($id: EncodedId!, $after: String) {
    job(id: $id) {
      id
      jobNumber
      title
      instructions
      jobStatus
      jobType
      startAt
      endAt
      completedAt
      createdAt
      total
      jobberWebUri
      client { id firstName lastName companyName }
      quote { id quoteNumber }
      request { id }
      lineItems {
        nodes { id name description quantity unitPrice }
      }
      visits(first: ${DETAIL_VISITS_PER_PAGE}, after: $after) {
        nodes { ${VISIT_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const JOB_QUERIES = { JOBS_QUERY, JOB_DETAIL_QUERY };

export interface VisitNode {
  id?: string;
  title?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  completedAt?: string | null;
  visitStatus?: string | null;
}

function isComplete(visit: VisitNode): boolean {
  return Boolean(visit.completedAt) || String(visit.visitStatus || '').toLowerCase() === 'completed';
}

function minIso(values: Array<string | null | undefined>): string | null {
  const v = values.filter((x): x is string => Boolean(x)).sort();
  return v[0] ?? null;
}

function maxIso(values: Array<string | null | undefined>): string | null {
  const v = values.filter((x): x is string => Boolean(x)).sort();
  return v[v.length - 1] ?? null;
}

/**
 * Deterministic visit roll-up. Counts only cover the visits returned on this page;
 * `truncated` says when Jobber has more.
 */
export function summarizeVisits(visits: VisitNode[], hasMore: boolean, now: Date = new Date()) {
  const nowIso = now.toISOString();
  const completed = visits.filter(isComplete);
  const open = visits.filter((v) => !isComplete(v));
  const scheduledOpen = open.filter((v) => v.startAt);
  const upcoming = scheduledOpen.filter((v) => String(v.startAt) >= nowIso);
  const overdue = scheduledOpen.filter((v) => String(v.endAt || v.startAt) < nowIso);
  return {
    countedVisits: visits.length,
    completedVisits: completed.length,
    openVisits: open.length,
    unscheduledVisits: open.length - scheduledOpen.length,
    overdueOpenVisits: overdue.length,
    firstVisitStart: minIso(visits.map((v) => v.startAt)),
    lastVisitEnd: maxIso(visits.map((v) => v.endAt || v.startAt)),
    lastCompletedAt: maxIso(completed.map((v) => v.completedAt)),
    nextVisitStart: minIso(upcoming.map((v) => v.startAt)),
    truncated: hasMore,
    note: hasMore
      ? 'Jobber has more visits than this page returned. Counts are partial; use read_job with a cursor for the full list.'
      : 'Counts cover every visit Jobber returned for this job.',
  };
}

export function mapVisit(v: VisitNode) {
  return {
    id: v.id ?? null,
    title: v.title ?? null,
    startAt: v.startAt ?? null,
    endAt: v.endAt ?? null,
    completedAt: v.completedAt ?? null,
    status: v.visitStatus ?? null,
  };
}
