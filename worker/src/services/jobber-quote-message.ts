/**
 * update_quote_message: replace the "message to the customer" on a DRAFT Jobber quote.
 *
 * The caller passes the full new message and the messageVersion that read_quote returned.
 * The tool refuses when the quote is not a draft or when its message or status changed since
 * that read. It saves the message with Jobber's quoteEdit mutation, rereads the quote and
 * reports whether the saved message matches exactly.
 *
 * It never sends the quote, changes its status, title or line items, or contacts anyone.
 */
import type { JobberReadClient } from './ops-assistant-read.js';
import { QuoteEditArgsError } from './jobber-quote-edits.js';
import { sanitizeLogText } from './jobber-log-sanitize.mjs';

export const MAX_MESSAGE_LENGTH = 10000;
const ID_RE = /^[A-Za-z0-9+/=_-]{4,200}$/;

export const QUOTE_MESSAGE_QUERY = `query AssistantQuoteMessage($id: EncodedId!) {
  quote(id: $id) { id quoteNumber quoteStatus message }
}`;

export const QUOTE_MESSAGE_MUTATION = `mutation AssistantQuoteMessageEdit($quoteId: EncodedId!, $attributes: QuoteEditAttributes!) {
  quoteEdit(quoteId: $quoteId, attributes: $attributes) { quote { id } userErrors { message path } }
}`;

/** Jobber stores line breaks as \r\n in places and adds trailing whitespace; compare without that. */
export function normalizeMessage(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
}

/** Fingerprint of a quote's status and message, used to detect edits made since a review. */
export async function messageVersion(status: string | null | undefined, message: string | null | undefined): Promise<string> {
  const canonical = JSON.stringify([status ?? '', normalizeMessage(message)]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest).slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function parseMessageArgs(raw: unknown): { quoteId: string; messageVersion: string; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new QuoteEditArgsError('Arguments must be an object.');
  const args = raw as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (!['quoteId', 'messageVersion', 'message'].includes(key)) throw new QuoteEditArgsError(`Unknown field: ${key}`);
  }
  if (typeof args.quoteId !== 'string' || !ID_RE.test(args.quoteId)) throw new QuoteEditArgsError('quoteId is not a valid id.');
  if (typeof args.messageVersion !== 'string' || !/^[0-9a-f]{16}$/.test(args.messageVersion)) {
    throw new QuoteEditArgsError('messageVersion is required: use quote.messageVersion from read_quote.');
  }
  if (typeof args.message !== 'string') throw new QuoteEditArgsError('message must be text: the whole new message.');
  const message = normalizeMessage(args.message);
  if (!message) throw new QuoteEditArgsError('message cannot be empty.');
  if (message.length > MAX_MESSAGE_LENGTH) throw new QuoteEditArgsError(`message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
  return { quoteId: args.quoteId.trim(), messageVersion: args.messageVersion, message };
}

type QuoteMessageRow = { id: string; quoteNumber?: string; quoteStatus?: string; message?: string | null };

async function loadQuoteMessage(jobber: JobberReadClient, quoteId: string): Promise<QuoteMessageRow | null> {
  const data = await jobber.graphqlRequest<{ quote?: QuoteMessageRow | null }>(QUOTE_MESSAGE_QUERY, { id: quoteId });
  return data.quote ?? null;
}

export async function updateQuoteMessage(jobber: JobberReadClient, rawArgs: unknown) {
  const args = parseMessageArgs(rawArgs);
  const quote = await loadQuoteMessage(jobber, args.quoteId);
  if (!quote) return { outcome: 'not_found' as const, quoteId: args.quoteId, changed: false };
  const quoteNumber = quote.quoteNumber ?? null;
  const version = await messageVersion(quote.quoteStatus, quote.message);
  if (version !== args.messageVersion) {
    return { outcome: 'conflict' as const, changed: false, quoteNumber, currentMessageVersion: version,
      reason: 'The quote message or status changed since it was read. Nothing was changed. Reread it with read_quote and check the review still applies.' };
  }
  if (quote.quoteStatus !== 'draft') {
    return { outcome: 'refused' as const, changed: false, quoteNumber,
      reason: `Only draft quotes can be edited here; this one is ${quote.quoteStatus}. Nothing was changed.` };
  }
  if (normalizeMessage(quote.message) === args.message) {
    return { outcome: 'ok' as const, changed: false, quoteNumber, verified: true, messageVersion: version, note: 'The message already matches. Nothing was changed.' };
  }

  let failure: string | null = null;
  try {
    const data = await jobber.graphqlRequest<{ quoteEdit?: { userErrors?: Array<{ message?: string }> } | null }>(
      QUOTE_MESSAGE_MUTATION,
      { quoteId: args.quoteId, attributes: { message: args.message } },
    );
    const errors = data.quoteEdit?.userErrors ?? [];
    if (errors.length) throw new Error(`quoteEdit rejected: ${errors.map((e) => e.message).join('; ')}`);
  } catch (err) {
    failure = sanitizeLogText(err instanceof Error ? err.message : String(err)).slice(0, 300);
  }

  const after = await loadQuoteMessage(jobber, args.quoteId).catch(() => null);
  const afterVersion = after ? await messageVersion(after.quoteStatus, after.message) : null;
  const matches = after ? normalizeMessage(after.message) === args.message : false;
  const statusKept = after ? after.quoteStatus === quote.quoteStatus : false;
  const changed: boolean | 'unknown' = afterVersion === null ? 'unknown' : afterVersion !== version;
  const problems = !after
    ? ['The quote could not be reread after saving.']
    : [...(matches ? [] : ['The saved message does not match the requested text.']), ...(statusKept ? [] : [`The quote status is now ${after.quoteStatus}.`])];
  return {
    outcome: failure || problems.length ? 'failed' as const : 'ok' as const,
    changed,
    quoteNumber,
    verified: !failure && problems.length === 0,
    ...(failure ? { failure } : {}),
    ...(problems.length ? { mismatches: problems } : {}),
    messageVersion: afterVersion,
  };
}

export const QUOTE_MESSAGE_TOOL = {
  name: 'update_quote_message',
  description: 'Replace the message to the customer on a DRAFT Jobber quote with Ben-approved text. Send the whole new message. Requires quote.messageVersion from read_quote; refuses if the message or status changed since. Rereads and reports whether the saved message matches. Never sends the quote or changes its status, title or line items. Use only after Ben approves the wording.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['quoteId', 'messageVersion', 'message'],
    properties: {
      quoteId: { type: 'string' },
      messageVersion: { type: 'string', description: 'quote.messageVersion from read_quote' },
      message: { type: 'string', description: 'The complete new message to the customer.' },
    },
  },
} as const;
