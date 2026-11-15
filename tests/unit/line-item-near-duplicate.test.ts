import { describe, it, expect } from 'vitest';
import { deduplicateLineItems } from '../../worker/src/services/line-item-utils.js';

const line = (productName: string, quantity: number, extra: Record<string, unknown> = {}) => ({
  productName,
  description: '',
  quantity,
  unitPrice: 50,
  confidenceScore: 80,
  originalText: productName,
  ...extra,
});

describe('deduplicateLineItems near-duplicates', () => {
  it('collapses "Install Baseboard Trim" into "Install Baseboard Trim and Shoe"', () => {
    const out = deduplicateLineItems([
      line('Install Baseboard Trim', 6),
      line('Install Baseboard Trim and Shoe', 6, { ruleIdsApplied: ['r1'] }),
      line('Vinyl Flooring', 930),
    ]);
    expect(out.map((item) => item.productName)).toEqual(['Install Baseboard Trim and Shoe', 'Vinyl Flooring']);
    expect(out[0].quantity).toBe(6);
    expect(out[0].ruleIdsApplied).toEqual(['r1']);
  });

  it('keeps near-duplicates in different spaces apart', () => {
    const out = deduplicateLineItems([
      line('Install Baseboard Trim', 6, { description: 'Basement - trim' }),
      line('Install Baseboard Trim and Shoe', 6, { description: 'Kitchen - trim' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('keeps lines whose names only share a word', () => {
    const out = deduplicateLineItems([line('Install Baseboard', 6), line('Install Baseboards Paint', 6)]);
    expect(out).toHaveLength(2);
  });

  it('keeps the larger quantity when collapsing', () => {
    const out = deduplicateLineItems([
      line('Install Baseboard Trim', 8),
      line('Install Baseboard Trim and Shoe', 6),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].quantity).toBe(8);
  });

  it('folds "Install Tile" into "Install Tile & Grout" and "Install Tile with Grout"', () => {
    const withAmpersand = deduplicateLineItems([
      line('Install Tile', 6),
      line('Install Tile & Grout', 6),
    ]);
    expect(withAmpersand.map((item) => item.productName)).toEqual(['Install Tile & Grout']);

    const withWith = deduplicateLineItems([
      line('Install Tile', 6),
      line('Install Tile with Grout', 6),
    ]);
    expect(withWith.map((item) => item.productName)).toEqual(['Install Tile with Grout']);
  });

  it('keeps the rule-priced short line when the long line has no rules', () => {
    const out = deduplicateLineItems([
      line('Install Baseboard Trim', 5, { ruleIdsApplied: ['r9'], unitPrice: 40 }),
      line('Install Baseboard Trim and Shoe', 7, { unitPrice: 50 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].productName).toBe('Install Baseboard Trim');
    expect(out[0].unitPrice).toBe(40);
    expect(out[0].quantity).toBe(7);
    expect(out[0].ruleIdsApplied).toEqual(['r9']);
  });
});
