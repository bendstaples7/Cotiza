import { sanitizeLogText } from './jobber-log-sanitize.mjs';
import { InvalidAssistantArgs, publishReceipt, type JobberReadClient, type ReceiptTarget } from './ops-assistant-read.js';

/**
 * log_expense (card 0d929d22 slice 3): create one Chicago Reno expense in Jobber from a paid
 * vendor invoice, at most once per caller-supplied sourceKey (e.g. "20four7VA invoice #5511-R-0026").
 *
 * Write safety, ported from the original design in PR #104:
 * 1. Claim sourceKey in D1. A repeat call returns duplicate / unresolved_prior_attempt and never creates.
 * 2. Search Jobber for an expense already mentioning sourceKey (covers entries made by hand).
 * 3. Download the receipt (Square invoice PDF only) before anything is created, and republish it
 *    on the same short-lived private URL route attach_expense_receipt uses.
 * 4. expenseCreate runs once. A definite rejection releases the claim; an uncertain reply is
 *    recorded as unknown and never retried.
 * 5. Read the expense back and report verified.
 */

const EXPENSES_QUERY = `query AssistantExpenseDupes($first: Int!, $searchTerm: String) {
  expenses(first: $first, searchTerm: $searchTerm) { edges { node { id title description total date } } }
}`;
const EXPENSE_QUERY = `query AssistantExpenseCreated($id: EncodedId!) {
  expense(id: $id) { id title description total date }
}`;
const EXPENSE_CREATE = `mutation AssistantExpenseCreate($input: ExpenseCreateInput!) {
  expenseCreate(input: $input) { expense { id title description total date } userErrors { message path } }
}`;
export const EXPENSE_CREATE_QUERIES = { EXPENSES_QUERY, EXPENSE_QUERY, EXPENSE_CREATE };

const RECEIPT_HOSTS = new Set(['squareup.com', 'app.squareup.com']);
const TRACKING_HOSTS = new Set(['a.squareupmessaging.com']);
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;

interface ExpenseNode { id?: string; title?: string | null; description?: string | null; total?: number | null; date?: string | null }

function objectArgs(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new InvalidAssistantArgs('arguments must be an object.');
  return args as Record<string, unknown>;
}

function onlyKeys(raw: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new InvalidAssistantArgs(`Unknown field "${key}".`);
}

function text(raw: Record<string, unknown>, key: string, max: number, required: boolean): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null || value === '') {
    if (required) throw new InvalidAssistantArgs(`${key} is required.`);
    return undefined;
  }
  if (typeof value !== 'string') throw new InvalidAssistantArgs(`${key} must be text.`);
  // Keep newlines in descriptions; drop other control characters.
  const cleaned = value.replace(/[\u0000-\u0009\u000b-\u001f]/g, '').trim();
  if (!cleaned && required) throw new InvalidAssistantArgs(`${key} is required.`);
  if (cleaned.length > max) throw new InvalidAssistantArgs(`${key} must be ${max} characters or fewer.`);
  return cleaned || undefined;
}

function requireDate(raw: Record<string, unknown>): string {
  const value = text(raw, 'date', 10, true)!;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  // Date.parse rolls impossible dates (2026-02-31) forward, so compare the round trip.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new InvalidAssistantArgs('date must be YYYY-MM-DD.');
  }
  return value;
}

function requireTotal(raw: Record<string, unknown>): number {
  const value = raw.total;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100_000) {
    throw new InvalidAssistantArgs('total must be a positive amount up to 100000.');
  }
  if (Math.abs(Math.round(value * 100) - value * 100) > 1e-6) throw new InvalidAssistantArgs('total must have at most two decimal places.');
  return Math.round(value * 100) / 100;
}

function allowedReceiptUrl(url: URL): boolean {
  return url.protocol === 'https:' && RECEIPT_HOSTS.has(url.hostname) && !url.username && !url.password;
}

/** Accept a direct Square invoice link or a Square click-tracking wrapper around one. */
export function normalizeReceiptUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new InvalidAssistantArgs('receiptUrl is not a valid URL.'); }
  if (TRACKING_HOSTS.has(url.hostname) && url.pathname.startsWith('/CL0/')) {
    const wrapped = url.pathname.slice('/CL0/'.length).split('/')[0];
    try { url = new URL(decodeURIComponent(wrapped)); } catch { throw new InvalidAssistantArgs('receiptUrl tracking link does not wrap a valid URL.'); }
  }
  if (!allowedReceiptUrl(url)) throw new InvalidAssistantArgs(`receiptUrl must be an https link on ${[...RECEIPT_HOSTS].join(' or ')}.`);
  return url.toString();
}

export type ReceiptFetcher = (url: string) => Promise<Response>;
const defaultFetcher: ReceiptFetcher = (url) => fetch(url, { redirect: 'manual' });

async function readBounded(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | string> {
  if (!body) return 'empty';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RECEIPT_BYTES) return 'too_large';
      chunks.push(value);
    }
  } catch {
    return 'download_failed';
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!total) return 'empty';
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

