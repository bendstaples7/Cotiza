# Implementation Plan: Quantity Engine

## Overview

Implement the Quantity Engine service that predicts line item quantities from historical quote data. The implementation follows the pipeline: extraction during corpus sync → storage in quantity_history → prediction at quote generation time → application before rules engine. TypeScript throughout, integrating with the existing Cloudflare Workers + D1 architecture.

## Tasks

- [x] 1. Create database migration and shared types
  - [x] 1.1 Create the quantity_history D1 migration
    - Create `worker/src/migrations/0028_quantity_history.sql`
    - Define the `quantity_history` table with columns: id (TEXT PK), product_name (TEXT NOT NULL), quantity (REAL NOT NULL CHECK > 0), source_quote_id (TEXT NOT NULL), source_quote_number (TEXT), context_text (TEXT), extracted_at (TEXT NOT NULL DEFAULT datetime('now'))
    - Add UNIQUE constraint on (product_name, source_quote_id) for upsert support
    - Add COLLATE NOCASE index on product_name for case-insensitive prefix lookups
    - Add index on source_quote_id
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 1.4_

  - [x] 1.2 Add shared types for quantity prediction metadata
    - Add `QuantitySource` type ('ai_estimate' | 'historical_prediction' | 'rule_override') to `shared/src/types/quote.ts`
    - Add `QuantityPredictionMeta` interface (predictedQuantity, confidenceScore, sourceQuoteNumbers, quantitySource) to `shared/src/types/quote.ts`
    - Add optional `quantityPrediction?: QuantityPredictionMeta` field to the `EngineLineItem` interface
    - Add optional `quantityPrediction?: QuantityPredictionMeta` field to the `QuoteLineItem` interface
    - Export new types from `shared/src/types/index.ts`
    - _Requirements: 8.1, 8.2, 3.3_

- [x] 2. Implement the LineItemParser module
  - [x] 2.1 Create the line-item-parser module
    - Create `worker/src/services/line-item-parser.ts`
    - Implement `parseLineItems(message: string): ParsedLineItem[]` supporting em-dash format ("ProductName — Quantity x UnitPrice"), tab-separated, and comma-separated formats
    - Implement `printLineItems(items: ParsedLineItem[]): string` for canonical output format
    - Export `ParsedLineItem` interface (productName, quantity, unitPrice?)
    - The parser must never throw — return empty array for unparseable input
    - Skip lines that don't match any known format without error
    - Discard entries where quantity is not a positive finite number
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 5.3_

  - [ ]* 2.2 Write property tests for parser round-trip
    - **Property 1: Parser Round-Trip**
    - **Validates: Requirements 9.4, 9.5**
    - Create `tests/property/quantity-engine.property.test.ts`
    - For any valid set of parsed line items (non-empty product names without line-break/em-dash chars, positive finite quantities), `parseLineItems(printLineItems(items))` produces equivalent product-quantity pairs

  - [ ]* 2.3 Write property tests for parser format extraction
    - **Property 2: Parser Extracts Correctly from Supported Formats**
    - **Validates: Requirements 9.1, 9.2**
    - For any product name (non-empty, no special delimiters) and positive finite quantity, formatting in any supported format and parsing extracts the original product name and quantity

  - [ ]* 2.4 Write property test for non-parseable input
    - **Property 3: Non-Parseable Input Produces Empty Result**
    - **Validates: Requirements 1.3, 9.3**
    - For any string without recognizable line item patterns, the parser returns an empty array without throwing

  - [ ]* 2.5 Write unit tests for LineItemParser
    - Create `tests/unit/quantity-engine.test.ts`
    - Test specific parsing examples with real Jobber quote message formats
    - Test edge cases: empty messages, messages with only headers/footers, single-line messages
    - Test that invalid quantities (0, negative, NaN, Infinity) are discarded
    - _Requirements: 9.1, 9.2, 9.3, 5.3_

