# Requirements Document

## Introduction

The Context-Aware Quantity Rules feature extends the existing rules engine to extract numeric and categorical context from customer request text and use that context to compute line item quantities deterministically. Currently, when a customer request mentions scope indicators like "fully gutted 1500 sqft property needs drywall," the AI defaults quantity to 1 and the rules engine can only set static values. This feature bridges that gap by enabling rules that extract values (square footage, room counts, scope keywords) from the request text and apply configurable formulas to compute appropriate quantities — without any AI dependency at runtime.

## Glossary

- **Rules_Engine**: The existing deterministic rules engine that evaluates conditions against line items and request text, then executes actions to modify the quote
- **Context_Variable**: A named value extracted from the customer request text during condition evaluation, available for use in subsequent actions within the same rule (e.g., `sqft = 1500`)
- **Extraction_Pattern**: A regex pattern with a named capture group used to extract numeric or string values from customer request text
- **Computed_Quantity**: A quantity value calculated from a formula that references one or more Context_Variables and literal constants
- **Scope_Indicator**: A keyword or phrase in the customer request text that signals the scale or nature of the work (e.g., "fully gutted", "full property", "per room")
- **Rate_Formula**: A mathematical expression that computes a quantity from extracted context values (e.g., `sqft / 100 * 4` meaning 4 hours per 100 sqft)
- **Context_Extraction_Condition**: A new condition type that both tests for the presence of a pattern in the request text AND extracts a value into a Context_Variable
- **EngineLineItem**: The internal representation of a line item used by the rules engine during evaluation

## Requirements

### Requirement 1: Extract Numeric Values from Request Text

**User Story:** As a business owner, I want rules that can extract numeric values (square footage, room counts, floor counts) from customer request text, so that quantities can be calculated based on actual project scope.

#### Acceptance Criteria

1. WHEN a rule has a condition of type `request_text_extract`, THE Rules_Engine SHALL apply the specified regex pattern against the customer request text and extract the first matching capture group value
2. WHEN the regex pattern matches and produces a numeric capture group, THE Rules_Engine SHALL store the extracted value as a Context_Variable with the specified variable name for use by actions in the same rule
3. IF the regex pattern does not match the customer request text, THEN THE Rules_Engine SHALL treat the condition as not matched and skip the rule's actions
4. WHEN multiple numeric values could match the pattern, THE Rules_Engine SHALL extract the first match found in the text
5. THE Rules_Engine SHALL support extraction of integer and decimal numeric values from the captured text

### Requirement 2: Detect Scope Indicator Keywords

**User Story:** As a business owner, I want rules that detect scope keywords like "fully gutted" or "full property" in the request text, so that I can apply different quantity calculations based on the nature of the work.

#### Acceptance Criteria

1. WHEN a rule has a condition of type `request_text_extract` with a pattern that matches a scope keyword, THE Rules_Engine SHALL store the matched keyword as a string Context_Variable
2. WHEN a rule has multiple conditions combined (a `request_text_contains` condition AND a `request_text_extract` condition), THE Rules_Engine SHALL require all conditions to match before executing actions
3. THE Rules_Engine SHALL perform case-insensitive matching for scope indicator keyword extraction
4. WHEN a scope keyword is extracted, THE Rules_Engine SHALL make it available as a Context_Variable alongside any numeric extractions from the same rule

### Requirement 3: Compute Quantities from Extracted Context

**User Story:** As a business owner, I want to define rate-based formulas that calculate quantities from extracted values, so that labor hours and material quantities reflect the actual project scope.

#### Acceptance Criteria

1. WHEN a rule has an action of type `compute_quantity`, THE Rules_Engine SHALL evaluate the specified Rate_Formula using the Context_Variables extracted by the rule's conditions
2. THE Rules_Engine SHALL support formulas containing: Context_Variable references, literal numeric constants, and the arithmetic operators addition, subtraction, multiplication, and division
3. WHEN a formula references a Context_Variable that was not extracted (condition did not match), THE Rules_Engine SHALL skip the action and record a warning in the audit trail
4. THE Rules_Engine SHALL round computed quantity values to the nearest integer (quantities represent whole units of labor hours or material units)
5. IF a computed quantity evaluates to zero or a negative number, THEN THE Rules_Engine SHALL set the quantity to 1 and record a warning in the audit trail
6. IF a formula produces a non-finite result (division by zero, overflow), THEN THE Rules_Engine SHALL skip the action and record an error in the audit trail

### Requirement 4: Compound Conditions for Context Rules

**User Story:** As a business owner, I want rules that combine product matching with context extraction, so that computed quantities are applied only to the correct line items.

#### Acceptance Criteria

