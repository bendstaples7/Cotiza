import { InvalidAssistantArgs } from './ops-assistant-read.js';
import type { AssistantPrincipal } from './assistant-access.js';

/**
 * Chicago Reno quote-review ledger: Ben's review decisions and per-quote records.
 * Append-only. Nothing here reads or writes Jobber.
 */

export const REVIEW_FEEDBACK_STATUSES = ['confirmed', 'conditional', 'accepted/closed', 'superseded', 'proposed'] as const;
/** `superseded` is only reached by writing a newer entry with `supersedes`. */
const WRITABLE_STATUSES = REVIEW_FEEDBACK_STATUSES.filter((status) => status !== 'superseded');

export const REVIEW_FEEDBACK_LIMITS = {
  defaultPageSize: 25,
  maxPageSize: 50,
  author: 80,
  source: 200,
  scope: 120,
  statusDetail: 200,
  excerpt: 1000,
  rule: 2000,
  recordChars: 16_000,
  recordDepth: 6,
} as const;

/** Keys that would hold customer contact details. Rejected on write, dropped on import. */
export const CONTACT_KEY_RE = /^(client|client_name|customer|customer_name|contact|contact_name|email|emails|phone|phones|mobile|address|street|property_address|service_address)$/i;

const QUOTE_NUMBER_RE = /^\d{1,10}$/;
const ENTRY_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const CURSOR_RE = /^\d{1,12}$/;
const RECORD_KEY_RE = /^[A-Za-z0-9_]{1,64}$/;

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

/** Strips control characters except newline and tab, then trims. */
function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
}

function requiredText(raw: Record<string, unknown>, key: string, max: number): string {
  const value = raw[key];
  if (typeof value !== 'string') throw new InvalidAssistantArgs(`${key} is required text.`);
  const text = cleanText(value);
  if (!text) throw new InvalidAssistantArgs(`${key} must not be empty.`);
  if (text.length > max) throw new InvalidAssistantArgs(`${key} must be ${max} characters or fewer.`);
  return text;
}

function optionalText(raw: Record<string, unknown>, key: string, max: number): string | null {
  if (raw[key] === undefined || raw[key] === null || raw[key] === '') return null;
  return requiredText(raw, key, max);
}

function optionalQuoteNumber(raw: Record<string, unknown>): string | null {
  const value = raw.quoteNumber;
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !QUOTE_NUMBER_RE.test(text.trim().replace(/^#/, ''))) {
    throw new InvalidAssistantArgs('quoteNumber must be a Jobber quote number such as "706".');
  }
  return text.trim().replace(/^#/, '');
}

function optionalBoolean(raw: Record<string, unknown>, key: string): boolean {
  if (raw[key] === undefined || raw[key] === null) return false;
  if (typeof raw[key] !== 'boolean') throw new InvalidAssistantArgs(`${key} must be true or false.`);
  return raw[key] as boolean;
}

function pageArgs(raw: Record<string, unknown>): { limit: number; afterSeq: number } {
  const limit = raw.limit === undefined ? REVIEW_FEEDBACK_LIMITS.defaultPageSize : raw.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > REVIEW_FEEDBACK_LIMITS.maxPageSize) {
    throw new InvalidAssistantArgs(`limit must be a whole number from 1 to ${REVIEW_FEEDBACK_LIMITS.maxPageSize}.`);
  }
  let afterSeq = 0;
  if (raw.cursor !== undefined && raw.cursor !== null && raw.cursor !== '') {
    if (typeof raw.cursor !== 'string' || !CURSOR_RE.test(raw.cursor)) {
      throw new InvalidAssistantArgs('cursor is not a valid page token.');
    }
    afterSeq = Number(raw.cursor);
  }
  return { limit, afterSeq };
}

/** Checks a per-quote record: plain JSON object, bounded size and depth, no contact-detail keys. */
export function validateQuoteRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidAssistantArgs('record must be an object, for example { "edit_register": [...], "closed_findings": [...], "verification": [...] }.');
  }
  const walk = (node: unknown, depth: number, path: string) => {
    if (depth > REVIEW_FEEDBACK_LIMITS.recordDepth) throw new InvalidAssistantArgs(`record is nested too deeply at ${path}.`);
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, depth + 1, `${path}[${i}]`));
    } else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (!RECORD_KEY_RE.test(key)) throw new InvalidAssistantArgs(`record key "${key.slice(0, 64)}" must be letters, digits or underscores.`);
        if (CONTACT_KEY_RE.test(key)) throw new InvalidAssistantArgs(`record must not hold customer contact details ("${key}").`);
        walk(child, depth + 1, `${path}.${key}`);
      }
    } else if (!['string', 'number', 'boolean'].includes(typeof node) && node !== null) {
      throw new InvalidAssistantArgs(`record holds an unsupported value at ${path}.`);
    }
  };
  walk(value, 1, 'record');
  if (JSON.stringify(value).length > REVIEW_FEEDBACK_LIMITS.recordChars) {
    throw new InvalidAssistantArgs(`record must be ${REVIEW_FEEDBACK_LIMITS.recordChars} characters of JSON or fewer.`);
  }
  return value as Record<string, unknown>;
}

