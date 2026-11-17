import { describe, expect, it, vi } from 'vitest';
import { handleMcpPost, readMcpJsonBody } from '../../worker/src/routes/ops-assistant.js';
import assistantReceiptRoutes, { sweepExpiredReceipts } from '../../worker/src/routes/assistant-receipt.js';
import { CallBudget } from '../../worker/src/services/assistant-access.js';
import { OpsAssistantRead, callExpenseWriteTool } from '../../worker/src/services/ops-assistant-read.js';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';
import { createMockR2 } from './helpers/mock-r2.js';

const RESOURCE = 'http://127.0.0.1:8787/mcp';

function mcp(method: string, params?: unknown) {
  return new Request(RESOURCE, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ctz_test',
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

function deps(scope: string, email: string) {
  const db = createMockD1();
  configurePrepareResults(db, [{ first: { email } }, { first: { email } }]);
  const graphqlRequest = vi.fn()
    .mockResolvedValueOnce({ expense: { id: 'e', updatedAt: '2026-10-29T16:00:00Z' } })
    .mockResolvedValueOnce({ expenseEdit: { expense: { id: 'e' }, userErrors: [] } })
    .mockResolvedValueOnce({ expense: { id: 'e', updatedAt: '2026-10-29T17:00:00Z' } });
  const directory = {
    authenticateAccessToken: async () => ({
      tokenId: 'tok-1',
      userId: 'user-a',
      clientId: 'cotiza-session',
      resource: RESOURCE,
      scope,
    }),
  };
  return {
    directory: directory as never,
    read: new OpsAssistantRead({ graphqlRequest } as never, db as never),
    db: db as never,
    budget: new CallBudget(),
    bucket: createMockR2(),
    jobber: { graphqlRequest } as never,
  };
}

const args = { expenseId: 'exp-1', pdfBase64: btoa('%PDF-1.4 test') };

describe('attach_expense_receipt connector wiring', () => {
  it('hides the tool without the expense-write scope', async () => {
    const response = await handleMcpPost(mcp('tools/list'), deps('ops:read review:write', 'office@chicago-reno.com'));
    const body = readMcpJsonBody(await response.text()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).not.toContain('attach_expense_receipt');
  });

  it('refuses a non-office expense-write token without calling Jobber', async () => {
    const d = deps('ops:read expense:write', 'ben@chicago-reno.com');
    const response = await handleMcpPost(mcp('tools/call', { name: 'attach_expense_receipt', arguments: args }), d);
    const body = readMcpJsonBody(await response.text()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    const payload = JSON.parse(body.result.content[0].text) as { outcome: string; failure: { code: string } };
    expect(body.result.isError).toBe(true);
    expect(payload.failure.code).toBe('forbidden_user');
    expect((d.jobber as { graphqlRequest: { mock: { calls: unknown[] } } }).graphqlRequest.mock.calls).toHaveLength(0);
  });

  it('runs the office call and passes a receipt URL that serves the stored PDF', async () => {
    const d = deps('ops:read expense:write', 'office@chicago-reno.com');
    const response = await handleMcpPost(mcp('tools/call', { name: 'attach_expense_receipt', arguments: args }), d);
    const body = readMcpJsonBody(await response.text()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    const payload = JSON.parse(body.result.content[0].text) as { outcome: string };
    expect(body.result.isError).toBe(false);
    expect(payload.outcome).toBe('ok');
    const receiptUrl = (d.jobber as { graphqlRequest: { mock: { calls: Array<[unknown, { input: { receiptUrl: string } }]> } } }).graphqlRequest.mock.calls[1][1].input.receiptUrl;
    expect(receiptUrl).toMatch(/\/assistant-receipt\/\d{13}-[A-Za-z0-9_-]{43}\.pdf$/);
    const name = receiptUrl.slice(receiptUrl.lastIndexOf('/') + 1);
    expect(d.bucket._store.has(`assistant-receipts/${name}`)).toBe(true);
    const served = await assistantReceiptRoutes.request('/assistant-receipt/' + name, {}, { R2_BUCKET: d.bucket } as never);
    expect(served.status).toBe(200);
    // Plain byte values: toEqual on typed arrays fails across jsdom/Node constructors with identical bytes.
    expect(Array.from(new Uint8Array(await served.arrayBuffer()))).toEqual(Array.from(new TextEncoder().encode('%PDF-1.4 test')));
  });

  it('accepts a 6 MB body for attach_expense_receipt only', async () => {
    const d = deps('ops:read expense:write', 'office@chicago-reno.com');
    const big = { expenseId: 'exp-1', pdfBase64: btoa('%PDF-1.4 ' + 'a'.repeat(4_500_000)) };
    const response = await handleMcpPost(mcp('tools/call', { name: 'attach_expense_receipt', arguments: big }), d);
    const body = readMcpJsonBody(await response.text()) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(body.result.content[0].text) as { outcome: string };
    expect(response.status).toBe(200);
    expect(payload.outcome).toBe('ok');
  });

  it('refuses a 6 MB body for any other tool', async () => {
    const d = deps('ops:read expense:write', 'office@chicago-reno.com');
    const response = await handleMcpPost(mcp('tools/call', { name: 'find_quotes', arguments: { pad: 'a'.repeat(6_000_000) } }), d);
    expect(response.status).toBe(413);
  });
});

describe('assistant-receipt route', () => {
  const token = 'a'.repeat(43);

  it('serves a fresh stored PDF without listing the bucket', async () => {
    const bucket = createMockR2();
    const name = `${Date.now() + 60_000}-${token}.pdf`;
    await bucket.put(`assistant-receipts/${name}`, new TextEncoder().encode('%PDF-1.4 test'));
    const response = await assistantReceiptRoutes.request('/assistant-receipt/' + name, {}, { R2_BUCKET: bucket } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(bucket.list).not.toHaveBeenCalled();
  });

  it('404s an expired or malformed name without reading the bucket', async () => {
    const bucket = createMockR2();
    const expiredName = `${Date.now() - 60_000}-${token}.pdf`;
    await bucket.put(`assistant-receipts/${expiredName}`, new TextEncoder().encode('%PDF-1.4 stale'));
    const expired = await assistantReceiptRoutes.request(`/assistant-receipt/${expiredName}`, {}, { R2_BUCKET: bucket } as never);
    const bad = await assistantReceiptRoutes.request('/assistant-receipt/bad.pdf', {}, { R2_BUCKET: bucket } as never);
    expect(expired.status).toBe(404);
    expect(bad.status).toBe(404);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it('sweepExpiredReceipts deletes only receipts past their expiry prefix', async () => {
    const bucket = createMockR2();
    const expiredName = `${Date.now() - 60_000}-${token}.pdf`;
    const freshName = `${Date.now() + 60_000}-${token}.pdf`;
    await bucket.put(`assistant-receipts/${expiredName}`, new TextEncoder().encode('%PDF-1.4 stale'));
    await bucket.put(`assistant-receipts/${freshName}`, new TextEncoder().encode('%PDF-1.4 fresh'));
    await sweepExpiredReceipts(bucket as never);
    expect(bucket._store.has(`assistant-receipts/${expiredName}`)).toBe(false);
    expect(bucket._store.has(`assistant-receipts/${freshName}`)).toBe(true);
  });
});

describe('attach_expense_receipt via receiptUrl', () => {
  const squareLink = 'https://squareup.com/receipt/preview/abc123';
  const pdfResponse = () => new Response(new TextEncoder().encode('%PDF-1.4 test'));

  it('downloads a Square link and attaches the PDF', async () => {
    const before = { id: 'exp-1', title: 'x', description: null, date: '2026-10-29', total: 10, updatedAt: '2026-10-29T16:00:00Z' };
    const graphqlRequest = vi.fn()
      .mockResolvedValueOnce({ expense: before })
      .mockResolvedValueOnce({ expenseEdit: { expense: { id: 'exp-1' }, userErrors: [] } })
      .mockResolvedValueOnce({ expense: before });
    const bucket = createMockR2();
    const fetcher = vi.fn().mockResolvedValue(pdfResponse());
    const result = await callExpenseWriteTool({ graphqlRequest } as never, { bucket, origin: 'https://worker.test' } as never, 'attach_expense_receipt', { expenseId: 'exp-1', receiptUrl: squareLink }, fetcher);
    expect(result).toMatchObject({ outcome: 'ok', changed: true });
    expect(fetcher).toHaveBeenCalledWith(squareLink);
    const stored = [...bucket._store.values()][0].body;
    expect(Array.from(new Uint8Array(stored))).toEqual(Array.from(new TextEncoder().encode('%PDF-1.4 test')));
  });

  it('rejects an over-long Square link before fetching', async () => {
    const graphqlRequest = vi.fn();
    const bucket = createMockR2();
    const fetcher = vi.fn().mockResolvedValue(pdfResponse());
    const longLink = 'https://squareup.com/receipt/preview/'.padEnd(2049, 'a');
    await expect(callExpenseWriteTool({ graphqlRequest } as never, { bucket, origin: 'https://worker.test' } as never, 'attach_expense_receipt', { expenseId: 'exp-1', receiptUrl: longLink }, fetcher)).rejects.toThrow(/too long/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('refuses a non-Square host before R2 or Jobber', async () => {
    const graphqlRequest = vi.fn();
    const bucket = createMockR2();
    const fetcher = vi.fn().mockResolvedValue(pdfResponse());
    await expect(callExpenseWriteTool({ graphqlRequest } as never, { bucket, origin: 'https://worker.test' } as never, 'attach_expense_receipt', { expenseId: 'exp-1', receiptUrl: 'https://evil.example.com/x.pdf' }, fetcher)).rejects.toThrow(/must be an https link/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
    expect(graphqlRequest).not.toHaveBeenCalled();
  });

  it('refuses a non-PDF download before R2 or Jobber', async () => {
    const graphqlRequest = vi.fn();
    const bucket = createMockR2();
    const fetcher = vi.fn().mockResolvedValue(new Response(new TextEncoder().encode('hello')));
    const result = await callExpenseWriteTool({ graphqlRequest } as never, { bucket, origin: 'https://worker.test' } as never, 'attach_expense_receipt', { expenseId: 'exp-1', receiptUrl: squareLink }, fetcher);
    expect(result).toMatchObject({ outcome: 'refused', changed: false });
    expect(bucket.put).not.toHaveBeenCalled();
    expect(graphqlRequest).not.toHaveBeenCalled();
  });

  it('requires exactly one of pdfBase64 or receiptUrl', async () => {
    const graphqlRequest = vi.fn();
    const bucket = createMockR2();
    const fetcher = vi.fn().mockResolvedValue(pdfResponse());
    const target = { bucket, origin: 'https://worker.test' } as never;
    await expect(callExpenseWriteTool({ graphqlRequest } as never, target, 'attach_expense_receipt', { expenseId: 'exp-1' }, fetcher)).rejects.toThrow(/exactly one of/);
    await expect(callExpenseWriteTool({ graphqlRequest } as never, target, 'attach_expense_receipt', { expenseId: 'exp-1', pdfBase64: btoa('%PDF-1.4 test'), receiptUrl: squareLink }, fetcher)).rejects.toThrow(/exactly one of/);
  });

  it('rejects a sha256 mismatch before R2 or Jobber', async () => {
    const graphqlRequest = vi.fn();
    const bucket = createMockR2();
    const fetcher = vi.fn().mockResolvedValue(pdfResponse());
    await expect(callExpenseWriteTool({ graphqlRequest } as never, { bucket, origin: 'https://worker.test' } as never, 'attach_expense_receipt', { expenseId: 'exp-1', receiptUrl: squareLink, sha256: '0'.repeat(64) }, fetcher)).rejects.toThrow(/does not match/);
    expect(bucket.put).not.toHaveBeenCalled();
    expect(graphqlRequest).not.toHaveBeenCalled();
  });
});
