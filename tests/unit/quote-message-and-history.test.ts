import { describe, expect, it, vi } from 'vitest';
import {
  messageVersion,
  parseMessageArgs,
  QUOTE_MESSAGE_MUTATION,
  QUOTE_MESSAGE_QUERY,
  updateQuoteMessage,
} from '../../worker/src/services/jobber-quote-message.js';
import { QuoteEditArgsError } from '../../worker/src/services/jobber-quote-edits.js';
import { CLIENT_HISTORY_QUERIES, summarizeClientHistory } from '../../worker/src/services/ops-assistant-client-history.js';
import { OpsAssistantRead, TOOL_DEFINITIONS } from '../../worker/src/services/ops-assistant-read.js';
import { CallBudget, type AssistantDirectory, type AssistantPrincipal } from '../../worker/src/services/assistant-access.js';
import { handleMcpPost, readMcpJsonBody } from '../../worker/src/routes/ops-assistant.js';
import { createMockD1 } from './helpers/mock-d1.js';

const QUOTE_ID = 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=';
const OLD = 'All work will be completed by licensed contractors.\r\nEstimate includes city permit and coordination fee.\n';
const NEW = 'All work will be completed by licensed contractors.\nPricing assumes condo association approval.';

function fakeJobber(opts: { status?: string; reject?: boolean; ignoreWrite?: boolean } = {}) {
  let message = OLD;
  const graphqlRequest = vi.fn(async (query: string, vars?: Record<string, unknown>) => {
    if (query === QUOTE_MESSAGE_QUERY) return { quote: { id: QUOTE_ID, quoteNumber: '717', quoteStatus: opts.status ?? 'draft', message } };
    if (query === QUOTE_MESSAGE_MUTATION) {
      if (opts.reject) return { quoteEdit: { userErrors: [{ message: 'Message is invalid' }] } };
      if (!opts.ignoreWrite) message = String((vars?.attributes as { message: string }).message);
      return { quoteEdit: { quote: { id: QUOTE_ID }, userErrors: [] } };
    }
    throw new Error(`unexpected query ${query.slice(0, 40)}`);
  });
  return { graphqlRequest, get message() { return message; } };
}

describe('update_quote_message', () => {
  it('ignores line-ending and trailing-space differences in the version', async () => {
    expect(await messageVersion('draft', OLD)).toBe(await messageVersion('draft', OLD.replace(/\r\n/g, '\n').trim()));
    expect(await messageVersion('draft', OLD)).not.toBe(await messageVersion('sent', OLD));
  });

  it('rejects bad arguments', () => {
    expect(() => parseMessageArgs({ quoteId: QUOTE_ID, message: NEW })).toThrow(QuoteEditArgsError);
    expect(() => parseMessageArgs({ quoteId: QUOTE_ID, messageVersion: '0123456789abcdef', message: '  ' })).toThrow(QuoteEditArgsError);
    expect(() => parseMessageArgs({ quoteId: QUOTE_ID, messageVersion: '0123456789abcdef', message: NEW, title: 'x' })).toThrow(QuoteEditArgsError);
  });

  it('saves the message on a draft and verifies the reread', async () => {
    const jobber = fakeJobber();
    const result = await updateQuoteMessage(jobber, { quoteId: QUOTE_ID, messageVersion: await messageVersion('draft', OLD), message: NEW });
    expect(result).toMatchObject({ outcome: 'ok', changed: true, verified: true, quoteNumber: '717' });
    expect(jobber.message).toBe(NEW);
    const sent = jobber.graphqlRequest.mock.calls.find(([q]) => q === QUOTE_MESSAGE_MUTATION)?.[1];
    expect(sent).toEqual({ quoteId: QUOTE_ID, attributes: { message: NEW } });
  });

  it('refuses a stale version without writing', async () => {
    const jobber = fakeJobber();
    const result = await updateQuoteMessage(jobber, { quoteId: QUOTE_ID, messageVersion: '0123456789abcdef', message: NEW });
    expect(result).toMatchObject({ outcome: 'conflict', changed: false });
    expect(jobber.graphqlRequest.mock.calls.some(([q]) => q === QUOTE_MESSAGE_MUTATION)).toBe(false);
  });

  it('refuses a quote that is not a draft', async () => {
    const jobber = fakeJobber({ status: 'awaiting_response' });
    const result = await updateQuoteMessage(jobber, { quoteId: QUOTE_ID, messageVersion: await messageVersion('awaiting_response', OLD), message: NEW });
    expect(result).toMatchObject({ outcome: 'refused', changed: false });
    expect(jobber.graphqlRequest.mock.calls.some(([q]) => q === QUOTE_MESSAGE_MUTATION)).toBe(false);
  });

  it('reports a Jobber rejection or a write that did not stick as failed', async () => {
    const rejected = await updateQuoteMessage(fakeJobber({ reject: true }), { quoteId: QUOTE_ID, messageVersion: await messageVersion('draft', OLD), message: NEW });
    expect(rejected).toMatchObject({ outcome: 'failed', verified: false, changed: false });
    const ignored = await updateQuoteMessage(fakeJobber({ ignoreWrite: true }), { quoteId: QUOTE_ID, messageVersion: await messageVersion('draft', OLD), message: NEW });
    expect(ignored).toMatchObject({ outcome: 'failed', verified: false });
  });
});

