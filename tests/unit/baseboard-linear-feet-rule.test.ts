import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { executeRules } from '../../worker/src/services/rules-engine.js';
import type { EngineLineItem, StructuredRule } from 'shared';

// Read the real migration 0081 so this test tracks the seeded rules
// (same approach as tests/unit/review-feedback.test.ts:256).
const migrationSql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../worker/src/migrations/0081_baseboard_linear_feet_rules.sql'),
  'utf8',
);

function parseInsertedRule(line: string): StructuredRule {
  const header = line.match(/VALUES\s*\('((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'/)!;
  const unquote = (s: string) => s.replace(/''/g, "'");
  return {
    id: unquote(header[1]),
    name: unquote(header[2]),
    priorityOrder: Number(line.match(/\(SELECT[^)]*\)\s*,\s*(\d+)/)![1]),
    triggerMode: line.match(/'(chained|on_create)'/)![1] as StructuredRule['triggerMode'],
    condition: JSON.parse(unquote(line.match(/'(\{(?:[^']|'')*\})'/)![1])),
    actions: JSON.parse(unquote(line.match(/'(\[(?:[^']|'')*\])'/)![1])),
  };
}

// Migration 0081 rules: stated baseboard feet (priorities 45/60/61/62).
const statedFeetRules: StructuredRule[] = migrationSql
  .split('\n')
  .filter((line) => line.trimStart().startsWith('INSERT'))
  .map(parseInsertedRule);

const SUPPLIES = 'Materials: Baseboard Supplies';
const TRIM = 'Carpentry: Install Baseboard Trim';
const SHOE = 'Carpentry: Install Baseboard Shoe';
const TRIM_AND_SHOE = 'Carpentry: Install Baseboard Trim and Shoe';
const PRODUCTS = [SUPPLIES, TRIM, SHOE, TRIM_AND_SHOE] as const;

const SQFT = '(\\d[\\d,]*)\\s*(?:sq\\.?\\s*ft|square\\s*feet|sqft)';
const exists = (productNamePattern: string) => ({ type: 'line_item_exists' as const, productNamePattern, matchMode: 'exact' as const });
const extractSqft = { type: 'request_text_extract' as const, pattern: SQFT, variableName: 'sqft' };

// Migration 0044 rule: sqft / 2.5 fallback (priority 44, chained).
const fallbackRule: StructuredRule = {
  id: 'cq-materials-baseboard-trim-shoe',
  name: 'Baseboard Supplies from Sqft',
  priorityOrder: 44,
  triggerMode: 'chained',
  condition: { type: 'compound', conditions: [exists(SUPPLIES), extractSqft] },
  actions: [{ type: 'compute_quantity', productNamePattern: SUPPLIES, formula: 'sqft / 2.5', matchMode: 'exact' }],
};

// Migration 0040 install fallbacks: sqft / 2.5 / baseboard_rate (priorities 57/58/59, on_create).
const installFallback = (id: string, priorityOrder: number, productNamePattern: string): StructuredRule => ({
  id,
  name: `${productNamePattern} from Sqft`,
  priorityOrder,
  triggerMode: 'on_create',
  condition: { type: 'compound', conditions: [exists(productNamePattern), extractSqft] },
  actions: [{ type: 'compute_quantity', productNamePattern, formula: 'sqft / 2.5 / baseboard_rate', matchMode: 'exact' }],
});

const fallbackRules: StructuredRule[] = [
  fallbackRule,
  installFallback('cq-baseboard-trim', 57, TRIM),
  installFallback('cq-baseboard-shoe', 58, SHOE),
  installFallback('cq-baseboard-trim-and-shoe', 59, TRIM_AND_SHOE),
];

const lineItem = (productName: string, i: number): EngineLineItem => ({
  id: `li-${i}`,
  productCatalogEntryId: null,
  productName,
  description: '',
  quantity: 1,
  unitPrice: 50,
  confidenceScore: 100,
  originalText: '',
  ruleIdsApplied: [],
});

function quantitiesFor(customerRequestText: string): Record<string, number> {
  const result = executeRules({
    lineItems: PRODUCTS.map((productName, i) => lineItem(productName, i)),
    rules: [...fallbackRules, ...statedFeetRules],
    catalog: [],
    customerRequestText,
    preResolvedContext: new Map([['baseboard_rate', 20]]),
  });
  const quantities: Record<string, number> = {};
  for (const li of result.lineItems) quantities[li.productName] = li.quantity;
  return quantities;
}

describe('baseboard linear-feet rule (migration 0081)', () => {
  it('uses stated baseboard feet over sqft (830 ft of baseboard + 930 sq ft -> 830)', () => {
    const q = quantitiesFor('Install about 830 ft of baseboard, 930 sq ft total.');
    expect(q[SUPPLIES]).toBe(830);
    expect(q[TRIM]).toBe(Math.round(830 / 20));
    expect(q[SHOE]).toBe(Math.round(830 / 20));
    expect(q[TRIM_AND_SHOE]).toBe(Math.round(830 / 20));
  });

  it('falls back to sqft / 2.5 when no baseboard feet are stated (930 sq ft -> 372)', () => {
    const q = quantitiesFor('Paint the walls in the 930 sq ft room.');
    expect(q[SUPPLIES]).toBe(372);
    expect(q[TRIM]).toBe(Math.round(372 / 20));
    expect(q[SHOE]).toBe(Math.round(372 / 20));
    expect(q[TRIM_AND_SHOE]).toBe(Math.round(372 / 20));
  });

  it('does not read drywall feet as baseboard feet (90 feet wide -> not 90)', () => {
    const q = quantitiesFor('Walls are 90 feet wide by 1 ft tall; 43 ft wide. Install baseboard.')[SUPPLIES];
    expect(q).toBe(1);
  });
});