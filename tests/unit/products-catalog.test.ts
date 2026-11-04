import { describe, expect, it, vi } from 'vitest';
import {
  applyQuoteEdits,
  parseApplyArgs,
  planEdits,
  quoteVersion,
  QuoteEditArgsError,
  QUOTE_EDIT_SCHEMA_QUERY,
  QUOTE_LINES_QUERY,
  type QuoteLine,
} from '../../worker/src/services/jobber-quote-edits.js';
import { PRODUCTS_QUERY, catalogKey, matchCatalog, type CatalogItem } from '../../worker/src/services/ops-assistant-products.js';
import { OpsAssistantRead, TOOL_DEFINITIONS, callAssistantTool } from '../../worker/src/services/ops-assistant-read.js';

const line = (id: string, name: string, quantity = 1, unitPrice = 100, description = ''): QuoteLine => ({ id, name, description, quantity, unitPrice });
const nonNull = (inner: object) => ({ kind: 'NON_NULL', name: null, ofType: inner });
const scalar = (name: string) => ({ kind: 'SCALAR', name });
const list = (name: string) => nonNull({ kind: 'LIST', name: null, ofType: nonNull({ kind: 'INPUT_OBJECT', name }) });
const schema = {
  __schema: { mutationType: { fields: [
    { name: 'quoteEditLineItems', args: [{ name: 'quoteId', type: nonNull(scalar('EncodedId')) }, { name: 'lineItems', type: list('QuoteEditLineItemAttributes') }] },
    { name: 'quoteCreateLineItems', args: [{ name: 'quoteId', type: nonNull(scalar('EncodedId')) }, { name: 'lineItems', type: list('QuoteCreateLineItemAttributes') }] },
    { name: 'quoteDeleteLineItems', args: [{ name: 'quoteId', type: nonNull(scalar('EncodedId')) }, { name: 'lineItemIds', type: nonNull({ kind: 'LIST', name: null, ofType: nonNull(scalar('EncodedId')) }) }] },
  ] } },
  edit: { inputFields: ['lineItemId', 'name', 'description', 'quantity', 'unitPrice'].map((name) => ({ name, type: scalar(name === 'quantity' || name === 'unitPrice' ? 'Float' : 'String') })) },
  create: { inputFields: [
    ...['name', 'description', 'quantity', 'unitPrice'].map((name) => ({ name, type: scalar(name === 'quantity' || name === 'unitPrice' ? 'Float' : 'String') })),
    { name: 'saveToProductsAndServices', type: nonNull(scalar('Boolean')) },
  ] },
};

const product = (name: string, defaultUnitCost = 100, description = ''): Record<string, unknown> => ({ id: `p-${name}`, name, description, defaultUnitCost, category: 'SERVICE' });