describe('read_client_history', () => {
  const CLIENT = 'Z2lkOi8vSm9iYmVyL0NsaWVudC8x';
  const jobs = [{ id: 'j1', jobNumber: 120, title: 'Bathroom Remodel', jobStatus: 'archived', completedAt: '2025-06-01T12:00:00Z', quote: { id: 'oldQuote', quoteNumber: '400' } }];
  const invoices = [{ id: 'i1', invoiceNumber: '88', invoiceStatus: 'paid', issuedDate: '2025-06-02' }];
  const quotes = [{ id: 'oldQuote', quoteNumber: '400', title: 'Bathroom Remodel', quoteStatus: 'converted' }, { id: QUOTE_ID, quoteNumber: '717', title: 'Condo Maintenance', quoteStatus: 'draft' }];

  function jobberFor(sections: Partial<Record<'jobs' | 'invoices' | 'quotes' | 'requests', unknown[] | Error>>) {
    return {
      graphqlRequest: vi.fn(async (query: string) => {
        if (query === CLIENT_HISTORY_QUERIES.client) return { client: { id: CLIENT, firstName: 'Emma', lastName: 'C', createdAt: '2024-05-01T00:00:00Z' } };
        for (const key of ['jobs', 'invoices', 'quotes', 'requests'] as const) {
          if (query === CLIENT_HISTORY_QUERIES[key]) {
            const value = sections[key] ?? [];
            if (value instanceof Error) throw value;
            return { client: { id: CLIENT, [key]: { nodes: value, pageInfo: { hasNextPage: false } } } };
          }
        }
        throw new Error('unexpected query');
      }),
    };
  }

  it('is listed as a read tool', () => {
    expect(TOOL_DEFINITIONS.some((t) => t.name === 'read_client_history')).toBe(true);
  });

  it('marks a client with completed jobs and invoices as a past customer', async () => {
    const read = new OpsAssistantRead(jobberFor({ jobs, invoices, quotes }), createMockD1() as never);
    const result = await read.readClientHistory('u', { clientId: CLIENT, excludeQuoteId: QUOTE_ID }) as Record<string, any>;
    expect(result.outcome).toBe('ok');
    expect(result.complete).toBe(true);
    expect(result.history.pastCustomer).toBe(true);
    expect(result.history.counts).toEqual({ jobs: 1, completedJobs: 1, invoices: 1, approvedOrConvertedQuotes: 1 });
    expect(result.history.evidence[0]).toContain('Job #120');
  });

  it('does not count the quote under review as past work', () => {
    const ok = (items: Array<Record<string, unknown>>) => ({ outcome: 'ok' as const, items, truncated: false });
    const summary = summarizeClientHistory({
      jobs: ok([]), invoices: ok([]), requests: ok([]),
      quotes: ok([{ id: QUOTE_ID, quoteNumber: '717', quoteStatus: 'approved' }]),
    }, QUOTE_ID);
    expect(summary.pastCustomer).toBe(false);
  });

  it('says unknown, not "no history", when a section fails', async () => {
    const read = new OpsAssistantRead(jobberFor({ jobs: new Error('Access denied'), quotes: [quotes[1]] }), createMockD1() as never);
    const result = await read.readClientHistory('u', { clientId: CLIENT, excludeQuoteId: QUOTE_ID }) as Record<string, any>;
    expect(result.complete).toBe(false);
    expect(result.failedSections).toEqual(['jobs']);
    expect(result.history.pastCustomer).toBe('unknown');
    expect(result.sections.jobs.failure).toContain('not an empty list');
  });

  it('still proves past work when another section failed', async () => {
    const read = new OpsAssistantRead(jobberFor({ jobs, invoices: new Error('denied') }), createMockD1() as never);
    const result = await read.readClientHistory('u', { clientId: CLIENT }) as Record<string, any>;
    expect(result.history.pastCustomer).toBe(true);
  });
});

