# Requirements Document

## Introduction

The Square Footage Resolution feature introduces a tiered system for determining the square footage of a property or project area. This resolved value feeds into the existing context-aware quantity rules engine, enabling accurate computation of labor hours (drywall, paint) and material quantities (flooring) based on actual project scope. The system resolves square footage through three tiers in priority order: direct text extraction from the customer request, AI vision analysis of attached layout diagrams, and public records lookup via the Cook County Assessor. The business user is shown which source provided the value and the confidence level, ensuring full transparency into the resolution process.

## Glossary

- **Sqft_Resolution_Service**: The service responsible for resolving square footage through the tiered resolution pipeline and producing a resolution result with source metadata
- **Resolution_Tier**: One of three ordered methods for determining square footage — text extraction (highest priority), layout diagram analysis (medium priority), or public records lookup (lowest priority)
- **Resolution_Result**: The output of the resolution process containing the resolved square footage value, the source tier that produced it, a confidence indicator, and any supporting metadata
- **Layout_Diagram**: An image attachment on a customer request that depicts a floor plan, blueprint, or spatial layout from which square footage can be estimated
- **Public_Records_Source**: The Cook County Assessor property records system used to look up recorded square footage for a given property address
- **Resolution_Context**: The set of inputs available for resolution — customer request text, attached images, and property address
- **Rules_Engine**: The existing deterministic rules engine that evaluates conditions and executes actions including `compute_quantity` formulas referencing a `sqft` context variable
- **Quote_Draft_UI**: The client-side interface where business users view and manage generated quote drafts

## Requirements

### Requirement 1: Tiered Resolution Priority Order

**User Story:** As a business owner, I want square footage to be resolved using the most reliable source available, so that quantity calculations are based on the best data for each request.

#### Acceptance Criteria

1. WHEN a customer request contains square footage in the text AND attached layout diagrams AND a property address, THE Sqft_Resolution_Service SHALL use the text-extracted value as the resolved square footage
2. WHEN a customer request does not contain square footage in the text BUT has attached layout diagrams, THE Sqft_Resolution_Service SHALL use the AI-estimated value from the layout diagram as the resolved square footage
3. WHEN a customer request does not contain square footage in the text AND has no layout diagrams BUT has a property address, THE Sqft_Resolution_Service SHALL use the public records value as the resolved square footage
4. IF a customer request has no square footage in text, no layout diagrams, and no property address, THEN THE Sqft_Resolution_Service SHALL produce a resolution result indicating no square footage could be determined
5. THE Sqft_Resolution_Service SHALL attempt resolution tiers in strict order — text extraction first, then layout diagram analysis, then public records lookup — stopping at the first tier that produces a value

### Requirement 2: Text Extraction Resolution (Tier 1)

**User Story:** As a business owner, I want square footage mentioned directly in the customer request to be automatically extracted, so that explicitly stated measurements are used without additional lookups.

#### Acceptance Criteria

1. WHEN the customer request text contains a numeric value followed by a square footage indicator (sqft, sq ft, square feet, sf), THE Sqft_Resolution_Service SHALL extract that value as the resolved square footage
2. THE Sqft_Resolution_Service SHALL support extraction of integer and decimal values with optional comma separators from the request text
3. WHEN multiple square footage values appear in the request text, THE Sqft_Resolution_Service SHALL extract the first match found
4. THE Sqft_Resolution_Service SHALL assign a confidence level of "high" to text-extracted square footage values
5. THE Sqft_Resolution_Service SHALL record the matched text segment as supporting metadata in the resolution result

### Requirement 3: Layout Diagram Analysis Resolution (Tier 2)

**User Story:** As a business owner, I want the system to estimate square footage from attached floor plans or blueprints, so that visual information is utilized when the customer does not state measurements in text.

#### Acceptance Criteria

1. WHEN the customer request has image attachments and no text-extracted square footage, THE Sqft_Resolution_Service SHALL analyze each image to determine if it depicts a floor plan or spatial layout
2. WHEN an image is identified as a layout diagram, THE Sqft_Resolution_Service SHALL use AI vision analysis to estimate the total square footage depicted
3. IF no attached images depict a recognizable floor plan or layout, THEN THE Sqft_Resolution_Service SHALL skip this tier and proceed to the public records tier
4. THE Sqft_Resolution_Service SHALL assign a confidence level of "medium" to layout-diagram-estimated square footage values
5. THE Sqft_Resolution_Service SHALL record the image identifier and the AI-generated reasoning as supporting metadata in the resolution result
6. IF the AI vision analysis fails or times out, THEN THE Sqft_Resolution_Service SHALL skip this tier and proceed to the public records tier without blocking quote generation

### Requirement 4: Public Records Lookup Resolution (Tier 3)

**User Story:** As a business owner, I want the system to look up property square footage from public records when no other source is available, so that I have a baseline estimate for quantity calculations.

#### Acceptance Criteria

