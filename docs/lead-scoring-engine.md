# Lead Scoring Engine

## Overview

The lead scoring engine produces a numeric priority score (0–100) for each lead,
ranking them by expected value to the business. The score determines which leads
should be pursued first, which need nurturing, and which can be archived.

## Scoring Dimensions

Four dimensions are scored independently, then combined via a weighted sum:

| Dimension               | Default Weight | What It Measures                                      |
|-------------------------|----------------|-------------------------------------------------------|
| Budget Alignment        | 25%            | Customer's declared budget vs estimated project cost  |
| Geographic Fit          | 20%            | Distance to service area / primary coverage zone      |
| Archetype Match         | 30%            | Comparison to the ideal lead profile                  |
| Project Scope           | 25%            | Core offering match, scope size, request clarity      |

Weights can be overridden per-call (must sum to 1.0).

## Score Ranges / Tiers

| Tier       | Score Range | Action                              |
|------------|-------------|-------------------------------------|
| hot        | 85–100      | Pursue immediately                   |
| warm       | 70–84       | Engage within 24h                    |
| lukewarm   | 50–69       | Nurture / monitor                    |
| cold       | 30–49       | Low priority                         |
| archive    | 0–29        | Not actionable                       |

## Budget Alignment (25%)

Compares `declaredBudget / estimatedCost`. Ratio determines the score:

| Ratio Range                | Score | Interpretation                  |
|----------------------------|-------|---------------------------------|
| ratio >= tolerance (1.2)   | 100   | Budget easily covers cost       |
| 1.0 <= ratio < tolerance   | 80–99 | Covers with room                |
| 0.75 <= ratio < 1.0        | 50–79 | Close, needs attention          |
| 0.5 <= ratio < 0.75        | 10–49 | Significant gap                 |
| ratio < 0.5                | 10    | Critically underfunded          |
| Missing data (either side) | 50    | Neutral — avoids penalising     |

The `tolerance` parameter is configurable (default: 1.2 = 20% headroom).

## Geographic Fit (20%)

| Condition                              | Score | Interpretation                  |
|----------------------------------------|-------|---------------------------------|
| `inServiceArea: true`                  | 100   | Primary service area            |
| `inServiceArea: false`                 | 0     | Outside area                    |
| distance <= serviceRadius (default 50) | 80    | Within radius                   |
| distance <= 2x serviceRadius           | 40    | Manageable but not ideal        |
| distance > 2x serviceRadius            | 10    | Significantly far               |
| No data                                | 50    | Neutral                         |

## Archetype Match (30%)

Five sub-dimensions compared against an ideal profile:

| Sub-dimension   | Default Weight | Match (100) | No Match (0) | Neutral (50) |
|-----------------|----------------|-------------|--------------|--------------|
| Property type   | 35%            | Preferred   | Non-preferred| Not provided |
| Job type        | 25%            | Preferred   | Non-preferred| Not provided |
| Customer segment| 15%            | Preferred   | Non-preferred| Not provided |
| Property value  | 10%            | In range    | Out of range | Unknown      |
| Project size    | 15%            | In range    | Out of range | Unknown      |

Default ideal profile: residential property, interior/exterior jobs, homeowners.
The ideal profile can be customised per-call or per-business.

## Project Scope (25%)

Three sub-scores averaged equally:

| Factor            | Good (100)      | Bad (0)          | Neutral (50)     |
|-------------------|-----------------|------------------|------------------|
| Core offering     | In core offering| Outside offering | Not determined   |
| Scope area count  | 2–6 areas       | <2 or >6         | Not provided     |
| Request clarity   | Clear           | Vague            | Unknown          |

Ideal scope range is configurable (default: 2–6 areas).

## Overrides & Modifiers

### Forced Overrides (bypass computed score entirely)

| Override              | Score  | Tier     | When to use                              |
|-----------------------|--------|----------|------------------------------------------|
| `is_referral`         | 95     | hot      | Lead came from a trusted referral        |
| `is_existing_client`  | 80     | warm     | Returning past customer                  |
| `regulatory_block`    | 0      | archive  | Cannot serve due to regulations          |

