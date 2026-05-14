# Design: Space-Aware Line Items & Sqft Allocation

## Architecture Overview

The feature adds a space extraction layer that runs before the existing rules engine. It is purely additive — the existing sqft resolution pipeline, rules engine, and enrichment service all continue to work unchanged. The new layer provides richer per-line-item context that the existing machinery consumes.

```
Customer Text
     |
     v
[SpaceExtractionService]  <- NEW: AI extracts { space, sqft }[] from text
     |
     v
[SqftResolutionService]   <- UNCHANGED: resolves whole-property sqft (Tier 1/2/3)
     |
     v
[AI Quote Generation]     <- UPDATED: prompt instructs per-space line item splitting
     |
     v
[SpaceAllocationService]  <- NEW: maps space names to fraction of total sqft
     |
     v
[Rules Engine]            <- UNCHANGED: receives per-item preResolvedContext with space sqft
     |
     v
[EnrichmentService]       <- UPDATED: no-op guard when location already in description
     |
     v
[QuoteDraft]              <- UPDATED: stores spaceContext[], per-item descriptions with location
```

---

## New Types (shared/src/types/quote.ts)

```typescript
/** A space extracted from the customer request text */
export interface SpaceContext {
  /** Space name as written by the customer (e.g., "the basement", "master bedroom") */
  spaceName: string;
  /** Normalized label for display (e.g., "Basement", "Master Bedroom") */
  normalizedLabel: string;
  /** Explicit sqft stated by the customer, or null if not mentioned */
  explicitSqft: number | null;
  /** Estimated sqft from the lookup table, or null if space not recognized */
  estimatedSqft: number | null;
  /** Whether the sqft was explicitly stated (true) or estimated (false) */
  sqftIsExplicit: boolean;
  /** The fraction of total building sqft used for estimation, or null */
  allocationFraction: number | null;
}
```

Add `spaceContext?: SpaceContext[] | null` to `QuoteDraft`.

---

## New Service: SpaceExtractionService

**File:** `worker/src/services/space-extraction-service.ts`

Responsibilities:
- Call GPT-4o-mini with the customer request text
- Return a `SpaceContext[]` array
- Never throw — return empty array on any failure

AI prompt:
```
System: You extract room/space information from home renovation customer requests.
Return a JSON array of spaces mentioned. Each entry: { "spaceName": string, "sqft": number | null }
If no spaces are mentioned, return [].
Return ONLY valid JSON. No markdown.

User: [customer request text]
```

After parsing the AI response, call `SpaceAllocationService.resolveSpaceAllocation(spaceName, totalSqft)` for each entry to populate `estimatedSqft` and `allocationFraction`.

---

## New Service: SpaceAllocationService

**File:** `worker/src/services/space-allocation-service.ts`

Lookup table (ordered — more specific entries first):

```typescript
const SPACE_ALLOCATIONS = [
  { keywords: ['master bedroom', 'primary bedroom', 'master suite'], fraction: 1/8, label: 'Master Bedroom' },
  { keywords: ['bedroom'], fraction: 1/10, label: 'Bedroom' },
  { keywords: ['basement', 'lower level', 'lower floor'], fraction: 1/3, label: 'Basement' },
  { keywords: ['kitchen'], fraction: 1/10, label: 'Kitchen' },
  { keywords: ['living room', 'great room', 'family room', 'front room'], fraction: 1/8, label: 'Living Area' },
  { keywords: ['dining room'], fraction: 1/12, label: 'Dining Room' },
  { keywords: ['bathroom', 'half bath', 'powder room', 'full bath'], fraction: 1/20, label: 'Bathroom' },
  { keywords: ['hallway', 'foyer', 'entryway', 'mudroom', 'entry'], fraction: 1/20, label: 'Hallway/Entry' },
  { keywords: ['laundry', 'utility room', 'mechanical room'], fraction: 1/20, label: 'Utility Room' },
  { keywords: ['garage'], fraction: 1/4, label: 'Garage' },
  { keywords: ['attic'], fraction: 1/3, label: 'Attic' },
];
```

Lookup algorithm:
1. Normalize input: lowercase, strip leading "the "
2. Check each entry's keywords array — match if any keyword is a substring of the space name, or the space name is a substring of a keyword
3. Return first match; return null if no match

