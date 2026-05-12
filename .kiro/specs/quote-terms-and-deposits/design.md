
# Design Document: Quote Terms and Deposits

## Overview

This feature adds two capabilities to the Chicago Reno quote generation system:

1. **Default Customer Note Rule** — Every quote automatically receives a standard permit-fee disclaimer via the rules engine. The rule is stored as a structured rule in the database so it can be edited or disabled through the existing rules management UI without a code deployment.

2. **Deposit Schedule** — A structured payment plan (`DepositSchedule` with `PaymentMilestone` entries) attached to quote drafts. The schedule is rules-driven: a Standard Deposit Rule applies a 30%/70% two-milestone schedule to all quotes, and a High-Value Deposit Rule overrides it with a four-milestone schedule for quotes over $10,000. The schedule is displayed on the `QuoteDraftPage` and appended to the Jobber message on publish.

Both capabilities build on the existing rules engine architecture. The `customerNote` pipeline is already implemented; this spec formalizes the Default Note Rule as a stored rule and introduces `depositSchedule` as a new first-class field on `QuoteDraft`.

### Conflict Resolution: Standard Deposit Rule Milestone Sum

Requirement 6.1 describes the Standard Deposit Rule as having a single milestone at 30%. However, Requirement 5.4 mandates that milestone percentages in rules engine actions must be whole integers summing to exactly 100. A single 30% milestone fails this invariant.

**Resolution**: The Standard Deposit Rule is seeded with **two milestones**: 30% "Deposit due at signing" and 70% "Balance due at completion of work". This satisfies the sum-to-100 invariant while preserving the intent of the requirement (a 30% upfront deposit). The label remains "Standard Deposit".

---

## Architecture

The feature touches four layers:

```text
┌─────────────────────────────────────────────────────────────┐
│  Shared Types (shared/src/types/quote.ts)                   │
│  + PaymentMilestone, DepositSchedule                        │
│  + QuoteDraft.depositSchedule                               │
│  + RuleActionType: set_deposit_schedule                     │
│  + RuleConditionType: quote_total_gte                       │
│  + RulesEngineResult.depositSchedule                        │
└─────────────────────────────────────────────────────────────┘
           ↕ types
┌─────────────────────────────────────────────────────────────┐
│  Rules Engine (worker/src/services/rules-engine.ts)         │
│  + evaluateCondition: quote_total_gte case                  │
│  + executeAction: set_deposit_schedule case                 │
│  + validateCondition: quote_total_gte validation            │
│  + validateAction: set_deposit_schedule validation          │
│  + executeRules: depositSchedule in result                  │
└─────────────────────────────────────────────────────────────┘
           ↕ engineResult.depositSchedule
┌─────────────────────────────────────────────────────────────┐
│  Quote/Revision Engines                                     │
│  quote-engine.ts: extract depositSchedule → buildDraft      │
│  revision-engine.ts: extract depositSchedule → output       │
└─────────────────────────────────────────────────────────────┘
           ↕ draft.depositSchedule
┌─────────────────────────────────────────────────────────────┐
│  Persistence (quote-draft-service.ts)                       │
│  + deposit_schedule column (JSON blob)                      │
│  + INSERT/SELECT/UPDATE queries updated                     │
│  + mapDraftRow: deserialize JSON blob                       │
└─────────────────────────────────────────────────────────────┘
           ↕ API / Client
┌─────────────────────────────────────────────────────────────┐
│  Client (QuoteDraftPage.tsx)                                │
│  + "Payment Schedule" section                               │
│  + Milestone dollar amount calculation                      │
└─────────────────────────────────────────────────────────────┘
           ↕ Jobber push
┌─────────────────────────────────────────────────────────────┐
│  Jobber Push (jobber-quote-push-service.ts)                 │
│  + buildQuoteCreateInput: message assembly order            │
└─────────────────────────────────────────────────────────────┘
```

### Rules Engine Priority Resolution

The deposit schedule follows the same priority pattern as `customerNote`:

- **`set_deposit_schedule`**: Lowest `priorityOrder` wins. All other `set_deposit_schedule` values are discarded.
- There is no `append_deposit_schedule` action — schedules are always replaced, never merged.
- The High-Value Deposit Rule has `priorityOrder: 100`; the Standard Deposit Rule has `priorityOrder: 200`. When both fire (quote ≥ $10,000), the High-Value rule wins.

### `quote_total_gte` Condition

