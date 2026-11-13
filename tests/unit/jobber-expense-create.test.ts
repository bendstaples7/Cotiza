import { describe, expect, it, vi } from 'vitest';
import { EXPENSE_CREATE_QUERIES, logExpense, mentionsSource, normalizeReceiptUrl } from '../../worker/src/services/jobber-expense-create.js';
import { handleMcpPost, readMcpJsonBody } from '../../worker/src/routes/ops-assistant.js';
import { CallBudget, normalizeScope } from '../../worker/src/services/assistant-access.js';
import { OpsAssistantRead } from '../../worker/src/services/ops-assistant-read.js';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';
import { createMockR2 } from './helpers/mock-r2.js';

const SQUARE_PDF = 'https://squareup.com/invoices/attachments/download/pdf/invoice?token=abc.def&inline=true';
const TRACKED = `https://a.squareupmessaging.com/CL0/${encodeURIComponent(SQUARE_PDF).replace(/%3A/g, ':')}/1/0101-xyz/sig=452`;
const KEY = '20four7VA invoice #5511-R-0024';
const INPUT = {
  sourceKey: KEY,
  title: 'Garlien Weekly 20Four7 VA',
  description: `Paid October 29, 2026. ${KEY}. Charged to card on file.`,
  date: '2026-10-29',
  total: 216.2,
  receiptUrl: TRACKED,
};
const TARGET = () => ({ bucket: createMockR2() as never, origin: 'https://cotiza.test' });
const pdf = () => vi.fn(async () => new Response('%PDF-1.4 x', { status: 200, headers: { 'content-type': 'application/pdf' } }));

/** In-memory stand-in for assistant_expense_writes. */
function writesDb() {
  const rows = new Map<string, { status: string; jobber_expense_id: string | null }>();
  return {
    rows,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              const key = (sql.includes('UPDATE') ? args[2] : args[0]) as string;
              if (sql.includes('INSERT')) {
                if (rows.has(key)) return { meta: { changes: 0 } };
                rows.set(key, { status: 'pending', jobber_expense_id: null });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('DELETE')) { if (rows.get(key)?.status === 'pending') rows.delete(key); return { meta: { changes: 1 } }; }
              if (sql.includes('UPDATE')) { const r = rows.get(key); if (r) Object.assign(r, { status: args[0], jobber_expense_id: args[1] }); return { meta: { changes: 1 } }; }
              throw new Error(sql);
            },
            async first() { return rows.get(args[0] as string) ?? null; },
          };
        },
      };
    },
  };
}

function jobber(create: unknown, existing: unknown[] = []) {
  return {
    graphqlRequest: vi.fn(async (query: string, vars?: Record<string, unknown>) => {
      if (query === EXPENSE_CREATE_QUERIES.EXPENSES_QUERY) return { expenses: { edges: existing.map((node) => ({ node })) } };
      if (query === EXPENSE_CREATE_QUERIES.EXPENSE_CREATE) return typeof create === 'function' ? (create as () => unknown)() : create;
      if (query === EXPENSE_CREATE_QUERIES.EXPENSE_QUERY) return { expense: { id: vars?.id, title: INPUT.title, total: 216.2, date: '2026-10-29T12:00:00Z' } };
      throw new Error('unexpected query');
    }),
  };
}
const created = { expenseCreate: { expense: { id: 'exp-1', title: INPUT.title, total: 216.2, date: '2026-10-29T12:00:00Z' }, userErrors: [] } };
const creates = (j: ReturnType<typeof jobber>) => j.graphqlRequest.mock.calls.filter(([q]) => q === EXPENSE_CREATE_QUERIES.EXPENSE_CREATE);