function source() {
  return { system: 'cotiza' as const, freshness: 'stored' as const, fetchedAt: new Date().toISOString() };
}

export interface FeedbackRow {
  seq: number;
  id: string;
  created_at: string;
  author: string;
  source: string;
  quote_number: string | null;
  status: string;
  status_detail: string | null;
  scope: string;
  excerpt: string;
  rule: string;
  supersedes: string | null;
  superseded_by: string | null;
  written_via: string;
}

export interface QuoteRecordRow {
  id: string;
  created_at: string;
  author: string;
  source: string;
  quote_number: string;
  record: string;
  supersedes: string | null;
  written_via: string;
}

function mapEntry(row: FeedbackRow) {
  return {
    id: row.id,
    createdAt: row.created_at,
    author: row.author,
    source: row.source,
    quoteNumber: row.quote_number,
    status: row.status,
    statusDetail: row.status_detail,
    scope: row.scope,
    excerpt: row.excerpt,
    rule: row.rule,
    supersedes: row.supersedes,
    supersededBy: row.superseded_by ? row.superseded_by.split(',') : [],
    writtenVia: row.written_via,
  };
}

function mapRecord(row: QuoteRecordRow) {
  let record: unknown = null;
  try {
    record = JSON.parse(row.record);
  } catch {
    record = null;
  }
  return {
    id: row.id,
    createdAt: row.created_at,
    author: row.author,
    source: row.source,
    quoteNumber: row.quote_number,
    supersedes: row.supersedes,
    writtenVia: row.written_via,
    record,
  };
}

function storedFailure(action: 'read' | 'write', err: unknown) {
  console.error(`[review-feedback] ${action} failed`, err instanceof Error ? err.message.slice(0, 160) : '');
  return action === 'read'
    ? { outcome: 'failed' as const, failure: { code: 'stored_read_failed', message: 'Review feedback could not be read. This is not an empty ledger.' }, items: [] as unknown[] }
    : { outcome: 'failed' as const, failure: { code: 'stored_write_failed', message: 'The entry may not have been recorded. Read the ledger before trying again.' } };
}

export class ReviewFeedbackStore {
  constructor(private readonly db: D1Database) {}

