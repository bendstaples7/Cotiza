/**
 * "Info needed" checklist for a lead (one Jobber request): the questions that must be
 * answered by the customer before a quote can be written, and the answers the team logs.
 *
 * Written from the Cotiza lead page (`via: 'app'`) and the assistant connector
 * (`via: 'assistant'`). A lead is ready to quote when every required item is answered or
 * dropped. Contact details don't belong here: they stay in Jobber, Quo and Gmail.
 */

export const LEAD_INFO_STATUSES = ['open', 'asked', 'answered', 'dropped'] as const;
export type LeadInfoStatus = typeof LEAD_INFO_STATUSES[number];
export type LeadInfoVia = 'app' | 'assistant';

export interface LeadInfoItem {
  id: string;
  requestId: string;
  question: string;
  status: LeadInfoStatus;
  answer: string | null;
  required: boolean;
  createdAt: string;
  updatedAt: string;
  createdVia: LeadInfoVia;
  updatedVia: LeadInfoVia;
}

export interface LeadInfoSummary {
  total: number;
  open: number;
  asked: number;
  answered: number;
  /** True when there is at least one item and every required item is answered or dropped. */
  readyToQuote: boolean;
}

export class LeadInfoError extends Error {}

const REQUEST_ID_RE = /^[A-Za-z0-9+/=_-]{4,200}$/;
const MAX_QUESTION = 300;
const MAX_ANSWER = 2000;
const MAX_ITEMS_PER_LEAD = 30;
// A phone number or email in an answer is contact data: it belongs in Jobber, not this list.
const CONTACT_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}|(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/i;

export function requireRequestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID_RE.test(value)) throw new LeadInfoError('requestId is not a valid Jobber request id.');
  return value;
}

function cleanText(value: unknown, field: string, max: number, min = 1): string {
  if (typeof value !== 'string') throw new LeadInfoError(`${field} must be text.`);
  const text = value.replace(/\r\n/g, '\n').trim();
  if (text.length < min || text.length > max) throw new LeadInfoError(`${field} must be ${min} to ${max} characters.`);
  if (CONTACT_RE.test(text)) throw new LeadInfoError(`${field} looks like it contains a phone number or email. Keep contact details in Jobber.`);
  return text;
}

/** Check a question without saving it (lets callers reject a batch before writing any of it). */
export function validateQuestion(value: unknown): string {
  return cleanText(value, 'question', MAX_QUESTION, 3);
}

function rowToItem(row: Record<string, unknown>): LeadInfoItem {
  return {
    id: String(row.id),
    requestId: String(row.jobber_request_id),
    question: String(row.question),
    status: row.status as LeadInfoStatus,
    answer: (row.answer as string | null) ?? null,
    required: Number(row.required) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    createdVia: row.created_via as LeadInfoVia,
    updatedVia: row.updated_via as LeadInfoVia,
  };
}

export function summarize(items: LeadInfoItem[]): LeadInfoSummary {
  const count = (s: LeadInfoStatus) => items.filter((i) => i.status === s).length;
  const required = items.filter((i) => i.required);
  return {
    total: items.length,
    open: count('open'),
    asked: count('asked'),
    answered: count('answered'),
    readyToQuote: items.length > 0 && required.every((i) => i.status === 'answered' || i.status === 'dropped'),
  };
}

export class LeadInfoService {
  constructor(private readonly db: D1Database, private readonly now: () => Date = () => new Date()) {}

  async list(requestId: string): Promise<LeadInfoItem[]> {
    const id = requireRequestId(requestId);
    const { results } = await this.db.prepare(
      `SELECT * FROM lead_info_items WHERE jobber_request_id = ? ORDER BY rowid ASC`,
    ).bind(id).all<Record<string, unknown>>();
    return (results ?? []).map(rowToItem);
  }

