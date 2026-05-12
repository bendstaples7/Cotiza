import { describe, it, expect } from 'vitest';
import { buildJobberMessage } from '../../worker/src/services/jobber-quote-push-service.js';
import type { DepositSchedule, QuoteLineItem } from 'shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUnresolvedItem(originalText: string): QuoteLineItem {
  return {
    id: 'unresolved-1',
    productCatalogEntryId: null,
    productName: 'Unknown',
    description: '',
    quantity: 1,
    unitPrice: 0,
    confidenceScore: 0,
    originalText,
    resolved: false,
  };
}

const STANDARD_SCHEDULE: DepositSchedule = {
  label: 'Standard Deposit',
  milestones: [
    { percentage: 30, description: 'Deposit due at signing' },
    { percentage: 70, description: 'Balance due at completion of work' },
  ],
};

// ---------------------------------------------------------------------------
// Four combinations of null/non-null customerNote and depositSchedule
// ---------------------------------------------------------------------------

describe('buildJobberMessage — null/non-null combinations', () => {
  it('returns undefined when both customerNote and depositSchedule are null and no unresolved items', () => {
    const result = buildJobberMessage(null, null, []);
    expect(result).toBeUndefined();
  });

  it('returns only the customerNote when depositSchedule is null and no unresolved items', () => {
    const result = buildJobberMessage('Permit fees not included.', null, []);
    expect(result).toBe('Permit fees not included.');
  });

  it('returns only the deposit schedule text when customerNote is null and no unresolved items', () => {
    const result = buildJobberMessage(null, STANDARD_SCHEDULE, []);
    expect(result).toBe(
      'Standard Deposit\n• 30% — Deposit due at signing\n• 70% — Balance due at completion of work',
    );
  });

  it('returns both segments joined by \\n\\n when both customerNote and depositSchedule are present', () => {
    const result = buildJobberMessage('Permit fees not included.', STANDARD_SCHEDULE, []);
    expect(result).toBe(
      'Permit fees not included.\n\nStandard Deposit\n• 30% — Deposit due at signing\n• 70% — Balance due at completion of work',
    );
  });
});

// ---------------------------------------------------------------------------
// Segment separator is exactly \n\n
// ---------------------------------------------------------------------------

describe('buildJobberMessage — segment separator', () => {
  it('separates customerNote and deposit schedule with exactly \\n\\n', () => {
    const result = buildJobberMessage('Note text', STANDARD_SCHEDULE, []);
    const parts = result!.split('\n\n');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe('Note text');
    expect(parts[1]).toContain('Standard Deposit');
  });

  it('separates deposit schedule and unresolved items with exactly \\n\\n', () => {
    const result = buildJobberMessage(null, STANDARD_SCHEDULE, [makeUnresolvedItem('mystery item')]);
    const parts = result!.split('\n\n');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('Standard Deposit');
    expect(parts[1]).toContain('Unresolved items');
  });

  it('separates all three segments with exactly \\n\\n each', () => {
    const result = buildJobberMessage('Note text', STANDARD_SCHEDULE, [makeUnresolvedItem('mystery item')]);
    const parts = result!.split('\n\n');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('Note text');
    expect(parts[1]).toContain('Standard Deposit');
    expect(parts[2]).toContain('Unresolved items');
  });
});

// ---------------------------------------------------------------------------
// Empty milestones array omits deposit schedule text
// ---------------------------------------------------------------------------

describe('buildJobberMessage — empty milestones', () => {
  it('omits deposit schedule text when milestones array is empty', () => {
    const emptySchedule: DepositSchedule = { label: 'Empty Schedule', milestones: [] };
    const result = buildJobberMessage('Note text', emptySchedule, []);
    // Only the note should be present — no deposit schedule text
    expect(result).toBe('Note text');
  });

  it('returns undefined when customerNote is null and milestones array is empty and no unresolved items', () => {
    const emptySchedule: DepositSchedule = { label: 'Empty Schedule', milestones: [] };
    const result = buildJobberMessage(null, emptySchedule, []);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unresolved items text appears after deposit schedule text
// ---------------------------------------------------------------------------

describe('buildJobberMessage — ordering with all three segments', () => {
  it('places unresolved items text after deposit schedule text', () => {
    const result = buildJobberMessage('Note text', STANDARD_SCHEDULE, [makeUnresolvedItem('mystery item')]);
    const depositIndex = result!.indexOf('Standard Deposit');
    const unresolvedIndex = result!.indexOf('Unresolved items');
    expect(depositIndex).toBeGreaterThan(-1);
    expect(unresolvedIndex).toBeGreaterThan(depositIndex);
  });

  it('places customerNote before deposit schedule text', () => {
    const result = buildJobberMessage('Note text', STANDARD_SCHEDULE, [makeUnresolvedItem('mystery item')]);
    const noteIndex = result!.indexOf('Note text');
    const depositIndex = result!.indexOf('Standard Deposit');
    expect(noteIndex).toBeLessThan(depositIndex);
  });

  it('formats unresolved items with bullet prefix and original text', () => {
    const result = buildJobberMessage(null, null, [makeUnresolvedItem('crown molding')]);
    expect(result).toContain('• crown molding');
    expect(result).toContain('Unresolved items from original request:');
  });
});

// ---------------------------------------------------------------------------
// Milestone percentage rendered as whole integer via Math.round
// ---------------------------------------------------------------------------

describe('buildJobberMessage — milestone percentage rendering', () => {
  it('renders integer percentages as whole integers', () => {
    const result = buildJobberMessage(null, STANDARD_SCHEDULE, []);
    expect(result).toContain('• 30%');
    expect(result).toContain('• 70%');
  });

  it('rounds fractional percentages to the nearest whole integer', () => {
    const fractionalSchedule: DepositSchedule = {
      label: 'Fractional Schedule',
      milestones: [
        { percentage: 33.4, description: 'First payment' },
        { percentage: 66.6, description: 'Final payment' },
      ],
    };
    const result = buildJobberMessage(null, fractionalSchedule, []);
    // 33.4 rounds to 33, 66.6 rounds to 67
    expect(result).toContain('• 33%');
    expect(result).toContain('• 67%');
  });

  it('renders milestone lines in the format "• {n}% — {description}"', () => {
    const result = buildJobberMessage(null, STANDARD_SCHEDULE, []);
    expect(result).toContain('• 30% — Deposit due at signing');
    expect(result).toContain('• 70% — Balance due at completion of work');
  });

  it('deposit schedule text starts with the schedule label on the first line', () => {
    const result = buildJobberMessage(null, STANDARD_SCHEDULE, []);
    const lines = result!.split('\n');
    expect(lines[0]).toBe('Standard Deposit');
  });
});

// ---------------------------------------------------------------------------
// customerNote whitespace trimming
// ---------------------------------------------------------------------------

describe('buildJobberMessage — customerNote trimming', () => {
  it('trims leading and trailing whitespace from customerNote', () => {
    const result = buildJobberMessage('  Note with spaces  ', null, []);
    expect(result).toBe('Note with spaces');
  });

  it('treats a whitespace-only customerNote as absent (no segment added)', () => {
    const result = buildJobberMessage('   ', STANDARD_SCHEDULE, []);
    // Only the deposit schedule should appear — no note segment
    const parts = result!.split('\n\n');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain('Standard Deposit');
  });
});
