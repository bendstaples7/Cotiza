import { describe, expect, it } from 'vitest';
import { loadOpenLeads, mergeQueueWithOpenLeads, type LeadNode } from '../../worker/src/services/open-leads.js';
import type { ManualRequestListRow } from '../../worker/src/services/manual-request-service.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');

function row(overrides: Partial<ManualRequestListRow>): ManualRequestListRow {
  return {
    id: 'r', userId: 'u', customerName: 'Unknown', customerPhone: null, customerEmail: null, customerAddress: null,
    serviceDescription: '', mediaItemIds: [], requestSource: 'jobber', createdAt: new Date(NOW), ageSeconds: 0, quoteSentAt: null,
    ...overrides,
  } as ManualRequestListRow;
}

const lead = (id: string, createdAt: string, first: string | null = 'Emma', title: string | null = 'Condo repairs'): LeadNode =>
  ({ id, title, requestStatus: 'new', createdAt, client: { firstName: first, lastName: first ? 'Chimera' : null, companyName: null } });

describe('mergeQueueWithOpenLeads', () => {
  it('keeps manual rows, drops stored Jobber rows that are no longer open, and adds open leads Cotiza never stored', () => {
    const stored = [
      row({ id: 'manual-1', requestSource: 'manual', customerName: 'Walk-in', ageSeconds: 5 * 86400 }),
      row({ id: 'stale', jobberRequestId: 'J-old', ageSeconds: 900 * 86400 }),
      row({ id: 'kept', jobberRequestId: 'J-1', customerName: 'Unknown', requestBodyText: 'stored notes', ageSeconds: 400 * 86400 }),
    ];
    const merged = mergeQueueWithOpenLeads(stored, [lead('J-1', '2026-11-03T12:00:00Z'), lead('J-2', '2026-11-04T06:00:00Z', null, null)], 'age_desc', 'u', NOW);

    expect(merged.map((r) => r.id)).toEqual(['J-2', 'kept', 'manual-1']);
    expect(merged[1]).toMatchObject({ customerName: 'Emma Chimera', requestTitle: 'Condo repairs', requestBodyText: 'stored notes', jobberRequestId: 'J-1', ageSeconds: 86400 });
    expect(merged[0]).toMatchObject({ requestSource: 'jobber', jobberRequestId: 'J-2', customerName: 'Unknown', ageSeconds: 6 * 3600, quoteSentAt: null });
    expect(merged[0].createdAt).toBeInstanceOf(Date);
  });

  it('uses the Jobber contact name when the client has no name', () => {
    const merged = mergeQueueWithOpenLeads([], [{ id: 'C', title: null, requestStatus: 'new', createdAt: '2026-11-04T06:00:00Z', contactName: ' Paige Tinkham ', client: { firstName: '', lastName: '', companyName: null } }], 'age_desc', 'u', NOW);
    expect(merged[0].customerName).toBe('Paige Tinkham');
  });

  it('treats a missing Jobber requests page as a failed read', async () => {
    const jobber = { graphqlRequest: async () => ({}) } as never;
    await expect(loadOpenLeads(jobber, 60, NOW)).rejects.toThrow('no requests page');
    const noPageInfo = { graphqlRequest: async () => ({ requests: { edges: [] } }) } as never;
    await expect(loadOpenLeads(noPageInfo, 60, NOW)).rejects.toThrow('no requests page');
  });

  it('sorts oldest first when asked', () => {
    const merged = mergeQueueWithOpenLeads([], [lead('A', '2026-11-04T06:00:00Z'), lead('B', '2026-10-20T00:00:00Z')], 'age_asc', 'u', NOW);
    expect(merged.map((r) => r.id)).toEqual(['B', 'A']);
  });
});
