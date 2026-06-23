import { describe, it, expect } from 'vitest';
import { ManualRequestService } from '../../worker/src/services/manual-request-service.js';
import type { ManualRequestListRow } from '../../worker/src/services/manual-request-service.js';

describe('ManualRequestService.dedupeListRows', () => {
  const service = new ManualRequestService({} as D1Database);

  const row = (overrides: Partial<ManualRequestListRow> & { id: string }): ManualRequestListRow => ({
    id: overrides.id,
    userId: 'user-1',
    customerName: overrides.customerName ?? 'Test',
    customerPhone: null,
    customerEmail: null,
    customerAddress: null,
    serviceDescription: 'Work',
    mediaItemIds: [],
    requestSource: overrides.requestSource ?? 'jobber',
    createdAt: new Date('2025-06-01'),
    ageSeconds: 100,
    jobberRequestId: overrides.jobberRequestId ?? null,
    ...overrides,
  });

  it('keeps one row per jobber_request_id', () => {
    const jobberId = 'gid://Jobber/Request/28658870';
    const deduped = (service as any).dedupeListRows([
      row({ id: 'a', jobberRequestId: jobberId }),
      row({ id: 'b', jobberRequestId: jobberId }),
      row({ id: 'c', jobberRequestId: jobberId }),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe('a');
  });

  it('keeps distinct manual and jobber rows', () => {
    const deduped = (service as any).dedupeListRows([
      row({ id: 'manual-1', requestSource: 'manual', jobberRequestId: null }),
      row({ id: 'jobber-1', jobberRequestId: 'gid://Jobber/Request/1' }),
    ]);
    expect(deduped).toHaveLength(2);
  });

  it('re-sorts after dedupe (oldest first)', () => {
    const jobberId = 'gid://Jobber/Request/1';
    const deduped = (service as any).dedupeListRows([
      row({ id: 'a', jobberRequestId: jobberId, ageSeconds: 100 }),
      row({ id: 'b', jobberRequestId: jobberId, ageSeconds: 100 }),
      row({ id: 'c', ageSeconds: 5000 }),
      row({ id: 'd', ageSeconds: 200 }),
    ], 'age_asc');
    expect(deduped.map((r: { id: string }) => r.id)).toEqual(['c', 'd', 'a']);
  });
});
