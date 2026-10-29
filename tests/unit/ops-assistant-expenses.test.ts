import { describe, expect, it, vi } from 'vitest';
import { EXPENSE_QUERIES, OpsAssistantExpenses, mentionsSource, normalizeReceiptUrl } from '../../worker/src/services/ops-assistant-expenses.js';
import { OpsAssistantRead } from '../../worker/src/services/ops-assistant-read.js';
import { CallBudget, hasScope, scopeRequestAllowed } from '../../worker/src/services/assistant-access.js';
import type { AssistantDirectory, AssistantPrincipal } from '../../worker/src/services/assistant-access.js';
import { handleMcpPost, readMcpJsonBody } from '../../worker/src/routes/ops-assistant.js';
import { createMockD1 } from './helpers/mock-d1.js';

const SQUARE_PDF = 'https://squareup.com/invoices/attachments/download/pdf/invoice?token=abc.def&inline=true';
const TRACKED = `https://a.squareupmessaging.com/CL0/${encodeURIComponent(SQUARE_PDF).replace(/%3A/g, ':')}/1/0101-xyz/sig=452`;

/** Minimal in-memory stand-in for the assistant_expense_writes table. */
function fakeWritesDb() {
  const rows = new Map<string, { source_key: string; status: string; jobber_expense_id: string | null; title: string; total: number; expense_date: string }>();
  const db = {
    rows,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.includes('INSERT INTO assistant_expense_writes')) {
                const [key, , title, total, date] = args as [string, string, string, number, string];
                if (rows.has(key)) return { meta: { changes: 0 } };
                rows.set(key, { source_key: key, status: 'pending', jobber_expense_id: null, title, total, expense_date: date });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('DELETE FROM assistant_expense_writes')) {
                const [key] = args as [string];
                if (rows.get(key)?.status === 'pending') rows.delete(key);
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE assistant_expense_writes')) {
                const [status, id, key] = args as [string, string | null, string];
                const row = rows.get(key);
                if (row) Object.assign(row, { status, jobber_expense_id: id });
                return { meta: { changes: row ? 1 : 0 } };
              }
              throw new Error(`unexpected sql ${sql}`);
            },
            async first() {
              return rows.get(args[0] as string) ?? null;
            },
          };
        },
      };
    },
  };
  return db;
}

const pdfFetcher = vi.fn(async () => new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } }));

const INPUT = {
  sourceKey: '20four7VA invoice #5511-R-0024',
  title: '24/7 VA',
  description: '20four7VA weekly billing, invoice #5511-R-0024',
  date: '2026-10-29',
  total: 216.2,
  receiptUrl: TRACKED,
};

function jobberWith(createResult: unknown | (() => never), existing: unknown[] = []) {
  return {
    graphqlRequest: vi.fn(async (query: string, vars?: Record<string, unknown>) => {
      if (query === EXPENSE_QUERIES.EXPENSES_QUERY) return { expenses: { edges: existing.map((node) => ({ node })), pageInfo: { hasNextPage: false } } };
      if (query === EXPENSE_QUERIES.EXPENSE_CREATE) {
        if (typeof createResult === 'function') return (createResult as () => never)();
        return createResult;
      }
      if (query === EXPENSE_QUERIES.EXPENSE_QUERY) return { expense: { id: vars?.id, title: INPUT.title, description: INPUT.description, total: 216.2, date: '2026-10-29T12:00:00Z' } };
      throw new Error('unexpected query');
    }),
  };
}

const created = { expenseCreate: { expense: { id: 'exp-1', title: INPUT.title, total: 216.2, date: '2026-10-29T12:00:00Z' }, userErrors: [] } };

describe('receipt url', () => {
  it('unwraps a Square click-tracking link to the direct invoice PDF', () => {
    expect(normalizeReceiptUrl(TRACKED)).toBe(SQUARE_PDF);
  });

  it('rejects hosts outside the allowlist, including wrapped ones', () => {
    expect(() => normalizeReceiptUrl('https://evil.example/receipt.pdf')).toThrow(/squareup\.com/);
    expect(() => normalizeReceiptUrl(`https://a.squareupmessaging.com/CL0/${encodeURIComponent('https://evil.example/x')}/1/a`)).toThrow(/squareup\.com/);
    expect(() => normalizeReceiptUrl('http://squareup.com/x.pdf')).toThrow();
  });
});

