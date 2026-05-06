# Implementation Plan: Square Footage Resolution

## Overview

This plan implements the tiered square footage resolution system bottom-up: shared types first, then the database migration, then the resolution services (Cook County client, address resolver, main resolution service), then rules engine integration, then API/persistence layer, and finally the UI display and manual override components. Each step builds on the previous and ends with full integration into the quote generation pipeline.

## Tasks

- [x] 1. Extend shared type definitions for sqft resolution
  - [x] 1.1 Add resolution types to shared/src/types/quote.ts
    - Add `ResolutionTier` type: `'text_extraction' | 'layout_diagram' | 'public_records' | 'manual_override'`
    - Add `ResolutionConfidence` type: `'high' | 'medium' | 'low'`
    - Add `ResolutionMetadata` interface with optional fields: `matchedText`, `imageId`, `aiReasoning`, `propertyAddress`, `assessorRecordId`
    - Add `ResolutionResult` interface with fields: `resolved`, `value`, `tier`, `confidence`, `metadata`
    - Add `SqftResolutionResult` interface with fields: `resolution`, `manualOverride`, `originalResolution`
    - Add optional `sqftResolution?: SqftResolutionResult | null` field to `QuoteDraft` interface
    - Add optional `sqftOverride?: number | null` field to `QuoteDraftUpdate` interface
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.4, 2.5, 3.4, 3.5, 4.4, 4.5, 7.1, 8.1_

  - [x] 1.2 Add preResolvedContext to RulesEngineInput interface in worker/src/services/rules-engine.ts
    - Add optional `preResolvedContext?: Map<string, number>` field to the `RulesEngineInput` interface
    - _Requirements: 5.1, 5.2_

- [x] 2. Database migration for sqft resolution storage
  - [x] 2.1 Create migration worker/src/migrations/0029_sqft_resolution.sql
    - Add `sqft_resolution_json TEXT DEFAULT NULL` column to `quote_drafts` table
    - _Requirements: 8.1, 8.2, 8.3_

- [x] 3. Implement Cook County Assessor client
  - [x] 3.1 Create worker/src/services/cook-county-assessor.ts
    - Implement `AssessorPropertyRecord` interface with fields: `pin`, `address`, `buildingSqft`, `propertyClass`, `township`
    - Implement `CookCountyAssessorClient` class with static config: `BASE_URL`, `DATASET_ID`, `TIMEOUT_MS` (8000ms)
    - Implement `lookupByAddress(address: string): Promise<AssessorPropertyRecord | null>` — two-step lookup: resolve address to PIN via parcel addresses dataset, then query characteristics dataset by PIN for building sqft
    - Implement private `parseAddress(address: string)` method to extract house number and street name for SODA query filtering
    - Handle errors gracefully: return null on timeout, API error, no match, or parse failure
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [ ]* 3.2 Write unit tests for Cook County Assessor client
    - Test file: tests/unit/cook-county-assessor.test.ts
    - Test mocked HTTP responses: property found, property not found, API error, timeout
    - Test address parsing: standard addresses, apartment numbers, suite numbers, PO boxes (rejected)
    - Test PIN resolution and characteristics lookup flow
    - _Requirements: 4.1, 4.3, 4.5, 4.6_

- [x] 4. Implement address resolution helper
  - [x] 4.1 Create resolvePropertyAddress function in worker/src/services/sqft-resolution-service.ts
    - Implement `AddressResolutionInput` interface with optional fields: `jobberPropertyAddress`, `manualRequestAddress`, `customerText`
    - Implement `resolvePropertyAddress(input: AddressResolutionInput): string | null`
    - Priority order: Jobber property address > manual request address > street address extracted from text
    - For text extraction fallback, use a basic street address regex pattern
    - Return null if no address can be determined from any source
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [ ]* 4.2 Write unit tests for address resolution
    - Test file: tests/unit/address-resolution.test.ts
    - Test priority ordering: Jobber address wins when all sources present
    - Test fallback: manual address used when Jobber is null
    - Test text extraction: street address extracted from customer text
    - Test null result when no source provides an address
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [ ]* 4.3 Write property test for address resolution priority
    - **Property 6: Address Resolution Priority**
    - Generate combinations of Jobber/manual/text addresses (some null, some present), verify priority ordering and null-only-when-all-null
    - Test file: tests/property/sqft-resolution.property.test.ts
    - **Validates: Requirements 4.2, 9.1, 9.2, 9.3, 9.4**

