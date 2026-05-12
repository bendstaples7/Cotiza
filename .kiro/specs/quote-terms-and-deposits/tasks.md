# Implementation Plan: Quote Terms and Deposits

## Overview

This plan implements the quote terms and deposits feature bottom-up: shared types first, then database migrations, then rules engine extensions, then persistence and service layers, then API routes, then the Jobber push service, then the client UI, and finally unit, property-based, and integration tests. Each step builds on the previous and ends with full integration into the quote generation pipeline.

## Tasks

- [x] 1. Extend shared TypeScript types
  - [x] 1.1 Add `PaymentMilestone` and `DepositSchedule` interfaces to `shared/src/types/quote.ts`
    - Add `PaymentMilestone` interface with fields: `description: string` (max 255 chars), `percentage: number` (0.01–100.00)
    - Add `DepositSchedule` interface with fields: `label: string` (1–100 chars), `milestones: PaymentMilestone[]` (1–10 entries)
    - _Requirements: 11.1, 11.2_

  - [x] 1.2 Extend `QuoteDraft` and `QuoteDraftUpdate` interfaces
    - Add `depositSchedule: DepositSchedule | null` field to `QuoteDraft`
    - Add optional `depositSchedule?: DepositSchedule | null` field to `QuoteDraftUpdate`
    - _Requirements: 11.3, 11.4_

  - [x] 1.3 Extend rules engine types
    - Add `'quote_total_gte'` to `RuleConditionType` union
    - Add `{ type: 'quote_total_gte'; threshold: number }` variant to `RuleCondition` union
    - Add `'set_deposit_schedule'` to `RuleActionType` union
    - Add `{ type: 'set_deposit_schedule'; schedule: DepositSchedule }` variant to `RuleAction` union
    - Add `depositSchedule: DepositSchedule | null` field to `RulesEngineResult` interface
    - _Requirements: 11.5, 11.6, 11.7, 11.8, 11.9_

  - [x] 1.4 Re-export new types from `shared/src/index.ts`
    - Ensure `PaymentMilestone` and `DepositSchedule` are exported from the shared package barrel
    - _Requirements: 11.1, 11.2_

- [x] 2. Create database migrations
  - [x] 2.1 Create `worker/src/migrations/0045_deposit_schedule.sql`
    - Add `deposit_schedule TEXT DEFAULT NULL` column to `quote_drafts` table using `ALTER TABLE quote_drafts ADD COLUMN deposit_schedule TEXT DEFAULT NULL`
    - This is non-destructive: existing rows receive NULL without a table rewrite
    - _Requirements: 3.1, 3.2, 3.3_

  - [x] 2.2 Create `worker/src/migrations/0046_seed_deposit_rules.sql`
    - Create a "Quote Terms" rule group using `INSERT OR IGNORE` with a stable UUID
    - Insert the Default Note Rule: `priorityOrder: 100`, `always` condition, `set_customer_note` action with the permit-fee disclaimer text: `"Estimate does not include permit fees, or permit coordination fees. If customer would like permits pulled for this work, will require change order at additional cost."`
    - Insert the High-Value Deposit Rule: `priorityOrder: 100`, `quote_total_gte` condition with `threshold: 10000`, `set_deposit_schedule` action with the four-milestone "High-Value Payment Schedule" (30% "Deposit due at signing", 30% "Due at completion of rough plumbing and electric", 30% "Due at completion of tile and flooring", 10% "Due at customer sign-off of punch list")
    - Insert the Standard Deposit Rule: `priorityOrder: 200`, `always` condition, `set_deposit_schedule` action with the two-milestone "Standard Deposit" schedule (30% "Deposit due at signing" + 70% "Balance due at completion of work")
    - All inserts use `INSERT OR IGNORE` for idempotency
    - _Requirements: 1.4, 6.4, 7.4_

