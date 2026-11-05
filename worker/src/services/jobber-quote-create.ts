/**
 * create_quote: create a new DRAFT Jobber quote from a Ben-approved title, message and line list.
 *
 * The client and property come from an existing quote (basedOnQuoteId, the usual case for a
 * change order), from a request (requestId), or are given directly (clientId + propertyId).
 * The tool checks Jobber's live schema before writing, creates the quote with quoteCreate,
 * rereads it and reports whether every line matches. The new quote's version is returned so
 * apply_quote_edits can follow up without another read.
 *
 * It never sends the quote, changes its status after creation, or contacts anyone.
 */
import type { JobberReadClient } from './ops-assistant-read.js';
import { sanitizeLogText } from './jobber-log-sanitize.mjs';
import {
  MAX_QUOTE_LINES,
  QUOTE_LINES_QUERY,
  QuoteEditArgsError,
  normalizeLines,
  quoteVersion,
} from './jobber-quote-edits.js';

const ID_RE = /^[A-Za-z0-9+/=_-]{4,200}$/;
export const MAX_TITLE_LENGTH = 255;
export const MAX_CREATE_MESSAGE_LENGTH = 10000;

export interface CreateLine {
  name: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface CreateArgs {
  basedOnQuoteId?: string;
  requestId?: string;
  clientId?: string;
  propertyId?: string;
  title: string;
  message?: string;
  lines: CreateLine[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : NaN;
}

function optionalId(args: Record<string, unknown>, key: string): string | undefined {
  if (args[key] === undefined) return undefined;
  if (typeof args[key] !== 'string' || !ID_RE.test(args[key] as string)) throw new QuoteEditArgsError(`${key} is not a valid id.`);
  return (args[key] as string).trim();
}

export function parseCreateArgs(raw: unknown): CreateArgs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new QuoteEditArgsError('Arguments must be an object.');
  const args = raw as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (!['basedOnQuoteId', 'requestId', 'clientId', 'propertyId', 'title', 'message', 'lines'].includes(key)) {
      throw new QuoteEditArgsError(`Unknown field: ${key}`);
    }
  }
  const basedOnQuoteId = optionalId(args, 'basedOnQuoteId');
  const requestId = optionalId(args, 'requestId');
  const clientId = optionalId(args, 'clientId');
  const propertyId = optionalId(args, 'propertyId');
  const sources = [basedOnQuoteId, requestId, clientId].filter(Boolean).length;
  if (sources !== 1) throw new QuoteEditArgsError('Give exactly one of basedOnQuoteId, requestId, or clientId (with propertyId).');
  if (clientId && !propertyId) throw new QuoteEditArgsError('propertyId is required with clientId.');
  if (propertyId && !clientId) throw new QuoteEditArgsError('propertyId is only used with clientId.');

  const title = text(args.title);
  if (!title || title.length > MAX_TITLE_LENGTH) throw new QuoteEditArgsError(`title must be 1 to ${MAX_TITLE_LENGTH} characters.`);
  if (args.message !== undefined && typeof args.message !== 'string') throw new QuoteEditArgsError('message must be text.');
  const message = args.message === undefined ? undefined : text(args.message);
  if (message && message.length > MAX_CREATE_MESSAGE_LENGTH) throw new QuoteEditArgsError(`message must be ${MAX_CREATE_MESSAGE_LENGTH} characters or fewer.`);

