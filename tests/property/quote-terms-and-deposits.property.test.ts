/**
 * Property-Based Tests — Quote Terms and Deposits
 *
 * Validates the 7 correctness properties defined in the design document.
 *
 * Properties tested here:
 *   Property 1: Deposit schedule milestone sum invariant
 *   Property 2: set_deposit_schedule priority resolution
 *   Property 3: quote_total_gte boundary correctness
 *   Property 4: Jobber message assembly order invariant
 *   Property 5: set_customer_note priority resolution
 *   Property 6: Deposit schedule persistence round-trip
 *   Property 7: Deposit schedule text formatting
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { executeRules, evaluateCondition, validateAction } from '../../worker/src/services/rules-engine.js';
import { buildJobberMessage } from '../../worker/src/services/jobber-quote-push-service.js';
import type {
  DepositSchedule,
  StructuredRule,
  EngineLineItem,
  QuoteLineItem,
} from '../../shared/src/types/quote.js';

// ═══════════════════════════════════════════════════════════════════════════
// Arbitraries
// ═══════════════════════════════════════════════════════════════════════════

/** Arbitrary for a non-empty ASCII string up to N characters (guaranteed non-whitespace-only) */
function arbNonEmptyString(maxLength = 100): fc.Arbitrary<string> {
  return fc
    .string({ minLength: 1, maxLength, unit: 'grapheme-ascii' })
    .filter((s) => s.trim().length > 0);
}

/**
 * Generates an array of N whole-integer percentages that sum to exactly 100.
 * Strategy: pick N-1 distinct cut points in [1, 99], sort them, compute diffs.
 */
function arbIntegerPercentagesSummingTo100(n: number): fc.Arbitrary<number[]> {
  if (n === 1) return fc.constant([100]);
  return fc
    .uniqueArray(fc.integer({ min: 1, max: 99 }), { minLength: n - 1, maxLength: n - 1 })
    .map((cuts) => {
      const sorted = [...cuts].sort((a, b) => a - b);
      const points = [0, ...sorted, 100];
      return points.slice(1).map((p, i) => p - points[i]);
    });
}

/**
 * Arbitrary for a valid DepositSchedule with integer percentages summing to 100.
 * Used for Properties 1, 2, 7.
 */
const arbValidDepositScheduleInteger: fc.Arbitrary<DepositSchedule> = fc
  .integer({ min: 1, max: 10 })
  .chain((n) =>
    fc.tuple(
      arbNonEmptyString(100),
      arbIntegerPercentagesSummingTo100(n),
      fc.array(arbNonEmptyString(60), { minLength: n, maxLength: n }),
    ).map(([label, percentages, descriptions]) => ({
      label,
      milestones: percentages.map((percentage, i) => ({
        percentage,
        description: descriptions[i],
      })),
    })),
  );

/**
 * Arbitrary for a valid DepositSchedule with floating-point percentages summing to 100.
 * Used for Property 6 (persistence round-trip).
 */
const arbValidDepositScheduleFloat: fc.Arbitrary<DepositSchedule> = fc
  .integer({ min: 1, max: 10 })
  .chain((n) => {
    if (n === 1) {
      return fc
        .tuple(arbNonEmptyString(100), arbNonEmptyString(60))
        .map(([label, description]) => ({
          label,
          milestones: [{ percentage: 100, description }],
        }));
    }
    return fc
      .tuple(
        arbNonEmptyString(100),
        fc.uniqueArray(fc.double({ min: 0.01, max: 99.99, noNaN: true }), {
          minLength: n - 1,
          maxLength: n - 1,
        }),
        fc.array(arbNonEmptyString(60), { minLength: n, maxLength: n }),
      )
      .map(([label, cuts, descriptions]) => {
        const sorted = [...cuts].sort((a, b) => a - b);
        const points = [0, ...sorted, 100];
        const percentages = points.slice(1).map((p, i) =>
          Math.round((p - points[i]) * 100) / 100,
        );
        // Fix rounding drift on last element so sum is exactly 100
        const sumSoFar = percentages.slice(0, -1).reduce((s, v) => s + v, 0);
        percentages[percentages.length - 1] = Math.round((100 - sumSoFar) * 100) / 100;
        return {
          label,
          milestones: percentages.map((percentage, i) => ({
            percentage,
            description: descriptions[i],
          })),
        };
      });
  });

/** Arbitrary for a unique rule ID (UUID ensures no collisions between rules in the same test) */
const arbRuleId: fc.Arbitrary<string> = fc.uuid();

