import { describe, it, expect } from 'vitest';
import {
  validateAction,
  validateCondition,
  evaluateCondition,
  executeAction,
  executeRules,
} from '../../worker/src/services/rules-engine.js';
import type { EngineLineItem, DepositSchedule, StructuredRule } from 'shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLineItem(overrides: Partial<EngineLineItem> = {}): EngineLineItem {
  return {
    id: 'li-1',
    productCatalogEntryId: null,
    productName: 'Drywall',
    description: '',
    quantity: 1,
    unitPrice: 100,
    confidenceScore: 100,
    originalText: '',
    ruleIdsApplied: [],
    ...overrides,
  };
}

const VALID_SCHEDULE: DepositSchedule = {
  label: 'Standard Deposit',
  milestones: [
    { percentage: 30, description: 'Deposit due at signing' },
    { percentage: 70, description: 'Balance due at completion of work' },
  ],
};

// ---------------------------------------------------------------------------
// validateAction('set_deposit_schedule')
// ---------------------------------------------------------------------------

describe("validateAction('set_deposit_schedule')", () => {
  it('passes for a valid two-milestone schedule summing to 100', () => {
    const result = validateAction({ type: 'set_deposit_schedule', schedule: VALID_SCHEDULE });
    expect(result.valid).toBe(true);
  });

  it('fails when milestone percentages do not sum to 100', () => {
    const result = validateAction({
      type: 'set_deposit_schedule',
      schedule: {
        label: 'Bad Schedule',
        milestones: [
          { percentage: 30, description: 'First' },
          { percentage: 50, description: 'Second' },
        ],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/sum to 100/i);
  });

  it('fails when a milestone percentage is not a whole integer', () => {
    const result = validateAction({
      type: 'set_deposit_schedule',
      schedule: {
        label: 'Float Schedule',
        milestones: [
          { percentage: 33.3, description: 'First' },
          { percentage: 66.7, description: 'Second' },
        ],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/whole integer/i);
  });

  it('fails when milestones array is empty', () => {
    const result = validateAction({
      type: 'set_deposit_schedule',
      schedule: { label: 'Empty', milestones: [] },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/at least one/i);
  });

  it('fails when label exceeds 100 characters', () => {
    const result = validateAction({
      type: 'set_deposit_schedule',
      schedule: {
        label: 'A'.repeat(101),
        milestones: [{ percentage: 100, description: 'Full payment' }],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/100 characters/i);
  });

  it('fails when label is empty', () => {
    const result = validateAction({
      type: 'set_deposit_schedule',
      schedule: {
        label: '',
        milestones: [{ percentage: 100, description: 'Full payment' }],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/non-empty/i);
  });

  it('fails when milestones array has more than 10 entries', () => {
    // 11 milestones: first 10 at 9% each = 90%, last at 10% = 100% total
    const milestones = [
      ...Array.from({ length: 10 }, (_, i) => ({ percentage: 9, description: `Milestone ${i + 1}` })),
      { percentage: 10, description: 'Milestone 11' },
    ];
    const result = validateAction({
      type: 'set_deposit_schedule',
      schedule: { label: 'Too Many', milestones },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/10 or fewer/i);
  });
});

// ---------------------------------------------------------------------------
// validateCondition('quote_total_gte')
// ---------------------------------------------------------------------------

describe("validateCondition('quote_total_gte')", () => {
  it('passes for a valid non-negative threshold', () => {
    const result = validateCondition({ type: 'quote_total_gte', threshold: 10000 });
    expect(result.valid).toBe(true);
  });

  it('passes for threshold of 0', () => {
    const result = validateCondition({ type: 'quote_total_gte', threshold: 0 });
    expect(result.valid).toBe(true);
  });

  it('fails for a negative threshold', () => {
    const result = validateCondition({ type: 'quote_total_gte', threshold: -1 });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/non-negative/i);
  });

  it('fails when threshold is not a number', () => {
    const result = validateCondition({ type: 'quote_total_gte', threshold: 'high' });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/number/i);
  });

  it('fails when threshold is missing', () => {
    const result = validateCondition({ type: 'quote_total_gte' });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/number/i);
  });
});

// ---------------------------------------------------------------------------
// evaluateCondition('quote_total_gte')
// ---------------------------------------------------------------------------

describe("evaluateCondition('quote_total_gte')", () => {
  it('fires (matched=true) when total equals threshold exactly (boundary)', () => {
    const lineItems = [makeLineItem({ quantity: 10, unitPrice: 1000 })]; // total = 10000
    const result = evaluateCondition({ type: 'quote_total_gte', threshold: 10000 }, lineItems);
    expect(result.matched).toBe(true);
    expect(result.matchingLineItemIds).toContain('li-1');
  });

  it('does not fire when total is below threshold', () => {
    const lineItems = [makeLineItem({ quantity: 9, unitPrice: 1000 })]; // total = 9000
    const result = evaluateCondition({ type: 'quote_total_gte', threshold: 10000 }, lineItems);
    expect(result.matched).toBe(false);
    expect(result.matchingLineItemIds).toHaveLength(0);
  });

  it('fires when total is above threshold', () => {
    const lineItems = [makeLineItem({ quantity: 11, unitPrice: 1000 })]; // total = 11000
    const result = evaluateCondition({ type: 'quote_total_gte', threshold: 10000 }, lineItems);
    expect(result.matched).toBe(true);
  });

  it('fires when line items are empty and threshold is 0', () => {
    const result = evaluateCondition({ type: 'quote_total_gte', threshold: 0 }, []);
    expect(result.matched).toBe(true);
    expect(result.matchingLineItemIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// executeAction('set_deposit_schedule')
// ---------------------------------------------------------------------------

describe("executeAction('set_deposit_schedule')", () => {
  const lineItems: EngineLineItem[] = [makeLineItem()];

  it('sets depositScheduleValue on the result', () => {
    const result = executeAction(
      { type: 'set_deposit_schedule', schedule: VALID_SCHEDULE },
      lineItems,
      [],
      'rule-1',
      null,
      undefined,
      undefined,
      null,
    );
    expect(result.depositScheduleValue).toEqual(VALID_SCHEDULE);
    expect(result.modified).toBe(true);
  });

  it('produces beforeSnapshot and afterSnapshot with id __deposit_schedule__', () => {
    const result = executeAction(
      { type: 'set_deposit_schedule', schedule: VALID_SCHEDULE },
      lineItems,
      [],
      'rule-1',
      null,
      undefined,
      undefined,
      null,
    );
    expect(result.beforeSnapshot).toHaveLength(1);
    expect(result.beforeSnapshot![0].id).toBe('__deposit_schedule__');
    expect(result.afterSnapshot).toHaveLength(1);
    expect(result.afterSnapshot![0].id).toBe('__deposit_schedule__');
  });

  it('beforeSnapshot description is empty string when no prior schedule existed', () => {
    const result = executeAction(
      { type: 'set_deposit_schedule', schedule: VALID_SCHEDULE },
      lineItems,
      [],
      'rule-1',
      null,
      undefined,
      undefined,
      null, // no prior schedule
    );
    expect(result.beforeSnapshot![0].description).toBe('');
  });

  it('beforeSnapshot description is JSON of prior schedule when one existed', () => {
    const priorSchedule: DepositSchedule = {
      label: 'Old Schedule',
      milestones: [{ percentage: 100, description: 'Full payment upfront' }],
    };
    const result = executeAction(
      { type: 'set_deposit_schedule', schedule: VALID_SCHEDULE },
      lineItems,
      [],
      'rule-1',
      null,
      undefined,
      undefined,
      priorSchedule,
    );
    expect(result.beforeSnapshot![0].description).toBe(JSON.stringify(priorSchedule));
  });

  it('afterSnapshot description is JSON of the new schedule', () => {
    const result = executeAction(
      { type: 'set_deposit_schedule', schedule: VALID_SCHEDULE },
      lineItems,
      [],
      'rule-1',
      null,
      undefined,
      undefined,
      null,
    );
    expect(result.afterSnapshot![0].description).toBe(JSON.stringify(VALID_SCHEDULE));
  });
});

// ---------------------------------------------------------------------------
// executeRules — depositSchedule is null when no set_deposit_schedule rule fires
// ---------------------------------------------------------------------------

describe('executeRules — depositSchedule when no set_deposit_schedule rule fires', () => {
  it('returns depositSchedule: null when no set_deposit_schedule rule is present', () => {
    const rule: StructuredRule = {
      id: 'rule-note',
      name: 'Note Rule',
      priorityOrder: 100,
      triggerMode: 'on_create',
      condition: { type: 'always' },
      actions: [{ type: 'set_customer_note', text: 'Some note' }],
    };

    const result = executeRules({
      lineItems: [makeLineItem()],
      rules: [rule],
      catalog: [],
    });

    expect(result.depositSchedule).toBeNull();
  });

  it('returns depositSchedule: null when rules array is empty', () => {
    const result = executeRules({
      lineItems: [makeLineItem()],
      rules: [],
      catalog: [],
    });

    expect(result.depositSchedule).toBeNull();
  });
});
