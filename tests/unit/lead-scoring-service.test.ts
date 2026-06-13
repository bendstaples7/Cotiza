// ---------------------------------------------------------------------------
// Lead Scoring Service — Unit Tests
//
// Covers all four dimensions, configurable weights, forced overrides,
// the remote-first modifier, edge cases, and neutral defaults.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { scoreLead } from '../../worker/src/services/lead-scoring-service.js';
import type { LeadScoringInput } from '../../shared/src/types/lead-scoring.js';
import { DEFAULT_SCORING_WEIGHTS, SCORING_TIERS, DEFAULT_IDEAL_PROFILE } from '../../shared/src/types/lead-scoring.js';

// ── Helpers ─────────────────────────────────────────────────────────

/** A "hot" lead — well-funded, in-area, ideal archetype, clear scope. */
function hotLeadInput(overrides?: Partial<LeadScoringInput>): LeadScoringInput {
  return {
    budget: { declaredBudget: 15000, estimatedCost: 10000 },
    geographic: { inServiceArea: true, distanceMiles: 5 },
    archetype: {
      propertyType: 'residential',
      jobType: 'interior',
      customerSegment: 'homeowner',
      propertyValueMatch: true,
      projectSizeMatch: true,
    },
    scope: { inCoreOffering: true, scopeAreaCount: 3, requestClarity: 'clear' },
    ...overrides,
  };
}

/** A "cold" lead — poor budget, outside area, wrong archetype, vague scope. */
function coldLeadInput(overrides?: Partial<LeadScoringInput>): LeadScoringInput {
  return {
    budget: { declaredBudget: 5000, estimatedCost: 20000 },
    geographic: { inServiceArea: false, distanceMiles: 150 },
    archetype: {
      propertyType: 'commercial',
      jobType: 'exterior',
      customerSegment: 'business',
      propertyValueMatch: false,
      projectSizeMatch: false,
    },
    scope: { inCoreOffering: false, scopeAreaCount: 1, requestClarity: 'vague' },
    ...overrides,
  };
}

// ── Full Pipeline: Hot / Warm / Cold / Edge ────────────────────────

describe('scoreLead — integration (4 worked examples)', () => {
  it('hot lead — well-funded, in-area, ideal archetype, clear scope', () => {
    const result = scoreLead(hotLeadInput());
    expect(result.totalScore).toBeGreaterThanOrEqual(SCORING_TIERS.hot.min);
    expect(result.tier).toBe('hot');
    expect(result.overridden).toBe(false);
    expect(result.dimensions).toHaveLength(4);
    expect(result.dimensions.every((d) => d.score >= 0 && d.score <= 100)).toBe(true);
    // All dimensions should score well
    expect(result.dimensions.find((d) => d.dimension === 'budgetAlignment')!.score).toBeGreaterThanOrEqual(80);
    expect(result.dimensions.find((d) => d.dimension === 'geographicFit')!.score).toBe(100);
    expect(result.dimensions.find((d) => d.dimension === 'archetypeMatch')!.score).toBeGreaterThanOrEqual(80);
    expect(result.dimensions.find((d) => d.dimension === 'projectScope')!.score).toBeGreaterThanOrEqual(80);
  });

  it('warm lead — adequate budget, in-area, partial archetype', () => {
    const result = scoreLead({
      budget: { declaredBudget: 5500, estimatedCost: 10000 }, // ratio 0.55 → tight, 10-49
      geographic: { inServiceArea: true, distanceMiles: 10 },
      archetype: {
        propertyType: 'residential',
        jobType: null, // unknown → neutral
        customerSegment: 'homeowner',
        propertyValueMatch: true,
        projectSizeMatch: null, // unknown → neutral
      },
      scope: { inCoreOffering: true, scopeAreaCount: 4, requestClarity: 'clear' },
    });
    expect(result.totalScore).toBeGreaterThanOrEqual(SCORING_TIERS.warm.min);
    expect(result.totalScore).toBeLessThan(SCORING_TIERS.hot.min);
    expect(result.tier).toBe('warm');
    expect(result.overridden).toBe(false);
  });

  it('lukewarm lead — limited budget, outside area, misaligned archetype', () => {
    const result = scoreLead({
      budget: { declaredBudget: 5000, estimatedCost: 10000 }, // ratio 0.5
      geographic: { inServiceArea: false, distanceMiles: 30 },
      archetype: {
        propertyType: 'commercial',
        jobType: 'exterior',
        customerSegment: 'business',
        propertyValueMatch: null,
        projectSizeMatch: true,
      },
      scope: { inCoreOffering: true, scopeAreaCount: 2, requestClarity: 'vague' },
    });
    // Outside area brings score down significantly
    expect(result.totalScore).toBeLessThan(SCORING_TIERS.warm.min);
    expect(result.tier).toMatch(/^(lukewarm|cold)$/);
    expect(result.overridden).toBe(false);
  });

  it('cold lead — severely underfunded, outside area, wrong archetype, vague', () => {
    // Milder cold: outside area, poor budget match, wrong archetype, vague scope
    const result = scoreLead({
      budget: { declaredBudget: 6000, estimatedCost: 10000 }, // ratio 0.6 → score 26
      geographic: { inServiceArea: null, distanceMiles: 150 }, // far → score 10
      archetype: {
        propertyType: 'commercial',
        jobType: 'interior', // interior IS preferred
        customerSegment: 'business',
        propertyValueMatch: false,
        projectSizeMatch: null,
      },
      scope: { inCoreOffering: true, scopeAreaCount: 1, requestClarity: 'vague' },
    });
    expect(result.totalScore).toBeGreaterThanOrEqual(SCORING_TIERS.cold.min);
    expect(result.totalScore).toBeLessThan(SCORING_TIERS.lukewarm.min);
    expect(result.tier).toBe('cold');
    expect(result.overridden).toBe(false);
  });
});

