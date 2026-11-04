/**
 * Where a lead's quote is, once the lead is ready to quote, so the team knows whose move it is:
 *
 *   Drafting       a draft quote exists in Jobber; the team finishes it
 *   Ben's edits    Ben reviewed and asked for changes; the team makes them
 *   Ben review     the team sent it to Ben (Cotiza button, or the old in-app review); nothing to do
 *   Ready to send  Ben's newest review approves it and the quote is still a draft; the team sends it
 *   Sent           Jobber shows it sent (awaiting response, changes requested, approved, converted)
 *
 * Ben's review comes from the Cotiza review ledger (quote_review_records): the newest record per
 * quote number. A record's `decision` ("approved" / "changes_requested") is used when present; older
 * records are read from their `status` text. When the ledger can't be read, the stage says so
 * ("unknown") instead of guessing.
 */

export type QuoteStageKind = 'none' | 'drafting' | 'changes' | 'ben_review' | 'ready_to_send' | 'sent' | 'unknown';
export type ReviewDecision = 'approved' | 'changes_requested' | 'unclear';

export interface QuoteRef {
  id: string;
  number: string | null;
  status: string | null;
  webUri: string | null;
}

export interface QuoteReview {
  at: string;
  decision: ReviewDecision;
}

export interface QuoteStageInput {
  quotes: QuoteRef[];
  /** Newest ledger review per quote number; 'unknown' when the ledger could not be read. */
  reviews: Record<string, QuoteReview> | 'unknown';
  /** When the team sent each quote (by Jobber quote id) to Ben for review from Cotiza. */
  requested: Record<string, string>;
  /** Quote ids with a pending review in Cotiza's older in-app review cycle. */
  legacyPending: string[];
}

export interface QuoteStage {
  kind: QuoteStageKind;
  quote: { id: string; number: string | null; webUri: string | null } | null;
  /** Short chip text, e.g. "Quote #716 · with Ben". */
  label: string;
  /** One line on whose move it is. */
  why: string;
}

const SENT = new Set(['awaiting_response', 'changes_requested', 'approved', 'converted']);
const APPROVED_TEXT = /\b(approved|good to go|looks good|route to customer|ready to send|send (?:it )?to (?:the )?customer|recheck passed|passed)\b/i;
const CHANGES_TEXT = /\b(changes? requested|request(?:ed)? changes|edits? (?:needed|listed|sent|to make)|needs? (?:edits|changes|fixes)|team to (?:apply|fix|update)|send back|revise)\b/i;

/** Ben's decision in one ledger record. */
export function reviewDecision(record: unknown): ReviewDecision {
  const r = (record && typeof record === 'object' && !Array.isArray(record)) ? record as Record<string, unknown> : {};
  const d = typeof r.decision === 'string' ? r.decision.toLowerCase().trim() : '';
  if (d === 'approved') return 'approved';
  if (d === 'changes_requested') return 'changes_requested';
  const text = typeof r.status === 'string' ? r.status : '';
  // Changes first: "approved once the team applies edits" is still a change request.
  if (CHANGES_TEXT.test(text)) return 'changes_requested';
  if (APPROVED_TEXT.test(text)) return 'approved';
  return 'unclear';
}

const ms = (iso: string | null | undefined) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : -Infinity; };
const num = (q: QuoteRef) => { const n = Number(q.number); return Number.isFinite(n) ? n : -Infinity; };

function quoteName(q: QuoteRef) {
  return q.number ? `#${q.number}` : 'the quote';
}

export function computeQuoteStage(input: QuoteStageInput): QuoteStage {
  const live = input.quotes.filter((q) => String(q.status ?? '').toLowerCase() !== 'archived');
  const ref = (q: QuoteRef) => ({ id: q.id, number: q.number, webUri: q.webUri });
  const sent = live.filter((q) => SENT.has(String(q.status ?? '').toLowerCase())).sort((a, b) => num(b) - num(a));
  if (sent.length) {
    const q = sent[0];
    return { kind: 'sent', quote: ref(q), label: `Quote ${quoteName(q)} · sent`, why: `Quote ${quoteName(q)} is with the customer.` };
  }
  const drafts = live.filter((q) => String(q.status ?? '').toLowerCase() === 'draft').sort((a, b) => num(b) - num(a));
  if (!drafts.length) return { kind: 'none', quote: null, label: 'No quote yet', why: 'No draft quote in Jobber yet.' };
  const q = drafts[0];
  const name = quoteName(q);
  const requestedAt = Math.max(ms(input.requested[q.id]), input.legacyPending.includes(q.id) ? Infinity : -Infinity);
  if (input.reviews === 'unknown') {
    return { kind: 'unknown', quote: ref(q), label: `Quote ${name} · review status unknown`, why: `Ben's review of ${name} could not be read right now. Check with Ben before sending.` };
  }
  const review = q.number ? input.reviews[q.number] : undefined;
  const reviewedAfterRequest = review && ms(review.at) >= requestedAt;
  if (requestedAt > -Infinity && !reviewedAfterRequest) {
    return { kind: 'ben_review', quote: ref(q), label: `Quote ${name} · with Ben`, why: `Waiting on Ben's review of ${name}. Nothing for you to do.` };
  }
  if (review && review.decision === 'approved') {
    return { kind: 'ready_to_send', quote: ref(q), label: `Quote ${name} · ready to send`, why: `Ben approved ${name}. Send it to the customer in Jobber.` };
  }
  if (review && review.decision === 'changes_requested') {
    return { kind: 'changes', quote: ref(q), label: `Quote ${name} · Ben's edits`, why: `Ben asked for changes on ${name}. Make them in Jobber, then send it back to Ben.` };
  }
  if (review) {
    return { kind: 'ben_review', quote: ref(q), label: `Quote ${name} · reviewed`, why: `Ben reviewed ${name}, but the outcome isn't clear here. Check with Ben before sending.` };
  }
  return { kind: 'drafting', quote: ref(q), label: `Quote ${name} · drafting`, why: `Finish ${name} in Jobber, then send it to Ben for review.` };
}

