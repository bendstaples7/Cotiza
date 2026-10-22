import { JobberIntegration } from '../../worker/src/services/jobber-integration.js';
import { describe, expect, it, vi } from 'vitest';
import { AssistantExpenseCreate, expenseMarker, validateExpenseInvoice, type ExpenseInvoice } from '../../worker/src/services/assistant-expense-create.js';
import { callAssistantTool, OpsAssistantRead } from '../../worker/src/services/ops-assistant-read.js';
const input: ExpenseInvoice = { supplier: '20four7VA', invoiceNumber: '5511-R-0023', title: '20four7VA invoice 5511-R-0023', description: 'Garlien, 30 hours plus fees', date: '2026-10-22', total: 216.20, receiptUrl: 'https://squareup.com/invoices/attachments/download/pdf/invoice?token=private-test-token' };
function setup() {
  let row: any = null;
  const db = { prepare(sql: string) { return { bind(...args: unknown[]) { return {
    async run() {
      if (sql.startsWith('INSERT') && !row) row = { id: args[0], user_id: args[1], payload: args[3], state: args[4], expense_id: null, expires_at: args[5] };
      if (sql.includes('state = ?, expires_at') && ['pending', 'authorized'].includes(row.state) && Date.parse(row.expires_at) < Date.now()) { row.state = args[0]; row.expires_at = args[1]; row.payload = args[2]; }
      if (sql.includes("state = 'authorized', payload")) {
        if (row.state !== 'pending') return { meta: { changes: 0 } };
        row.state = 'authorized'; row.payload = args[0];
      }
      if (sql.includes("state = 'verified'")) row.state = 'verified';
      if (sql.includes("state = 'submitting'")) {
        if (row.state !== 'authorized') return { meta: { changes: 0 } };
        row.state = 'submitting';
      }
      if (sql.includes("state = 'created'")) { row.state = 'created'; row.expense_id = args[0]; }
      if (sql.includes("state = 'rejected'")) row.state = 'rejected';
      return { meta: { changes: 1 } };
    },
    async first() { return row && (sql.includes('invoice_key') || (args[0] === row.id && args[1] === row.user_id)) ? { ...row } : null; },
  }; } }; } };
  const expense = { id: 'expense-123', title: input.title, description: `${input.description}\n${expenseMarker(input)}`, total: input.total, date: '2026-10-22T12:00:00Z' };
  const jobber = {
    graphqlRequest: vi.fn(async (query: string): Promise<any> => query.includes('Duplicate') ? { expenses: { nodes: [], pageInfo: { hasNextPage: false } } } : { expense }),
    graphqlMutation: vi.fn(async (query: string, _vars?: Record<string, unknown>): Promise<any> => query.includes('AssistantExpenseReceipt') ? ({ expenseEdit: { expense, userErrors: [] } }) : ({ expenseCreate: { expense, userErrors: [] } })),
  };
  return { service: new AssistantExpenseCreate(db as never, jobber), jobber, db, expire() { row.expires_at = '2000-01-01'; } };
}
describe('authorized invoice expenses', () => {
  it('requires separate authorization and refuses a different user', async () => {
    const { service, jobber } = setup();
    expect((await service.create('u', crypto.randomUUID())).outcome).toBe('unauthorized');
    const a = await service.authorize('u', input);
    expect((await service.create('other', a.authorizationId)).outcome).toBe('unauthorized');
    expect(jobber.graphqlMutation).not.toHaveBeenCalled();
    expect(await callAssistantTool(new OpsAssistantRead({ graphqlRequest: vi.fn() }, {} as never), 'u', 'create_expense_from_invoice', { authorizationId: a.authorizationId })).toMatchObject({ outcome: 'unauthorized' });
  });
  it('submits the receipt, verifies the record, and does not repeat the mutation', async () => {
    const { service, jobber } = setup();
    const a = await service.authorize('u', input);
    const result = await service.create('u', a.authorizationId);
    expect(result).toMatchObject({ outcome: 'created', receiptSubmitted: true, receiptReadbackAvailable: false });
    expect(jobber.graphqlMutation).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ input: expect.objectContaining({ receiptUrl: input.receiptUrl }) }));
    expect(JSON.stringify(result)).not.toContain('private-test-token');
    expect((await service.create('u', a.authorizationId)).outcome).toBe('already_recorded');
    expect(jobber.graphqlMutation).toHaveBeenCalledTimes(1);
  });
  it('blocks duplicate invoices and incomplete duplicate searches', async () => {
    const { service, jobber } = setup();
    const a = await service.authorize('u', input);
    jobber.graphqlRequest.mockResolvedValue({ expenses: { nodes: [], pageInfo: { hasNextPage: true } } });
    expect((await service.create('u', a.authorizationId)).outcome).toBe('review_required');
    expect(jobber.graphqlMutation).not.toHaveBeenCalled();
  });
  it('does not rearm a timeout or let authorization details be replaced', async () => {
    const { service, jobber } = setup();
    const a = await service.authorize('u', input);
    jobber.graphqlMutation.mockRejectedValue(new Error('timeout'));
    expect((await service.create('u', a.authorizationId)).outcome).toBe('unknown');
    expect((await service.authorize('u', { ...input, total: 100 })).outcome).toBe('conflict');
    expect((await service.create('u', a.authorizationId)).outcome).toBe('review_required');
    expect(jobber.graphqlMutation).toHaveBeenCalledTimes(1);
  });
  it('preserves a known created ID when verification fails', async () => {
    const { service, jobber } = setup();
    const a = await service.authorize('u', input);
    jobber.graphqlRequest.mockResolvedValueOnce({ expenses: { nodes: [], pageInfo: { hasNextPage: false } } }).mockRejectedValueOnce(new Error('network'));
    expect(await service.create('u', a.authorizationId)).toMatchObject({ outcome: 'created_unverified', expenseId: 'expense-123' });
    expect((await service.create('u', a.authorizationId)).outcome).toBe('created_unverified');
    expect(jobber.graphqlMutation).toHaveBeenCalledTimes(1);
  });
  it('allows only one mutation for simultaneous calls', async () => {
    const { service, jobber } = setup();
    const a = await service.authorize('u', input);
    const results = await Promise.all([service.create('u', a.authorizationId), service.create('u', a.authorizationId)]);
    expect(results.map(x => x.outcome).sort()).toEqual(['created', 'review_required']);
    expect(jobber.graphqlMutation).toHaveBeenCalledTimes(1);
  });
  it('the real mutation transport never retries a network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection lost'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new JobberIntegration({ log: vi.fn() } as never, { clientId: 'test', clientSecret: 'test', accessToken: 'test' });
      await expect(client.graphqlMutation('mutation Test { expenseCreate { expense { id } } }')).rejects.toThrow('connection lost');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it('refreshes once only after a definitive HTTP 401', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('expired', { status: 401 })).mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'new-token', refresh_token: 'rotated' }))).mockResolvedValueOnce(new Response(JSON.stringify({ data: { ok: true } })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new JobberIntegration({ log: vi.fn() } as never, { clientId: 'test', clientSecret: 'test', accessToken: 'expired', refreshToken: 'refresh-token' });
      expect(await client.graphqlMutation('mutation Test { x }')).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[1][0]).toContain('oauth/token');
    } finally { vi.unstubAllGlobals(); }
  });
  it('prepares a review without creating an expense, then submits after approval', async () => {
    const { service, jobber } = setup();
    const review = await service.prepare('u', input, 'https://cotiza.example');
    expect(review.outcome).toBe('pending');
    expect(review.reviewUrl).toContain('/expenses/review/');
    expect(jobber.graphqlMutation).not.toHaveBeenCalled();
    expect(await service.create('u', review.authorizationId)).toMatchObject({ outcome: 'review_required' });
    expect(await service.approve('u', review.authorizationId!)).toMatchObject({ outcome: 'created' });
  });
  it('blocks an actual duplicate expense', async () => {
    const { service, jobber } = setup();
    const a = await service.authorize('u', input);
    jobber.graphqlRequest.mockResolvedValue({ expenses: { nodes: [{ id: 'existing', title: input.title, description: expenseMarker(input), total: input.total, date: input.date }], pageInfo: { hasNextPage: false } } });
    expect((await service.create('u', a.authorizationId)).outcome).toBe('review_required');
    expect(jobber.graphqlMutation).not.toHaveBeenCalled();
  });
  it('renews only expired entries that have never been submitted', async () => {
    const { service, expire } = setup();
    const a = await service.authorize('u', input); expire();
    const renewed = await service.prepare('u', { ...input, total: 200 }, 'https://cotiza.example');
    expect(renewed.outcome).toBe('pending');
    expect(renewed.authorizationId).toBe(a.authorizationId);
    expect(Date.parse(renewed.expiresAt!)).toBeGreaterThan(Date.now());
  });
  it('requires replacement approval and edits only the receipt on an existing expense', async () => {
    const { service, jobber } = setup();
    const review = await service.prepare('u', { ...input, operation: 'attach', targetExpenseId: 'expense-123' }, 'https://cotiza.example');
    expect((await service.approve('u', review.authorizationId!, false)).outcome).toBe('invalid_request');
    expect(jobber.graphqlMutation).not.toHaveBeenCalled();
    expect((await service.approve('u', review.authorizationId!, true)).outcome).toBe('receipt_submitted');
    expect(jobber.graphqlMutation).toHaveBeenCalledWith(expect.stringContaining('expenseEdit'), { id: 'expense-123', input: { receiptUrl: input.receiptUrl } });
  });
  it('passes the approved job, category and reimbursement IDs', async () => {
    const { service, jobber } = setup();
    const a = await service.authorize('u', { ...input, linkedJobId: 'job123', accountingCodeId: 'code123', reimbursableToId: 'user123' });
    await service.create('u', a.authorizationId);
    expect(jobber.graphqlMutation).toHaveBeenCalledWith(expect.any(String), { input: expect.objectContaining({ linkedJobId: 'job123', accountingCodeId: 'code123', reimbursableToId: 'user123' }) });
  });
  it('does not call a mismatched title/date verified', async () => {
    const { service, jobber } = setup();
    const a = await service.authorize('u', input);
    jobber.graphqlRequest.mockResolvedValueOnce({ expenses: { nodes: [], pageInfo: { hasNextPage: false } } }).mockResolvedValueOnce({ expense: { id: 'expense-123', title: 'Wrong', date: '2020-01-01', total: input.total, description: expenseMarker(input) } });
    expect((await service.create('u', a.authorizationId)).outcome).toBe('created_unverified');
  });
  it('rejects expired authorization before calling Jobber', async () => {
    const { service, jobber, expire } = setup();
    const a = await service.authorize('u', input); expire();
    expect((await service.create('u', a.authorizationId)).outcome).toBe('expired');
    expect(jobber.graphqlRequest).not.toHaveBeenCalled();
  });
  it('rejects internal URLs, credentials, invalid amounts and impossible dates', () => {
    for (const receiptUrl of ['http://squareup.com/invoices/attachments/download/pdf/invoice?token=x', 'https://127.0.0.1/a', 'https://user:pass@squareup.com/invoices/attachments/download/pdf/invoice?token=x']) expect(() => validateExpenseInvoice({ ...input, receiptUrl })).toThrow();
    expect(() => validateExpenseInvoice({ ...input, date: '2026-02-30' })).toThrow();
    expect(() => validateExpenseInvoice({ ...input, total: 1.123 })).toThrow();
  });
});
