# Requirements Document

## Introduction

The Quantity Engine enhances the quote generation flow by predicting accurate line item quantities based on historical quote data and allowing rules-based adjustments. Currently, the AI estimates quantities from customer request text (often defaulting to 1), and the rules engine can override them with static values. The Quantity Engine bridges this gap by analyzing past quotes for similar work to derive statistically-informed quantity predictions — for example, recognizing that tiling a standard mosaic shower floor historically takes 18 hours of labor.

## Glossary

- **Quantity_Engine**: The service responsible for predicting line item quantities based on historical data and applying those predictions during quote generation
- **Quote_Corpus**: The existing database table storing historical Jobber quotes with text embeddings for similarity search
- **Quantity_History**: A new data store that records product-quantity associations extracted from finalized historical quotes, along with contextual metadata
- **Quantity_Prediction**: A suggested quantity value for a specific product, derived from historical patterns, accompanied by a confidence score and source references
- **Similar_Quote**: A past quote found via embedding-based cosine similarity search against the quote corpus
- **Rules_Engine**: The existing deterministic rules engine that can override or adjust quantities via `set_quantity` and `adjust_quantity` actions
- **Confidence_Score**: A numeric value (0–100) indicating how reliable a quantity prediction is, based on sample size and variance in historical data
- **Quote_Generation_Flow**: The end-to-end process of creating a quote draft from a customer request, including AI generation, quantity prediction, and rules application

## Requirements

### Requirement 1: Extract Quantity Data from Historical Quotes

**User Story:** As a quote generator, I want to extract and store product-quantity associations from finalized historical quotes, so that the system can learn typical quantities for specific types of work.

#### Acceptance Criteria

1. WHEN a quote corpus sync completes, THE Quantity_Engine SHALL extract line item product names and quantities from each synced quote's message field and store them in the Quantity_History table
2. THE Quantity_History SHALL store the product name, quantity value, source quote identifier, and the searchable text context for each extracted record
3. IF the message field of a historical quote does not contain parseable line item data, THEN THE Quantity_Engine SHALL skip that quote without error and continue processing remaining quotes
4. WHEN a quantity record already exists for the same product and source quote, THE Quantity_Engine SHALL update the existing record rather than creating a duplicate

### Requirement 2: Predict Quantities from Historical Data

**User Story:** As a quote generator, I want to receive quantity predictions based on similar past quotes, so that line items have accurate quantities without manual adjustment.

#### Acceptance Criteria

1. WHEN similar quotes are found for a customer request, THE Quantity_Engine SHALL compute a predicted quantity for each line item by analyzing quantity values from matching products in those similar quotes
2. THE Quantity_Engine SHALL weight quantity predictions by the similarity score of the source quote, giving higher weight to more similar past quotes
3. THE Quantity_Engine SHALL produce a Confidence_Score for each prediction based on the number of historical data points and the variance among them
4. WHEN fewer than 2 historical data points exist for a product, THE Quantity_Engine SHALL assign a Confidence_Score of 0 and fall back to the AI-estimated quantity
5. THE Quantity_Engine SHALL return the predicted quantity, confidence score, and a list of source quote references for each prediction

### Requirement 3: Integrate Predictions into Quote Generation Flow

**User Story:** As a quote generator, I want quantity predictions applied automatically during quote creation, so that generated quotes have historically-informed quantities without extra manual steps.

#### Acceptance Criteria

1. WHEN a quote is generated and quantity predictions are available, THE Quote_Generation_Flow SHALL apply predicted quantities to matching line items before the rules engine executes
2. THE Quote_Generation_Flow SHALL apply a quantity prediction only when the prediction Confidence_Score exceeds a configurable threshold (default: 50)
3. WHILE a quantity prediction is applied to a line item, THE Quote_Generation_Flow SHALL record the prediction source on that line item for traceability
4. THE Quote_Generation_Flow SHALL preserve the AI-estimated quantity when no prediction meets the confidence threshold for a given line item

### Requirement 4: Rules-Based Quantity Adjustments Override Predictions

**User Story:** As a business owner, I want rules to take precedence over historical predictions, so that I can enforce specific quantity policies regardless of what historical data suggests.

#### Acceptance Criteria