/** Download the receipt PDF, following redirects by hand so every hop stays on an allowed host. */
async function downloadReceipt(fetcher: ReceiptFetcher, url: string): Promise<{ ok: true; pdf: Uint8Array } | { ok: false; reason: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try { response = await fetcher(current); } catch { return { ok: false, reason: 'download_failed' }; }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      let next: URL;
      try { next = new URL(location ?? '', current); } catch { return { ok: false, reason: 'bad_redirect' }; }
      if (!location || !allowedReceiptUrl(next)) return { ok: false, reason: 'redirect_off_allowlist' };
      current = next.toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: `http_${response.status}` };
    }
    const body = await readBounded(response.body);
    if (typeof body === 'string') return { ok: false, reason: body };
    if (String.fromCharCode(...body.slice(0, 5)) !== '%PDF-') return { ok: false, reason: 'not_a_pdf' };
    return { ok: true, pdf: body };
  }
  return { ok: false, reason: 'too_many_redirects' };
}

/** True when `haystack` contains `key` not run into further letters or digits on either side. */
export function mentionsSource(haystack: string, key: string): boolean {
  const h = haystack.toLowerCase();
  const k = key.toLowerCase();
  for (let at = h.indexOf(k); at !== -1; at = h.indexOf(k, at + 1)) {
    const before = h[at - 1] ?? '';
    const after = h[at + k.length] ?? '';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
  }
  return false;
}

