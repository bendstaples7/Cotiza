import { describe, it, expect, beforeEach } from 'vitest';
import { MaterialPriceService } from '../../worker/src/services/material-price-service.js';
import type { QuoteLineItem, ProductCatalogEntry } from 'shared';

const DEFAULT_MARKUP = 1.3;

describe('MaterialPriceService', () => {
  let service: MaterialPriceService;

  beforeEach(() => {
    service = new MaterialPriceService();
  });

  const catalog: ProductCatalogEntry[] = [
    { id: 'p1', name: 'Drywall Installation', unitPrice: 1.50, description: 'Per sq ft', source: 'manual' },
    { id: 'p2', name: 'Interior Painting', unitPrice: 2.00, description: 'Per sq ft', source: 'manual' },
    { id: 'p3', name: 'Baseboard Installation', unitPrice: 3.50, description: 'Per linear ft', source: 'manual' },
  ];

  function makeLineItem(overrides: Partial<QuoteLineItem> = {}): QuoteLineItem {
    return {
      id: 'item-1',
      productCatalogEntryId: 'p1',
      productName: 'Drywall Installation',
      description: 'Living room walls',
      quantity: 1,
      unitPrice: 1.50,
      confidenceScore: 90,
      originalText: 'drywall in living room',
      resolved: true,
      ruleIdsApplied: [],
      ...overrides,
    };
  }

  describe('calculateMaterialPrices()', () => {
    it('applies default markup multiplier (1.3) to unit prices', () => {
      const items = [
        makeLineItem({ id: 'i1', productName: 'Drywall Installation', unitPrice: 1.50, productCatalogEntryId: 'p1' }),
        makeLineItem({ id: 'i2', productName: 'Interior Painting', unitPrice: 2.00, productCatalogEntryId: 'p2' }),
      ];

      const { adjustedItems, adjustments } = service.calculateMaterialPrices(items, catalog);

      expect(adjustedItems[0].unitPrice).toBe(1.95);  // 1.50 × 1.3
      expect(adjustedItems[1].unitPrice).toBe(2.60);  // 2.00 × 1.3
      expect(adjustments).toHaveLength(2);
      expect(adjustments[0].multiplierApplied).toBe(DEFAULT_MARKUP);
    });

    it('uses catalog unitPrice as the base when line item has a catalog match', () => {
      const items = [
        // Item has unitPrice 999, but catalog says 1.50 — should use 1.50 × 1.3
        makeLineItem({ id: 'i1', productName: 'Drywall Installation', unitPrice: 999, productCatalogEntryId: 'p1' }),
      ];

      const { adjustedItems, adjustments } = service.calculateMaterialPrices(items, catalog);

      expect(adjustedItems[0].unitPrice).toBe(1.95);  // catalog 1.50 × 1.3, not 999 × 1.3
      expect(adjustments[0].originalUnitPrice).toBe(1.50);
    });

    it('preserves line item ID and other fields', () => {
      const items = [
        makeLineItem({
          id: 'keep-id',
          productName: 'Baseboard Installation',
          description: 'Trim work',
          quantity: 10,
          confidenceScore: 85,
        }),
      ];

      const { adjustedItems } = service.calculateMaterialPrices(items, catalog);

      expect(adjustedItems[0].id).toBe('keep-id');
      expect(adjustedItems[0].description).toBe('Trim work');
      expect(adjustedItems[0].quantity).toBe(10);
      expect(adjustedItems[0].confidenceScore).toBe(85);
    });

    it('supports custom markup multiplier', () => {
      const items = [
        makeLineItem({ id: 'i1', productName: 'Drywall Installation', unitPrice: 1.50, productCatalogEntryId: 'p1' }),
      ];

      const { adjustedItems, adjustments } = service.calculateMaterialPrices(items, catalog, 1.5);

      expect(adjustedItems[0].unitPrice).toBe(2.25);  // 1.50 × 1.5
      expect(adjustments[0].multiplierApplied).toBe(1.5);
    });

    it('rounds prices to 2 decimal places', () => {
      const items = [
        makeLineItem({ id: 'i1', productName: 'Baseboard Installation', unitPrice: 3.50, productCatalogEntryId: 'p3' }),
      ];

      const { adjustedItems } = service.calculateMaterialPrices(items, catalog);

      expect(adjustedItems[0].unitPrice).toBe(4.55);  // 3.50 × 1.3 = 4.55
    });

    it('handles empty line items list', () => {
      const { adjustedItems, adjustments } = service.calculateMaterialPrices([], catalog);

      expect(adjustedItems).toHaveLength(0);
      expect(adjustments).toHaveLength(0);
    });

    it('handles items not in catalog (no match)', () => {
      const items = [
        makeLineItem({ id: 'i1', productName: 'Unknown Product', unitPrice: 10.00, productCatalogEntryId: null }),
      ];

      const { adjustedItems, adjustments } = service.calculateMaterialPrices(items, catalog);

      // Falls back to the item's own unitPrice
      expect(adjustedItems[0].unitPrice).toBe(13.00);  // 10.00 × 1.3
      expect(adjustments[0].originalUnitPrice).toBe(10.00);
    });
  });
});
