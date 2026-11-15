import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { executeRules } from '../../worker/src/services/rules-engine.js';
import type { EngineLineItem, StructuredRule } from 'shared';

const PRODUCT = 'Drywall: Installation of New Drywall';
const RATE = 40;

// Read the real migration 0082 so this test tracks the seeded rules
// (same approach as tests/unit/review-feedback.test.ts:256).
const migrationSql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../worker/src/migrations/0082_drywall_patch_rules.sql'),
  'utf8',
);

const unquote = (s: string) => s.replace(/''/g, "'");
const conditionOf = (sql: string) => JSON.parse(unquote(sql.match(/'(\{(?:[^']|'')*\})'/)![1]));
const actionsOf = (sql: string) => JSON.parse(unquote(sql.match(/'(\[(?:[^']|'')*\])'/)![1]));

const insertSql = migrationSql.split('UPDATE rules')[0];
const updateSql = migrationSql.slice(migrationSql.indexOf('UPDATE rules'));

// Migration 0032 rule, updated by 0082: whole-room sqft, excluding patch/repair wording.
const sqftRule: StructuredRule = {
  id: 'cq-drywall-install',
  name: 'Compute Drywall Labor Hours from Sqft',
  priorityOrder: 20,
  triggerMode: 'on_create',
  condition: conditionOf(updateSql),
  actions: [{ type: 'compute_quantity', productNamePattern: PRODUCT, formula: 'sqft / drywall_rate', matchMode: 'exact' }],
};

// Migration 0082 rule: measured patch area (priority 30, runs after the sqft rule and wins).
const patchRule: StructuredRule = {
  id: 'cq-drywall-patch-measured',
  name: 'Compute Drywall Patch Hours from Measured Area',
  priorityOrder: 30,
  triggerMode: 'on_create',
  condition: conditionOf(insertSql),
  actions: actionsOf(insertSql),
};

const lineItem = (): EngineLineItem => ({
  id: 'li-drywall',
  productCatalogEntryId: null,
  productName: PRODUCT,
  description: '',
  quantity: 1,
  unitPrice: 50,
  confidenceScore: 100,
  originalText: '',
  ruleIdsApplied: [],
});

function quantityFor(customerRequestText: string): number {
  const result = executeRules({
    lineItems: [lineItem()],
    rules: [sqftRule, patchRule],
    catalog: [],
    customerRequestText,
    preResolvedContext: new Map([['drywall_rate', RATE]]),
  });
  return result.lineItems.find((li) => li.productName === PRODUCT)!.quantity;
}

describe('drywall patch-quantity rule (migration 0082)', () => {
  it('bills the measured patch area, not whole-room sqft (90 ft x 1 ft -> 2, not 23)', () => {
    const q = quantityFor('Vinyl flooring for 930 sq ft; drywall repair 90 feet wide by 1 ft tall.');
    expect(q).toBe(Math.round((90 * 1) / RATE));
    expect(q).not.toBe(Math.round(930 / RATE));
  });

  it('keeps sqft / rate for new drywall with no patch measurement (400 sq ft -> 10)', () => {
    expect(quantityFor('Install new drywall, 400 sq ft.')).toBe(Math.round(400 / RATE));
  });

  it('does not bill whole-room sqft for an unmeasured patch (drywall patch + 930 sq ft -> not 23)', () => {
    const q = quantityFor('Need a drywall patch; 930 sq ft of flooring is being replaced.');
    expect(q).not.toBe(Math.round(930 / RATE));
    expect(q).toBe(1);
  });
});
