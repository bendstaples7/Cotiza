# Implementation Plan: Productivity Rates

## Overview

This plan implements the productivity rates feature bottom-up: shared types first, then the D1 migration, then the service with unit and property tests, then QuoteEngine integration, then the REST endpoints, then the client API functions, and finally the RulesPage UI (Rates tab + formula test panel update). Each step builds on the previous and ends with everything wired together.

## Tasks

- [x] 1. Add shared TypeScript types
  - [x] 1.1 Add `ProductivityRate` and `UpdateProductivityRatePayload` interfaces to `shared/src/types/quote.ts`
    - Append `ProductivityRate` interface with fields: `id: string`, `variableName: string`, `displayName: string`, `sqftPerHour: number`, `description: string | null`, `createdAt: Date`, `updatedAt: Date`
    - Append `UpdateProductivityRatePayload` interface with fields: `sqftPerHour: number`, `displayName?: string`, `description?: string`
    - _Requirements: 7.1, 7.2_

  - [x] 1.2 Re-export new types from `shared/src/index.ts`
    - Ensure `ProductivityRate` and `UpdateProductivityRatePayload` are exported from the shared package barrel
    - _Requirements: 7.1, 7.2_

- [x] 2. Create D1 migration
  - [x] 2.1 Create `worker/src/migrations/0030_productivity_rates.sql`
    - Write `CREATE TABLE IF NOT EXISTS productivity_rates` with columns: `id TEXT PRIMARY KEY`, `variable_name TEXT NOT NULL UNIQUE`, `display_name TEXT NOT NULL`, `sqft_per_hour REAL NOT NULL`, `description TEXT`, `created_at TEXT NOT NULL DEFAULT (datetime('now'))`, `updated_at TEXT NOT NULL DEFAULT (datetime('now'))`
    - Add `CREATE INDEX IF NOT EXISTS idx_productivity_rates_variable_name ON productivity_rates(variable_name)`
    - Seed 6 initial rates using `INSERT OR IGNORE`: `drywall_rate` (40), `paint_rate` (100), `paint_ceiling_rate` (80), `tile_shower_rate` (8), `tile_floor_rate` (12), `tile_bath_rate` (8)
    - _Requirements: 1.1, 2.1, 2.2, 2.3_

- [x] 3. Implement `ProductivityRatesService`
  - [x] 3.1 Create `worker/src/services/productivity-rates-service.ts`
    - Implement `ProductivityRatesService` class with `constructor(db: D1Database)`
    - Implement `async getAllRates(): Promise<ProductivityRate[]>` — query `SELECT * FROM productivity_rates ORDER BY display_name ASC`, map each row via `mapRow()`
    - Implement `async getRateById(id: string): Promise<ProductivityRate>` — query by primary key, throw 404 `PlatformError` if not found
    - Implement `async updateRate(id: string, payload: UpdateProductivityRatePayload): Promise<ProductivityRate>` — call `validateSqftPerHour()`, validate `display_name` non-empty if provided, run `UPDATE` with `updated_at = datetime('now')`, return updated rate via `getRateById()`
    - Implement private `mapRow(row: Record<string, unknown>): ProductivityRate` — map snake_case columns to camelCase fields; convert `sqft_per_hour` with `Number()`, `description` with `?? null`, `created_at`/`updated_at` with `new Date()`
    - Implement private `validateSqftPerHour(value: number): void` — throw 400 `PlatformError` unless `Number.isFinite(value) && value > 0`
    - Follow `PlatformError` pattern for all errors (severity, component, operation, description, recommendedActions)
    - _Requirements: 1.1, 1.3, 1.5, 4.2, 4.3, 4.4, 7.3_

  - [x] 3.2 Export `ProductivityRatesService` from `worker/src/services/index.ts`
    - Add export for the new service to the barrel file
    - _Requirements: 1.1_

  - [ ]* 3.3 Write unit tests for `ProductivityRatesService` in `tests/unit/productivity-rates-service.test.ts`
    - Test `getAllRates()` returns empty array when table is empty
    - Test `getAllRates()` returns rates ordered by `display_name` ascending
    - Test `updateRate()` updates `sqft_per_hour` and `updated_at`
    - Test `updateRate()` updates optional `display_name` and `description` when provided
    - Test `updateRate()` throws 404 `PlatformError` for unknown id
    - Test `updateRate()` throws 400 `PlatformError` for non-finite `sqft_per_hour` (NaN, Infinity, -Infinity)
    - Test `updateRate()` throws 400 `PlatformError` for zero `sqft_per_hour`
    - Test `updateRate()` throws 400 `PlatformError` for negative `sqft_per_hour`
    - Test `updateRate()` throws 400 `PlatformError` for empty `display_name`
    - Test `mapRow()` correctly maps all snake_case columns to camelCase fields with correct types
    - Use mock D1 helper from `tests/unit/helpers/mock-d1.ts`
    - _Requirements: 1.3, 1.5, 4.2, 4.3, 4.4, 7.3_