/** Fake Jobber with a quote and a Products & Services catalog paged two items at a time. */
function fakeJobber(initial: QuoteLine[], catalog: Array<Record<string, unknown>>, opts: { failCatalog?: boolean; nullCatalog?: boolean; rejectCreate?: boolean } = {}) {
  let lines = [...initial];
  const products = [...catalog];
  let next = 1;
  const created: Array<Record<string, unknown>> = [];
  const graphqlRequest = vi.fn(async (query: string, vars?: Record<string, unknown>) => {
    if (query === PRODUCTS_QUERY) {
      if (opts.failCatalog) throw new Error('403 forbidden');
      if (opts.nullCatalog) return { productOrServices: null };
      const start = vars?.after ? Number(vars.after) : 0;
      const page = products.slice(start, start + (vars?.first as number));
      const end = start + page.length;
      return { productOrServices: { edges: page.map((node) => ({ node })), pageInfo: { hasNextPage: end < products.length, endCursor: String(end) } } };
    }
    if (query === QUOTE_LINES_QUERY) return { quote: { id: 'q', quoteNumber: '717', quoteStatus: 'draft', lineItems: { nodes: lines, pageInfo: { hasNextPage: false } } } };
    if (query === QUOTE_EDIT_SCHEMA_QUERY) return schema;
    const items = (vars?.items ?? []) as Array<Record<string, unknown>>;
    if (query.includes('quoteCreateLineItems(')) {
      const reject = opts.rejectCreate;
      for (const i of items) {
        created.push(i);
        lines.push(line(`newLine${next++}`, i.name as string, i.quantity as number, i.unitPrice as number, i.description as string));
        if (i.saveToProductsAndServices === true) products.push(product(i.name as string, i.unitPrice as number, i.description as string));
      }
      // rejectCreate: the lines are saved but Jobber still answers with an error.
      return { quoteCreateLineItems: { userErrors: reject ? [{ message: 'Something went wrong' }] : [] } };
    }
    if (query.includes('quoteEditLineItems(')) return { quoteEditLineItems: { userErrors: [] } };
    if (query.includes('quoteDeleteLineItems(')) {
      const ids = new Set(vars?.items as string[]);
      lines = lines.filter((l) => !ids.has(l.id));
      return { quoteDeleteLineItems: { userErrors: [] } };
    }
    throw new Error(`unexpected query ${query.slice(0, 40)}`);
  });
  return { graphqlRequest, created, products: () => products };
}

const A = line('lineA', 'Interior Water Investigation', 4, 65);
const B = line('lineB', 'Drywall: Patches', 4, 65);

