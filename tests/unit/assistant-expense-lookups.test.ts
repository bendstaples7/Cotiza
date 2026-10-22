import { describe, expect, it, vi } from 'vitest';
import { expenseOptions, findExpenses } from '../../worker/src/services/assistant-expense-lookups.js';
const ref = (name: string, kind = 'OBJECT') => ({ name, kind });
describe('expense lookups', () => {
  it('discovers user display fields and paginates without guessed schema fields', async () => {
    const graphqlRequest = vi.fn(async (query: string, vars?: Record<string, unknown>): Promise<any> => {
      expect(query).not.toMatch(/^mutation/);
      if (query.includes('__schema')) return { __schema: { queryType: { fields: [{ name: 'users', type: ref('UserConnection'), args: [{ name: 'first', type: ref('Int', 'SCALAR') }, { name: 'after', type: ref('String', 'SCALAR') }] }] } } };
      if (vars?.name === 'UserConnection') return { __type: { fields: [{ name: 'nodes', type: ref('User') }, { name: 'pageInfo', type: ref('PageInfo') }] } };
      if (vars?.name === 'User') return { __type: { fields: [{ name: 'id', type: ref('EncodedId', 'SCALAR') }, { name: 'name', type: ref('Name') }] } };
      if (vars?.name === 'Name') return { __type: { fields: [{ name: 'full', type: ref('String', 'SCALAR') }] } };
      expect(query).toContain('name { full }'); expect(vars?.after).toBe('next');
      return { users: { nodes: [{ id: 'user123', name: { full: 'Ben' } }], pageInfo: { hasNextPage: false, endCursor: null } } };
    });
    expect(await expenseOptions({ graphqlRequest }, 'users', 'next')).toMatchObject({ outcome: 'ok', items: [{ id: 'user123' }] });
  });
  it('does not turn unsupported categories or failed expense reads into an empty success', async () => {
    expect(await expenseOptions({ graphqlRequest: vi.fn().mockResolvedValue({ __schema: { queryType: { fields: [] } } }) }, 'categories')).toMatchObject({ outcome: 'unavailable' });
    await expect(findExpenses({ graphqlRequest: vi.fn().mockResolvedValue({ expenses: null }) }, 'invoice')).rejects.toThrow('not an empty');
  });
});
