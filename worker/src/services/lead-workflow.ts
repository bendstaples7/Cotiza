/**
 * What the team should do next on a lead, and when. Pure: no I/O, so the request queue, the lead
 * page and the list_open_leads tool all agree.
 *
 * The follow-up cadence is the Chicago Reno handbook's "Lead Follow-Up Schedule" for new leads
 * and leads waiting on photos or information:
 *   1 Intake      reach out the day the lead comes in
 *   2 Next day    follow up the business day after
 *   3 Every 2–3   business days (we use 2) until photos or requested info are received
 *   4 Weekly      after 3 unanswered step-3 touches
 *   5 Monthly     after 3 unanswered weekly touches, until they reply or the lead is closed
 * When the customer contacted us last, they get an answer the same day; after we answer, the
 * count restarts at step 3. A date the team sets by hand always wins.
 *
 * The handbook also says a lead with no quote 3+ days after it came in gets a "still working on
 * your quote" update.
 */
import type { ContactEvent } from './lead-contact-service.js';

// ── Chicago calendar days ──────────────────────────────────────

const chicagoDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });

/** YYYY-MM-DD in Chicago for an instant. */
export function chicagoDate(ms: number): string {
  return chicagoDay.format(new Date(ms));
}

/** Adds business days (Mon–Fri) to a YYYY-MM-DD date. */
export function addBusinessDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole calendar days from a to b (both YYYY-MM-DD); negative when b is earlier. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);
}

// ── Cadence ────────────────────────────────────────────────────

export type CadenceStep = 1 | 2 | 3 | 4 | 5 | 'replied';

export const STEP_LABEL: Record<Exclude<CadenceStep, 'replied'>, string> = {
  1: 'Step 1 · reach out on intake',
  2: 'Step 2 · next day after intake',
  3: 'Step 3 · every 2–3 business days',
  4: 'Step 4 · weekly',
  5: 'Step 5 · monthly',
};
export const REPLIED_LABEL = 'Customer replied → answer same day';

/** Customer events this close to the request are part of intake (form attachments), not a reply. */
const INTAKE_WINDOW_MS = 60 * 60_000;
/** Touches at each of steps 3 and 4 before moving on. */
const TOUCHES_PER_STEP = 3;

export interface Cadence {
  step: CadenceStep;
  stage: string;
  /** Suggested next contact (YYYY-MM-DD), before any date the team set. */
  suggested: string;
  /** Our outreach since the customer last engaged (or since intake), oldest first. */
  touches: ContactEvent[];
  /** The customer's latest reply or a call where we spoke; null when they never engaged. */
  engaged: ContactEvent | null;
  /** Outreach count used for the step table (touches, plus credit for an engagement). */
  count: number;
}

const ms = (e: ContactEvent) => { const t = Date.parse(e.at); return Number.isFinite(t) ? t : NaN; };

/** Outreach the customer received from us: texts, calls, emails, visits, and Jobber notes that record outreach. */
export function isOutreach(e: ContactEvent): boolean {
  if (e.direction !== 'outgoing' || e.conversation) return false;
  if (e.channel === 'request') return false;
  if (e.channel === 'note') return e.outreach === true;
  return true;
}