describe('find_products', () => {
  it('is listed as a read tool', () => {
    expect(TOOL_DEFINITIONS.some((t) => t.name === 'find_products')).toBe(true);
  });

  it('reads every page and filters on all words', async () => {
    const jobber = fakeJobber([], [product('Drywall: Patches', 65), product('Plumbing: Hot Water Heater Flushing', 75), product('Materials: Drywall', 100, 'Drywall, tape and mud'), product('Electrical: Swap Light Fixture', 150)]);
    const read = new OpsAssistantRead(jobber, {} as never);
    const result = await callAssistantTool(read, 'u', 'find_products', { query: 'drywall' }) as { outcome: string; items: Array<{ name: { value?: string; untrusted?: boolean }; defaultUnitPrice: { value?: number } }>; totalMatches: number; catalogSize: number; catalogComplete: boolean };
    expect(result.outcome).toBe('ok');
    expect(result.catalogSize).toBe(4);
    expect(result.catalogComplete).toBe(true);
    expect(result.items.map((i) => i.name.value)).toEqual(['Drywall: Patches', 'Materials: Drywall']);
    expect(result.items[0].name.untrusted).toBe(true);
    expect(result.items[0].defaultUnitPrice.value).toBe(65);
  });

  it('reads past the first page and stops at the 2,000-item cap', async () => {
    const big = Array.from({ length: 2001 }, (_, i) => product(`Item ${i}`));
    const read = new OpsAssistantRead(fakeJobber([], big), {} as never);
    const result = await callAssistantTool(read, 'u', 'find_products', {}) as { catalogSize: number; catalogComplete: boolean; items: unknown[]; totalMatches: number; truncated: boolean };
    expect(result.catalogSize).toBe(2000);
    expect(result.catalogComplete).toBe(false);
    expect(result.totalMatches).toBe(2000);
    expect(result.items).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it('returns 100 of 101 matches and says it is truncated', async () => {
    const read = new OpsAssistantRead(fakeJobber([], Array.from({ length: 101 }, (_, i) => product(`Tile ${i}`))), {} as never);
    const result = await callAssistantTool(read, 'u', 'find_products', { query: 'tile' }) as { items: unknown[]; totalMatches: number; truncated: boolean; catalogComplete: boolean };
    expect(result.catalogComplete).toBe(true);
    expect(result.totalMatches).toBe(101);
    expect(result.items).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it('treats a missing catalog list as a failed read, not an empty catalog', async () => {
    const read = new OpsAssistantRead(fakeJobber([], [], { nullCatalog: true }), {} as never);
    const result = await callAssistantTool(read, 'u', 'find_products', {}) as { outcome: string };
    expect(result.outcome).toBe('failed');
  });

  it('reports a failed read, never an empty catalog', async () => {
    const read = new OpsAssistantRead(fakeJobber([], [], { failCatalog: true }), {} as never);
    const result = await callAssistantTool(read, 'u', 'find_products', {}) as { outcome: string };
    expect(result.outcome).toBe('failed');
  });

  it('rejects unknown fields', async () => {
    const read = new OpsAssistantRead(fakeJobber([], []), {} as never);
    await expect(callAssistantTool(read, 'u', 'find_products', { name: 'x' })).rejects.toThrow(/Unknown field/);
  });

  it('matches names regardless of case, spacing and dash style', () => {
    expect(catalogKey('Plumbing:  Replace Shower Valve Cartridge')).toBe(catalogKey('plumbing: replace shower valve cartridge'));
    expect(catalogKey('A – B')).toBe(catalogKey('a - b'));
    expect(catalogKey('A—B')).toBe(catalogKey('a - b'));
    expect(catalogKey('A \u2212 B')).toBe(catalogKey('a-b'));
    const items: CatalogItem[] = [{ id: '1', name: 'Shower Valve', description: 'cartridge swap', defaultUnitCost: 1, category: null }];
    expect(matchCatalog(items, 'valve cartridge')).toHaveLength(1);
    expect(matchCatalog(items, 'valve tile')).toHaveLength(0);
  });
});

describe('apply_quote_edits saveToCatalog', () => {
  it('only accepts saveToCatalog on new lines', () => {
    expect(() => parseApplyArgs({ quoteId: 'q123', quoteVersion: '0123456789abcdef', lines: [{ id: 'lineA', name: 'x', quantity: 1, unitPrice: 1, saveToCatalog: true }] }))
      .toThrow(QuoteEditArgsError);
    expect(() => parseApplyArgs({ quoteId: 'q123', quoteVersion: '0123456789abcdef', lines: [{ name: 'x', quantity: 1, unitPrice: 1, saveToCatalog: 'yes' }] }))
      .toThrow(QuoteEditArgsError);
  });

  it('never marks existing lines recreated for order as catalog saves', () => {
    const plan = planEdits([A, B], [{ name: 'New', quantity: 1, unitPrice: 75, saveToCatalog: true }, B, A]);
    expect(plan.creates.map((c) => [c.name, c.saveToCatalog === true])).toEqual([['New', true], ['Drywall: Patches', false], ['Interior Water Investigation', false]]);
  });

  it('saves new catalog lines, skips names already there, and verifies', async () => {
    const jobber = fakeJobber([A, B], [product('Drywall: Patches', 65), product('Materials: Drywall', 50)]);
    const version = await quoteVersion('draft', [A, B]);
    const result = await applyQuoteEdits(jobber, {
      quoteId: 'q123', quoteVersion: version,
      lines: [
        { id: 'lineA', name: A.name, quantity: 4, unitPrice: 65 },
        { name: 'Plumbing: Replace Shower Valve Cartridge', description: 'Replace the cartridge.', quantity: 2, unitPrice: 100, saveToCatalog: true },
        { name: 'Materials: Shower Valve Cartridge', quantity: 1, unitPrice: 75, saveToCatalog: true },
        { id: 'lineB', name: B.name, quantity: 4, unitPrice: 65 },
        { name: 'materials:  drywall', quantity: 1, unitPrice: 50, saveToCatalog: true },
      ],
    }) as { outcome: string; verified: boolean; catalog: { saved: string[]; skippedExisting: string[]; verified: boolean } };
    expect(result.outcome).toBe('ok');
    expect(result.verified).toBe(true);
    expect(result.catalog.saved).toEqual(['Plumbing: Replace Shower Valve Cartridge', 'Materials: Shower Valve Cartridge']);
    expect(result.catalog.skippedExisting).toEqual(['materials:  drywall']);
    expect(result.catalog.verified).toBe(true);
    const flags = Object.fromEntries(jobber.created.map((c) => [c.name, c.saveToProductsAndServices]));
    expect(flags['Drywall: Patches']).toBe(false);
    expect(flags['materials:  drywall']).toBe(false);
    expect(jobber.products().filter((p) => catalogKey(String(p.name)) === catalogKey('Materials: Drywall'))).toHaveLength(1);
  });

  it('still applies the quote but saves nothing when the catalog cannot be read', async () => {
    const jobber = fakeJobber([A], [], { failCatalog: true });
    const version = await quoteVersion('draft', [A]);
    const result = await applyQuoteEdits(jobber, {
      quoteId: 'q123', quoteVersion: version,
      lines: [{ id: 'lineA', name: A.name, quantity: 4, unitPrice: 65 }, { name: 'New line', quantity: 1, unitPrice: 10, saveToCatalog: true }],
    }) as { outcome: string; catalog: { saved: string[]; notSaved?: string } };
    expect(result.outcome).toBe('ok');
    expect(result.catalog.saved).toEqual([]);
    expect(result.catalog.notSaved).toMatch(/could not be read/);
    expect((result.catalog as { verified?: boolean }).verified).toBe(false);
    expect(jobber.created[0].saveToProductsAndServices).toBe(false);
  });

  it('leaves the result unchanged when nothing asks for a catalog save', async () => {
    const jobber = fakeJobber([A], [product('x')]);
    const version = await quoteVersion('draft', [A]);
    const result = await applyQuoteEdits(jobber, {
      quoteId: 'q123', quoteVersion: version,
      lines: [{ id: 'lineA', name: A.name, quantity: 4, unitPrice: 65 }, { name: 'New line', quantity: 1, unitPrice: 10 }],
    }) as Record<string, unknown>;
    expect(result.catalog).toBeUndefined();
    expect(jobber.graphqlRequest.mock.calls.some(([q]) => q === PRODUCTS_QUERY)).toBe(false);
  });

  it('saves a name repeated in one request only once', async () => {
    const jobber = fakeJobber([A], []);
    const version = await quoteVersion('draft', [A]);
    const result = await applyQuoteEdits(jobber, {
      quoteId: 'q123', quoteVersion: version,
      lines: [
        { id: 'lineA', name: A.name, quantity: 4, unitPrice: 65 },
        { name: 'Paint: Touch-Up', quantity: 1, unitPrice: 65, saveToCatalog: true },
        { name: 'paint: touch - up', quantity: 2, unitPrice: 65, saveToCatalog: true },
      ],
    }) as { catalog: { saved: string[]; skippedExisting: string[] } };
    expect(result.catalog.saved).toEqual(['Paint: Touch-Up']);
    expect(result.catalog.skippedExisting).toEqual(['paint: touch - up']);
    expect(jobber.created.filter((c) => c.saveToProductsAndServices === true)).toHaveLength(1);
  });

  it('still checks the catalog when the create call errors after saving', async () => {
    const jobber = fakeJobber([A], [], { rejectCreate: true });
    const version = await quoteVersion('draft', [A]);
    const result = await applyQuoteEdits(jobber, {
      quoteId: 'q123', quoteVersion: version,
      lines: [{ id: 'lineA', name: A.name, quantity: 4, unitPrice: 65 }, { name: 'New line', quantity: 1, unitPrice: 10, saveToCatalog: true }],
    }) as { outcome: string; catalog: { saved: string[]; verified: boolean } };
    expect(result.outcome).toBe('failed');
    expect(result.catalog.saved).toEqual(['New line']);
    expect(result.catalog.verified).toBe(true);
  });
});