  async read(args: unknown) {
    const raw = objectArgs(args);
    onlyKeys(raw, ['quoteNumber', 'includeOtherQuotes', 'includeSuperseded', 'cursor', 'limit']);
    const quoteNumber = optionalQuoteNumber(raw);
    const includeOtherQuotes = optionalBoolean(raw, 'includeOtherQuotes');
    const includeSuperseded = optionalBoolean(raw, 'includeSuperseded');
    const { limit, afterSeq } = pageArgs(raw);

    let rows: FeedbackRow[];
    try {
      const result = await this.db.prepare(
        `SELECT f.seq, f.id, f.created_at, f.author, f.source, f.quote_number, f.status, f.status_detail,
                f.scope, f.excerpt, f.rule, f.supersedes, f.written_via,
                (SELECT group_concat(n.id) FROM quote_review_feedback n WHERE n.supersedes = f.id) AS superseded_by
         FROM quote_review_feedback f
         WHERE f.seq > ?
           AND (? = 1 OR f.quote_number IS NULL OR f.quote_number = ?)
           AND (? = 1 OR (f.status <> 'superseded'
                AND NOT EXISTS (SELECT 1 FROM quote_review_feedback n WHERE n.supersedes = f.id)))
         ORDER BY f.seq
         LIMIT ?`,
      ).bind(afterSeq, includeOtherQuotes ? 1 : 0, quoteNumber ?? '', includeSuperseded ? 1 : 0, limit + 1).all<FeedbackRow>();
      rows = result.results ?? [];
    } catch (err) {
      return storedFailure('read', err);
    }

    const pageRows = rows.slice(0, limit);
    const hasNextPage = rows.length > limit;
    const last = pageRows[pageRows.length - 1];

    let quoteRecord: Record<string, unknown> | null = null;
    if (quoteNumber && afterSeq === 0) {
      try {
        const row = await this.db.prepare(
          `SELECT id, created_at, author, source, quote_number, record, supersedes, written_via
           FROM quote_review_records WHERE quote_number = ? ORDER BY seq DESC LIMIT 1`,
        ).bind(quoteNumber).first<QuoteRecordRow>();
        quoteRecord = row ? { outcome: 'ok', ...mapRecord(row) } : { outcome: 'not_found' };
      } catch (err) {
        quoteRecord = storedFailure('read', err);
      }
    }

    return {
      outcome: 'ok' as const,
      quoteNumber,
      items: pageRows.map(mapEntry),
      ...(quoteRecord ? { quoteRecord } : {}),
      page: {
        limit,
        hasNextPage,
        nextCursor: hasNextPage && last ? String(last.seq) : null,
      },
      filters: {
        entries: includeOtherQuotes
          ? 'All entries, general and every quote.'
          : quoteNumber ? `General entries plus quote ${quoteNumber}.` : 'General entries only (no quote number).',
        superseded: includeSuperseded ? 'Included; check supersededBy.' : 'Hidden. Pass includeSuperseded to see replaced entries.',
      },
      source: source(),
    };
  }

