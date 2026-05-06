# Requirements Document

## Introduction

The productivity rates feature enables the rules engine to compute labor quantities (hours) from resolved square footage. Currently, `compute_quantity` formulas can reference `sqft` as a pre-resolved variable, but there is no mechanism to inject trade-specific rates (e.g., how many square feet a crew can complete per hour) into the formula evaluator. This feature adds a global `productivity_rates` table in D1, a service to load and manage those rates, injection of all rates into the rules engine's `preResolvedContext` alongside `sqft`, and a UI for viewing and editing rates. Rates are global (not per-user) because Chicago Reno operates as a single business entity. Location-based pricing differences (downtown vs. suburbs) affect unit prices, not labor quantities, so rates remain global.

## Glossary

- **Productivity_Rate**: A named numeric value representing the square footage a crew can complete per hour for a given service category (e.g., `drywall_rate = 40` means 40 sqft/hr).
- **Rate_Variable_Name**: The snake_case identifier used to reference a productivity rate inside a `compute_quantity` formula (e.g., `drywall_rate`, `paint_rate`).
- **Productivity_Rates_Service**: The worker-side service class responsible for reading, writing, and seeding productivity rates in D1.
- **preResolvedContext**: The `Map<string, number>` passed to the rules engine before formula evaluation; currently contains `sqft` when resolved.
- **Formula_Evaluator**: The existing `evaluateFormula` function in `formula-evaluator.ts` that evaluates arithmetic expressions against a variable map.
- **Rules_Engine**: The existing `executeRules` function in `rules-engine.ts` that processes structured rules and executes `compute_quantity` actions.
- **Quote_Engine**: The existing `QuoteEngine` class in `quote-engine.ts` that orchestrates quote generation and builds `preResolvedContext`.
- **Seed_Rate**: An initial productivity rate value derived from historical quote data or set as a sensible default when historical data is insufficient.
- **Rate_Editor**: The UI component on the Rules page that allows viewing and editing productivity rates.

## Requirements

### Requirement 1: Productivity Rates Storage

**User Story:** As a system administrator, I want productivity rates stored in a dedicated D1 table, so that rates are persistent, auditable, and independent of individual rules.

#### Acceptance Criteria

1. THE Productivity_Rates_Service SHALL store productivity rates in a `productivity_rates` table in D1 with columns: `id` (TEXT primary key), `variable_name` (TEXT unique, not null), `display_name` (TEXT not null), `sqft_per_hour` (REAL not null), `description` (TEXT), `created_at` (TEXT), `updated_at` (TEXT).
2. THE Productivity_Rates_Service SHALL enforce that `variable_name` values match the pattern `[a-z][a-z0-9_]*` (lowercase letters, digits, and underscores, starting with a letter).
3. THE Productivity_Rates_Service SHALL enforce that `sqft_per_hour` values are finite positive numbers greater than zero.
4. THE Productivity_Rates_Service SHALL enforce that `variable_name` values are unique across all rows.
5. THE Productivity_Rates_Service SHALL enforce that `display_name` is a non-empty string.
6. WHEN a `variable_name` conflicts with a reserved formula keyword (`sqft`), THE Productivity_Rates_Service SHALL reject the operation with a descriptive error.

### Requirement 2: Database Migration and Seeding

**User Story:** As a developer deploying this feature, I want the table created and pre-populated with sensible initial rates, so that existing `compute_quantity` rules referencing rate variables work immediately after deployment.

#### Acceptance Criteria

1. THE migration `0030_productivity_rates.sql` SHALL create the `productivity_rates` table using `CREATE TABLE IF NOT EXISTS` to be idempotent.
2. THE migration `0030_productivity_rates.sql` SHALL seed the following initial rates using `INSERT OR IGNORE` to be idempotent:

   | variable_name        | display_name                                    | sqft_per_hour |
   |----------------------|-------------------------------------------------|---------------|
   | `drywall_rate`       | Drywall: Installation of New Drywall            | 40            |
   | `paint_rate`         | Interior Painting                               | 100           |
   | `paint_ceiling_rate` | Interior Painting: Ceilings                     | 80            |
   | `tile_shower_rate`   | Tile: Install Tiled Shower Surround             | 8             |
   | `tile_floor_rate`    | Tile: Install and Grout New Tile Floor          | 12            |
   | `tile_bath_rate`     | Tile: Bath Surround                             | 8             |

3. WHEN flooring line items have quantity equal to sqft (rate = 1), THE migration SHALL NOT seed a productivity rate for those items, as their `compute_quantity` formula is `sqft * 1` and no rate variable is needed.

### Requirement 3: Rates Injection into the Rules Engine

**User Story:** As a rules author, I want productivity rate variables (e.g., `drywall_rate`) available in `compute_quantity` formulas alongside `sqft`, so that I can write formulas like `sqft / drywall_rate` to compute labor hours.

#### Acceptance Criteria

