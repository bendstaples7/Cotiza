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

type Field<T> = { availability?: string; value?: T } | undefined;
export type RequestDetail = {
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

export function requestEvents(detail: RequestDetail): ContactEvent[] {
  const events: ContactEvent[] = [];
  const created = present(detail?.createdAt);
  if (created) events.push({ at: created, channel: 'request', direction: 'incoming', source: 'jobber', label: 'Request came in' });
  for (const note of detail?.notes ?? []) {
    if (!note.createdAt || (note.createdBy !== 'team' && note.createdBy !== 'client')) continue;
    const text = redactContactDetails((note.message ?? '').replace(/\s+/g, ' ').trim());
    if (!text) continue;
    events.push({
      at: note.createdAt,
      channel: 'note',
      direction: note.createdBy === 'client' ? 'incoming' : 'outgoing',
      source: 'jobber',
      label: note.createdBy === 'client' ? 'Note from customer' : 'Team note in Jobber',
      note: text.length > NOTE_SNIPPET ? `${text.slice(0, NOTE_SNIPPET - 1)}…` : text,
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
}): Promise<{ status: ContactStatus; logged: LoggedContact[] }> {
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
  return { status: computeContactStatus(events, nextSet, unavailable, now, notConnected), logged };
}