- [x] 3. Extend the rules engine — condition and action support
  - [x] 3.1 Add `quote_total_gte` condition evaluation to `worker/src/services/rules-engine.ts`
    - Add `'quote_total_gte'` to the condition types set
    - In `evaluateCondition`, add a case for `quote_total_gte`: compute `sum(li.quantity × li.unitPrice)` across all `lineItems`, return `matched: total >= condition.threshold` and `matchingLineItemIds: matched ? lineItems.map(li => li.id) : []`
    - _Requirements: 7.1, 5.1_

  - [x] 3.2 Add `quote_total_gte` condition validation to `validateCondition`
    - Validate that `threshold` is present, is a finite number, and is non-negative; return a structured error if any check fails
    - _Requirements: 7.1_

  - [x] 3.3 Add `set_deposit_schedule` action execution to `worker/src/services/rules-engine.ts`
    - Add `'set_deposit_schedule'` to the action types set
    - In `executeAction`, add a case for `set_deposit_schedule`: return `{ depositScheduleValue: action.schedule }` along with before/after sentinel audit snapshots using `id: '__deposit_schedule__'`, `productName: 'Deposit Schedule'`, `description: JSON.stringify(schedule)`, `quantity: 0`, `unitPrice: 0`
    - Record `beforeSnapshot` as the previously active schedule (empty description string if none existed), and `afterSnapshot` as the new schedule
    - _Requirements: 5.1, 5.2, 10.1, 10.2, 10.3_

  - [x] 3.4 Add `set_deposit_schedule` action validation to `validateAction`
    - Validate that `schedule` is a non-null object
    - Validate `schedule.label` is a non-empty string of 1–100 characters
    - Validate `schedule.milestones` is an array of 1–10 entries
    - Validate each milestone `percentage` is a whole integer between 1 and 100
    - Validate each milestone `description` is a non-empty string
    - Validate that the sum of all `percentage` values equals exactly 100
    - Return a structured error identifying the failing check if any validation fails
    - _Requirements: 5.4_

  - [x] 3.5 Add `depositSchedule` priority resolution to the `executeRules` main loop
    - Add `let depositSchedule: DepositSchedule | null = null` and `let depositSchedulePriority: number = Infinity` to internal state
    - After each action execution, if `actionResult.depositScheduleValue !== undefined`, apply lowest-`priorityOrder`-wins logic: update `depositSchedule` and `depositSchedulePriority` only when `rule.priorityOrder < depositSchedulePriority`
    - Include `depositSchedule` in the `executeRules` return value
    - _Requirements: 5.3, 5.5, 5.6, 6.2, 6.3, 7.3_

- [x] 4. Update quote draft persistence
  - [x] 4.1 Update `save` in `worker/src/services/quote-draft-service.ts`
    - Add `deposit_schedule` to the INSERT statement, bound to `JSON.stringify(draft.depositSchedule) ?? null`
    - _Requirements: 2.5_

  - [x] 4.2 Update `getById` and `list` queries
    - Add `deposit_schedule` to the SELECT column list in both queries
    - _Requirements: 2.6, 4.3, 4.4_

  - [x] 4.3 Update `update` method to handle `depositSchedule`
    - When `updates.depositSchedule !== undefined`, validate the value (if non-null: sum must equal 100, milestones 1–10, each percentage 0.01–100.00) and add `deposit_schedule = ?` to the SET clause bound to `JSON.stringify(updates.depositSchedule) ?? null`
    - Return HTTP 400 `PlatformError` if validation fails, identifying the specific constraint violated
    - _Requirements: 2.7, 2.8, 4.1, 4.5, 4.6_

  - [x] 4.4 Update `mapDraftRow` to deserialize `deposit_schedule`
    - Parse `row.deposit_schedule` with `JSON.parse` inside a `try/catch`; on parse failure, log a warning and return `null` for `depositSchedule` (graceful degradation consistent with `sqft_resolution_json` handling)
    - _Requirements: 2.6_