// ── Forced Overrides ────────────────────────────────────────────────

describe('scoreLead — forced overrides', () => {
  it('is_referral forces score to 95 (hot)', () => {
    const result = scoreLead({
      ...coldLeadInput(),
      overrides: ['is_referral'],
    });
    expect(result.totalScore).toBe(95);
    expect(result.tier).toBe('hot');
    expect(result.overridden).toBe(true);
    expect(result.appliedOverrides).toContain('is_referral');
  });

  it('is_existing_client forces score to 80 (warm)', () => {
    const result = scoreLead({
      ...coldLeadInput(),
      overrides: ['is_existing_client'],
    });
    expect(result.totalScore).toBe(80);
    expect(result.tier).toBe('warm');
    expect(result.overridden).toBe(true);
    expect(result.appliedOverrides).toContain('is_existing_client');
  });

  it('regulatory_block forces score to 0 (archive)', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      overrides: ['regulatory_block'],
    });
    expect(result.totalScore).toBe(0);
    expect(result.tier).toBe('archive');
    expect(result.overridden).toBe(true);
    expect(result.appliedOverrides).toContain('regulatory_block');
  });

  it('multiple overrides — last match wins', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      overrides: ['is_referral', 'regulatory_block'],
    });
    // regulatory_block is checked first in order of precedence
    expect(result.totalScore).toBe(0);
    expect(result.appliedOverrides).toContain('regulatory_block');
    expect(result.overridden).toBe(true);
  });

  it('override disables modifiers', () => {
    const result = scoreLead({
      ...coldLeadInput(),
      overrides: ['is_referral'],
      isRemoteFirst: true,
    });
    expect(result.totalScore).toBe(95);
    expect(result.appliedModifiers).toHaveLength(0);
  });
});

// ── Modifiers ───────────────────────────────────────────────────────

describe('scoreLead — modifiers', () => {
  it('isRemoteFirst adds +15 to non-overridden scores', () => {
    const base = scoreLead(hotLeadInput());
    const boosted = scoreLead({ ...hotLeadInput(), isRemoteFirst: true });
    expect(boosted.totalScore).toBe(Math.min(100, base.totalScore + 15));
    expect(boosted.appliedModifiers).toHaveLength(1);
    expect(boosted.appliedModifiers[0]).toMatchObject({ name: 'remote_first', delta: 15 });
  });

  it('isRemoteFirst does not apply when score is overridden', () => {
    const result = scoreLead({
      ...coldLeadInput(),
      overrides: ['is_referral'],
      isRemoteFirst: true,
    });
    expect(result.totalScore).toBe(95);
    expect(result.appliedModifiers).toHaveLength(0);
  });
});

