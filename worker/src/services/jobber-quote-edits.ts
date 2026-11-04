/**
 * apply_quote_edits: apply a Ben-approved line list to a DRAFT Jobber quote.
 *
 * The caller sends the complete desired line list in order (existing lines keep their id,
 * new lines have none). The tool refuses when the quote changed since it was reviewed
 * (quoteVersion from read_quote), when the quote is not a draft, or when Jobber's live
 * schema doesn't have the fields it would send. It then edits lines in place, recreates
 * lines whose position changed (Jobber appends new lines at the end), deletes removed
 * lines, rereads the quote and reports whether it now matches exactly.
 *
 * It never sends a quote, changes its status, title or message, or contacts anyone.
 */
import type { JobberReadClient } from './ops-assistant-read.js';
import { sanitizeLogText } from './jobber-log-sanitize.mjs';

export const MAX_QUOTE_LINES = 100;
/** Same shape read_quote accepts for Jobber encoded ids. */
const ID_RE = /^[A-Za-z0-9+/=_-]{4,200}$/;

export const QUOTE_LINES_QUERY = `query AssistantQuoteLines($id: EncodedId!) {
  quote(id: $id) {
    id
    quoteNumber
    quoteStatus
    lineItems(first: ${MAX_QUOTE_LINES}) {
      nodes { id name description quantity unitPrice }
      pageInfo { hasNextPage }
    }
  }
}`;

export interface QuoteLine {
  id: string;
  name: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface DesiredLine {
  id?: string;
  name: string;
  /** Omitted on an existing line = keep its current description; omitted on a new line = none. */
  description?: string;
  quantity: number;
  unitPrice: number;
}

export class QuoteEditArgsError extends Error {}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : NaN;
}

export function normalizeLines(nodes: Array<Record<string, unknown>> | undefined): QuoteLine[] {
  return (nodes ?? []).map((node) => ({
    id: String(node.id ?? ''),
    name: text(node.name),
    description: text(node.description),
    quantity: num(node.quantity),
    unitPrice: num(node.unitPrice),
  }));
}

/** Stable fingerprint of a quote's status and lines, used to detect edits made since a review. */
export async function quoteVersion(status: string | null | undefined, lines: QuoteLine[]): Promise<string> {
  const canonical = JSON.stringify([status ?? '', lines.map((l) => [l.id, l.name, l.description, l.quantity, l.unitPrice])]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest).slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameContent(a: { name: string; description: string; quantity: number; unitPrice: number }, b: typeof a): boolean {
  return a.name === b.name && a.description === b.description && a.quantity === b.quantity && a.unitPrice === b.unitPrice;
}

export function parseApplyArgs(raw: unknown): { quoteId: string; quoteVersion: string; lines: DesiredLine[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new QuoteEditArgsError('Arguments must be an object.');
  const args = raw as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (!['quoteId', 'quoteVersion', 'lines'].includes(key)) throw new QuoteEditArgsError(`Unknown field: ${key}`);
  }
  if (typeof args.quoteId !== 'string' || !ID_RE.test(args.quoteId)) throw new QuoteEditArgsError('quoteId is not a valid id.');
  if (typeof args.quoteVersion !== 'string' || !/^[0-9a-f]{16}$/.test(args.quoteVersion)) {
    throw new QuoteEditArgsError('quoteVersion is required: use the version from read_quote.');
  }
  if (!Array.isArray(args.lines) || args.lines.length === 0 || args.lines.length > MAX_QUOTE_LINES) {
    throw new QuoteEditArgsError(`lines must list 1 to ${MAX_QUOTE_LINES} lines: the whole quote, in order.`);
  }
  const seen = new Set<string>();
  const lines = args.lines.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new QuoteEditArgsError(`lines[${index}] must be an object.`);
    const line = item as Record<string, unknown>;
    for (const key of Object.keys(line)) {
      if (!['id', 'name', 'description', 'quantity', 'unitPrice'].includes(key)) throw new QuoteEditArgsError(`lines[${index}]: unknown field ${key}`);
    }
    if (line.id !== undefined) {
      if (typeof line.id !== 'string' || !ID_RE.test(line.id)) throw new QuoteEditArgsError(`lines[${index}].id must be a line id from read_quote.`);
      if (seen.has(line.id)) throw new QuoteEditArgsError(`lines[${index}].id appears twice.`);
      seen.add(line.id);
    }
    const name = text(line.name);
    if (!name || name.length > 255) throw new QuoteEditArgsError(`lines[${index}].name must be 1 to 255 characters.`);
    if (line.description !== undefined && typeof line.description !== 'string') throw new QuoteEditArgsError(`lines[${index}].description must be text.`);
    const description = line.description === undefined ? undefined : text(line.description);
    if (description && description.length > 10000) throw new QuoteEditArgsError(`lines[${index}].description is too long.`);
    const quantity = num(line.quantity);
    const unitPrice = num(line.unitPrice);
    if (!(quantity > 0) || quantity > 100000) throw new QuoteEditArgsError(`lines[${index}].quantity must be a positive number.`);
    if (!(unitPrice >= 0) || unitPrice > 1000000) throw new QuoteEditArgsError(`lines[${index}].unitPrice must be zero or more.`);
    return { ...(line.id ? { id: line.id as string } : {}), name, ...(description === undefined ? {} : { description }), quantity, unitPrice };
  });
  return { quoteId: args.quoteId.trim(), quoteVersion: args.quoteVersion, lines };
}