Public API:
```typescript
interface SpaceAllocationResult {
  fraction: number;
  normalizedLabel: string;
  estimatedSqft: number; // Math.round(totalSqft * fraction / 10) * 10
}

function resolveSpaceAllocation(
  spaceName: string,
  totalSqft: number,
): SpaceAllocationResult | null
```

---

## QuoteEngine Integration

**File:** `worker/src/services/quote-engine.ts`

### Updated step order in generateQuote:

1. [EXISTING] Call OpenAI for line items (AI generation)
2. [EXISTING] Run QuantityEngine historical prediction
3. [EXISTING] Run SqftResolutionService (Tier 1/2/3) -> wholePropSqft
4. [NEW] Run SpaceExtractionService -> spaceContexts: SpaceContext[]
5. [EXISTING] Load productivity rates into preResolvedContext
6. [NEW] For each line item, resolve its space context and build a per-item sqft override
7. [NEW] Apply space-aware descriptions and disclaimers to line items before rules engine
8. [EXISTING] Run rules engine (with per-item sqft injected via preResolvedContext)
9. [EXISTING] Run EnrichmentService for pending enrichments
10. [NEW] For line items still lacking location context, run fallback enrichment
11. [EXISTING] Deduplicate, sort, build draft

### Per-item sqft resolution logic (step 6):

```
For each AI line item:
  1. Find matching SpaceContext by checking if item.originalText contains any space name
     from spaceContexts (case-insensitive)
  2. If match found:
     a. If spaceContext.explicitSqft -> use that as sqft override
     b. Else if spaceContext.estimatedSqft -> use that as sqft override, set disclaimer flag
     c. Else -> no sqft override, generate action item (REQ-7.1)
  3. If no match -> use wholePropSqft (existing behavior, unchanged)
```

The per-item sqft override is applied by building a modified copy of `preResolvedContext` for each line item before passing it to the rules engine. Since the rules engine processes all items in a single pass, the implementation injects the space-specific sqft into the line item's `originalText` context map before the rules engine runs.

Implementation approach: add a new optional field `sqftOverride?: number` to `EngineLineItem`. The rules engine checks this field first when resolving the `sqft` variable in `compute_quantity` formulas, before falling back to `preResolvedContext`.

### Description building (step 7):

```
For each line item with a resolved space:
  prefix = spaceContext.normalizedLabel

  if sqftIsExplicit:
    locationStr = `${prefix} — ${sqft} sq ft`
  else if estimatedSqft:
    locationStr = `${prefix} — Assumes ${prefix} sq footage is no greater than ${estimatedSqft} sq ft. If greater, a change order at additional cost will be required.`
  else:
    locationStr = prefix  (action item also generated)

  if existing description is non-empty:
    description = `${locationStr} — ${existingDescription}`
  else:
    description = locationStr
```

### Updated AI system prompt additions:

Add to SYSTEM_PROMPT:
```
- SPACE SPLITTING: If the customer mentions the same type of work in multiple distinct rooms
  or areas, create SEPARATE line items for each space — one per space. Include the space name
  in the "originalText" field for each item (e.g., originalText: "drywall in the basement").
  Do NOT combine multi-space work into a single line item with a summed quantity.
```

---

## Rules Engine Changes

**File:** `worker/src/services/rules-engine.ts`

### EngineLineItem sqft override:

Add optional `sqftOverride?: number` to `EngineLineItem` in `shared/src/types/quote.ts`.

In the `request_text_extract` condition evaluator, when `variableName === 'sqft'`:
1. Check `lineItem.sqftOverride` first (if the condition is being evaluated for a specific line item)
2. Then check `preResolvedContext`
3. Then extract from text (existing behavior)

Since the rules engine processes all line items together (not per-item), the sqft override is injected into `preResolvedContext` on a per-rule-execution basis. The quote engine runs the rules engine once per space group when multiple spaces are present, or injects the override into the shared context when only one space is involved.

Alternative (simpler): inject the space-specific sqft directly into each `EngineLineItem`'s `originalText` as a synthetic annotation (e.g., append `[sqft:800]`) that the `request_text_extract` regex can pick up. This avoids any rules engine changes.