- [x] 3. Implement the QuantityEngine service — confidence and prediction
  - [x] 3.1 Implement confidence scoring and weighted median
    - Create `worker/src/services/quantity-engine.ts`
    - Implement `computeConfidence(input: ConfidenceInput): number` following the algorithm: base score from sample size (min(100, sampleSize * 10)), cap at 0 for < 2 samples, cap at 60 for < 5 samples, variance penalty (CV > 0.5: subtract max(30, CV * 40); CV 0.3–0.5: subtract CV * 20), clamp to [0, 100]
    - Implement `weightedMedian(dataPoints: Array<{ quantity: number; weight: number }>): number` using cumulative weight approach
    - Export both functions for testing
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 2.2, 2.3_

  - [ ]* 3.2 Write property tests for confidence score bounds
    - **Property 5: Confidence Score Bounds**
    - **Validates: Requirements 2.3, 2.4, 6.1, 6.2**
    - Verify: sampleSize < 2 → confidence = 0; sampleSize 2–4 → confidence ≤ 60; sampleSize ≥ 10 and CV < 0.3 → confidence ≥ 90; always integer in [0, 100]

  - [ ]* 3.3 Write property test for variance penalty
    - **Property 6: Variance Penalty on Confidence**
    - **Validates: Requirement 6.3**
    - For any data points where CV > 0.5, the final confidence is at least 30 points lower than the sample-size-only base score

  - [ ]* 3.4 Write property tests for weighted median
    - **Property 7: Similarity Weighting Moves Prediction**
    - **Validates: Requirement 2.2**
    - For two or more data points with distinct quantities, increasing one point's weight moves the predicted quantity toward that value

  - [ ]* 3.5 Write property test for weighted median bounds
    - **Property 8: Weighted Median Bounds**
    - **Validates: Requirement 6.4**
    - For any set of (quantity, weight) pairs with positive weights and positive finite quantities, the weighted median is between min and max quantity inclusive

  - [x] 3.6 Implement predictQuantities method
    - Implement `QuantityEngine.predictQuantities(lineItems, similarQuotes)` that queries quantity_history for matching products using case-insensitive prefix matching (consistent with `matchesProductName` helper)
    - Weight historical quantities by similarity score of source quotes
    - Compute weighted median and confidence score for each product
    - Return predictions only for products with ≥ 2 data points
    - Return empty array on any error (graceful degradation)
    - Return empty array immediately when no similar quotes provided
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 7.1, 7.2, 7.3_

  - [ ]* 3.7 Write property test for threshold-based application
    - **Property 9: Threshold-Based Application**
    - **Validates: Requirements 3.2, 3.4**
    - Prediction is applied if and only if confidence > threshold; when not applied, line item quantity remains unchanged

  - [ ]* 3.8 Write property test for prediction output completeness
    - **Property 11: Prediction Output Completeness**
    - **Validates: Requirements 2.5, 8.1, 8.2**
    - For any product with ≥ 2 valid data points and confidence above threshold, the prediction contains: positive finite predicted quantity, confidence in [0, 100], and at least one source quote reference

- [x] 4. Implement extraction and storage
  - [x] 4.1 Implement extractAndStore method
    - Implement `QuantityEngine.extractAndStore(quotes)` that uses `parseLineItems` to extract product-quantity pairs from each quote's message field
    - Use `INSERT ... ON CONFLICT(product_name, source_quote_id) DO UPDATE` for idempotent upserts
    - Skip quotes with null/empty messages without error
    - Discard extracted quantities that are not positive finite numbers
    - Log warnings for individual quote extraction failures, continue processing remaining
    - Return `{ extracted: number; skipped: number }` counts
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 5.3_

  - [ ]* 4.2 Write property test for extraction idempotence
    - **Property 4: Extraction Idempotence**
    - **Validates: Requirement 1.4**
    - Extracting and storing quantity records twice for the same (product_name, source_quote_id) results in the same number of records as extracting once

  - [ ]* 4.3 Write property test for invalid quantity filtering
    - **Property 10: Invalid Quantities Are Discarded**
    - **Validates: Requirement 5.3**
    - For any extracted quantity that is not a positive finite number (zero, negative, NaN, Infinity), the extraction discards that record

  - [ ]* 4.4 Write unit tests for extraction and graceful degradation
    - Test extraction from real quote message formats
    - Test idempotent upsert behavior (same quote re-extracted)
    - Test graceful degradation: DB errors return empty predictions, empty corpus returns empty set
    - Test that no similar quotes returns empty set immediately
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 7.1, 7.2, 7.3_