// ── Loading ──────────────────────────────────────────────────────────────────

/** Newest ledger review per quote number. Throws on a failed read (callers report "unknown"). */
export async function loadQuoteReviews(db: D1Database, quoteNumbers: string[]): Promise<Record<string, QuoteReview>> {
  const numbers = [...new Set(quoteNumbers.filter(Boolean))].slice(0, 50);
  if (!numbers.length) return {};
  const marks = numbers.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT r.quote_number, r.created_at, r.record FROM quote_review_records r
              WHERE r.quote_number IN (${marks})
                AND r.seq = (SELECT MAX(seq) FROM quote_review_records x WHERE x.quote_number = r.quote_number)`)
    .bind(...numbers)
    .all<{ quote_number: string; created_at: string; record: string }>();
  const out: Record<string, QuoteReview> = {};
  for (const row of results ?? []) {
    let record: unknown = null;
    try { record = JSON.parse(row.record); } catch { record = null; }
    out[row.quote_number] = { at: row.created_at, decision: reviewDecision(record) };
  }
  return out;
}

/** Quotes the team sent to Ben from Cotiza, by Jobber quote id. */
export async function loadReviewRequests(db: D1Database, requestId: string): Promise<Record<string, string>> {
  const { results } = await db
    .prepare('SELECT jobber_quote_id, requested_at FROM lead_quote_reviews WHERE jobber_request_id = ?')
    .bind(requestId)
    .all<{ jobber_quote_id: string; requested_at: string }>();
  return Object.fromEntries((results ?? []).map((r) => [r.jobber_quote_id, r.requested_at]));
}

/** Quote ids with a review pending in Cotiza's older in-app review cycle (quote_drafts + quote_reviews). */
export async function loadLegacyPending(db: D1Database, requestId: string): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT DISTINCT d.jobber_quote_id FROM quote_drafts d
              JOIN quote_reviews r ON r.quote_draft_id = d.id
              WHERE d.jobber_request_id = ? AND r.status = 'pending_review' AND d.jobber_quote_id IS NOT NULL`)
    .bind(requestId)
    .all<{ jobber_quote_id: string }>();
  return (results ?? []).map((r) => r.jobber_quote_id);
}

/** Records that the team sent a quote to Ben for review (again, after edits, moves the date on). */
export async function requestReview(db: D1Database, requestId: string, quote: { id: string; number: string | null }, userId: string, now: number = Date.now()): Promise<string> {
  const at = new Date(now).toISOString();
  await db
    .prepare(`INSERT INTO lead_quote_reviews (jobber_quote_id, jobber_request_id, quote_number, requested_at, requested_by_user_id)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(jobber_quote_id) DO UPDATE SET requested_at = excluded.requested_at, requested_by_user_id = excluded.requested_by_user_id, quote_number = excluded.quote_number`)
    .bind(quote.id, requestId, quote.number, at, userId)
    .run();
  return at;
}

/** Everything computeQuoteStage needs for one request. The ledger read failing makes reviews 'unknown'. */
export async function gatherQuoteStage(db: D1Database, requestId: string, quotes: QuoteRef[]): Promise<QuoteStage> {
  const [reviews, requested, legacyPending] = await Promise.all([
    loadQuoteReviews(db, quotes.map((q) => q.number ?? '')).catch(() => 'unknown' as const),
    loadReviewRequests(db, requestId).catch(() => null),
    loadLegacyPending(db, requestId).catch(() => [] as string[]),
  ]);
  // Without the team's review requests we can't tell "with Ben" from "drafting": say so.
  return computeQuoteStage({ quotes, reviews: requested === null ? 'unknown' : reviews, requested: requested ?? {}, legacyPending });
}