describe('find_expenses', () => {
  it('maps one page and passes the search term and cursor through', async () => {
    const jobber = { graphqlRequest: vi.fn(async () => ({ expenses: {
      edges: [{ node: { id: 'exp-1', title: '24/7 VA', description: 'weekly', total: 216.2, date: '2026-10-22T12:00:00Z', linkedJob: null, reimbursableTo: null } }],
      pageInfo: { hasNextPage: true, endCursor: 'cur-2' },
    } })) };
    const result = await new OpsAssistantExpenses(jobber, fakeWritesDb() as never).findExpenses('user-a', { searchTerm: 'VA', limit: 5, cursor: 'cur-1' }) as Record<string, any>;
    expect(jobber.graphqlRequest).toHaveBeenCalledWith(EXPENSE_QUERIES.EXPENSES_QUERY, { first: 5, after: 'cur-1', searchTerm: 'VA' });
    expect(result.outcome).toBe('ok');
    expect(result.items[0]).toMatchObject({ id: 'exp-1', title: '24/7 VA', total: 216.2 });
    expect(result.page).toEqual({ limit: 5, hasNextPage: true, nextCursor: 'cur-2' });
  });

  it('reports a failed read instead of an empty list', async () => {
    const jobber = { graphqlRequest: vi.fn(async () => { throw new Error('Jobber API error (500): down'); }) };
    const result = await new OpsAssistantExpenses(jobber, fakeWritesDb() as never).findExpenses('user-a', {}) as Record<string, any>;
    expect(result.outcome).toBe('failed');
    expect(result.failure.message).toContain('not an empty list');
  });
});

describe('source matching', () => {
  it('matches a whole reference but not a longer one', () => {
    expect(mentionsSource('Paid invoice #5511-R-0024.', '#5511-R-0024')).toBe(true);
    expect(mentionsSource('Paid invoice #5511-R-00241', '#5511-R-0024')).toBe(false);
  });
});