- [x] 4. Checkpoint — Ensure service unit tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Write property-based tests for `ProductivityRatesService`
  - [ ]* 5.1 Write property test for `sqft_per_hour` validation (Property 1) in `tests/property/productivity-rates.property.test.ts`
    - **Property 1: sqft_per_hour validation accepts exactly finite positive numbers**
    - Generate numbers including `NaN`, `Infinity`, `-Infinity`, `0`, negatives, and positives using `fc.oneof(fc.float(), fc.integer(), fc.constant(NaN), fc.constant(Infinity), fc.constant(-Infinity))`
    - Assert: `validateSqftPerHour(v)` throws if and only if `!(Number.isFinite(v) && v > 0)`
    - Minimum 1000 runs
    - **Validates: Requirements 1.3, 4.3**

  - [ ]* 5.2 Write property test for rate injection completeness and non-overwrite (Property 2) in `tests/property/productivity-rates.property.test.ts`
    - **Property 2: Rate injection is complete and non-overwriting**
    - Generate arbitrary arrays of rates and arbitrary initial context maps
    - Assert: after injection, every rate's `variableName` is present; keys already in the map retain their original value; new keys map to the rate's `sqftPerHour`
    - Minimum 200 runs
    - **Validates: Requirements 3.1, 3.3**

  - [ ]* 5.3 Write property test for formula evaluation with injected rate variables (Property 3) in `tests/property/productivity-rates.property.test.ts`
    - **Property 3: Formula evaluation with injected rate variables produces correct arithmetic**
    - Generate finite positive `sqft` and finite positive rate values using `fc.float({ min: 0.01, max: 100000, noNaN: true })`
    - Build a context map `{ sqft, drywall_rate: rate }`, evaluate `'sqft / drywall_rate'` using the existing `evaluateFormula` function
    - Assert result is within floating-point precision of `sqft / rate` using `toBeCloseTo(sqft / rate, 5)`
    - Minimum 500 runs
    - **Validates: Requirements 3.2**

  - [ ]* 5.4 Write property test for D1 row serialization (Property 6) in `tests/property/productivity-rates.property.test.ts`
    - **Property 6: D1 row serialization maps all fields correctly**
    - Generate arbitrary valid rate rows with `fc.record({ id: fc.string(), variable_name: fc.string(), display_name: fc.string(), sqft_per_hour: fc.float({ min: 0.01, noNaN: true }), description: fc.option(fc.string()), created_at: fc.string(), updated_at: fc.string() })`
    - Assert: `mapRow(row)` produces a `ProductivityRate` where every camelCase field matches the corresponding snake_case column, `createdAt` and `updatedAt` are `Date` instances
    - Minimum 200 runs
    - **Validates: Requirements 7.3**

  - [ ]* 5.5 Write property test for formula test panel variables (Property 7) in `tests/property/productivity-rates.property.test.ts`
    - **Property 7: Formula test panel variables include all loaded rates**
    - Generate arbitrary arrays of `ProductivityRate` objects
    - Call the rate-merging helper (extracted pure function from `BusinessRulesTab`) with an empty base variables map and the generated rates
    - Assert: the resulting map contains an entry for every rate's `variableName` equal to its `sqftPerHour`
    - Minimum 200 runs
    - **Validates: Requirements 6.1, 6.2**

