# Implementation Plan: Manual Request Creation

## Overview

This plan implements the manual request creation flow — allowing business users to create customer requests directly in the app without relying on Jobber. The implementation follows a bottom-up approach: shared types → database migration → service layer → API routes → client components → integration wiring.

## Tasks

- [x] 1. Add shared types and database migration
  - [ ] 1.1 Add ManualRequest and CreateManualRequestPayload types to `shared/src/types/quote.ts`
    - Add `ManualRequest` interface with fields: id, userId, customerName, customerPhone, customerEmail, customerAddress, serviceDescription, mediaItemIds, requestSource, createdAt
    - Add `CreateManualRequestPayload` interface with fields: customerName, customerPhone?, customerEmail?, customerAddress?, serviceDescription, mediaItemIds?
    - Add `manualRequestId?: string | null` to the existing `QuoteDraft` interface
    - Export new types from `shared/src/types/index.ts`
    - _Requirements: 2.1, 2.2, 5.3, 6.1_

  - [ ] 1.2 Create D1 migration `worker/src/migrations/0027_manual_requests.sql`
    - Create `manual_requests` table with columns: id, user_id, customer_name, customer_phone, customer_email, customer_address, service_description, media_item_ids_json, created_at
    - Add index on user_id
    - ALTER TABLE quote_drafts ADD COLUMN manual_request_id referencing manual_requests(id)
    - Add index on quote_drafts(manual_request_id)
    - _Requirements: 6.1, 6.2_

- [x] 2. Implement ManualRequestService
  - [x] 2.1 Create `worker/src/services/manual-request-service.ts`
    - Implement `create(userId, payload)` method with validation logic:
      - customerName: required, non-empty after trim, max 200 chars
      - customerEmail: optional, basic email regex validation
      - customerPhone: optional, max 30 chars
      - customerAddress: optional, max 500 chars
      - serviceDescription: required, non-empty after trim, max 10000 chars
      - mediaItemIds: optional array, max 10 items
    - Reject whitespace-only strings for customerName and serviceDescription
    - Implement `getById(id, userId)` method scoped to user
    - Implement `getByDraftId(draftId, userId)` method using JOIN on quote_drafts.manual_request_id
    - Use PlatformError for all validation and not-found errors
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 4.2, 6.1, 6.4_

  - [x] 2.2 Export ManualRequestService from `worker/src/services/index.ts` barrel file
    - _Requirements: 6.1_

  - [ ]* 2.3 Write property test for whitespace rejection (Property 1)
    - **Property 1: Required field whitespace rejection**
    - Generate whitespace-only strings, verify validation rejects them for both customerName and serviceDescription
    - **Validates: Requirements 2.3, 3.2**

  - [ ]* 2.4 Write property test for email format validation (Property 2)
    - **Property 2: Email format validation**
    - Generate random strings, verify email validator correctly classifies valid vs invalid emails
    - **Validates: Requirements 2.4**

  - [ ]* 2.5 Write property test for manual request source invariant (Property 5)
    - **Property 5: Manual request source invariant**
    - Generate random manual request payloads, verify requestSource is always "manual"
    - **Validates: Requirements 5.3**

  - [ ]* 2.6 Write property test for customer details persistence round-trip (Property 6)
    - **Property 6: Customer details persistence round-trip**
    - Generate random customer details, persist and read back (mocked D1), verify round-trip equality
    - **Validates: Requirements 6.1**

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Add API routes for manual requests
  - [x] 4.1 Add `POST /api/quotes/manual-requests` route in `worker/src/routes/quotes.ts`
    - Parse and validate request body using ManualRequestService.create()
    - Return the created ManualRequest with status 201
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 4.2, 6.1, 6.4_

  - [x] 4.2 Add `GET /api/quotes/manual-requests/:id` route in `worker/src/routes/quotes.ts`
    - Fetch manual request by ID scoped to authenticated user
    - Return 404 PlatformError if not found
    - _Requirements: 6.1_

  - [x] 4.3 Add `GET /api/quotes/drafts/:id/manual-request` route in `worker/src/routes/quotes.ts`
    - Fetch the manual request associated with a draft via ManualRequestService.getByDraftId()
    - Return the ManualRequest or null if no association
    - _Requirements: 6.3, 7.1_

  - [x] 4.4 Update the `POST /api/quotes/generate` route to accept and persist `manualRequestId`
    - Accept optional `manualRequestId` in the request body
    - When present, store it on the draft and populate `clientName` from the manual request's customerName
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [ ]* 4.5 Write property test for customer name propagation to draft (Property 4)
    - **Property 4: Customer name propagation to draft**
    - Generate random customer names, create manual requests, verify clientName on resulting draft matches
    - **Validates: Requirements 5.2**

  - [ ]* 4.6 Write property test for manual request ↔ draft association (Property 7)
    - **Property 7: Manual request ↔ draft association**
    - Generate random manual requests, create drafts, verify bidirectional association
    - **Validates: Requirements 6.2**