### Modifiers (applied after scoring, only if not overridden)

| Modifier           | Delta | Rationale                                                |
|--------------------|-------|----------------------------------------------------------|
| `isRemoteFirst`    | +15   | Remote-first teams tend to be more responsive            |

## API Endpoint

POST `/api/quotes/leads/score`

**Request body** (`LeadScoringInput`):

```json
{
  "budget": {
    "declaredBudget": 15000,
    "estimatedCost": 10000,
    "tolerance": 1.2
  },
  "geographic": {
    "inServiceArea": true,
    "distanceMiles": 5,
    "serviceRadius": 50
  },
  "archetype": {
    "propertyType": "residential",
    "jobType": "interior",
    "customerSegment": "homeowner",
    "propertyValueMatch": true,
    "projectSizeMatch": true,
    "idealProfile": { ... }
  },
  "scope": {
    "inCoreOffering": true,
    "scopeAreaCount": 3,
    "requestClarity": "clear",
    "idealScopeAreaMin": 2,
    "idealScopeAreaMax": 6
  },
  "weights": {
    "budgetAlignment": 0.25,
    "geographicFit": 0.20,
    "archetypeMatch": 0.30,
    "projectScope": 0.25
  },
  "overrides": ["is_referral"],
  "isRemoteFirst": true
}
```

**Response** (`LeadScoringResult`):

```json
{
  "totalScore": 100,
  "tier": "hot",
  "dimensions": [
    {
      "dimension": "budgetAlignment",
      "score": 100,
      "rationale": "Budget ($15K) is 50% above estimated cost ($10K). Well within tolerance."
    },
    { "dimension": "geographicFit", "score": 100, "rationale": "Lead is within the primary service area." },
    { "dimension": "archetypeMatch", "score": 100, "rationale": "Lead archetype match: 100/100.\n  propertyType: 100/100 — ..." },
    { "dimension": "projectScope", "score": 100, "rationale": "Project scope: 100/100..." }
  ],
  "appliedOverrides": [],
  "appliedModifiers": [{ "name": "remote_first", "delta": 15, "rationale": "..." }],
  "overridden": false
}
```

## Client Usage

```typescript
import { scoreLead } from '../api';
import type { LeadScoringInput } from 'shared';

const input: LeadScoringInput = {
  budget: { declaredBudget: 15000, estimatedCost: 10000 },
  geographic: { inServiceArea: true, distanceMiles: 5 },
  archetype: { propertyType: 'residential', jobType: 'interior', customerSegment: 'homeowner', propertyValueMatch: true, projectSizeMatch: true },
  scope: { inCoreOffering: true, scopeAreaCount: 3, requestClarity: 'clear' },
};

const result = await scoreLead(input);
console.log(result.totalScore, result.tier); // 100, 'hot'
```

## Code Location

| Component           | File                                                                 |
|---------------------|----------------------------------------------------------------------|
| Types               | `shared/src/types/lead-scoring.ts`                                   |
| Service (pure fn)   | `worker/src/services/lead-scoring-service.ts`                        |
| Service export      | `worker/src/services/index.ts`                                       |
| API endpoint        | `worker/src/routes/quotes.ts` (POST /leads/score)                    |
| Client API call     | `client/src/api.ts`                                                  |
| Unit tests          | `tests/unit/lead-scoring-service.test.ts` (50 tests, all passing)    |

## Tests

50 unit tests covering:

- Full pipeline: hot, warm, lukewarm, cold lead examples
- Each dimension: budget alignment (6 cases), geographic fit (6),
  archetype match (3), project scope (5)
- Forced overrides: referral, existing client, regulatory block (5 cases)
- Modifiers: remote-first
- Configurable weights
- Edge cases: all nulls, clamping, custom tolerance, custom radius,
  custom ideal profile, custom scope bounds
- Tier boundary verification (5 thresholds)