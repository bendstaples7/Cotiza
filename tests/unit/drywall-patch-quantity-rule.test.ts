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
const priorityOf = (sql: string) =>
  Number((sql.match(/\(SELECT[^)]*\)\s*,\s*(\d+)/) ?? sql.match(/priority_order\s*=\s*(\d+)/))![1]);

const insertSql = migrationSql.split('UPDATE rules')[0];
const updateSql = migrationSql.slice(migrationSql.indexOf('UPDATE rules'));
const [patchSql, repairSql] = insertSql.split('INSERT OR IGNORE INTO rules').slice(1);

// Migration 0032 rule, updated by 0082: whole-room sqft, excluding patch/repair wording.
const sqftRule: StructuredRule = {
  id: 'cq-drywall-install',
  name: 'Compute Drywall Labor Hours from Sqft',
  priorityOrder: priorityOf(updateSql),
  triggerMode: 'on_create',
  condition: conditionOf(updateSql),
  actions: [{ type: 'compute_quantity', productNamePattern: PRODUCT, formula: 'sqft / drywall_rate', matchMode: 'exact' }],
};

// Migration 0082 rules: measured patch/repair area (run after the sqft rule and win).
const patchRule: StructuredRule = {
  id: 'cq-drywall-patch-measured',
  name: 'Compute Drywall Patch Hours from Measured Area',
  priorityOrder: priorityOf(patchSql),
  triggerMode: 'on_create',
  condition: conditionOf(patchSql),
  actions: actionsOf(patchSql),
};

const repairRule: StructuredRule = {
  id: 'cq-drywall-repair-measured',
  name: 'Compute Drywall Repair Hours from Measured Area',
  priorityOrder: priorityOf(repairSql),
  triggerMode: 'on_create',
  condition: conditionOf(repairSql),
  actions: actionsOf(repairSql),
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
    rules: [sqftRule, patchRule, repairRule],
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

  it('keeps sqft / rate for new drywall with wall dimensions (400 sq ft + 20 ft x 8 ft wall)', () => {
    expect(quantityFor('Install new drywall, 400 sq ft; wall is 20 ft wide by 8 ft tall.')).toBe(Math.round(400 / RATE));
  });

  it('pairs dimensions positionally (10 ft long by 2 ft wide -> 1)', () => {
    expect(quantityFor('Drywall patch 10 ft long by 2 ft wide.')).toBe(Math.round(20 / RATE));
  });

  it('bills decimal measured repair area (12.5 ft wide by 8 ft tall -> 3)', () => {
    expect(quantityFor('Drywall repair 12.5 ft wide by 8 ft tall.')).toBe(Math.round((12.5 * 8) / RATE));
  });

  it('measured patch beats whole-room sqft (930 sq ft + 90 ft x 1 ft patch -> 2)', () => {
    expect(quantityFor('Install drywall 930 sq ft; patch 90 feet wide by 1 ft tall.')).toBe(Math.round(90 / RATE));
  });
});