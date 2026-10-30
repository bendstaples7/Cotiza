import { describe, expect, it, vi } from 'vitest';
import {
  CallBudget,
  hasScope,
  normalizeScope,
  oauthProtectedResourceMetadata,
  type AssistantDirectory,
  type AssistantPrincipal,
  type AuthCodeRecord,
} from '../../worker/src/services/assistant-access.js';
import { OpsAssistantRead } from '../../worker/src/services/ops-assistant-read.js';
import { createOpsAssistantApp, handleMcpPost, readMcpJsonBody } from '../../worker/src/routes/ops-assistant.js';
import { createMockD1, configurePrepareResults, type MockD1Database } from './helpers/mock-d1.js';

const RESOURCE = 'http://127.0.0.1:8787/mcp';
const OFFICE = 'office@chicago-reno.com';
const readPrincipal: AssistantPrincipal = { tokenId: 'tok-read', userId: 'user-a', clientId: 'claude', resource: RESOURCE, scope: 'ops:read' };
const reviewPrincipal: AssistantPrincipal = { ...readPrincipal, tokenId: 'tok-review', scope: 'ops:read review:write' };
const financePrincipal: AssistantPrincipal = { ...readPrincipal, tokenId: 'tok-fin', scope: 'ops:read finance:read' };
const PERIOD = { start: '2026-10-17', end: '2026-10-23' };

function fakeDirectory(current: AssistantPrincipal | null, overrides: Partial<AssistantDirectory> = {}): AssistantDirectory {
  return {
    authenticateAccessToken: async () => current,
    authenticateRefreshToken: async () => null,
    mintToken: async () => ({ id: 'new', token: 'ctz_new', expiresAt: '2099-01-01T00:00:00.000Z' }),
    revoke: async () => true,
    revokeByHash: async () => true,
    list: async () => [],
    findClient: async () => null,
    saveClient: async () => undefined,
    saveTx: async () => undefined,
    loadTx: async () => null,
    saveCode: async () => undefined,
    consumeCode: async () => null,
    ...overrides,
  };
}