Computes `sum(lineItem.quantity × lineItem.unitPrice)` across all current `EngineLineItem` entries and evaluates to `true` when the total is ≥ the specified `threshold`. This is evaluated against the line items at the time the condition is checked during rules engine execution.

---

## Components and Interfaces

### Shared Types (`shared/src/types/quote.ts`)

New interfaces:

```typescript
/** A single payment milestone within a deposit schedule */
export interface PaymentMilestone {
  /** Human-readable label for when this payment is due (max 255 chars) */
  description: string;
  /** Percentage of total quote value due at this milestone (0.01–100.00, up to 2 decimal places) */
  percentage: number;
}

/** A structured payment plan attached to a quote draft */
export interface DepositSchedule {
  /** Human-readable name for the schedule (1–100 chars) */
  label: string;
  /** Ordered list of payment milestones (1–10 entries); percentages must sum to 100.00 */
  milestones: PaymentMilestone[];
}
```

Extensions to existing types:

```typescript
// QuoteDraft — add:
depositSchedule: DepositSchedule | null;

// QuoteDraftUpdate — add:
depositSchedule?: DepositSchedule | null;

// RuleConditionType — add member:
| 'quote_total_gte'

// RuleCondition — add variant:
| { type: 'quote_total_gte'; threshold: number }

// RuleActionType — add member:
| 'set_deposit_schedule'

// RuleAction — add variant:
| { type: 'set_deposit_schedule'; schedule: DepositSchedule }

// RulesEngineResult — add field:
depositSchedule: DepositSchedule | null;
```

### Rules Engine (`worker/src/services/rules-engine.ts`)

**New internal state in `executeRules`:**

```typescript
let depositSchedule: DepositSchedule | null = null;
let depositSchedulePriority: number = Infinity; // tracks winning rule's priorityOrder
```

**`ActionResult` interface extension:**

```typescript
interface ActionResult {
  // ... existing fields ...
  depositScheduleValue?: DepositSchedule;
}
```

**`executeAction` — new `set_deposit_schedule` case:**

The action receives the current `depositSchedule` state (passed as a parameter alongside `customerNote`) and returns a new `depositScheduleValue`. The before/after snapshots use a sentinel entry with `id: '__deposit_schedule__'` to record the schedule change in the audit trail, consistent with how `set_customer_note` uses `__customer_note__`.

**Priority resolution in `executeRules` main loop:**

```typescript
if (actionResult.depositScheduleValue !== undefined) {
  // Lowest priorityOrder wins — only update if this rule has higher precedence
  if (rule.priorityOrder < depositSchedulePriority) {
    depositSchedule = actionResult.depositScheduleValue;
    depositSchedulePriority = rule.priorityOrder;
  }
}
```

**`evaluateCondition` — new `quote_total_gte` case:**

```typescript
case 'quote_total_gte': {
  const total = lineItems.reduce((sum, li) => sum + li.quantity * li.unitPrice, 0);
  const matched = total >= condition.threshold;
  return {
    matched,
    matchingLineItemIds: matched ? lineItems.map((li) => li.id) : [],
  };
}
```

**`validateCondition` — new `quote_total_gte` case:**

Validates that `threshold` is a finite non-negative number.

**`validateAction` — new `set_deposit_schedule` case:**

Validates:
- `schedule` is a non-null object
- `schedule.label` is a non-empty string of 1–100 characters
- `schedule.milestones` is an array of 1–10 entries
- Each milestone `percentage` is a whole integer between 1 and 100
- Each milestone `description` is a non-empty string
- Sum of all `percentage` values equals exactly 100

**Updated `executeRules` return:**

```typescript
return { lineItems, auditTrail, iterationCount, converged, pendingEnrichments, customerNote, depositSchedule };
```

### Quote Draft Service (`worker/src/services/quote-draft-service.ts`)

- `save`: add `deposit_schedule` to the INSERT statement, bound to `draft.depositSchedule ? JSON.stringify(draft.depositSchedule) : null` (stores SQL NULL when no schedule is set).
- `getById` / `list`: add `deposit_schedule` to SELECT column lists.
- `update`: handle `updates.depositSchedule !== undefined` — validate (if non-null), then add `deposit_schedule = ?` to SET clauses.
- `mapDraftRow`: deserialize `deposit_schedule` JSON blob with try/catch, returning `null` on parse failure (graceful degradation consistent with `sqft_resolution_json`).

### Quote Engine (`worker/src/services/quote-engine.ts`)

