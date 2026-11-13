const SENDER_HINTS = [/20four7/i, /four7\s*va/i];
const SQUARE_SENDER = /messaging\.squareup\.com/i;
const SQUARE_SUBJECT = /you paid an invoice/i;
const MAX_PER_RUN = 25;

export interface GmailInvoiceMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  bodyText: string;
  snippet?: string;
  attachmentNames: string[];
}

export interface InvoiceScanResult {
  scanned: number;
  wouldLog: number;
  uncertain: number;
  skipped: number;
}

export function classifyInvoiceMessage(
  message: Pick<GmailInvoiceMessage, 'from' | 'subject' | 'attachmentNames'>,
): boolean {
  // Square's "You paid an invoice!" mail carries no PDF - the document is a link.
  if (SQUARE_SENDER.test(message.from) && SQUARE_SUBJECT.test(message.subject)) return true;
  if (!message.attachmentNames.some((name) => /\.pdf$/i.test(name))) return false;
  return SENDER_HINTS.some((hint) => hint.test(message.from)) || /\binvoice\b/i.test(message.subject);
}

export function invoiceDedupeKey(
  vendor: string | null,
  number: string | null,
  amount: number | null,
  date: string | null,
): string | null {
  if (vendor && number) return `${vendor}|${number}`.toLowerCase();
  if (vendor && amount !== null && date) return `${vendor}|${Math.round(amount * 100)}|${date}`.toLowerCase();
  return null;
}

export function draftFromMessage(message: GmailInvoiceMessage): {
  messageId: string;
  vendor: string | null;
  invoiceNumber: string | null;
  amount: number | null;
  expenseDate: string | null;
  attachmentName: string | null;
  status: 'would_log' | 'uncertain';
  reason: string | null;
} {
  const lt = message.from.indexOf('<');
  const rawVendor = (lt === -1 ? message.from : message.from.slice(0, lt)).replace(/['"]/g, '').trim();
  const vendor = rawVendor || null;

  const text = [message.subject, message.bodyText, message.snippet ?? ''].join('\n');
  const numberMatch = text.match(/#\s*([A-Za-z0-9][A-Za-z0-9-]{2,})/);
  const invoiceNumber = numberMatch ? numberMatch[1].toUpperCase() : null;

  // Amount comes only from a labelled total (total / amount due / balance due); an
  // unlabelled $ token is a guess, and several different labelled totals are ambiguous.
  const labelledTotals = [...text.matchAll(/\b(?:total|amount\s+due|balance\s+due)\b[^$]{0,40}\$\s?([0-9][0-9,]*\.[0-9]{2})/gi)]
    .map((match) => Math.round(parseFloat(match[1].replace(/,/g, '')) * 100) / 100);
  const distinctTotals = [...new Set(labelledTotals)];
  const paidInvoice = text.match(/\bpaid\s+(?:an\s+)?invoice\b[^$]{0,80}?\bfor\s+\$\s?([0-9][0-9,]*\.[0-9]{2})/i);
  const amount = distinctTotals.length === 1
    ? distinctTotals[0]
    : !distinctTotals.length && paidInvoice
      ? Math.round(parseFloat(paidInvoice[1].replace(/,/g, '')) * 100) / 100
      : null;

  const isoDate = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  const namedDate = text.match(/\b([A-Z][a-z]+\s+\d{1,2},\s+\d{4})\b/);
  const parsedNamed = namedDate ? Date.parse(namedDate[1] + ' 12:00:00 UTC') : NaN;
  const expenseDate = isoDate ? isoDate[1] : Number.isNaN(parsedNamed) ? null : new Date(parsedNamed).toISOString().slice(0, 10);

  const attachmentName = message.attachmentNames.find((name) => /\.pdf$/i.test(name)) ?? null;

  const missing: string[] = [];
  if (!vendor) missing.push('vendor');
  if (!invoiceNumber) missing.push('invoiceNumber');
  if (!expenseDate) missing.push('expenseDate');
  if (!attachmentName && !SQUARE_SENDER.test(message.from)) missing.push('attachment');

  const reasons: string[] = [];
  if (amount === null) reasons.push('no unambiguous total');
  if (missing.length > 0) reasons.push('missing ' + missing.join(', '));

  return {
    messageId: message.id,
    vendor,
    invoiceNumber,
    amount,
    expenseDate,
    attachmentName,
    status: reasons.length > 0 ? 'uncertain' : 'would_log',
    reason: reasons.length > 0 ? reasons.join('; ') : null,
  };
}

export async function scanInvoiceInbox(deps: {
  messages: GmailInvoiceMessage[];
  db: D1Database;
}): Promise<InvoiceScanResult> {
  const result: InvoiceScanResult = { scanned: 0, wouldLog: 0, uncertain: 0, skipped: 0 };
  for (const message of deps.messages.slice(0, MAX_PER_RUN)) {
    result.scanned++;
    if (!classifyInvoiceMessage(message)) continue;
    const draft = draftFromMessage(message);
    const key = invoiceDedupeKey(draft.vendor, draft.invoiceNumber, draft.amount, draft.expenseDate);
    let duplicate = false;
    if (key) {
      duplicate = Boolean(
        await deps.db
          .prepare('SELECT 1 FROM invoice_inbox_items WHERE dedupe_key = ? AND message_id != ? LIMIT 1')
          .bind(key, message.id)
          .first(),
      );
    }
    // No dedupe key means the row could never be recognised as a repeat — never would_log.
    const status = duplicate ? 'skipped' : !key ? 'uncertain' : draft.status;
    await deps.db
      .prepare(
        'INSERT INTO invoice_inbox_items (message_id, thread_id, vendor, invoice_number, amount, expense_date, attachment_name, dedupe_key, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING',
      )
      .bind(
        message.id,
        message.threadId,
        draft.vendor,
        draft.invoiceNumber,
        draft.amount,
        draft.expenseDate,
        draft.attachmentName,
        key,
        status,
        duplicate ? 'duplicate of an earlier invoice' : draft.reason,
      )
      .run();
    if (status === 'skipped') result.skipped++;
    else if (status === 'would_log') result.wouldLog++;
    else result.uncertain++;
  }
  return result;
}

export async function runInvoiceInboxScan(
  service: {
    fetchInvoiceMessages(limit?: number): Promise<GmailInvoiceMessage[]>;
    fetchMailboxAddress(): Promise<string | null>;
  },
  db: D1Database,
): Promise<void> {
  try {
    const mailbox = await service.fetchMailboxAddress();
    const result = await scanInvoiceInbox({ messages: await service.fetchInvoiceMessages(), db });
    console.log(
      `[invoice-inbox] dry-run scanned=${result.scanned} would_log=${result.wouldLog} uncertain=${result.uncertain} skipped=${result.skipped} mailbox=${mailbox ?? 'unknown'}`,
    );
  } catch (err) {
    console.error('[invoice-inbox] scan failed', err);
  }
}
