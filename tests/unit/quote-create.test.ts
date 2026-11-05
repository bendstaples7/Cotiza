import { describe, expect, it, vi } from 'vitest';
import {
  createQuote,
  parseCreateArgs,
  QUOTE_CREATE_SCHEMA_QUERY,
  SOURCE_QUOTE_QUERY,
  SOURCE_REQUEST_QUERY,
} from '../../worker/src/services/jobber-quote-create.js';
import { QUOTE_LINES_QUERY, QuoteEditArgsError, quoteVersion } from '../../worker/src/services/jobber-quote-edits.js';

const MAIN = 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=';
const NEW_ID = 'Z2lkOi8vSm9iYmVyL1F1b3RlLzk=';
const REQ = 'Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMQ==';

const ref = (name: string, nonNull = false) => (nonNull ? { kind: 'NON_NULL', name: null, ofType: { kind: 'INPUT_OBJECT', name } } : { kind: 'INPUT_OBJECT', name });
const scalar = (name: string, nonNull = false) => (nonNull ? { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name } } : { kind: 'SCALAR', name });

const schema = {
  __schema: { mutationType: { fields: [{ name: 'quoteCreate', args: [{ name: 'attributes', type: ref('QuoteCreateAttributes', true) }] }] } },
  attrs: { inputFields: [
    { name: 'clientId', type: scalar('EncodedId', true) },
    { name: 'propertyId', type: scalar('EncodedId', true) },
    { name: 'title', type: scalar('String') },
    { name: 'message', type: scalar('String') },
    { name: 'lineItems', type: { kind: 'LIST', name: null, ofType: ref('QuoteCreateLineItemAttributes', true) } },
  ] },
};
const lineSchema = { t: { inputFields: [
  { name: 'name', type: scalar('String', true) },
  { name: 'description', type: scalar('String') },
  { name: 'quantity', type: scalar('Float', true) },
  { name: 'unitPrice', type: scalar('Float', true) },
  { name: 'saveToProductsAndServices', type: scalar('Boolean', true) },
] } };

const LINES = [
  { name: 'Plumbing: Toilet Install', description: 'Customer to provide toilet', quantity: 1, unitPrice: 200 },
  { name: 'Credit: Switches', description: '', quantity: 5, unitPrice: -50 },
];

function fakeJobber(opts: { reject?: boolean; dropLine?: boolean; noMutation?: boolean } = {}) {
  let created: Array<Record<string, unknown>> = [];
  const graphqlRequest = vi.fn(async (query: string, vars?: Record<string, unknown>) => {
    if (query === QUOTE_CREATE_SCHEMA_QUERY) {
      return opts.noMutation ? { ...schema, __schema: { mutationType: { fields: [] } } } : schema;
    }
    if (query.includes('AssistantQuoteCreateLineSchema')) return lineSchema;
    if (query === SOURCE_QUOTE_QUERY) return { quote: { id: MAIN, quoteNumber: '643', client: { id: 'client1' }, property: { id: 'prop1' } } };
    if (query === SOURCE_REQUEST_QUERY) return { request: { id: REQ, client: { id: 'client2' }, property: null } };
    if (query.includes('quoteCreate(')) {
      if (opts.reject) return { quoteCreate: { quote: null, userErrors: [{ message: 'Property is invalid' }] } };
      const attrs = vars?.attributes as { lineItems: Array<Record<string, unknown>> };
      created = attrs.lineItems.map((l, i) => ({ id: `line${i}`, description: '', ...l }));
      if (opts.dropLine) created = created.slice(0, 1);
      return { quoteCreate: { quote: { id: NEW_ID, quoteNumber: '718', quoteStatus: 'draft', jobberWebUri: 'https://secure.getjobber.com/quotes/9' }, userErrors: [] } };
    }
    if (query === QUOTE_LINES_QUERY) {
      return { quote: { id: NEW_ID, quoteNumber: '718', quoteStatus: 'draft', lineItems: { nodes: created, pageInfo: { hasNextPage: false } } } };
    }
    throw new Error(`unexpected query ${query.slice(0, 50)}`);
  });
  return { graphqlRequest };
}