- [x] 5. Integrate deposit schedule into quote and revision engines
  - [x] 5.1 Extract `depositSchedule` from `RulesEngineResult` in `worker/src/services/quote-engine.ts`
    - After `executeRules`, read `engineResult.depositSchedule` and pass it to `buildDraft` so the returned `QuoteDraft` includes `depositSchedule`
    - _Requirements: 5.7, 5.8_

  - [x] 5.2 Extract `depositSchedule` from `RulesEngineResult` in `worker/src/services/revision-engine.ts`
    - After `executeRules`, read `engineResult.depositSchedule` and include it in `RevisionOutput`
    - In the route handler that calls `revise()`, persist the deposit schedule to the draft via `QuoteDraftService.update({ depositSchedule: revisionOutput.depositSchedule })`
    - _Requirements: 5.7, 5.8, 7.5_

- [x] 6. Update API routes
  - [x] 6.1 Verify `PUT /api/quotes/drafts/:id` passes `depositSchedule` through to `QuoteDraftService.update`
    - Confirm the route handler forwards all `QuoteDraftUpdate` fields; if not, add `depositSchedule` to the fields extracted from the request body
    - The service-layer validation added in task 4.3 handles the 400 responses for invalid schedules
    - _Requirements: 4.1, 4.2, 4.5, 4.6, 4.7_

  - [x] 6.2 Verify `GET /api/quotes/drafts/:id` and `GET /api/quotes/drafts` include `depositSchedule` in responses
    - Confirm the route handlers return the full `QuoteDraft` object from `QuoteDraftService`; since `mapDraftRow` now populates `depositSchedule`, no additional changes should be needed
    - _Requirements: 4.3, 4.4_

- [x] 7. Update Jobber quote push service
  - [x] 7.1 Update `buildQuoteCreateInput` in `worker/src/services/jobber-quote-push-service.ts`
    - Assemble the `message` field in order: (1) `customerNote` if non-null and non-empty, (2) deposit schedule text if `depositSchedule` is non-null and has at least one milestone, (3) unresolved items text if any unresolved line items exist
    - Format deposit schedule text as: `schedule.label` on the first line, then one line per milestone as `• {Math.round(milestone.percentage)}% — {milestone.description}`
    - Join present segments with `\n\n`; omit absent segments entirely
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [x] 8. Update QuoteDraftPage UI
  - [x] 8.1 Add "Payment Schedule" section to `client/src/pages/QuoteDraftPage.tsx`
    - Position the section below the "Note to Customer" section and above the "Push to Jobber" button
    - When `depositSchedule` is non-null: display the schedule `label` as a heading, list each milestone with its `description`, `percentage`, and dollar amount calculated as `(milestone.percentage / 100) × quoteTotal` formatted as USD with `Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })`
    - Compute `quoteTotal` as `draft.lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)`
    - When `depositSchedule` is null: display "No payment schedule has been assigned to this quote."
    - Section is read-only in all draft statuses (no edit controls)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

- [x] 9. Write unit tests
  - [x] 9.1 Write unit tests for rules engine extensions in `tests/unit/rules-engine-deposit.test.ts`
    - Test `validateAction('set_deposit_schedule')`: valid two-milestone schedule passes; sum ≠ 100 fails; non-integer percentage fails; empty milestones array fails; label too long (> 100 chars) fails; empty label fails; more than 10 milestones fails
    - Test `validateCondition('quote_total_gte')`: valid threshold passes; negative threshold fails; non-number threshold fails; missing threshold fails
    - Test `evaluateCondition('quote_total_gte')`: fires at exact threshold (boundary); does not fire below threshold; fires above threshold; empty line items with threshold 0 fires
    - Test `executeAction('set_deposit_schedule')`: sets schedule on result; produces correct before/after sentinel snapshots with `id: '__deposit_schedule__'`; `beforeSnapshot` description is empty string when no prior schedule existed; `beforeSnapshot` description is JSON of prior schedule when one existed
    - Test `executeRules` with no `set_deposit_schedule` rule: `depositSchedule` in result is `null`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 7.1, 10.1, 10.2_

  - [x] 9.2 Write unit tests for Jobber message assembly in `tests/unit/jobber-quote-push-deposit.test.ts`
    - Test all four combinations of null/non-null `customerNote` and `depositSchedule`: both null, note only, schedule only, both present
    - Test that segments are separated by exactly `\n\n` when both are present
    - Test that empty `milestones` array omits deposit schedule text entirely
    - Test that unresolved items text appears after deposit schedule text when all three segments are present
    - Test milestone percentage rendered as whole integer via `Math.round`
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 9.3 Write unit tests for `mapDraftRow` deposit schedule deserialization in `tests/unit/quote-draft-service-deposit.test.ts`
    - Test: valid JSON blob deserializes to correct `DepositSchedule` object
    - Test: malformed JSON in `deposit_schedule` column returns `null` without throwing
    - Test: `null` value in `deposit_schedule` column returns `null`
    - _Requirements: 2.6_

  - [x] 9.4 Write unit tests for Default Note Rule behavior
    - Test: Default Note Rule disabled → `customerNote` is null when no other note rules fire
    - Test: Default Note Rule fires alongside a higher-priority `set_customer_note` rule → higher-priority rule's text wins
    - Test: Default Note Rule fires alongside an `append_customer_note` rule → text is appended to the default note
    - _Requirements: 1.1, 1.2, 1.3, 1.5_