export interface EditPlan {
  updates: QuoteLine[];
  creates: Array<DesiredLine & { description: string }>;
  deletes: string[];
  /** Index in the desired list from which lines are recreated to get the order right. */
  recreateFrom: number;
}

/** Fill omitted descriptions: an existing line keeps its current one, a new line gets none. */
export function resolveDescriptions(current: QuoteLine[], desired: DesiredLine[]): Array<DesiredLine & { description: string }> {
  const byId = new Map(current.map((l) => [l.id, l]));
  return desired.map((line) => ({
    ...line,
    description: line.description ?? (line.id ? byId.get(line.id)?.description ?? '' : ''),
  }));
}

/**
 * Plan the smallest change set. Lines are edited in place while the desired order matches the
 * current order; from the first new or out-of-order line on, lines are recreated (Jobber can only
 * append) and the originals deleted.
 */
export function planEdits(current: QuoteLine[], requested: DesiredLine[]): EditPlan {
  const currentIds = new Set(current.map((l) => l.id));
  for (const line of requested) {
    if (line.id && !currentIds.has(line.id)) throw new QuoteEditArgsError(`Line ${line.id} is not on this quote. Reread the quote.`);
  }
  const desired = resolveDescriptions(current, requested);
  const desiredIds = new Set(desired.filter((l) => l.id).map((l) => l.id as string));
  const keptInCurrentOrder = current.filter((l) => desiredIds.has(l.id)).map((l) => l.id);
  let recreateFrom = desired.length;
  for (let i = 0, j = 0; i < desired.length; i++, j++) {
    if (!desired[i].id || desired[i].id !== keptInCurrentOrder[j]) { recreateFrom = i; break; }
  }
  const byId = new Map(current.map((l) => [l.id, l]));
  const updates: QuoteLine[] = [];
  const keepIds = new Set<string>();
  for (const line of desired.slice(0, recreateFrom)) {
    const id = line.id as string;
    keepIds.add(id);
    const before = byId.get(id)!;
    if (!sameContent(before, line)) updates.push({ id, name: line.name, description: line.description, quantity: line.quantity, unitPrice: line.unitPrice });
  }
  const creates = desired.slice(recreateFrom).map(({ name, description, quantity, unitPrice }) => ({ name, description, quantity, unitPrice }));
  const deletes = current.filter((l) => !keepIds.has(l.id)).map((l) => l.id);
  return { updates, creates, deletes, recreateFrom };
}

// ── Live schema check ────────────────────────────────────────────────────────

interface TypeRef { kind: string; name: string | null; ofType?: TypeRef | null }
interface InputField { name: string; type: TypeRef }
interface MutationField { name: string; args: InputField[] }

const REF = 'kind name ofType { kind name ofType { kind name ofType { kind name } } }';
export const QUOTE_EDIT_SCHEMA_QUERY = `query AssistantQuoteEditSchema {
  __schema { mutationType { fields { name args { name type { ${REF} } } } } }
  edit: __type(name: "QuoteEditLineItemAttributes") { inputFields { name type { ${REF} } } }
  create: __type(name: "QuoteCreateLineItemAttributes") { inputFields { name type { ${REF} } } }
}`;