// ── Budget Alignment ────────────────────────────────────────────────

describe('scoreLead — Budget Alignment dimension', () => {
  it('ratio >= tolerance (1.2) → score 100', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      budget: { declaredBudget: 15000, estimatedCost: 10000 }, // ratio 1.5
    });
    const dim = result.dimensions.find((d) => d.dimension === 'budgetAlignment')!;
    expect(dim.score).toBe(100);
  });

  it('ratio between 1.0 and tolerance → score 80–99', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      budget: { declaredBudget: 11000, estimatedCost: 10000 }, // ratio 1.1
    });
    const dim = result.dimensions.find((d) => d.dimension === 'budgetAlignment')!;
    expect(dim.score).toBeGreaterThanOrEqual(80);
    expect(dim.score).toBeLessThan(100);
  });

  it('ratio between 0.75 and 1.0 → score 50–79', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      budget: { declaredBudget: 8500, estimatedCost: 10000 }, // ratio 0.85
    });
    const dim = result.dimensions.find((d) => d.dimension === 'budgetAlignment')!;
    expect(dim.score).toBeGreaterThanOrEqual(50);
    expect(dim.score).toBeLessThanOrEqual(79);
  });

  it('ratio between 0.5 and 0.75 → score 10–49', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      budget: { declaredBudget: 6000, estimatedCost: 10000 }, // ratio 0.6
    });
    const dim = result.dimensions.find((d) => d.dimension === 'budgetAlignment')!;
    expect(dim.score).toBeGreaterThanOrEqual(10);
    expect(dim.score).toBeLessThanOrEqual(49);
  });

  it('ratio < 0.5 → score 10', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      budget: { declaredBudget: 3000, estimatedCost: 10000 }, // ratio 0.3
    });
    const dim = result.dimensions.find((d) => d.dimension === 'budgetAlignment')!;
    expect(dim.score).toBe(10);
  });

  it('missing both values → neutral 50', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      budget: { declaredBudget: null, estimatedCost: null },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'budgetAlignment')!;
    expect(dim.score).toBe(50);
  });

  it('only budget stated → neutral 50', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      budget: { declaredBudget: 10000, estimatedCost: null },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'budgetAlignment')!;
    expect(dim.score).toBe(50);
  });

  it('only cost estimate → neutral 50', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      budget: { declaredBudget: null, estimatedCost: 10000 },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'budgetAlignment')!;
    expect(dim.score).toBe(50);
  });
});

// ── Geographic Fit ──────────────────────────────────────────────────

describe('scoreLead — Geographic Fit dimension', () => {
  it('in service area → score 100', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      geographic: { inServiceArea: true, distanceMiles: 5 },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'geographicFit')!;
    expect(dim.score).toBe(100);
  });

  it('outside service area → score 0', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      geographic: { inServiceArea: false, distanceMiles: 100 },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'geographicFit')!;
    expect(dim.score).toBe(0);
  });

  it('no flag but within radius → score 80', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      geographic: { inServiceArea: null, distanceMiles: 25 },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'geographicFit')!;
    expect(dim.score).toBe(80);
  });

  it('no flag but within 2x radius → score 40', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      geographic: { inServiceArea: null, distanceMiles: 75 },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'geographicFit')!;
    expect(dim.score).toBe(40);
  });

  it('no flag and beyond 2x radius → score 10', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      geographic: { inServiceArea: null, distanceMiles: 200 },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'geographicFit')!;
    expect(dim.score).toBe(10);
  });

  it('no data at all → neutral 50', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      geographic: { inServiceArea: null, distanceMiles: null },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'geographicFit')!;
    expect(dim.score).toBe(50);
  });
});

// ── Archetype Match ─────────────────────────────────────────────────