/** Builds a StructuredRule with an `always` condition and a `set_deposit_schedule` action */
function makeDepositRule(
  id: string,
  priorityOrder: number,
  schedule: DepositSchedule,
): StructuredRule {
  return {
    id,
    name: `Deposit Rule ${id}`,
    priorityOrder,
    triggerMode: 'on_create',
    condition: { type: 'always' },
    actions: [{ type: 'set_deposit_schedule', schedule }],
  };
}

/** Builds a StructuredRule with an `always` condition and a `set_customer_note` action */
function makeNoteRule(
  id: string,
  priorityOrder: number,
  text: string,
): StructuredRule {
  return {
    id,
    name: `Note Rule ${id}`,
    priorityOrder,
    triggerMode: 'on_create',
    condition: { type: 'always' },
    actions: [{ type: 'set_customer_note', text }],
  };
}

/** Minimal EngineLineItem factory */
function makeEngineLineItem(
  id: string,
  quantity: number,
  unitPrice: number,
): EngineLineItem {
  return {
    id,
    productCatalogEntryId: null,
    productName: `Product ${id}`,
    description: '',
    quantity,
    unitPrice,
    confidenceScore: 100,
    originalText: '',
    ruleIdsApplied: [],
  };
}

/** Minimal QuoteLineItem factory for unresolved items */
function makeUnresolvedItem(id: string, originalText: string): QuoteLineItem {
  return {
    id,
    productCatalogEntryId: null,
    productName: '',
    description: '',
    quantity: 1,
    unitPrice: 0,
    confidenceScore: 0,
    originalText,
    resolved: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Property 1: Deposit schedule milestone sum invariant
//
// For any DepositSchedule that passes validateAction (whole integer percentages
// summing to 100, 1–10 milestones, label 1–100 chars), the sum of all
// milestone.percentage values SHALL equal exactly 100.
//
// Validates: Requirements 2.7, 5.4
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 1: Deposit schedule milestone sum invariant', () => {
  it('sum of milestone percentages equals 100 for any valid schedule that passes validateAction', () => {
    // **Validates: Requirements 2.7, 5.4**
    fc.assert(
      fc.property(arbValidDepositScheduleInteger, (schedule) => {
        // Precondition: the schedule must pass validateAction
        const validation = validateAction({ type: 'set_deposit_schedule', schedule });
        fc.pre(validation.valid);

        const sum = schedule.milestones.reduce((acc, m) => acc + m.percentage, 0);
        expect(sum).toBe(100);
      }),
      { numRuns: 100 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 2: set_deposit_schedule priority resolution
//
// For any set of rules containing 2–5 set_deposit_schedule actions whose
// conditions all evaluate to true, the depositSchedule in the RulesEngineResult
// SHALL be the schedule from the rule with the numerically lowest priorityOrder.
//
// Validates: Requirements 5.3, 6.2, 6.3, 7.3
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 2: set_deposit_schedule priority resolution', () => {
  it('depositSchedule in result equals the schedule from the rule with the lowest priorityOrder', () => {
    // **Validates: Requirements 5.3, 6.2, 6.3, 7.3**

    const arbRules = fc
      .integer({ min: 2, max: 5 })
      .chain((n) =>
        fc.tuple(
          fc.uniqueArray(fc.integer({ min: 1, max: 1000 }), { minLength: n, maxLength: n }),
          fc.array(arbValidDepositScheduleInteger, { minLength: n, maxLength: n }),
          fc.array(arbRuleId, { minLength: n, maxLength: n }),
        ).map(([priorities, schedules, ids]) =>
          priorities.map((priorityOrder, i) =>
            makeDepositRule(ids[i], priorityOrder, schedules[i]),
          ),
        ),
      );

    fc.assert(
      fc.property(arbRules, (rules) => {
        const result = executeRules({
          lineItems: [],
          rules,
          catalog: [],
        });

        // Find the rule with the lowest priorityOrder — it wins for set_deposit_schedule
        const winningRule = rules.reduce((best, r) =>
          r.priorityOrder < best.priorityOrder ? r : best,
        );
        const expectedSchedule = (
          winningRule.actions[0] as { type: 'set_deposit_schedule'; schedule: DepositSchedule }
        ).schedule;

        expect(result.depositSchedule).toEqual(expectedSchedule);
      }),
      { numRuns: 100 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 3: quote_total_gte boundary correctness
//
// For any set of line items and any threshold ≥ 0, the quote_total_gte
// condition SHALL evaluate to true when sum(quantity × unitPrice) >= threshold
// and to false when sum(quantity × unitPrice) < threshold.
//
// Validates: Requirements 7.1
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 3: quote_total_gte boundary correctness', () => {
  it('matched === (computedTotal >= threshold) for any line items and threshold', () => {
    // **Validates: Requirements 7.1**

    const arbLineItems = fc.array(
      fc
        .tuple(
          fc.string({ minLength: 1, maxLength: 8, unit: 'grapheme-ascii' }),
          fc.double({ min: 0, max: 1000, noNaN: true }),
          fc.double({ min: 0, max: 1000, noNaN: true }),
        )
        .map(([id, quantity, unitPrice]) => makeEngineLineItem(id, quantity, unitPrice)),
      { minLength: 0, maxLength: 10 },
    );

    const arbThreshold = fc.double({ min: 0, max: 100_000, noNaN: true });

    fc.assert(
      fc.property(arbLineItems, arbThreshold, (lineItems, threshold) => {
        fc.pre(Number.isFinite(threshold) && threshold >= 0);

        const computedTotal = lineItems.reduce(
          (sum, li) => sum + li.quantity * li.unitPrice,
          0,
        );

        const condResult = evaluateCondition(
          { type: 'quote_total_gte', threshold },
          lineItems,
        );

        expect(condResult.matched).toBe(computedTotal >= threshold);
      }),
      { numRuns: 100 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 4: Jobber message assembly order invariant
//
// For any combination of customerNote (null or non-null), depositSchedule
// (null or non-null with at least one milestone), and unresolvedItems (empty
// or non-empty), the assembled message SHALL contain present segments in the
// order: customerNote → deposit schedule text → unresolved items text, with
// each adjacent pair separated by exactly \n\n, and absent segments omitted.
//
// Validates: Requirements 9.1, 9.4
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 4: Jobber message assembly order invariant', () => {
  it('present segments appear in order with \\n\\n separators; absent segments are omitted', () => {
    // **Validates: Requirements 9.1, 9.4**

    const arbNullableNote = fc.option(
      fc.string({ minLength: 1, maxLength: 200, unit: 'grapheme-ascii' }),
      { nil: null, freq: 3 },
    );

    const arbNullableSchedule = fc.option(arbValidDepositScheduleInteger, {
      nil: null,
      freq: 3,
    });

    // Use fc.uuid() to generate unique IDs inside the arbitrary chain (pure, no external mutable state)
    const arbUnresolvedItems = fc.array(
      fc.tuple(
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 50, unit: 'grapheme-ascii' }),
      ).map(([id, text]) => makeUnresolvedItem(id, text)),
      { minLength: 0, maxLength: 5 },
    );

    fc.assert(
      fc.property(
        arbNullableNote,
        arbNullableSchedule,
        arbUnresolvedItems,
        (customerNote, depositSchedule, unresolvedItems) => {
          const message = buildJobberMessage(customerNote, depositSchedule, unresolvedItems);

          const hasNote = !!(customerNote?.trim());
          const hasSchedule = !!(depositSchedule && depositSchedule.milestones.length > 0);
          const hasUnresolved = unresolvedItems.length > 0;

          const presentCount = [hasNote, hasSchedule, hasUnresolved].filter(Boolean).length;

          if (presentCount === 0) {
            expect(message).toBeUndefined();
            return;
          }

          expect(typeof message).toBe('string');
          const msg = message as string;

          // Split on \n\n — must yield exactly presentCount parts
          const parts = msg.split('\n\n');
          expect(parts.length).toBe(presentCount);

          // Verify each segment appears in the correct part (by index).
          // Using parts[i].startsWith() avoids false failures when the note
          // text and schedule label happen to share the same string.
          let partIndex = 0;
          if (hasNote) {
            expect(parts[partIndex]).toContain(customerNote!.trim());
            partIndex++;
          }
          if (hasSchedule) {
            // The deposit schedule segment starts with the label on its first line
            expect(parts[partIndex].split('\n')[0]).toBe(depositSchedule!.label);
            partIndex++;
          }
          if (hasUnresolved) {
            expect(parts[partIndex]).toContain('Unresolved items from original request:');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 5: set_customer_note priority resolution
//
// For any set of rules containing 2–5 set_customer_note actions whose
// conditions all evaluate to true, the customerNote in the RulesEngineResult
// SHALL be the text from the rule with the numerically HIGHEST priorityOrder.
//
// Rationale: set_customer_note has no priority guard — it directly overwrites
// customerNote. Rules are sorted ascending by priorityOrder before execution,
// so the rule with the HIGHEST priorityOrder runs last and its text is the
// final value.
//
// Validates: Requirements 1.2, 1a.2
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 5: set_customer_note priority resolution', () => {
  it('customerNote in result equals the text from the rule with the highest priorityOrder (last writer wins)', () => {
    // **Validates: Requirements 1.2, 1a.2**

    const arbRules = fc
      .integer({ min: 2, max: 5 })
      .chain((n) =>
        fc.tuple(
          fc.uniqueArray(fc.integer({ min: 1, max: 1000 }), { minLength: n, maxLength: n }),
          // Note text must be non-empty and non-whitespace (set_customer_note validates text.trim() !== '')
          fc.array(
            fc.string({ minLength: 1, maxLength: 100, unit: 'grapheme-ascii' }).filter(
              (s) => s.trim().length > 0,
            ),
            { minLength: n, maxLength: n },
          ),
          fc.array(arbRuleId, { minLength: n, maxLength: n }),
        ).map(([priorities, texts, ids]) =>
          priorities.map((priorityOrder, i) =>
            makeNoteRule(ids[i], priorityOrder, texts[i]),
          ),
        ),
      );

    fc.assert(
      fc.property(arbRules, (rules) => {
        const result = executeRules({
          lineItems: [],
          rules,
          catalog: [],
        });

        // set_customer_note has no priority guard — last rule to execute wins.
        // Rules are sorted ascending by priorityOrder, so the rule with the
        // HIGHEST priorityOrder runs last and its text is the final value.
        const winningRule = rules.reduce((best, r) =>
          r.priorityOrder > best.priorityOrder ? r : best,
        );
        const expectedNote = (
          winningRule.actions[0] as { type: 'set_customer_note'; text: string }
        ).text;

        expect(result.customerNote).toBe(expectedNote);
      }),
      { numRuns: 100 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 6: Deposit schedule persistence round-trip
//
// For any valid DepositSchedule, JSON.parse(JSON.stringify(schedule)) SHALL
// be deeply equal to the original (verifies the serialization round-trip
// used by mapDraftRow).
//
// Validates: Requirements 2.5, 2.6, 4.1, 4.3
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 6: Deposit schedule persistence round-trip', () => {
  it('JSON serialization round-trip preserves all fields exactly', () => {
    // **Validates: Requirements 2.5, 2.6, 4.1, 4.3**
    fc.assert(
      fc.property(arbValidDepositScheduleFloat, (schedule) => {
        const roundTripped = JSON.parse(JSON.stringify(schedule)) as DepositSchedule;

        expect(roundTripped.label).toBe(schedule.label);
        expect(roundTripped.milestones.length).toBe(schedule.milestones.length);

        for (let i = 0; i < schedule.milestones.length; i++) {
          expect(roundTripped.milestones[i].description).toBe(
            schedule.milestones[i].description,
          );
          expect(roundTripped.milestones[i].percentage).toBe(
            schedule.milestones[i].percentage,
          );
        }

        expect(roundTripped).toEqual(schedule);
      }),
      { numRuns: 100 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 7: Deposit schedule text formatting
//
// For any non-null DepositSchedule with at least one milestone, the formatted
// deposit schedule text appended to the Jobber message SHALL:
//   - Begin with the schedule label on the first line
//   - Contain one line per milestone in the format: • {n}% — {description}
//     where n is a whole integer (Math.round of the percentage)
//   - Milestone lines appear in the same order as schedule.milestones
//
// Validates: Requirements 9.2
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 7: Deposit schedule text formatting', () => {
  it('formatted deposit schedule text starts with label and contains one line per milestone in order', () => {
    // **Validates: Requirements 9.2**
    fc.assert(
      fc.property(arbValidDepositScheduleInteger, (schedule) => {
        // Build the message with only a deposit schedule (no note, no unresolved items)
        const message = buildJobberMessage(null, schedule, []);

        expect(typeof message).toBe('string');
        const msg = message as string;

        const lines = msg.split('\n');

        // First line must be the schedule label
        expect(lines[0]).toBe(schedule.label);

        // One line per milestone after the label
        expect(lines.length).toBe(1 + schedule.milestones.length);

        for (let i = 0; i < schedule.milestones.length; i++) {
          const milestone = schedule.milestones[i];
          const renderedPct = Math.round(milestone.percentage);
          const expectedLine = `• ${renderedPct}% — ${milestone.description}`;

          // Milestone line must match the expected format
          expect(lines[i + 1]).toBe(expectedLine);

          // Rendered percentage must be a whole integer
          expect(Number.isInteger(renderedPct)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});