function baseOf(ref: TypeRef): TypeRef {
  let r = ref;
  while (r.ofType) r = r.ofType;
  return r;
}

function render(ref: TypeRef): string {
  if (ref.kind === 'NON_NULL') return `${render(ref.ofType!)}!`;
  if (ref.kind === 'LIST') return `[${render(ref.ofType!)}]`;
  return String(ref.name);
}

interface MutationShape { mutation: string; quoteArg: string; quoteType: string; listArg: string; listType: string }

export interface EditSchema {
  edit: MutationShape & { idField: string; fields: Set<string> };
  create: MutationShape & { fields: Set<string>; requiredSave: boolean };
  remove: MutationShape;
}

class SchemaMismatch extends Error {}

function mutationShape(fields: MutationField[], name: string, listBase: (ref: TypeRef) => boolean): MutationShape {
  const field = fields.find((f) => f.name === name);
  if (!field) throw new SchemaMismatch(`Jobber has no ${name} mutation.`);
  const quoteArg = field.args.find((a) => a.name === 'quoteId');
  const listArg = field.args.find((a) => a.name !== 'quoteId' && listBase(a.type));
  if (!quoteArg || !listArg) throw new SchemaMismatch(`${name} has unexpected arguments.`);
  return { mutation: name, quoteArg: quoteArg.name, listArg: listArg.name, listType: render(listArg.type), quoteType: render(quoteArg.type) };
}

export async function loadEditSchema(jobber: JobberReadClient): Promise<EditSchema> {
  const data = await jobber.graphqlRequest<{
    __schema?: { mutationType?: { fields?: MutationField[] } };
    edit?: { inputFields?: InputField[] } | null;
    create?: { inputFields?: InputField[] } | null;
  }>(QUOTE_EDIT_SCHEMA_QUERY);
  const mutations = data.__schema?.mutationType?.fields ?? [];
  const editFields = data.edit?.inputFields ?? [];
  const createFields = data.create?.inputFields ?? [];
  if (!editFields.length || !createFields.length) throw new SchemaMismatch('Jobber line-item input types are missing.');
  const edit = mutationShape(mutations, 'quoteEditLineItems', (t) => baseOf(t).name === 'QuoteEditLineItemAttributes');
  const create = mutationShape(mutations, 'quoteCreateLineItems', (t) => baseOf(t).name === 'QuoteCreateLineItemAttributes');
  const remove = mutationShape(mutations, 'quoteDeleteLineItems', (t) => t.kind === 'LIST' || (t.kind === 'NON_NULL' && t.ofType?.kind === 'LIST'));
  const editNames = new Set(editFields.map((f) => f.name));
  const idField = editNames.has('lineItemId') ? 'lineItemId' : editNames.has('id') ? 'id' : '';
  if (!idField) throw new SchemaMismatch('QuoteEditLineItemAttributes has no line id field.');
  for (const needed of ['name', 'quantity', 'unitPrice']) {
    if (!editNames.has(needed)) throw new SchemaMismatch(`QuoteEditLineItemAttributes has no ${needed} field.`);
  }
  const editPrice = baseOf(editFields.find((f) => f.name === 'unitPrice')!.type);
  if (!(editPrice.kind === 'SCALAR' && /^(Float|Int)$/.test(String(editPrice.name)))) {
    throw new SchemaMismatch(`QuoteEditLineItemAttributes.unitPrice is ${editPrice.name}; this tool only sends numbers.`);
  }
  const createNames = new Set(createFields.map((f) => f.name));
  for (const needed of ['name', 'quantity', 'unitPrice']) {
    if (!createNames.has(needed)) throw new SchemaMismatch(`QuoteCreateLineItemAttributes has no ${needed} field.`);
  }
  const createPrice = baseOf(createFields.find((f) => f.name === 'unitPrice')!.type);
  if (!(createPrice.kind === 'SCALAR' && /^(Float|Int)$/.test(String(createPrice.name)))) {
    throw new SchemaMismatch(`QuoteCreateLineItemAttributes.unitPrice is ${createPrice.name}; this tool only sends numbers.`);
  }
  const unknownRequired = createFields.filter((f) => f.type.kind === 'NON_NULL'
    && !['name', 'quantity', 'unitPrice', 'description', 'saveToProductsAndServices'].includes(f.name));
  if (unknownRequired.length) throw new SchemaMismatch(`QuoteCreateLineItemAttributes requires ${unknownRequired.map((f) => f.name).join(', ')}.`);
  return {
    edit: { ...edit, idField, fields: editNames },
    create: { ...create, fields: createNames, requiredSave: createNames.has('saveToProductsAndServices') },
    remove,
  };
}