- [x] 10. Write property-based tests
  - [x]* 10.1 Write Property 1 test in `tests/property/quote-terms-and-deposits.property.test.ts`
    - **Property 1: Deposit schedule milestone sum invariant**
    - Generator: arbitrary `DepositSchedule` objects that pass `validateAction` (whole integer percentages summing to 100, 1–10 milestones, label 1–100 chars)
    - Assertion: `sum(schedule.milestones.map(m => m.percentage)) === 100`
    - Minimum 100 runs
    - **Validates: Requirements 2.7, 5.4**

  - [x]* 10.2 Write Property 2 test in `tests/property/quote-terms-and-deposits.property.test.ts`
    - **Property 2: `set_deposit_schedule` priority resolution**
    - Generator: arbitrary array of 2–5 `StructuredRule` objects, each with `always` condition and `set_deposit_schedule` action with a valid schedule, with distinct `priorityOrder` values
    - Assertion: `executeRules(input).depositSchedule` equals the schedule from the rule with `Math.min(...rules.map(r => r.priorityOrder))`
    - Minimum 100 runs
    - **Validates: Requirements 5.3, 6.2, 6.3, 7.3**

  - [x]* 10.3 Write Property 3 test in `tests/property/quote-terms-and-deposits.property.test.ts`
    - **Property 3: `quote_total_gte` boundary correctness**
    - Generator: arbitrary array of `EngineLineItem` objects (quantity ≥ 0, unitPrice ≥ 0) and arbitrary threshold ≥ 0
    - Assertion: `evaluateCondition({ type: 'quote_total_gte', threshold }, lineItems).matched === (computedTotal >= threshold)` where `computedTotal = sum(li.quantity × li.unitPrice)`
    - Minimum 100 runs
    - **Validates: Requirements 7.1**

  - [x]* 10.4 Write Property 4 test in `tests/property/quote-terms-and-deposits.property.test.ts`
    - **Property 4: Jobber message assembly order invariant**
    - Generator: arbitrary nullable `customerNote` string, arbitrary nullable `DepositSchedule` with at least one milestone, arbitrary array of unresolved items
    - Assertion: the assembled message contains present segments in the order customerNote → deposit schedule text → unresolved items text, with each adjacent pair separated by exactly `\n\n`, and absent segments omitted entirely
    - Minimum 100 runs
    - **Validates: Requirements 9.1, 9.4**

  - [x]* 10.5 Write Property 5 test in `tests/property/quote-terms-and-deposits.property.test.ts`
    - **Property 5: `set_customer_note` priority resolution**
    - Generator: arbitrary array of 2–5 `StructuredRule` objects with `always` condition and `set_customer_note` action, with distinct `priorityOrder` values
    - Assertion: `executeRules(input).customerNote` equals the text from the rule with the minimum `priorityOrder`
    - Minimum 100 runs
    - **Validates: Requirements 1.2, 1a.2**

  - [x]* 10.6 Write Property 6 test in `tests/property/quote-terms-and-deposits.property.test.ts`
    - **Property 6: Deposit schedule persistence round-trip**
    - Generator: arbitrary valid `DepositSchedule` (floating-point percentages summing to 100, 1–10 milestones, non-empty descriptions, label 1–100 chars)
    - Assertion: `JSON.parse(JSON.stringify(schedule))` is deeply equal to the original (verifies the serialization round-trip used by `mapDraftRow`)
    - Minimum 100 runs
    - **Validates: Requirements 2.5, 2.6, 4.1, 4.3**

  - [x]* 10.7 Write Property 7 test in `tests/property/quote-terms-and-deposits.property.test.ts`
    - **Property 7: Deposit schedule text formatting**
    - Generator: arbitrary `DepositSchedule` with 1–10 milestones (non-empty descriptions, integer percentages summing to 100)
    - Assertion: the formatted text starts with `schedule.label` on the first line, contains one line per milestone matching `• {n}% — {description}` where `n` is a whole integer, and milestone lines appear in the same order as `schedule.milestones`
    - Minimum 100 runs
    - **Validates: Requirements 9.2**