After `executeRules`, extract `engineResult.depositSchedule` and pass it to `buildDraft`. The `buildDraft` method includes `depositSchedule` in the returned `QuoteDraft`.

### Revision Engine (`worker/src/services/revision-engine.ts`)

After `executeRules`, extract `engineResult.depositSchedule` and include it in `RevisionOutput`. The route handler that calls `revise()` then persists the deposit schedule to the draft via `QuoteDraftService.update`.

### Jobber Quote Push Service (`worker/src/services/jobber-quote-push-service.ts`)

Updated `buildQuoteCreateInput` message assembly order:

1. `customerNote` (if non-null and non-empty)
2. Deposit schedule text (if `depositSchedule` is non-null and has at least one milestone): schedule `label` on the first line, then `• {percentage}% — {description}` per milestone
3. Unresolved items text (if any unresolved line items exist)

Each present segment is joined with `\n\n`. Absent segments are omitted entirely.

Milestone percentages are rendered as `Math.round(milestone.percentage)` to ensure whole integers in the Jobber message. API validation requires integer percentages (consistent with rules engine validation), so `Math.round` is a no-op for valid data and a safety net for any legacy float values.

### QuoteDraftPage (`client/src/pages/QuoteDraftPage.tsx`)

A new "Payment Schedule" section is rendered below the "Note to Customer" section and above the "Push to Jobber" button.

**Milestone dollar amount calculation:**

```typescript
const quoteTotal = draft.lineItems.reduce(
  (sum, item) => sum + item.quantity * item.unitPrice, 0
);
const formatUSD = (amount: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
```

**Section behavior:**
- When `depositSchedule` is non-null: display the schedule `label` as a heading, list each milestone with its `description`, `percentage`, and calculated dollar amount.
- When `depositSchedule` is null: display "No payment schedule has been assigned to this quote." with an option to add one.
- When `draft.status !== 'finalized'`: edit controls are available — users can edit the schedule label, add/edit/remove milestones, and assign a new `depositSchedule`.
- When `draft.status === 'finalized'`: the section is read-only with no edit controls.

---

## Data Models

### Database Schema

**Migration `0045_deposit_schedule.sql`:**

```sql
-- Add deposit_schedule column to quote_drafts
-- SQLite ALTER TABLE ADD COLUMN with DEFAULT NULL is non-destructive:
-- existing rows get NULL without a table rewrite.
ALTER TABLE quote_drafts ADD COLUMN deposit_schedule TEXT DEFAULT NULL;
```

**Seed migration `0046_seed_deposit_rules.sql`:**