- [x] 5. Checkpoint — Ensure address resolution and assessor client tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement SqftResolutionService
  - [x] 6.1 Create worker/src/services/sqft-resolution-service.ts main class
    - Implement `ResolutionContext` interface with fields: `customerText`, `mediaItemIds`, `jobberPropertyAddress`, `manualRequestAddress`
    - Implement `SqftResolutionService` class with constructor accepting `apiKey`, `apiUrl`, `r2Bucket` (R2Bucket)
    - Implement `async resolve(context: ResolutionContext): Promise<ResolutionResult>` — orchestrates the tiered pipeline, never throws
    - Implement `extractFromText(text: string): ResolutionResult | null` — uses the existing sqft regex pattern from extraction-presets.ts, returns result with confidence "high" and matched text in metadata
    - Implement private `async analyzeLayoutDiagrams(mediaItemIds: string[]): Promise<ResolutionResult | null>` — fetches images from R2, sends to OpenAI gpt-4o vision API with a prompt asking to identify floor plans and estimate sqft, returns result with confidence "medium"
    - Implement private `async lookupPublicRecords(address: string): Promise<ResolutionResult | null>` — uses CookCountyAssessorClient, returns result with confidence "low"
    - Each tier catches its own errors and returns null on failure (graceful fallthrough)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.4, 4.5, 4.6_

  - [ ]* 6.2 Write unit tests for SqftResolutionService
    - Test file: tests/unit/sqft-resolution-service.test.ts
    - Test text extraction with each format: "1500 sqft", "1,500 sq ft", "1500 square feet", "1500sf"
    - Test first-match behavior when multiple sqft values in text
    - Test tier fallthrough: text fails → vision attempted, vision fails → records attempted
    - Test graceful degradation: each tier failing independently
    - Test AI vision: mocked OpenAI responses for floor plan detected/not detected/error/timeout
    - Test no-images skip for Tier 2
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 3.1, 3.6_

  - [ ]* 6.3 Write property test for tier priority ordering
    - **Property 1: Tier Priority Ordering**
    - Generate resolution contexts with various tier availability combinations (mocked tier functions), verify highest-priority tier always wins and lower tiers are not called
    - Test file: tests/property/sqft-resolution.property.test.ts
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5**

  - [ ]* 6.4 Write property test for text extraction correctness
    - **Property 2: Text Extraction Correctness**
    - Generate texts with embedded sqft values in various formats (integers, decimals, commas, different suffixes), verify correct numeric extraction and metadata
    - Test file: tests/property/sqft-resolution.property.test.ts
    - **Validates: Requirements 2.1, 2.2, 2.4, 2.5**

  - [ ]* 6.5 Write property test for first match extraction
    - **Property 3: First Match Extraction**
    - Generate texts with multiple sqft values at random positions, verify first match is always chosen
    - Test file: tests/property/sqft-resolution.property.test.ts
    - **Validates: Requirements 2.3**

- [x] 7. Integrate pre-resolved context into rules engine
  - [x] 7.1 Modify rules engine to accept and use preResolvedContext
    - In `executeRules()`, read `preResolvedContext` from input
    - Before evaluating each rule's condition, merge `preResolvedContext` entries into the condition evaluation context
    - When a `request_text_extract` condition targets a variable that already exists in `preResolvedContext`, skip the extraction and use the pre-resolved value instead
    - Pass pre-resolved variables through to `compute_quantity` action evaluation alongside rule-scoped context variables
    - _Requirements: 5.1, 5.2, 5.3_

  - [ ]* 7.2 Write property test for pre-resolved context variable availability
    - **Property 4: Pre-Resolved Context Variable Availability**
    - Generate sqft values and `compute_quantity` formulas referencing `sqft`, verify the pre-resolved value is used and existing extraction is skipped
    - Test file: tests/property/sqft-resolution.property.test.ts
    - **Validates: Requirements 5.1, 5.2, 7.2**

  - [ ]* 7.3 Write property test for audit trail source inclusion
    - **Property 7: Resolution Source in Audit Trail**
    - Generate scenarios with pre-resolved sqft used in formulas, verify audit trail metadata includes resolution tier
    - Test file: tests/property/sqft-resolution.property.test.ts
    - **Validates: Requirements 8.4**