1. WHEN no square footage is available from text extraction or layout diagram analysis AND a property address is available, THE Sqft_Resolution_Service SHALL query the Cook County Assessor records for the recorded square footage
2. THE Sqft_Resolution_Service SHALL extract the property address from the Jobber client property record or the manual request customer address field
3. IF the public records lookup does not find a matching property, THEN THE Sqft_Resolution_Service SHALL produce a resolution result indicating no square footage could be determined
4. THE Sqft_Resolution_Service SHALL assign a confidence level of "low" to public-records-sourced square footage values
5. THE Sqft_Resolution_Service SHALL record the property address used and the assessor record identifier as supporting metadata in the resolution result
6. IF the public records lookup fails or times out, THEN THE Sqft_Resolution_Service SHALL produce a resolution result indicating no square footage could be determined without blocking quote generation

### Requirement 5: Integration with Rules Engine

**User Story:** As a business owner, I want the resolved square footage to automatically feed into my quantity calculation rules, so that labor hours and material quantities are computed based on actual project scope.

#### Acceptance Criteria

1. WHEN the Sqft_Resolution_Service produces a resolved square footage value, THE Rules_Engine SHALL receive that value as a pre-populated `sqft` context variable available to all `compute_quantity` formulas
2. WHEN a rule has a `request_text_extract` condition with the `sqft` preset AND the Sqft_Resolution_Service has already resolved a value, THE Rules_Engine SHALL use the pre-resolved value rather than re-extracting from text
3. WHEN no square footage is resolved by the Sqft_Resolution_Service, THE Rules_Engine SHALL fall back to its existing `request_text_extract` behavior for the `sqft` variable
4. THE Sqft_Resolution_Service SHALL execute before the Rules_Engine runs during quote generation, ensuring the resolved value is available for all rule evaluations

### Requirement 6: Resolution Transparency for Business Users

**User Story:** As a business owner, I want to see which source provided the square footage value and how it was determined, so that I can verify the data and understand the basis for quantity calculations.

#### Acceptance Criteria

1. WHEN a quote draft has a resolved square footage value, THE Quote_Draft_UI SHALL display the resolved value, the source tier name, and the confidence level
2. THE Quote_Draft_UI SHALL display the source tier as one of: "Extracted from request text", "Estimated from layout diagram", or "From public records"
3. WHEN the source is text extraction, THE Quote_Draft_UI SHALL show the matched text segment from the customer request
4. WHEN the source is layout diagram analysis, THE Quote_Draft_UI SHALL show a reference to the analyzed image and the AI reasoning summary
5. WHEN the source is public records, THE Quote_Draft_UI SHALL show the property address used for the lookup
6. WHEN no square footage could be resolved, THE Quote_Draft_UI SHALL display a notice indicating that square footage is unavailable and quantity rules requiring it will use default values
7. THE Quote_Draft_UI SHALL allow the business user to manually override the resolved square footage value

### Requirement 7: Manual Override of Resolved Square Footage

**User Story:** As a business owner, I want to manually set or correct the square footage value, so that I can adjust calculations when the automated resolution is inaccurate.

#### Acceptance Criteria

1. WHEN the business user enters a manual square footage value, THE Quote_Draft_UI SHALL update the resolved value and mark the source as "manual override"
2. WHEN a manual override is applied, THE Rules_Engine SHALL use the overridden value for all subsequent `compute_quantity` formula evaluations on that quote draft
3. THE Quote_Draft_UI SHALL preserve the original resolution result alongside the manual override so the user can see what was automatically determined
4. WHEN the business user clears a manual override, THE Sqft_Resolution_Service SHALL revert to the automatically resolved value

### Requirement 8: Resolution Result Persistence

**User Story:** As a system operator, I want resolution results stored with the quote draft, so that the resolution source and value are available for audit and do not require re-computation on page load.

#### Acceptance Criteria

1. WHEN the Sqft_Resolution_Service resolves a square footage value during quote generation, THE system SHALL persist the resolution result (value, source tier, confidence, metadata) alongside the quote draft
2. WHEN a quote draft is loaded, THE Quote_Draft_UI SHALL display the persisted resolution result without re-running the resolution pipeline
3. WHEN a manual override is applied, THE system SHALL persist both the override value and the original resolution result
4. THE system SHALL include the resolution source tier in the rules engine audit trail entries for `compute_quantity` actions that reference the `sqft` variable

### Requirement 9: Address Resolution from Request Sources

**User Story:** As a business owner, I want the system to automatically find the property address from the customer request data, so that public records lookup can proceed without manual address entry.

#### Acceptance Criteria

1. WHEN the customer request originates from Jobber, THE Sqft_Resolution_Service SHALL extract the property address from the Jobber client property record linked to the request
2. WHEN the customer request is a manual request with a customer address, THE Sqft_Resolution_Service SHALL use the manual request customer address for public records lookup
3. WHEN the customer request text contains a recognizable street address, THE Sqft_Resolution_Service SHALL extract that address as a fallback when no structured address is available from Jobber or manual request fields
4. IF no property address can be determined from any source, THEN THE Sqft_Resolution_Service SHALL skip the public records tier
