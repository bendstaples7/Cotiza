import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CallBudget,
  D1AssistantDirectory,
  hasScope,
  normalizeScope,
  pkceS256,
  type AssistantDirectory,
  type AssistantPrincipal,
  type AuthCodeRecord,
} from '../../worker/src/services/assistant-access.js';
import { OpsAssistantRead } from '../../worker/src/services/ops-assistant-read.js';
import { CONTACT_KEY_RE, REVIEW_FEEDBACK_STATUSES, ReviewFeedbackStore } from '../../worker/src/services/review-feedback.js';
import { createOpsAssistantApp, handleMcpPost, readMcpJsonBody } from '../../worker/src/routes/ops-assistant.js';
import { createMockD1, configurePrepareResults, type MockD1Database } from './helpers/mock-d1.js';
// @ts-expect-error plain ESM script without type declarations
import { DEFAULT_LEDGER_PATH, ledgerToRows, mapStatus, rowsToSql } from '../../scripts/import-review-feedback.mjs';

const RESOURCE = 'http://127.0.0.1:8787/mcp';
const readPrincipal: AssistantPrincipal = { tokenId: 'tok-read', userId: 'user-a', clientId: 'claude', resource: RESOURCE, scope: 'ops:read' };
const writePrincipal: AssistantPrincipal = { ...readPrincipal, tokenId: 'tok-write', scope: 'ops:read review:write' };

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

function deps(principal: AssistantPrincipal, db: MockD1Database = createMockD1()) {
  return {
    directory: fakeDirectory(principal),
    read: new OpsAssistantRead({ graphqlRequest: vi.fn() }, createMockD1() as never),
    db: db as never,
    budget: new CallBudget(),
  };
}

async function toolNames(response: Response) {
  const body = readMcpJsonBody(await response.text()) as { result: { tools: Array<{ name: string }> } };
  return body.result.tools.map((tool) => tool.name);
}

async function toolPayload(response: Response) {
  const body = readMcpJsonBody(await response.text()) as { result: { content: Array<{ text: string }>; isError: boolean } };
  return { isError: body.result.isError, payload: JSON.parse(body.result.content[0].text) as Record<string, unknown> };
}

function sqlOf(db: MockD1Database): string[] {
  return db.prepare.mock.calls.map((call) => String(call[0]));
}

const goodEntry = {
  author: 'Ben',
  source: 'Claude conversation 2026-10-29',
  quoteNumber: '706',
  status: 'confirmed',
  scope: 'quote 706',
  excerpt: 'Quote 706 is good as is',
  rule: 'Do not add jamb extenders separately on 706.',
};