describe('log_expense helpers', () => {
  it('unwraps the Square click-tracking link and rejects other hosts', () => {
    expect(normalizeReceiptUrl(TRACKED)).toBe(SQUARE_PDF);
    expect(() => normalizeReceiptUrl('https://evil.example/x.pdf')).toThrow(/squareup/);
  });
  it('matches the source key only as a whole reference', () => {
    expect(mentionsSource(`x ${KEY}.`, KEY)).toBe(true);
    expect(mentionsSource(`${KEY}5`, KEY)).toBe(false);
  });
  it('knows the expense:create scope', () => {
    expect(normalizeScope('expense:create')).toBe('ops:read expense:create');
  });
});

describe('logExpense', () => {
  it('creates once with a private receipt URL, then reports duplicate on a repeat', async () => {
    const db = writesDb();
    const j = jobber(created);
    const target = TARGET();
    const first = await logExpense(j as never, db as never, target, 'u', INPUT, pdf());
    expect(first).toMatchObject({ outcome: 'created', expenseId: 'exp-1', verified: true });
    const input = (creates(j)[0][1] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({ title: INPUT.title, description: INPUT.description, total: 216.2, date: '2026-10-29T12:00:00Z' });
    expect(String(input.receiptUrl)).toMatch(/^https:\/\/cotiza\.test\/assistant-receipt\/\d{13}-[A-Za-z0-9_-]{43}\.pdf$/);
    const second = await logExpense(j as never, db as never, target, 'u', INPUT, pdf());
    expect(second.outcome).toBe('duplicate');
    expect(creates(j)).toHaveLength(1);
  });

  it('does not create when Jobber already has an expense mentioning the source key', async () => {
    const j = jobber(created, [{ id: 'old', title: 'x', description: `logged ${KEY}` }]);
    const r = await logExpense(j as never, writesDb() as never, TARGET(), 'u', INPUT, pdf());
    expect(r).toMatchObject({ outcome: 'duplicate', expenseId: 'old' });
    expect(creates(j)).toHaveLength(0);
  });

  it('records unknown on an uncertain reply and never retries', async () => {
    const db = writesDb();
    const j = jobber(() => { throw new Error('network reset'); });
    expect((await logExpense(j as never, db as never, TARGET(), 'u', INPUT, pdf())).outcome).toBe('unknown');
    expect((await logExpense(j as never, db as never, TARGET(), 'u', INPUT, pdf())).outcome).toBe('unresolved_prior_attempt');
    expect(creates(j)).toHaveLength(1);
  });

  it('releases the claim when Jobber rejects, so a later call can try again', async () => {
    const db = writesDb();
    const j = jobber({ expenseCreate: { expense: null, userErrors: [{ message: 'Total is invalid' }] } });
    expect((await logExpense(j as never, db as never, TARGET(), 'u', INPUT, pdf())).outcome).toBe('failed');
    expect(db.rows.has(KEY)).toBe(false);
  });

  it('creates nothing when the receipt is not a PDF', async () => {
    const j = jobber(created);
    const html = vi.fn(async () => new Response('<html>', { status: 200 }));
    const r = await logExpense(j as never, writesDb() as never, TARGET(), 'u', INPUT, html);
    expect(r).toMatchObject({ outcome: 'failed', failure: { code: 'receipt_unavailable' } });
    expect(creates(j)).toHaveLength(0);
  });

  it('creates nothing when a redirect leaves squareup.com', async () => {
    const j = jobber(created);
    const hop = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.pdf' } }));
    const r = await logExpense(j as never, writesDb() as never, TARGET(), 'u', INPUT, hop);
    expect(r).toMatchObject({ outcome: 'failed', failure: { code: 'receipt_unavailable' } });
    expect(creates(j)).toHaveLength(0);
  });

  it('creates nothing when the receipt is over 5 MB', async () => {
    const j = jobber(created);
    const big = vi.fn(async () => new Response(new Uint8Array(5 * 1024 * 1024 + 1), { status: 200 }));
    const r = await logExpense(j as never, writesDb() as never, TARGET(), 'u', INPUT, big);
    expect(r).toMatchObject({ outcome: 'failed', failure: { code: 'receipt_unavailable' } });
    expect(creates(j)).toHaveLength(0);
  });

  it('requires a description and a receipt link', async () => {
    const { description: _d, ...noDescription } = INPUT;
    const { receiptUrl: _r, ...noReceipt } = INPUT;
    await expect(logExpense(jobber(created) as never, writesDb() as never, TARGET(), 'u', noDescription, pdf())).rejects.toThrow(/description/);
    await expect(logExpense(jobber(created) as never, writesDb() as never, TARGET(), 'u', noReceipt, pdf())).rejects.toThrow(/receiptUrl/);
  });

  it('requires the description to carry the source key', async () => {
    await expect(logExpense(jobber(created) as never, writesDb() as never, TARGET(), 'u', { ...INPUT, description: 'no ref' }, pdf())).rejects.toThrow(/sourceKey/);
  });
});

describe('log_expense connector wiring', () => {
  const RESOURCE = 'http://127.0.0.1:8787/mcp';
  const mcp = (method: string, params?: unknown) => new Request(RESOURCE, {
    method: 'POST',
    headers: { Authorization: 'Bearer ctz_test', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  function deps(scope: string, email: string) {
    const db = createMockD1();
    configurePrepareResults(db, [{ first: { email } }, { first: { email } }, { first: { email } }]);
    const graphqlRequest = vi.fn();
    return {
      directory: { authenticateAccessToken: async () => ({ tokenId: 't', userId: 'u', clientId: 'c', resource: RESOURCE, scope }) } as never,
      read: new OpsAssistantRead({ graphqlRequest } as never, db as never),
      db: db as never,
      budget: new CallBudget(),
      bucket: createMockR2() as never,
      jobber: { graphqlRequest } as never,
    };
  }
  const list = async (scope: string, email: string) => {
    const body = readMcpJsonBody(await (await handleMcpPost(mcp('tools/list'), deps(scope, email))).text()) as { result: { tools: Array<{ name: string }> } };
    return body.result.tools.map((t) => t.name);
  };

  it('lists log_expense only for an office token with expense:create', async () => {
    expect(await list('ops:read expense:write', 'office@chicago-reno.com')).not.toContain('log_expense');
    expect(await list('ops:read expense:create', 'office@chicago-reno.com')).toContain('log_expense');
    expect(await list('ops:read expense:create', 'ben@chicago-reno.com')).not.toContain('log_expense');
  });

  it('refuses without the scope and without calling Jobber', async () => {
    const d = deps('ops:read expense:write', 'office@chicago-reno.com');
    const res = await handleMcpPost(mcp('tools/call', { name: 'log_expense', arguments: INPUT }), d);
    const body = readMcpJsonBody(await res.text()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).failure.code).toBe('insufficient_scope');
    expect((d.jobber as unknown as { graphqlRequest: { mock: { calls: unknown[] } } }).graphqlRequest.mock.calls).toHaveLength(0);
  });

  it('refuses a non-office token with the scope', async () => {
    const d = deps('ops:read expense:create', 'ben@chicago-reno.com');
    const res = await handleMcpPost(mcp('tools/call', { name: 'log_expense', arguments: INPUT }), d);
    const body = readMcpJsonBody(await res.text()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(body.result.content[0].text).failure.code).toBe('forbidden_user');
  });

  it('marks an unconfirmed create as an error for the client', async () => {
    const d = deps('ops:read expense:create', 'office@chicago-reno.com');
    // Every row answers both the office-email lookup and the prior-claim lookup; inserts report 0 changes.
    const row = { email: 'office@chicago-reno.com', status: 'unknown', jobber_expense_id: null };
    configurePrepareResults(d.db as never, Array.from({ length: 10 }, () => ({ first: row, run: { meta: { changes: 0 } } })));
    const res = await handleMcpPost(mcp('tools/call', { name: 'log_expense', arguments: INPUT }), d);
    const body = readMcpJsonBody(await res.text()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(JSON.parse(body.result.content[0].text).outcome).toBe('unresolved_prior_attempt');
    expect(body.result.isError).toBe(true);
  });
});
