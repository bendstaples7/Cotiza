import type { JobberReadClient } from './ops-assistant-read.js';

export interface ExpenseInvoice {
  supplier: string;
  invoiceNumber: string;
  title: string;
  description: string;
  date: string;
  total: number;
  receiptUrl: string;
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
const READ = `query AssistantCreatedExpense($id: EncodedId!) { expense(id: $id) { ${FIELDS} } }`;
type Expense = { id: string; title: string; description: string | null; date: string; total: number | null };

export function validateExpenseInvoice(raw: unknown): ExpenseInvoice {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expense details must be an object.');
  const x = raw as Record<string, unknown>;
  const keys = ['supplier', 'invoiceNumber', 'title', 'description', 'date', 'total', 'receiptUrl'];
  if (Object.keys(x).some(key => !keys.includes(key))) throw new Error('Unknown expense field.');
  for (const key of ['supplier', 'invoiceNumber', 'title', 'description', 'date', 'receiptUrl']) {
    if (typeof x[key] !== 'string' || !x[key].trim()) throw new Error(`${key} is required.`);
  }
  if (!/^[A-Za-z0-9 ._-]{1,100}$/.test(String(x.supplier)) || !/^[A-Za-z0-9_-]{1,80}$/.test(String(x.invoiceNumber))) throw new Error('Invalid supplier or invoice number.');
  if (String(x.title).length > 200 || String(x.description).length > 4000) throw new Error('Expense text is too long.');
  if (typeof x.total !== 'number' || !Number.isFinite(x.total) || x.total <= 0 || x.total > 100000 || Math.abs(x.total * 100 - Math.round(x.total * 100)) > 0.000001) throw new Error('total must be a positive amount with at most two decimals.');
  const date = String(x.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('date must be a real YYYY-MM-DD date.');
  let url: URL;
  try { url = new URL(String(x.receiptUrl)); } catch { throw new Error('Invalid receipt URL.'); }
  // Square invoice downloads only for the first release. Never expose a general URL fetch or blob-upload capability.
  if (url.protocol !== 'https:' || url.hostname !== 'squareup.com' || url.port || url.username || url.password || url.hash || url.pathname !== '/invoices/attachments/download/pdf/invoice' || !url.searchParams.get('token') || url.href.length > 4096) throw new Error('A direct HTTPS Square invoice PDF URL is required.');
  return x as unknown as ExpenseInvoice;
}
export function expenseMarker(input: ExpenseInvoice) { return `[invoice:${input.supplier.toLowerCase().trim()}:${input.invoiceNumber.toLowerCase()}]`; }
function cleanExpense(expense: Expense) {
  // Receipt URLs and all upstream metadata are deliberately excluded.
  return { id: expense.id, title: expense.title, description: expense.description, date: expense.date, total: expense.total };
}
export class AssistantExpenseCreate {
  constructor(private db: D1Database, private jobber: ExpenseWriteClient) {}

  /** Called only through a normal Cotiza user session, never an ops:read bearer. */
  async authorize(userId: string, raw: unknown) {
    const input = validateExpenseInvoice(raw);
    const key = expenseMarker(input);
    const id = crypto.randomUUID();
    const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await this.db.prepare(`INSERT OR IGNORE INTO assistant_expense_actions
      (id, user_id, invoice_key, payload, state, expires_at) VALUES (?, ?, ?, ?, 'authorized', ?)`)
      .bind(id, userId, key, JSON.stringify(input), expires).run();
    const row = await this.db.prepare('SELECT * FROM assistant_expense_actions WHERE invoice_key = ?').bind(key).first<ActionRow>();
    if (!row || row.user_id !== userId) return { outcome: 'conflict', message: 'This invoice already has an expense action. Review it before proceeding.' };
    // Repeated authorization cannot replace the receipt/amount or rearm an uncertain action.
    if (row.payload !== JSON.stringify(input)) return { outcome: 'conflict', message: 'This invoice already has different authorized details.' };
    return { outcome: 'authorized', authorizationId: row.id, state: row.state, expiresAt: row.expires_at, title: input.title, date: input.date, total: input.total, invoiceNumber: input.invoiceNumber };
  }

  async create(userId: string, authorizationId: unknown) {
    if (typeof authorizationId !== 'string' || !/^[a-f0-9-]{36}$/.test(authorizationId)) throw new Error('Invalid authorizationId.');
    const row = await this.db.prepare('SELECT * FROM assistant_expense_actions WHERE id = ? AND user_id = ?').bind(authorizationId, userId).first<ActionRow>();
    if (!row) return { outcome: 'unauthorized', message: 'Authorize this exact invoice from a Cotiza user session first.' };
    if (row.expense_id) return { outcome: 'already_recorded', expenseId: row.expense_id, receiptSubmitted: true };
    if (row.state !== 'authorized') return { outcome: 'review_required', message: 'A prior attempt may have created this expense. Do not retry automatically.' };
    if (Date.parse(row.expires_at) < Date.now()) return { outcome: 'expired', message: 'Invoice authorization expired.' };
    const input = validateExpenseInvoice(JSON.parse(row.payload));
    const marker = expenseMarker(input);
    const duplicates = await this.jobber.graphqlRequest<{ expenses: { nodes: Expense[]; pageInfo: { hasNextPage: boolean } } | null }>(FIND, { search: input.invoiceNumber });
    if (!duplicates?.expenses || !Array.isArray(duplicates.expenses.nodes)) return { outcome: 'failed', message: 'Could not check existing expenses. Nothing was submitted.' };
    const matches = duplicates.expenses.nodes.filter(e => e.description?.includes(marker) || `${e.title} ${e.description ?? ''}`.toLowerCase().includes(input.invoiceNumber.toLowerCase()));
    if (matches.length || duplicates.expenses.pageInfo.hasNextPage) return { outcome: 'review_required', message: 'Possible existing invoice expense or incomplete duplicate search. Nothing was submitted.', matches: matches.map(cleanExpense) };
    const claim = await this.db.prepare("UPDATE assistant_expense_actions SET state = 'submitting' WHERE id = ? AND user_id = ? AND state = 'authorized'").bind(row.id, userId).run();
    if (claim.meta.changes !== 1) return { outcome: 'review_required', message: 'Another attempt owns this invoice. Do not retry.' };
    let expense: Expense;
    try {
      const data = await this.jobber.graphqlMutation<{ expenseCreate: { expense: Expense | null; userErrors: Array<{ message: string }> } }>(CREATE, {
        input: { title: input.title, description: `${input.description}\n${marker}`, date: `${input.date}T12:00:00Z`, total: input.total, receiptUrl: input.receiptUrl },
      });
      if (!data?.expenseCreate || !Array.isArray(data.expenseCreate.userErrors)) throw new Error('Missing result');
      if (data.expenseCreate.userErrors.length || !data.expenseCreate.expense?.id) {
        await this.db.prepare("UPDATE assistant_expense_actions SET state = 'rejected' WHERE id = ?").bind(row.id).run();
        return { outcome: 'rejected', message: 'Jobber rejected the expense. No automatic retry. Check expense API permissions and invoice PDF support.' };
      }
      expense = data.expenseCreate.expense;
      // Persist the known ID before the verification read so a failed read cannot cause a second creation.
      await this.db.prepare("UPDATE assistant_expense_actions SET state = 'created', expense_id = ? WHERE id = ?").bind(expense.id, row.id).run();
    } catch {
      return { outcome: 'unknown', message: 'Creation result is uncertain. Do not create another expense. Check Jobber for this invoice.', authorizationId: row.id };
    }
    try {
      const read = await this.jobber.graphqlRequest<{ expense: Expense | null }>(READ, { id: expense.id });
      if (!read.expense || read.expense.total !== input.total || !read.expense.description?.includes(marker)) throw new Error('Verification mismatch');
      return { outcome: 'created', expense: cleanExpense(read.expense), receiptSubmitted: true, receiptReadbackAvailable: false };
    } catch {
      return { outcome: 'created_unverified', expenseId: expense.id, receiptSubmitted: true, message: 'Creation was accepted, but record read-back failed. Do not create another expense.' };
    }
  }
}