// ── Apply ────────────────────────────────────────────────────────────────────

function mutationText(shape: MutationShape) {
  return `mutation AssistantApply($quoteId: ${shape.quoteType}, $items: ${shape.listType}) {
  ${shape.mutation}(${shape.quoteArg}: $quoteId, ${shape.listArg}: $items) { userErrors { message path } }
}`;
}

async function runMutation(jobber: JobberReadClient, shape: MutationShape, quoteId: string, items: unknown[]) {
  const data = await jobber.graphqlRequest<Record<string, { userErrors?: Array<{ message?: string }> } | null>>(mutationText(shape), { quoteId, items });
  const errors = data[shape.mutation]?.userErrors ?? [];
  if (errors.length) throw new Error(`${shape.mutation} rejected: ${errors.map((e) => e.message).join('; ')}`);
}

async function loadQuoteLines(jobber: JobberReadClient, quoteId: string) {
  const data = await jobber.graphqlRequest<{ quote?: { id: string; quoteNumber?: string; quoteStatus?: string; lineItems?: { nodes?: Array<Record<string, unknown>>; pageInfo?: { hasNextPage?: boolean } } } | null }>(QUOTE_LINES_QUERY, { id: quoteId });
  return data.quote ?? null;
}

function mismatches(after: QuoteLine[], desired: Array<DesiredLine & { description: string }>) {
  const out: string[] = [];
  if (after.length !== desired.length) out.push(`Quote has ${after.length} lines; expected ${desired.length}.`);
  desired.forEach((want, i) => {
    const got = after[i];
    if (!got) return;
    if (!sameContent(got, want)) out.push(`Line ${i + 1} (${want.name}) does not match after saving.`);
  });
  return out;
}

const subtotal = (lines: Array<{ quantity: number; unitPrice: number }>) =>
  Math.round(lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0) * 100) / 100;

