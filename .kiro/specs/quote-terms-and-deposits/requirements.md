# Requirements Document

## Introduction

This feature adds two capabilities to the Chicago Reno quote generation system:

1. **Default Customer Note**: Every quote automatically receives a standard permit-fee disclaimer note via the rules engine. Additional rules can override or append to this note based on quote contents. The note is already synced to Jobber via the existing `customerNote` / `message` field pipeline.

2. **Deposit Schedule**: Quotes require a structured payment schedule. All quotes carry a 30% deposit requirement. Quotes over $10,000 require a four-milestone payment schedule. The deposit schedule is rules-driven (configurable), displayed on the quote draft page, and synced to Jobber when the quote is published.

The `customerNote` field, rules engine `set_customer_note`/`append_customer_note` actions, and Jobber push pipeline are already implemented. This spec builds on that foundation by (a) defining the default note rule as a formal requirement and (b) introducing the deposit schedule as a new first-class concept.

## Glossary

- **Quote_Draft**: An AI-generated quote with line items stored in the `quote_drafts` D1 table, editable and publishable to Jobber.
- **Customer_Note**: The free-text `customerNote` field on a Quote_Draft, sent to Jobber as the `message` field on publish. Already implemented.
- **Deposit_Schedule**: A structured payment plan attached to a Quote_Draft, consisting of one or more Payment_Milestones that together sum to 100%.
- **Payment_Milestone**: A single entry in a Deposit_Schedule with a label (description of when payment is due) and a percentage of the total quote value.
- **Rules_Engine**: The deterministic rules engine (`RulesEngine`) that evaluates structured conditions against line items and executes typed actions after AI quote generation.
- **RuleAction**: A typed action object executed by the Rules_Engine when a rule's condition matches.
- **Default_Note_Rule**: A built-in rule with `always` condition and `set_customer_note` action that sets the standard permit-fee disclaimer on every quote.
- **Standard_Deposit_Rule**: A built-in rule with `always` condition and `set_deposit_schedule` action that sets the 30% single-deposit schedule on every quote.
- **High_Value_Deposit_Rule**: A built-in rule with a `quote_total_gte` condition and `set_deposit_schedule` action that overrides the schedule with the four-milestone plan for quotes over $10,000.
- **QuoteDraftPage**: The React page component (`client/src/pages/QuoteDraftPage.tsx`) where users view and edit a single quote draft.
- **JobberQuotePushService**: The worker service (`worker/src/services/jobber-quote-push-service.ts`) that pushes a finalized quote draft to Jobber via the `quoteCreate` GraphQL mutation.
- **QuoteDraftService**: The worker service (`worker/src/services/quote-draft-service.ts`) that persists and retrieves quote drafts from D1.

---

## Requirements

### Requirement 1: Default Customer Note Rule

**User Story:** As a user, I want every new quote to automatically include the standard permit-fee disclaimer in the customer note, so that I don't have to manually add it to every quote.

#### Acceptance Criteria

1. WHEN a new Quote_Draft is created, THE Rules_Engine SHALL set the Customer_Note to: `"Estimate does not include permit fees, or permit coordination fees. If customer would like permits pulled for this work, will require change order at additional cost."` via the Default_Note_Rule.
2. WHEN the Default_Note_Rule fires and a subsequent rule with a `set_customer_note` action also fires, THE Rules_Engine SHALL use the value from the rule with the numerically lower priority value, overwriting the default.
3. WHEN the Default_Note_Rule fires and a subsequent rule with an `append_customer_note` action also fires, THE Rules_Engine SHALL append the additional text to the default note, separated by a single space character.
4. THE Default_Note_Rule SHALL be stored as a standard structured rule in the rules database so that it can be edited or disabled through the existing rules management UI without a code deployment.
5. WHEN the Default_Note_Rule is disabled, THE Rules_Engine SHALL not set the default permit-fee text, and the Customer_Note SHALL remain as determined by the rule with the numerically lowest priority value among any other matching note rules, or remain null if no other note rules fire.
6. THE Rules_Engine SHALL support any number of additional user-defined rules that use `set_customer_note` or `append_customer_note` actions to augment the Customer_Note based on quote contents, evaluated alongside the Default_Note_Rule using the same priority resolution.

---

### Requirement 1a: Customer Note Rule Extensibility

**User Story:** As a user, I want to create additional rules that add or replace note text based on what's in the quote, so that customers receive context-specific information relevant to their project.

#### Acceptance Criteria

