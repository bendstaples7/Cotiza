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
export { MAX_ITEMS_PER_LEAD };
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

/** Duplicate key: Unicode-normalized, case-folded, single-spaced. Must match what the unique index stores. */
export function questionKey(question: string): string {
  return question.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export const ITEM_ID_RE = /^lii_[0-9a-f-]{36}$/;

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LeadInfoError('Send the change as an object.');
  return input as Record<string, unknown>;
}

/**
 * The item after a change, or a LeadInfoError. Pure, so a batch can be checked in full before
 * anything is written.
 */
export function applyChange(item: LeadInfoItem, input: unknown): LeadInfoItem {
  const fields = objectInput(input);
  let status = item.status;
  if (fields.status !== undefined) {
    if (!(LEAD_INFO_STATUSES as readonly unknown[]).includes(fields.status)) throw new LeadInfoError(`status must be one of ${LEAD_INFO_STATUSES.join(', ')}.`);
    status = fields.status as LeadInfoStatus;
  }
  let answer = item.answer;
  if (fields.answer !== undefined) {
    answer = fields.answer === null || fields.answer === '' ? null : cleanText(fields.answer, 'answer', MAX_ANSWER);
    if (answer && fields.status === undefined) status = 'answered';
  }
  if (status === 'answered' && !answer) throw new LeadInfoError('An answered question needs the answer.');
  const question = fields.question === undefined ? item.question : cleanText(fields.question, 'question', MAX_QUESTION, 3);
  return { ...item, question, status, answer };
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
  /** Checklist items for many leads in one read, each lead's in insertion order. */
  async listMany(requestIds: string[]): Promise<Record<string, LeadInfoItem[]>> {
    const ids = [...new Set(requestIds.filter((id) => REQUEST_ID_RE.test(id)))].slice(0, 200);
    if (!ids.length) return {};
    const { results } = await this.db.prepare(
      `SELECT * FROM lead_info_items WHERE jobber_request_id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid ASC`,
    ).bind(...ids).all<Record<string, unknown>>();
    const grouped: Record<string, LeadInfoItem[]> = {};
    for (const item of (results ?? []).map(rowToItem)) (grouped[item.requestId] ??= []).push(item);
    return grouped;
  }

  async summaries(requestIds: string[]): Promise<Record<string, LeadInfoSummary>> {
    const grouped = await this.listMany(requestIds);
    return Object.fromEntries(Object.entries(grouped).map(([id, items]) => [id, summarize(items)]));
  }

  async add(requestId: string, input: { question?: unknown; required?: unknown } | null | undefined, by: { userId: string; via: LeadInfoVia }): Promise<LeadInfoItem> {
    const id = requireRequestId(requestId);
    const fields = objectInput(input);
    const question = cleanText(fields.question, 'question', MAX_QUESTION, 3);
    if (fields.required !== undefined && typeof fields.required !== 'boolean') throw new LeadInfoError('required must be true or false.');
    const now = this.now().toISOString();
    const itemId = `lii_${crypto.randomUUID()}`;
    const required = fields.required === false ? 0 : 1;
    // The cap and the duplicate check live in the statement (and a unique index) so two saves at
    // the same moment can't both slip past them.
    const result = await this.db.prepare(
      `INSERT INTO lead_info_items
         (id, jobber_request_id, question, question_key, status, answer, required, created_at, updated_at, created_via, created_by_user_id, updated_by_user_id, updated_via)
       SELECT ?, ?, ?, ?, 'open', NULL, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM lead_info_items WHERE jobber_request_id = ?) < ?
       ON CONFLICT DO NOTHING`,
    ).bind(itemId, id, question, questionKey(question), required, now, now, by.via, by.userId, by.userId, by.via, id, MAX_ITEMS_PER_LEAD).run();
    if ((result.meta?.changes ?? 0) > 0) {
      return {
        id: itemId, requestId: id, question, status: 'open', answer: null, required: required === 1,
        createdAt: now, updatedAt: now, createdVia: by.via, updatedVia: by.via,
      };
    }
    const duplicate = (await this.list(id)).find((i) => i.status !== 'dropped' && questionKey(i.question) === questionKey(question));
    if (duplicate) return duplicate;
    throw new LeadInfoError(`A lead can have at most ${MAX_ITEMS_PER_LEAD} questions.`);
  }

  async update(itemId: unknown, input: { status?: unknown; answer?: unknown; question?: unknown } | null | undefined, by: { userId: string; via: LeadInfoVia }): Promise<LeadInfoItem> {
    if (typeof itemId !== 'string' || !ITEM_ID_RE.test(itemId)) throw new LeadInfoError('itemId is not valid.');
    const row = await this.db.prepare(`SELECT * FROM lead_info_items WHERE id = ?`).bind(itemId).first<Record<string, unknown>>();
    if (!row) throw new LeadInfoError('That question no longer exists.');
    const next = applyChange(rowToItem(row), input);
    const now = this.now().toISOString();
    try {
      await this.db.prepare(
        `UPDATE lead_info_items SET question = ?, question_key = ?, status = ?, answer = ?, updated_at = ?, updated_by_user_id = ?, updated_via = ? WHERE id = ?`,
      ).bind(next.question, questionKey(next.question), next.status, next.answer, now, by.userId, by.via, itemId).run();
    } catch (err) {
      if (/UNIQUE/i.test(err instanceof Error ? err.message : '')) throw new LeadInfoError('That question is already on the list.');
      throw err;
    }
    return { ...next, updatedAt: now, updatedVia: by.via };
  }
}