1. WHEN the Quote_Engine builds `preResolvedContext` before calling `executeRules`, THE Quote_Engine SHALL load all productivity rates from D1 and add each rate's `variable_name` to `sqft_per_hour` mapping into the `preResolvedContext` map.
2. WHEN `sqft` is resolved and a `compute_quantity` formula references both `sqft` and a rate variable (e.g., `sqft / drywall_rate`), THE Formula_Evaluator SHALL evaluate the formula using both values from `preResolvedContext`.
3. WHEN productivity rates are loaded and `preResolvedContext` already contains a key matching a rate's `variable_name`, THE Quote_Engine SHALL not overwrite the existing value (rates do not override explicitly pre-resolved context).
4. WHEN the productivity rates table is empty or the D1 query fails, THE Quote_Engine SHALL proceed with quote generation using only the existing `preResolvedContext` entries (graceful degradation — rate loading failure must not block quote generation).
5. THE Rules_Engine SHALL pass `preResolvedContext` (including injected rates) to the `request_text_extract` condition evaluator so that rate variables are available as pre-resolved values when the condition's `variableName` matches a rate variable name.

### Requirement 4: REST API for Productivity Rates

**User Story:** As a front-end developer, I want REST endpoints for reading and updating productivity rates, so that the UI can display and edit them.

#### Acceptance Criteria

1. THE System SHALL expose a `GET /api/quotes/productivity-rates` endpoint that returns all productivity rates as a JSON array, ordered by `display_name` ascending.
2. THE System SHALL expose a `PUT /api/quotes/productivity-rates/:id` endpoint that accepts `{ sqft_per_hour: number, display_name?: string, description?: string }` and updates the specified rate.
3. WHEN a `PUT /api/quotes/productivity-rates/:id` request provides a `sqft_per_hour` value that is not a finite positive number, THE System SHALL return a 400 error with a descriptive message.
4. WHEN a `PUT /api/quotes/productivity-rates/:id` request references an `id` that does not exist, THE System SHALL return a 404 error.
5. THE System SHALL protect all productivity rates endpoints with the existing session middleware (authenticated users only).
6. THE System SHALL NOT expose a `DELETE` endpoint for productivity rates — rates are permanent records; only their values are editable.
7. THE System SHALL NOT expose a `POST` endpoint for creating new rates in v1 — the initial set is seeded by migration and the UI only edits existing rates.

### Requirement 5: Rate Editor UI

**User Story:** As a Chicago Reno operator, I want to view and edit productivity rates in the app, so that I can adjust rates when crew efficiency changes without touching the database directly.

#### Acceptance Criteria

1. THE Rate_Editor SHALL be accessible from the Rules page as a new tab or section alongside the existing "Business Rules" and "Product Ordering" tabs.
2. THE Rate_Editor SHALL display all productivity rates in a table with columns: Display Name, Variable Name (read-only), sqft/hr value (editable), and Description (editable).
3. WHEN a user edits a `sqft_per_hour` value and saves, THE Rate_Editor SHALL call `PUT /api/quotes/productivity-rates/:id` and display a success or error message.
4. WHEN a save request fails, THE Rate_Editor SHALL display the error message returned by the API without losing the user's unsaved edits.
5. THE Rate_Editor SHALL display the `variable_name` for each rate so that rules authors know the exact variable name to use in `compute_quantity` formulas.
6. THE Rate_Editor SHALL display a helper note explaining that these variables can be used in `compute_quantity` formulas (e.g., "Use `drywall_rate` in a formula like `sqft / drywall_rate`").
7. WHEN the Rate_Editor is loading rates, THE Rate_Editor SHALL display a loading indicator.
8. IF the rates API call fails, THE Rate_Editor SHALL display an error message with a retry option.

### Requirement 6: Formula Test Integration

**User Story:** As a rules author, I want the formula test panel on the Rules page to recognize productivity rate variables, so that I can test formulas like `sqft / drywall_rate` without getting "variable not found" errors.

#### Acceptance Criteria

1. WHEN the context-aware quantity rule form's formula test panel evaluates a formula, THE Rate_Editor context SHALL make productivity rate variable values available to the client-side formula preview evaluator.
2. WHEN a formula references a rate variable (e.g., `drywall_rate`) and the rates have been loaded, THE formula test panel SHALL substitute the current rate value and display the computed result.
3. WHEN a formula references a rate variable that is not found in the loaded rates, THE formula test panel SHALL display a clear error message identifying the missing variable by name.

### Requirement 7: Shared Types

**User Story:** As a developer, I want TypeScript types for productivity rates in the shared package, so that both the worker and client have type-safe access to rate data.

#### Acceptance Criteria

1. THE shared package SHALL export a `ProductivityRate` interface with fields: `id: string`, `variableName: string`, `displayName: string`, `sqftPerHour: number`, `description: string | null`, `createdAt: Date`, `updatedAt: Date`.
2. THE shared package SHALL export an `UpdateProductivityRatePayload` interface with fields: `sqftPerHour: number`, `displayName?: string`, `description?: string`.
3. WHEN the worker serializes a productivity rate from D1, THE Productivity_Rates_Service SHALL map snake_case column names to the camelCase `ProductivityRate` interface fields.