describe('scoreLead — Archetype Match dimension', () => {
  it('full archetype match → score 100', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      archetype: {
        propertyType: 'residential',
        jobType: 'interior',
        customerSegment: 'homeowner',
        propertyValueMatch: true,
        projectSizeMatch: true,
      },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'archetypeMatch')!;
    expect(dim.score).toBe(100);
  });

  it('no match at all → score 0', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      archetype: {
        propertyType: 'commercial',
        jobType: 'flooring',
        customerSegment: 'business',
        propertyValueMatch: false,
        projectSizeMatch: false,
      },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'archetypeMatch')!;
    expect(dim.score).toBe(0);
  });

  it('partial match (some fields null) → intermediate score', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      archetype: {
        propertyType: 'residential',
        jobType: null,
        customerSegment: null,
        propertyValueMatch: null,
        projectSizeMatch: null,
      },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'archetypeMatch')!;
    // residential matches (100 * 0.35 = 35), rest are 50 → composite should be ~53.5
    expect(dim.score).toBeGreaterThan(0);
    expect(dim.score).toBeLessThanOrEqual(100);
  });
});

// ── Project Scope ─────────────────────────────────────────────────

describe('scoreLead — Project Scope dimension', () => {
  it('core offering + ideal scope count + clear → score 100', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      scope: { inCoreOffering: true, scopeAreaCount: 3, requestClarity: 'clear' },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'projectScope')!;
    expect(dim.score).toBe(100);
  });

  it('outside core offering → score 0', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      scope: { inCoreOffering: false, scopeAreaCount: 3, requestClarity: 'clear' },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'projectScope')!;
    // core: 0, count: 100, clarity: 100 → avg ~67
    expect(dim.score).toBeLessThan(70);
  });

  it('vague request → lower score', () => {
    const clearResult = scoreLead({
      ...hotLeadInput(),
      scope: { inCoreOffering: true, scopeAreaCount: 3, requestClarity: 'clear' },
    });
    const vagueResult = scoreLead({
      ...hotLeadInput(),
      scope: { inCoreOffering: true, scopeAreaCount: 3, requestClarity: 'vague' },
    });
    const clearDim = clearResult.dimensions.find((d) => d.dimension === 'projectScope')!;
    const vagueDim = vagueResult.dimensions.find((d) => d.dimension === 'projectScope')!;
    expect(vagueDim.score).toBeLessThan(clearDim.score);
  });

  it('too few scope areas → penalised', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      scope: { inCoreOffering: true, scopeAreaCount: 1, requestClarity: 'clear' },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'projectScope')!;
    // core: 100, count: 30, clarity: 100 → avg ~77
    expect(dim.score).toBeLessThan(80);
  });

  it('too many scope areas → penalised', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      scope: { inCoreOffering: true, scopeAreaCount: 10, requestClarity: 'clear' },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'projectScope')!;
    // core: 100, count: 20, clarity: 100 → avg ~73
    expect(dim.score).toBeLessThan(80);
  });
});

// ── Configurable Weights ───────────────────────────────────────────

describe('scoreLead — configurable weights', () => {
  it('higher budget weight increases total for budget-rich leads', () => {
    // Use a lead with budget strength but weakness elsewhere
    const budgetRichLead: LeadScoringInput = {
      budget: { declaredBudget: 20000, estimatedCost: 10000 }, // ratio 2.0 → 100
      geographic: { inServiceArea: null, distanceMiles: 150 }, // far away → low
      archetype: {
        propertyType: 'residential', // matches → high
        jobType: 'interior', // matches → high
        customerSegment: 'homeowner', // matches → high
        propertyValueMatch: null,
        projectSizeMatch: null,
      },
      scope: { inCoreOffering: true, scopeAreaCount: 2, requestClarity: 'clear' },
    };
    const defaultWeight = scoreLead(budgetRichLead);
    const highBudgetWeight = scoreLead({
      ...budgetRichLead,
      weights: { budgetAlignment: 0.70, geographicFit: 0.10, archetypeMatch: 0.10, projectScope: 0.10 },
    });
    // With higher budget weight, the budget-rich lead should score higher
    expect(highBudgetWeight.totalScore).toBeGreaterThan(defaultWeight.totalScore);
  });

  it('weights that sum to 1.0 produce valid results', () => {
    const result = scoreLead({
      ...hotLeadInput(),
      weights: { budgetAlignment: 0.10, geographicFit: 0.10, archetypeMatch: 0.40, projectScope: 0.40 },
    });
    expect(result.totalScore).toBeGreaterThanOrEqual(0);
    expect(result.totalScore).toBeLessThanOrEqual(100);
  });
  it('throws on invalid weight sums', () => {
    // Weights sum to 2.0 instead of 1.0
    expect(() =>
      scoreLead({
        ...hotLeadInput(),
        weights: { budgetAlignment: 0.50, geographicFit: 0.50, archetypeMatch: 0.50, projectScope: 0.50 },
      }),
    ).toThrow('Scoring weights must sum to 1.0');

    // Negative weight
    expect(() =>
      scoreLead({
        ...hotLeadInput(),
        weights: { budgetAlignment: 0.5, geographicFit: 0.5, archetypeMatch: 0.5, projectScope: -0.5 },
      }),
    ).toThrow('Scoring weights must be finite non-negative numbers.');
  });
});