  /** Summaries for many leads at once (queue cards, list_open_leads). Leads without items are omitted. */
  async summaries(requestIds: string[]): Promise<Record<string, LeadInfoSummary>> {
    const ids = [...new Set(requestIds.filter((id) => REQUEST_ID_RE.test(id)))].slice(0, 200);
    if (!ids.length) return {};
    const { results } = await this.db.prepare(
      `SELECT * FROM lead_info_items WHERE jobber_request_id IN (${ids.map(() => '?').join(',')})`,
    ).bind(...ids).all<Record<string, unknown>>();
    const grouped = new Map<string, LeadInfoItem[]>();
    for (const item of (results ?? []).map(rowToItem)) {
      grouped.set(item.requestId, [...(grouped.get(item.requestId) ?? []), item]);
    }
    return Object.fromEntries([...grouped].map(([id, items]) => [id, summarize(items)]));
  }

  async add(requestId: string, input: { question?: unknown; required?: unknown }, by: { userId: string; via: LeadInfoVia }): Promise<LeadInfoItem> {
    const id = requireRequestId(requestId);
    const question = cleanText(input.question, 'question', MAX_QUESTION, 3);
    if (input.required !== undefined && typeof input.required !== 'boolean') throw new LeadInfoError('required must be true or false.');
    const existing = await this.list(id);
    if (existing.length >= MAX_ITEMS_PER_LEAD) throw new LeadInfoError(`A lead can have at most ${MAX_ITEMS_PER_LEAD} questions.`);
    const duplicate = existing.find((i) => i.status !== 'dropped' && i.question.toLowerCase() === question.toLowerCase());
    if (duplicate) return duplicate;
    const now = this.now().toISOString();
    const itemId = `lii_${crypto.randomUUID()}`;
    await this.db.prepare(
      `INSERT INTO lead_info_items
         (id, jobber_request_id, question, status, answer, required, created_at, updated_at, created_via, created_by_user_id, updated_by_user_id, updated_via)
       VALUES (?, ?, ?, 'open', NULL, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(itemId, id, question, input.required === false ? 0 : 1, now, now, by.via, by.userId, by.userId, by.via).run();
    return {
      id: itemId, requestId: id, question, status: 'open', answer: null, required: input.required !== false,
      createdAt: now, updatedAt: now, createdVia: by.via, updatedVia: by.via,
    };
  }

  async update(itemId: unknown, input: { status?: unknown; answer?: unknown; question?: unknown }, by: { userId: string; via: LeadInfoVia }): Promise<LeadInfoItem> {
    if (typeof itemId !== 'string' || !/^lii_[0-9a-f-]{36}$/.test(itemId)) throw new LeadInfoError('itemId is not valid.');
    const row = await this.db.prepare(`SELECT * FROM lead_info_items WHERE id = ?`).bind(itemId).first<Record<string, unknown>>();
    if (!row) throw new LeadInfoError('That question no longer exists.');
    const item = rowToItem(row);
    let status = item.status;
    if (input.status !== undefined) {
      if (!(LEAD_INFO_STATUSES as readonly unknown[]).includes(input.status)) throw new LeadInfoError(`status must be one of ${LEAD_INFO_STATUSES.join(', ')}.`);
      status = input.status as LeadInfoStatus;
    }
    let answer = item.answer;
    if (input.answer !== undefined) {
      answer = input.answer === null || input.answer === '' ? null : cleanText(input.answer, 'answer', MAX_ANSWER);
      if (answer && input.status === undefined) status = 'answered';
    }
    if (status === 'answered' && !answer) throw new LeadInfoError('An answered question needs the answer.');
    const question = input.question === undefined ? item.question : cleanText(input.question, 'question', MAX_QUESTION, 3);
    const now = this.now().toISOString();
    await this.db.prepare(
      `UPDATE lead_info_items SET question = ?, status = ?, answer = ?, updated_at = ?, updated_by_user_id = ?, updated_via = ? WHERE id = ?`,
    ).bind(question, status, answer, now, by.userId, by.via, itemId).run();
    return { ...item, question, status, answer, updatedAt: now, updatedVia: by.via };
  }
}
