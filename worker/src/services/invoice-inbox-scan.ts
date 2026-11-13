const SENDER_HINTS = [/20four7/i, /four7\s*va/i];
const MAX_PER_RUN = 25;

export interface GmailInvoiceMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  bodyText: string;
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
  if (amount !== null && date) return `${Math.round(amount * 100)}|${date}`;
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

  const text = message.subject + '\n' + message.bodyText;
  const numberMatch = text.match(/#\s*([A-Za-z0-9][A-Za-z0-9-]{2,})/);
  const invoiceNumber = numberMatch ? numberMatch[1].toUpperCase() : null;

  const amountMatch =
    message.bodyText.match(/\$\s?([0-9][0-9,]*\.[0-9]{2})/) ??
    message.subject.match(/\$\s?([0-9][0-9,]*\.[0-9]{2})/);
  const amount = amountMatch
    ? Math.round(parseFloat(amountMatch[1].replace(/,/g, '')) * 100) / 100
    : null;

  const dateMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  const expenseDate = dateMatch ? dateMatch[1] : null;

  const attachmentName = message.attachmentNames.find((name) => /\.pdf$/i.test(name)) ?? null;

  const missing: string[] = [];
  if (!vendor) missing.push('vendor');
  if (!invoiceNumber) missing.push('invoiceNumber');
  if (amount === null) missing.push('amount');
  if (!expenseDate) missing.push('expenseDate');
  if (!attachmentName) missing.push('attachment');

  return {
    messageId: message.id,
    vendor,
    invoiceNumber,
    amount,
    expenseDate,
    attachmentName,
    status: missing.length > 0 ? 'uncertain' : 'would_log',
    reason: missing.length > 0 ? 'missing ' + missing.join(', ') : null,
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
    const status = duplicate ? 'skipped' : draft.status;
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
