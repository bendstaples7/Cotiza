import type { QuoteLineItem, ProductCatalogEntry } from 'shared';

/**
 * Default markup multiplier applied to base catalog unit prices when
 * material price mode is enabled.
 *
 * 1.3 = 30% markup over base cost (covers overhead, profit margin).
 * This value is used as the default formula when no per-product rule exists.
 */
const DEFAULT_MARKUP_MULTIPLIER = 1.3;

/**
 * Result of applying material price calculation to a single line item.
 */
export interface MaterialPriceAdjustment {
  /** The line item's product name (for identification). */
  productName: string;
  /** The original unit price from the catalog. */
  originalUnitPrice: number;
  /** The calculated material price after markup. */
  calculatedUnitPrice: number;
  /** The multiplier that was applied. */
  multiplierApplied: number;
}

/**
 * Service for calculating material prices in quotes.
 *
 * When material price mode is enabled, this service applies a predefined
 * markup formula to each line item's unit price. The base price comes from
 * the product catalog, and the markup covers material handling, waste,
 * consumables, and profit margin.
 *
 * The calculation can be extended in the future to support:
 * - Per-product markup multipliers (from a material_price_rules table)
 * - External pricing data sources (supplier API lookups)
 * - Volume-based pricing tiers
 *
 * Currently uses a simple flat markup multiplier (default: 1.3 = 30% markup).
 */
export class MaterialPriceService {
  /**
   * Apply material price calculation to quote line items.
   *
   * @param lineItems - The resolved (matched) line items from the quote draft.
   * @param catalog - The full product catalog, used to look up base unit prices.
   * @param markupMultiplier - Optional override for the markup multiplier (default: 1.3).
   * @returns The adjusted line items with recalculated unitPrices,
   *          plus a record of adjustments made.
   */
  calculateMaterialPrices(
    lineItems: QuoteLineItem[],
    catalog: ProductCatalogEntry[],
    markupMultiplier: number = DEFAULT_MARKUP_MULTIPLIER,
  ): { adjustedItems: QuoteLineItem[]; adjustments: MaterialPriceAdjustment[] } {
    const catalogByName = new Map(
      catalog.map((p) => [p.name.trim().toLowerCase(), p]),
    );

    const adjustments: MaterialPriceAdjustment[] = [];

    const adjustedItems = lineItems.map((item) => {
      const catalogEntry = catalogByName.get(item.productName.trim().toLowerCase());

      // If we can find the catalog entry, use its unitPrice as the base
      const baseUnitPrice = catalogEntry?.unitPrice ?? item.unitPrice;
      const calculatedPrice = this.roundPrice(baseUnitPrice * markupMultiplier);

      adjustments.push({
        productName: item.productName,
        originalUnitPrice: baseUnitPrice,
        calculatedUnitPrice: calculatedPrice,
        multiplierApplied: markupMultiplier,
      });

      return {
        ...item,
        unitPrice: calculatedPrice,
      };
    });

    return { adjustedItems, adjustments };
  }

  /**
   * Round a price to 2 decimal places for currency display.
   */
  private roundPrice(price: number): number {
    return Math.round(price * 100) / 100;
  }
}
