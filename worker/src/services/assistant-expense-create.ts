import type { AssistantReceiptStore } from './assistant-receipts.js';
export class ExpenseInputError extends Error {}
import type { JobberReadClient } from './ops-assistant-read.js';

export interface ExpenseInvoice {
  supplier: string;
  invoiceNumber: string;
  title: string;
  description: string;
  date: string;
  total: number;
  receiptUrl?: string;
  receiptId?: string;
  accountingCodeId?: string;
  linkedJobId?: string;
  reimbursableToId?: string;
  operation?: 'create' | 'attach';
  targetExpenseId?: string;
  replaceReceiptConfirmed?: boolean;
}
export interface ExpenseWriteClient extends JobberReadClient {
  graphqlMutation<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}
interface ActionRow { id: string; user_id: string; payload: string; state: string; expense_id: string | null; expires_at: string }
const FIELDS = 'id title description date total';
const FIND = `query AssistantExpenseDuplicate($search: String!) {
  expenses(first: 100, searchTerm: $search) { nodes { ${FIELDS} } pageInfo { hasNextPage } }
}`;
const CREATE = `mutation AssistantExpenseCreate($input: ExpenseCreateInput!) {
  expenseCreate(input: $input) { expense { ${FIELDS} } userErrors { message path } }
}`;
const EDIT = `mutation AssistantExpenseReceipt($id: EncodedId!, $input: ExpenseEditInput!) {
  expenseEdit(expenseId: $id, input: $input) { expense { ${FIELDS} } userErrors { message path } }
}`;
const READ = `query AssistantCreatedExpense($id: EncodedId!) { expense(id: $id) { ${FIELDS} } }`;
type Expense = { id: string; title: string; description: string | null; date: string; total: number | null };

