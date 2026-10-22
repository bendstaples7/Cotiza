import { describe, expect, it, vi } from 'vitest';
import { inspectExpenseCapabilities } from '../../worker/src/services/jobber-expense-capabilities.js';
import { callAssistantTool, OpsAssistantRead } from '../../worker/src/services/ops-assistant-read.js';

const ref = (name: string) => ({ kind: 'INPUT_OBJECT', name });
describe('expense capability discovery', () => {
  it('follows discovered expense inputs without executing mutations or returning unrelated fields', async () => {
    const graphqlRequest = vi.fn(async (query: string, vars?: Record<string, unknown>): Promise<any> => {
      expect(query.trim()).toMatch(/^query /);
      if (!vars) return { __schema: {
        queryType: { fields: [{ name: 'expenses', type: ref('ExpenseConnection') }] },
        mutationType: { fields: [
          { name: 'expenseCreate', type: ref('ExpensePayload'), args: [{ name: 'input', type: ref('ExpenseInput') }] },
          { name: 'clientDelete', type: ref('Client') },
        ] },
      } };
      if (vars.name === 'ExpenseInput') return { __type: {
        name: 'ExpenseInput', kind: 'INPUT_OBJECT', inputFields: [{ name: 'receipt', type: ref('ReceiptInput') }],
      } };
      return { __type: null };
    });
    const result = await inspectExpenseCapabilities({ graphqlRequest });
    expect(result.mutations.map(m => m.name)).toEqual(['expenseCreate']);
    expect(graphqlRequest.mock.calls.some(([, v]) => v?.name === 'ReceiptInput')).toBe(true);
    expect(result.assistantWritesEnabled).toBe(false);
  });
  it('reaches creation and receipt inputs even when queries expose many pagination types', async () => {
    const seen: string[] = [];
    const graphqlRequest = vi.fn(async (_query: string, vars?: Record<string, unknown>): Promise<any> => {
      if (!vars) return { __schema: {
        queryType: { fields: Array.from({ length: 20 }, (_, i) => ({ name: `expenseQuery${i}`, type: ref(`Connection${i}`) })) },
        mutationType: { fields: [{ name: 'expenseCreate', type: ref('ExpenseCreatePayload'), args: [{ name: 'input', type: ref('ExpenseCreateInput') }] }] },
      } };
      seen.push(String(vars.name));
      if (vars.name === 'ExpenseCreateInput') return { __type: {
        name: 'ExpenseCreateInput', kind: 'INPUT_OBJECT', inputFields: [{ name: 'receipt', type: ref('ReceiptInput') }],
      } };
      return { __type: null };
    });
    await inspectExpenseCapabilities({ graphqlRequest });
    expect(seen.slice(0, 2)).toEqual(['ExpenseCreateInput', 'ReceiptInput']);
    expect(seen).not.toContain('Connection0');
  });
  it('does not mistake denied introspection for an empty capability list', async () => {
    await expect(inspectExpenseCapabilities({ graphqlRequest: vi.fn().mockResolvedValue({}) })).rejects.toThrow('unavailable');
    const read = new OpsAssistantRead({ graphqlRequest: vi.fn().mockRejectedValue(new Error('denied')) }, {} as never);
    expect((await callAssistantTool(read, 'u', 'inspect_expense_capabilities', {}))?.outcome).toBe('failed');
  });
  it('rejects caller-supplied GraphQL before using the connection', async () => {
    const graphqlRequest = vi.fn();
    const read = new OpsAssistantRead({ graphqlRequest }, {} as never);
    await expect(callAssistantTool(read, 'u', 'inspect_expense_capabilities', { query: 'mutation { x }' })).rejects.toThrow();
    expect(graphqlRequest).not.toHaveBeenCalled();
  });
  it('caps recursive schema discovery', async () => {
    let calls = 0;
    const graphqlRequest = vi.fn(async (_query: string, vars?: Record<string, unknown>): Promise<any> => {
      calls++;
      if (!vars) return { __schema: { queryType: { fields: [] }, mutationType: { fields: [] } } };
      return { __type: { name: vars.name, kind: 'INPUT_OBJECT', inputFields: [{ name: 'next', type: ref(`Child${calls}`) }] } };
    });
    const result = await inspectExpenseCapabilities({ graphqlRequest });
    expect(calls).toBe(13);
    expect(result.discoveryComplete).toBe(false);
  });
});
