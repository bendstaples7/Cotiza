/**
 * Last contact and next contact for a lead (one Jobber request).
 *
 * Last contact is the newest of: Quo texts and calls with the customer's number, Gmail messages
 * with the customer's address, notes on the Jobber request, the request itself, and contacts the
 * team logs in Cotiza. Next contact is the date the team set, or the handbook cadence's suggestion
 * (see lead-workflow.ts). Dates are Chicago calendar days.
 *
 * Contact details (numbers, addresses) are inputs only; nothing here stores or returns them.
 */
import { chicagoDate, handbookCadence } from './lead-workflow.js';

export { addBusinessDays, chicagoDate } from './lead-workflow.js';

export const CONTACT_CHANNELS = ['call', 'text', 'email', 'in_person', 'other'] as const;
export type ContactChannel = typeof CONTACT_CHANNELS[number];
export type ContactDirection = 'outgoing' | 'incoming';
export type ContactSource = 'quo' | 'gmail' | 'jobber' | 'cotiza';

/** One touchpoint with the customer, from any source. */
export interface ContactEvent {
  at: string;
  channel: ContactChannel | 'note' | 'request';
  direction: ContactDirection;
  source: ContactSource;
  /** Short plain label for the UI, e.g. "Text sent", "Call from customer". */
  label: string;
  note?: string | null;
  /** True for a call that connected: we spoke with the customer, whoever dialled. */
  conversation?: boolean;
  /** For a Jobber team note: it records outreach the customer received (text, call, email, voicemail). */
  outreach?: boolean;
  /** For a Jobber team note: it records a reply from the customer. */
  reply?: boolean;
  /** For a contact logged in Cotiza: the outreach step it completed (e.g. "intro_text", "quote_update"). */
  step?: string | null;
}

export interface LoggedContact {
  id: string;
  requestId: string;
  channel: ContactChannel;
  direction: ContactDirection;
  note: string | null;
  step: string | null;
  contactedAt: string;
  createdAt: string;
}

export interface NextContact {
  on: string;
  source: 'set' | 'suggested';
  overdue: boolean;
  dueToday: boolean;
  /** The cadence stage, e.g. "Step 2 · next day after intake". */
  reason: string;
}

export interface ContactStatus {
  last: ContactEvent | null;
  next: NextContact;
  /** Sources that could not be read; their events are missing, which is not the same as none. */
  unavailable: ContactSource[];
  /** Sources that are not connected to Cotiza at all (e.g. no Quo key). */
  notConnected: ContactSource[];
  /** Newest first, at most 15. */
  recent: ContactEvent[];
}

export class LeadContactError extends Error {}