function safeMessage(err: unknown): string {
  return sanitizeLogText(err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/** Jobber refused before running the mutation, so nothing was created. Anything else stays unknown. */
function definitelyRejected(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/Jobber API error \(4\d\d\)|Jobber API throttled|not configured|access token is unavailable/i.test(message)) return true;
  return /Jobber GraphQL error/i.test(message)
    && /doesn't exist|isn't defined|was provided invalid value|Variable \$\w+ |not authorized|unauthorized|access denied|permission|scope/i.test(message);
}

function mapExpense(node: ExpenseNode) {
  return { id: node.id ?? null, title: node.title ?? null, description: node.description ?? null, total: node.total ?? null, date: node.date ?? null };
}

function failed(code: string, message: string, sourceKey: string, detail?: string) {
  return { outcome: 'failed' as const, sourceKey, failure: { code, message, detail } };
}

interface WriteRow { status: string; jobber_expense_id: string | null }

export async function logExpense(
  jobber: JobberReadClient,
  db: D1Database,
  target: ReceiptTarget,
  userId: string,
  args: unknown,
  fetchReceipt: ReceiptFetcher = defaultFetcher,
) {
  const raw = objectArgs(args);
  onlyKeys(raw, ['sourceKey', 'title', 'description', 'date', 'total', 'receiptUrl']);
  const sourceKey = text(raw, 'sourceKey', 120, true)!;
  const title = text(raw, 'title', 120, true)!;
  const description = text(raw, 'description', 2000, true)!;
  const date = requireDate(raw);
  const total = requireTotal(raw);
  const receiptUrl = normalizeReceiptUrl(text(raw, 'receiptUrl', 2048, true)!);
  if (!mentionsSource(description, sourceKey)) {
    throw new InvalidAssistantArgs('description must contain sourceKey exactly, so the expense can be found again.');
  }

  // 1. Claim the source key.
  const claim = await db.prepare(
    `INSERT INTO assistant_expense_writes (source_key, user_id, status, title, total, expense_date)
     VALUES (?, ?, 'pending', ?, ?, ?) ON CONFLICT(source_key) DO NOTHING`,
  ).bind(sourceKey, userId, title, total, date).run();
  if ((claim.meta?.changes ?? 0) < 1) {
    const prior = await db.prepare(`SELECT status, jobber_expense_id FROM assistant_expense_writes WHERE source_key = ?`).bind(sourceKey).first<WriteRow>();
    if (prior?.status === 'created') {
      return { outcome: 'duplicate' as const, sourceKey, expenseId: prior.jobber_expense_id, message: 'This invoice was already logged as a Jobber expense. Nothing was created.' };
    }
    return { outcome: 'unresolved_prior_attempt' as const, sourceKey, status: prior?.status ?? 'unknown', message: 'An earlier attempt for this invoice did not confirm. Check Jobber by hand; this tool will not retry.' };
  }
  const release = () => db.prepare(`DELETE FROM assistant_expense_writes WHERE source_key = ? AND status = 'pending'`).bind(sourceKey).run();
  const mark = (status: 'created' | 'unknown', expenseId: string | null) => db.prepare(
    `UPDATE assistant_expense_writes SET status = ?, jobber_expense_id = ?, updated_at = datetime('now') WHERE source_key = ?`,
  ).bind(status, expenseId, sourceKey).run();

  // 2. Existing Jobber expense mentioning the source key.
  try {
    const existing = await jobber.graphqlRequest<{ expenses?: { edges?: Array<{ node: ExpenseNode }> } | null }>(EXPENSES_QUERY, { first: 20, searchTerm: sourceKey });
    const match = (existing.expenses?.edges ?? []).map((e) => e.node).find((n) => mentionsSource(`${n.title ?? ''}\n${n.description ?? ''}`, sourceKey));
    if (match) {
      await mark('created', match.id ?? null);
      return { outcome: 'duplicate' as const, sourceKey, expenseId: match.id ?? null, expense: mapExpense(match), message: 'Jobber already has an expense mentioning this invoice. Nothing was created.' };
    }
  } catch (err) {
    await release();
    return failed('duplicate_check_failed', `Could not check Jobber for an existing expense, so nothing was created. (${safeMessage(err)})`, sourceKey);
  }

  // 3. Receipt: download before creating anything, then serve it from our private short-lived URL.
  const receipt = await downloadReceipt(fetchReceipt, receiptUrl);
  if (!receipt.ok) {
    await release();
    return failed('receipt_unavailable', `The receipt link could not be downloaded as a PDF (${receipt.reason}). Nothing was created.`, sourceKey, receipt.reason);
  }
  let jobberReceiptUrl: string;
  try {
    jobberReceiptUrl = await publishReceipt(target, receipt.pdf);
  } catch (err) {
    await release();
    return failed('receipt_store_failed', `Could not store the receipt, so nothing was created. (${safeMessage(err)})`, sourceKey);
  }

  // 4. Create once.
  const input: Record<string, unknown> = { title, description, date: `${date}T12:00:00Z`, total, receiptUrl: jobberReceiptUrl };
  let created: { expenseCreate?: { expense?: ExpenseNode | null; userErrors?: Array<{ message?: string }> } | null };
  try {
    created = await jobber.graphqlRequest(EXPENSE_CREATE, { input });
  } catch (err) {
    if (definitelyRejected(err)) {
      await release();
      return failed('jobber_rejected', `Jobber rejected the expense, so nothing was created. (${safeMessage(err)})`, sourceKey);
    }
    await mark('unknown', null);
    return { outcome: 'unknown' as const, sourceKey, message: 'Jobber did not confirm whether the expense was created. Check Jobber by hand; this tool will not retry.' };
  }
  const userErrors = (created.expenseCreate?.userErrors ?? []).map((e) => sanitizeLogText(String(e.message ?? '')).slice(0, 200)).filter(Boolean);
  if (userErrors.length) {
    await release();
    return failed('jobber_rejected', `Jobber rejected the expense: ${userErrors.join('; ')}. Nothing was created.`, sourceKey);
  }
  const expenseId = created.expenseCreate?.expense?.id;
  if (!expenseId) {
    await mark('unknown', null);
    return { outcome: 'unknown' as const, sourceKey, message: 'Jobber returned no expense id. Check Jobber by hand; this tool will not retry.' };
  }
  await mark('created', expenseId);

  // 5. Read back.
  let verified = false;
  let stored: ReturnType<typeof mapExpense> | null = null;
  try {
    const back = await jobber.graphqlRequest<{ expense?: ExpenseNode | null }>(EXPENSE_QUERY, { id: expenseId });
    if (back.expense) {
      stored = mapExpense(back.expense);
      verified = back.expense.title === title
        && Math.round(Number(back.expense.total) * 100) === Math.round(total * 100)
        && String(back.expense.date ?? '').slice(0, 10) === date;
    }
  } catch (err) {
    console.error(`[ops-assistant] expense read-back failed ${safeMessage(err)}`);
  }
  return {
    outcome: 'created' as const,
    sourceKey,
    expenseId,
    verified,
    expense: stored ?? mapExpense(created.expenseCreate!.expense!),
    receipt: { submitted: true, note: 'The Jobber API cannot show receipts back. Confirm the PDF on the expense in Jobber\'s web UI.' },
  };
}

export const EXPENSE_CREATE_TOOL = {
  name: 'log_expense',
  description: 'Create one Chicago Reno expense in Jobber from a paid vendor invoice, at most once per sourceKey (e.g. "20four7VA invoice #5511-R-0026"; the description must contain it). Checks Jobber for an existing expense mentioning sourceKey, downloads the Square invoice PDF receipt first, creates the expense with the receipt, and reads it back. Outcomes: created, duplicate, unresolved_prior_attempt, unknown, failed. Only created or duplicate mean it is in Jobber. Never retry after unknown. Office account only.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['sourceKey', 'title', 'description', 'date', 'total', 'receiptUrl'],
    properties: {
      sourceKey: { type: 'string', maxLength: 120 },
      title: { type: 'string', maxLength: 120 },
      description: { type: 'string', maxLength: 2000 },
      date: { type: 'string', description: 'YYYY-MM-DD' },
      total: { type: 'number', exclusiveMinimum: 0 },
      receiptUrl: { type: 'string', description: 'Square invoice PDF link (click-tracking wrapper accepted).' },
    },
  },
} as const;
