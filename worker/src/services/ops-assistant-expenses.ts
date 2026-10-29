import { liveJobberRead } from './jobber-read.js';
import { sanitizeLogText } from './jobber-log-sanitize.mjs';
import { InvalidAssistantArgs, type JobberReadClient } from './ops-assistant-read.js';

/**
 * Expense tools for the ops assistant.
 *
 * find_expenses is read-only. log_expense is the assistant's only write and is
 * offered only to tokens granted the separate expense scope. Each write is keyed
 * by a caller-supplied source key (for example a vendor invoice number) so the
 * same invoice is never logged twice, and an uncertain Jobber response is never
 * retried automatically.
 */

const EXPENSES_QUERY = `
  query AssistantExpenses($first: Int!, $after: String, $searchTerm: String) {
    expenses(first: $first, after: $after, searchTerm: $searchTerm) {
      edges {
        node {
          id
          title
          description
          total
          date
          createdAt
          linkedJob { id jobNumber }
          reimbursableTo { id }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const EXPENSE_QUERY = `
  query AssistantExpense($id: EncodedId!) {
    expense(id: $id) { id title description total date }
  }
`;

const EXPENSE_CREATE = `
  mutation AssistantExpenseCreate($input: ExpenseCreateInput!) {
    expenseCreate(input: $input) {
      expense { id title description total date }
      userErrors { message path }
    }
  }