describe('log_expense', () => {
  it('creates once with the unwrapped receipt and reads it back', async () => {
    const db = fakeWritesDb();
    const jobber = jobberWith(created);
    const tools = new OpsAssistantExpenses(jobber, db as never, pdfFetcher);
    const result = await tools.logExpense('user-a', INPUT) as Record<string, unknown>;
    expect(result.outcome).toBe('created');
    expect(result.verified).toBe(true);
    const createCall = jobber.graphqlRequest.mock.calls.find(([q]) => q === EXPENSE_QUERIES.EXPENSE_CREATE)!;
    expect(createCall[1]).toEqual({ input: {
      title: INPUT.title,
      description: INPUT.description,
      date: '2026-10-29T12:00:00Z',
      total: 216.2,
      receiptUrl: SQUARE_PDF,
    } });
    expect(db.rows.get(INPUT.sourceKey)).toMatchObject({ status: 'created', jobber_expense_id: 'exp-1' });

    const again = await tools.logExpense('user-a', INPUT) as Record<string, unknown>;
    expect(again.outcome).toBe('duplicate');
    expect(jobber.graphqlRequest.mock.calls.filter(([q]) => q === EXPENSE_QUERIES.EXPENSE_CREATE)).toHaveLength(1);
  });

  it('does not create when Jobber already has an expense mentioning the source', async () => {
    const db = fakeWritesDb();
    const jobber = jobberWith(created, [{ id: 'exp-old', title: '24/7 VA', description: 'Paid 20four7VA invoice #5511-R-0024' }]);
    const result = await new OpsAssistantExpenses(jobber, db as never, pdfFetcher).logExpense('user-a', INPUT) as Record<string, unknown>;
    expect(result.outcome).toBe('duplicate');
    expect(result.expenseId).toBe('exp-old');
    expect(jobber.graphqlRequest.mock.calls.some(([q]) => q === EXPENSE_QUERIES.EXPENSE_CREATE)).toBe(false);
  });

  it('marks an uncertain response unknown and never retries it', async () => {
    const db = fakeWritesDb();
    const jobber = jobberWith(() => { throw new Error('Jobber API request timed out'); });
    const tools = new OpsAssistantExpenses(jobber, db as never, pdfFetcher);
    expect((await tools.logExpense('user-a', INPUT) as Record<string, unknown>).outcome).toBe('unknown');
    expect((await tools.logExpense('user-a', INPUT) as Record<string, unknown>).outcome).toBe('unresolved_prior_attempt');
    expect(jobber.graphqlRequest.mock.calls.filter(([q]) => q === EXPENSE_QUERIES.EXPENSE_CREATE)).toHaveLength(1);
  });

  it('treats a generic GraphQL error from the mutation as unknown', async () => {
    const db = fakeWritesDb();
    const jobber = jobberWith(() => { throw new Error('Jobber GraphQL error: {"errors":[{"message":"Internal server error"}]}'); });
    const result = await new OpsAssistantExpenses(jobber, db as never, pdfFetcher).logExpense('user-a', INPUT) as Record<string, unknown>;
    expect(result.outcome).toBe('unknown');
    expect(db.rows.get(INPUT.sourceKey)?.status).toBe('unknown');
  });

  it('releases the claim when Jobber denies permission before running the mutation', async () => {
    const db = fakeWritesDb();
    const jobber = jobberWith(() => { throw new Error('Jobber GraphQL error: {"errors":[{"message":"Access denied for expenseCreate"}]}'); });
    const result = await new OpsAssistantExpenses(jobber, db as never, pdfFetcher).logExpense('user-a', INPUT) as Record<string, unknown>;
    expect(result.outcome).toBe('failed');
    expect(db.rows.has(INPUT.sourceKey)).toBe(false);
  });

  it('refuses a receipt that redirects off Square', async () => {
    const db = fakeWritesDb();
    const jobber = jobberWith(created);
    const redirecting = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/r.pdf' } }));
    const result = await new OpsAssistantExpenses(jobber, db as never, redirecting).logExpense('user-a', INPUT) as { failure: { message: string } };
    expect(result.failure.message).toContain('redirect_off_allowlist');
    expect(jobber.graphqlRequest.mock.calls.some(([q]) => q === EXPENSE_QUERIES.EXPENSE_CREATE)).toBe(false);
  });

  it('releases the claim when Jobber rejects the input', async () => {
    const db = fakeWritesDb();
    const jobber = jobberWith({ expenseCreate: { expense: null, userErrors: [{ message: 'Total is invalid' }] } });
    const result = await new OpsAssistantExpenses(jobber, db as never, pdfFetcher).logExpense('user-a', INPUT) as { outcome: string; failure: { message: string } };
    expect(result.outcome).toBe('failed');
    expect(result.failure.message).toContain('Total is invalid');
    expect(db.rows.has(INPUT.sourceKey)).toBe(false);
  });

  it('creates nothing when the receipt does not download as a document', async () => {
    const db = fakeWritesDb();
    const jobber = jobberWith(created);
    const htmlFetcher = vi.fn(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const result = await new OpsAssistantExpenses(jobber, db as never, htmlFetcher).logExpense('user-a', INPUT) as { outcome: string; failure: { code: string } };
    expect(result.failure.code).toBe('receipt_unavailable');
    expect(jobber.graphqlRequest.mock.calls.some(([q]) => q === EXPENSE_QUERIES.EXPENSE_CREATE)).toBe(false);
    expect(db.rows.has(INPUT.sourceKey)).toBe(false);
  });

  it('rejects bad amounts and unknown fields before touching anything', async () => {
    const db = fakeWritesDb();
    const jobber = jobberWith(created);
    const tools = new OpsAssistantExpenses(jobber, db as never, pdfFetcher);
    await expect(tools.logExpense('user-a', { ...INPUT, total: 216.205 })).rejects.toThrow(/two decimal/);
    await expect(tools.logExpense('user-a', { ...INPUT, total: -1 })).rejects.toThrow(/positive/);
    await expect(tools.logExpense('user-a', { ...INPUT, extra: 1 })).rejects.toThrow(/Unknown field/);
    await expect(tools.logExpense('user-a', { ...INPUT, date: '2026-02-31' })).rejects.toThrow(/YYYY-MM-DD/);
    expect(jobber.graphqlRequest).not.toHaveBeenCalled();
  });
});

describe('expense scope', () => {
  it('accepts only known scopes', () => {
    expect(scopeRequestAllowed(undefined)).toBe(true);
    expect(scopeRequestAllowed('ops:read')).toBe(true);
    expect(scopeRequestAllowed('ops:read ops:expenses:write')).toBe(true);
    expect(scopeRequestAllowed('ops:read admin')).toBe(false);
    expect(hasScope({ scope: 'ops:read' }, 'ops:expenses:write')).toBe(false);
    expect(hasScope({ scope: 'ops:read ops:expenses:write' }, 'ops:expenses:write')).toBe(true);
  });

  function deps(scope: string) {
    const principal: AssistantPrincipal = { tokenId: `tok-${scope}`, userId: 'user-a', clientId: 'c', resource: 'http://127.0.0.1:8787/mcp', scope };
    const directory = { authenticateAccessToken: async () => principal } as unknown as AssistantDirectory;
    const jobber = jobberWith(created);
    return {
      jobber,
      deps: {
        directory,
        read: new OpsAssistantRead(jobber, createMockD1() as never),
        expenses: new OpsAssistantExpenses(jobber, fakeWritesDb() as never, pdfFetcher),
        db: createMockD1() as never,
        budget: new CallBudget(),
      },
    };
  }

  function mcp(method: string, params?: unknown) {
    return new Request('http://127.0.0.1:8787/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer ctz_x', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  }

  it('hides and refuses log_expense for a read-only token', async () => {
    const { deps: d, jobber } = deps('ops:read');
    const listed = readMcpJsonBody(await (await handleMcpPost(mcp('tools/list'), d)).text()) as { result: { tools: Array<{ name: string }> } };
    const names = listed.result.tools.map((tool) => tool.name);
    expect(names).toContain('find_expenses');
    expect(names).not.toContain('log_expense');
    const called = readMcpJsonBody(await (await handleMcpPost(mcp('tools/call', { name: 'log_expense', arguments: INPUT }), d)).text()) as { error?: { message: string } };
    expect(called.error?.message).toBe('Unknown tool');
    expect(jobber.graphqlRequest).not.toHaveBeenCalled();
  });

  it('offers and runs log_expense for a token granted expense logging', async () => {
    const { deps: d } = deps('ops:read ops:expenses:write');
    const listed = readMcpJsonBody(await (await handleMcpPost(mcp('tools/list'), d)).text()) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map((tool) => tool.name)).toContain('log_expense');
    const called = readMcpJsonBody(await (await handleMcpPost(mcp('tools/call', { name: 'log_expense', arguments: INPUT }), d)).text()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(called.result.content[0].text).outcome).toBe('created');
  });
});
