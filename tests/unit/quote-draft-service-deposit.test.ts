import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';
import type { MockD1Database } from './helpers/mock-d1.js';
import { QuoteDraftService } from '../../worker/src/services/quote-draft-service.js';
import type { DepositSchedule } from 'shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid D1 row for a quote_drafts record */
function makeDraftRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'draft-001',
    user_id: 'user-abc',
    customer_request_text: 'Replace kitchen tile',
    selected_template_id: null,
    selected_template_name: null,
    status: 'draft',
    jobber_request_id: null,
    customer_note: null,
    manual_request_id: null,
    draft_number: 1,
    jobber_quote_id: null,
    jobber_quote_number: null,
    jobber_quote_web_uri: null,
    sqft_resolution_json: null,
    deposit_schedule: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Configure the mock DB for a single getById() call.
 * getById() issues three sequential prepare() calls:
 *   1. first()  — the quote_drafts row
 *   2. all()    — quote_line_items rows
 *   3. all()    — action_items rows
 */
function configureGetById(
  db: MockD1Database,
  draftRow: Record<string, unknown>,
): void {
  configurePrepareResults(db, [
    { first: draftRow },
    { all: { results: [] } },
    { all: { results: [] } },
  ]);
}

// ---------------------------------------------------------------------------
// Tests — mapDraftRow deposit_schedule deserialization (via getById)
// Requirements: 2.6
// ---------------------------------------------------------------------------

describe('QuoteDraftService — mapDraftRow deposit_schedule deserialization', () => {
  let db: MockD1Database;
  let service: QuoteDraftService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockD1();
    service = new QuoteDraftService(db as unknown as D1Database);
  });

  it('deserializes a valid JSON deposit_schedule blob to the correct DepositSchedule object', async () => {
    const schedule: DepositSchedule = {
      label: 'Standard Deposit',
      milestones: [
        { description: 'Deposit due at signing', percentage: 30 },
        { description: 'Balance due at completion of work', percentage: 70 },
      ],
    };

    configureGetById(db, makeDraftRow({ deposit_schedule: JSON.stringify(schedule) }));

    const draft = await service.getById('draft-001', 'user-abc');

    expect(draft.depositSchedule).toEqual(schedule);
    expect(draft.depositSchedule?.label).toBe('Standard Deposit');
    expect(draft.depositSchedule?.milestones).toHaveLength(2);
    expect(draft.depositSchedule?.milestones[0]).toEqual({
      description: 'Deposit due at signing',
      percentage: 30,
    });
    expect(draft.depositSchedule?.milestones[1]).toEqual({
      description: 'Balance due at completion of work',
      percentage: 70,
    });
  });

  it('returns null for depositSchedule when deposit_schedule column contains malformed JSON', async () => {
    configureGetById(db, makeDraftRow({ deposit_schedule: 'not-valid-json' }));

    // Must not throw — graceful degradation consistent with sqft_resolution_json handling
    const draft = await service.getById('draft-001', 'user-abc');

    expect(draft.depositSchedule).toBeNull();
  });

  it('returns null for depositSchedule when deposit_schedule column is null', async () => {
    configureGetById(db, makeDraftRow({ deposit_schedule: null }));

    const draft = await service.getById('draft-001', 'user-abc');

    expect(draft.depositSchedule).toBeNull();
  });

  it('preserves all milestone fields when deserializing a four-milestone schedule', async () => {
    const schedule: DepositSchedule = {
      label: 'High-Value Payment Schedule',
      milestones: [
        { description: 'Deposit due at signing', percentage: 30 },
        { description: 'Due at completion of rough plumbing and electric', percentage: 30 },
        { description: 'Due at completion of tile and flooring', percentage: 30 },
        { description: 'Due at customer sign-off of punch list', percentage: 10 },
      ],
    };

    configureGetById(db, makeDraftRow({ deposit_schedule: JSON.stringify(schedule) }));

    const draft = await service.getById('draft-001', 'user-abc');

    expect(draft.depositSchedule).toEqual(schedule);
    expect(draft.depositSchedule?.milestones).toHaveLength(4);
    const percentages = draft.depositSchedule!.milestones.map(m => m.percentage);
    expect(percentages.reduce((a, b) => a + b, 0)).toBe(100);
  });
});
