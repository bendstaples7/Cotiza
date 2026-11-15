import { describe, it, expect } from 'vitest';
import { executeRules } from '../../worker/src/services/rules-engine.js';
import type { EngineLineItem, StructuredRule } from 'shared';

const LF = '(\\d[\\d,]*)\\s*(?:linear\\s+feet|lin\\.?\\s*ft|\\blf\\b|ft|feet|foot)\\s*(?:of\\s+|in\\s+)?baseboard';
const PRODUCT = 'Materials: Baseboard Supplies';
const extraction = (pattern: string, variableName: string) => ({ type: 'request_text_extract' as const, pattern, variableName });
const exists = { type: 'line_item_exists' as const, productNamePattern: PRODUCT, matchMode: 'exact' as const };

// Migration 0081 rule: stated baseboard feet (priority 45, chained).
const statedFeetRule: StructuredRule = {
  id: 'cq-baseboard-supplies-lf',
  name: 'Baseboard Supplies from Stated Feet',
  priorityOrder: 45,
  triggerMode: 'chained',
  condition: { type: 'compound', conditions: [exists, extraction(LF, 'baseboard_lf')] },
  actions: [{ type: 'compute_quantity', productNamePattern: PRODUCT, formula: 'baseboard_lf', matchMode: 'exact' }],
};

// Migration 0044 rule: sqft / 2.5 fallback (priority 44, chained).
const fallbackRule: StructuredRule = {
  id: 'cq-materials-baseboard-trim-shoe',
  name: 'Baseboard Supplies from Sqft',
  priorityOrder: 44,
  triggerMode: 'chained',
  condition: { type: 'compound', conditions: [exists, extraction('(\\d[\\d,]*)\\s*(?:sq\\.?\\s*ft|square\\s*feet|sqft)', 'sqft')] },
  actions: [{ type: 'compute_quantity', productNamePattern: PRODUCT, formula: 'sqft / 2.5', matchMode: 'exact' }],
};

const lineItem = (): EngineLineItem => ({
  id: 'li-baseboard-supplies',
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
    rules: [fallbackRule, statedFeetRule],
    catalog: [],
    customerRequestText,
  });
  return result.lineItems.find((li) => li.productName === PRODUCT)!.quantity;
}

describe('baseboard linear-feet rule (migration 0081)', () => {
  it('uses stated baseboard feet over sqft (830 ft of baseboard + 930 sq ft -> 830)', () => {
    expect(quantityFor('Install about 830 ft of baseboard, 930 sq ft total.')).toBe(830);
  });

  it('falls back to sqft / 2.5 when no baseboard feet are stated (930 sq ft -> 372)', () => {
    expect(quantityFor('Paint the walls in the 930 sq ft room.')).toBe(372);
  });

  it('does not read drywall feet as baseboard feet (90 feet wide -> not 90)', () => {
    const q = quantityFor('Walls are 90 feet wide by 1 ft tall; 43 ft wide. Install baseboard.');
    expect(q).not.toBe(90);
  });
});