1. THE Rules_Engine SHALL evaluate all enabled rules with `set_customer_note` or `append_customer_note` actions whose conditions match the current quote, in addition to the Default_Note_Rule, during every quote generation.
2. WHEN multiple rules with `set_customer_note` actions fire during the same execution, THE Rules_Engine SHALL apply only the value from the rule with the numerically lowest priority value; all other `set_customer_note` values SHALL be discarded.
3. WHEN one or more rules with `append_customer_note` actions fire during the same execution, THE Rules_Engine SHALL append each matching rule's text to the active Customer_Note in ascending priority order (lowest priority value first), each separated by a single space character.
4. WHEN both `set_customer_note` and `append_customer_note` rules fire during the same execution, THE Rules_Engine SHALL first resolve the final `set_customer_note` value (lowest priority wins), then append all `append_customer_note` values in ascending priority order.
5. THE Rules_Engine SHALL support condition types including `always`, `line_item_category_includes`, and `quote_total_gte` as triggers for customer note rules, so that note augmentation can be based on the specific contents of a quote.
6. WHEN a user creates a new rule with a `set_customer_note` or `append_customer_note` action through the rules management UI, THE Rules_Engine SHALL include that rule in all subsequent quote evaluations without requiring a code deployment.

---

### Requirement 2: Deposit Schedule Data Model

**User Story:** As a user, I want quote drafts to carry a deposit schedule, so that payment terms are defined and visible before the quote is sent to the customer.

#### Acceptance Criteria

1. THE Quote_Draft SHALL include a `depositSchedule` field of type `DepositSchedule` or `null`.
2. THE `DepositSchedule` type SHALL contain a `milestones` array of between 1 and 10 `PaymentMilestone` objects (inclusive) and a `label` string of between 1 and 100 characters describing the schedule.
3. THE `PaymentMilestone` type SHALL contain a `description` field of type `string` (maximum 255 characters) and a `percentage` field of type `number` between 0.01 and 100.00 (inclusive, up to two decimal places) representing the percentage of the total quote value due at that milestone.
4. WHEN a new Quote_Draft is created, THE QuoteDraftService SHALL default the `depositSchedule` field to `null`.
5. WHEN a Quote_Draft is saved, THE QuoteDraftService SHALL persist the `depositSchedule` field to the `quote_drafts` D1 table as a JSON blob in a `deposit_schedule` column.
6. WHEN a Quote_Draft is retrieved by the QuoteDraftService, THE QuoteDraftService SHALL include the persisted `depositSchedule` value in the returned object.
7. THE sum of all `percentage` values across all milestones in a `DepositSchedule` SHALL equal exactly 100.00.
8. IF a `depositSchedule` is submitted with milestone percentages that do not sum to 100.00, or with any individual percentage outside the valid range, or with a milestones array outside the valid size bounds, THEN THE QuoteDraftService SHALL reject the value and return an error without persisting the invalid schedule.

---

### Requirement 3: Deposit Schedule Database Migration

**User Story:** As a developer, I want the database schema to support the deposit schedule field, so that the data is persisted correctly.

#### Acceptance Criteria

1. THE migration SHALL add a `deposit_schedule` column of type `TEXT` with a default value of `NULL` to the `quote_drafts` table.
2. WHEN the migration is applied, THE migration SHALL leave the total row count in `quote_drafts` unchanged, leave all non-`deposit_schedule` column values on every existing row identical to their pre-migration values, and set `deposit_schedule` to `NULL` on every pre-existing row.
3. IF the migration fails for any reason, THEN THE migration SHALL roll back completely, leaving the `quote_drafts` table in its exact pre-migration state with no partial changes applied.

---

### Requirement 4: Deposit Schedule API Support

**User Story:** As a user, I want to update the deposit schedule through the API, so that I can adjust payment terms before publishing.

#### Acceptance Criteria

1. WHEN a `PUT /api/quotes/drafts/:id` request includes a `depositSchedule` field, THE API SHALL persist the provided value to the Quote_Draft and return the updated Quote_Draft in the response body.
2. WHEN a `PUT /api/quotes/drafts/:id` request omits the `depositSchedule` field, THE API SHALL leave the existing `depositSchedule` value unchanged.
3. WHEN a `GET /api/quotes/drafts/:id` response is returned, THE API SHALL include the `depositSchedule` field in the response body, as `null` when no schedule has been set.
4. WHEN a `GET /api/quotes/drafts` response is returned, THE API SHALL include the `depositSchedule` field on each Quote_Draft in the response body, as `null` for drafts with no schedule set.
5. IF a `PUT /api/quotes/drafts/:id` request includes a `depositSchedule` whose milestone percentages do not sum to 100, THEN THE API SHALL return a 400 error with a message stating that milestone percentages must sum to 100.
6. IF a `PUT /api/quotes/drafts/:id` request includes a `depositSchedule` with any individual milestone percentage outside the range of 1 to 99 inclusive, THEN THE API SHALL return a 400 error with a message identifying the invalid milestone percentage.
7. IF a `PUT /api/quotes/drafts/:id` or `GET /api/quotes/drafts/:id` request references an `:id` that does not match any existing Quote_Draft, THEN THE API SHALL return a 404 error.