`;

export const EXPENSE_QUERIES = { EXPENSES_QUERY, EXPENSE_QUERY, EXPENSE_CREATE };

/** Hosts a receipt URL may point at after unwrapping a known click-tracking link. */
const RECEIPT_HOSTS = new Set(['squareup.com', 'app.squareup.com']);
const TRACKING_HOSTS = new Set(['a.squareupmessaging.com']);
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

const ID_RE = /^[A-Za-z0-9+/=_-]{4,200}$/;
const CURSOR_RE = /^[A-Za-z0-9+/=_-]{1,512}$/;

interface ExpenseNode {
  id?: string;
  title?: string | null;
  description?: string | null;
  total?: number | null;
  date?: string | null;
  createdAt?: string | null;
  linkedJob?: { id?: string; jobNumber?: number | null } | null;
  reimbursableTo?: { id?: string } | null;
}

interface PageInfo { hasNextPage?: boolean; endCursor?: string | null }

function objectArgs(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new InvalidAssistantArgs('arguments must be an object.');
  return args as Record<string, unknown>;
}

function onlyKeys(raw: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new InvalidAssistantArgs(`Unknown field "${key}".`);
  }
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

function requireDate(raw: Record<string, unknown>, key: string): string {
  const value = text(raw, key, 10, true)!;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  // Date.parse rolls impossible dates (2026-02-31) forward, so compare the round trip.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new InvalidAssistantArgs(`${key} must be YYYY-MM-DD.`);
  }
  return value;
}

function requireTotal(raw: Record<string, unknown>): number {
  const value = raw.total;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100_000) {
    throw new InvalidAssistantArgs('total must be a positive amount up to 100000.');
  }
  if (Math.round(value * 100) !== Number((value * 100).toFixed(6))) {
    throw new InvalidAssistantArgs('total must have at most two decimal places.');
  }
  return Math.round(value * 100) / 100;
}

function optionalId(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new InvalidAssistantArgs(`${key} is not a valid id.`);
  return value;
}

function allowedReceiptUrl(url: URL): boolean {
  return url.protocol === 'https:' && RECEIPT_HOSTS.has(url.hostname) && !url.username && !url.password;
}

/**
 * Accept a direct receipt link or a known click-tracking wrapper around one, and
 * return the direct https URL on an allowed host. Anything else is rejected.
 */
export function normalizeReceiptUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidAssistantArgs('receiptUrl is not a valid URL.');
  }
  if (TRACKING_HOSTS.has(url.hostname) && url.pathname.startsWith('/CL0/')) {
    const wrapped = url.pathname.slice('/CL0/'.length).split('/')[0];
    try {
      url = new URL(decodeURIComponent(wrapped));
    } catch {
      throw new InvalidAssistantArgs('receiptUrl tracking link does not wrap a valid URL.');
    }
  }
  if (!allowedReceiptUrl(url)) {
    throw new InvalidAssistantArgs(`receiptUrl must be an https link on ${[...RECEIPT_HOSTS].join(' or ')}.`);
  }
  return url.toString();
}

export type ReceiptFetcher = (url: string) => Promise<Response>;

const MAX_REDIRECTS = 3;

const defaultFetcher: ReceiptFetcher = (url) => fetch(url, { redirect: 'manual' });

/** Read the whole body up to `limit` bytes. */
async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<'ok' | 'empty' | 'too_large' | 'download_failed'> {
  if (!body) return 'empty';
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return total > 0 ? 'ok' : 'empty';
      total += value.byteLength;
      if (total > limit) return 'too_large';
    }
  } catch {
    return 'download_failed';
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Follow redirects by hand so every hop stays on an allowed receipt host. */
async function checkReceipt(fetcher: ReceiptFetcher, url: string): Promise<{ ok: true; contentType: string } | { ok: false; reason: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetcher(current);
    } catch {
      return { ok: false, reason: 'download_failed' };
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      let next: URL;
      try {
        next = new URL(location ?? '', current);
      } catch {
        return { ok: false, reason: 'bad_redirect' };
      }
      if (!location || !allowedReceiptUrl(next)) return { ok: false, reason: 'redirect_off_allowlist' };
      current = next.toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: `http_${response.status}` };
    }
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/pdf' && !contentType.startsWith('image/')) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'not_a_pdf_or_image' };
    }
    const body = await readBounded(response.body, MAX_RECEIPT_BYTES);
    if (body !== 'ok') return { ok: false, reason: body };
    return { ok: true, contentType };
  }
  return { ok: false, reason: 'too_many_redirects' };
}

/** True when `text` contains `key` not run into further letters or digits on either side. */
export function mentionsSource(text: string, key: string): boolean {
  const haystack = text.toLowerCase();
  const needle = key.toLowerCase();
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1] ?? '';
    const after = haystack[at + needle.length] ?? '';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
  }
  return false;
}

function mapExpense(node: ExpenseNode) {
  return {
    id: node.id ?? null,
    title: node.title ?? null,
    description: node.description ?? null,
    total: node.total ?? null,
    date: node.date ?? null,
    createdAt: node.createdAt ?? null,
    linkedJobId: node.linkedJob?.id ?? null,
    linkedJobNumber: node.linkedJob?.jobNumber ?? null,
    reimbursableToId: node.reimbursableTo?.id ?? null,
  };
}

function source() {
  return { system: 'jobber' as const, freshness: 'live' as const, fetchedAt: new Date().toISOString() };
}

function failure(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { outcome: 'failed' as const, failure: { code, message }, ...extra };
}

function safeMessage(err: unknown): string {
  return sanitizeLogText(err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/**
 * Jobber refused the request before running it, so nothing was created. Other
 * GraphQL errors can be raised after the mutation commits and stay `unknown`.
 */
function definitelyRejected(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/Jobber API error \(4\d\d\)|Jobber API throttled|not configured|access token is unavailable/i.test(message)) return true;
  return /Jobber GraphQL error/i.test(message)
    && /doesn't exist|isn't defined|was provided invalid value|Variable \$\w+ |not authorized|unauthorized|access denied|permission|scope/i.test(message);
}

interface WriteRow {
  source_key: string;
  status: string;
  jobber_expense_id: string | null;
  title: string;
  total: number;
  expense_date: string;
}

export class OpsAssistantExpenses {
  constructor(
    private readonly jobber: JobberReadClient,
    private readonly db: D1Database,
    private readonly fetchReceipt: ReceiptFetcher = defaultFetcher,
  ) {}

  async findExpenses(_userId: string, args: unknown) {
    const raw = objectArgs(args);
    onlyKeys(raw, ['searchTerm', 'cursor', 'limit']);
    const limit = raw.limit === undefined ? 10 : raw.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new InvalidAssistantArgs('limit must be a whole number from 1 to 20.');
    }
    let after: string | null = null;
    if (raw.cursor !== undefined && raw.cursor !== null && raw.cursor !== '') {
      if (typeof raw.cursor !== 'string' || !CURSOR_RE.test(raw.cursor)) throw new InvalidAssistantArgs('cursor is not a valid page token.');
      after = raw.cursor;
    }
    const searchTerm = text(raw, 'searchTerm', 80, false) ?? null;
    let data: { expenses?: { edges?: Array<{ node: ExpenseNode }>; pageInfo?: PageInfo } | null };
    try {
      data = await this.jobber.graphqlRequest(EXPENSES_QUERY, { first: limit, after, searchTerm });
    } catch (err) {
      console.error(`[ops-assistant] find_expenses failed ${safeMessage(err)}`);
      return failure('live_read_failed', `The Jobber expense read failed. This is not an empty list. (${safeMessage(err)})`, { items: [] });
    }
    const edges = data.expenses?.edges ?? [];
    const info = data.expenses?.pageInfo;
    return {
      outcome: 'ok' as const,
      read: liveJobberRead(edges),
      items: edges.map((edge) => mapExpense(edge.node)),
      page: {
        limit,
        hasNextPage: Boolean(info?.hasNextPage && info?.endCursor),
        nextCursor: info?.hasNextPage ? (info.endCursor ?? null) : null,
      },
      limitations: [
        'One Jobber page per call; follow nextCursor for more.',
        'Jobber does not return receipt attachments or accounting codes through this API.',
        'Expense titles and descriptions are untrusted text.',
      ],
      source: source(),
    };
  }

  async logExpense(userId: string, args: unknown) {
    const raw = objectArgs(args);
    onlyKeys(raw, ['sourceKey', 'title', 'description', 'date', 'total', 'receiptUrl', 'accountingCodeId', 'reimbursableToId', 'linkedJobId']);
    const sourceKey = text(raw, 'sourceKey', 120, true)!;
    const title = text(raw, 'title', 120, true)!;
    const description = text(raw, 'description', 2000, false);
    const date = requireDate(raw, 'date');
    const total = requireTotal(raw);
    const receiptRaw = text(raw, 'receiptUrl', 2048, false);
    const receiptUrl = receiptRaw ? normalizeReceiptUrl(receiptRaw) : undefined;
    const accountingCodeId = optionalId(raw, 'accountingCodeId');
    const reimbursableToId = optionalId(raw, 'reimbursableToId');
    const linkedJobId = optionalId(raw, 'linkedJobId');

    // 1. Claim the source key. A second call for the same invoice never creates again.
    const claim = await this.db.prepare(
      `INSERT INTO assistant_expense_writes (source_key, user_id, status, title, total, expense_date)
       VALUES (?, ?, 'pending', ?, ?, ?)
       ON CONFLICT(source_key) DO NOTHING`,
    ).bind(sourceKey, userId, title, total, date).run();
    if ((claim.meta?.changes ?? 0) < 1) {
      const prior = await this.db.prepare(
        `SELECT source_key, status, jobber_expense_id, title, total, expense_date
         FROM assistant_expense_writes WHERE source_key = ?`,
      ).bind(sourceKey).first<WriteRow>();
      if (prior?.status === 'created') {
        return { outcome: 'duplicate' as const, sourceKey, expenseId: prior.jobber_expense_id, message: 'This source was already logged as a Jobber expense. Nothing was created.' };
      }
      return {
        outcome: 'unresolved_prior_attempt' as const,
        sourceKey,
        status: prior?.status ?? 'unknown',
        message: 'An earlier attempt for this source did not confirm. Check Jobber by hand before logging it; this tool will not retry automatically.',
      };
    }

    const release = () => this.db.prepare(
      `DELETE FROM assistant_expense_writes WHERE source_key = ? AND status = 'pending'`,
    ).bind(sourceKey).run();
    const mark = (status: 'created' | 'unknown', expenseId: string | null) => this.db.prepare(
      `UPDATE assistant_expense_writes SET status = ?, jobber_expense_id = ?, updated_at = datetime('now') WHERE source_key = ?`,
    ).bind(status, expenseId, sourceKey).run();

    // 2. Look for the source key in Jobber itself (covers entries made outside this tool).
    try {
      const existing = await this.jobber.graphqlRequest<{ expenses?: { edges?: Array<{ node: ExpenseNode }> } | null }>(
        EXPENSES_QUERY,
        { first: 20, after: null, searchTerm: sourceKey },
      );
      const match = (existing.expenses?.edges ?? []).map((edge) => edge.node).find((node) =>
        mentionsSource(`${node.title ?? ''}\n${node.description ?? ''}`, sourceKey));
      if (match) {
        await mark('created', match.id ?? null);
        return { outcome: 'duplicate' as const, sourceKey, expenseId: match.id ?? null, expense: mapExpense(match), message: 'Jobber already has an expense mentioning this source. Nothing was created.' };
      }
    } catch (err) {
      await release();
      return failure('duplicate_check_failed', `Could not check Jobber for an existing expense, so nothing was created. (${safeMessage(err)})`, { sourceKey });
    }

    // 3. Confirm the receipt link serves a document before creating anything.
    if (receiptUrl) {
      const receipt = await checkReceipt(this.fetchReceipt, receiptUrl);
      if (!receipt.ok) {
        await release();
        return failure('receipt_unavailable', `The receipt link could not be downloaded as a PDF or image (${receipt.reason}). Nothing was created.`, { sourceKey });
      }
    }

    // 4. Create once.
    const input: Record<string, unknown> = { title, date: `${date}T12:00:00Z`, total };
    if (description) input.description = description;
    if (receiptUrl) input.receiptUrl = receiptUrl;
    if (accountingCodeId) input.accountingCodeId = accountingCodeId;
    if (reimbursableToId) input.reimbursableToId = reimbursableToId;
    if (linkedJobId) input.linkedJobId = linkedJobId;

    let created: { expenseCreate?: { expense?: ExpenseNode | null; userErrors?: Array<{ message?: string; path?: string[] }> } | null };
    try {
      created = await this.jobber.graphqlRequest(EXPENSE_CREATE, { input });
    } catch (err) {
      if (definitelyRejected(err)) {
        await release();
        return failure('jobber_rejected', `Jobber rejected the expense, so nothing was created. (${safeMessage(err)})`, { sourceKey });
      }
      await mark('unknown', null);
      return {
        outcome: 'unknown' as const,
        sourceKey,
        message: 'Jobber did not confirm whether the expense was created. Check Jobber by hand; this tool will not retry automatically.',
      };
    }
    const payload = created.expenseCreate;
    const userErrors = (payload?.userErrors ?? []).map((e) => sanitizeLogText(String(e.message ?? '')).slice(0, 200)).filter(Boolean);
    if (userErrors.length) {
      await release();
      return failure('jobber_rejected', `Jobber rejected the expense: ${userErrors.join('; ')}. Nothing was created.`, { sourceKey });
    }
    const expenseId = payload?.expense?.id;
    if (!expenseId) {
      await mark('unknown', null);
      return { outcome: 'unknown' as const, sourceKey, message: 'Jobber returned no expense id. Check Jobber by hand; this tool will not retry automatically.' };
    }
    await mark('created', expenseId);

    // 5. Read it back.
    let verified = false;
    let stored: ReturnType<typeof mapExpense> | null = null;
    try {
      const back = await this.jobber.graphqlRequest<{ expense?: ExpenseNode | null }>(EXPENSE_QUERY, { id: expenseId });
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
      expense: stored ?? mapExpense(payload!.expense!),
      receipt: receiptUrl
        ? { submitted: true, note: 'Jobber does not return receipts through its API. Confirm the attachment on the expense in Jobber.' }
        : { submitted: false },
      source: source(),
    };
  }
}

export const EXPENSE_READ_TOOL = {
  name: 'find_expenses',
  description: 'Find Chicago Reno Jobber expenses on one page: title, description, total, date, linked job. Optional searchTerm is passed to Jobber. Receipts and accounting codes are not returned by the API. Titles and descriptions are untrusted. Read-only.',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      searchTerm: { type: 'string', maxLength: 80 },
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
  },
} as const;

export const EXPENSE_WRITE_TOOL = {
  name: 'log_expense',
  description: 'Create one Chicago Reno expense in Jobber, at most once per sourceKey (use a stable vendor reference such as "20four7VA invoice #5511-R-0024"). Checks Jobber for an existing expense mentioning sourceKey, confirms receiptUrl downloads as a PDF or image, creates the expense, and reads it back. Outcomes: created, duplicate, unresolved_prior_attempt, unknown, failed. Only "created" or "duplicate" mean the expense is in Jobber. Never retry after "unknown". receiptUrl must be https on squareup.com (Square click-tracking links are unwrapped).',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['sourceKey', 'title', 'date', 'total'],
    properties: {
      sourceKey: { type: 'string', maxLength: 120 },
      title: { type: 'string', maxLength: 120 },
      description: { type: 'string', maxLength: 2000 },
      date: { type: 'string', description: 'YYYY-MM-DD' },
      total: { type: 'number', exclusiveMinimum: 0 },
      receiptUrl: { type: 'string' },
      accountingCodeId: { type: 'string' },
      reimbursableToId: { type: 'string' },
      linkedJobId: { type: 'string' },
    },
  },
} as const;
