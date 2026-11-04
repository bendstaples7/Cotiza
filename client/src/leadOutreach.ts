/**
 * Proposed outreach for a lead, built from what Cotiza already knows: the client's first name,
 * the project title, the questions still open, and the assumptions the quote will rest on.
 * Deterministic (no AI), in Chicago Reno's own voice, so the team can send it as-is or edit it.
 */
import type { LeadInfoItem } from './api';

export const ASSUMED_PREFIX = /^assumed:\s*/i;
export const OPTIONAL_PREFIX = /^optional:\s*/i;

export type ItemKind = 'ask' | 'assumption' | 'optional';

/** Required items are asks; "Assumed: …" lines are assumptions; other non-required items are optional asks. */
export function itemKind(item: LeadInfoItem): ItemKind {
  if (ASSUMED_PREFIX.test(item.question)) return 'assumption';
  return item.required ? 'ask' : 'optional';
}

export function stripPrefix(question: string): string {
  return question.replace(ASSUMED_PREFIX, '').replace(OPTIONAL_PREFIX, '').trim();
}

function firstName(clientName: string | null): string {
  const first = (clientName ?? '').trim().split(/\s+/)[0] ?? '';
  return first && first.toLowerCase() !== 'unknown' ? first : 'there';
}

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

function sentence(text: string): string {
  const t = text.trim();
  return /[.?!]$/.test(t) ? t : `${t}.`;
}

export interface OutreachMessages {
  text: string;
  emailSubject: string;
  emailBody: string;
  asks: string[];
  assumptions: string[];
}

export function buildOutreach(input: { clientName: string | null; title: string | null; items: LeadInfoItem[] }): OutreachMessages {
  const name = firstName(input.clientName);
  const project = (input.title ?? '').trim() || 'project';
  const live = input.items.filter((i) => i.status === 'open' || i.status === 'asked');
  const asks = live.filter((i) => itemKind(i) === 'ask').map((i) => stripPrefix(i.question));
  const optional = live.filter((i) => itemKind(i) === 'optional').map((i) => stripPrefix(i.question));
  const assumptions = live.filter((i) => itemKind(i) === 'assumption').map((i) => stripPrefix(i.question).replace(/[.]$/, ''));

  const textLines = [`Hi ${name}, this is Chicago Reno about your ${project} request.`];
  if (asks.length === 1) textLines.push(`To get your quote out, could you help with one thing? ${sentence(asks[0])}`);
  else if (asks.length > 1) textLines.push(`To get your quote out, could you help with a few things?\n${asks.map((a, i) => `${i + 1}) ${a}`).join('\n')}`);
  else textLines.push(`We're putting your quote together now.`);
  if (assumptions.length > 0) textLines.push(`We'll list what we're assuming on the quote so you can tell us if anything is off.`);
  textLines.push('— Chicago Reno');
  const text = textLines.join('\n\n');

  const body: string[] = [`Hi ${name},`, `Thanks for reaching out to Chicago Reno about your ${project} request.`];
  if (asks.length > 0) {
    body.push(`To get your quote out quickly, could you help us with ${asks.length === 1 ? 'one thing' : 'a few things'}?\n\n${asks.map((a) => `- ${a}`).join('\n')}`);
  } else {
    body.push(`We're putting your quote together now.`);
  }
  if (optional.length > 0) body.push(`If they're handy, these help too (not required):\n\n${optional.map((a) => `- ${a}`).join('\n')}`);
  if (assumptions.length > 0) {
    body.push(`So we don't hold up your quote, here is what we're assuming. Let us know if any of it is off and we'll adjust:\n\n${assumptions.map((a) => `- We're assuming ${lowerFirst(a)}`).join('\n')}`);
  }
  body.push('Thanks,\nChicago Reno');
  return {
    text,
    emailSubject: `Your ${project} quote from Chicago Reno`,
    emailBody: body.join('\n\n'),
    asks,
    assumptions,
  };
}

export const OUTREACH_STEPS = [
  { step: 'intro_text', label: 'Send the intro text', channel: 'text' as const },
  { step: 'email_followup', label: 'Email if no reply', channel: 'email' as const },
  { step: 'call', label: 'Call', channel: 'call' as const },
  { step: 'follow_up', label: 'Follow up on the next-contact date', channel: 'other' as const },
];

export function smsLink(phone: string, body: string): string {
  const number = phone.replace(/[^\d+]/g, '');
  // "?&body=" works on both iOS and Android.
  return `sms:${number}?&body=${encodeURIComponent(body)}`;
}

/** A mailto: link, or null when the address doesn't look like one plain email address. */
export function mailtoLink(email: string, subject: string, body: string): string | null {
  const address = email.trim();
  if (!/^[^\s@,;?&]+@[^\s@,;?&]+\.[^\s@,;?&]+$/.test(address)) return null;
  return `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