const LOG_ID_RE = /^lct_[0-9a-f-]{36}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STEP_RE = /^[a-z_]{2,40}$/;
const MAX_NOTE = 500;
const CONTACT_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}|(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/i;

export { LOG_ID_RE };

const CHANNEL_LABEL: Record<ContactChannel, [string, string]> = {
  call: ['Call made', 'Call from customer'],
  text: ['Text sent', 'Text from customer'],
  email: ['Email sent', 'Email from customer'],
  in_person: ['Visited', 'Customer came by'],
  other: ['Reached out', 'Customer reached out'],
};

export function contactLabel(channel: ContactChannel, direction: ContactDirection): string {
  return CHANNEL_LABEL[channel][direction === 'outgoing' ? 0 : 1];
}

export function sortNewestFirst(events: ContactEvent[]): ContactEvent[] {
  const ms = (e: ContactEvent) => { const t = Date.parse(e.at); return Number.isFinite(t) ? t : -Infinity; };
  return [...events].sort((a, b) => ms(b) - ms(a));
}

export function computeContactStatus(
  events: ContactEvent[],
  nextSet: string | null,
  unavailable: ContactSource[],
  now: number,
  notConnected: ContactSource[] = [],
): ContactStatus {
  const recent = sortNewestFirst(events.filter((e) => Number.isFinite(Date.parse(e.at))));
  const today = chicagoDate(now);
  const cadence = handbookCadence(recent, now);
  const on = nextSet ?? cadence.suggested;
  return {
    last: recent[0] ?? null,
    next: {
      on,
      source: nextSet ? 'set' : 'suggested',
      overdue: on < today,
      dueToday: on === today,
      reason: nextSet ? 'Set by the team' : cadence.stage,
    },
    unavailable,
    notConnected,
    recent: recent.slice(0, 15),
  };
}

// ── Storage ────────────────────────────────────────────────────

type ContactRow = {
  id: string; jobber_request_id: string; channel: ContactChannel; direction: ContactDirection; note: string | null;
  step: string | null; contacted_at: string; created_at: string;
};

function toLogged(row: ContactRow): LoggedContact {
  return {
    id: row.id, requestId: row.jobber_request_id, channel: row.channel, direction: row.direction, note: row.note,
    step: row.step, contactedAt: row.contacted_at, createdAt: row.created_at,
  };
}

export function loggedToEvent(contact: LoggedContact): ContactEvent {
  return {
    at: contact.contactedAt,
    channel: contact.channel,
    direction: contact.direction,
    source: 'cotiza',
    label: contactLabel(contact.channel, contact.direction),
    note: contact.note,
    step: contact.step,
  };
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LeadContactError('Send the contact as an object.');
  return input as Record<string, unknown>;
}

/** Checks a contact to log. contactedAt defaults to now and may not be in the future. */
export function validateContact(input: unknown, now: number): { channel: ContactChannel; direction: ContactDirection; note: string | null; step: string | null; contactedAt: string } {
  const raw = objectInput(input);
  for (const key of Object.keys(raw)) {
    if (!['channel', 'direction', 'note', 'step', 'contactedAt'].includes(key)) throw new LeadContactError(`Unknown field: ${key}`);
  }
  if (!CONTACT_CHANNELS.includes(raw.channel as ContactChannel)) throw new LeadContactError(`channel must be one of ${CONTACT_CHANNELS.join(', ')}.`);
  const direction = raw.direction === undefined ? 'outgoing' : raw.direction;
  if (direction !== 'outgoing' && direction !== 'incoming') throw new LeadContactError('direction must be outgoing or incoming.');
  let note: string | null = null;
  if (raw.note !== undefined && raw.note !== null && raw.note !== '') {
    if (typeof raw.note !== 'string') throw new LeadContactError('note must be text.');
    note = raw.note.replace(/\r\n/g, '\n').trim();
    if (note.length > MAX_NOTE) throw new LeadContactError(`note must be at most ${MAX_NOTE} characters.`);
    if (CONTACT_RE.test(note)) throw new LeadContactError('note looks like it contains a phone number or email. Keep contact details in Jobber.');
    if (!note) note = null;
  }
  let step: string | null = null;
  if (raw.step !== undefined && raw.step !== null) {
    if (typeof raw.step !== 'string' || !STEP_RE.test(raw.step)) throw new LeadContactError('step is not a valid outreach step.');
    step = raw.step;
  }
  let contactedAt = new Date(now).toISOString();
  if (raw.contactedAt !== undefined) {
    const ms = typeof raw.contactedAt === 'string' ? Date.parse(raw.contactedAt) : NaN;
    if (!Number.isFinite(ms)) throw new LeadContactError('contactedAt must be a date and time.');
    if (ms > now + 5 * 60_000) throw new LeadContactError('contactedAt cannot be in the future.');
    contactedAt = new Date(ms).toISOString();
  }
  return { channel: raw.channel as ContactChannel, direction, note, step, contactedAt };
}

export function validateNextContactDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`))) {
    throw new LeadContactError('nextContactOn must be a date (YYYY-MM-DD) or null.');
  }
  return value;
}

export class LeadContactService {
  constructor(private db: D1Database) {}

  async list(requestId: string): Promise<LoggedContact[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM lead_contacts WHERE jobber_request_id = ? ORDER BY contacted_at DESC LIMIT 50')
      .bind(requestId)
      .all<ContactRow>();
    return (results ?? []).map(toLogged);
  }

  async log(requestId: string, input: unknown, userId: string, now: number = Date.now()): Promise<LoggedContact> {
    const contact = validateContact(input, now);
    const id = `lct_${crypto.randomUUID()}`;
    const createdAt = new Date(now).toISOString();
    await this.db
      .prepare('INSERT INTO lead_contacts (id, jobber_request_id, channel, direction, note, step, contacted_at, created_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, requestId, contact.channel, contact.direction, contact.note, contact.step, contact.contactedAt, createdAt, userId)
      .run();
    return { id, requestId, ...contact, createdAt };
  }

  /** Each outreach step's first completion, however many contacts have been logged since. */
  async completedSteps(requestId: string): Promise<Array<{ step: string; contactedAt: string }>> {
    const { results } = await this.db
      .prepare('SELECT step, MIN(contacted_at) AS contacted_at FROM lead_contacts WHERE jobber_request_id = ? AND step IS NOT NULL GROUP BY step')
      .bind(requestId)
      .all<{ step: string; contacted_at: string }>();
    return (results ?? []).map((r) => ({ step: r.step, contactedAt: r.contacted_at }));
  }

  async nextContact(requestId: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT next_contact_on FROM lead_followups WHERE jobber_request_id = ?').bind(requestId).first<{ next_contact_on: string }>();
    return row?.next_contact_on ?? null;
  }

  async setNextContact(requestId: string, value: unknown, userId: string, now: number = Date.now()): Promise<string | null> {
    const on = validateNextContactDate(value);
    if (on === null) {
      await this.db.prepare('DELETE FROM lead_followups WHERE jobber_request_id = ?').bind(requestId).run();
      return null;
    }
    await this.db
      .prepare('INSERT INTO lead_followups (jobber_request_id, next_contact_on, updated_at, updated_by_user_id) VALUES (?, ?, ?, ?) ON CONFLICT(jobber_request_id) DO UPDATE SET next_contact_on = excluded.next_contact_on, updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id')
      .bind(requestId, on, new Date(now).toISOString(), userId)
      .run();
    return on;
  }

  async notALead(requestId: string): Promise<boolean> {
    const row = await this.db.prepare('SELECT not_a_lead FROM lead_marks WHERE jobber_request_id = ?').bind(requestId).first<{ not_a_lead: number }>();
    return row?.not_a_lead === 1;
  }

  /**
   * Marks a lead as not a real lead (true) or clears the mark (false). changed is true only for the
   * one call that actually flipped the mark, so concurrent identical calls don't each act on it.
   * The row may also hold the lead's closure (closeLead), which clearing the mark keeps.
   */
  async setNotALead(requestId: string, value: unknown, userId: string, now: number = Date.now()): Promise<{ notALead: boolean; changed: boolean }> {
    if (typeof value !== 'boolean') throw new LeadContactError('notALead must be true or false.');
    const at = new Date(now).toISOString();
    if (!value) {
      const res = await this.db.prepare('UPDATE lead_marks SET not_a_lead = 0, updated_at = ?, updated_by_user_id = ? WHERE jobber_request_id = ? AND not_a_lead = 1').bind(at, userId, requestId).run();
      await this.dropEmptyMark(requestId);
      return { notALead: false, changed: Boolean(res.meta?.changes) };
    }
    const res = await this.db
      .prepare(`INSERT INTO lead_marks (jobber_request_id, not_a_lead, updated_at, updated_by_user_id) VALUES (?, 1, ?, ?)
                ON CONFLICT(jobber_request_id) DO UPDATE SET not_a_lead = 1, updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id
                WHERE lead_marks.not_a_lead = 0`)
      .bind(requestId, at, userId)
      .run();
    return { notALead: true, changed: Boolean(res.meta?.changes) };
  }

  private async dropEmptyMark(requestId: string) {
    await this.db.prepare('DELETE FROM lead_marks WHERE jobber_request_id = ? AND not_a_lead = 0 AND closed_reason IS NULL').bind(requestId).run();
  }

  // ── Closing a lead ──────────────────────────────────────────

  async closure(requestId: string): Promise<LeadClosure | null> {
    const row = await this.db
      .prepare('SELECT closed_reason, closed_note, check_back_on, closed_at, jobber_archived FROM lead_marks WHERE jobber_request_id = ? AND closed_reason IS NOT NULL')
      .bind(requestId)
      .first<ClosureRow>();
    return row ? toClosure(row) : null;
  }

  /** Every closed lead, by request id (a short list: closed leads leave the queue). */
  async closures(): Promise<Map<string, LeadClosure>> {
    const { results } = await this.db
      .prepare('SELECT jobber_request_id, closed_reason, closed_note, check_back_on, closed_at, jobber_archived FROM lead_marks WHERE closed_reason IS NOT NULL')
      .all<ClosureRow & { jobber_request_id: string }>();
    return new Map((results ?? []).map((r) => [r.jobber_request_id, toClosure(r)]));
  }

  /**
   * Closes a lead with a reason. changed is false when it was already closed (the existing closure
   * stands; reopen first to change it), so a double click never closes, notes or archives twice.
   */
  async closeLead(requestId: string, input: unknown, userId: string, now: number = Date.now()): Promise<{ closure: LeadClosure; changed: boolean }> {
    const close = validateClose(input, now);
    const at = new Date(now).toISOString();
    const res = await this.db
      .prepare(`INSERT INTO lead_marks (jobber_request_id, not_a_lead, closed_reason, closed_note, check_back_on, closed_at, closed_by_user_id, jobber_archived, updated_at, updated_by_user_id)
                VALUES (?, 0, ?, ?, ?, ?, ?, 0, ?, ?)
                ON CONFLICT(jobber_request_id) DO UPDATE SET closed_reason = excluded.closed_reason, closed_note = excluded.closed_note,
                  check_back_on = excluded.check_back_on, closed_at = excluded.closed_at, closed_by_user_id = excluded.closed_by_user_id,
                  jobber_archived = 0, updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id
                WHERE lead_marks.closed_reason IS NULL`)
      .bind(requestId, close.reason, close.note, close.checkBackOn, at, userId, at, userId)
      .run();
    const closure = await this.closure(requestId);
    if (!closure) throw new LeadContactError('The lead could not be closed.');
    return { closure, changed: Boolean(res.meta?.changes) };
  }

  /** Reopens a closed lead. Returns the closure it cleared (null when it wasn't closed). */
  async reopenLead(requestId: string, userId: string, now: number = Date.now()): Promise<LeadClosure | null> {
    const before = await this.closure(requestId);
    if (!before) return null;
    const res = await this.db
      .prepare(`UPDATE lead_marks SET closed_reason = NULL, closed_note = NULL, check_back_on = NULL, closed_at = NULL, closed_by_user_id = NULL,
                  jobber_archived = 0, updated_at = ?, updated_by_user_id = ?
                WHERE jobber_request_id = ? AND closed_reason IS NOT NULL`)
      .bind(new Date(now).toISOString(), userId, requestId)
      .run();
    await this.dropEmptyMark(requestId);
    return res.meta?.changes ? before : null;
  }

  async setJobberArchived(requestId: string, archived: boolean): Promise<void> {
    await this.db.prepare('UPDATE lead_marks SET jobber_archived = ? WHERE jobber_request_id = ?').bind(archived ? 1 : 0, requestId).run();
  }

  /** After a check-back on a postponed lead, the next one is due three months on (the handbook's postponed cadence). */
  async pushCheckBack(requestId: string, now: number = Date.now()): Promise<string | null> {
    const next = addMonths(chicagoDate(now), POSTPONE_MONTHS);
    const res = await this.db
      .prepare("UPDATE lead_marks SET check_back_on = ? WHERE jobber_request_id = ? AND closed_reason = 'postponed'")
      .bind(next, requestId)
      .run();
    return res.meta?.changes ? next : null;
  }
}

// ── Closure helpers ──────────────────────────────────────────

export const CLOSE_REASONS = {
  went_elsewhere: 'Went with someone else',
  too_small: 'Too small or not our work',
  no_response: 'No response',
  postponed: 'Postponed',
  other: 'Other',
} as const;
export type CloseReason = keyof typeof CLOSE_REASONS;
/** The handbook: a postponed lead gets a follow-up every 3 months. */
export const POSTPONE_MONTHS = 3;

export interface LeadClosure {
  reason: CloseReason;
  label: string;
  note: string | null;
  /** Postponed only: the day the lead comes back to Do now. */
  checkBackOn: string | null;
  closedAt: string;
  jobberArchived: boolean;
}

type ClosureRow = { closed_reason: CloseReason; closed_note: string | null; check_back_on: string | null; closed_at: string | null; jobber_archived: number | null };

function toClosure(row: ClosureRow): LeadClosure {
  return {
    reason: row.closed_reason,
    label: CLOSE_REASONS[row.closed_reason] ?? 'Closed',
    note: row.closed_note,
    checkBackOn: row.check_back_on,
    closedAt: row.closed_at ?? '',
    jobberArchived: row.jobber_archived === 1,
  };
}

/** YYYY-MM-DD plus n calendar months, clamped to the month's last day (Nov 30 + 3 → Feb 28). */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** Checks a close request: a known reason; Postponed gets a future check-back date (default 3 months); Other needs a note. */
export function validateClose(input: unknown, now: number): { reason: CloseReason; note: string | null; checkBackOn: string | null } {
  const raw = objectInput(input);
  for (const key of Object.keys(raw)) {
    if (!['reason', 'note', 'checkBackOn'].includes(key)) throw new LeadContactError(`Unknown field: ${key}`);
  }
  if (typeof raw.reason !== 'string' || !(raw.reason in CLOSE_REASONS)) {
    throw new LeadContactError(`reason must be one of ${Object.keys(CLOSE_REASONS).join(', ')}.`);
  }
  const reason = raw.reason as CloseReason;
  let note: string | null = null;
  if (raw.note !== undefined && raw.note !== null && raw.note !== '') {
    if (typeof raw.note !== 'string') throw new LeadContactError('note must be text.');
    note = raw.note.replace(/\s+/g, ' ').trim() || null;
    if (note && note.length > 200) throw new LeadContactError('note must be at most 200 characters.');
    if (note && CONTACT_RE.test(note)) throw new LeadContactError('note looks like it contains a phone number or email. Keep contact details in Jobber.');
  }
  if (reason === 'other' && !note) throw new LeadContactError('Add a short note saying why the lead is closed.');
  const today = chicagoDate(now);
  let checkBackOn: string | null = null;
  if (reason === 'postponed') {
    if (raw.checkBackOn === undefined || raw.checkBackOn === null || raw.checkBackOn === '') {
      checkBackOn = addMonths(today, POSTPONE_MONTHS);
    } else {
      checkBackOn = validateNextContactDate(raw.checkBackOn);
      if (!checkBackOn || checkBackOn <= today) throw new LeadContactError('The check-back date must be after today.');
    }
  } else if (raw.checkBackOn !== undefined && raw.checkBackOn !== null && raw.checkBackOn !== '') {
    throw new LeadContactError('Only a postponed lead has a check-back date.');
  }
  return { reason, note, checkBackOn };
}