**Chosen approach:** Inject space-specific sqft into `preResolvedContext` before the rules engine runs. When multiple spaces are present with different sqft values, run the rules engine once per space group (items grouped by their resolved space), then merge results. This is the cleanest approach and requires no changes to the rules engine itself.

### append_description duplicate guard (REQ-9.2):

In the `append_description` action executor, before appending:
```typescript
if (existing.toLowerCase().includes(action.text.toLowerCase())) {
  return { modified: false, lineItems };
}
```

---

## EnrichmentService Changes

**File:** `worker/src/services/enrichment-service.ts`

No-op guard after extracting context from AI:
```typescript
if (existing.toLowerCase().includes(extracted.toLowerCase())) {
  return; // already present, skip
}
```

---

## Deduplication Changes

**File:** `worker/src/services/line-item-utils.ts`

The existing `deduplicateLineItems` function merges items with the same `productName`. Update to treat items with the same product name but different space prefixes in their descriptions as distinct.

Check: if two items share `productName` but their descriptions start with different space labels (from the lookup table), keep both.

---

## Fallback Enrichment (REQ-6.4)

After the rules engine and existing enrichment run, for any line item whose description does not contain a location reference, run a targeted enrichment call via `EnrichmentService`:

```typescript
const itemsNeedingLocation = engineResult.lineItems.filter(
  li => !hasLocationContext(li.description)
);

if (itemsNeedingLocation.length > 0 && input.customerText?.trim()) {
  const fallbackEnrichments = itemsNeedingLocation.map(li => ({
    lineItemId: li.id,
    productNamePattern: li.productName,
    extractionPrompt: 'Extract the room, area, or location where this work is being done (e.g., "kitchen", "master bedroom", "basement"). If no specific location is mentioned, return N/A.',
    separator: ' — ',
    ruleId: '__space_fallback__',
    ruleName: 'Space Fallback Enrichment',
  }));

  const fallbackDescriptions = await enrichmentService.processEnrichments(
    fallbackEnrichments,
    input.customerText,
    engineResult.lineItems,
  );

  for (const li of engineResult.lineItems) {
    const newDesc = fallbackDescriptions.get(li.id);
    if (newDesc) li.description = newDesc;
  }
}
```

`hasLocationContext(description)` checks if the description contains any keyword from the space allocation lookup table or common location-indicating words.

---

## Data Model Changes

Migration `0047_space_context.sql`:
```sql
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE quote_drafts ADD COLUMN space_context_json TEXT DEFAULT NULL;
```

The `spaceContext` array is stored as JSON in this column and deserialized when the draft is loaded.

---

## Error Handling & Graceful Degradation

| Failure point | Behavior |
|---|---|
| SpaceExtractionService AI call fails | Return [], continue with existing behavior |
| SpaceExtractionService returns invalid JSON | Return [], log warning |
| SpaceAllocationService finds no match | Return null, generate action item |
| Per-item sqft override fails | Fall back to whole-property sqft |
| Fallback enrichment fails | Leave description as-is |
| Deduplication guard fails | Log warning, keep both items |

---

## Files Changed Summary

| File | Change type | Description |
|---|---|---|
| `shared/src/types/quote.ts` | Modified | Add SpaceContext type, spaceContext on QuoteDraft, sqftOverride on EngineLineItem |
| `worker/src/services/space-extraction-service.ts` | New | AI extraction of space/sqft pairs from customer text |
| `worker/src/services/space-allocation-service.ts` | New | Lookup table: space name to fraction of total sqft |
| `worker/src/services/quote-engine.ts` | Modified | Integrate space extraction, per-item sqft, description building, fallback enrichment |
| `worker/src/services/rules-engine.ts` | Modified | append_description duplicate guard |
| `worker/src/services/enrichment-service.ts` | Modified | No-op guard when location already present |
| `worker/src/services/line-item-utils.ts` | Modified | Deduplication: same product + different space = distinct items |
| `worker/src/migrations/0047_space_context.sql` | New | Add space_context_json column to quote_drafts |
| `worker/src/routes/quotes.ts` | Modified | Serialize/deserialize spaceContext on draft read/write |