  async recordFeedback(principal: AssistantPrincipal, args: unknown) {
    const raw = objectArgs(args);
    onlyKeys(raw, ['author', 'source', 'quoteNumber', 'status', 'statusDetail', 'scope', 'excerpt', 'rule', 'supersedes']);
    const author = requiredText(raw, 'author', REVIEW_FEEDBACK_LIMITS.author);
    const sourceText = requiredText(raw, 'source', REVIEW_FEEDBACK_LIMITS.source);
    const quoteNumber = optionalQuoteNumber(raw);
    const status = requiredText(raw, 'status', 40).toLowerCase();
    if (!(WRITABLE_STATUSES as string[]).includes(status)) {
      throw new InvalidAssistantArgs(`status must be one of: ${WRITABLE_STATUSES.join(', ')}. To retire an entry, write a new one with supersedes.`);
    }
    const statusDetail = optionalText(raw, 'statusDetail', REVIEW_FEEDBACK_LIMITS.statusDetail);
    const scope = requiredText(raw, 'scope', REVIEW_FEEDBACK_LIMITS.scope);
    const excerpt = requiredText(raw, 'excerpt', REVIEW_FEEDBACK_LIMITS.excerpt);
    const rule = requiredText(raw, 'rule', REVIEW_FEEDBACK_LIMITS.rule);
    let supersedes: string | null = null;
    if (raw.supersedes !== undefined && raw.supersedes !== null && raw.supersedes !== '') {
      if (typeof raw.supersedes !== 'string' || !ENTRY_ID_RE.test(raw.supersedes)) {
        throw new InvalidAssistantArgs('supersedes must be an existing entry id such as "F012".');
      }
      supersedes = raw.supersedes;
    }

    try {
      if (supersedes) {
        const target = await this.db.prepare(
          `SELECT id FROM quote_review_feedback WHERE id = ?`,
        ).bind(supersedes).first<{ id: string }>();
        if (!target) throw new InvalidAssistantArgs(`supersedes: no entry has id "${supersedes}".`);
      }
      const createdAt = new Date().toISOString();
      const inserted = await this.db.prepare(
        `INSERT INTO quote_review_feedback
          (id, created_at, author, source, quote_number, status, status_detail, scope, excerpt, rule, supersedes,
           written_via, written_by_user_id, written_by_token_id, written_by_client_id)
         SELECT 'F' || printf('%03d', COALESCE(MAX(CAST(substr(id, 2) AS INTEGER)), 0) + 1),
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assistant', ?, ?, ?
         FROM quote_review_feedback WHERE id GLOB 'F[0-9]*'
         RETURNING id, created_at`,
      ).bind(
        createdAt, author, sourceText, quoteNumber, status, statusDetail, scope, excerpt, rule, supersedes,
        principal.userId, principal.tokenId, principal.clientId,
      ).first<{ id: string; created_at: string }>();
      if (!inserted) return storedFailure('write', new Error('insert returned no row'));
      return {
        outcome: 'recorded' as const,
        entry: { id: inserted.id, createdAt: inserted.created_at, quoteNumber, status, supersedes },
        note: supersedes ? `${supersedes} is now superseded by ${inserted.id}. The old row is kept.` : 'Appended. Entries are never edited or deleted.',
        source: source(),
      };
    } catch (err) {
      if (err instanceof InvalidAssistantArgs) throw err;
      return storedFailure('write', err);
    }
  }

  async recordQuoteReview(principal: AssistantPrincipal, args: unknown) {
    const raw = objectArgs(args);
    onlyKeys(raw, ['author', 'source', 'quoteNumber', 'record']);
    const author = requiredText(raw, 'author', REVIEW_FEEDBACK_LIMITS.author);
    const sourceText = requiredText(raw, 'source', REVIEW_FEEDBACK_LIMITS.source);
    const quoteNumber = optionalQuoteNumber(raw);
    if (!quoteNumber) throw new InvalidAssistantArgs('quoteNumber is required for a quote review record.');
    const record = validateQuoteRecord(raw.record);

    try {
      const createdAt = new Date().toISOString();
      const inserted = await this.db.prepare(
        `INSERT INTO quote_review_records
          (id, created_at, author, source, quote_number, record, supersedes,
           written_via, written_by_user_id, written_by_token_id, written_by_client_id)
         SELECT 'QR-' || ? || '-' || (COUNT(*) + 1), ?, ?, ?, ?, ?,
                (SELECT id FROM quote_review_records WHERE quote_number = ? ORDER BY seq DESC LIMIT 1),
                'assistant', ?, ?, ?
         FROM quote_review_records WHERE quote_number = ?
         RETURNING id, created_at, supersedes`,
      ).bind(
        quoteNumber, createdAt, author, sourceText, quoteNumber, JSON.stringify(record),
        quoteNumber, principal.userId, principal.tokenId, principal.clientId, quoteNumber,
      ).first<{ id: string; created_at: string; supersedes: string | null }>();
      if (!inserted) return storedFailure('write', new Error('insert returned no row'));
      return {
        outcome: 'recorded' as const,
        record: { id: inserted.id, createdAt: inserted.created_at, quoteNumber, supersedes: inserted.supersedes },
        note: 'Saved as the newest version for this quote. Earlier versions are kept.',
        source: source(),
      };
    } catch (err) {
      return storedFailure('write', err);
    }
  }
}

