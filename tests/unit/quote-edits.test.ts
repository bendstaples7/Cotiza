import { describe, expect, it, vi } from 'vitest';
import {
  applyQuoteEdits,
  normalizeLines,
  parseApplyArgs,
  planEdits,
  quoteVersion,
  QuoteEditArgsError,
  QUOTE_EDIT_SCHEMA_QUERY,
  QUOTE_LINES_QUERY,
  type QuoteLine,
} from '../../worker/src/services/jobber-quote-edits.js';
import { CallBudget, type AssistantDirectory, type AssistantPrincipal, type AuthCodeRecord } from '../../worker/src/services/assistant-access.js';
import { OpsAssistantRead } from '../../worker/src/services/ops-assistant-read.js';
import { createOpsAssistantApp, handleMcpPost, readMcpJsonBody } from '../../worker/src/routes/ops-assistant.js';
import { createMockD1 } from './helpers/mock-d1.js';

const RESOURCE = 'http://127.0.0.1:8787/mcp';
const OFFICE = 'office@chicago-reno.com';
const line = (id: string, name: string, quantity = 1, unitPrice = 100, description = ''): QuoteLine => ({ id, name, description, quantity, unitPrice });
const A = line('lineA', 'Demo', 8, 70), B = line('lineB', 'Materials: Demo Supplies', 1, 100), C = line('lineC', 'Drywall', 16, 65), D = line('lineD', 'Materials: Drywall', 1, 100);

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

const quoteOf = (lines: QuoteLine[], status = 'draft') => ({ quote: { id: 'q', quoteNumber: '715', quoteStatus: status, lineItems: { nodes: lines, pageInfo: { hasNextPage: false } } } });

/** A fake Jobber that keeps a line list and applies the three mutations to it. */
function fakeJobber(initial: QuoteLine[], opts: { status?: string; rejectCreate?: boolean } = {}) {
  let lines = [...initial];
  let next = 1;
  const graphqlRequest = vi.fn(async (query: string, vars?: Record<string, unknown>) => {
    if (query === QUOTE_LINES_QUERY) return quoteOf(lines, opts.status);
    if (query === QUOTE_EDIT_SCHEMA_QUERY) return schema;
    const items = (vars?.items ?? []) as Array<Record<string, unknown>>;
    if (query.includes('quoteEditLineItems(')) {
      lines = lines.map((l) => {
        const edit = items.find((i) => i.lineItemId === l.id);
        return edit ? { ...l, name: edit.name as string, description: (edit.description as string) ?? l.description, quantity: edit.quantity as number, unitPrice: edit.unitPrice as number } : l;
      });
      return { quoteEditLineItems: { userErrors: [] } };
    }
    if (query.includes('quoteCreateLineItems(')) {
      if (opts.rejectCreate) return { quoteCreateLineItems: { userErrors: [{ message: 'Name is too long' }] } };
      for (const i of items) lines.push(line(`newLine${next++}`, i.name as string, i.quantity as number, i.unitPrice as number, i.description as string));
      return { quoteCreateLineItems: { userErrors: [] } };
    }
    if (query.includes('quoteDeleteLineItems(')) {
      const ids = new Set(vars?.items as string[]);
      lines = lines.filter((l) => !ids.has(l.id));
      return { quoteDeleteLineItems: { userErrors: [] } };
    }
    throw new Error(`unexpected query ${query.slice(0, 40)}`);
  });
  return { graphqlRequest, lines: () => lines };
}

const strip = (l: QuoteLine) => ({ name: l.name, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice });

describe('planEdits', () => {
  it('edits in place when the order is unchanged', () => {
    const plan = planEdits([A, B, C, D], [A, B, { ...C, quantity: 12 }, D]);
    expect(plan.updates.map((l) => l.id)).toEqual(['lineC']);
    expect(plan.creates).toEqual([]);
    expect(plan.deletes).toEqual([]);
  });

  it('deletes removed lines without recreating the rest', () => {
    const plan = planEdits([A, B, C, D], [A, B, C]);
    expect(plan).toMatchObject({ updates: [], creates: [], deletes: ['lineD'] });
  });

  it('recreates from the first new or moved line so the order comes out right', () => {
    const plan = planEdits([A, B, C, D], [A, C, D, B]);
    expect(plan.recreateFrom).toBe(1);
    expect(plan.creates.map((l) => l.name)).toEqual(['Drywall', 'Materials: Drywall', 'Materials: Demo Supplies']);
    expect(plan.deletes.sort()).toEqual(['lineB', 'lineC', 'lineD']);
    const added = planEdits([A, B], [A, { name: 'New', description: '', quantity: 1, unitPrice: 5 }, B]);
    expect(added.creates.map((l) => l.name)).toEqual(['New', 'Materials: Demo Supplies']);
    expect(added.deletes).toEqual(['lineB']);
  });

  it('refuses ids that are not on the quote', () => {
    expect(() => planEdits([A], [{ ...A, id: 'zzzz' }])).toThrow(QuoteEditArgsError);
    expect(() => parseApplyArgs({ quoteId: 'bad id!', quoteVersion: '0123456789abcdef', lines: [A] })).toThrow('quoteId');
  });
});

