# Implementation Plan: Space-Aware Line Items & Sqft Allocation

## Overview

Add a space extraction layer that runs before the existing rules engine. It is purely additive — the existing sqft resolution pipeline, rules engine, and enrichment service all continue to work unchanged. The new layer provides richer per-line-item context that the existing machinery consumes.

## Tasks

- [x] 1. Create branch and verify baseline
  - Checkout main, pull latest, create branch `feature/space-aware-sqft-and-descriptions`
  - Run `npm run build:worker` to confirm clean baseline before any changes
  - _Requirements: REQ-8_

- [x] 2. Add SpaceContext types to shared package
  - Add `SpaceContext` interface to `shared/src/types/quote.ts` with fields: `spaceName: string`, `normalizedLabel: string`, `explicitSqft: number | null`, `estimatedSqft: number | null`, `sqftIsExplicit: boolean`, `allocationFraction: number | null`
  - Add `spaceContext?: SpaceContext[] | null` to `QuoteDraft` interface
  - Export `SpaceContext` from `shared/src/types/index.ts`
  - _Requirements: REQ-1.7_

- [x] 3. Implement SpaceAllocationService
  - Create `worker/src/services/space-allocation-service.ts` (new file)
  - Define `SPACE_ALLOCATIONS` lookup table ordered most-specific first: master bedroom/primary bedroom/master suite (1/8), bedroom (1/10), basement/lower level/lower floor (1/3), kitchen (1/10), living room/great room/family room/front room (1/8), dining room (1/12), bathroom/half bath/powder room/full bath (1/20), hallway/foyer/entryway/mudroom/entry (1/20), laundry/utility room/mechanical room (1/20), garage (1/4), attic (1/3)
  - Implement `resolveSpaceAllocation(spaceName: string, totalSqft: number): SpaceAllocationResult | null` — normalize to lowercase, strip leading "the ", match if keyword is substring of spaceName or spaceName is substring of keyword, return `{ fraction, normalizedLabel, estimatedSqft: Math.round(totalSqft * fraction / 10) * 10 }` or null
  - Export from `worker/src/services/index.ts`
  - _Requirements: REQ-4.1, REQ-4.2, REQ-4.3, REQ-4.4, REQ-4.5_

- [x] 4. Implement SpaceExtractionService
  - Create `worker/src/services/space-extraction-service.ts` (new file)
  - Constructor: `(apiKey: string, apiUrl: string)`
  - Implement `extractSpaces(customerText: string, totalSqft: number | null): Promise<SpaceContext[]>` — call GPT-4o-mini with prompt to return JSON array `[{ spaceName: string, sqft: number | null }]`, parse response, call `resolveSpaceAllocation` for each entry, build and return `SpaceContext[]`; catch all errors, log warning, return `[]`
  - Export from `worker/src/services/index.ts`
  - _Requirements: REQ-1.1, REQ-1.2, REQ-1.3, REQ-1.4, REQ-1.5, REQ-1.6_

- [x] 5. Add space_context_json migration
  - Create `worker/src/migrations/0047_space_context.sql` with: `ALTER TABLE quote_drafts ADD COLUMN space_context_json TEXT DEFAULT NULL;`
  - Include idempotency comment: `-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed`
  - _Requirements: REQ-1.7_

- [x] 6. Update deduplication to preserve space-split items
  - In `worker/src/services/line-item-utils.ts`, add helper `extractSpacePrefix(description: string): string | null` that checks if description starts with a known space label from the lookup table
  - In `deduplicateLineItems`, before merging two items with the same `productName`, check if they have different space prefixes — if so, treat as distinct and do not merge
  - _Requirements: REQ-2.4_

- [x] 7. Add append_description duplicate guard to rules engine
  - In `worker/src/services/rules-engine.ts`, in the `append_description` action executor, after computing `existing`, add guard: `if (existing.toLowerCase().includes(action.text.toLowerCase())) { return { modified: false, lineItems }; }`
  - _Requirements: REQ-9.2_

- [x] 8. Add no-op guard to EnrichmentService
  - In `worker/src/services/enrichment-service.ts`, after `extractContext` returns a value, before building `newDesc`, add guard: `if (existing.toLowerCase().includes(extracted.toLowerCase())) { return; }`
  - _Requirements: REQ-9.3_

- [x] 9. Integrate space extraction into QuoteEngine
  - In `worker/src/services/quote-engine.ts`, after the SqftResolutionService step, instantiate `SpaceExtractionService` and call `extractSpaces(input.customerText, wholePropSqft ?? null)`
  - Store result as `spaceContexts: SpaceContext[]` and pass through to description-building and sqft-override steps
  - _Requirements: REQ-1.6, REQ-3.3, REQ-8.4_