- [x] 5. Update QuoteDraftService to handle manual_request_id
  - [x] 5.1 Update `QuoteDraftService.save()` to persist `manual_request_id` column
    - Include manual_request_id in the INSERT statement when provided
    - _Requirements: 6.2_

  - [x] 5.2 Update `QuoteDraftService.getById()` to return `manualRequestId` field
    - Read manual_request_id from the query result and map to the QuoteDraft interface
    - _Requirements: 6.2, 7.1_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement client API functions and ManualRequestForm component
  - [x] 7.1 Add client API functions in `client/src/api.ts`
    - Add `createManualRequest(payload)` → POST /api/quotes/manual-requests
    - Add `fetchManualRequest(id)` → GET /api/quotes/manual-requests/:id
    - Add `fetchDraftManualRequest(draftId)` → GET /api/quotes/drafts/:id/manual-request
    - Update `generateQuote` to accept optional `manualRequestId` parameter
    - Import `ManualRequest` and `CreateManualRequestPayload` types from shared
    - _Requirements: 5.1, 6.1, 6.3_

  - [x] 7.2 Create `client/src/pages/ManualRequestForm.tsx` component
    - Render form fields: customerName (required), customerPhone, customerEmail, customerAddress, serviceDescription (required textarea)
    - Include image upload area reusing the same drag-and-drop pattern from QuoteInputPage
    - Client-side validation mirroring server rules (empty name, empty description, email format, max lengths)
    - Display inline validation errors on submit attempt
    - On successful submission: call createManualRequest, then call generateQuote with serviceDescription, mediaItemIds, and manualRequestId, then navigate to the draft page
    - Show loading/generating state during submission
    - _Requirements: 1.2, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 5.1_

  - [ ]* 7.3 Write property test for file type validation (Property 3)
    - **Property 3: File type validation with error identification**
    - Generate random MIME types and filenames, verify rejection of non-allowed types and error message content
    - **Validates: Requirements 4.1, 4.3**

- [x] 8. Update QuoteInputPage to show manual request entry point
  - [x] 8.1 Add "Create Manual Request" button/mode to `client/src/pages/QuoteInputPage.tsx`
    - Add a "Create Manual Request" button alongside the existing Jobber request selector
    - When clicked, show the ManualRequestForm component (hide the existing text area and Jobber selector)
    - When Jobber is unavailable, show ManualRequestForm as the primary input method
    - Add a "Back" button to return to the default view from the manual form
    - _Requirements: 1.1, 1.2, 1.3_

- [x] 9. Update QuoteDraftPage to display customer details
  - [x] 9.1 Update `client/src/pages/QuoteDraftPage.tsx` to show manual request customer details
    - When draft has a manualRequestId, fetch the manual request via fetchDraftManualRequest
    - Display customer details panel (name, phone, email, address) in the side panel area
    - Continue showing Jobber request link for Jobber-sourced drafts (existing behavior)
    - Show only customer request text for legacy drafts with no request association
    - _Requirements: 7.1, 7.2, 7.3_

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The two-step client flow (create manual request → generate quote) keeps the existing QuoteEngine untouched
- All property tests use `fast-check` and should be placed in `tests/property/manual-request-creation.property.test.ts`