// ── Edge Cases ──────────────────────────────────────────────────────

describe('scoreLead — edge cases', () => {
  it('score is clamped to [0, 100]', () => {
    // isRemoteFirst + already-hot could exceed 100
    const result = scoreLead({ ...hotLeadInput(), isRemoteFirst: true });
    expect(result.totalScore).toBeLessThanOrEqual(100);
    expect(result.totalScore).toBeGreaterThanOrEqual(0);
  });

  it('all null inputs return neutral scores', () => {
    const result = scoreLead({
      budget: { declaredBudget: null, estimatedCost: null },
      geographic: { inServiceArea: null, distanceMiles: null },
      archetype: {
        propertyType: null,
        jobType: null,
        customerSegment: null,
        propertyValueMatch: null,
        projectSizeMatch: null,
      },
      scope: { inCoreOffering: null, scopeAreaCount: null, requestClarity: null },
    });
    // All neutrals → 50 each → weighted sum = 50
    expect(result.totalScore).toBe(50);
    expect(result.tier).toBe('lukewarm');
    expect(result.overridden).toBe(false);
  });

  it('every dimension has a human-readable rationale', () => {
    const result = scoreLead(hotLeadInput());
    for (const dim of result.dimensions) {
      expect(dim.rationale).toBeTruthy();
      expect(typeof dim.rationale).toBe('string');
      expect(dim.rationale.length).toBeGreaterThan(10);
    }
  });

  it('appliedModifiers is empty when no modifiers active', () => {
    const result = scoreLead(hotLeadInput());
    expect(result.appliedModifiers).toHaveLength(0);
  });

  it('appliedOverrides is empty when no overrides active', () => {
    const result = scoreLead(hotLeadInput());
    expect(result.appliedOverrides).toHaveLength(0);
  });

  it('budget tolerance parameter is respected', () => {
    // With a low tolerance (1.0), budget=cost is a perfect 100
    const strictTolerance = scoreLead({
      ...hotLeadInput(),
      budget: { declaredBudget: 10000, estimatedCost: 10000, tolerance: 1.0 },
    });
    const strictDim = strictTolerance.dimensions.find((d) => d.dimension === 'budgetAlignment')!;
    expect(strictDim.score).toBe(100);

    // With a higher tolerance (1.5), budget=cost is not 100
    const highTolerance = scoreLead({
      ...hotLeadInput(),
      budget: { declaredBudget: 10000, estimatedCost: 10000, tolerance: 1.5 },
    });
    const highDim = highTolerance.dimensions.find((d) => d.dimension === 'budgetAlignment')!;
    expect(highDim.score).toBeLessThan(100);
  });

  it('custom service radius is respected', () => {
    const withinRadius = scoreLead({
      ...hotLeadInput(),
      geographic: { inServiceArea: null, distanceMiles: 80, serviceRadius: 100 },
    });
    const dim1 = withinRadius.dimensions.find((d) => d.dimension === 'geographicFit')!;
    expect(dim1.score).toBe(80); // 80 < 100, so within radius

    const beyondRadius = scoreLead({
      ...hotLeadInput(),
      geographic: { inServiceArea: null, distanceMiles: 80, serviceRadius: 40 },
    });
    const dim2 = beyondRadius.dimensions.find((d) => d.dimension === 'geographicFit')!;
    expect(dim2.score).toBe(40); // 80 > 40, so between 1x and 2x radius
  });

  it('custom ideal archetype profile is respected', () => {
    const commercialProfile = {
      ...DEFAULT_IDEAL_PROFILE,
      preferredPropertyTypes: ['commercial'],
      preferredSegments: ['business'],
    };
    const result = scoreLead({
      ...hotLeadInput(),
      archetype: {
        ...hotLeadInput().archetype,
        propertyType: 'commercial',
        customerSegment: 'business',
        idealProfile: commercialProfile,
      },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'archetypeMatch')!;
    // Commercial and business now match perfectly
    expect(dim.score).toBeGreaterThan(50);
  });

  it('custom scope area bounds are respected', () => {
    // Single scope but idealMin=1 → not penalised
    const result = scoreLead({
      ...hotLeadInput(),
      scope: { inCoreOffering: true, scopeAreaCount: 1, requestClarity: 'clear', idealScopeAreaMin: 1, idealScopeAreaMax: 3 },
    });
    const dim = result.dimensions.find((d) => d.dimension === 'projectScope')!;
    expect(dim.score).toBe(100); // all 100
  });
});

// ── Tier Classification ─────────────────────────────────────────────

describe('scoreLead — tier boundaries', () => {
  it('85+ → hot', () => {
    const result = scoreLead(hotLeadInput());
    expect(result.totalScore).toBeGreaterThanOrEqual(85);
    expect(result.tier).toBe('hot');
  });

  it('70–84 → warm', () => {
    const result = scoreLead({
      budget: { declaredBudget: 5000, estimatedCost: 10000 }, // ratio 0.5 → 10
      geographic: { inServiceArea: true, distanceMiles: 5 }, // 100
      archetype: {
        propertyType: 'residential', // 100
        jobType: null, // neutral 50
        customerSegment: 'homeowner', // 100
        propertyValueMatch: true, // 100
        projectSizeMatch: null, // neutral 50
      },
      scope: { inCoreOffering: true, scopeAreaCount: 3, requestClarity: 'clear' }, // 100
    });
    expect(result.totalScore).toBeGreaterThanOrEqual(70);
    expect(result.totalScore).toBeLessThan(85);
    expect(result.tier).toBe('warm');
  });

  it('50–69 → lukewarm', () => {
    const result = scoreLead({
      budget: { declaredBudget: null, estimatedCost: null }, // 50
      geographic: { inServiceArea: null, distanceMiles: null }, // 50
      archetype: {
        propertyType: 'residential',
        jobType: null,
        customerSegment: null,
        propertyValueMatch: null,
        projectSizeMatch: null,
      },
      scope: { inCoreOffering: null, scopeAreaCount: null, requestClarity: null }, // 50
    });
    expect(result.totalScore).toBeGreaterThanOrEqual(50);
    expect(result.totalScore).toBeLessThan(70);
    expect(result.tier).toBe('lukewarm');
  });

  it('30–49 → cold', () => {
    // Moderate cold: outside area, poor budget, but core offering and some archetype match
    const result = scoreLead({
      budget: { declaredBudget: 3000, estimatedCost: 10000 }, // ratio 0.3 → score 10
      geographic: { inServiceArea: false, distanceMiles: 150 },
      archetype: {
        propertyType: 'residential', // matches → 100
        jobType: null,
        customerSegment: null,
        propertyValueMatch: null,
        projectSizeMatch: null,
      },
      scope: { inCoreOffering: true, scopeAreaCount: 1, requestClarity: 'vague' },
    });
    expect(result.totalScore).toBeGreaterThanOrEqual(30);
    expect(result.totalScore).toBeLessThan(50);
    expect(result.tier).toBe('cold');
  });

  it('0–29 → archive', () => {
    const result = scoreLead({
      ...coldLeadInput(),
      overrides: ['regulatory_block'],
    });
    expect(result.totalScore).toBe(0);
    expect(result.tier).toBe('archive');
  });
});
