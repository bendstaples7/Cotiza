/** Jobber quote statuses that represent in-progress work (not terminal). */
const ACTIVE_JOBBER_QUOTE_STATUSES = new Set([
  'draft',
  'sent',
  'awaiting_response',
  'changes_requested',
]);

/** True when a Jobber quote is still in progress and should be surfaced on the request queue. */
export function isActiveJobberQuoteStatus(status: string): boolean {
  return ACTIVE_JOBBER_QUOTE_STATUSES.has(status.trim().toLowerCase());
}
