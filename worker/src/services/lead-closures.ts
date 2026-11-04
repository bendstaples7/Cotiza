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
const MAX_POSTPONED_FETCH = 20;

/** True when a closed lead should still be listed: a postponed one whose check-back date has come. */
export function closureListed(closure: LeadClosure | undefined, today: string): boolean {
  if (!closure) return true;
  return closure.reason === 'postponed' && Boolean(closure.checkBackOn) && closure.checkBackOn! <= today;
}

export async function applyClosuresToOpenLeads(db: D1Database, jobber: JobberReadClient, open: LeadNode[], now: number): Promise<{ open: LeadNode[]; closuresUnavailable: boolean }> {
  let closures: Map<string, LeadClosure>;
  try {
    closures = await new LeadContactService(db).closures();
  } catch (err) {
    console.warn(`[lead-closures] closures unavailable: ${sanitizeLogText(err instanceof Error ? err.message : String(err)).slice(0, 180)}`);
    // Better to show a closed lead than to hide an open one: the caller says closures couldn't be read.
    return { open, closuresUnavailable: true };
  }
  const today = chicagoDate(now);
  const listed = open.filter((node) => closureListed(closures.get(node.id), today));
  const present = new Set(open.map((n) => n.id));
  const duePostponed = [...closures.entries()]
    .filter(([id, c]) => !present.has(id) && closureListed(c, today))
    .slice(0, MAX_POSTPONED_FETCH);
  for (const [id] of duePostponed) {
    try {
      const data = await jobber.graphqlRequest<{ request?: LeadNode | null }>(REQUEST_NODE_QUERY, { id });
      const node = data.request;
      if (node && !CLOSED_REQUEST_STATUSES.has(String(node.requestStatus ?? '').toLowerCase())) listed.push(node);
    } catch (err) {
      console.warn(`[lead-closures] postponed lead unavailable: ${sanitizeLogText(err instanceof Error ? err.message : String(err)).slice(0, 180)}`);
    }
  }
  return { open: listed, closuresUnavailable: false };
}