describe('create_quote arguments', () => {
  it('needs exactly one source and valid lines, and allows credits', () => {
    expect(() => parseCreateArgs({ title: 'CO', lines: LINES })).toThrow(QuoteEditArgsError);
    expect(() => parseCreateArgs({ basedOnQuoteId: MAIN, requestId: REQ, title: 'CO', lines: LINES })).toThrow('exactly one');
    expect(() => parseCreateArgs({ clientId: 'client1', title: 'CO', lines: LINES })).toThrow('propertyId');
    expect(() => parseCreateArgs({ basedOnQuoteId: MAIN, title: ' ', lines: LINES })).toThrow('title');
    expect(() => parseCreateArgs({ basedOnQuoteId: MAIN, title: 'CO', lines: [] })).toThrow('lines');
    expect(() => parseCreateArgs({ basedOnQuoteId: MAIN, title: 'CO', lines: [{ ...LINES[0], id: 'x' }] })).toThrow('unknown field');
    expect(() => parseCreateArgs({ basedOnQuoteId: MAIN, title: 'CO', lines: LINES, send: true })).toThrow('Unknown field');
    expect(parseCreateArgs({ basedOnQuoteId: MAIN, title: ' CO ', lines: LINES }).lines[1].unitPrice).toBe(-50);
  });
});

describe('create_quote', () => {
  it('creates a draft on the main quote\'s client and property and verifies it', async () => {
    const jobber = fakeJobber();
    const result = await createQuote(jobber, { basedOnQuoteId: MAIN, title: 'CO: Powder Room', message: 'Change order', lines: LINES });
    expect(result).toMatchObject({ outcome: 'ok', created: true, verified: true, quoteNumber: '718', quoteStatus: 'draft', subtotal: -50 });
    const sent = jobber.graphqlRequest.mock.calls.find(([q]) => String(q).includes('quoteCreate('))?.[1] as { attributes: Record<string, unknown> };
    expect(sent.attributes).toMatchObject({ clientId: 'client1', propertyId: 'prop1', title: 'CO: Powder Room', message: 'Change order' });
    expect((sent.attributes.lineItems as Array<Record<string, unknown>>)[0]).toEqual({ ...LINES[0], saveToProductsAndServices: false });
    expect((result as { version: string }).version).toBe(await quoteVersion('draft', LINES.map((l, i) => ({ id: `line${i}`, ...l }))));
  });

  it('refuses a request without a property and never writes', async () => {
    const jobber = fakeJobber();
    const result = await createQuote(jobber, { requestId: REQ, title: 'New', lines: LINES });
    expect(result).toMatchObject({ outcome: 'refused', created: false });
    expect(jobber.graphqlRequest.mock.calls.some(([q]) => String(q).includes('quoteCreate('))).toBe(false);
  });

  it('refuses when Jobber has no quoteCreate mutation', async () => {
    const result = await createQuote(fakeJobber({ noMutation: true }), { basedOnQuoteId: MAIN, title: 'CO', lines: LINES });
    expect(result).toMatchObject({ outcome: 'refused', created: false });
  });

  it('reports a rejection without claiming a quote exists', async () => {
    const result = await createQuote(fakeJobber({ reject: true }), { basedOnQuoteId: MAIN, title: 'CO', lines: LINES });
    expect(result).toMatchObject({ outcome: 'failed', created: 'unknown' });
  });

  it('reports a created quote whose lines do not match', async () => {
    const result = await createQuote(fakeJobber({ dropLine: true }), { basedOnQuoteId: MAIN, title: 'CO', lines: LINES });
    expect(result).toMatchObject({ outcome: 'failed', created: true, verified: false, quoteNumber: '718' });
  });
});
