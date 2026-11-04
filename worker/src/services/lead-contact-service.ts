/**
 * Last contact and next contact for a lead (one Jobber request).
 *
 * Last contact is the newest of: Quo texts and calls with the customer's number, Gmail messages
 * with the customer's address, notes on the Jobber request, the request itself, and contacts the
 * team logs in Cotiza. Next contact is the date the team set, or a suggestion from a simple cadence:
 * when the customer spoke last, today; after our own outreach with no reply, 1, then 2, then 4
 * business days later. Dates are Chicago calendar days.
 *
 * Contact details (numbers, addresses) are inputs only; nothing here stores or returns them.
 */

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

const CADENCE = [1, 2, 4];

/**
 * Suggested next contact from the events: today when the customer reached out last (or nobody
 * has reached out yet); the next business day after a call where we spoke with them; after our
 * outreach with no reply, 1, 2, then 4 business days after the latest attempt (4 thereafter).
 */
export function suggestNextContact(events: ContactEvent[], now: number): { on: string; reason: string } {
  const today = chicagoDate(now);
  const sorted = sortNewestFirst(events);
  const outreach: ContactEvent[] = [];
  let stop: ContactEvent | undefined;
  for (const event of sorted) {
    if (event.direction === 'incoming' || event.conversation) { stop = event; break; }
    // Team notes record work on the lead, not a message the customer received.
    if (event.channel === 'note') continue;
    outreach.push(event);
  }
  if (outreach.length === 0) {
    if (stop?.conversation && stop.direction === 'outgoing') {
      return { on: addBusinessDays(chicagoDate(Date.parse(stop.at)), 1), reason: 'Spoke with the customer; follow up' };
    }
    return { on: today, reason: stop && stop.channel !== 'request' ? 'Customer replied; get back to them' : 'No outreach yet' };
  }
  const step = CADENCE[Math.min(outreach.length, CADENCE.length) - 1];
  const due = addBusinessDays(chicagoDate(Date.parse(outreach[0].at)), step);
  const attempts = outreach.length === 1 ? '1 attempt' : `${outreach.length} attempts`;
  return { on: due, reason: `No reply after ${attempts}; follow up` };
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
  const suggestion = suggestNextContact(recent, now);
  const on = nextSet ?? suggestion.on;
  return {
    last: recent[0] ?? null,
    next: {
      on,
      source: nextSet ? 'set' : 'suggested',
      overdue: on < today,
      dueToday: on === today,
      reason: nextSet ? 'Set by the team' : suggestion.reason,
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
}
