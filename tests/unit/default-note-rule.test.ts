import { describe, it, expect } from 'vitest';
import { executeRules } from '../../worker/src/services/rules-engine.js';
import type { EngineLineItem, StructuredRule } from 'shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_NOTE_TEXT =
  'Estimate does not include permit fees, or permit coordination fees. If customer would like permits pulled for this work, will require change order at additional cost.';

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

/** The Default Note Rule as it is seeded in the database (priorityOrder: 100) */
const DEFAULT_NOTE_RULE: StructuredRule = {
  id: 'default-note-rule',
  name: 'Default Note Rule',
  priorityOrder: 100,
  triggerMode: 'on_create',
  condition: { type: 'always' },
  actions: [{ type: 'set_customer_note', text: DEFAULT_NOTE_TEXT }],
};

// ---------------------------------------------------------------------------
// Scenario 1: Default Note Rule disabled (not included in rules array)
// → customerNote is null when no other note rules fire
// Requirements: 1.5
// ---------------------------------------------------------------------------

describe('Default Note Rule disabled — no note rules in rules array', () => {
  it('returns customerNote: null when the rules array is empty', () => {
    const result = executeRules({
      lineItems: [makeLineItem()],
      rules: [],
      catalog: [],
    });

    expect(result.customerNote).toBeNull();
  });

  it('returns customerNote: null when rules array contains only non-note rules', () => {
    const nonNoteRule: StructuredRule = {
      id: 'add-item-rule',
      name: 'Add Item Rule',
      priorityOrder: 50,
      triggerMode: 'on_create',
      condition: { type: 'always' },
      actions: [{ type: 'add_line_item', productName: 'Permit Fee', quantity: 1, unitPrice: 0 }],
    };

    const result = executeRules({
      lineItems: [makeLineItem()],
      rules: [nonNoteRule],
      catalog: [],
    });

    expect(result.customerNote).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Default Note Rule fires alongside a higher-priority
// set_customer_note rule (priorityOrder: 50 < 100)
//
// executeRules sorts rules ascending by priorityOrder before execution.
// set_customer_note has no priority guard — each action directly overwrites
// the current customerNote value. Therefore the rule with the highest
// priorityOrder number runs last and its text is the final value.
//
// With Default Note Rule (100) + override rule (50):
//   1. priorityOrder 50 runs first → customerNote = override text
//   2. priorityOrder 100 runs second → customerNote = DEFAULT_NOTE_TEXT (overwrites)
// Result: DEFAULT_NOTE_TEXT
//
// Requirements: 1.2
// ---------------------------------------------------------------------------

describe('Default Note Rule + higher-priority set_customer_note rule (priorityOrder 50)', () => {
  it('Default Note Rule (100) runs after the override rule (50) and its text is the final customerNote', () => {
    const higherPriorityRule: StructuredRule = {
      id: 'override-note-rule',
      name: 'Override Note Rule',
      priorityOrder: 50, // lower number = higher priority, runs first
      triggerMode: 'on_create',
      condition: { type: 'always' },
      actions: [{ type: 'set_customer_note', text: 'Custom override note text.' }],
    };

    const result = executeRules({
      lineItems: [makeLineItem()],
      rules: [DEFAULT_NOTE_RULE, higherPriorityRule],
      catalog: [],
    });

    // Execution order (ascending priorityOrder):
    // 1. priorityOrder 50 → customerNote = "Custom override note text."
    // 2. priorityOrder 100 → customerNote = DEFAULT_NOTE_TEXT (overwrites)
    expect(result.customerNote).toBe(DEFAULT_NOTE_TEXT);
  });

  it('Default Note Rule alone sets customerNote to the permit-fee disclaimer', () => {
    const result = executeRules({
      lineItems: [makeLineItem()],
      rules: [DEFAULT_NOTE_RULE],
      catalog: [],
    });

    expect(result.customerNote).toBe(DEFAULT_NOTE_TEXT);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Default Note Rule fires alongside an append_customer_note rule
// → text is appended to the default note
//
// When the append rule has a higher priorityOrder (runs after the Default Note
// Rule), it appends to the default note text. The default separator is '\n'.
//
// Requirements: 1.3
// ---------------------------------------------------------------------------

describe('Default Note Rule + append_customer_note rule', () => {
  it('appends the additional text to the default note when the append rule runs after (priorityOrder 200 > 100)', () => {
    const appendRule: StructuredRule = {
      id: 'append-note-rule',
      name: 'Append Note Rule',
      priorityOrder: 200, // runs after Default Note Rule (100)
      triggerMode: 'on_create',
      condition: { type: 'always' },
      actions: [{ type: 'append_customer_note', text: 'Additional context for this job.' }],
    };

    const result = executeRules({
      lineItems: [makeLineItem()],
      rules: [DEFAULT_NOTE_RULE, appendRule],
      catalog: [],
    });

    // Execution order (ascending priorityOrder):
    // 1. priorityOrder 100 → customerNote = DEFAULT_NOTE_TEXT
    // 2. priorityOrder 200 → customerNote = DEFAULT_NOTE_TEXT + '\n' + 'Additional context for this job.'
    expect(result.customerNote).toBe(
      `${DEFAULT_NOTE_TEXT}\nAdditional context for this job.`,
    );
  });

  it('uses a custom separator when the append rule specifies one', () => {
    const appendRule: StructuredRule = {
      id: 'append-note-rule-space',
      name: 'Append Note Rule (space separator)',
      priorityOrder: 200,
      triggerMode: 'on_create',
      condition: { type: 'always' },
      actions: [{ type: 'append_customer_note', text: 'Extra note.', separator: ' ' }],
    };

    const result = executeRules({
      lineItems: [makeLineItem()],
      rules: [DEFAULT_NOTE_RULE, appendRule],
      catalog: [],
    });

    expect(result.customerNote).toBe(`${DEFAULT_NOTE_TEXT} Extra note.`);
  });
});