export async function applyQuoteEdits(jobber: JobberReadClient, rawArgs: unknown) {
  const args = parseApplyArgs(rawArgs);
  const quote = await loadQuoteLines(jobber, args.quoteId);
  if (!quote) return { outcome: 'not_found' as const, quoteId: args.quoteId, changed: false };
  if (quote.lineItems?.pageInfo?.hasNextPage) {
    return { outcome: 'refused' as const, changed: false, reason: `This quote has more than ${MAX_QUOTE_LINES} lines. Nothing was changed.` };
  }
  const current = normalizeLines(quote.lineItems?.nodes);
  const version = await quoteVersion(quote.quoteStatus, current);
  if (version !== args.quoteVersion) {
    return { outcome: 'conflict' as const, changed: false, quoteNumber: quote.quoteNumber ?? null, currentVersion: version,
      reason: 'The quote changed since it was read. Nothing was changed. Reread it with read_quote and check the review still applies.' };
  }
  if (quote.quoteStatus !== 'draft') {
    return { outcome: 'refused' as const, changed: false, quoteNumber: quote.quoteNumber ?? null,
      reason: `Only draft quotes can be edited here; this one is ${quote.quoteStatus}. Nothing was changed.` };
  }
  const plan = planEdits(current, args.lines);
  if (!plan.updates.length && !plan.creates.length && !plan.deletes.length) {
    return { outcome: 'ok' as const, changed: false, quoteNumber: quote.quoteNumber ?? null, verified: true, version, subtotal: subtotal(current), note: 'The quote already matches. Nothing was changed.' };
  }
  let schema: EditSchema;
  try {
    schema = await loadEditSchema(jobber);
  } catch (err) {
    const reason = err instanceof SchemaMismatch ? err.message : 'The Jobber schema could not be read.';
    return { outcome: 'refused' as const, changed: false, quoteNumber: quote.quoteNumber ?? null, reason: `${reason} Nothing was changed.` };
  }

  const applied = { updated: 0, created: 0, deleted: 0 };
  let failure: string | null = null;
  try {
    if (plan.updates.length) {
      await runMutation(jobber, schema.edit, args.quoteId, plan.updates.map((l) => ({
        [schema.edit.idField]: l.id, name: l.name, quantity: l.quantity, unitPrice: l.unitPrice,
        ...(schema.edit.fields.has('description') ? { description: l.description } : {}),
      })));
      applied.updated = plan.updates.length;
    }
    if (plan.creates.length) {
      await runMutation(jobber, schema.create, args.quoteId, plan.creates.map((l) => ({
        name: l.name, quantity: l.quantity, unitPrice: l.unitPrice,
        ...(schema.create.fields.has('description') ? { description: l.description } : {}),
        ...(schema.create.requiredSave ? { saveToProductsAndServices: false } : {}),
      })));
      applied.created = plan.creates.length;
    }
    // Deletes run last so a failed create never leaves the quote missing lines.
    if (plan.deletes.length) {
      await runMutation(jobber, schema.remove, args.quoteId, plan.deletes);
      applied.deleted = plan.deletes.length;
    }
  } catch (err) {
    failure = sanitizeLogText(err instanceof Error ? err.message : String(err)).slice(0, 300);
  }

  const after = await loadQuoteLines(jobber, args.quoteId).catch(() => null);
  const afterLines = normalizeLines(after?.lineItems?.nodes);
  const wanted = resolveDescriptions(current, args.lines);
  const problems = after ? mismatches(afterLines, wanted) : ['The quote could not be reread after saving.'];
  const afterVersion = after ? await quoteVersion(after.quoteStatus, afterLines) : null;
  // Judge "changed" from the reread, not from which calls returned cleanly: a mutation can
  // take effect and still report an error. Unknown when the reread failed.
  const changed: boolean | 'unknown' = afterVersion === null ? 'unknown' : afterVersion !== version;
  return {
    outcome: failure || problems.length ? 'failed' as const : 'ok' as const,
    changed,
    quoteNumber: quote.quoteNumber ?? null,
    applied,
    recreatedFromLine: plan.recreateFrom < args.lines.length ? plan.recreateFrom + 1 : null,
    verified: !failure && problems.length === 0,
    ...(failure ? { failure } : {}),
    ...(problems.length ? { mismatches: problems } : {}),
    subtotal: after ? subtotal(afterLines) : null,
    version: afterVersion,
    ...(failure || problems.length ? { warning: changed === false
      ? 'Nothing was changed.'
      : changed === 'unknown'
        ? 'The quote could not be reread, so some changes may have been saved. Reread it before trying again.'
        : 'Some changes were saved before the failure. Reread the quote before trying again.' } : {}),
  };
}

export const QUOTE_WRITE_TOOLS = [
  {
    name: 'apply_quote_edits',
    description: 'Apply a Ben-approved line list to a DRAFT Jobber quote. Send the whole quote in order: existing lines keep their id from read_quote, new lines have no id, removed lines are left out. Requires quoteVersion from read_quote; refuses if the quote changed since. Edits lines in place, recreates lines whose position changed, deletes removed lines, then rereads and reports whether every line matches. Never sends the quote or changes its status, title or message. Use only after Ben approves the edits.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['quoteId', 'quoteVersion', 'lines'],
      properties: {
        quoteId: { type: 'string' },
        quoteVersion: { type: 'string', description: 'version from read_quote' },
        lines: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_QUOTE_LINES,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'quantity', 'unitPrice'],
            properties: {
              id: { type: 'string', description: 'Existing line id; omit for a new line.' },
              name: { type: 'string' },
              description: { type: 'string', description: 'Omit on an existing line to keep its current description.' },
              quantity: { type: 'number' },
              unitPrice: { type: 'number' },
            },
          },
        },
      },
    },
  },
] as const;

export const QUOTE_WRITE_TOOL_NAMES = new Set<string>(QUOTE_WRITE_TOOLS.map((t) => t.name));
