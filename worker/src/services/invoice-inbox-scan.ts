import { logExpense, type ReceiptFetcher } from './jobber-expense-create.js';
import type { JobberReadClient, ReceiptTarget } from './ops-assistant-read.js';

const SENDER_HINTS = [/20four7/i, /four7\s*va/i];
const SQUARE_SENDER = /<[^>]*@messaging\.squareup\.com>|^[^<]*@messaging\.squareup\.com$/i;
const SQUARE_SUBJECT = /you paid an invoice/i;
const SQUARE_PAID = /you have paid invoice|paid invoice #|invoice paid|total paid/i;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MAX_PER_RUN = 25;

export interface GmailInvoiceMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  bodyText: string;
  snippet?: string;
  attachmentNames: string[];
  /** The Square invoice link from the email HTML; the only route to the receipt PDF. */
  receiptUrl?: string | null;
}

export interface InvoiceScanResult {
  scanned: number;
  wouldLog: number;
  uncertain: number;
  skipped: number;
}

export function classifyInvoiceMessage(
  message: Pick<GmailInvoiceMessage, 'from' | 'subject' | 'bodyText' | 'snippet' | 'attachmentNames'>,
): boolean {
  // Square's "You paid an invoice!" mail carries no PDF - the document is a link.
  // The same subject also goes out for unpaid/overdue invoices, so require the body
  // or snippet to state the invoice was actually paid.
  if (SQUARE_SENDER.test(message.from) && SQUARE_SUBJECT.test(message.subject)) {
    return SQUARE_PAID.test(`${message.bodyText}\n${message.snippet ?? ''}`);
  }
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
  const namedDate = text.match(/\b([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})\b/);
  let expenseDate: string | null = null;
  if (isoDate) {
    const iso = new Date(isoDate[1] + 'T12:00:00Z');
    expenseDate = !Number.isNaN(iso.getTime()) && iso.toISOString().slice(0, 10) === isoDate[1] ? isoDate[1] : null;
  } else if (namedDate) {
    const parsedNamed = Date.parse(`${namedDate[1]} ${namedDate[2]}, ${namedDate[3]} 12:00:00 UTC`);
    if (!Number.isNaN(parsedNamed)) {
      const named = new Date(parsedNamed);
      const matchesCaptured =
        named.getUTCFullYear() === Number(namedDate[3]) &&
        named.getUTCMonth() === MONTHS.indexOf(namedDate[1]) &&
        named.getUTCDate() === Number(namedDate[2]);
      if (matchesCaptured) expenseDate = named.toISOString().slice(0, 10);
    }
  }

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

interface WouldLogRow { status: string; dedupe_key: string | null; vendor: string | null; invoice_number: string | null; amount: number | null; expense_date: string | null }
interface ExpenseNode { id?: string; title?: string | null; description?: string | null; total?: number | null; date?: string | null }
interface ExistingExpense { found: ExpenseNode | null; complete: boolean }
export interface InvoiceLiveDeps { jobber: JobberReadClient; target: ReceiptTarget; userId: string; log?: typeof logExpense; fetchReceipt?: ReceiptFetcher }

const DAY_MS = 86_400_000;
const EXPENSE_PAGE_SIZE = 100;
const MAX_EXPENSE_PAGES = 10;
const squashed = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');

// The shared AssistantExpenseDupes query takes no cursor, so page the expenses by hand.
const EXPENSE_PAGES_QUERY = `query InvoiceInboxExpenses($first: Int!, $after: String) {
  expenses(first: $first, after: $after) { edges { node { id title description total date } } pageInfo { hasNextPage endCursor } }
}`;

/** Whole calendar days between two YYYY-MM-DD dates, or null when either is unparseable. */
function dayGap(a: string, b: string): number | null {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.abs(da - db) / DAY_MS;
}

/** The hand-entered Jobber expense that would duplicate this invoice, if any. */
async function findExistingExpense(
  jobber: JobberReadClient,
  vendor: string,
  amount: number,
  expenseDate: string,
): Promise<ExistingExpense> {
  const needle = squashed(vendor);
  if (!needle) return { found: null, complete: true };
  let after: string | null = null;
  for (let page = 0; page < MAX_EXPENSE_PAGES; page++) {
    const reply = await jobber.graphqlRequest<{
      expenses?: {
        edges?: Array<{ node: ExpenseNode }>;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      } | null;
    }>(EXPENSE_PAGES_QUERY, { first: EXPENSE_PAGE_SIZE, after });
    const found = (reply.expenses?.edges ?? []).map((edge) => edge.node).find((node) => {
      if (!node.id) return false;
      if (Math.round(Number(node.total) * 100) !== Math.round(amount * 100)) return false;
      const gap = dayGap(String(node.date ?? '').slice(0, 10), expenseDate);
      if (gap === null || gap > 1) return false;
      return squashed(`${node.title ?? ''}\n${node.description ?? ''}`).includes(needle);
    });
    if (found) return { found, complete: true };
    const pageInfo = reply.expenses?.pageInfo;
    if (!pageInfo?.hasNextPage) return { found: null, complete: true };
    if (!pageInfo.endCursor) break;
    after = pageInfo.endCursor;
  }
  return { found: null, complete: false };
}

async function setItem(db: D1Database, id: string, status: string, reason: string | null, expenseId: string | null = null): Promise<void> {
  await db
    .prepare('UPDATE invoice_inbox_items SET status = ?, reason = ?, jobber_expense_id = ? WHERE message_id = ?')
    .bind(status, reason, expenseId, id)
    .run();
}

/** Create the would_log rows in Jobber once each; never retries an unknown reply. */
async function logWouldLogRows(
  messages: GmailInvoiceMessage[],
  db: D1Database,
  live: InvoiceLiveDeps,
): Promise<{ logged: number; skipped: number; uncertain: number }> {
  const log = live.log ?? logExpense;
  const result = { logged: 0, skipped: 0, uncertain: 0 };
  for (const message of messages.slice(0, MAX_PER_RUN)) {
    const row = await db
      .prepare('SELECT status, dedupe_key, vendor, invoice_number, amount, expense_date FROM invoice_inbox_items WHERE message_id = ?')
      .bind(message.id)
      .first<WouldLogRow>();
    if (!row || row.status !== 'would_log' || !row.dedupe_key || row.amount === null || !row.expense_date) continue;
    if (!message.receiptUrl) {
      await setItem(db, message.id, 'uncertain', 'no receipt link in the email');
      result.uncertain++;
      continue;
    }
    let existing: ExistingExpense;
    try {
      existing = await findExistingExpense(live.jobber, row.vendor ?? '', row.amount, row.expense_date);
    } catch {
      await setItem(db, message.id, 'uncertain', 'existing-expense check failed');
      result.uncertain++;
      continue;
    }
    if (!existing.complete) {
      await setItem(db, message.id, 'uncertain', 'existing-expense check incomplete');
      result.uncertain++;
      continue;
    }
    if (existing.found) {
      await setItem(db, message.id, 'skipped', 'already in Jobber', existing.found.id ?? null);
      result.skipped++;
      continue;
    }
    const vendor = row.vendor ?? '';
    let outcome: Awaited<ReturnType<typeof log>>;
    try {
      outcome = await log(
        live.jobber,
        db,
        live.target,
        live.userId,
        {
          sourceKey: row.dedupe_key,
          title: `${vendor} ${row.invoice_number ?? ''}`.trim().slice(0, 120),
          description: `${vendor} invoice #${row.invoice_number ?? ''} (${row.dedupe_key})`,
          date: row.expense_date,
          total: row.amount,
          receiptUrl: message.receiptUrl,
        },
        live.fetchReceipt,
      );
    } catch (err) {
      await setItem(db, message.id, 'uncertain', err instanceof Error ? err.message : 'log_expense threw');
      result.uncertain++;
      continue;
    }
    const expenseId = 'expenseId' in outcome ? outcome.expenseId : null;
    if ((outcome.outcome === 'created' || outcome.outcome === 'duplicate') && expenseId) {
      await setItem(db, message.id, 'logged', null, expenseId);
      result.logged++;
    } else {
      const reason = 'message' in outcome && typeof outcome.message === 'string'
        ? outcome.message
        : 'failure' in outcome ? outcome.failure.message : 'log_expense did not confirm the expense';
      await setItem(db, message.id, 'uncertain', reason);
      result.uncertain++;
    }
  }
  return result;
}

export async function runInvoiceInboxScan(
  service: {
    fetchInvoiceMessages(limit?: number): Promise<GmailInvoiceMessage[]>;
    fetchMailboxAddress(): Promise<string | null>;
  },
  db: D1Database,
  live?: InvoiceLiveDeps | null,
  goLive = live != null,
): Promise<void> {
  try {
    const mailbox = await service.fetchMailboxAddress();
    const messages = await service.fetchInvoiceMessages();
    const result = await scanInvoiceInbox({ messages, db });
    console.log(
      `[invoice-inbox] ${goLive ? 'live' : 'dry-run'} scanned=${result.scanned} would_log=${result.wouldLog} uncertain=${result.uncertain} skipped=${result.skipped} mailbox=${mailbox ?? 'unknown'}`,
    );
    if (goLive && live) {
      const pass = await logWouldLogRows(messages, db, live);
      console.log(`[invoice-inbox] logged=${pass.logged} skipped=${pass.skipped} uncertain=${pass.uncertain}`);
    }
  } catch (err) {
    console.error('[invoice-inbox] scan failed', err);
  }
}
