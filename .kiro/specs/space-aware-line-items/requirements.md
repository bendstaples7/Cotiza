# Requirements: Space-Aware Line Items & Sqft Allocation

## Overview

Quote line items currently lack location context (which room or area the work covers) and use a single whole-property sqft value for all quantity calculations. This causes two problems:

1. **Missing location context** — Line item descriptions don't say where the work is going (e.g., "Drywall: Installation of New Drywall" with no mention of "basement" or "master bedroom").
2. **Wrong sqft for quantity** — When a customer mentions a specific space but not its sqft, the system falls through to public records (whole building sqft), inflating labor and materials quantities.

This spec defines a space-aware extraction layer that sits on top of the existing sqft pipeline and applies to all line items across all trades.

---

## Requirements

### REQ-1: Space Extraction from Customer Request Text

**1.1** The system MUST extract a structured list of `{ space, sqft }` pairs from the customer request text before quote generation runs.

**1.2** Extraction MUST be performed by an AI call (GPT-4o-mini) that reads the customer text and returns a JSON array of spaces mentioned, each with an optional sqft value.

**1.3** The extraction MUST identify space names as the customer wrote them (e.g., "the basement", "master bedroom", "kitchen area").

**1.4** If the customer mentions sqft for a specific space (e.g., "the basement is 800 sqft"), that value MUST be captured as the `sqft` for that space entry.

**1.5** If no spaces are mentioned in the customer text, the extraction MUST return an empty array (not an error).

**1.6** Space extraction MUST be gracefully degraded — any failure MUST NOT block quote generation. On failure, the system falls back to existing behavior.

**1.7** The extracted space context MUST be stored on the `QuoteDraft` as `spaceContext: SpaceContext[]`.

---

### REQ-2: Per-Space Line Item Splitting

**2.1** When the customer mentions multiple distinct spaces for the same type of work (e.g., "drywall in the basement and the master bedroom"), the AI MUST generate separate line items — one per space — rather than a single combined line item.

**2.2** The AI system prompt MUST be updated to instruct the model to split line items by space when multiple spaces are mentioned for the same product.

**2.3** Each split line item MUST reference its space in the `originalText` field so downstream rules can associate it with the correct space context.

**2.4** The existing deduplication logic MUST NOT collapse space-split line items into one. Items for the same product but different spaces are not duplicates.

---

### REQ-3: Space-Specific Sqft Resolution

**3.1** When a space has an explicit sqft value from the customer text (REQ-1.4), that value MUST be used as the `sqft` variable for `compute_quantity` rules targeting that line item.

**3.2** When a space has no explicit sqft value, the system MUST attempt to estimate it using the space allocation lookup table (REQ-4).

**3.3** When a space-specific sqft is available (either explicit or estimated), it MUST override the whole-property sqft for that line item's `compute_quantity` calculation only. The whole-property sqft resolution pipeline (Tier 1/2/3) MUST continue to run unchanged and its result MUST remain available for line items with no space context.

**3.4** The `preResolvedContext` map passed to the rules engine MUST be built per-line-item when space context is available, injecting the space-specific `sqft` for that item.

---

### REQ-4: Space Allocation Lookup Table

**4.1** The system MUST maintain a hardcoded lookup table mapping common space names to a fraction of total building sqft.

**4.2** The lookup MUST be case-insensitive and support partial/keyword matching (e.g., "master bedroom" and "primary bedroom" both match the bedroom entry).

**4.3** The lookup table MUST include at minimum:

| Space keywords | Fraction | Label used in disclaimer |
|---|---|---|
| basement, lower level, lower floor | 1/3 | "basement" |
| kitchen | 1/10 | "kitchen" |
| master bedroom, primary bedroom | 1/8 | "master bedroom" |
| bedroom | 1/10 | "bedroom" |
| living room, great room, family room | 1/8 | "living area" |
| dining room | 1/12 | "dining room" |
| bathroom, bath, half bath, powder room | 1/20 | "bathroom" |
| hallway, foyer, entryway, mudroom | 1/20 | "hallway/entry" |
| laundry room, utility room, mechanical room | 1/20 | "utility room" |
| garage | 1/4 | "garage" |
| attic | 1/3 | "attic" |