export function validateExpenseInvoice(raw: unknown): ExpenseInvoice {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ExpenseInputError('Expense details must be an object.');
  const x = raw as Record<string, unknown>;
  const keys = ['supplier', 'invoiceNumber', 'title', 'description', 'date', 'total', 'receiptUrl', 'receiptId', 'accountingCodeId', 'linkedJobId', 'reimbursableToId', 'operation', 'targetExpenseId', 'replaceReceiptConfirmed'];
  if (Object.keys(x).some(key => !keys.includes(key))) throw new ExpenseInputError('Unknown expense field.');
  for (const key of ['supplier', 'invoiceNumber', 'title', 'description', 'date']) {
    if (typeof x[key] !== 'string' || !x[key].trim()) throw new ExpenseInputError(`${key} is required.`);
  }
  if (!/^[A-Za-z0-9 ._-]{1,100}$/.test(String(x.supplier)) || !/^[A-Za-z0-9_-]{1,80}$/.test(String(x.invoiceNumber))) throw new ExpenseInputError('Invalid supplier or invoice number.');
  if (String(x.title).length > 200 || String(x.description).length > 4000) throw new ExpenseInputError('Expense text is too long.');
  if (typeof x.total !== 'number' || !Number.isFinite(x.total) || x.total <= 0 || x.total > 100000 || Math.abs(x.total * 100 - Math.round(x.total * 100)) > 0.000001) throw new ExpenseInputError('total must be a positive amount with at most two decimals.');
  const date = String(x.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) throw new ExpenseInputError('date must be a real YYYY-MM-DD date.');
  if ((typeof x.receiptId === 'string') === (typeof x.receiptUrl === 'string')) throw new ExpenseInputError('Provide exactly one receiptId or Square receiptUrl.');
  const idPattern = /^[A-Za-z0-9+/=_-]{4,200}$/;
  for (const key of ['accountingCodeId', 'linkedJobId', 'reimbursableToId', 'targetExpenseId']) {
    if (x[key] !== undefined && (typeof x[key] !== 'string' || !idPattern.test(x[key] as string))) throw new ExpenseInputError(`${key} is not a valid Jobber id.`);
  }
  if (x.operation !== undefined && !['create', 'attach'].includes(String(x.operation))) throw new ExpenseInputError('operation must be create or attach.');
  if (x.operation === 'attach' && !x.targetExpenseId) throw new ExpenseInputError('An existing expense id is required for attachment.');
  if (x.operation !== 'attach' && x.targetExpenseId) throw new ExpenseInputError('targetExpenseId requires attach operation.');
  if (x.replaceReceiptConfirmed !== undefined && typeof x.replaceReceiptConfirmed !== 'boolean') throw new ExpenseInputError('Invalid replacement confirmation.');
  if (x.receiptId !== undefined && (typeof x.receiptId !== 'string' || !/^[a-f0-9-]{36}$/.test(x.receiptId))) throw new ExpenseInputError('Invalid receiptId.');
  if (x.receiptUrl !== undefined) {
    let url: URL; try { url = new URL(String(x.receiptUrl)); } catch { throw new ExpenseInputError('Invalid receipt URL.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'squareup.com' || url.port || url.username || url.password || url.hash || url.pathname !== '/invoices/attachments/download/pdf/invoice' || !url.searchParams.get('token') || url.href.length > 4096) throw new ExpenseInputError('Upload a private receipt, or provide a direct HTTPS Square invoice PDF URL.');
  }
  return x as unknown as ExpenseInvoice;
}
export function expenseMarker(input: ExpenseInvoice) { return `[invoice:${input.supplier.toLowerCase().trim()}:${input.invoiceNumber.toLowerCase()}]`; }
function cleanExpense(expense: Expense) {
  // Receipt URLs and all upstream metadata are deliberately excluded.
  return { id: expense.id, title: expense.title, description: expense.description, date: expense.date, total: expense.total };
}
export class AssistantExpenseCreate {
  constructor(private db: D1Database, private jobber: ExpenseWriteClient, private receipts?: AssistantReceiptStore) {}

  async prepare(userId: string, raw: unknown, frontendOrigin: string) {
    const result = await this.save(userId, raw, 'pending');
    return { ...result, reviewUrl: result.authorizationId ? `${frontendOrigin}/expenses/review/${result.authorizationId}` : undefined, message: 'Review and approve these exact details before any Jobber write.' };
  }
  async review(userId: string, id: string) {
    const row = await this.db.prepare('SELECT * FROM assistant_expense_actions WHERE id = ? AND user_id = ?').bind(id, userId).first<ActionRow>();
    if (!row) return null;
    const input = validateExpenseInvoice(JSON.parse(row.payload));
    const { receiptUrl: _privateUrl, ...details } = input;
    return { authorizationId: row.id, state: row.state, expenseId: row.expense_id, expiresAt: row.expires_at, details, receiptSource: input.receiptId ? 'private_upload' : 'square_invoice', receiptReadbackAvailable: false };
  }
  async approve(userId: string, id: string, confirmReplacement = false) {
    const row = await this.db.prepare('SELECT * FROM assistant_expense_actions WHERE id = ? AND user_id = ?').bind(id, userId).first<ActionRow>();
    if (!row || row.state !== 'pending' || Date.parse(row.expires_at) <= Date.now()) return { outcome: 'review_required', message: 'This review is missing, expired, or already submitted.' };
    const input = validateExpenseInvoice(JSON.parse(row.payload));
    if (input.operation === 'attach') {
      if (!confirmReplacement) return { outcome: 'invalid_request', message: 'Confirm that setting this receipt may replace an existing receipt.' };
      input.replaceReceiptConfirmed = true;
    }
    const claim = await this.db.prepare("UPDATE assistant_expense_actions SET state = 'authorized', payload = ? WHERE id = ? AND user_id = ? AND state = 'pending' AND payload = ? AND expires_at > ?").bind(JSON.stringify(input), id, userId, row.payload, new Date().toISOString()).run();
    if (claim.meta.changes !== 1) return { outcome: 'review_required', message: 'Another review already handled this invoice.' };
    return this.create(userId, id);
  }

  /** Called only through a normal Cotiza user session, never an ops:read bearer. */
  async authorize(userId: string, raw: unknown) {
    const input = validateExpenseInvoice(raw);
    if (input.operation === 'attach' && !input.replaceReceiptConfirmed) throw new ExpenseInputError('Explicit receipt replacement confirmation is required.');
    return this.save(userId, input, 'authorized');
  }
  private async save(userId: string, raw: unknown, state: 'pending' | 'authorized') {
    const input = validateExpenseInvoice(raw);
    if (input.receiptId) {
      if (!this.receipts) throw new ExpenseInputError('Receipt uploads are unavailable.');
      await this.receipts.owned(userId, input.receiptId);
    }
    const key = expenseMarker(input);
    const id = crypto.randomUUID();
    const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await this.db.prepare(`INSERT OR IGNORE INTO assistant_expense_actions
      (id, user_id, invoice_key, payload, state, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, userId, key, JSON.stringify(input), state, expires).run();
    // Only expired, never-submitted entries may be renewed. Completed or uncertain actions stay locked.
    await this.db.prepare("UPDATE assistant_expense_actions SET state = ?, expires_at = ?, payload = ? WHERE invoice_key = ? AND user_id = ? AND state IN ('pending', 'authorized') AND expires_at < ?")
      .bind(state, expires, JSON.stringify(input), key, userId, new Date().toISOString()).run();
    const row = await this.db.prepare('SELECT * FROM assistant_expense_actions WHERE invoice_key = ?').bind(key).first<ActionRow>();
    if (!row || row.user_id !== userId) return { outcome: 'conflict', message: 'This invoice already has an expense action. Review it before proceeding.' };
    // Repeated authorization cannot replace the receipt/amount or rearm an uncertain action.
    if (row.payload !== JSON.stringify(input)) return { outcome: 'conflict', message: 'This invoice already has different authorized details.' };
    return { outcome: row.state === 'pending' ? 'pending' : 'authorized', authorizationId: row.id, state: row.state, expiresAt: row.expires_at, title: input.title, date: input.date, total: input.total, invoiceNumber: input.invoiceNumber };
  }

  async create(userId: string, authorizationId: unknown) {
    if (typeof authorizationId !== 'string' || !/^[a-f0-9-]{36}$/.test(authorizationId)) throw new Error('Invalid authorizationId.');
    const row = await this.db.prepare('SELECT * FROM assistant_expense_actions WHERE id = ? AND user_id = ?').bind(authorizationId, userId).first<ActionRow>();
    if (!row) return { outcome: 'unauthorized', message: 'Authorize this exact invoice from a Cotiza user session first.' };
    if (row.expense_id) return { outcome: row.state === 'verified' ? 'already_recorded' : 'created_unverified', expenseId: row.expense_id, receiptSubmitted: true, receiptReadbackAvailable: false };
    if (row.state !== 'authorized') return { outcome: 'review_required', message: 'A prior attempt may have created this expense. Do not retry automatically.' };
    if (Date.parse(row.expires_at) < Date.now()) return { outcome: 'expired', message: 'Invoice authorization expired.' };
    const input = validateExpenseInvoice(JSON.parse(row.payload));
    const marker = expenseMarker(input);
    if (input.operation === 'attach') {
      if (!input.replaceReceiptConfirmed) return { outcome: 'unauthorized', message: 'Receipt replacement requires explicit confirmation.' };
      const existing = await this.jobber.graphqlRequest<{ expense: Expense | null }>(READ, { id: input.targetExpenseId });
      if (!existing.expense || existing.expense.title !== input.title || existing.expense.total !== input.total || existing.expense.date.slice(0, 10) !== input.date) return { outcome: 'review_required', message: 'Existing expense details changed or do not match the approved receipt. Nothing was submitted.' };
    } else {
      const duplicates = await this.jobber.graphqlRequest<{ expenses: { nodes: Expense[]; pageInfo: { hasNextPage: boolean } } | null }>(FIND, { search: input.invoiceNumber });
      if (!duplicates?.expenses || !Array.isArray(duplicates.expenses.nodes)) return { outcome: 'failed', message: 'Could not check existing expenses. Nothing was submitted.' };
      const matches = duplicates.expenses.nodes.filter(e => e.description?.includes(marker) || `${e.title} ${e.description ?? ''}`.toLowerCase().includes(input.invoiceNumber.toLowerCase()));
      if (matches.length || duplicates.expenses.pageInfo.hasNextPage) return { outcome: 'review_required', message: 'Possible existing invoice expense or incomplete duplicate search. Nothing was submitted.', matches: matches.map(cleanExpense) };
    }
    const claim = await this.db.prepare("UPDATE assistant_expense_actions SET state = 'submitting' WHERE id = ? AND user_id = ? AND state = 'authorized' AND payload = ? AND expires_at > ?").bind(row.id, userId, row.payload, new Date().toISOString()).run();
    if (claim.meta.changes !== 1) return { outcome: 'review_required', message: 'Another attempt owns this invoice. Do not retry.' };
    let expense: Expense;
    let submitted = false;
    try {
      const receiptUrl = input.receiptId ? await this.receipts?.grant(userId, input.receiptId) : input.receiptUrl;
      if (!receiptUrl) throw new Error('Receipt unavailable');
      const variables = input.operation === 'attach' ? { id: input.targetExpenseId, input: { receiptUrl } } : {
        input: { title: input.title, description: `${input.description}\n${marker}`, date: `${input.date}T12:00:00Z`, total: input.total, receiptUrl,
          ...(input.accountingCodeId ? { accountingCodeId: input.accountingCodeId } : {}),
          ...(input.linkedJobId ? { linkedJobId: input.linkedJobId } : {}),
          ...(input.reimbursableToId ? { reimbursableToId: input.reimbursableToId } : {}),
        },
      };
      submitted = true;
      const response = await this.jobber.graphqlMutation<{ expenseCreate?: { expense: Expense | null; userErrors: Array<{ message: string }> }; expenseEdit?: { expense: Expense | null; userErrors: Array<{ message: string }> } }>(input.operation === 'attach' ? EDIT : CREATE, variables);
      const data = { expenseCreate: input.operation === 'attach' ? response.expenseEdit : response.expenseCreate };
      if (!data?.expenseCreate || !Array.isArray(data.expenseCreate.userErrors)) throw new Error('Missing result');
      if (data.expenseCreate.userErrors.length || !data.expenseCreate.expense?.id) {
        await this.db.prepare("UPDATE assistant_expense_actions SET state = 'rejected' WHERE id = ?").bind(row.id).run();
        return { outcome: 'rejected', message: 'Jobber rejected the expense. No automatic retry. Check expense API permissions and invoice PDF support.' };
      }
      expense = data.expenseCreate.expense;
      // Persist the known ID before the verification read so a failed read cannot cause a second creation.
      await this.db.prepare("UPDATE assistant_expense_actions SET state = 'created', expense_id = ? WHERE id = ?").bind(expense.id, row.id).run();
    } catch {
      if (!submitted) {
        await this.db.prepare("UPDATE assistant_expense_actions SET state = 'pending' WHERE id = ? AND state = 'submitting'").bind(row.id).run();
        return { outcome: 'failed', message: 'Receipt preparation failed before any Jobber write. Review the receipt and approve again.' };
      }
      return { outcome: 'unknown', message: 'Creation result is uncertain. Do not create another expense. Check Jobber for this invoice.', authorizationId: row.id };
    }
    try {
      const read = await this.jobber.graphqlRequest<{ expense: Expense | null }>(READ, { id: expense.id });
      if (!read.expense || read.expense.total !== input.total || read.expense.title !== input.title || read.expense.date.slice(0, 10) !== input.date || (input.operation !== 'attach' && !read.expense.description?.includes(marker))) throw new Error('Verification mismatch');
      await this.db.prepare("UPDATE assistant_expense_actions SET state = 'verified' WHERE id = ?").bind(row.id).run();
      return { outcome: input.operation === 'attach' ? 'receipt_submitted' : 'created', expense: cleanExpense(read.expense), receiptSubmitted: true, receiptReadbackAvailable: false };
    } catch {
      return { outcome: 'created_unverified', expenseId: expense.id, receiptSubmitted: true, message: 'Creation was accepted, but record read-back failed. Do not create another expense.' };
    }
  }
}