describe('review:write scope', () => {
  it('normalizes scopes and rejects unknown ones', () => {
    expect(normalizeScope(undefined)).toBe('ops:read');
    expect(normalizeScope('ops:read')).toBe('ops:read');
    expect(normalizeScope('review:write')).toBe('ops:read review:write');
    expect(normalizeScope('review:write  ops:read')).toBe('ops:read review:write');
    expect(normalizeScope('ops:read jobber:write')).toBeNull();
    expect(normalizeScope(['review:write'])).toBeNull();
    expect(hasScope('ops:read', 'review:write')).toBe(false);
    expect(hasScope('ops:read review:write', 'review:write')).toBe(true);
  });

  it('returns the stored scope and refuses a token with an unknown scope', async () => {
    const row = { id: 't1', user_id: 'user-a', client_id: 'claude', resource: RESOURCE, kind: 'access', expires_at: '2099-01-01T00:00:00Z', revoked_at: null };
    const db = createMockD1();
    configurePrepareResults(db, [
      { first: { ...row, scope: 'ops:read' } },
      { first: { ...row, scope: 'ops:read review:write' } },
      { first: { ...row, scope: 'ops:read admin' } },
    ]);
    const directory = new D1AssistantDirectory(db as never);
    expect((await directory.authenticateAccessToken('ctz_a', RESOURCE))?.scope).toBe('ops:read');
    expect((await directory.authenticateAccessToken('ctz_b', RESOURCE))?.scope).toBe('ops:read review:write');
    expect(await directory.authenticateAccessToken('ctz_c', RESOURCE)).toBeNull();
  });

  it('mints read-only tokens unless a scope is passed', async () => {
    const db = createMockD1();
    const directory = new D1AssistantDirectory(db as never);
    await directory.mintToken({ userId: 'u', resource: RESOURCE, label: 'x', clientId: 'c', kind: 'access', ttlMs: 1000 });
    await directory.mintToken({ userId: 'u', resource: RESOURCE, label: 'x', clientId: 'c', kind: 'access', ttlMs: 1000, scope: 'ops:read review:write' });
    expect(db._stmts[0].bind.mock.calls[0][7]).toBe('ops:read');
    expect(db._stmts[1].bind.mock.calls[0][7]).toBe('ops:read review:write');
    await expect(directory.mintToken({ userId: 'u', resource: RESOURCE, label: 'x', clientId: 'c', kind: 'access', ttlMs: 1000, scope: 'review:write' })).rejects.toThrow();
  });

  it('hides write tools from a read token', async () => {
    const names = await toolNames(await handleMcpPost(mcp('tools/list'), deps(readPrincipal)));
    expect(names).toContain('read_review_feedback');
    expect(names).not.toContain('record_review_feedback');
    expect(names).not.toContain('record_quote_review');
  });

  it('lists write tools for a review:write token', async () => {
    const names = await toolNames(await handleMcpPost(mcp('tools/list'), deps(writePrincipal)));
    expect(names).toEqual(expect.arrayContaining(['read_review_feedback', 'record_review_feedback', 'record_quote_review']));
  });

  it('refuses a write from a read token without touching the ledger', async () => {
    for (const name of ['record_review_feedback', 'record_quote_review']) {
      const db = createMockD1();
      const response = await handleMcpPost(mcp('tools/call', { name, arguments: goodEntry }), deps(readPrincipal, db));
      const { isError, payload } = await toolPayload(response);
      expect(isError).toBe(true);
      expect(payload.outcome).toBe('forbidden');
      expect((payload.failure as { code: string }).code).toBe('insufficient_scope');
      expect(sqlOf(db).some((sql) => /quote_review_(feedback|records)/.test(sql))).toBe(false);
    }
  });

  it('records a write with the token, client and user that made it', async () => {
    const db = createMockD1();
    configurePrepareResults(db, [{ first: { id: 'F074', created_at: '2026-10-29T00:00:00Z' } }]);
    const response = await handleMcpPost(mcp('tools/call', { name: 'record_review_feedback', arguments: goodEntry }), deps(writePrincipal, db));
    const { isError, payload } = await toolPayload(response);
    expect(isError).toBe(false);
    expect(payload.outcome).toBe('recorded');
    expect((payload.entry as { id: string }).id).toBe('F074');
    const bound = db._stmts[0].bind.mock.calls[0];
    expect(bound.slice(-3)).toEqual(['user-a', 'tok-write', 'claude']);
    // Audit row names the token too.
    const audit = db._stmts.find((stmt) => stmt.bind.mock.calls.some((call) => call.some((arg: unknown) => String(arg).includes('token=tok-write'))));
    expect(audit).toBeTruthy();
  });

  it('offers the write tick only when the client did not limit itself to ops:read', async () => {
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
    for (const [scope, offered] of [[undefined, true], ['ops:read', false], ['ops:read review:write', true]] as const) {
      const params = new URLSearchParams(scope ? { ...base, scope } : base);
      const response = await app.request(`http://127.0.0.1:8787/oauth/authorize?${params}`, {}, { DB: {} } as never);
      expect(response.status).toBe(200);
      expect(JSON.parse(saved.pop()!).offerReviewWrite).toBe(offered);
    }
    const bad = await app.request(`http://127.0.0.1:8787/oauth/authorize?${new URLSearchParams({ ...base, scope: 'jobber:write' })}`, {}, { DB: {} } as never);
    expect(bad.status).toBe(400);
  });

  it('grants review:write only when the person ticks it', async () => {
    const pending = (offerReviewWrite: boolean) => JSON.stringify({
      clientId: 'claude', redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'c', state: 's',
      resource: RESOURCE, offerReviewWrite, userId: 'user-a', email: 'ben@chicago-reno.com',
    });
    const cases: Array<[boolean, Record<string, string>, string]> = [
      [true, { decision: 'allow' }, 'ops:read'],
      [true, { decision: 'allow', review_write: 'yes' }, 'ops:read review:write'],
      [false, { decision: 'allow', review_write: 'yes' }, 'ops:read'],
    ];
    for (const [offer, form, expected] of cases) {
      const codes: AuthCodeRecord[] = [];
      const app = createOpsAssistantApp(() => fakeDirectory(null, {
        loadTx: async () => pending(offer),
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

  it('keeps a refreshed token at the scope it was granted', async () => {
    const minted: Array<string | undefined> = [];
    const verifier = 'c'.repeat(43);
    const code: AuthCodeRecord = {
      userId: 'user-a', clientId: 'claude', redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeChallenge: await pkceS256(verifier), resource: RESOURCE, scope: 'ops:read', expiresAt: '2099-01-01T00:00:00Z',
    };
    const app = createOpsAssistantApp(() => fakeDirectory(null, {
      consumeCode: async () => code,
      authenticateRefreshToken: async () => ({ ...readPrincipal, clientId: 'claude' }),
      mintToken: async (input) => { minted.push(input.scope); return { id: 'n', token: `ctz_${minted.length}`, expiresAt: '2099-01-01T00:00:00Z' }; },
    }));
    const post = (body: Record<string, string>) => app.request('http://127.0.0.1:8787/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ resource: RESOURCE, ...body }).toString(),
    }, { DB: {} } as never);
    const traded = await post({ grant_type: 'authorization_code', code: 'ctz_code', code_verifier: verifier, client_id: 'claude', redirect_uri: code.redirectUri });
    expect((await traded.json() as { scope: string }).scope).toBe('ops:read');
    const refreshed = await post({ grant_type: 'refresh_token', refresh_token: 'ctz_refresh' });
    expect((await refreshed.json() as { scope: string }).scope).toBe('ops:read');
    expect(minted).toEqual(['ops:read', 'ops:read', 'ops:read']);
  });
});

describe('append-only ledger', () => {
  it('only ever inserts, and the migration blocks updates and deletes', async () => {
    const db = createMockD1();
    configurePrepareResults(db, [
      { first: { id: 'F002', quote_number: '706' } },
      { first: { id: 'F074', created_at: 'now' } },
      { first: { id: 'QR-706-2', created_at: 'now', supersedes: 'QR-706-1' } },
    ]);
    const store = new ReviewFeedbackStore(db as never);
    const superseding = await store.recordFeedback(writePrincipal, { ...goodEntry, supersedes: 'F002' }) as { outcome: string; note: string };
    expect(superseding.outcome).toBe('recorded');
    expect(superseding.note).toContain('F002');
    expect(db._stmts[1].bind.mock.calls[0][9]).toBe('F002');
    const record = await store.recordQuoteReview(writePrincipal, {
      author: 'Ben', source: 'review', quoteNumber: '706', record: { edit_register: [{ id: '706-E01', state: 'approved' }], closed_findings: [], verification: ['line sum checked'] },
    }) as { outcome: string; record: { supersedes: string } };
    expect(record.outcome).toBe('recorded');
    expect(record.record.supersedes).toBe('QR-706-1');
    for (const sql of sqlOf(db)) expect(sql).not.toMatch(/\b(UPDATE|DELETE|REPLACE|UPSERT|ON CONFLICT)\b/i);

    const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../worker/src/migrations/0070_quote_review_feedback.sql'), 'utf8');
    for (const table of ['quote_review_feedback', 'quote_review_records']) {
      expect(migration).toMatch(new RegExp(`BEFORE UPDATE ON ${table}[\\s\\S]*?RAISE\\(ABORT`));
      expect(migration).toMatch(new RegExp(`BEFORE DELETE ON ${table}[\\s\\S]*?RAISE\\(ABORT`));
    }
  });

  it('refuses to supersede an entry that does not exist', async () => {
    const db = createMockD1();
    configurePrepareResults(db, [{ first: null }]);
    await expect(new ReviewFeedbackStore(db as never).recordFeedback(writePrincipal, { ...goodEntry, supersedes: 'F999' })).rejects.toThrow(/no entry/);
    expect(sqlOf(db).some((sql) => sql.includes('INSERT'))).toBe(false);
  });

  it('keeps a supersede from hiding an entry from other quotes', async () => {
    const attempt = async (targetQuote: string | null, quoteNumber: string | null) => {
      const db = createMockD1();
      configurePrepareResults(db, [{ first: { id: 'F002', quote_number: targetQuote } }, { first: { id: 'F074', created_at: 'now' } }]);
      return new ReviewFeedbackStore(db as never).recordFeedback(writePrincipal, { ...goodEntry, quoteNumber, supersedes: 'F002' });
    };
    await expect(attempt(null, '706')).rejects.toThrow(/all quotes/);
    await expect(attempt('669', '706')).rejects.toThrow(/quote 669/);
    await expect(attempt('706', '706')).resolves.toMatchObject({ outcome: 'recorded' });
    await expect(attempt('706', null)).resolves.toMatchObject({ outcome: 'recorded' });
    await expect(attempt(null, null)).resolves.toMatchObject({ outcome: 'recorded' });
  });

  it('refuses contact details in text and under any key spelling', async () => {
    const store = new ReviewFeedbackStore(createMockD1() as never);
    await expect(store.recordFeedback(writePrincipal, { ...goodEntry, excerpt: 'call 3125550100' })).rejects.toThrow(/contact details/);
    await expect(store.recordFeedback(writePrincipal, { ...goodEntry, rule: 'email pat@example.com' })).rejects.toThrow(/contact details/);
    const record = (body: Record<string, unknown>) => store.recordQuoteReview(writePrincipal, { author: 'Ben', source: 's', quoteNumber: '706', record: body });
    await expect(record({ customerName: 'Pat' })).rejects.toThrow(/contact/);
    await expect(record({ emailAddress: 'x' })).rejects.toThrow(/contact/);
    await expect(record({ notes: ['call 312-555-0100'] })).rejects.toThrow(/contact/);
  });

  it('allows the company email in text', async () => {
    const db = createMockD1();
    configurePrepareResults(db, [{ first: { id: 'F074', created_at: 'now' } }]);
    const saved = await new ReviewFeedbackStore(db as never).recordFeedback(writePrincipal, { ...goodEntry, rule: 'Send to office@chicago-reno.com' });
    expect(saved).toMatchObject({ outcome: 'recorded' });
  });

  it('validates fields, lengths and statuses', async () => {
    const store = new ReviewFeedbackStore(createMockD1() as never);
    await expect(store.recordFeedback(writePrincipal, { ...goodEntry, jobberQuoteId: 'x' })).rejects.toThrow(/Unknown field "jobberQuoteId"/);
    await expect(store.recordFeedback(writePrincipal, { ...goodEntry, rule: 'x'.repeat(2001) })).rejects.toThrow(/2000 characters/);
    await expect(store.recordFeedback(writePrincipal, { ...goodEntry, excerpt: '   ' })).rejects.toThrow(/empty/);
    await expect(store.recordFeedback(writePrincipal, { ...goodEntry, status: 'superseded' })).rejects.toThrow(/supersedes/);
    await expect(store.recordFeedback(writePrincipal, { ...goodEntry, quoteNumber: 'abc' })).rejects.toThrow(/quoteNumber/);
    await expect(store.recordQuoteReview(writePrincipal, { author: 'Ben', source: 's', quoteNumber: '706', record: { client: { email: 'a@b.co' } } })).rejects.toThrow(/contact/);
    await expect(store.recordQuoteReview(writePrincipal, { author: 'Ben', source: 's', record: {} })).rejects.toThrow(/quoteNumber/);
    await expect(store.recordQuoteReview(writePrincipal, { author: 'Ben', source: 's', quoteNumber: '706', record: { notes: 'x'.repeat(16_001) } })).rejects.toThrow(/16000/);
  });

  it('reports a failed write as uncertain, not as recorded', async () => {
    const db = createMockD1();
    db.prepare.mockImplementation(() => { throw new Error('D1_ERROR: database is locked'); });
    const result = await new ReviewFeedbackStore(db as never).recordFeedback(writePrincipal, goodEntry) as { outcome: string; failure: { message: string } };
    expect(result.outcome).toBe('failed');
    expect(result.failure.message).toMatch(/may not have been recorded/);
  });
});

describe('read_review_feedback pagination', () => {
  const row = (seq: number, quote: string | null = null) => ({
    seq, id: `F${String(seq).padStart(3, '0')}`, created_at: '2026-10-20', author: 'Ben', source: 's', quote_number: quote,
    status: 'confirmed', status_detail: null, scope: 'all reviews', excerpt: 'e', rule: 'r', supersedes: null, superseded_by: null, written_via: 'import',
  });

  it('returns one page, a next cursor, and the quote record on the first page', async () => {
    const db = createMockD1();
    configurePrepareResults(db, [
      { all: { results: [row(1), row(2, '706'), row(5)] } },
      { first: { id: 'QR-706-1', created_at: '2026-10-29', author: 'import', source: 's', quote_number: '706', record: '{"edit_register":[]}', supersedes: null, written_via: 'import' } },
    ]);
    const page = await new ReviewFeedbackStore(db as never).read({ quoteNumber: '#706', limit: 2 }) as {
      outcome: string; items: Array<{ id: string }>; page: { hasNextPage: boolean; nextCursor: string }; quoteRecord: { id: string; record: unknown };
    };
    expect(page.outcome).toBe('ok');
    expect(page.items.map((item) => item.id)).toEqual(['F001', 'F002']);
    expect(page.page).toMatchObject({ hasNextPage: true, nextCursor: '2' });
    expect(page.quoteRecord.id).toBe('QR-706-1');
    expect(page.quoteRecord.record).toEqual({ edit_register: [] });
    expect(db._stmts[0].bind.mock.calls[0]).toEqual([0, 0, '706', 0, 3]);
  });

  it('continues from the cursor and stops at the last page', async () => {
    const db = createMockD1();
    configurePrepareResults(db, [{ all: { results: [row(5)] } }]);
    const page = await new ReviewFeedbackStore(db as never).read({ quoteNumber: '706', cursor: '2', limit: 2, includeSuperseded: true }) as {
      items: Array<{ id: string }>; page: { hasNextPage: boolean; nextCursor: string | null }; quoteRecord?: unknown;
    };
    expect(db._stmts[0].bind.mock.calls[0]).toEqual([2, 0, '706', 1, 3]);
    expect(page.items.map((item) => item.id)).toEqual(['F005']);
    expect(page.page).toMatchObject({ hasNextPage: false, nextCursor: null });
    expect(page.quoteRecord).toBeUndefined();
    expect(db.prepare).toHaveBeenCalledTimes(1);
  });

  it('rejects bad page arguments and tells a failed read apart from an empty ledger', async () => {
    const store = new ReviewFeedbackStore(createMockD1() as never);
    await expect(store.read({ limit: 51 })).rejects.toThrow(/limit/);
    await expect(store.read({ cursor: 'abc' })).rejects.toThrow(/cursor/);
    await expect(store.read({ quote: '706' })).rejects.toThrow(/Unknown field/);

    const partial = createMockD1();
    partial.prepare
      .mockImplementationOnce(() => ({ bind: () => ({ all: async () => ({ results: [row(1)] }) }) }))
      .mockImplementationOnce(() => { throw new Error('D1 down'); });
    const noRecord = await new ReviewFeedbackStore(partial as never).read({ quoteNumber: '706' }) as { outcome: string };
    expect(noRecord.outcome).toBe('failed');

    const empty = await store.read({}) as { outcome: string; items: unknown[] };
    expect(empty).toMatchObject({ outcome: 'ok', items: [] });

    const db = createMockD1();
    db.prepare.mockImplementation(() => { throw new Error('no such table: quote_review_feedback'); });
    const failed = await new ReviewFeedbackStore(db as never).read({}) as { outcome: string; failure: { message: string } };
    expect(failed.outcome).toBe('failed');
    expect(failed.failure.message).toMatch(/not an empty ledger/);
  });

  it('is available to a read-only token over MCP', async () => {
    const db = createMockD1();
    configurePrepareResults(db, [{ all: { results: [row(1)] } }]);
    const { isError, payload } = await toolPayload(await handleMcpPost(mcp('tools/call', { name: 'read_review_feedback', arguments: {} }), deps(readPrincipal, db)));
    expect(isError).toBe(false);
    expect((payload.items as Array<{ id: string }>)[0].id).toBe('F001');
  });
});

describe('feedback.json import', () => {
  const ledger = {
    updated_on: '2026-10-29',
    feedback_entries: [
      { id: 'F001', date: '2026-10-20', author: 'Ben', source: 'Current conversation', quote: null, status: 'confirmed', scope: 'all reviews', excerpt: 'keep a ledger', rule: 'Consult the ledger.' },
      { id: 'F002', date: '2026-10-21', author: 'Ben', source: 'WhatsApp', quote: '702', status: 'confirmed direction; assistant specifics remain proposed for Pat Example', scope: 'quote 702', excerpt: "Call PAT EXAMPLE at 312-555-0100, 3125550101 or pat@example.com, it's fine", rule: 'Use office@chicago-reno.com for follow-up.' },
      { id: 'F-CAPACITY-PRICING-20261023', date: '2026-10-23', author: 'Ben', source: 'chat', quote: 'all', status: 'accepted/closed', excerpt: 'x', rule: 'y' },
    ],
    calibration: { quote: '669', observed_on: '2026-10-20', edit_register: [{ id: '669-E01' }] },
    quote_697: { observed_on: '2026-10-21', verification: ['ok'] },
    quote_reviews: {
      702: { observed_on: '2026-10-22', client: 'Pat Example', 'client-name': 'Pat Example', customerName: 'Pat Example', edit_register: [{ id: '702-E01', action: 'Tell Pat Example the price', name: 'Tile: Install' }], closed_findings: ['done'] },
    },
  };

  it('maps statuses onto the stored set and keeps the original wording', () => {
    expect(mapStatus('confirmed')).toEqual({ status: 'confirmed', statusDetail: null });
    expect(mapStatus('conditional approval; condition verified')).toEqual({ status: 'conditional', statusDetail: 'conditional approval; condition verified' });
    expect(mapStatus('accepted/closed')).toEqual({ status: 'accepted/closed', statusDetail: null });
    expect(mapStatus('something new')).toEqual({ status: 'proposed', statusDetail: 'something new' });
  });

  it('converts entries and per-quote records without contact details', () => {
    const { entries, records } = ledgerToRows(ledger);
    expect(entries.map((e: { id: string }) => e.id)).toEqual(['F001', 'F002', 'F-CAPACITY-PRICING-20261023']);
    expect(entries[0].quote_number).toBeNull();
    expect(entries[2].quote_number).toBeNull();
    expect(entries[1]).toMatchObject({ quote_number: '702', status: 'confirmed', status_detail: 'confirmed direction; assistant specifics remain proposed for the customer' });
    expect(entries[1].excerpt).not.toMatch(/312-555-0100|3125550101|pat@example\.com|pat example/i);
    expect(entries[1].rule).toContain('office@chicago-reno.com');

    expect(records.map((r: { id: string }) => r.id)).toEqual(['QR-669-1', 'QR-697-1', 'QR-702-1']);
    const r702 = JSON.parse(records[2].record);
    expect(Object.keys(r702).sort()).toEqual(['closed_findings', 'edit_register', 'observed_on']);
    expect(JSON.stringify(r702)).not.toContain('Pat Example');
    expect(r702.edit_register[0].name).toBe('Tile: Install');
    expect(r702.closed_findings).toEqual(['done']);

    const sql = rowsToSql({ entries, records });
    expect(sql.match(/INSERT OR IGNORE INTO quote_review_feedback/g)).toHaveLength(3);
    expect(sql.match(/INSERT OR IGNORE INTO quote_review_records/g)).toHaveLength(3);
    expect(sql).toContain("it''s fine");
    expect(sql).not.toMatch(/\b(UPDATE|DELETE)\b/);
    expect(sql).not.toMatch(/\(seq,/);
  });

  it('uses the same contact-key rule as the worker', () => {
    const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../scripts/import-review-feedback.mjs'), 'utf8');
    expect(script).toContain(CONTACT_KEY_RE.source);
  });

  it.skipIf(!existsSync(DEFAULT_LEDGER_PATH))('imports the real ledger cleanly', () => {
    const real = JSON.parse(readFileSync(DEFAULT_LEDGER_PATH, 'utf8'));
    const { entries, records } = ledgerToRows(real);
    expect(entries).toHaveLength(real.feedback_entries.length);
    for (const entry of entries) expect(REVIEW_FEEDBACK_STATUSES).toContain(entry.status);
    expect(new Set(entries.map((e: { id: string }) => e.id)).size).toBe(entries.length);
    for (const record of records) {
      expect(record.record).not.toMatch(/"client"\s*:/);
      expect(record.record).not.toMatch(/@(?!chicago-reno\.com)[A-Za-z0-9.-]+\.[a-z]{2,}/);
    }
  });
});