export const REVIEW_READ_TOOLS = [
  {
    name: 'read_review_feedback',
    description: 'Read Chicago Reno quote-review feedback stored in Cotiza: Ben\'s general review rules plus decisions for one quote number, and that quote\'s newest review record (edit register, closed findings, verification). Without quoteNumber, returns general rules only. Superseded entries are hidden unless includeSuperseded is true. Follow page.nextCursor for more. A failed read is not an empty ledger. Read-only.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quoteNumber: { type: 'string', description: 'Jobber quote number, e.g. "706"' },
        includeOtherQuotes: { type: 'boolean', description: 'Also return entries for every other quote (calibration cases).' },
        includeSuperseded: { type: 'boolean' },
        cursor: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: REVIEW_FEEDBACK_LIMITS.maxPageSize },
      },
    },
  },
] as const;

export const REVIEW_WRITE_TOOLS = [
  {
    name: 'record_review_feedback',
    description: 'Append one quote-review decision to the Cotiza ledger. Use only when Ben (or another named person) makes a new decision. Entries are never edited or deleted: to change one, append a new entry with supersedes set to the old id. Do not include customer contact details. Writes only to the Cotiza review ledger, never to Jobber.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['author', 'source', 'status', 'scope', 'excerpt', 'rule'],
      properties: {
        author: { type: 'string', maxLength: REVIEW_FEEDBACK_LIMITS.author, description: 'Who decided, e.g. "Ben"' },
        source: { type: 'string', maxLength: REVIEW_FEEDBACK_LIMITS.source, description: 'Where the decision was made, e.g. "Claude conversation 2026-10-29"' },
        quoteNumber: { type: 'string', description: 'Omit for a general rule' },
        status: { type: 'string', enum: [...WRITABLE_STATUSES] },
        statusDetail: { type: 'string', maxLength: REVIEW_FEEDBACK_LIMITS.statusDetail },
        scope: { type: 'string', maxLength: REVIEW_FEEDBACK_LIMITS.scope, description: 'e.g. "all reviews" or "quote 706"' },
        excerpt: { type: 'string', maxLength: REVIEW_FEEDBACK_LIMITS.excerpt, description: 'The person\'s own words' },
        rule: { type: 'string', maxLength: REVIEW_FEEDBACK_LIMITS.rule, description: 'What reviews should do from now on' },
        supersedes: { type: 'string', description: 'Id of the entry this replaces, e.g. "F012"' },
      },
    },
  },
  {
    name: 'record_quote_review',
    description: 'Save a new version of one quote\'s review record (edit register, closed findings, verification notes) in the Cotiza ledger. The newest version is current; earlier versions are kept. Do not include customer contact details. Never writes to Jobber.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['author', 'source', 'quoteNumber', 'record'],
      properties: {
        author: { type: 'string', maxLength: REVIEW_FEEDBACK_LIMITS.author },
        source: { type: 'string', maxLength: REVIEW_FEEDBACK_LIMITS.source },
        quoteNumber: { type: 'string' },
        record: {
          type: 'object',
          description: 'Full current record, e.g. { "edit_register": [...], "closed_findings": [...], "verification": [...] }',
        },
      },
    },
  },
] as const;

export const REVIEW_TOOL_NAMES = new Set<string>([...REVIEW_READ_TOOLS, ...REVIEW_WRITE_TOOLS].map((tool) => tool.name));
export const REVIEW_WRITE_TOOL_NAMES = new Set<string>(REVIEW_WRITE_TOOLS.map((tool) => tool.name));

export async function callReviewTool(store: ReviewFeedbackStore, principal: AssistantPrincipal, name: string, args: unknown) {
  switch (name) {
    case 'read_review_feedback': return store.read(args);
    case 'record_review_feedback': return store.recordFeedback(principal, args);
    case 'record_quote_review': return store.recordQuoteReview(principal, args);
    default: return null;
  }
}