---

### Requirement 5: Rules Engine — Set Deposit Schedule Action

**User Story:** As a user, I want rules to automatically assign a deposit schedule based on conditions, so that the correct payment terms are applied consistently without manual entry.

#### Acceptance Criteria

1. THE Rules_Engine SHALL support a `set_deposit_schedule` RuleAction type with a required `schedule` field of type `DepositSchedule`.
2. WHEN a rule with a `set_deposit_schedule` action fires, THE Rules_Engine SHALL set the Deposit_Schedule on the quote to the value of the `schedule` field.
3. IF multiple rules with `set_deposit_schedule` actions fire during the same execution, THEN THE Rules_Engine SHALL use the value from the rule with the numerically lowest priority value; if two rules share the same priority value, the first one evaluated wins.
4. THE Rules_Engine schema validator SHALL validate that `set_deposit_schedule` actions have a `schedule` whose milestone percentages are whole integers and sum to exactly 100; if validation fails, the validator SHALL return an error identifying the failing action and SHALL NOT execute the rule set.
5. THE RulesEngineResult SHALL include a `depositSchedule` field of type `DepositSchedule` or `null`.
6. WHEN no `set_deposit_schedule` action fires during execution, THE RulesEngineResult SHALL return `depositSchedule` as `null`.
7. WHEN the Rules_Engine produces a non-null `depositSchedule`, THE QuoteEngine and RevisionEngine SHALL persist the `depositSchedule` value on the Quote_Draft before returning a result to the caller.
8. IF persisting the `depositSchedule` value fails in QuoteEngine or RevisionEngine, THEN no success result SHALL be returned to the caller.

---

### Requirement 6: Standard Deposit Rule (30% for All Quotes)

**User Story:** As a user, I want every quote to automatically require a 30% deposit, so that the standard payment terms are applied without manual configuration.

#### Acceptance Criteria

1. WHEN a new Quote_Draft is created, THE Rules_Engine SHALL set the Deposit_Schedule to a single-milestone schedule with label `"Standard Deposit"` and exactly one milestone: 30% — `"Deposit due at signing"` via the Standard_Deposit_Rule.
2. WHEN both the Standard_Deposit_Rule and the High_Value_Deposit_Rule fire on the same quote, THE Rules_Engine SHALL apply the High_Value_Deposit_Rule's schedule, and the Standard_Deposit_Rule's schedule SHALL be discarded.
3. IF the High_Value_Deposit_Rule fires on the same quote as the Standard_Deposit_Rule, THEN the resulting Deposit_Schedule on the Quote_Draft SHALL be the High_Value_Deposit_Rule's four-milestone schedule, not the Standard_Deposit_Rule's single-milestone schedule.
4. THE Standard_Deposit_Rule SHALL be stored as a standard structured rule in the rules database so that it can be edited or disabled through the existing rules management UI without a code deployment.

---

### Requirement 7: High-Value Deposit Rule (Four Milestones for Quotes Over $10,000)

**User Story:** As a user, I want quotes over $10,000 to automatically use a four-milestone payment schedule, so that larger projects have structured progress payments.

#### Acceptance Criteria

1. THE Rules_Engine SHALL support a `quote_total_gte` condition type that evaluates to true when the sum of all line item totals (quantity × unit price) is greater than or equal to a specified `threshold` value.
2. THE Rules_Engine SHALL include a High_Value_Deposit_Rule with a `quote_total_gte` condition with `threshold: 10000` and a `set_deposit_schedule` action that sets the Deposit_Schedule to the following four-milestone schedule with label `"High-Value Payment Schedule"`:
   - 30% — `"Deposit due at signing"`
   - 30% — `"Due at completion of rough plumbing and electric"`
   - 30% — `"Due at completion of tile and flooring"`
   - 10% — `"Due at customer sign-off of punch list"`
3. THE High_Value_Deposit_Rule SHALL have a numerically lower priority value than the Standard_Deposit_Rule so that when both rules fire, the High_Value_Deposit_Rule's schedule is the one applied.
4. THE High_Value_Deposit_Rule SHALL be stored as a standard structured rule in the rules database so that it can be edited or disabled through the existing rules management UI without a code deployment.
5. WHEN the total value of a Quote_Draft's line items changes, THE QuoteEngine SHALL re-evaluate deposit schedule rules and replace the Deposit_Schedule with the output of the highest-precedence matching rule; if the updated total drops below $10,000, the Deposit_Schedule SHALL revert to the Standard_Deposit_Rule's single-milestone schedule.

---

### Requirement 8: Deposit Schedule UI Display

**User Story:** As a user, I want to see the deposit schedule on the quote draft page, so that I can review payment terms before publishing.

#### Acceptance Criteria