function mcp(method: string, params?: unknown) {
  return new Request(RESOURCE, {
    method: 'POST',
    headers: { Authorization: 'Bearer ctz_test', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

const schema = { range: { inputFields: [{ name: 'after' }, { name: 'before' }] }, amounts: { fields: [{ name: 'total', type: { kind: 'SCALAR', name: 'Float' } }] } };
const conn = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

function jobberMock(fail = false) {
  return {
    graphqlRequest: vi.fn(async (q: string) => {
      if (q.includes('WeeklyReportSchema')) return schema;
      if (q.includes('WeeklyExpenses')) {
        return { expenses: conn([{ id: 'exp-1', date: '2026-10-20T12:00:00Z', title: 'Lumber', description: 'Receipt', total: 12.5, enteredBy: { name: { full: 'Ben' } }, paidBy: { name: { full: 'Ivan' } }, reimbursableTo: { name: { full: 'Ivan' } }, linkedJob: null }]) };
      }
      if (q.includes('WeeklyPayments')) {
        if (fail) throw new Error('secret upstream detail');
        return { paymentRecords: conn([{ id: 'pay-1', entryDate: '2026-10-21T12:00:00Z', __typename: 'ZellePaymentRecord', amount: 100, rawAmount: 100, adjustmentType: 'PAYMENT', client: { firstName: 'A' }, invoice: { invoiceNumber: '266' } }]) };
      }
      if (q.includes('WeeklyInvoices')) {
        return { invoices: conn([{ id: 'inv-1', issuedDate: '2026-10-22T12:00:00Z', invoiceNumber: '269', amounts: { total: 200 }, client: { firstName: 'A' } }]) };
      }
      throw new Error('unexpected query');
    }),
  };
}

/** The first prepare() is the users lookup; later ones (audit rows) fall back to defaults. */
function dbFor(email: string | null): MockD1Database {
  const db = createMockD1();
  configurePrepareResults(db, [{ first: email ? { email } : null }]);
  return db;
}

function deps(principal: AssistantPrincipal, db: MockD1Database, jobber = jobberMock()) {
  return {
    directory: fakeDirectory(principal),
    read: new OpsAssistantRead({ graphqlRequest: vi.fn() }, createMockD1() as never),
    db: db as never,
    budget: new CallBudget(),
    jobber,
  };
}

async function toolNames(response: Response) {
  const body = readMcpJsonBody(await response.text()) as { result: { tools: Array<{ name: string }> } };
  return body.result.tools.map((tool) => tool.name);
}

async function toolPayload(response: Response) {
  const body = readMcpJsonBody(await response.text()) as { result: { content: Array<{ text: string }>; isError: boolean } };
  return { isError: body.result.isError, text: body.result.content[0].text, payload: JSON.parse(body.result.content[0].text) as Record<string, unknown> };
}

function sqlOf(db: MockD1Database): string[] {
  return db.prepare.mock.calls.map((call) => String(call[0]));
}

describe('finance:read scope', () => {
  it('normalizes scopes in a fixed order and publishes finance:read', () => {
    expect(normalizeScope('finance:read')).toBe('ops:read finance:read');
    expect(normalizeScope('finance:read review:write')).toBe('ops:read review:write finance:read');
    expect(normalizeScope('finance:read  ops:read')).toBe('ops:read finance:read');
    expect(normalizeScope('finance:write')).toBeNull();
    expect(hasScope('ops:read', 'finance:read')).toBe(false);
    expect(hasScope('ops:read review:write', 'finance:read')).toBe(false);
    expect(hasScope('ops:read finance:read', 'finance:read')).toBe(true);
    expect(oauthProtectedResourceMetadata('http://127.0.0.1:8787').scopes_supported).toEqual(['ops:read', 'review:write', 'finance:read']);
  });

  it('hides the report tool from ops:read and review:write tokens without looking up the user', async () => {
    for (const principal of [readPrincipal, reviewPrincipal]) {
      const db = createMockD1();
      const names = await toolNames(await handleMcpPost(mcp('tools/list'), deps(principal, db)));
      expect(names).not.toContain('weekly_payout_report');
      expect(sqlOf(db).some((sql) => /FROM users/.test(sql))).toBe(false);
    }
  });

  it('hides the report tool from a finance:read token that is not the office account', async () => {
    const names = await toolNames(await handleMcpPost(mcp('tools/list'), deps(financePrincipal, dbFor('ben@chicago-reno.com'))));
    expect(names).not.toContain('weekly_payout_report');
  });

  it('lists a read-only report tool for the office account with finance:read', async () => {
    const response = await handleMcpPost(mcp('tools/list'), deps(financePrincipal, dbFor(OFFICE)));
    const body = readMcpJsonBody(await response.text()) as { result: { tools: Array<{ name: string; description: string; annotations: { readOnlyHint: boolean }; inputSchema: { properties: Record<string, unknown>; additionalProperties: boolean } }> } };
    const tool = body.result.tools.find((t) => t.name === 'weekly_payout_report')!;
    expect(tool).toBeTruthy();
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['start', 'end']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.description).toMatch(/Read-only/);
    expect(tool.description).toMatch(/not cash receipts/);
    expect(tool.description).toMatch(/America\/Chicago/);
    expect(tool.description).toMatch(/31 days/);
  });

  it('refuses the report for a token without finance:read and reads nothing', async () => {
    for (const principal of [readPrincipal, reviewPrincipal]) {
      const db = createMockD1();
      const jobber = jobberMock();
      const { isError, payload } = await toolPayload(await handleMcpPost(mcp('tools/call', { name: 'weekly_payout_report', arguments: PERIOD }), deps(principal, db, jobber)));
      expect(isError).toBe(true);
      expect(payload.outcome).toBe('forbidden');
      expect((payload.failure as { code: string }).code).toBe('insufficient_scope');
      expect((payload.failure as { message: string }).message).toContain('finance:read');
      expect(jobber.graphqlRequest).not.toHaveBeenCalled();
    }
  });

  it('refuses the report for a finance:read token that is not the office account', async () => {
    for (const email of ['ben@chicago-reno.com', null]) {
      const jobber = jobberMock();
      const { isError, payload } = await toolPayload(await handleMcpPost(mcp('tools/call', { name: 'weekly_payout_report', arguments: PERIOD }), deps(financePrincipal, dbFor(email), jobber)));
      expect(isError).toBe(true);
      expect(payload.outcome).toBe('forbidden');
      expect((payload.failure as { code: string }).code).toBe('forbidden_user');
      expect(jobber.graphqlRequest).not.toHaveBeenCalled();
    }
  });

  it('rejects invalid periods and extra fields before reading Jobber', async () => {
    for (const args of [
      { start: '2026-02-30', end: '2026-03-01' },
      { start: '2026-10-23', end: '2026-10-17' },
      { start: '2026-10-01', end: '2026-11-15' },
      { ...PERIOD, query: 'x' },
      { start: '2026-10-17' },
    ]) {
      const jobber = jobberMock();
      const { isError, payload } = await toolPayload(await handleMcpPost(mcp('tools/call', { name: 'weekly_payout_report', arguments: args }), deps(financePrincipal, dbFor(OFFICE), jobber)));
      expect(isError).toBe(true);
      expect(payload.outcome).toBe('invalid_request');
      expect(jobber.graphqlRequest).not.toHaveBeenCalled();
    }
  });

  it('returns the complete report rows and summary without CSV file bodies', async () => {
    const db = dbFor(OFFICE);
    const { isError, payload } = await toolPayload(await handleMcpPost(mcp('tools/call', { name: 'weekly_payout_report', arguments: PERIOD }), deps(financePrincipal, db)));
    expect(isError).toBe(false);
    expect(payload.outcome).toBe('ok');
    expect(payload.complete).toBe(true);
    expect(payload.readOnly).toBe(true);
    expect(payload.period).toEqual({ ...PERIOD, timeZone: 'America/Chicago' });
    expect(payload.summary).toEqual({ expenseCount: 1, expenseTotal: 12.5, paymentCount: 1, paymentApiAmount: 100, invoiceCount: 1 });
    expect((payload.expenses as Array<Record<string, unknown>>)[0]['Source ID']).toBe('exp-1');
    expect((payload.transactions as Array<Record<string, unknown>>).map((row) => row['Source ID'])).toEqual(['pay-1', 'inv-1']);
    expect(Array.isArray(payload.limitations)).toBe(true);
    expect(payload).not.toHaveProperty('files');
    // Audit row names the token.
    const audit = db._stmts.find((stmt) => stmt.bind.mock.calls.some((call) => call.some((arg: unknown) => String(arg).includes('token=tok-fin'))));
    expect(audit).toBeTruthy();
  });

  it('returns an explicit failure with no rows when any collection fails', async () => {
    const { isError, text, payload } = await toolPayload(await handleMcpPost(mcp('tools/call', { name: 'weekly_payout_report', arguments: PERIOD }), deps(financePrincipal, dbFor(OFFICE), jobberMock(true))));
    expect(isError).toBe(true);
    expect(payload.outcome).toBe('failed');
    expect(payload.complete).toBe(false);
    expect(payload).not.toHaveProperty('expenses');
    expect(payload).not.toHaveProperty('transactions');
    expect(payload).not.toHaveProperty('summary');
    expect(text).not.toContain('secret upstream detail');
  });

  it('offers the finance tick only when the client did not limit itself to ops:read', async () => {
    const saved: string[] = [];
    const directory = fakeDirectory(null, {
      findClient: async () => ({ clientId: 'cotiza-ops-local', name: 'x', redirectUris: ['http://127.0.0.1:8787/oauth/exercise-callback'] }),
      saveTx: async (_id, payload) => { saved.push(payload); },
    });
    const app = createOpsAssistantApp(() => directory);
    const base = {
      response_type: 'code',
      client_id: 'cotiza-ops-local',
      redirect_uri: 'http://127.0.0.1:8787/oauth/exercise-callback',
      code_challenge: 'c',
      code_challenge_method: 'S256',
      resource: RESOURCE,
    };
    for (const [scope, offered] of [[undefined, true], ['ops:read', false], ['ops:read review:write', false], ['ops:read finance:read', true]] as const) {
      const params = new URLSearchParams(scope ? { ...base, scope } : base);
      const response = await app.request(`http://127.0.0.1:8787/oauth/authorize?${params}`, {}, { DB: {} } as never);
      expect(response.status).toBe(200);
      expect(JSON.parse(saved.pop()!).offerFinanceRead).toBe(offered);
    }
  });

  it('grants finance:read only when the office account ticks it', async () => {
    const pending = (offerFinanceRead: boolean, email: string) => JSON.stringify({
      clientId: 'claude', redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'c', state: 's',
      resource: RESOURCE, offerReviewWrite: true, offerFinanceRead, userId: 'user-a', email,
    });
    const cases: Array<[boolean, string, Record<string, string>, string]> = [
      [true, OFFICE, { decision: 'allow' }, 'ops:read'],
      [true, OFFICE, { decision: 'allow', finance_read: 'yes' }, 'ops:read finance:read'],
      [true, OFFICE, { decision: 'allow', finance_read: 'yes', review_write: 'yes' }, 'ops:read review:write finance:read'],
      [false, OFFICE, { decision: 'allow', finance_read: 'yes' }, 'ops:read'],
      [true, 'ben@chicago-reno.com', { decision: 'allow', finance_read: 'yes' }, 'ops:read'],
    ];
    for (const [offer, email, form, expected] of cases) {
      const codes: AuthCodeRecord[] = [];
      const app = createOpsAssistantApp(() => fakeDirectory(null, {
        loadTx: async () => pending(offer, email),
        saveCode: async (record) => { codes.push(record); },
      }));
      const response = await app.request('http://127.0.0.1:8787/oauth/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ tx: 'tx-1', ...form }).toString(),
      }, { DB: {} } as never);
      expect(response.status).toBe(302);
      expect(codes[0].scope).toBe(expected);
    }
  });
});
