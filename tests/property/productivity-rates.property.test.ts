/**
 * Property-Based Tests — Productivity Rates
 *
 * Validates the 7 correctness properties defined in the design document.
 * Properties 4 (GET ordering) and 5 (update round-trip) are covered by unit
 * tests in tests/unit/productivity-rates-service.test.ts.
 *
 * Properties tested here:
 *   Property 1: sqft_per_hour validation accepts exactly finite positive numbers
 *   Property 2: Rate injection is complete and non-overwriting
 *   Property 3: Formula evaluation with injected rate variables produces correct arithmetic
 *   Property 6: D1 row serialization maps all fields correctly
 *   Property 7: Formula test panel variables include all loaded rates
 *
 * Note: fc.double() is used throughout instead of fc.float() because fast-check
 * requires fc.float() min/max to be 32-bit floats (Math.fround-compatible).
 * fc.double() accepts full 64-bit double boundaries.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ProductivityRatesService } from '../../worker/src/services/productivity-rates-service.js';
import { evaluateFormula } from '../../worker/src/services/formula-evaluator.js';
import { createMockD1 } from '../unit/helpers/mock-d1.js';
import type { ProductivityRate } from '../../shared/src/types/quote.js';

// ═══════════════════════════════════════════════════════════════════════════
// Helpers — expose private methods for testing via a subclass
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Thin subclass that exposes the private `validateSqftPerHour` and `mapRow`
 * methods for property testing without modifying the production class.
 */
class TestableProductivityRatesService extends ProductivityRatesService {
  public validateSqftPerHourPublic(value: number): void {
    // Access via bracket notation to bypass TypeScript's private check
    return (this as unknown as { validateSqftPerHour(v: number): void }).validateSqftPerHour(value);
  }

  public mapRowPublic(row: Record<string, unknown>): ProductivityRate {
    return (this as unknown as { mapRow(r: Record<string, unknown>): ProductivityRate }).mapRow(row);
  }
}

function makeTestableService(): TestableProductivityRatesService {
  const db = createMockD1();
  return new TestableProductivityRatesService(db as unknown as D1Database);
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers — rate injection (mirrors the logic in QuoteEngine.generateQuote)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pure helper that merges productivity rates into a context map using
 * non-overwrite semantics. This is the same logic used in QuoteEngine and
 * will be extracted as a standalone helper in task 11.3 for the formula
 * test panel.
 *
 * Validates: Requirements 3.1, 3.3, 6.1, 6.2
 */
function injectRates(
  context: Map<string, number>,
  rates: Pick<ProductivityRate, 'variableName' | 'sqftPerHour'>[],
): void {
  for (const rate of rates) {
    if (!context.has(rate.variableName)) {
      context.set(rate.variableName, rate.sqftPerHour);
    }
  }
}

/**
 * Pure helper that builds the variables map for the formula test panel.
 * Merges base variables with productivity rates using non-overwrite semantics.
 * This is the function that task 11.3 will extract from BusinessRulesTab.
 *
 * Validates: Requirements 6.1, 6.2
 */
function buildFormulaTestVariables(
  baseVariables: Record<string, number>,
  rates: Pick<ProductivityRate, 'variableName' | 'sqftPerHour'>[],
): Record<string, number> {
  const result = { ...baseVariables };
  for (const rate of rates) {
    if (!(rate.variableName in result)) {
      result[rate.variableName] = rate.sqftPerHour;
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// Arbitraries
// ═══════════════════════════════════════════════════════════════════════════

/** Arbitrary for a valid variable name (snake_case, starts with letter) */
const arbVariableName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.string({
      minLength: 0,
      maxLength: 15,
      unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')),
    }),
  )
  .map(([first, rest]) => first + rest);

/** Arbitrary for a valid sqft_per_hour value (finite positive double) */
const arbValidSqftPerHour: fc.Arbitrary<number> = fc.double({
  min: 0.001,
  max: 100_000,
  noNaN: true,
});

/** Arbitrary for a ProductivityRate object */
const arbProductivityRate: fc.Arbitrary<ProductivityRate> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 20 }),
  variableName: arbVariableName,
  displayName: fc.string({ minLength: 1, maxLength: 60 }),
  sqftPerHour: arbValidSqftPerHour,
  description: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: null }),
  createdAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }),
  updatedAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }),
});