- [x] 11. Write integration tests
  - [x] 11.1 Write end-to-end quote generation integration tests in `tests/integration/quote-terms-and-deposits.test.ts`
    - Test: quote under $10,000 with all three built-in rules seeded → `customerNote` equals the permit-fee disclaimer and `depositSchedule` equals the Standard Deposit schedule (label "Standard Deposit", two milestones: 30% + 70%)
    - Test: quote over $10,000 with all three built-in rules seeded → `depositSchedule` equals the High-Value Payment Schedule (label "High-Value Payment Schedule", four milestones: 30%/30%/30%/10%)
    - _Requirements: 1.1, 6.1, 6.2, 6.3, 7.2, 7.3_

  - [x] 11.2 Write API integration tests
    - Test: `PUT /api/quotes/drafts/:id` with valid `depositSchedule` → 200 with updated draft containing the schedule
    - Test: `PUT /api/quotes/drafts/:id` with `depositSchedule` whose milestone percentages do not sum to 100 → 400 with message stating percentages must sum to 100
    - Test: `GET /api/quotes/drafts/:id` → response includes `depositSchedule` field (null when not set)
    - _Requirements: 4.1, 4.3, 4.5_

  - [x] 11.3 Write migration safety test
    - Test: migration `0045_deposit_schedule.sql` applied to a database with existing rows → row count unchanged, all non-`deposit_schedule` column values identical, `deposit_schedule` is NULL on all pre-existing rows
    - _Requirements: 3.1, 3.2, 3.3_

- [x] 12. Final checkpoint — Ensure all tests pass
  - Ensure all unit, property-based, and integration tests pass; ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Dependency order: shared types (1) → migrations (2) → rules engine (3) → persistence (4) → engines (5) → API (6) → Jobber push (7) → UI (8) → tests (9–11)
- The Standard Deposit Rule is seeded with **two milestones** (30% + 70%) to satisfy the sum-to-100 invariant, even though Requirement 6.1 describes a single 30% milestone — see the design document's conflict resolution note
- The `deposit_schedule` column uses `ALTER TABLE ADD COLUMN` with `DEFAULT NULL`, which is non-destructive in SQLite and requires no table rewrite
- Rules engine validation for `set_deposit_schedule` requires whole integer percentages; API validation for `PUT /api/quotes/drafts/:id` allows floating-point percentages (up to 2 decimal places) — these are separate validation contexts
- The `mapDraftRow` deserialization uses `try/catch` with graceful degradation to `null` on parse failure, consistent with the existing `sqft_resolution_json` pattern
- Audit trail sentinel entries for `set_deposit_schedule` reuse the existing `AuditEntry` shape with `id: '__deposit_schedule__'`, consistent with how `set_customer_note` uses `__customer_note__`
- Property tests use fast-check and run a minimum of 100 iterations each, tagged with comments referencing the design property they validate
