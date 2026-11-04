/**
 * Proposed outreach for a lead, built from what Cotiza already knows: the client's first name,
 * the project title, the questions still open, and the assumptions the quote will rest on.
 * Deterministic (no AI), in Chicago Reno's own voice, so the team can send it as-is or edit it.
 */
import type { LeadActionKind, LeadInfoItem } from './api';

export const ASSUMED_PREFIX = /^assumed:\s*/i;
export const OPTIONAL_PREFIX = /^optional:\s*/i;
export const MAX_TEXT_LENGTH = 1600;

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

/** Lowercases a plain capitalized first word ("About" -> "about"); leaves "I", acronyms and names' casing alone otherwise. */
function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
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

/**
 * The message for the lead's next action (see the worker's lead-workflow.ts):
 * - intro_text / ask_info / follow_up: the asks and assumptions (buildOutreach).
 * - reply: thanks them for getting back to us, then any asks.
 * - quote_update: the handbook's "quote still being created" update.
 * - quote_follow_up: the handbook's "quote sent, follow up" check-in.
 * - draft_quote / ben_edits / wait_review / send_quote / review / none: no customer message.
 */
export function buildActionMessage(kind: LeadActionKind, input: { clientName: string | null; title: string | null; items: LeadInfoItem[] }): OutreachMessages | null {
  if (kind === 'draft_quote' || kind === 'ben_edits' || kind === 'wait_review' || kind === 'send_quote' || kind === 'review' || kind === 'none') return null;
  const base = buildOutreach(input);
  const name = firstName(input.clientName);
  const project = (input.title ?? '').trim() || 'project';
  if (kind === 'quote_update') {
    return {
      ...base,
      text: [
        `Hi ${name}, this is Chicago Reno following up on your ${project} request.`,
        `We're putting the finishing touches on your quote and it should be over to you shortly. If you have any questions, or anything has changed on your side, just let us know.`,
        '— Chicago Reno',
      ].join('\n\n'),
      emailSubject: `Your ${project} quote from Chicago Reno`,
      emailBody: [
        `Hi ${name},`,
        `Just a quick update on your ${project} request: we're putting the finishing touches on your quote and it should be over to you shortly.`,
        `If you have any questions in the meantime, or anything has changed on your side, just reply here.`,
        'Thank you for your patience!\nChicago Reno',
      ].join('\n\n'),
    };
  }
  if (kind === 'quote_follow_up') {
    return {
      ...base,
      text: [
        `Hi ${name}, this is Chicago Reno. Just checking in to make sure you received our quote for your ${project} okay (sometimes they go to spam).`,
        `Please let us know if you have any questions, or if anything needs to be clarified!`,
        '— Chicago Reno',
      ].join('\n\n'),
      emailSubject: `Checking in on your ${project} quote`,
      emailBody: [
        `Hi ${name},`,
        `Just checking in to make sure you received our quote for your ${project} okay (sometimes they go to spam).`,
        `Please let us know if you have any questions, or if anything needs to be clarified!`,
        'Best,\nChicago Reno',
      ].join('\n\n'),
    };
  }
  if (kind === 'reply') {
    return {
      ...base,
      text: base.text.replace(`Hi ${name}, this is Chicago Reno about your ${project} request.`, `Hi ${name}, thanks for getting back to us about your ${project} request.`),
      emailBody: base.emailBody.replace(`Thanks for reaching out to Chicago Reno about your ${project} request.`, `Thanks for getting back to us about your ${project} request.`),
    };
  }
  if (kind === 'follow_up' && base.asks.length === 0) {
    // No checklist yet: a check-in, not a first contact.
    return {
      ...base,
      text: [
        `Hi ${name}, this is Chicago Reno following up on your ${project} request.`,
        `Is this still something you'd like a quote for? If you can send a few photos and any details, we'll get it put together.`,
        '— Chicago Reno',
      ].join('\n\n'),
      emailSubject: `Following up on your ${project} request`,
      emailBody: [
        `Hi ${name},`,
        `Following up on your ${project} request. Is this still something you'd like a quote for?`,
        `If you can reply with a few photos and any details, we'll get it put together.`,
        'Thanks,\nChicago Reno',
      ].join('\n\n'),
    };
  }
  return base;
}

export function smsLink(phone: string, body: string): string {
  const number = phone.replace(/[^\d+]/g, '');
  // "?&body=" works on both iOS and Android.
  return `sms:${number}?&body=${encodeURIComponent(body)}`;
}

/** A mailto: link, or null when the address doesn't look like one plain email address. */
export function mailtoLink(email: string, subject: string, body: string): string | null {
  const address = email.trim();
  if (!/^[^\s@,;?&]+@[^\s@,;?&]+\.[^\s@,;?&]+$/.test(address)) return null;
  const at = address.lastIndexOf('@');
  const safe = `${encodeURIComponent(address.slice(0, at))}@${encodeURIComponent(address.slice(at + 1))}`;
  return `mailto:${safe}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
