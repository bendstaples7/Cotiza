        # Implementation Plan: Context-Aware Quantity Rules

## Overview

This plan implements the context-aware quantity rules feature by building from the bottom up: shared types first, then the formula evaluator and extraction presets modules, then integrating into the existing rules engine condition/action pipeline, then API validation, and finally the client UI. Each step builds on the previous and ends with wiring into the existing system.

## Tasks

- [x] 1. Extend shared type definitions
  - [x] 1.1 Add new condition types and action type to shared/src/types/quote.ts
    - Add `'request_text_extract'` and `'compound'` to `RuleConditionType` union
    - Add `{ type: 'request_text_extract'; pattern: string; variableName: string; preset?: string }` to `RuleCondition` union
    - Add `{ type: 'compound'; conditions: RuleCondition[] }` to `RuleCondition` union
    - Add `'compute_quantity'` to `RuleActionType` union
    - Add `{ type: 'compute_quantity'; productNamePattern: string; formula: string; matchMode?: MatchMode }` to `RuleAction` union
    - Add optional `computedQuantityMeta` field to `AuditEntry` interface with shape: `{ formula: string; variableValues: Record<string, number>; rawExtractedText: Record<string, string>; previousQuantity: number; computedQuantity: number }`
    - _Requirements: 1.1, 1.2, 3.1, 4.1, 6.1_

  - [x] 1.2 Add ConditionResult contextVariables to shared types
    - Extend the `ConditionResult` interface concept (or export a new interface) so that condition evaluation can return `contextVariables?: Map<string, number>` and `rawExtractedText?: Map<string, string>`
    - _Requirements: 1.2, 2.4, 4.3_

- [x] 2. Implement the formula evaluator module
  - [x] 2.1 Create worker/src/services/formula-evaluator.ts with recursive-descent parser
    - Implement `validateFormula(formula: string): FormulaValidationResult` that parses the formula grammar and returns `{ valid, error?, referencedVariables }`
    - Implement `evaluateFormula(formula: string, variables: Map<string, number>): number` that evaluates the formula with variable substitution
    - Support: numeric literals (integers, decimals), variable identifiers `[a-zA-Z_][a-zA-Z0-9_]*`, operators `+`, `-`, `*`, `/` with standard precedence, parentheses, unary minus
    - Throw on: division by zero, missing variable, non-finite result, overflow (> Number.MAX_SAFE_INTEGER)
    - Reject: function calls, property access, string literals, assignment operators, any non-arithmetic construct
    - _Requirements: 3.1, 3.2, 5.1, 5.3_

  - [ ]* 2.2 Write property tests for formula evaluator — round-trip correctness
    - **Property 7: Formula evaluation correctness**
    - Generate random valid ASTs (literals, variables, binary ops), serialize to formula string, evaluate with known variable bindings, verify result matches direct computation
    - Test file: tests/property/context-aware-quantity-rules.property.test.ts
    - **Validates: Requirements 3.1, 3.2, 7.2**

  - [ ]* 2.3 Write property tests for formula validation — accepts valid, rejects invalid
    - **Property 12: Formula validation accepts valid and rejects invalid formulas**
    - Generate valid formula strings from grammar → assert `valid: true`; generate strings with function calls, property access, assignments → assert `valid: false`
    - Test file: tests/property/context-aware-quantity-rules.property.test.ts
    - **Validates: Requirements 5.1, 5.3**

  - [ ]* 2.4 Write property tests for rounding and clamping
    - **Property 9: Computed quantities are rounded to nearest integer**
    - **Property 10: Zero or negative results are clamped to 1**
    - Generate formulas producing fractional results → verify `Math.round()` applied; generate formulas producing ≤ 0 → verify clamped to 1
    - Test file: tests/property/context-aware-quantity-rules.property.test.ts
    - **Validates: Requirements 3.4, 3.5**

  - [ ]* 2.5 Write property tests for non-finite results
    - **Property 11: Non-finite results cause action skip**
    - Generate formulas with division by zero or overflow → verify error thrown
    - Test file: tests/property/context-aware-quantity-rules.property.test.ts
    - **Validates: Requirements 3.6**

  - [ ]* 2.6 Write unit tests for formula evaluator edge cases
    - Test file: tests/unit/formula-evaluator.test.ts
    - Test specific formulas: `sqft / 100 * 4`, `rooms * 2 + 1`, `(floors + 1) * 3`
    - Test error cases: empty formula, lone operator, unclosed parenthesis, nested function call attempts
    - _Requirements: 3.1, 3.2, 5.1, 5.3_