function intakeTime(events: ContactEvent[]): number | null {
  const request = events.find((e) => e.channel === 'request');
  const t = request ? ms(request) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** Engagement: the customer reached out (after intake), or we spoke on a call. */
export function isEngagement(e: ContactEvent, intake: number | null): boolean {
  if (e.conversation) return true;
  if (e.direction !== 'incoming' || e.channel === 'request') return false;
  // Around intake, a client note or email is the request form itself (attachments, auto email).
  if (intake !== null && Math.abs(ms(e) - intake) <= INTAKE_WINDOW_MS && e.channel !== 'text' && e.channel !== 'call') return false;
  return true;
}

function stepFor(count: number): Exclude<CadenceStep, 'replied'> {
  if (count <= 0) return 1;
  if (count === 1) return 2;
  if (count < 2 + TOUCHES_PER_STEP) return 3;
  if (count < 2 + TOUCHES_PER_STEP * 2) return 4;
  return 5;
}

export function handbookCadence(events: ContactEvent[], now: number): Cadence {
  const sorted = events.filter((e) => Number.isFinite(ms(e))).sort((a, b) => ms(a) - ms(b));
  const intake = intakeTime(sorted);
  const today = chicagoDate(now);
  let engaged: ContactEvent | null = null;
  for (const e of sorted) if (isEngagement(e, intake)) engaged = e;
  const since = engaged ? ms(engaged) : -Infinity;
  const touches = sorted.filter((e) => isOutreach(e) && ms(e) > since);

  if (engaged && engaged.direction === 'incoming' && touches.length === 0) {
    return { step: 'replied', stage: REPLIED_LABEL, suggested: chicagoDate(ms(engaged)), touches, engaged, count: 0 };
  }
  // After the customer engaged we pick up at step 3: a reply we answered counts as touches 1–2,
  // a call where we spoke counts the same with the answer already given.
  const credit = engaged ? (engaged.conversation ? 2 : 1) : 0;
  const count = touches.length + credit;
  const step = stepFor(count);
  const lastAt = touches.length ? ms(touches[touches.length - 1]) : engaged ? ms(engaged) : intake;
  const lastDay = lastAt !== null ? chicagoDate(lastAt) : today;
  const suggested = step === 1 ? (intake !== null ? chicagoDate(intake) : today)
    : step === 2 ? addBusinessDays(lastDay, 1)
    : step === 3 ? addBusinessDays(lastDay, 2)
    : step === 4 ? addBusinessDays(lastDay, 5)
    : addDays(lastDay, 30);
  return { step, stage: STEP_LABEL[step], suggested, touches, engaged, count };
}

// ── Next action ────────────────────────────────────────────────

export type LeadBucket = 'do_now' | 'waiting' | 'review';
export type LeadActionKind = 'intro_text' | 'reply' | 'ask_info' | 'quote_update' | 'draft_quote' | 'quote_follow_up' | 'follow_up' | 'review' | 'none';
export type LeadProgress = 'lead_in' | 'getting_info' | 'ready_to_quote' | 'quote_drafted' | 'quote_sent';
export type PlanState = 'done' | 'missed' | 'due' | 'upcoming';

export interface LeadAction {
  kind: LeadActionKind;
  /** Button text, e.g. "Send intro text", "Text: ask for photos". */
  label: string;
  /** One short line on why this is next. */
  why: string;
  /** Logged-contact step this action completes. */
  step: string;
  channel: 'text' | 'call' | 'email' | 'other';
}

export interface PlanRow {
  label: string;
  detail: string;
  state: PlanState;
}

export interface LeadWorkflow {
  bucket: LeadBucket;
  step: CadenceStep;
  stage: string;
  next: { on: string; source: 'set' | 'suggested'; overdue: boolean; dueToday: boolean; daysOverdue: number };
  action: LeadAction;
  progress: LeadProgress;
  /** Days since the lead came in (Chicago calendar days), null when unknown. */
  ageDays: number | null;
  /** True when this lead sits in Review because it looks like it isn't a real project. */
  likelySpam: boolean;
  notALead: boolean;
  plan: PlanRow[];
}

export interface WorkflowInput {
  events: ContactEvent[];
  nextSet: string | null;
  info: { readyToQuote: boolean; total: number; firstAsk: string | null };
  hasTitle: boolean;
  notALead: boolean;
  /** Jobber quotes on the request, when known. Open leads normally have none (Jobber marks a quoted request converted). */
  quotes?: Array<{ status: string | null }>;
  now: number;
}

/** A few words for the first open ask, for a button: "photos", "a site visit", "measurements"… */
export function shortAsk(question: string): string {
  const q = question.replace(/^(assumed|optional):\s*/i, '').trim();
  if (/\b(photo|photos|picture|pictures|video|pics)\b/i.test(q)) return 'photos';
  if (/\b(site visit|come by|come over|come out|walk ?through|stop by)\b/i.test(q)) return 'a site visit';
  if (/\bmeasure/i.test(q)) return 'measurements';
  if (/\bbudget\b/i.test(q)) return 'their budget';
  const words = q.replace(/^(can|could|would|will|do|does|is|are) (you|we|they)\s+/i, '').replace(/[?.!:]+$/, '').split(/\s+/).slice(0, 5).join(' ');
  return words.length > 0 ? words.toLowerCase() : 'the missing details';
}

const QUOTE_UPDATE_AFTER_DAYS = 3;
const QUOTE_UPDATE_REPEAT_DAYS = 3;

function formatShortDay(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function planRows(c: Cadence, next: LeadWorkflow['next'], today: string): PlanRow[] {
  const rows: PlanRow[] = [];
  const touchDay = (i: number) => (c.touches[i] ? formatShortDay(chicagoDate(ms(c.touches[i]))) : '');
  const currentState: PlanState = next.overdue ? 'missed' : 'due';
  const currentDetail = next.overdue
    ? `Missed: was due ${formatShortDay(next.on)}. Do it today.`
    : next.on === today ? 'Due today' : `Next: ${formatShortDay(next.on)}`;

  if (c.engaged) {
    const day = formatShortDay(chicagoDate(ms(c.engaged)));
    if (c.step === 'replied') {
      rows.push({ label: `${day} · Customer replied`, detail: next.overdue ? `Missed: answer them today.` : 'Answer them today', state: currentState });
    } else {
      rows.push({ label: `${day} · ${c.engaged.conversation ? 'Spoke with the customer' : 'Customer replied'}`, detail: c.engaged.label, state: 'done' });
    }
  } else {
    rows.push(c.count >= 1
      ? { label: 'Intake', detail: `${touchDay(0)} · ${c.touches[0].label}`, state: 'done' }
      : { label: 'Intake', detail: currentDetail, state: currentState });
    rows.push(c.count >= 2
      ? { label: 'Next day', detail: `${touchDay(1)} · ${c.touches[1].label}`, state: 'done' }
      : { label: 'Next day', detail: c.step === 2 ? currentDetail : 'The business day after intake', state: c.step === 2 ? currentState : 'upcoming' });
  }
  const group = (label: string, stepNo: 3 | 4, start: number, what: string): PlanRow => {
    const done = Math.max(0, Math.min(TOUCHES_PER_STEP, c.count - start));
    if (c.step === stepNo) return { label, detail: `${done} of ${TOUCHES_PER_STEP} done · ${currentDetail}`, state: currentState };
    if (done >= TOUCHES_PER_STEP) return { label, detail: `${TOUCHES_PER_STEP} of ${TOUCHES_PER_STEP} done`, state: 'done' };
    return { label, detail: what, state: 'upcoming' };
  };
  rows.push(group('Every 2–3 business days', 3, 2, 'Until we have the photos or info we need'));
  rows.push(group('Weekly', 4, 2 + TOUCHES_PER_STEP, 'If they go quiet'));
  rows.push(c.step === 5
    ? { label: 'Monthly', detail: currentDetail, state: currentState }
    : { label: 'Monthly', detail: 'After several weekly tries, until they reply or we close it', state: 'upcoming' });
  return rows;
}

export function computeLeadWorkflow(input: WorkflowInput): LeadWorkflow {
  const { events, nextSet, info, now } = input;
  const today = chicagoDate(now);
  const cadence = handbookCadence(events, now);
  const on = nextSet ?? cadence.suggested;
  const daysOverdue = Math.max(0, daysBetween(on, today));
  const next = { on, source: (nextSet ? 'set' : 'suggested') as 'set' | 'suggested', overdue: on < today, dueToday: on === today, daysOverdue };

  const request = events.find((e) => e.channel === 'request');
  const created = request ? Date.parse(request.at) : NaN;
  const ageDays = Number.isFinite(created) ? Math.max(0, daysBetween(chicagoDate(created), today)) : null;
  const teamNotes = events.some((e) => e.channel === 'note' && e.direction === 'outgoing');
  const likelySpam = !input.notALead && !input.hasTitle && !teamNotes && cadence.touches.length === 0 && !cadence.engaged
    && info.total === 0 && (ageDays ?? 0) >= 3;
  const quoteUpdateRecent = events.some((e) => e.step === 'quote_update' && Date.parse(e.at) >= now - QUOTE_UPDATE_REPEAT_DAYS * 86400_000);

  // Jobber quote states: draft; sent and waiting on the customer; or settled (approved / converted to a job).
  const quoteStatuses = (input.quotes ?? []).map((q) => String(q.status ?? '').toLowerCase()).filter((st) => st && st !== 'archived');
  const quoteSettled = quoteStatuses.some((st) => st === 'approved' || st === 'converted');
  const quoteSent = quoteSettled || quoteStatuses.some((st) => st === 'awaiting_response' || st === 'changes_requested');
  const quoteDrafted = quoteStatuses.length > 0;
  const oldNoQuote = (ageDays ?? 0) >= QUOTE_UPDATE_AFTER_DAYS && !quoteUpdateRecent;

  let action: LeadAction;
  if (input.notALead) {
    action = { kind: 'review', label: 'Archive in Jobber', why: 'Marked as not a lead. Archive it in Jobber to clear it.', step: 'review', channel: 'other' };
  } else if (quoteSettled) {
    action = { kind: 'none', label: 'Quote approved', why: 'The customer approved the quote. Nothing to chase here; schedule the job in Jobber.', step: 'none', channel: 'other' };
  } else if (quoteSent) {
    action = { kind: 'quote_follow_up', label: 'Follow up on the quote', why: 'A quote has gone out. Make sure they got it and answer questions.', step: 'quote_follow_up', channel: 'text' };
  } else if (cadence.step === 'replied') {
    // Their message gets an answer today. When we can quote, the answer is that the quote is coming.
    action = !info.readyToQuote
      ? { kind: 'reply', label: 'Reply today', why: 'They got back to us. Answer the same day.', step: 'reply', channel: 'text' }
      : quoteDrafted || !oldNoQuote
        ? { kind: 'draft_quote', label: quoteDrafted ? 'Finish the quote' : 'Draft quote', why: 'They replied and we have what we need to quote. Answer them, then get the quote out.', step: 'draft_quote', channel: 'other' }
        : { kind: 'quote_update', label: 'Reply: quote is coming', why: `They replied and the lead is ${ageDays} days old with no quote. Answer today and let them know it’s coming.`, step: 'quote_update', channel: 'text' };
  } else if (quoteDrafted) {
    action = { kind: 'draft_quote', label: 'Finish the quote', why: 'A draft quote is in Jobber. Finish it and send it.', step: 'draft_quote', channel: 'other' };
  } else if (cadence.count === 0) {
    action = { kind: 'intro_text', label: 'Send intro text', why: likelySpam ? 'No project described yet. Send one intro text or mark it not a lead.' : 'Nobody has contacted them yet.', step: 'intro_text', channel: 'text' };
  } else if (info.readyToQuote && oldNoQuote) {
    action = { kind: 'quote_update', label: 'Send “quote in progress” text', why: `Lead is ${ageDays} days old with no quote. Let them know it’s coming.`, step: 'quote_update', channel: 'text' };
  } else if (info.readyToQuote) {
    action = { kind: 'draft_quote', label: 'Draft quote', why: 'We have what we need to quote.', step: 'draft_quote', channel: 'other' };
  } else if (info.firstAsk) {
    const ask = shortAsk(info.firstAsk);
    action = { kind: 'ask_info', label: `Text: ask for ${ask}`, why: `Still need ${ask} to quote.`, step: 'follow_up', channel: 'text' };
  } else {
    action = { kind: 'follow_up', label: 'Follow up', why: 'No checklist yet. Check in and find out what we need.', step: 'follow_up', channel: 'text' };
  }

  const bucket: LeadBucket = input.notALead || likelySpam ? 'review'
    : quoteSettled ? 'waiting'
    : ((info.readyToQuote || quoteDrafted) && !quoteSent) || next.overdue || next.dueToday ? 'do_now'
    : 'waiting';
  const progress: LeadProgress = quoteSent ? 'quote_sent'
    : quoteDrafted ? 'quote_drafted'
    : info.readyToQuote ? 'ready_to_quote'
    : cadence.count === 0 && !cadence.engaged ? 'lead_in'
    : 'getting_info';

  return {
    bucket,
    step: cadence.step,
    stage: nextSet ? `${cadence.stage} · date set by the team` : cadence.stage,
    next,
    action,
    progress,
    ageDays,
    likelySpam,
    notALead: input.notALead,
    plan: planRows(cadence, next, today),
  };
}