Creates a "Quote Terms" rule group (if it doesn't exist) and inserts the three built-in rules using `INSERT OR IGNORE` for idempotency. The rules reference the group by a stable UUID assigned in the migration.

Built-in rules summary:

| Rule | priorityOrder | Condition | Action |
|------|--------------|-----------|--------|
| Default Note Rule | 100 | `always` | `set_customer_note` with permit-fee disclaimer |
| High-Value Deposit Rule | 100 | `quote_total_gte` threshold: 10000 | `set_deposit_schedule` with 4-milestone schedule |
| Standard Deposit Rule | 200 | `always` | `set_deposit_schedule` with 2-milestone schedule (30% + 70%) |

Note: Default Note Rule and High-Value Deposit Rule share `priorityOrder: 100` — this is intentional since they act on different fields (`customerNote` vs `depositSchedule`) and do not conflict.

### DepositSchedule JSON Blob

Stored in `quote_drafts.deposit_schedule` as a JSON-serialized `DepositSchedule`:

```json
{
  "label": "Standard Deposit",
  "milestones": [
    { "percentage": 30, "description": "Deposit due at signing" },
    { "percentage": 70, "description": "Balance due at completion of work" }
  ]
}
```

### AuditEntry Snapshots for Deposit Schedule Actions

The existing `AuditEntry.beforeSnapshot` and `afterSnapshot` fields are arrays of line item snapshot objects. For `set_deposit_schedule` actions, a sentinel entry is used (consistent with how `set_customer_note` uses `__customer_note__`):

```typescript
// beforeSnapshot when no prior schedule existed:
{ id: '__deposit_schedule__', productName: 'Deposit Schedule', description: '', quantity: 0, unitPrice: 0 }

// beforeSnapshot when a prior schedule existed:
{ id: '__deposit_schedule__', productName: 'Deposit Schedule', description: JSON.stringify(previousSchedule), quantity: 0, unitPrice: 0 }

// afterSnapshot:
{ id: '__deposit_schedule__', productName: 'Deposit Schedule', description: JSON.stringify(newSchedule), quantity: 0, unitPrice: 0 }
```

This reuses the existing `AuditEntry` shape without requiring a schema change.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Deposit schedule milestone sum invariant

*For any* `DepositSchedule` produced by the rules engine (i.e., any `set_deposit_schedule` action that passes schema validation), the sum of all `milestone.percentage` values SHALL equal exactly 100.

**Validates: Requirements 2.7, 5.4**

### Property 2: `set_deposit_schedule` priority resolution

*For any* set of rules containing two or more `set_deposit_schedule` actions whose conditions all evaluate to true, the `depositSchedule` in the `RulesEngineResult` SHALL be the schedule from the rule with the numerically lowest `priorityOrder` value.

**Validates: Requirements 5.3, 6.2, 6.3, 7.3**

### Property 3: `quote_total_gte` boundary correctness

*For any* set of line items and any threshold value, the `quote_total_gte` condition SHALL evaluate to `true` when `sum(quantity × unitPrice) >= threshold` and to `false` when `sum(quantity × unitPrice) < threshold`. This must hold at exact boundary values (e.g., total = threshold exactly).

**Validates: Requirements 7.1**

### Property 4: Jobber message assembly order invariant

*For any* combination of `customerNote` (null or non-null string), `depositSchedule` (null or non-null), and `unresolvedItems` (empty or non-empty array), the assembled Jobber `message` string SHALL contain the present segments in the order: customerNote → deposit schedule text → unresolved items text, with each pair of adjacent present segments separated by exactly `\n\n`, and absent segments omitted entirely.

**Validates: Requirements 9.1, 9.4**

### Property 5: `set_customer_note` priority resolution

*For any* set of rules containing two or more `set_customer_note` actions whose conditions all evaluate to true, the `customerNote` in the `RulesEngineResult` SHALL be the text from the rule with the numerically lowest `priorityOrder` value.

**Validates: Requirements 1.2, 1a.2**

### Property 6: Deposit schedule persistence round-trip

*For any* valid `DepositSchedule`, saving a `QuoteDraft` with that schedule and then retrieving it SHALL return a `depositSchedule` field that is deeply equal to the original value.

**Validates: Requirements 2.5, 2.6, 4.1, 4.3**

### Property 7: Deposit schedule text formatting

*For any* non-null `DepositSchedule` with at least one milestone, the formatted deposit schedule text appended to the Jobber message SHALL begin with the schedule `label` on the first line, followed by one line per milestone in the format `• {percentage}% — {description}`, where `percentage` is rendered as a whole integer.

**Validates: Requirements 9.2**

---

## Error Handling

### Rules Engine Validation Errors

- `validateAction` for `set_deposit_schedule` returns a structured error if: `schedule` is missing or not an object; `label` is empty or exceeds 100 chars; `milestones` array is empty, exceeds 10 entries, or is not an array; any milestone `percentage` is not a whole integer, is < 1, or is > 100; milestone percentages do not sum to 100.
- `validateCondition` for `quote_total_gte` returns a structured error if `threshold` is missing, not a number, not finite, or negative.
- Invalid rules are skipped at runtime with a warning `AuditEntry` (existing behavior), so a single bad rule does not block the entire engine.

### API Validation Errors

- `PUT /api/quotes/drafts/:id` with a `depositSchedule` whose milestone percentages do not sum to 100 → HTTP 400: `"Deposit schedule milestone percentages must sum to 100"`.
- `PUT /api/quotes/drafts/:id` with any individual milestone percentage outside 0.01–100.00 → HTTP 400 identifying the invalid percentage.
- `PUT /api/quotes/drafts/:id` with a `milestones` array outside 1–10 entries → HTTP 400.
- Note: API validation uses floating-point percentages (up to 2 decimal places); rules engine validation requires whole integers. These are separate validation contexts.

### Persistence Errors

- If `JSON.parse` fails on `deposit_schedule` during `mapDraftRow`, the error is logged as a warning and `depositSchedule` is returned as `null` (graceful degradation, consistent with `sqft_resolution_json` handling).
- If persisting `depositSchedule` fails in `QuoteEngine` or `RevisionEngine`, the error propagates to the caller as a `PlatformError` (Requirement 5.8).

### Jobber Push

- If `depositSchedule` is non-null but `milestones` is empty, no deposit schedule text is appended (Requirement 9.2).
- Milestone percentages are rendered as `Math.round(milestone.percentage)` to ensure whole integers in the Jobber message.

---

## Testing Strategy

### Unit Tests

Unit tests cover specific examples and edge cases:

- `validateAction('set_deposit_schedule')`: valid schedule passes; sum ≠ 100 fails; non-integer percentage fails; empty milestones fails; label too long fails; label empty fails.
- `validateCondition('quote_total_gte')`: valid threshold passes; negative threshold fails; non-number threshold fails.
- `evaluateCondition('quote_total_gte')`: fires at exact threshold; does not fire below threshold; fires above threshold.
- `executeAction('set_deposit_schedule')`: sets schedule on result; produces correct before/after snapshots with sentinel IDs.
- `buildQuoteCreateInput` message assembly: all four combinations of null/non-null `customerNote` and `depositSchedule`; empty milestones array omits deposit text; segments separated by `\n\n`.
- `mapDraftRow`: malformed `deposit_schedule` JSON returns `null` without throwing.
- Default Note Rule disabled → `customerNote` is null.
- `RulesEngineResult.depositSchedule` is null when no `set_deposit_schedule` rule fires.

### Property-Based Tests (fast-check)

Property tests use fast-check and run a minimum of 100 iterations each. Each test is tagged with a comment referencing the design property it validates.

**Feature: quote-terms-and-deposits, Property 1: Deposit schedule milestone sum invariant**
- Generator: arbitrary `DepositSchedule` objects that pass `validateAction` (whole integer percentages summing to 100, 1–10 milestones, label 1–100 chars).
- Assertion: `sum(schedule.milestones.map(m => m.percentage)) === 100`.

**Feature: quote-terms-and-deposits, Property 2: set_deposit_schedule priority resolution**
- Generator: arbitrary array of 2–5 `StructuredRule` objects, each with `always` condition and `set_deposit_schedule` action with a valid schedule, with distinct `priorityOrder` values.
- Assertion: `executeRules(input).depositSchedule` equals the schedule from the rule with `Math.min(...rules.map(r => r.priorityOrder))`.

**Feature: quote-terms-and-deposits, Property 3: quote_total_gte boundary correctness**
- Generator: arbitrary array of `EngineLineItem` objects (quantity ≥ 0, unitPrice ≥ 0) and arbitrary threshold ≥ 0.
- Assertion: `evaluateCondition({ type: 'quote_total_gte', threshold }, lineItems).matched === (computedTotal >= threshold)`.

**Feature: quote-terms-and-deposits, Property 4: Jobber message assembly order invariant**
- Generator: arbitrary nullable `customerNote` string, arbitrary nullable `DepositSchedule`, arbitrary array of unresolved items.
- Assertion: the assembled message contains present segments in the correct order, separated by `\n\n`, with absent segments omitted.

**Feature: quote-terms-and-deposits, Property 5: set_customer_note priority resolution**
- Generator: arbitrary array of 2–5 `StructuredRule` objects with `always` condition and `set_customer_note` action, distinct `priorityOrder` values.
- Assertion: `executeRules(input).customerNote` equals the text from the rule with the minimum `priorityOrder`.

**Feature: quote-terms-and-deposits, Property 6: Deposit schedule persistence round-trip**
- Generator: arbitrary valid `DepositSchedule` (floating-point percentages summing to 100, 1–10 milestones).
- Assertion: `JSON.parse(JSON.stringify(schedule))` is deeply equal to the original (verifies the serialization round-trip used by `mapDraftRow`).

**Feature: quote-terms-and-deposits, Property 7: Deposit schedule text formatting**
- Generator: arbitrary `DepositSchedule` with 1–10 milestones (non-empty descriptions, integer percentages).
- Assertion: the formatted text starts with `schedule.label`, contains one line per milestone matching `• {n}% — {description}`, and milestone lines appear in order.

### Integration Tests

- End-to-end quote generation with all three built-in rules seeded: verify `customerNote` equals the permit-fee disclaimer and `depositSchedule` equals the Standard Deposit schedule for a quote under $10,000.
- End-to-end quote generation for a quote over $10,000: verify `depositSchedule` equals the High-Value Payment Schedule.
- `PUT /api/quotes/drafts/:id` with valid `depositSchedule` → 200 with updated draft containing the schedule.
- `PUT /api/quotes/drafts/:id` with invalid `depositSchedule` (sum ≠ 100) → 400.
- Migration `0045_deposit_schedule.sql` applied to a database with existing rows: verify row count unchanged and `deposit_schedule` is NULL on all pre-existing rows.