- [x] 3. Checkpoint — Ensure formula evaluator tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement extraction presets module
  - [x] 4.1 Create worker/src/services/extraction-presets.ts
    - Implement `ExtractionPreset` interface with fields: `id`, `name`, `description`, `pattern`, `variableName`, `exampleMatches`
    - Implement `getExtractionPresets(): ExtractionPreset[]` returning the three predefined presets (sqft, room_count, floor_count)
    - Implement `resolvePreset(presetId: string): ExtractionPreset | null`
    - Sqft pattern: `(\d[\d,]*(?:\.\d+)?)\s*(?:sq\.?\s*ft|sqft|square\s*feet|sf)` with case-insensitive flag
    - Room count pattern: `(\d+)\s*(?:rooms?|bedrooms?|bathrooms?|bed/?bath)` with case-insensitive flag
    - Floor count pattern: `(\d+)\s*(?:floors?|stor(?:y|ies)|levels?)` with case-insensitive flag
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ]* 4.2 Write unit tests for extraction presets
    - Test file: tests/unit/extraction-presets.test.ts
    - Verify each preset matches all documented example formats (e.g., "1500 sqft", "1,500 sq ft", "1500 square feet", "1500sf")
    - Verify `resolvePreset` returns null for unknown IDs
    - Verify case-insensitive matching
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [x] 5. Integrate new condition types into the rules engine
  - [x] 5.1 Add `request_text_extract` condition evaluation to worker/src/services/rules-engine.ts
    - Add `'request_text_extract'` and `'compound'` to the `CONDITION_TYPES` set
    - Extend `ConditionResult` interface to include `contextVariables?: Map<string, number>` and `rawExtractedText?: Map<string, string>`
    - In `evaluateCondition`, add a case for `request_text_extract`: apply the regex (case-insensitive) against `customerRequestText`, extract first match's capture group, parse as number (strip commas), store in context variable map
    - If pattern doesn't match, return `{ matched: false, matchingLineItemIds: [], contextVariables: new Map() }`
    - Return all line item IDs as `matchingLineItemIds` when matched (same as `request_text_contains`)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.3_

  - [x] 5.2 Add `compound` condition evaluation to worker/src/services/rules-engine.ts
    - In `evaluateCondition`, add a case for `compound`: iterate sub-conditions in order, short-circuit on first non-match
    - Aggregate `contextVariables` from all sub-conditions into a single merged map
    - Aggregate `rawExtractedText` from all sub-conditions
    - For `matchingLineItemIds`, intersect the IDs from line-item-targeting sub-conditions; for text-only sub-conditions, don't restrict
    - _Requirements: 2.2, 4.1, 4.2, 4.3, 4.4_

  - [x] 5.3 Add validation for new condition types in `validateCondition`
    - Validate `request_text_extract`: require non-empty `pattern` string, non-empty `variableName` string, validate regex is syntactically valid, validate exactly one capture group (count unescaped `(` excluding `(?:`, `(?=`, `(?!`, `(?<`)
    - Validate `compound`: require non-empty `conditions` array, validate each sub-condition recursively, reject nested compound conditions (max depth 1)
    - _Requirements: 5.4, 4.1_

  - [ ]* 5.4 Write property tests for extraction condition evaluation
    - **Property 1: Extraction produces correct numeric context variable**
    - **Property 2: Non-matching patterns yield condition failure**
    - **Property 3: First match extraction**
    - Generate request texts with embedded numbers + unit suffixes, verify correct extraction
    - Test file: tests/property/context-aware-quantity-rules.property.test.ts
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5**

  - [ ]* 5.5 Write property tests for compound condition semantics
    - **Property 4: Compound condition AND semantics**
    - **Property 5: Compound conditions aggregate all context variables**
    - **Property 6: Short-circuit evaluation in compound conditions**
    - Generate compound conditions with known match/no-match sub-conditions, verify AND logic, variable aggregation, and short-circuit behavior
    - Test file: tests/property/context-aware-quantity-rules.property.test.ts
    - **Validates: Requirements 2.2, 2.4, 4.1, 4.3, 4.4**