**4.4** When a space name does not match any entry in the lookup table, the system MUST NOT apply an estimated sqft. Instead it MUST generate an action item asking for the actual sqft of that space.

**4.5** The lookup table MUST be defined in a dedicated service file (`space-allocation-service.ts`) so fractions can be updated without touching the quote engine.

---

### REQ-5: Assumption-Based Description Generation

**5.1** When a space-specific sqft is estimated via the lookup table (not explicitly stated by the customer), the line item description MUST include an assumption disclaimer.

**5.2** The disclaimer format MUST be:
> "Assumes [space] sq footage is no greater than [estimated sqft] sq ft. If greater, a change order at additional cost will be required."

**5.3** The estimated sqft value in the disclaimer MUST be the computed value (total building sqft × fraction), rounded to the nearest 10 sq ft.

**5.4** When the customer explicitly stated the sqft for a space, no disclaimer is needed — the description MUST reference the space name and sqft (e.g., "Basement — 800 sq ft").

**5.5** When no sqft is available at all (no explicit, no estimate, no whole-property fallback), the description MUST reference the space name only, and an action item MUST be generated.

---

### REQ-6: Location Context in All Line Item Descriptions

**6.1** Every resolved line item on a quote MUST have its location/space referenced in the description field.

**6.2** When space context is available from REQ-1, the space name MUST be prepended to the description (format: "[Space] — [existing description or catalog description]").

**6.3** When no space context is available from extraction, the system MUST fall back to the existing `extract_request_context` enrichment pipeline (via `EnrichmentService`) to attempt AI-based location extraction.

**6.4** The enrichment fallback (REQ-6.3) MUST be applied to ALL line items, not just sqft-driven ones. This fixes the existing gap where `extract_request_context` rules exist in the rules engine but are never seeded in the database for most products.

**6.5** If neither space extraction nor enrichment produces a location, the description MUST remain as-is (no empty or placeholder text injected).

---

### REQ-7: Action Items for Missing or Estimated Sqft

**7.1** When a space is identified but has no explicit sqft AND no lookup table match (REQ-4.4), the system MUST generate an action item: "Square footage of [space] needed for accurate pricing."

**7.2** When a space is identified and an estimated sqft is used (REQ-4), the system MUST generate an action item: "Confirm [space] sq footage — currently estimated at [X] sq ft. Update if different."

**7.3** Action items from REQ-7.1 and REQ-7.2 MUST be associated with the specific line item they affect.

**7.4** Existing action item generation (from the AI and from rules) MUST continue to work unchanged.

---

### REQ-8: Backward Compatibility

**8.1** All existing `compute_quantity` rules MUST continue to work without modification. The space-aware sqft injection is additive — it provides a more accurate `sqft` value to the same rules.

**8.2** When no space context is extracted (empty customer text, extraction failure, or no spaces mentioned), the system MUST behave identically to today.

**8.3** Existing `extract_request_context` rules in the database MUST continue to fire. The new code-level enrichment runs first; if a description is already populated with location context, the rule's enrichment MUST be a no-op (append nothing if the location is already present).

**8.4** The existing `SqftResolutionService` tiered pipeline (Tier 1/2/3) MUST run unchanged. Space-specific sqft values supplement it; they do not replace it.

---

### REQ-9: No Duplicate or Looping Rule Behavior

**9.1** The rules engine's existing duplicate-application guard (the `applied` set keyed by `ruleId:lineItemId`) MUST prevent any rule from firing twice on the same line item in the same execution run.

**9.2** The `append_description` action MUST check whether the text to append is already present in the description before appending, to prevent duplicate location strings if both code-level enrichment and a rule-level enrichment fire.

**9.3** The `extract_request_context` action MUST be treated as a no-op if the line item description already contains the extracted text (case-insensitive substring check in `EnrichmentService`).