1. WHEN a rule has a condition of type `compound`, THE Rules_Engine SHALL evaluate all sub-conditions and require every sub-condition to match before the rule fires
2. THE Rules_Engine SHALL support combining `line_item_exists` or `line_item_name_contains` conditions with `request_text_extract` conditions within a single compound condition
3. WHEN a compound condition matches, THE Rules_Engine SHALL make all Context_Variables from all sub-conditions available to the rule's actions
4. THE Rules_Engine SHALL evaluate sub-conditions in the order they are defined, stopping early if any sub-condition does not match

### Requirement 5: Formula Validation and Storage

**User Story:** As a business owner, I want the system to validate my quantity formulas when I create rules, so that I know immediately if a formula is malformed rather than discovering errors at quote generation time.

#### Acceptance Criteria

1. WHEN a rule with a `compute_quantity` action is created or updated, THE Rules_Engine SHALL validate that the formula syntax is correct and contains only allowed operators and variable references
2. IF a formula references a variable name that does not correspond to any extraction pattern in the rule's conditions, THEN THE Rules_Engine SHALL reject the rule with a descriptive error message
3. THE Rules_Engine SHALL reject formulas containing function calls, string operations, or any construct beyond arithmetic expressions and variable references
4. WHEN a rule with a `request_text_extract` condition is created, THE Rules_Engine SHALL validate that the regex pattern is syntactically valid and contains exactly one capture group

### Requirement 6: Audit Trail for Computed Quantities

**User Story:** As a business owner, I want to see how computed quantities were derived, so that I can verify the calculations and adjust rates if needed.

#### Acceptance Criteria

1. WHEN a `compute_quantity` action is executed, THE Rules_Engine SHALL record in the audit trail: the formula used, the Context_Variable values substituted, and the resulting computed quantity
2. THE Rules_Engine SHALL include the extracted raw text that produced each Context_Variable value in the audit entry
3. WHEN a computed quantity overrides a previous quantity (from AI estimation or historical prediction), THE Rules_Engine SHALL record both the previous and new quantity values in the audit trail
4. THE Rules_Engine SHALL record the regex pattern and the matched text segment for each successful extraction in the audit trail

### Requirement 7: Integration with Existing Rules Engine Pipeline

**User Story:** As a system operator, I want context-aware quantity rules to work within the existing rules engine execution model, so that rule priority, chaining, and convergence behavior remain consistent.

#### Acceptance Criteria

1. THE Rules_Engine SHALL evaluate context-aware rules in priority order alongside existing rule types, using the same iteration and convergence model
2. WHEN a context-aware rule modifies a quantity, THE Rules_Engine SHALL mark the affected line items with the rule ID in `ruleIdsApplied`, consistent with existing rule behavior
3. THE Rules_Engine SHALL support both `on_create` and `chained` trigger modes for context-aware rules
4. WHEN a subsequent rule (context-aware or static) targets the same line item, THE Rules_Engine SHALL allow it to override the computed quantity, following standard priority ordering
5. Context_Variables extracted by one rule SHALL NOT be accessible to other rules — each rule's extraction is scoped to its own condition-action evaluation

### Requirement 8: Predefined Extraction Patterns

**User Story:** As a business owner, I want common extraction patterns available as presets, so that I can create context-aware rules without writing regex patterns manually.

#### Acceptance Criteria

1. THE Rules_Engine SHALL provide a preset extraction pattern for square footage that matches common formats including "1500 sqft", "1,500 sq ft", "1500 square feet", and "1500sf"
2. THE Rules_Engine SHALL provide a preset extraction pattern for room count that matches formats including "3 rooms", "3 bedrooms", "3 bathrooms", and "3 bed/bath"
3. THE Rules_Engine SHALL provide a preset extraction pattern for floor count that matches formats including "2 floors", "2 stories", "2 levels", and "2-story"
4. WHEN a preset pattern is used, THE Rules_Engine SHALL store the resolved regex in the rule's condition so that rule evaluation does not depend on preset definitions at runtime
5. THE Rules_Engine SHALL allow custom regex patterns in addition to presets for cases not covered by the predefined set

### Requirement 9: Context-Aware Rule Configuration UI

**User Story:** As a business owner, I want to create and manage context-aware quantity rules through the existing rules management interface, so that I can configure rate-based calculations without developer assistance.

#### Acceptance Criteria

1. WHEN creating a new rule, THE Client SHALL offer a "Context-Aware Quantity" rule type that presents extraction pattern selection and formula configuration
2. THE Client SHALL display preset extraction patterns as selectable options with descriptions of what each pattern matches
3. THE Client SHALL provide a formula input field that shows available Context_Variable names from the configured extraction patterns
4. WHEN a rule is saved, THE Client SHALL display validation errors returned by the API for invalid patterns or formulas
5. THE Client SHALL display a preview of how the rule would evaluate against a sample request text entered by the user