  if (!Array.isArray(args.lines) || args.lines.length === 0 || args.lines.length > MAX_QUOTE_LINES) {
    throw new QuoteEditArgsError(`lines must list 1 to ${MAX_QUOTE_LINES} lines, in order.`);
  }
  const lines = args.lines.map((item, index): CreateLine => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new QuoteEditArgsError(`lines[${index}] must be an object.`);
    const line = item as Record<string, unknown>;
    for (const key of Object.keys(line)) {
      if (!['name', 'description', 'quantity', 'unitPrice'].includes(key)) throw new QuoteEditArgsError(`lines[${index}]: unknown field ${key}`);
    }
    const name = text(line.name);
    if (!name || name.length > 255) throw new QuoteEditArgsError(`lines[${index}].name must be 1 to 255 characters.`);
    if (line.description !== undefined && typeof line.description !== 'string') throw new QuoteEditArgsError(`lines[${index}].description must be text.`);
    const description = text(line.description);
    if (description.length > 10000) throw new QuoteEditArgsError(`lines[${index}].description is too long.`);
    const quantity = num(line.quantity);
    const unitPrice = num(line.unitPrice);
    if (!(quantity > 0) || quantity > 100000) throw new QuoteEditArgsError(`lines[${index}].quantity must be a positive number.`);
    // Negative prices are allowed for credit lines (Jobber's UI accepts them).
    if (!Number.isFinite(unitPrice) || unitPrice < -1000000 || unitPrice > 1000000) {
      throw new QuoteEditArgsError(`lines[${index}].unitPrice must be a number between -1,000,000 and 1,000,000.`);
    }
    return { name, description, quantity, unitPrice };
  });

  return {
    ...(basedOnQuoteId ? { basedOnQuoteId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(clientId ? { clientId, propertyId } : {}),
    title,
    ...(message ? { message } : {}),
    lines,
  };
}

// ── Schema check ─────────────────────────────────────────────────────────────

interface TypeRef { kind: string; name: string | null; ofType?: TypeRef | null }
interface InputField { name: string; type: TypeRef }
interface MutationField { name: string; args: InputField[] }

const REF = 'kind name ofType { kind name ofType { kind name ofType { kind name } } }';
export const QUOTE_CREATE_SCHEMA_QUERY = `query AssistantQuoteCreateSchema {
  __schema { mutationType { fields { name args { name type { ${REF} } } } } }
  attrs: __type(name: "QuoteCreateAttributes") { inputFields { name type { ${REF} } } }
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

class SchemaMismatch extends Error {}

export interface CreateSchema {
  argName: string;
  argType: string;
  fields: Set<string>;
  lineFields: Set<string>;
}

const SUPPLIED = new Set(['clientId', 'propertyId', 'title', 'message', 'lineItems']);
const LINE_SUPPLIED = new Set(['name', 'description', 'quantity', 'unitPrice', 'saveToProductsAndServices']);

export async function loadCreateSchema(jobber: JobberReadClient): Promise<CreateSchema> {
  const data = await jobber.graphqlRequest<{
    __schema?: { mutationType?: { fields?: MutationField[] } };
    attrs?: { inputFields?: InputField[] } | null;
  }>(QUOTE_CREATE_SCHEMA_QUERY);
  const mutation = (data.__schema?.mutationType?.fields ?? []).find((f) => f.name === 'quoteCreate');
  if (!mutation) throw new SchemaMismatch('Jobber has no quoteCreate mutation.');
  const arg = mutation.args.find((a) => baseOf(a.type).name === 'QuoteCreateAttributes');
  if (!arg) throw new SchemaMismatch('quoteCreate has unexpected arguments.');
  const unknownArgs = mutation.args.filter((a) => a !== arg && a.type.kind === 'NON_NULL');
  if (unknownArgs.length) throw new SchemaMismatch(`quoteCreate requires ${unknownArgs.map((a) => a.name).join(', ')}.`);
  const fields = data.attrs?.inputFields ?? [];
  if (!fields.length) throw new SchemaMismatch('QuoteCreateAttributes is missing.');
  const names = new Set(fields.map((f) => f.name));
  for (const needed of ['clientId', 'propertyId', 'title', 'lineItems']) {
    if (!names.has(needed)) throw new SchemaMismatch(`QuoteCreateAttributes has no ${needed} field.`);
  }
  const unknownRequired = fields.filter((f) => f.type.kind === 'NON_NULL' && !SUPPLIED.has(f.name));
  if (unknownRequired.length) throw new SchemaMismatch(`QuoteCreateAttributes requires ${unknownRequired.map((f) => f.name).join(', ')}.`);

  const lineTypeName = baseOf(fields.find((f) => f.name === 'lineItems')!.type).name;
  const lineType = await jobber.graphqlRequest<{ t?: { inputFields?: InputField[] } | null }>(
    `query AssistantQuoteCreateLineSchema { t: __type(name: "${String(lineTypeName).replace(/[^A-Za-z0-9_]/g, '')}") { inputFields { name type { ${REF} } } } }`,
  );
  const lineFields = lineType.t?.inputFields ?? [];
  const lineNames = new Set(lineFields.map((f) => f.name));
  for (const needed of ['name', 'quantity', 'unitPrice']) {
    if (!lineNames.has(needed)) throw new SchemaMismatch(`${lineTypeName} has no ${needed} field.`);
  }
  const price = baseOf(lineFields.find((f) => f.name === 'unitPrice')!.type);
  if (!(price.kind === 'SCALAR' && /^(Float|Int)$/.test(String(price.name)))) {
    throw new SchemaMismatch(`${lineTypeName}.unitPrice is ${price.name}; this tool only sends numbers.`);
  }
  const lineRequired = lineFields.filter((f) => f.type.kind === 'NON_NULL' && !LINE_SUPPLIED.has(f.name));
  if (lineRequired.length) throw new SchemaMismatch(`${lineTypeName} requires ${lineRequired.map((f) => f.name).join(', ')}.`);
  return { argName: arg.name, argType: render(arg.type), fields: names, lineFields: lineNames };
}

// ── Client and property ──────────────────────────────────────────────────────

export const SOURCE_QUOTE_QUERY = `query AssistantCreateSourceQuote($id: EncodedId!) {
  quote(id: $id) { id quoteNumber client { id } property { id } }
}`;

export const SOURCE_REQUEST_QUERY = `query AssistantCreateSourceRequest($id: EncodedId!) {
  request(id: $id) { id client { id } property { id } }
}`;

type Target = { clientId: string; propertyId: string; from: string } | { refused: string };

async function resolveTarget(jobber: JobberReadClient, args: CreateArgs): Promise<Target> {
  if (args.clientId && args.propertyId) return { clientId: args.clientId, propertyId: args.propertyId, from: 'clientId' };
  if (args.basedOnQuoteId) {
    const data = await jobber.graphqlRequest<{ quote?: { quoteNumber?: string; client?: { id?: string } | null; property?: { id?: string } | null } | null }>(
      SOURCE_QUOTE_QUERY, { id: args.basedOnQuoteId },
    );
    const q = data.quote;
    if (!q) return { refused: 'basedOnQuoteId was not found. Nothing was created.' };
    if (!q.client?.id || !q.property?.id) return { refused: `Quote ${q.quoteNumber ?? ''} has no client or property to copy. Nothing was created.` };
    return { clientId: q.client.id, propertyId: q.property.id, from: `quote ${q.quoteNumber ?? args.basedOnQuoteId}` };
  }
  const data = await jobber.graphqlRequest<{ request?: { client?: { id?: string } | null; property?: { id?: string } | null } | null }>(
    SOURCE_REQUEST_QUERY, { id: args.requestId },
  );
  const r = data.request;
  if (!r) return { refused: 'requestId was not found. Nothing was created.' };
  if (!r.client?.id || !r.property?.id) return { refused: 'That request has no client or property yet. Nothing was created.' };
  return { clientId: r.client.id, propertyId: r.property.id, from: 'request' };
}

// ── Create ───────────────────────────────────────────────────────────────────

function createMutation(schema: CreateSchema) {
  return `mutation AssistantQuoteCreate($attributes: ${schema.argType}) {
  quoteCreate(${schema.argName}: $attributes) { quote { id quoteNumber quoteStatus jobberWebUri } userErrors { message path } }
}`;
}

const subtotal = (lines: Array<{ quantity: number; unitPrice: number }>) =>
  Math.round(lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0) * 100) / 100;

export async function createQuote(jobber: JobberReadClient, rawArgs: unknown) {
  const args = parseCreateArgs(rawArgs);
  const target = await resolveTarget(jobber, args);
  if ('refused' in target) return { outcome: 'refused' as const, created: false, reason: target.refused };

  let schema: CreateSchema;
  try {
    schema = await loadCreateSchema(jobber);
  } catch (err) {
    const reason = err instanceof SchemaMismatch ? err.message : 'The Jobber schema could not be read.';
    return { outcome: 'refused' as const, created: false, reason: `${reason} Nothing was created.` };
  }

  const attributes: Record<string, unknown> = {
    clientId: target.clientId,
    propertyId: target.propertyId,
    title: args.title,
    ...(args.message && schema.fields.has('message') ? { message: args.message } : {}),
    lineItems: args.lines.map((l) => ({
      name: l.name,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      ...(schema.lineFields.has('description') ? { description: l.description } : {}),
      ...(schema.lineFields.has('saveToProductsAndServices') ? { saveToProductsAndServices: false } : {}),
    })),
  };

  let created: { id?: string; quoteNumber?: string; quoteStatus?: string; jobberWebUri?: string } | null = null;
  let failure: string | null = null;
  try {
    const data = await jobber.graphqlRequest<{ quoteCreate?: { quote?: typeof created; userErrors?: Array<{ message?: string }> } | null }>(
      createMutation(schema), { attributes },
    );
    created = data.quoteCreate?.quote ?? null;
    const errors = data.quoteCreate?.userErrors ?? [];
    if (errors.length) throw new Error(`quoteCreate rejected: ${errors.map((e) => e.message).join('; ')}`);
    if (!created?.id) throw new Error('quoteCreate returned no quote.');
  } catch (err) {
    failure = sanitizeLogText(err instanceof Error ? err.message : String(err)).slice(0, 300);
  }

  if (!created?.id) {
    return {
      outcome: 'failed' as const,
      created: 'unknown' as const,
      ...(failure ? { failure } : {}),
      warning: 'Jobber did not confirm a new quote. Check find_quotes for this client before trying again, so a duplicate is not created.',
    };
  }

  const after = await jobber.graphqlRequest<{ quote?: { quoteNumber?: string; quoteStatus?: string; lineItems?: { nodes?: Array<Record<string, unknown>> } } | null }>(
    QUOTE_LINES_QUERY, { id: created.id },
  ).then((d) => d.quote ?? null).catch(() => null);
  const afterLines = normalizeLines(after?.lineItems?.nodes);
  const problems: string[] = [];
  if (!after) problems.push('The new quote could not be reread.');
  else {
    if (afterLines.length !== args.lines.length) problems.push(`Quote has ${afterLines.length} lines; expected ${args.lines.length}.`);
    args.lines.forEach((want, i) => {
      const got = afterLines[i];
      if (!got) return;
      const same = got.name === want.name && got.quantity === want.quantity && got.unitPrice === want.unitPrice
        && (!schema.lineFields.has('description') || got.description === want.description);
      if (!same) problems.push(`Line ${i + 1} (${want.name}) does not match after saving.`);
    });
    if (after.quoteStatus && after.quoteStatus !== 'draft') problems.push(`The new quote's status is ${after.quoteStatus}, not draft.`);
  }

  return {
    outcome: failure || problems.length ? 'failed' as const : 'ok' as const,
    created: true,
    quoteId: created.id,
    quoteNumber: after?.quoteNumber ?? created.quoteNumber ?? null,
    quoteStatus: after?.quoteStatus ?? created.quoteStatus ?? null,
    jobberWebUri: created.jobberWebUri ?? null,
    clientAndPropertyFrom: target.from,
    verified: !failure && problems.length === 0,
    ...(failure ? { failure } : {}),
    ...(problems.length ? { mismatches: problems, warning: 'The quote was created but does not fully match. Fix it with apply_quote_edits; do not create it again.' } : {}),
    subtotal: after ? subtotal(afterLines) : null,
    version: after ? await quoteVersion(after.quoteStatus, afterLines) : null,
    ...(args.message && !schema.fields.has('message') ? { note: 'This Jobber account does not accept a message on create; set it with update_quote_message.' } : {}),
  };
}

