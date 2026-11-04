/**
 * Applies the team's lead closures to Jobber's open leads, for the request queue and list_open_leads:
 * a closed lead leaves the list, and a postponed one comes back once its check-back date arrives,
 * even when the request is older than the open-lead window (postponed requests stay open in Jobber).
 */
import type { JobberReadClient } from './ops-assistant-read.js';
import { CLOSED_REQUEST_STATUSES, type LeadNode } from './open-leads.js';
import { LeadContactService, type LeadClosure } from './lead-contact-service.js';
import { chicagoDate } from './lead-workflow.js';
import { sanitizeLogText } from './jobber-log-sanitize.mjs';

const REQUEST_NODE_QUERY = `query CotizaPostponedLead($id: EncodedId!) {
  request(id: $id) { id title requestStatus createdAt jobberWebUri companyName contactName client { firstName lastName companyName } }
}`;
const MAX_POSTPONED_FETCH = 50;
const FETCH_CONCURRENCY = 4;

/** True when a closed lead should still be listed: a postponed one whose check-back date has come. */
export function closureListed(closure: LeadClosure | undefined, today: string): boolean {
  if (!closure) return true;
  return closure.reason === 'postponed' && Boolean(closure.checkBackOn) && closure.checkBackOn! <= today;
}

export interface ClosureResult {
  open: LeadNode[];
  /** Closed leads could not be read: some listed leads may already be closed. */
  closuresUnavailable: boolean;
  /** Some due postponed leads could not be read from Jobber (or there were too many): they are missing. */
  postponedUnavailable: boolean;
}

export async function applyClosuresToOpenLeads(db: D1Database, jobber: JobberReadClient, open: LeadNode[], now: number): Promise<ClosureResult> {
  let closures: Map<string, LeadClosure>;
  try {
    closures = await new LeadContactService(db).closures();
  } catch (err) {
    console.warn(`[lead-closures] closures unavailable: ${sanitizeLogText(err instanceof Error ? err.message : String(err)).slice(0, 180)}`);
    // Better to show a closed lead than to hide an open one: the caller says closures couldn't be read.
    return { open, closuresUnavailable: true, postponedUnavailable: false };
  }
  const today = chicagoDate(now);
  const listed = open.filter((node) => closureListed(closures.get(node.id), today));
  const present = new Set(open.map((n) => n.id));
  const due = [...closures.entries()].filter(([id, c]) => !present.has(id) && closureListed(c, today)).map(([id]) => id);
  const toFetch = due.slice(0, MAX_POSTPONED_FETCH);
  let postponedUnavailable = due.length > toFetch.length;
  const fetched: LeadNode[] = [];
  let next = 0;
  const worker = async () => {
    while (next < toFetch.length) {
      const id = toFetch[next++];
      try {
        const data = await jobber.graphqlRequest<{ request?: LeadNode | null }>(REQUEST_NODE_QUERY, { id });
        const node = data.request;
        if (node && !CLOSED_REQUEST_STATUSES.has(String(node.requestStatus ?? '').toLowerCase())) fetched.push(node);
      } catch (err) {
        postponedUnavailable = true;
        console.warn(`[lead-closures] postponed lead unavailable: ${sanitizeLogText(err instanceof Error ? err.message : String(err)).slice(0, 180)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, toFetch.length) }, worker));
  return { open: [...listed, ...fetched], closuresUnavailable: false, postponedUnavailable };
}