- [x] 10. Update AI system prompt for per-space line item splitting
  - In `worker/src/services/quote-engine.ts`, add to `SYSTEM_PROMPT` RULES section: instruct the model to create SEPARATE line items for each space when the same type of work is mentioned in multiple rooms, include the space name in `originalText`, and do NOT combine multi-space work into a single line item
  - _Requirements: REQ-2.1, REQ-2.2, REQ-2.3_

- [x] 11. Wire per-item sqft overrides into rules engine execution
  - In `worker/src/services/quote-engine.ts`, before calling `executeRules`, group line items by resolved space context (match via `originalText` containing space name)
  - For each space group, build a modified copy of `preResolvedContext` injecting the space-specific `sqft`
  - Run `executeRules` once per space group and merge all results back into a single ordered array
  - Items with no space context use the shared whole-property `preResolvedContext` (existing behavior); if only one space or no spaces, run `executeRules` once as today
  - _Requirements: REQ-3.1, REQ-3.2, REQ-3.3, REQ-3.4, REQ-8.1, REQ-8.2_

- [x] 12. Build description prefix logic with assumption disclaimers
  - In `worker/src/services/quote-engine.ts`, after space extraction and before the rules engine, iterate over AI line items and find matching `SpaceContext` by checking `originalText` for space name substrings (case-insensitive)
  - Build description prefix: explicit sqft uses `"${normalizedLabel} — ${sqft} sq ft"`; estimated sqft uses `"${normalizedLabel} — Assumes ${normalizedLabel} sq footage is no greater than ${estimatedSqft} sq ft. If greater, a change order at additional cost will be required."`; space known but no sqft uses `"${normalizedLabel}"` plus action item per REQ-7.1
  - Prepend prefix to existing description: `"${prefix} — ${existingDesc}"` or just `prefix` if no existing desc
  - Generate action items per REQ-7.2 for estimated sqft cases: `"Confirm [space] sq footage — currently estimated at [X] sq ft. Update if different."`
  - _Requirements: REQ-5.1, REQ-5.2, REQ-5.3, REQ-5.4, REQ-5.5, REQ-6.1, REQ-6.2, REQ-7.1, REQ-7.2, REQ-7.3_

- [x] 13. Add fallback enrichment pass for items missing location context
  - In `worker/src/services/quote-engine.ts`, after the existing enrichment pass, implement `hasLocationContext(description: string): boolean` that returns true if description contains any keyword from the space allocation lookup table or common location words ("room", "area", "floor", "level", "space")
  - Filter line items where `!hasLocationContext(li.description)`, build `PendingEnrichment[]` for those items with extraction prompt asking for room/area/location, call `enrichmentService.processEnrichments` and apply results
  - _Requirements: REQ-6.3, REQ-6.4, REQ-6.5_

- [x] 14. Serialize/deserialize spaceContext in quotes route
  - In `worker/src/routes/quotes.ts`, when writing a draft serialize `spaceContext` via `JSON.stringify` into `space_context_json` column
  - When reading a draft, parse `space_context_json` and attach as `spaceContext` on the draft object; handle null/missing column gracefully for existing drafts
  - _Requirements: REQ-1.7, REQ-8.2_

- [x] 15. Build and verify no TypeScript errors
  - Run `npm run build:worker` from the worker directory and fix any TypeScript errors
  - Run `npm test` to verify no existing tests are broken
  - _Requirements: REQ-8.1, REQ-8.2, REQ-8.3, REQ-8.4_

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1"] },
    { "wave": 2, "tasks": ["2"] },
    { "wave": 3, "tasks": ["3", "5"] },
    { "wave": 4, "tasks": ["4", "6", "7", "8"] },
    { "wave": 5, "tasks": ["9"] },
    { "wave": 6, "tasks": ["10"] },
    { "wave": 7, "tasks": ["11"] },
    { "wave": 8, "tasks": ["12"] },
    { "wave": 9, "tasks": ["13"] },
    { "wave": 10, "tasks": ["14"] },
    { "wave": 11, "tasks": ["15"] }
  ]
}
```

## Notes

- Tasks 1-5 are foundational and must complete before integration tasks
- Tasks 6, 7, 8 are independent guard/fix tasks that can run in parallel with task 4 once task 2 is done
- Tasks 9-14 are sequential integration steps in QuoteEngine and routes
- Task 15 is the final build verification gate
- The space extraction layer is purely additive — existing sqft resolution, rules engine, and enrichment service continue to work unchanged
- SpaceExtractionService never throws — all errors result in empty array and graceful fallback to existing behavior
- The deduplication guard in task 6 requires importing the space labels from SpaceAllocationService (task 3 must complete first)