1. THE Rules_Engine SHALL execute after the Quantity_Engine applies predictions, allowing `set_quantity` and `adjust_quantity` actions to override predicted values
2. WHEN a rule modifies a quantity that was set by the Quantity_Engine, THE Rules_Engine SHALL record both the rule ID and the original predicted quantity in the audit trail
3. THE Rules_Engine SHALL treat quantity predictions identically to AI-estimated quantities when evaluating `line_item_quantity_gte` and `line_item_quantity_lte` conditions

### Requirement 5: Quantity History Data Storage

**User Story:** As a system operator, I want quantity history stored efficiently in the database, so that predictions can be computed quickly without re-parsing historical quotes on every request.

#### Acceptance Criteria

1. THE Quantity_History SHALL store each record with: product name, quantity value, source quote ID, context text, and extraction timestamp
2. THE Quantity_History SHALL support querying all quantity records for a given product name using case-insensitive prefix matching consistent with the existing `matchesProductName` helper
3. IF a quantity value extracted from a historical quote is not a positive finite number, THEN THE Quantity_Engine SHALL discard that record and not store it in Quantity_History
4. THE Quantity_History table SHALL use indexed columns for product name lookups to maintain query performance as the corpus grows

### Requirement 6: Confidence Scoring Algorithm

**User Story:** As a quote generator, I want confidence scores that reflect prediction reliability, so that unreliable predictions do not override reasonable AI estimates.

#### Acceptance Criteria

1. WHEN 10 or more historical data points exist for a product with low variance (coefficient of variation below 0.3), THE Quantity_Engine SHALL assign a Confidence_Score of 90 or above
2. WHEN fewer than 5 historical data points exist for a product, THE Quantity_Engine SHALL assign a Confidence_Score no higher than 60
3. WHEN the coefficient of variation among historical quantities exceeds 0.5, THE Quantity_Engine SHALL reduce the Confidence_Score by at least 30 points from the sample-size-based score
4. THE Quantity_Engine SHALL compute the predicted quantity as the similarity-weighted median of historical values when the Confidence_Score exceeds the application threshold

### Requirement 7: Graceful Degradation

**User Story:** As a system operator, I want the quantity engine to degrade gracefully when historical data is unavailable, so that quote generation continues to work without interruption.

#### Acceptance Criteria

1. IF the Quantity_History table is empty or unreachable, THEN THE Quantity_Engine SHALL return an empty prediction set and allow quote generation to proceed with AI-estimated quantities
2. IF the Quantity_Engine encounters a database error during prediction, THEN THE Quantity_Engine SHALL log the error, return an empty prediction set, and not block quote generation
3. WHEN no similar quotes are found for a customer request, THE Quantity_Engine SHALL skip prediction entirely and return an empty prediction set within 10 milliseconds

### Requirement 8: Quantity Prediction Traceability

**User Story:** As a business owner, I want to see where predicted quantities came from, so that I can verify and trust the system's suggestions.

#### Acceptance Criteria

1. WHEN a quantity prediction is applied to a line item, THE Quote_Generation_Flow SHALL include the prediction metadata (confidence score, source quote numbers, and predicted value) in the quote draft response
2. THE Quote_Generation_Flow SHALL distinguish between quantities set by AI estimation, historical prediction, and rules engine in the line item metadata
3. WHEN a user views a quote draft, THE Client SHALL display the quantity source (AI estimate, historical prediction, or rule override) for each line item that has prediction metadata

### Requirement 9: Parse Historical Quote Line Items

**User Story:** As a developer, I want a reliable parser for extracting line items from historical quote message fields, so that quantity data can be accurately extracted from varied quote formats.

#### Acceptance Criteria

1. WHEN a historical quote message contains line items in the format "ProductName — Quantity x UnitPrice", THE Parser SHALL extract the product name and quantity as separate fields
2. WHEN a historical quote message contains line items in alternative formats (tab-separated, comma-separated), THE Parser SHALL attempt extraction using each known format pattern
3. IF a line in the quote message does not match any known line item format, THEN THE Parser SHALL skip that line without error
4. THE Pretty_Printer SHALL format extracted line item data back into a canonical string representation
5. FOR ALL valid extracted line item sets, parsing then printing then parsing SHALL produce an equivalent set of product-quantity pairs (round-trip property)