1. WHEN `depositSchedule` is non-null, THE QuoteDraftPage SHALL display a "Payment Schedule" section showing the active Deposit_Schedule.
2. THE "Payment Schedule" section SHALL display the schedule `label` as a heading and list each Payment_Milestone with its `description` and `percentage`.
3. THE "Payment Schedule" section SHALL display the dollar amount for each milestone, calculated as `percentage / 100 × (sum of quantity × unitPrice across all resolved lineItems)`, formatted as USD currency with a dollar sign, thousands separator, and two decimal places (e.g., $1,234.56).
4. WHEN `depositSchedule` is `null`, THE QuoteDraftPage SHALL display a message within the "Payment Schedule" section indicating that no payment schedule has been assigned.
5. THE "Payment Schedule" section SHALL be positioned below the "Note to Customer" section and above the "Push to Jobber" button.
6. WHEN the Quote_Draft status is `finalized`, THE QuoteDraftPage SHALL display the Deposit_Schedule without any controls to edit or reassign the schedule.

---

### Requirement 9: Jobber Publishing — Include Deposit Schedule

**User Story:** As a user, I want the deposit schedule to be reflected on the Jobber quote when I push it, so that the customer sees the payment terms.

#### Acceptance Criteria

1. WHEN a Quote_Draft with a non-null `depositSchedule` is pushed to Jobber, THE JobberQuotePushService SHALL append the deposit schedule information to the `message` field of the `quoteCreate` mutation, after any existing `customerNote` content, separated by two newline characters.
2. THE deposit schedule text appended to the Jobber message SHALL be formatted as: the schedule `label` on the first line, followed by one line per milestone in the format `• {percentage}% — {description}`, where `percentage` is a whole integer between 0 and 100; if the `milestones` array is empty, no deposit schedule text SHALL be appended.
3. WHEN a Quote_Draft has a `null` `depositSchedule`, THE JobberQuotePushService SHALL not append any deposit schedule text to the Jobber message.
4. THE `message` field sent to Jobber SHALL be assembled in the following order, with each present segment separated by two newline characters: (1) `customerNote` if non-null, (2) deposit schedule text if `depositSchedule` is non-null, (3) unresolved items text if any unresolved line items exist; segments that are null or absent SHALL be omitted entirely.

---

### Requirement 10: Rules Engine Audit Trail for Deposit Schedule Actions

**User Story:** As a user, I want to see which rules set the deposit schedule in the audit trail, so that I can understand how the payment terms were determined.

#### Acceptance Criteria

1. WHEN a `set_deposit_schedule` action fires, THE Rules_Engine SHALL record an AuditEntry containing the name of the rule that triggered the action, the resulting Deposit_Schedule value, a `beforeSnapshot` of the Deposit_Schedule value that was active immediately before the action, and an `afterSnapshot` of the Deposit_Schedule value set by the action.
2. IF no Deposit_Schedule was active before the `set_deposit_schedule` action fires, THEN THE Rules_Engine SHALL record the `beforeSnapshot` field of the AuditEntry as empty, indicating no prior schedule existed.
3. IF the `set_deposit_schedule` action fails to complete, THEN THE Rules_Engine SHALL not record an AuditEntry for that action, leaving the existing Deposit_Schedule and any prior AuditEntries unchanged.

---

### Requirement 11: Shared Types Update

**User Story:** As a developer, I want the shared types to reflect the deposit schedule field and new rule action and condition types, so that both client and worker have consistent type definitions.

#### Acceptance Criteria

1. THE `shared` package SHALL include a `PaymentMilestone` interface with `description: string` and `percentage: number` (0–100 inclusive) fields.
2. THE `shared` package SHALL include a `DepositSchedule` interface with `label: string` and `milestones: PaymentMilestone[]` fields.
3. THE `QuoteDraft` interface in `shared/src/types/quote.ts` SHALL include a `depositSchedule` field of type `DepositSchedule | null`.
4. THE `QuoteDraftUpdate` interface in `shared/src/types/quote.ts` SHALL include an optional `depositSchedule` field of type `DepositSchedule | null`.
5. THE `RuleActionType` union in `shared/src/types/quote.ts` SHALL include `set_deposit_schedule`.
6. THE `RuleAction` union in `shared/src/types/quote.ts` SHALL include a typed variant for `set_deposit_schedule` with a `schedule: DepositSchedule` field.
7. THE `RuleConditionType` union in `shared/src/types/quote.ts` SHALL include `quote_total_gte`.
8. THE `RuleCondition` union in `shared/src/types/quote.ts` SHALL include a typed variant for `quote_total_gte` with a `threshold: number` (≥ 0) field.
9. THE `RulesEngineResult` interface in `shared/src/types/quote.ts` SHALL include a `depositSchedule` field of type `DepositSchedule | null`.