describe('parseApplyArgs', () => {
  it('rejects unknown fields, missing versions, bad numbers and duplicate ids', () => {
    const base = { quoteId: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=', quoteVersion: '0123456789abcdef', lines: [A] };
    expect(() => parseApplyArgs({ ...base, send: true })).toThrow('Unknown field');
    expect(() => parseApplyArgs({ ...base, quoteVersion: 'x' })).toThrow('quoteVersion');
    expect(() => parseApplyArgs({ ...base, lines: [] })).toThrow('lines');
    expect(() => parseApplyArgs({ ...base, lines: [{ ...A, quantity: 0 }] })).toThrow('quantity');
    expect(parseApplyArgs({ ...base, lines: [{ ...A, unitPrice: -250 }] }).lines[0].unitPrice).toBe(-250);
    expect(() => parseApplyArgs({ ...base, lines: [{ ...A, unitPrice: -2000000 }] })).toThrow('unitPrice');
    expect(() => parseApplyArgs({ ...base, lines: [{ ...A, unitPrice: 'x' }] })).toThrow('unitPrice');
    expect(() => parseApplyArgs({ ...base, lines: [A, A] })).toThrow('twice');
    expect(parseApplyArgs({ ...base, lines: [{ name: ' New ', quantity: 2, unitPrice: 0 }] }).lines[0]).toEqual({ name: 'New', quantity: 2, unitPrice: 0 });
  });
});

describe('applyQuoteEdits', () => {
  it('applies edits, moves and deletes, then verifies the reread quote', async () => {
    const jobber = fakeJobber([A, B, C, D]);
    const version = await quoteVersion('draft', [A, B, C, D]);
    const desired = [{ ...A, description: 'Remove ceiling' }, C, D, { name: 'Debris Removal', description: '', quantity: 1, unitPrice: 500 }];
    const result = await applyQuoteEdits(jobber, { quoteId: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=', quoteVersion: version, lines: desired });
    expect(result).toMatchObject({ outcome: 'ok', verified: true, changed: true, applied: { updated: 1, created: 1, deleted: 1 }, subtotal: 70 * 8 + 16 * 65 + 100 + 500 });
    expect(jobber.lines().map(strip)).toEqual(desired.map((l) => strip(l as QuoteLine)));
    const create = jobber.graphqlRequest.mock.calls.find(([q]) => String(q).includes('quoteCreateLineItems('))!;
    expect((create[1] as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({ saveToProductsAndServices: false });
  });

  it('refuses without writing when the quote changed since it was read', async () => {
    const jobber = fakeJobber([A, B]);
    const result = await applyQuoteEdits(jobber, { quoteId: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=', quoteVersion: '0000000000000000', lines: [A] });
    expect(result).toMatchObject({ outcome: 'conflict', changed: false });
    expect(jobber.graphqlRequest).toHaveBeenCalledTimes(1);
  });

  it('refuses quotes that are not drafts', async () => {
    const jobber = fakeJobber([A, B], { status: 'awaiting_response' });
    const result = await applyQuoteEdits(jobber, { quoteId: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=', quoteVersion: await quoteVersion('awaiting_response', [A, B]), lines: [A] });
    expect(result).toMatchObject({ outcome: 'refused', changed: false });
    expect(jobber.lines()).toEqual([A, B]);
  });

  it('refuses when the live schema lacks a field it would send', async () => {
    const jobber = fakeJobber([A, B]);
    jobber.graphqlRequest.mockImplementation(async (query: string) => {
      if (query === QUOTE_LINES_QUERY) return quoteOf([A, B]);
      if (query === QUOTE_EDIT_SCHEMA_QUERY) return { ...schema, edit: { inputFields: schema.edit.inputFields.filter((f) => f.name !== 'unitPrice') } };
      throw new Error('should not write');
    });
    const result = await applyQuoteEdits(jobber, { quoteId: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=', quoteVersion: await quoteVersion('draft', [A, B]), lines: [{ ...A, quantity: 9 }, B] });
    expect(result).toMatchObject({ outcome: 'refused', changed: false });
    expect(String((result as { reason: string }).reason)).toContain('unitPrice');
  });

  it('never deletes when a create fails, and reports the failure', async () => {
    const jobber = fakeJobber([A, B], { rejectCreate: true });
    const result = await applyQuoteEdits(jobber, { quoteId: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=', quoteVersion: await quoteVersion('draft', [A, B]), lines: [B, A] });
    expect(result).toMatchObject({ outcome: 'failed', verified: false });
    expect(jobber.lines().map((l) => l.id)).toEqual(['lineA', 'lineB']);
  });

  it('keeps an existing description when the line omits it', async () => {
    const described = { ...A, description: 'Remove ceiling' };
    const jobber = fakeJobber([described, B]);
    const { description: _omit, ...noDescription } = described;
    const result = await applyQuoteEdits(jobber, { quoteId: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=', quoteVersion: await quoteVersion('draft', [described, B]), lines: [{ ...noDescription, quantity: 9 }, B] });
    expect(result).toMatchObject({ outcome: 'ok', verified: true, changed: true });
    expect(jobber.lines()[0]).toMatchObject({ description: 'Remove ceiling', quantity: 9 });
  });

  it('reports changed from the reread when a mutation errors after taking effect', async () => {
    const jobber = fakeJobber([A, B]);
    const base = jobber.graphqlRequest.getMockImplementation()!;
    jobber.graphqlRequest.mockImplementation(async (query: string, vars?: Record<string, unknown>) => {
      const out = await base(query, vars);
      return query.includes('quoteEditLineItems(') ? { quoteEditLineItems: { userErrors: [{ message: 'timeout' }] } } : out;
    });
    const result = await applyQuoteEdits(jobber, { quoteId: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=', quoteVersion: await quoteVersion('draft', [A, B]), lines: [{ ...A, quantity: 9 }, B] });
    expect(result).toMatchObject({ outcome: 'failed', changed: true });
  });

  it('changes nothing when the quote already matches', async () => {
    const jobber = fakeJobber([A, B]);
    const result = await applyQuoteEdits(jobber, { quoteId: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=', quoteVersion: await quoteVersion('draft', [A, B]), lines: [A, B] });
    expect(result).toMatchObject({ outcome: 'ok', changed: false, verified: true });
  });
});

describe('read_quote version', () => {
  it('matches the version apply_quote_edits computes', async () => {
    const nodes = [A, B];
    const graphqlRequest = vi.fn(async (query: string) => (query.includes('AssistantQuoteDetail')
      ? { quote: { id: 'q', quoteNumber: '715', title: 't', message: '', quoteStatus: 'draft', lineItems: { nodes, pageInfo: { hasNextPage: false } }, client: null, request: null } }
      : { quote: { id: 'q', contractDisclaimer: null, amounts: { total: 0, depositAmount: 0 }, depositRecords: { nodes: [] } } }));
    const result = await new OpsAssistantRead({ graphqlRequest }, createMockD1() as never).readQuote('u', { quoteId: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=' });
    expect((result as { quote: { version: string } }).quote.version).toBe(await quoteVersion('draft', normalizeLines(nodes as never)));
  });
});

describe('quote:write scope', () => {
  const principal = (scope: string): AssistantPrincipal => ({ tokenId: 't', userId: 'u', clientId: 'claude', resource: RESOURCE, scope });
  const directory = (p: AssistantPrincipal | null, overrides: Partial<AssistantDirectory> = {}): AssistantDirectory => ({
    authenticateAccessToken: async () => p, authenticateRefreshToken: async () => null,
    mintToken: async () => ({ id: 'n', token: 'ctz', expiresAt: '2099-01-01T00:00:00Z' }), revoke: async () => true, revokeByHash: async () => true,
    list: async () => [], findClient: async () => null, saveClient: async () => undefined, saveTx: async () => undefined,
    loadTx: async () => null, saveCode: async () => undefined, consumeCode: async () => null, ...overrides,
  });
  const mcp = (method: string, params?: unknown) => new Request(RESOURCE, {
    method: 'POST',
    headers: { Authorization: 'Bearer ctz', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const deps = (p: AssistantPrincipal, jobber = fakeJobber([A, B])) => ({
    directory: directory(p), read: new OpsAssistantRead({ graphqlRequest: vi.fn() }, createMockD1() as never),
    db: createMockD1() as never, budget: new CallBudget(), jobber,
  });

  it('hides apply_quote_edits from tokens without quote:write and refuses calls', async () => {
    const list = readMcpJsonBody(await (await handleMcpPost(mcp('tools/list'), deps(principal('ops:read review:write')))).text()) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).not.toContain('apply_quote_edits');
    const jobber = fakeJobber([A, B]);
    const call = readMcpJsonBody(await (await handleMcpPost(mcp('tools/call', { name: 'apply_quote_edits', arguments: { quoteId: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=', quoteVersion: '0123456789abcdef', lines: [A] } }), deps(principal('ops:read'), jobber))).text()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(call.result.content[0].text)).toMatchObject({ outcome: 'forbidden', failure: { code: 'insufficient_scope' } });
    expect(jobber.graphqlRequest).not.toHaveBeenCalled();
  });

  it('lists and runs apply_quote_edits for a quote:write token', async () => {
    const jobber = fakeJobber([A, B]);
    const d = deps(principal('ops:read quote:write'), jobber);
    const list = readMcpJsonBody(await (await handleMcpPost(mcp('tools/list'), d)).text()) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toContain('apply_quote_edits');
    const args = { quoteId: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=', quoteVersion: await quoteVersion('draft', [A, B]), lines: [{ ...A, quantity: 10 }, B] };
    const call = readMcpJsonBody(await (await handleMcpPost(mcp('tools/call', { name: 'apply_quote_edits', arguments: args }), d)).text()) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(call.result.isError).toBe(false);
    expect(JSON.parse(call.result.content[0].text)).toMatchObject({ outcome: 'ok', verified: true });
  });

  it('marks refusals as errors and logs which quote a write touched', async () => {
    const jobber = fakeJobber([A, B], { status: 'awaiting_response' });
    const d = deps(principal('ops:read quote:write'), jobber);
    const args = { quoteId: 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=', quoteVersion: await quoteVersion('awaiting_response', [A, B]), lines: [A] };
    const call = readMcpJsonBody(await (await handleMcpPost(mcp('tools/call', { name: 'apply_quote_edits', arguments: args }), d)).text()) as { result: { isError: boolean } };
    expect(call.result.isError).toBe(true);
    const stmts = (d.db as unknown as { _stmts: Array<{ bind: { mock: { calls: unknown[][] } } }> })._stmts;
    const bound = JSON.stringify(stmts.flatMap((stmt) => stmt.bind.mock.calls));
    expect(bound).toContain('quote=715');
  });

  it('grants quote:write only when the office account ticks it', async () => {
    const pending = (email: string) => JSON.stringify({
      clientId: 'claude', redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'c', state: 's',
      resource: RESOURCE, offerReviewWrite: true, offerFinanceRead: true, offerQuoteWrite: true, userId: 'u', email,
    });
    const cases: Array<[string, Record<string, string>, string]> = [
      [OFFICE, { decision: 'allow' }, 'ops:read'],
      [OFFICE, { decision: 'allow', quote_write: 'yes' }, 'ops:read quote:write'],
      ['ben@chicago-reno.com', { decision: 'allow', quote_write: 'yes' }, 'ops:read'],
    ];
    for (const [email, form, expected] of cases) {
      const codes: AuthCodeRecord[] = [];
      const app = createOpsAssistantApp(() => directory(null, { loadTx: async () => pending(email), saveCode: async (r) => { codes.push(r); } }));
      const response = await app.request('http://127.0.0.1:8787/oauth/authorize', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ tx: 'tx-1', ...form }).toString(),
      }, { DB: {} } as never);
      expect(response.status).toBe(302);
      expect(codes[0].scope).toBe(expected);
    }
  });
});