- [x] 8. Checkpoint — Ensure rules engine integration tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Integrate resolution into QuoteEngine pipeline and persistence
  - [x] 9.1 Add SqftResolutionService call to QuoteEngine.generateQuote()
    - Instantiate `SqftResolutionService` with `apiKey`, `apiUrl`, and R2 bucket binding
    - Call `resolve()` after QuantityEngine predictions but before `executeRules()`
    - If resolution produces a value, pass it as `preResolvedContext: new Map([['sqft', value]])` to `executeRules()`
    - Attach the `SqftResolutionResult` to the draft output for persistence
    - Update `QuoteEngine` constructor or `generateQuote` signature to accept R2 bucket binding
    - _Requirements: 5.4, 8.1_

  - [x] 9.2 Update QuoteDraftService to persist and load sqft_resolution_json
    - In the `save()` method, serialize `sqftResolution` to JSON and store in `sqft_resolution_json` column
    - In the `getById()` / load methods, deserialize `sqft_resolution_json` and attach to the returned `QuoteDraft`
    - _Requirements: 8.1, 8.2_

  - [x] 9.3 Add manual override handling to PATCH /api/quote-drafts/:id route
    - When `sqftOverride` is present in the update payload, update `sqft_resolution_json`:
      - Set `manualOverride` to the provided value
      - Preserve original resolution in `originalResolution`
      - Update active `resolution` to reflect manual override tier with "high" confidence
    - When `sqftOverride` is null, clear the override and restore original resolution
    - Validate override value: must be a positive number ≤ 100,000
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 9.4 Pass address context to SqftResolutionService from quote generation route
    - In the quote generation route handler, resolve the property address from Jobber request detail or manual request
    - Pass `jobberPropertyAddress` and `manualRequestAddress` to the resolution context
    - _Requirements: 9.1, 9.2_

  - [ ]* 9.5 Write property test for manual override round-trip
    - **Property 5: Manual Override Round-Trip**
    - Generate resolution results and override values, verify apply then clear restores original
    - Test file: tests/property/sqft-resolution.property.test.ts
    - **Validates: Requirements 7.1, 7.3, 7.4**

- [x] 10. Checkpoint — Ensure pipeline integration and API tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implement UI display of resolution result
  - [x] 11.1 Add sqft resolution display section to QuoteDraftPage
    - Display resolved value, source tier label, and confidence badge when `draft.sqftResolution` is present
    - Map tier values to user-friendly labels: "Extracted from request text", "Estimated from layout diagram", "From public records", "Manual override"
    - Show confidence as a colored badge (high=green, medium=amber, low=gray)
    - When source is text extraction, show the matched text segment
    - When source is layout diagram, show reference to analyzed image and AI reasoning summary
    - When source is public records, show the property address used
    - When no sqft resolved, display notice: "Square footage unavailable — quantity rules requiring it will use default values"
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [x] 11.2 Add manual override input to QuoteDraftPage
    - Add an editable input field allowing the user to enter a manual sqft value
    - On save, call `updateDraft(id, { sqftOverride: value })` via the existing PATCH endpoint
    - Show the original resolution alongside the override so the user can compare
    - Add a "Clear override" button that sends `sqftOverride: null` to restore the original
    - Validate input client-side: positive number, ≤ 100,000
    - _Requirements: 6.7, 7.1, 7.3, 7.4_

- [x] 12. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The resolution service never throws — all errors result in graceful fallthrough or "not_resolved"
- The existing sqft regex pattern from extraction-presets.ts is reused for Tier 1 consistency
- Pre-resolved context variables take precedence over runtime extraction to avoid redundant work
- The Cook County Assessor lookup uses the public Socrata SODA API (no API key required)
- AI vision analysis reuses the existing OpenAI API configuration with gpt-4o model