describe('MCP listing', () => {
  const principal = (scope: string): AssistantPrincipal => ({ tokenId: 't', userId: 'u', clientId: 'claude', resource: 'http://127.0.0.1:8787/mcp', scope });
  const directory = (p: AssistantPrincipal): AssistantDirectory => ({
    authenticateAccessToken: async () => p, authenticateRefreshToken: async () => null,
    mintToken: async () => ({ id: 'n', token: 'ctz', expiresAt: '2099-01-01T00:00:00Z' }), revoke: async () => true, revokeByHash: async () => true,
    list: async () => [], findClient: async () => null, saveClient: async () => undefined, saveTx: async () => undefined,
    loadTx: async () => null, saveCode: async () => undefined, consumeCode: async () => null,
  });
  const mcp = (method: string, params?: unknown) => new Request('http://127.0.0.1:8787/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer ctz', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const deps = (p: AssistantPrincipal, jobber = fakeJobber()) => ({
    directory: directory(p), read: new OpsAssistantRead({ graphqlRequest: vi.fn() }, createMockD1() as never),
    db: createMockD1() as never, budget: new CallBudget(), jobber,
  });
  const names = async (scope: string) => (readMcpJsonBody(await (await handleMcpPost(mcp('tools/list'), deps(principal(scope)))).text()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);

  it('lists update_quote_message only with quote:write, and read_client_history always', async () => {
    expect(await names('ops:read')).not.toContain('update_quote_message');
    expect(await names('ops:read')).toContain('read_client_history');
    expect(await names('ops:read quote:write')).toContain('update_quote_message');
  });

  it('refuses update_quote_message without quote:write and runs it with', async () => {
    const jobber = fakeJobber();
    const args = { quoteId: QUOTE_ID, messageVersion: await messageVersion('draft', OLD), message: NEW };
    const denied = readMcpJsonBody(await (await handleMcpPost(mcp('tools/call', { name: 'update_quote_message', arguments: args }), deps(principal('ops:read'), jobber))).text()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(denied.result.content[0].text)).toMatchObject({ outcome: 'forbidden' });
    expect(jobber.graphqlRequest).not.toHaveBeenCalled();
    const ran = readMcpJsonBody(await (await handleMcpPost(mcp('tools/call', { name: 'update_quote_message', arguments: args }), deps(principal('ops:read quote:write'), jobber))).text()) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(ran.result.isError).toBe(false);
    expect(JSON.parse(ran.result.content[0].text)).toMatchObject({ outcome: 'ok', verified: true });
  });
});

describe('read_client_history edge cases', () => {
  const ok = (items: Array<Record<string, unknown>>, truncated = false) => ({ outcome: 'ok' as const, items, truncated });

  it('ignores draft invoices', () => {
    const summary = summarizeClientHistory({ jobs: ok([]), quotes: ok([]), requests: ok([]), invoices: ok([{ invoiceNumber: '9', invoiceStatus: 'draft' }]) });
    expect(summary.pastCustomer).toBe(false);
  });

  it('says unknown when a section was cut off before anything was found', () => {
    const summary = summarizeClientHistory({ jobs: ok([]), invoices: ok([]), requests: ok([]), quotes: ok([{ id: 'q1', quoteStatus: 'draft' }], true) });
    expect(summary.pastCustomer).toBe('unknown');
  });

  it('treats a section with no list as failed, not empty', async () => {
    const CLIENT = 'Z2lkOi8vSm9iYmVyL0NsaWVudC8x';
    const jobber = { graphqlRequest: vi.fn(async (query: string) => {
      if (query === CLIENT_HISTORY_QUERIES.client) return { client: { id: CLIENT, firstName: 'A', lastName: 'B' } };
      if (query === CLIENT_HISTORY_QUERIES.jobs) return { client: { id: CLIENT } };
      const key = (['invoices', 'quotes', 'requests'] as const).find((k) => query === CLIENT_HISTORY_QUERIES[k])!;
      return { client: { id: CLIENT, [key]: { nodes: [], pageInfo: { hasNextPage: false } } } };
    }) };
    const result = await new OpsAssistantRead(jobber, createMockD1() as never).readClientHistory('u', { clientId: CLIENT }) as Record<string, any>;
    expect(result.failedSections).toEqual(['jobs']);
    expect(result.history.pastCustomer).toBe('unknown');
  });
});