/** Arbitrary for a raw D1 row representing a productivity rate */
const arbRateRow: fc.Arbitrary<Record<string, unknown>> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 20 }),
  variable_name: arbVariableName,
  display_name: fc.string({ minLength: 1, maxLength: 60 }),
  sqft_per_hour: arbValidSqftPerHour,
  description: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: null }),
  created_at: fc
    .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
    .map((d) => d.toISOString()),
  updated_at: fc
    .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
    .map((d) => d.toISOString()),
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 1: sqft_per_hour validation accepts exactly finite positive numbers
//
// For any number (including NaN, Infinity, -Infinity, 0, negatives, positives),
// validateSqftPerHour throws if and only if !(Number.isFinite(v) && v > 0).
//
// Validates: Requirements 1.3, 4.3
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 1: sqft_per_hour validation accepts exactly finite positive numbers', () => {
  it('throws for any non-finite or non-positive number, accepts all finite positive numbers', () => {
    const service = makeTestableService();

    fc.assert(
      fc.property(
        fc.oneof(
          // 32-bit floats (includes NaN, Infinity, -Infinity, negatives, positives)
          fc.float(),
          fc.integer(),
          fc.constant(NaN),
          fc.constant(Infinity),
          fc.constant(-Infinity),
          fc.constant(0),
          fc.constant(-1),
          fc.constant(-0.001),
          fc.constant(0.001),
          fc.constant(1),
          fc.constant(100),
        ),
        (v) => {
          const isValid = Number.isFinite(v) && v > 0;

          if (isValid) {
            // Must NOT throw for valid values
            expect(() => service.validateSqftPerHourPublic(v)).not.toThrow();
          } else {
            // Must throw a 400 PlatformError for invalid values
            expect(() => service.validateSqftPerHourPublic(v)).toThrow();
            try {
              service.validateSqftPerHourPublic(v);
            } catch (err) {
              expect((err as { statusCode?: number }).statusCode).toBe(400);
            }
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('accepts all finite positive doubles without throwing', () => {
    const service = makeTestableService();

    fc.assert(
      fc.property(
        fc.double({ min: Number.MIN_VALUE, max: Number.MAX_VALUE, noNaN: true }),
        (v) => {
          // Precondition: only test finite positive values
          fc.pre(Number.isFinite(v) && v > 0);
          expect(() => service.validateSqftPerHourPublic(v)).not.toThrow();
        },
      ),
      { numRuns: 500 },
    );
  });

  it('rejects NaN, Infinity, -Infinity, 0, and all negative numbers', () => {
    const service = makeTestableService();

    const invalidValues = [NaN, Infinity, -Infinity, 0, -0];

    for (const v of invalidValues) {
      expect(() => service.validateSqftPerHourPublic(v)).toThrow();
    }

    fc.assert(
      fc.property(
        fc.double({ max: 0, noNaN: true }),
        (v) => {
          // All non-positive finite doubles must be rejected
          fc.pre(Number.isFinite(v) && v <= 0);
          expect(() => service.validateSqftPerHourPublic(v)).toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 2: Rate injection is complete and non-overwriting
//
// For any set of rates and any initial context map, after injection:
//   - Every rate's variableName is present in the resulting map
//   - Keys already in the map retain their original value
//   - New keys map to the rate's sqftPerHour
//
// Validates: Requirements 3.1, 3.3
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 2: Rate injection is complete and non-overwriting', () => {
  it('injects all rate variables into an empty context', () => {
    fc.assert(
      fc.property(
        fc.array(arbProductivityRate, { minLength: 0, maxLength: 10 }),
        (rates) => {
          const context = new Map<string, number>();
          injectRates(context, rates);

          // Every rate's variableName must be present
          for (const rate of rates) {
            expect(context.has(rate.variableName)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('does not overwrite existing context values', () => {
    fc.assert(
      fc.property(
        fc.array(arbProductivityRate, { minLength: 1, maxLength: 10 }),
        fc.double({ min: 0.01, max: 99999, noNaN: true }),
        (rates, existingValue) => {
          fc.pre(Number.isFinite(existingValue) && existingValue > 0);

          // Pre-populate the context with the first rate's variableName
          const firstRate = rates[0];
          const context = new Map<string, number>([
            [firstRate.variableName, existingValue],
          ]);

          injectRates(context, rates);

          // The pre-existing value must not be overwritten
          expect(context.get(firstRate.variableName)).toBe(existingValue);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('maps new keys to the rate sqftPerHour value', () => {
    fc.assert(
      fc.property(
        fc.array(arbProductivityRate, { minLength: 1, maxLength: 10 }),
        (rates) => {
          const context = new Map<string, number>();
          injectRates(context, rates);

          // For each rate, if it was the first with that variableName, the
          // context value must equal the rate's sqftPerHour
          const seen = new Set<string>();
          for (const rate of rates) {
            if (!seen.has(rate.variableName)) {
              expect(context.get(rate.variableName)).toBe(rate.sqftPerHour);
              seen.add(rate.variableName);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('preserves all pre-existing context entries after injection', () => {
    fc.assert(
      fc.property(
        fc.array(arbProductivityRate, { minLength: 0, maxLength: 8 }),
        fc.dictionary(
          arbVariableName,
          fc.double({ min: 0.01, max: 99999, noNaN: true }),
          { minKeys: 0, maxKeys: 5 },
        ),
        (rates, initial) => {
          const context = new Map(Object.entries(initial));
          const snapshotBefore = new Map(context);

          injectRates(context, rates);

          // Every key that was in the initial map must still have its original value
          for (const [key, value] of snapshotBefore) {
            expect(context.get(key)).toBe(value);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 3: Formula evaluation with injected rate variables produces
//             correct arithmetic
//
// For any finite positive sqft and finite positive rate value, evaluating
// 'sqft / drywall_rate' with both in the context returns sqft / rate
// within floating-point precision.
//
// Validates: Requirements 3.2
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 3: Formula evaluation with injected rate variables produces correct arithmetic', () => {
  it('sqft / drywall_rate evaluates to sqft / rate within floating-point precision', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 100_000, noNaN: true }),
        fc.double({ min: 0.01, max: 10_000, noNaN: true }),
        (sqft, rate) => {
          fc.pre(Number.isFinite(sqft) && sqft > 0);
          fc.pre(Number.isFinite(rate) && rate > 0);

          const vars = new Map<string, number>([
            ['sqft', sqft],
            ['drywall_rate', rate],
          ]);

          const result = evaluateFormula('sqft / drywall_rate', vars);

          expect(result).toBeCloseTo(sqft / rate, 5);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('sqft * rate evaluates to the correct product', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 100_000, noNaN: true }),
        fc.double({ min: 0.01, max: 10_000, noNaN: true }),
        (sqft, rate) => {
          fc.pre(Number.isFinite(sqft) && sqft > 0);
          fc.pre(Number.isFinite(rate) && rate > 0);

          const vars = new Map<string, number>([
            ['sqft', sqft],
            ['paint_rate', rate],
          ]);

          const result = evaluateFormula('sqft * paint_rate', vars);

          expect(result).toBeCloseTo(sqft * rate, 5);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('formula with injected rates produces the same result as direct arithmetic', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 10_000, noNaN: true }),
        fc.double({ min: 1, max: 1_000, noNaN: true }),
        fc.double({ min: 1, max: 1_000, noNaN: true }),
        (sqft, rate1, rate2) => {
          fc.pre(Number.isFinite(sqft) && Number.isFinite(rate1) && Number.isFinite(rate2));
          fc.pre(sqft > 0 && rate1 > 0 && rate2 > 0);

          const context = new Map<string, number>([['sqft', sqft]]);
          const rates: Pick<ProductivityRate, 'variableName' | 'sqftPerHour'>[] = [
            { variableName: 'drywall_rate', sqftPerHour: rate1 },
            { variableName: 'paint_rate', sqftPerHour: rate2 },
          ];
          injectRates(context, rates);

          const result = evaluateFormula('sqft / drywall_rate + sqft / paint_rate', context);
          const expected = sqft / rate1 + sqft / rate2;

          expect(result).toBeCloseTo(expected, 4);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 6: D1 row serialization maps all fields correctly
//
// For any valid productivity rate row, mapRow produces a ProductivityRate
// where every camelCase field matches the corresponding snake_case column,
// with createdAt and updatedAt as valid Date instances.
//
// Validates: Requirements 7.3
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 6: D1 row serialization maps all fields correctly', () => {
  it('maps all snake_case columns to camelCase fields with correct types', () => {
    const service = makeTestableService();

    fc.assert(
      fc.property(arbRateRow, (row) => {
        const rate = service.mapRowPublic(row);

        // Direct field mappings
        expect(rate.id).toBe(row.id);
        expect(rate.variableName).toBe(row.variable_name);
        expect(rate.displayName).toBe(row.display_name);

        // sqft_per_hour must be converted via Number()
        expect(rate.sqftPerHour).toBe(Number(row.sqft_per_hour));
        expect(typeof rate.sqftPerHour).toBe('number');

        // description: null when absent or null, string otherwise
        if (row.description === null || row.description === undefined) {
          expect(rate.description).toBeNull();
        } else {
          expect(rate.description).toBe(row.description);
        }

        // Timestamps must be Date instances
        expect(rate.createdAt).toBeInstanceOf(Date);
        expect(rate.updatedAt).toBeInstanceOf(Date);

        // Timestamps must parse to the correct ISO string
        expect(rate.createdAt.toISOString()).toBe(new Date(row.created_at as string).toISOString());
        expect(rate.updatedAt.toISOString()).toBe(new Date(row.updated_at as string).toISOString());
      }),
      { numRuns: 200 },
    );
  });

  it('handles sqft_per_hour as a string (D1 may return REAL as string)', () => {
    const service = makeTestableService();

    fc.assert(
      fc.property(
        arbRateRow,
        fc.double({ min: 0.001, max: 100_000, noNaN: true }),
        (row, sqftValue) => {
          fc.pre(Number.isFinite(sqftValue) && sqftValue > 0);

          // Simulate D1 returning REAL as a string
          const rowWithStringRate = { ...row, sqft_per_hour: String(sqftValue) };
          const rate = service.mapRowPublic(rowWithStringRate);

          expect(typeof rate.sqftPerHour).toBe('number');
          expect(rate.sqftPerHour).toBeCloseTo(sqftValue, 5);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('maps null description to null', () => {
    const service = makeTestableService();

    fc.assert(
      fc.property(arbRateRow, (row) => {
        const rowWithNullDesc = { ...row, description: null };
        const rate = service.mapRowPublic(rowWithNullDesc);
        expect(rate.description).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it('maps undefined description to null', () => {
    const service = makeTestableService();

    fc.assert(
      fc.property(arbRateRow, (row) => {
        const { description: _omit, ...rowWithoutDesc } = row;
        const rate = service.mapRowPublic(rowWithoutDesc);
        expect(rate.description).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 7: Formula test panel variables include all loaded rates
//
// For any set of loaded ProductivityRate objects, the variables map passed
// to the formula evaluator contains an entry for every rate's variableName
// with the rate's sqftPerHour as the value.
//
// Validates: Requirements 6.1, 6.2
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 7: Formula test panel variables include all loaded rates', () => {
  it('all rate variableNames appear in the formula test variables map', () => {
    fc.assert(
      fc.property(
        fc.array(arbProductivityRate, { minLength: 0, maxLength: 10 }),
        (rates) => {
          const variables = buildFormulaTestVariables({}, rates);

          // Every rate's variableName must be present with its sqftPerHour value
          const seen = new Set<string>();
          for (const rate of rates) {
            if (!seen.has(rate.variableName)) {
              expect(variables[rate.variableName]).toBe(rate.sqftPerHour);
              seen.add(rate.variableName);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('base variables are not overwritten by rates with the same key', () => {
    fc.assert(
      fc.property(
        fc.array(arbProductivityRate, { minLength: 1, maxLength: 10 }),
        fc.double({ min: 0.01, max: 99999, noNaN: true }),
        (rates, baseValue) => {
          fc.pre(Number.isFinite(baseValue) && baseValue > 0);

          // Pre-populate base variables with the first rate's variableName
          const firstRate = rates[0];
          const baseVariables = { [firstRate.variableName]: baseValue };

          const variables = buildFormulaTestVariables(baseVariables, rates);

          // The base value must not be overwritten
          expect(variables[firstRate.variableName]).toBe(baseValue);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('sqft base variable is preserved when rates are merged', () => {
    fc.assert(
      fc.property(
        fc.array(arbProductivityRate, { minLength: 0, maxLength: 8 }),
        fc.double({ min: 100, max: 10_000, noNaN: true }),
        (rates, sqft) => {
          fc.pre(Number.isFinite(sqft) && sqft > 0);

          const baseVariables = { sqft };
          const variables = buildFormulaTestVariables(baseVariables, rates);

          // sqft must always be preserved
          expect(variables['sqft']).toBe(sqft);

          // All rate variables must also be present (unless they collide with sqft)
          const seen = new Set<string>();
          for (const rate of rates) {
            if (!seen.has(rate.variableName) && rate.variableName !== 'sqft') {
              expect(variables[rate.variableName]).toBe(rate.sqftPerHour);
              seen.add(rate.variableName);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('formula test panel can evaluate sqft / rate_variable after merging rates', () => {
    fc.assert(
      fc.property(
        fc.array(arbProductivityRate, { minLength: 1, maxLength: 5 }),
        fc.double({ min: 100, max: 10_000, noNaN: true }),
        (rates, sqft) => {
          fc.pre(Number.isFinite(sqft) && sqft > 0);

          const baseVariables = { sqft };
          const variables = buildFormulaTestVariables(baseVariables, rates);

          // Pick the first rate that doesn't collide with sqft
          const firstRate = rates.find((r) => r.variableName !== 'sqft');
          if (!firstRate) return; // skip if all rates happen to be named 'sqft'

          const formula = `sqft / ${firstRate.variableName}`;
          const context = new Map(Object.entries(variables));

          const result = evaluateFormula(formula, context);
          expect(result).toBeCloseTo(sqft / firstRate.sqftPerHour, 4);
        },
      ),
      { numRuns: 200 },
    );
  });
});