- [x] 5. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Integrate with QuoteEngine and QuoteSyncService
  - [x] 6.1 Integrate QuantityEngine into QuoteSyncService
    - Modify `worker/src/services/quote-sync-service.ts` to accept an optional `QuantityEngine` instance in the constructor
    - After upserting new and changed quotes in `sync()`, call `quantityEngine.extractAndStore()` with the new/changed quotes that have messages
    - Log aggregate extraction results via ActivityLogService
    - _Requirements: 1.1, 1.2_

  - [x] 6.2 Integrate QuantityEngine into QuoteEngine
    - Modify `worker/src/services/quote-engine.ts` to accept an optional `QuantityEngine` instance
    - After AI response parsing and before rules engine execution, call `predictQuantities()` with the engine line items and similar quotes
    - Apply predictions that exceed the confidence threshold (default: 50) to matching line items using `matchesProductName` with 'starts_with' mode
    - Set `quantityPrediction` metadata on affected line items for traceability
    - Preserve AI-estimated quantity when no prediction meets the threshold
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 6.3 Ensure rules engine overrides are recorded correctly
    - Verify that the rules engine `set_quantity` and `adjust_quantity` actions execute after quantity predictions are applied
    - Ensure the audit trail `beforeSnapshot` captures the predicted quantity when a rule overrides it
    - Ensure rules engine treats predicted quantities identically to AI-estimated quantities for `line_item_quantity_gte` and `line_item_quantity_lte` conditions
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 6.4 Export QuantityEngine from services barrel
    - Add `QuantityEngine` export to `worker/src/services/index.ts`
    - Export relevant types (`QuantityPrediction`, `QuantityEngineConfig`, `QuantitySource`)
    - _Requirements: 3.1_

  - [x] 6.5 Wire QuantityEngine in route handlers
    - Instantiate `QuantityEngine` in the quote generation route handler and pass to `QuoteEngine`
    - Instantiate `QuantityEngine` in the corpus sync route handler and pass to `QuoteSyncService`
    - _Requirements: 3.1, 1.1_

  - [ ]* 6.6 Write property test for audit trail on override
    - **Property 12: Audit Trail Records Override Details**
    - **Validates: Requirement 4.2**
    - For any line item whose quantity was set by the Quantity Engine and subsequently modified by a rules engine action, the audit trail entry contains both the rule ID and the original predicted quantity in the before snapshot

  - [ ]* 6.7 Write unit tests for integration behavior
    - Test that QuoteSyncService calls extractAndStore after upserting quotes
    - Test that QuoteEngine calls predictQuantities before executeRules
    - Test that predictions below threshold are not applied
    - Test that quantityPrediction metadata is set on affected line items
    - Test quantity source is correctly set to 'historical_prediction'
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.1_

- [x] 7. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Client UI — display quantity source badges
  - [x] 8.1 Update QuoteDraftPage to display quantity source metadata
    - Modify `client/src/pages/QuoteDraftPage.tsx` to read `quantityPrediction` metadata from line items in the quote draft response
    - Display a badge or indicator next to each line item's quantity showing the source: "AI estimate", "Historical prediction", or "Rule override"
    - For historical predictions, show confidence score and source quote numbers on hover or in a tooltip
    - _Requirements: 8.1, 8.2, 8.3_

- [x] 9. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The design uses TypeScript throughout, consistent with the existing codebase
- All property tests use `fast-check` and go in `tests/property/quantity-engine.property.test.ts`
- All unit tests go in `tests/unit/quantity-engine.test.ts`
