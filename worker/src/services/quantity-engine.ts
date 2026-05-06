/**
 * Quantity Engine — predicts line item quantities from historical quote data.
 *
 * Pipeline:
 * 1. During corpus sync: extract product-quantity pairs from quote messages
 * 2. At quote generation: predict quantities using similarity-weighted historical data
 * 3. Apply predictions above confidence threshold before rules engine executes
 */

import type { EngineLineItem, QuantityPredictionMeta } from 'shared';
import type { SimilarQuoteResult } from './similarity-engine.js';
import { parseLineItems } from './line-item-parser.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QuantityPrediction {
  productName: string;
  predictedQuantity: number;
  confidenceScore: number;
  sourceQuotes: SourceQuoteRef[];
  dataPointCount: number;
}

export interface SourceQuoteRef {
  quoteNumber: string;
  quantity: number;
  similarityScore: number;
}

export interface QuantityEngineConfig {
  confidenceThreshold: number;
}

export type { QuantityPredictionMeta };

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

export interface ConfidenceInput {
  sampleSize: number;
  coefficientOfVariation: number;
}

/**
 * Compute confidence score based on sample size and variance.
 *
 * Algorithm:
 * 1. Base score from sample size: min(100, sampleSize * 10)
 * 2. Apply sample-size caps:
 *    - sampleSize < 2: return 0
 *    - sampleSize < 5: cap at 60
 * 3. Apply variance penalty:
 *    - CV > 0.5: subtract max(30, CV * 40) from base
 *    - CV 0.3–0.5: subtract CV * 20 from base
 * 4. Clamp to [0, 100]
 *
 * Returns integer in [0, 100].
 */
export function computeConfidence(input: ConfidenceInput): number {
  const { sampleSize, coefficientOfVariation: cv } = input;

  // Hard floor: fewer than 2 samples means no confidence
  if (sampleSize < 2) return 0;

  // Base score from sample size
  let base = Math.min(100, sampleSize * 10);

  // Cap for small sample sizes
  if (sampleSize < 5) {
    base = Math.min(base, 60);
  }

  // Apply variance penalty
  let penalty = 0;
  if (cv > 0.5) {
    penalty = Math.max(30, cv * 40);
  } else if (cv >= 0.3) {
    penalty = cv * 20;
  }

  const score = Math.round(base - penalty);
  return Math.max(0, Math.min(100, score));
}

// ---------------------------------------------------------------------------
// Weighted median
// ---------------------------------------------------------------------------

/**
 * Compute similarity-weighted median of quantity values.
 *
 * Algorithm:
 * 1. Sort (quantity, weight) pairs by quantity ascending
 * 2. Compute cumulative weight
 * 3. Find the quantity where cumulative weight reaches 50% of total weight
 * 4. If the 50% mark falls exactly between two quantities, take the lower
 *
 * Precondition: dataPoints is non-empty, all weights > 0, all quantities > 0
 */
export function weightedMedian(
  dataPoints: Array<{ quantity: number; weight: number }>,
): number {
  if (dataPoints.length === 0) {
    throw new Error('weightedMedian requires at least one data point');
  }

  if (dataPoints.length === 1) {
    return dataPoints[0].quantity;
  }

  // Sort by quantity ascending
  const sorted = [...dataPoints].sort((a, b) => a.quantity - b.quantity);

  const totalWeight = sorted.reduce((sum, dp) => sum + dp.weight, 0);
  const halfWeight = totalWeight / 2;

  let cumulative = 0;
  for (const dp of sorted) {
    cumulative += dp.weight;
    if (cumulative >= halfWeight) {
      return dp.quantity;
    }
  }

  // Fallback (should not reach here with valid input)
  return sorted[sorted.length - 1].quantity;
}

// ---------------------------------------------------------------------------
// QuantityEngine class
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: QuantityEngineConfig = {
  confidenceThreshold: 50,
};

export class QuantityEngine {
  private readonly db: D1Database;
  private readonly config: QuantityEngineConfig;

