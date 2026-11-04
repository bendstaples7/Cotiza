/**
 * Puts together a lead's contact history from every source (Jobber request and notes, Quo, Gmail,
 * contacts logged in Cotiza) and works out last and next contact. Used by the lead page and the
 * request queue. Contact details are used to look things up and are never returned.
 */
import type { EmailContextService } from './email-context-service.js';
import type { PhoneContextService } from './phone-context-service.js';
import {
  computeContactStatus,
  loggedToEvent,
  type ContactEvent,
  type ContactSource,
  type ContactStatus,
  type LeadContactService,
  type LoggedContact,
} from './lead-contact-service.js';
import type { LeadInfoItem } from './lead-info-service.js';
import { summarize } from './lead-info-service.js';
import { computeLeadWorkflow, type LeadWorkflow } from './lead-workflow.js';
import { isCotizaNote } from './jobber-request-notes.js';
import type { QuoteStage } from './lead-quote-stage.js';

type Field<T> = { availability?: string; value?: T } | undefined;
export type RequestDetail = {
  title?: Field<string>;
  createdAt?: Field<string>;
  phone?: Field<string>;
  email?: Field<string>;
  notes?: Array<{ message?: string; createdAt?: string | null; createdBy?: string }>;
} | null | undefined;

const present = <T,>(f: Field<T>): T | null => (f && f.availability === 'present' ? (f.value ?? null) : null);
const NOTE_SNIPPET = 140;
// Notes often carry a phone number or email; the status never repeats them.
const CONTACT_DETAILS = /[^\s@]+@[^\s@]+\.[a-z]{2,}|(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/gi;

export function redactContactDetails(text: string): string {
  return text.replace(CONTACT_DETAILS, '[contact]');
}

// The handbook has the team record every call, text and email in Jobber, so team notes are read for
// what they record. Plain wording only; anything unrecognised stays a note and does not move the cadence.
// A note that starts with the customer's own words ("Emma's text:", "CHRIS EMAILED:") is a reply.
const REPLY_PREFIX = /^\s*(?:[a-z]+(?:'|’)s\s+(?:text|email|reply|message|voicemail)|[a-z]+\s+(?:emailed|texted|replied|wrote|called back))\s*:/i;
const CONVERSATION_NOTE = /\b(?:call summary|spoke (?:with|to)|talked (?:with|to)|on the phone with)\b/i;
// "Spoke to voicemail" or an answering machine is outreach, not a conversation.
const NOT_A_CONVERSATION = /\b(?:voicemail|voice mail|vm|machine|no answer)\b/i;
// Customer-voiced notes ("Client texted", "Customer left a voicemail") are replies, unless the note is a call summary.
const CUSTOMER_VOICED = /\b(?:customer|client|homeowner)\s+(?:replied|responded|wrote|texted|emailed|called|sent|reached out|left|got back)\b|\b(?:missed call|voicemail|text|email|message) from (?:the )?(?:customer|client|homeowner)\b/i;
const OUTREACH_NOTE = /\b(?:no answer|left (?:a )?(?:vm|voicemail|message)|sent (?:an? )?(?:email|text|follow[- ]?up)|texted|emailed (?:the )?(?:customer|client|them|him|her)|followed up|reached out|called (?:the )?(?:customer|client|them|him|her))\b/i;

export type NoteKind = 'reply' | 'conversation' | 'outreach' | 'note';

export function classifyTeamNote(message: string): NoteKind {
  if (REPLY_PREFIX.test(message)) return 'reply';
  if (CONVERSATION_NOTE.test(message)) return NOT_A_CONVERSATION.test(message) ? 'outreach' : 'conversation';
  if (CUSTOMER_VOICED.test(message)) return 'reply';
  if (OUTREACH_NOTE.test(message)) return 'outreach';
  return 'note';
}

export function requestEvents(detail: RequestDetail): ContactEvent[] {
  const events: ContactEvent[] = [];
  const created = present(detail?.createdAt);
  if (created) events.push({ at: created, channel: 'request', direction: 'incoming', source: 'jobber', label: 'Request came in' });
  for (const note of detail?.notes ?? []) {
    if (!note.createdAt || (note.createdBy !== 'team' && note.createdBy !== 'client')) continue;
    // Cotiza's own notes repeat contacts already logged in Cotiza; counting them would double the touch.
    if (isCotizaNote(note.message)) continue;
    const raw = (note.message ?? '').replace(/\s+/g, ' ').trim();
    const text = redactContactDetails(raw);
    if (!text) continue;
    const kind: NoteKind = note.createdBy === 'client' ? 'note' : classifyTeamNote(raw);
    const fromClient = note.createdBy === 'client';
    events.push({
      at: note.createdAt,
      channel: 'note',
      direction: fromClient || kind === 'reply' ? 'incoming' : 'outgoing',
      source: 'jobber',
      label: fromClient ? 'Note from customer'
        : kind === 'reply' ? 'Customer reply (Jobber note)'
        : kind === 'conversation' ? 'Spoke with customer (Jobber note)'
        : kind === 'outreach' ? 'Outreach (Jobber note)'
        : 'Team note in Jobber',
      note: text.length > NOTE_SNIPPET ? `${text.slice(0, NOTE_SNIPPET - 1)}…` : text,
      ...(kind === 'reply' ? { reply: true } : {}),
      ...(kind === 'conversation' ? { conversation: true } : {}),
      ...(kind === 'outreach' ? { outreach: true } : {}),
    });
  }
  return events;
}

export async function gatherContactStatus(input: {
  requestId: string;
  detail: RequestDetail;
  requestFailed: boolean;
  contacts: LeadContactService;
  phone: PhoneContextService;
  email: EmailContextService;
  now: number;
}): Promise<{ status: ContactStatus; logged: LoggedContact[]; events: ContactEvent[]; nextSet: string | null }> {
  const { requestId, detail, contacts, phone, email, now } = input;
  const customerPhone = present(detail?.phone);
  const customerEmail = present(detail?.email);
  const [logged, nextSet, quo, gmail] = await Promise.all([
    contacts.list(requestId),
    contacts.nextContact(requestId),
    phone.isAvailable() && customerPhone ? phone.fetchActivityResult(customerPhone).catch(() => ({ status: 'failed' as const })) : Promise.resolve(null),
    email.isAvailable() && customerEmail ? email.fetchActivityResult(customerEmail).catch(() => ({ status: 'failed' as const })) : Promise.resolve(null),
  ]);

  const events: ContactEvent[] = [...requestEvents(detail), ...logged.map(loggedToEvent)];
  const unavailable: ContactSource[] = [];
  const notConnected: ContactSource[] = [];
  if (input.requestFailed) unavailable.push('jobber');
  if (!phone.isAvailable()) notConnected.push('quo');
  else if (quo?.status === 'failed') unavailable.push('quo');
  else if (quo?.status === 'ok') {
    for (const e of quo.events) {
      const out = e.direction === 'outgoing';
      const label = e.kind === 'text'
        ? (out ? 'Text sent' : 'Text from customer')
        : out ? (e.answered ? 'Call made' : 'Call made, no answer') : (e.answered ? 'Call from customer' : 'Missed call from customer');
      // An answered call is a conversation, whoever dialled: the customer heard from us.
      events.push({ at: e.at, channel: e.kind, direction: e.direction, source: 'quo', label, conversation: e.kind === 'call' && e.answered });
    }
  }
  if (!email.isAvailable()) notConnected.push('gmail');
  else if (gmail?.status === 'failed') unavailable.push('gmail');
  else if (gmail?.status === 'ok') {
    for (const e of gmail.events) {
      events.push({ at: e.at, channel: 'email', direction: e.direction, source: 'gmail', label: e.direction === 'outgoing' ? 'Email sent' : 'Email from customer' });
    }
  }
  return { status: computeContactStatus(events, nextSet, unavailable, now, notConnected), logged, events, nextSet };
}

/** The first open required question ("ask") on the checklist, which is what blocks the quote. */
export function firstOpenAsk(items: LeadInfoItem[]): string | null {
  const ask = items.find((i) => i.required && (i.status === 'open' || i.status === 'asked'));
  return ask ? ask.question : null;
}

/** Contact status plus what to do next, from the handbook cadence and the info-needed checklist. */
export async function gatherLeadWorkflow(input: Parameters<typeof gatherContactStatus>[0] & {
  items: LeadInfoItem[];
  /**
   * Jobber quotes on the request (statuses only). 'unknown' when they could not be read: a quote
   * may already be out, so no next step is offered (workflow null). Omit when not looked up.
   */
  quotes?: Array<{ status: string | null }> | 'unknown';
  /** Where the drafted quote is (with Ben, ready to send…), from lead-quote-stage.ts. */
  quoteStage?: QuoteStage | null;
}): Promise<{ status: ContactStatus; logged: LoggedContact[]; workflow: LeadWorkflow | null }> {
  const [gathered, notALead, closed] = await Promise.all([
    gatherContactStatus(input),
    input.contacts.notALead(input.requestId),
    input.contacts.closure(input.requestId),
  ]);
  if (input.quotes === 'unknown') return { status: gathered.status, logged: gathered.logged, workflow: null };
  const summary = summarize(input.items);
  const workflow = computeLeadWorkflow({
    events: gathered.events,
    nextSet: gathered.nextSet,
    info: { readyToQuote: summary.readyToQuote, total: summary.total, firstAsk: firstOpenAsk(input.items) },
    hasTitle: Boolean(present(input.detail?.title)?.trim()),
    notALead,
    quotes: input.quotes,
    quoteStage: input.quoteStage ?? null,
    closed,
    now: input.now,
  });
  return { status: gathered.status, logged: gathered.logged, workflow };
}