export const QUOTE_CREATE_TOOL = {
  name: 'create_quote',
  description: 'Create a new DRAFT Jobber quote with a Ben-approved title, optional message to the customer, and line list. For a change order, pass basedOnQuoteId (the main quote) to reuse its client and property; for a new lead pass requestId; otherwise pass clientId and propertyId. Lines may have negative unit prices for credits. Rereads the new quote and reports whether every line matches, plus quoteNumber, jobberWebUri and version (for apply_quote_edits). Never sends the quote or contacts anyone. If the outcome is failed with created unknown, check find_quotes before retrying so no duplicate is made. Use only after Ben approves the quote.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'lines'],
    properties: {
      basedOnQuoteId: { type: 'string', description: 'Existing quote whose client and property the new quote uses (change orders).' },
      requestId: { type: 'string', description: 'Request whose client and property the new quote uses.' },
      clientId: { type: 'string', description: 'Client id; requires propertyId.' },
      propertyId: { type: 'string' },
      title: { type: 'string' },
      message: { type: 'string', description: 'Message to the customer.' },
      lines: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_QUOTE_LINES,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'quantity', 'unitPrice'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            quantity: { type: 'number' },
            unitPrice: { type: 'number', description: 'Negative for a credit line.' },
          },
        },
      },
    },
  },
} as const;