  constructor(db: D1Database, config?: Partial<QuantityEngineConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** The confidence threshold above which predictions are applied */
  get confidenceThreshold(): number {
    return this.config.confidenceThreshold;
  }

  /**
   * Predict quantities for line items based on historical data from similar quotes.
   * Returns predictions only for products with sufficient historical data (≥ 2 points).
   * Returns empty array on any error (graceful degradation).
   */
  async predictQuantities(
    lineItems: EngineLineItem[],
    similarQuotes: SimilarQuoteResult[],
  ): Promise<QuantityPrediction[]> {
    try {
      // No similar quotes → skip prediction entirely
      if (!similarQuotes || similarQuotes.length === 0) return [];
      if (!lineItems || lineItems.length === 0) return [];

      // Build a map of source_quote_id → similarity score for weighting
      const quoteScoreMap = new Map<string, number>();
      for (const sq of similarQuotes) {
        quoteScoreMap.set(sq.jobberQuoteId, sq.similarityScore);
      }

      const sourceQuoteIds = Array.from(quoteScoreMap.keys());
      if (sourceQuoteIds.length === 0) return [];

      const predictions: QuantityPrediction[] = [];

      for (const lineItem of lineItems) {
        const prediction = await this.predictForProduct(
          lineItem.productName,
          sourceQuoteIds,
          quoteScoreMap,
        );
        if (prediction) {
          predictions.push(prediction);
        }
      }

      return predictions;
    } catch (err) {
      console.error(
        '[QuantityEngine] Prediction failed:',
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  }

  /**
   * Extract line items from historical quotes and store in quantity_history.
   * Called during quote corpus sync.
   *
   * Accepts structured line item data (from Jobber GraphQL) OR falls back to
   * parsing the message field for legacy/text-based formats.
   */
  async extractAndStore(
    quotes: Array<{
      jobberQuoteId: string;
      quoteNumber: string;
      message: string | null;
      lineItems?: Array<{ name: string; quantity: number }>;
    }>,
  ): Promise<{ extracted: number; skipped: number }> {
    let extracted = 0;
    let skipped = 0;

    for (const quote of quotes) {
      try {
        // Prefer structured line items from Jobber GraphQL when available
        let items: Array<{ productName: string; quantity: number }>;

        if (quote.lineItems && quote.lineItems.length > 0) {
          items = quote.lineItems
            .filter(li => li.name && isValidQuantity(li.quantity))
            .map(li => ({ productName: li.name, quantity: li.quantity }));
        } else if (quote.message) {
          // Fallback: parse from message text (legacy path)
          items = parseLineItems(quote.message);
        } else {
          skipped++;
          continue;
        }

        if (items.length === 0) {
          skipped++;
          continue;
        }

        for (const item of items) {
          // Only store positive finite quantities
          if (!isValidQuantity(item.quantity)) continue;

          const id = `${quote.jobberQuoteId}:${item.productName}`;
          await this.db
            .prepare(
              `INSERT INTO quantity_history (id, product_name, quantity, source_quote_id, source_quote_number, context_text)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(product_name, source_quote_id) DO UPDATE SET
                 quantity = excluded.quantity,
                 source_quote_number = excluded.source_quote_number,
                 context_text = excluded.context_text,
                 extracted_at = datetime('now')`,
            )
            .bind(
              id,
              item.productName,
              item.quantity,
              quote.jobberQuoteId,
              quote.quoteNumber,
              quote.message ?? null,
            )
            .run();

          extracted++;
        }
      } catch (err) {
        console.warn(
          '[QuantityEngine] Extraction failed for quote',
          quote.quoteNumber,
          err instanceof Error ? err.message : err,
        );
        skipped++;
      }
    }

    return { extracted, skipped };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Predict quantity for a single product by querying ALL quantity_history
   * records for matching products. Data points from similar quotes get
   * higher weight (their similarity score), while other historical data
   * gets a base weight of 0.1 to still contribute to the prediction.
   */
  private async predictForProduct(
    productName: string,
    sourceQuoteIds: string[],
    quoteScoreMap: Map<string, number>,
  ): Promise<QuantityPrediction | null> {
    // Use case-insensitive prefix matching consistent with matchesProductName
    const pattern = productName.toLowerCase() + '%';

    // Query ALL quantity_history records for this product (no source_quote_id filter)
    const query = `
      SELECT product_name, quantity, source_quote_id, source_quote_number
      FROM quantity_history
      WHERE product_name LIKE ? COLLATE NOCASE
    `;

    const result = await this.db
      .prepare(query)
      .bind(pattern)
      .all();

    if (!result.results || result.results.length < 2) {
      return null; // Need at least 2 data points
    }

    const rows = result.results as Array<{
      product_name: string;
      quantity: number;
      source_quote_id: string;
      source_quote_number: string;
    }>;

    // Build weighted data points — similar quotes get their similarity score as weight,
    // other historical data gets a base weight so it still contributes
    const BASE_WEIGHT = 0.1;
    const dataPoints: Array<{ quantity: number; weight: number }> = [];
    const sourceQuotes: SourceQuoteRef[] = [];

    for (const row of rows) {
      const similarityScore = quoteScoreMap.get(row.source_quote_id) ?? 0;
      const weight = similarityScore > 0 ? similarityScore : BASE_WEIGHT;

      dataPoints.push({ quantity: row.quantity, weight });
      sourceQuotes.push({
        quoteNumber: row.source_quote_number,
        quantity: row.quantity,
        similarityScore: similarityScore > 0 ? similarityScore : 0,
      });
    }

    if (dataPoints.length < 2) return null;

    // Compute predicted quantity via weighted median
    const predictedQuantity = weightedMedian(dataPoints);

    // Compute confidence score
    const quantities = dataPoints.map((dp) => dp.quantity);
    const mean = quantities.reduce((s, q) => s + q, 0) / quantities.length;
    const variance =
      quantities.reduce((s, q) => s + (q - mean) ** 2, 0) / quantities.length;
    const stdDev = Math.sqrt(variance);
    const cv = mean > 0 ? stdDev / mean : 0;

    const confidenceScore = computeConfidence({
      sampleSize: dataPoints.length,
      coefficientOfVariation: cv,
    });

    return {
      productName,
      predictedQuantity,
      confidenceScore,
      sourceQuotes,
      dataPointCount: dataPoints.length,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidQuantity(qty: number): boolean {
  return typeof qty === 'number' && isFinite(qty) && qty > 0;
}