- [x] 6. Integrate compute_quantity action into the rules engine
  - [x] 6.1 Add `compute_quantity` action execution to worker/src/services/rules-engine.ts
    - Add `'compute_quantity'` to the `ACTION_TYPES` set
    - Extend `executeAction` signature to accept optional `contextVariables?: Map<string, number>` and `rawExtractedText?: Map<string, string>` parameters
    - Implement `compute_quantity` case: find matching line items by `productNamePattern`/`matchMode`, evaluate formula with context variables, apply rounding (`Math.round`), clamp ≤ 0 to 1, set quantity, append rule ID to `ruleIdsApplied`
    - Handle missing variable: return `{ modified: false }` with warning
    - Handle non-finite result: return `{ modified: false }` with error in audit
    - Populate `computedQuantityMeta` on the audit entry with formula, variable values, raw text, previous quantity, and computed quantity
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 6.1, 6.2, 6.3, 6.4, 7.2_

  - [x] 6.2 Add validation for `compute_quantity` action in `validateAction`
    - Require non-empty `productNamePattern` string
    - Require non-empty `formula` string
    - Validate formula syntax using `validateFormula()`
    - Validate `matchMode` if present
    - _Requirements: 5.1, 5.3_

  - [x] 6.3 Wire context variables through the main `executeRules` loop
    - After `evaluateCondition` returns, capture `contextVariables` and `rawExtractedText` from the result
    - Pass them to each `executeAction` call for the matched rule
    - Ensure context variables are scoped to the current rule only (discard after rule's actions complete)
    - _Requirements: 7.1, 7.3, 7.4, 7.5_

  - [ ]* 6.4 Write property tests for compute_quantity action
    - **Property 8: Missing variable causes action skip**
    - **Property 15: Audit trail contains complete computation metadata**
    - Test file: tests/property/context-aware-quantity-rules.property.test.ts
    - **Validates: Requirements 3.3, 6.1, 6.2, 6.3, 6.4**

  - [ ]* 6.5 Write property test for context variable scoping
    - **Property 16: Context variable scoping**
    - Generate multi-rule sequences where rule 1 extracts a variable and rule 2 references the same name without extraction → verify rule 2 skips
    - Test file: tests/property/context-aware-quantity-rules.property.test.ts
    - **Validates: Requirements 7.5**

- [x] 7. Checkpoint — Ensure all engine tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Add formula-condition cross-validation at rule creation/update
  - [x] 8.1 Implement cross-validation logic in the rules route handler
    - When a rule is created/updated with a `compute_quantity` action, collect all `variableName` values from `request_text_extract` conditions (direct or within compound)
    - Compare against `referencedVariables` from `validateFormula()` on the action's formula
    - If any formula variable is not in the extracted set, reject with 400 and descriptive error: "Formula references variable '{name}' which is not extracted by any condition"
    - _Requirements: 5.2_

  - [x] 8.2 Implement regex capture group count validation
    - When a rule is created/updated with a `request_text_extract` condition, validate the pattern has exactly one capture group
    - Count unescaped `(` excluding non-capturing groups `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`
    - Reject with 400 if zero or multiple capture groups found
    - _Requirements: 5.4_

  - [x] 8.3 Add preset resolution at rule creation time
    - When a `request_text_extract` condition includes a `preset` field, resolve it via `resolvePreset()` and store the resolved regex in the `pattern` field
    - If preset ID is unknown, reject with 400
    - _Requirements: 8.4_

  - [ ]* 8.4 Write property test for formula-condition cross-validation
    - **Property 13: Formula-condition cross-validation**
    - Generate rules where formula variables match/don't match condition variable names → verify acceptance/rejection
    - Test file: tests/property/context-aware-quantity-rules.property.test.ts
    - **Validates: Requirements 5.2**

  - [ ]* 8.5 Write property test for regex capture group validation
    - **Property 14: Regex pattern validation requires exactly one capture group**
    - Generate regex strings with 0, 1, or multiple capture groups → verify correct acceptance/rejection
    - Test file: tests/property/context-aware-quantity-rules.property.test.ts
    - **Validates: Requirements 5.4**

- [x] 9. Implement context-aware rule configuration UI
  - [x] 9.1 Add "Context-Aware Quantity" rule type to client/src/pages/RulesPage.tsx
    - Add a rule type selector when creating/editing a rule that offers "Context-Aware Quantity" as an option
    - When selected, show: extraction pattern configuration (preset selector + custom regex input), variable name field, formula input field
    - Display available presets as selectable options with descriptions
    - Show available context variable names (from configured extractions) near the formula input
    - Wire form submission to build the correct `conditionJson` (compound with line_item + request_text_extract) and `actionJson` (compute_quantity)
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 9.2 Add validation error display and formula preview
    - Display API validation errors (invalid pattern, invalid formula, undefined variable) inline on the form
    - Add a "Test formula" section where the user can enter sample request text and see: extracted values, computed quantity result
    - _Requirements: 9.4, 9.5_

  - [x] 9.3 Add API endpoint for extraction presets
    - Create a GET endpoint (e.g., `/api/rules/extraction-presets`) that returns the list of available presets with their descriptions and example matches
    - Add corresponding client API call in `client/src/api.ts`
    - _Requirements: 8.4, 9.2_

- [x] 10. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The formula evaluator is intentionally a pure module with no dependencies for easy testing
- Context variables are scoped per-rule to prevent ordering-dependent bugs
- Preset patterns are resolved at creation time so runtime evaluation never depends on preset definitions
