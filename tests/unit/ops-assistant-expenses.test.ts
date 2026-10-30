import { describe, expect, it, vi } from 'vitest';
import { OpsAssistantRead, TOOL_DEFINITIONS, callAssistantTool } from '../../worker/src/services/ops-assistant-read.js';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';

function expense(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exp-1',
    title: 'Garlien Weekly 20Four7 VA',
    description: 'Invoice #5511-R-0024',
    date: '2026-10-29T15:00:00Z',
    total: 216.2,
    createdAt: '2026-10-29T16:00:00Z',
    enteredBy: { id: 'u1', name: { full: 'Ben Staples' } },
    paidBy: null,
    reimbursableTo: null,
    linkedJob: null,
    ...overrides,
  };
}

function office(email = 'office@chicago-reno.com') {
  const db = createMockD1();
  configurePrepareResults(db, [{ first: { email } }]);
  return db as never;
}

function page(nodes: unknown[], pageInfo = { hasNextPage: false, endCursor: null as string | null }) {
  return { expenses: { edges: nodes.map((node) => ({ node })), pageInfo } };
}

describe('find_expenses', () => {
  it('is registered as read-only', () => {
    const def = TOOL_DEFINITIONS.find((t) => t.name === 'find_expenses') as { annotations?: { readOnlyHint?: boolean } } | undefined;
    expect(def?.annotations?.readOnlyHint).toBe(true);
  });

  it('refuses every account except the office one, without calling Jobber', async () => {
    const graphqlRequest = vi.fn();
    const read = new OpsAssistantRead({ graphqlRequest }, office('ivan@chicago-reno.com'));
    const result = await callAssistantTool(read, 'u', 'find_expenses', { searchTerm: '20four7' }) as Record<string, any>;
    expect(result.outcome).toBe('failed');
    expect(result.failure.code).toBe('office_account_required');
    expect(graphqlRequest).not.toHaveBeenCalled();
  });

  it('sends the search and a widened date range, then re-checks Chicago dates', async () => {
    const graphqlRequest = vi.fn().mockResolvedValue(page([
      expense(),
      expense({ id: 'exp-2', date: '2026-10-30T04:00:00Z' }), // Oct 29, 11 PM in Chicago
      expense({ id: 'exp-3', date: '2026-10-30T06:00:00Z' }), // Oct 30, 1 AM in Chicago
    ]));
    const read = new OpsAssistantRead({ graphqlRequest }, office());
    const result = await callAssistantTool(read, 'u', 'find_expenses', { searchTerm: '20four7', onOrAfter: '2026-10-29', onOrBefore: '2026-10-29' }) as Record<string, any>;
    expect(graphqlRequest.mock.calls[0][1]).toEqual({
      first: 10,
      after: null,
      searchTerm: '20four7',
      filter: { date: { after: '2026-10-28T00:00:00.000Z', before: '2026-10-31T00:00:00.000Z' } },
    });
    expect(result.outcome).toBe('ok');
    expect(result.items.map((item: { id: string }) => item.id)).toEqual(['exp-1', 'exp-2']);
    expect(result.items[0]).toMatchObject({
      date: '2026-10-29',
      total: { availability: 'present', value: 216.2 },
      title: { untrusted: true },
      enteredBy: { availability: 'present', value: 'Ben Staples' },
      paidBy: { availability: 'unavailable' },
    });
  });

  it('sends no filter when no dates are given and returns the next cursor', async () => {
    const graphqlRequest = vi.fn().mockResolvedValue(page([expense()], { hasNextPage: true, endCursor: 'abc' }));
    const read = new OpsAssistantRead({ graphqlRequest }, office());
    const result = await callAssistantTool(read, 'u', 'find_expenses', {}) as Record<string, any>;
    expect(graphqlRequest.mock.calls[0][1]).toMatchObject({ searchTerm: null, filter: null });
    expect(result.page.nextCursor).toBe('abc');
  });

  it('reports an empty page as empty, not failed', async () => {
    const read = new OpsAssistantRead({ graphqlRequest: vi.fn().mockResolvedValue(page([])) }, office());
    const result = await callAssistantTool(read, 'u', 'find_expenses', { searchTerm: 'nothing' }) as Record<string, any>;
    expect(result.outcome).toBe('ok');
    expect(result.read.status).toBe('empty');
  });

  it('treats a Jobber failure as failed, not empty', async () => {
    const read = new OpsAssistantRead({ graphqlRequest: vi.fn().mockRejectedValue(new Error('timeout')) }, office());
    const result = await callAssistantTool(read, 'u', 'find_expenses', {}) as Record<string, any>;
    expect(result.outcome).toBe('failed');
    expect(result.read.liveLookupFailed).toBe(true);
  });

  it('rejects bad dates and unknown fields', async () => {
    const read = new OpsAssistantRead({ graphqlRequest: vi.fn() }, office());
    await expect(callAssistantTool(read, 'u', 'find_expenses', { onOrAfter: 'Oct 29' })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(callAssistantTool(read, 'u', 'find_expenses', { query: '{ x }' })).rejects.toThrow(/Unknown field/);
  });
});