- [x] 6. Checkpoint — Ensure all property tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Integrate productivity rates into `QuoteEngine`
  - [x] 7.1 Add optional `db?: D1Database` as 5th constructor parameter to `worker/src/services/quote-engine.ts`
    - Add `private readonly db?: D1Database` field
    - Update constructor signature: `constructor(apiKey: string, apiUrl: string, quantityEngine?: QuantityEngine, r2Bucket?: R2Bucket, db?: D1Database)`
    - _Requirements: 3.1_

  - [x] 7.2 Inject productivity rates into `preResolvedContext` inside `generateQuote()`
    - After the sqft resolution block builds `preResolvedContext`, add a `try/catch` block that instantiates `ProductivityRatesService(this.db)`, calls `getAllRates()`, and merges each rate into `preResolvedContext` using non-overwrite logic: `if (!preResolvedContext.has(rate.variableName)) preResolvedContext.set(rate.variableName, rate.sqftPerHour)`
    - Silently catch all errors — rate loading failure must not block quote generation
    - _Requirements: 3.1, 3.3, 3.4_

  - [x] 7.3 Update `POST /generate` route in `worker/src/routes/quotes.ts` to pass `db` to `QuoteEngine`
    - Change `new QuoteEngine(apiKey, apiUrl, new QuantityEngine(db), c.env.R2_BUCKET)` to `new QuoteEngine(apiKey, apiUrl, new QuantityEngine(db), c.env.R2_BUCKET, db)`
    - _Requirements: 3.1_

  - [ ]* 7.4 Write unit tests for QuoteEngine rate injection in `tests/unit/productivity-rates-service.test.ts` (or a new `quote-engine-rates.test.ts`)
    - Test: rates are injected into `preResolvedContext` when `db` is provided
    - Test: existing `preResolvedContext` values are not overwritten by rates with the same key
    - Test: rate loading failure does not throw — quote generation proceeds normally
    - Test: empty rates table results in no additional context entries beyond `sqft`
    - _Requirements: 3.1, 3.3, 3.4_

- [x] 8. Add REST endpoints for productivity rates
  - [x] 8.1 Add `GET /productivity-rates` and `PUT /productivity-rates/:id` endpoints to `worker/src/routes/quotes.ts`
    - `GET /productivity-rates`: instantiate `ProductivityRatesService(c.env.DB)`, call `getAllRates()`, return `c.json({ rates })`
    - `PUT /productivity-rates/:id`: instantiate `ProductivityRatesService(c.env.DB)`, parse request body as `UpdateProductivityRatePayload`, call `updateRate(c.req.param('id'), body)`, return `c.json(rate)`
    - Both endpoints are protected by the existing session middleware (already applied to the router)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

- [x] 9. Add client API functions
  - [x] 9.1 Add `fetchProductivityRates()` and `updateProductivityRate()` to `client/src/api.ts`
    - `fetchProductivityRates(): Promise<ProductivityRate[]>` — `GET /api/quotes/productivity-rates`, extract `data.rates`
    - `updateProductivityRate(id: string, payload: UpdateProductivityRatePayload): Promise<ProductivityRate>` — `PUT /api/quotes/productivity-rates/:id` with JSON body, use `handleResponseWithToast`
    - Follow existing auth header pattern (`authHeaders()`)
    - _Requirements: 4.1, 4.2_

- [x] 10. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implement `ProductivityRatesTab` and update `RulesPage`
  - [x] 11.1 Add `'rates'` to the `TabId` union and add the "Productivity Rates" tab button in `client/src/pages/RulesPage.tsx`
    - Extend `type TabId = 'rules' | 'ordering' | 'rates'`
    - Add a third tab button "Productivity Rates" in the tab bar alongside "Business Rules" and "Product Ordering"
    - _Requirements: 5.1_

  - [x] 11.2 Implement `ProductivityRatesTab` component inside `RulesPage.tsx`
    - On mount, call `fetchProductivityRates()` and store in state; show a loading indicator while fetching; show an error message with a retry button if the fetch fails
    - Render a table with columns: Display Name (editable), Variable Name (read-only, monospace), sqft/hr (editable numeric input), Description (editable)
    - Each row has a "Save" button that calls `updateProductivityRate(id, payload)` and shows inline success/error feedback without losing unsaved edits on failure
    - Display a helper note: "Use these variable names in `compute_quantity` formulas — e.g., `sqft / drywall_rate`"
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

  - [x] 11.3 Update the formula test panel in `BusinessRulesTab` to merge productivity rate values
    - Accept a `rates: ProductivityRate[]` prop (loaded once when `RulesPage` mounts and passed down)
    - In `runFormulaTest()`, after building the `variables` map from text extractions, iterate `rates` and add each rate's `variableName → sqftPerHour` using non-overwrite logic: `if (!(rate.variableName in variables)) variables[rate.variableName] = rate.sqftPerHour`
    - Extract this merge step as a pure helper function (enables Property 7 test)
    - _Requirements: 6.1, 6.2, 6.3_

- [x] 12. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate the 7 correctness properties defined in the design document (Properties 4 and 5 are covered by unit tests for `getAllRates()` ordering and `updateRate()` round-trip)
- Unit tests validate specific examples and edge cases
- The `db` parameter on `QuoteEngine` is optional to preserve backward compatibility with existing tests
- Rate loading in `QuoteEngine` is wrapped in `try/catch` with no re-throw — mirrors the existing graceful degradation pattern for sqft resolution
- The rate-merging helper extracted for Property 7 testing is the same function used in the formula test panel at runtime
