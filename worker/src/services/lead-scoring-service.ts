// ---------------------------------------------------------------------------
// Lead Scoring Service
//
// Implements the configurable lead priority scoring engine described in the
// architect's design spec. 4 dimensions, weighted-sum composite, overrides,
// modifiers, and full audit trail.
//
// Design reference: lead-scoring-algorithm-design.md (architect task t_542b9331)
// ---------------------------------------------------------------------------

import type {
  LeadScoringInput,
  LeadScoringResult,
  DimensionScore,
  ScoringDimension,
  ScoreOverride,
  ScoringWeights,
  ArchetypeIdealProfile,
} from 'shared';
import { DEFAULT_SCORING_WEIGHTS, SCORING_TIERS, DEFAULT_IDEAL_PROFILE } from 'shared';
import type { ScoringTier } from 'shared';

// ── Public API ──────────────────────────────────────────────────────

/**
 * Score a lead across all four dimensions and return a composite priority
 * score with full audit trail.
 *
 * @param input - Lead attributes and optional configuration.
 * @returns A structured scoring result with tier, breakdown, and audit trail.
 */
export function scoreLead(input: LeadScoringInput): LeadScoringResult {
  const weights: ScoringWeights = input.weights ?? DEFAULT_SCORING_WEIGHTS;
  const overrides: ScoreOverride[] = input.overrides ?? [];

  // ── Step 1: Score each dimension ──────────────────────────────────
  const dimensions: DimensionScore[] = [
    scoreBudgetAlignment(input.budget),
    scoreGeographicFit(input.geographic),
    scoreArchetypeMatch(input.archetype),
    scoreProjectScope(input.scope),
  ];

  // ── Step 2: Compute weighted total ────────────────────────────────
  let totalScore = dimensions.reduce(
    (sum, d) => sum + d.score * weightForDimension(weights, d.dimension),
    0,
  );
  let overridden = false;

  // ── Step 3: Check forced overrides ────────────────────────────────
  const appliedOverrides: ScoreOverride[] = [];
  const appliedModifiers: Array<{ name: string; delta: number; rationale: string }> = [];

  if (overrides.includes('regulatory_block')) {
    totalScore = 0;
    appliedOverrides.push('regulatory_block');
    overridden = true;
  } else if (overrides.includes('is_referral')) {
    totalScore = 95;
    appliedOverrides.push('is_referral');
    overridden = true;
  } else if (overrides.includes('is_existing_client')) {
    totalScore = 80;
    appliedOverrides.push('is_existing_client');
    overridden = true;
  }

  // ── Step 4: Apply modifiers (only if not overridden) ──────────────
  if (!overridden) {
    if (input.isRemoteFirst) {
      appliedModifiers.push({
        name: 'remote_first',
        delta: 15,
        rationale: 'Remote-first/async-capable teams tend to be more responsive and have clearer requirements.',
      });
      totalScore += 15;
    }
  }

  // ── Step 5: Clamp and classify ────────────────────────────────────
  const clampedScore = Math.max(0, Math.min(100, Math.round(totalScore)));
  const tier = classifyTier(clampedScore);

  return {
    totalScore: clampedScore,
    tier,
    dimensions,
    appliedOverrides,
    appliedModifiers,
    overridden,
  };
}

// ── Dimension Scorers ───────────────────────────────────────────────

/**
 * Budget Alignment (weight: 0.25)
 *
 * Compares the customer's declared budget against the estimated project cost.
 * When both values are available the ratio determines the score.  Missing data
 * yields a neutral 50 to avoid penalising leads who didn't state a budget.
 */
function scoreBudgetAlignment(input: {
  declaredBudget: number | null;
  estimatedCost: number | null;
  tolerance?: number;
}): DimensionScore {
  const tolerance = input.tolerance ?? 1.2;

  // Neither value available → neutral score
  if (input.declaredBudget === null && input.estimatedCost === null) {
    return {
      dimension: 'budgetAlignment',
      score: 50,
      rationale: 'No budget or cost data available. Defaulting to neutral score to avoid bias.',
    };
  }

  // Only budget stated → neutral (no cost baseline to compare)
  if (input.declaredBudget !== null && input.estimatedCost === null) {
    return {
      dimension: 'budgetAlignment',
      score: 50,
      rationale: `Declared budget: $${formatCurrency(input.declaredBudget)}. No cost estimate available yet. Neutral score.`,
    };
  }

  // Only cost estimate available → neutral
  if (input.declaredBudget === null && input.estimatedCost !== null) {
    return {
      dimension: 'budgetAlignment',
      score: 50,
      rationale: `Estimated cost: $${formatCurrency(input.estimatedCost)}. No declared budget from lead. Neutral score.`,
    };
  }

  // Both values available → score by ratio
  const ratio = input.declaredBudget! / input.estimatedCost!;
  let score: number;
  let rationale: string;

  if (ratio >= tolerance) {
    score = 100;
    rationale = `Budget ($${formatCurrency(input.declaredBudget!)}) is ${((ratio - 1) * 100).toFixed(0)}% above estimated cost ($${formatCurrency(input.estimatedCost!)}). Well within tolerance.`;
  } else if (ratio >= 1.0) {
    // Budget covers cost with some room: 80–99
    score = 80 + Math.round(((ratio - 1.0) / (tolerance - 1.0)) * 19);
    rationale = `Budget ($${formatCurrency(input.declaredBudget!)}) covers estimated cost ($${formatCurrency(input.estimatedCost!)}) with room. Ratio: ${ratio.toFixed(2)}.`;
  } else if (ratio >= 0.75) {
    // Budget is close: 50–79
    score = 50 + Math.round(((ratio - 0.75) / 0.25) * 29);
    rationale = `Budget ($${formatCurrency(input.declaredBudget!)}) is ${((1 - ratio) * 100).toFixed(0)}% below estimate ($${formatCurrency(input.estimatedCost!)}). Close but needs attention.`;
  } else if (ratio >= 0.5) {
    // Budget is tight: 10–49
    score = 10 + Math.round(((ratio - 0.5) / 0.25) * 39);
    rationale = `Budget ($${formatCurrency(input.declaredBudget!)}) is significantly below estimate ($${formatCurrency(input.estimatedCost!)}). Ratio: ${ratio.toFixed(2)}.`;
  } else {
    score = 10;
    rationale = `Budget ($${formatCurrency(input.declaredBudget!)}) is critically below estimate ($${formatCurrency(input.estimatedCost!)}). Ratio: ${ratio.toFixed(2)}.`;
  }

  return { dimension: 'budgetAlignment', score, rationale };
}

/**
 * Geographic Fit (weight: 0.20)
 *
 * Scores based on whether the lead falls within the primary service area or
 * within a reasonable driving distance.  Missing data yields neutral 50.
 */
function scoreGeographicFit(input: {
  inServiceArea: boolean | null;
  distanceMiles: number | null;
  serviceRadius?: number;
}): DimensionScore {
  const serviceRadius = input.serviceRadius ?? 50;

  // Explicit inServiceArea flag
  if (input.inServiceArea === true) {
    return {
      dimension: 'geographicFit',
      score: 100,
      rationale: 'Lead is within the primary service area.',
    };
  }
  if (input.inServiceArea === false) {
    return {
      dimension: 'geographicFit',
      score: 0,
      rationale: 'Lead is outside the service area.',
    };
  }

  // No explicit flag — use distance
  if (input.distanceMiles === null) {
    return {
      dimension: 'geographicFit',
      score: 50,
      rationale: 'No geographic data available. Defaulting to neutral score to avoid bias.',
    };
  }

  if (input.distanceMiles <= serviceRadius) {
    return {
      dimension: 'geographicFit',
      score: 80,
      rationale: `Lead is ${input.distanceMiles} miles away, within the ${serviceRadius}-mile service radius.`,
    };
  }
  if (input.distanceMiles <= serviceRadius * 2) {
    return {
      dimension: 'geographicFit',
      score: 40,
      rationale: `Lead is ${input.distanceMiles} miles away, within ${serviceRadius * 2} miles. Manageable but not ideal.`,
    };
  }

  return {
    dimension: 'geographicFit',
    score: 10,
    rationale: `Lead is ${input.distanceMiles} miles away, significantly beyond the ${serviceRadius}-mile service radius.`,
  };
}

/**
 * Archetype Match (weight: 0.30)
 *
 * Compares the lead against an ideal customer profile across five
 * sub-dimensions with configurable weights.
 */
function scoreArchetypeMatch(input: {
  propertyType: string | null;
  jobType: string | null;
  customerSegment: string | null;
  propertyValueMatch: boolean | null;
  projectSizeMatch: boolean | null;
  idealProfile?: ArchetypeIdealProfile;
}): DimensionScore {
  const profile = input.idealProfile ?? DEFAULT_IDEAL_PROFILE;

  const subtypeWeights: Record<string, number> = {
    propertyType: profile.propertyTypeWeight ?? 0.35,
    jobType: profile.jobTypeWeight ?? 0.25,
    segment: profile.segmentWeight ?? 0.15,
    propertyValue: profile.propertyValueWeight ?? 0.10,
    projectSize: profile.projectSizeWeight ?? 0.15,
  };
  const totalSubWeight = Object.values(subtypeWeights).reduce((s, w) => s + w, 0);

  // Score each sub-dimension
  const subScores: Array<{ score: number; detail: string }> = [];

  // Property type
  subScores.push(scoreCategoryMatch(
    input.propertyType,
    profile.preferredPropertyTypes,
    'property type',
  ));

  // Job type
  subScores.push(scoreCategoryMatch(
    input.jobType,
    profile.preferredJobTypes,
    'job type',
  ));

  // Customer segment
  subScores.push(scoreCategoryMatch(
    input.customerSegment,
    profile.preferredSegments,
    'customer segment',
  ));

  // Property value
  if (input.propertyValueMatch === true) {
    subScores.push({ score: 100, detail: 'Property value matches ideal range.' });
  } else if (input.propertyValueMatch === false) {
    subScores.push({ score: 0, detail: 'Property value outside ideal range.' });
  } else {
    subScores.push({ score: 50, detail: 'Property value data not available. Neutral score.' });
  }

  // Project size
  if (input.projectSizeMatch === true) {
    subScores.push({ score: 100, detail: 'Project size matches ideal range.' });
  } else if (input.projectSizeMatch === false) {
    subScores.push({ score: 0, detail: 'Project size outside ideal range.' });
  } else {
    subScores.push({ score: 50, detail: 'Project size data not available. Neutral score.' });
  }

  // Weighted composite
  const weightKeys = Object.keys(subtypeWeights);
  const composite = subScores.reduce(
    (sum, s, i) => sum + s.score * (subtypeWeights[weightKeys[i]] / totalSubWeight),
    0,
  );

  const detailLines = subScores.map((s, i) => `  ${weightKeys[i]}: ${s.score}/100 — ${s.detail}`).join('\n');

  return {
    dimension: 'archetypeMatch',
    score: Math.round(composite),
    rationale: `Lead archetype match: ${Math.round(composite)}/100.\n${detailLines}`,
  };
}

/**
 * Project Scope (weight: 0.25)
 *
 * Evaluates whether the project fits within our core service offerings,
 * has an appropriate number of scope areas, and has a clear request.
 */
function scoreProjectScope(input: {
  inCoreOffering: boolean | null;
  scopeAreaCount: number | null;
  requestClarity: 'clear' | 'vague' | 'unknown' | null;
  idealScopeAreaMin?: number;
  idealScopeAreaMax?: number;
}): DimensionScore {
  const idealMin = input.idealScopeAreaMin ?? 2;
  const idealMax = input.idealScopeAreaMax ?? 6;
  const rationales: string[] = [];

  // 1. Core offering match
  let coreScore: number;
  if (input.inCoreOffering === true) {
    coreScore = 100;
    rationales.push('Project is in core service offering.');
  } else if (input.inCoreOffering === false) {
    coreScore = 0;
    rationales.push('Project is outside core service offering.');
  } else {
    coreScore = 50;
    rationales.push('Core offering match not determined. Neutral score.');
  }

  // 2. Scope area count
  let countScore: number;
  if (input.scopeAreaCount === null) {
    countScore = 50;
    rationales.push('Scope area count not provided. Neutral score.');
  } else if (input.scopeAreaCount >= idealMin && input.scopeAreaCount <= idealMax) {
    countScore = 100;
    rationales.push(`Scope areas (${input.scopeAreaCount}) within ideal range [${idealMin}–${idealMax}].`);
  } else if (input.scopeAreaCount < idealMin) {
    countScore = 30;
    rationales.push(`Scope areas (${input.scopeAreaCount}) fewer than ideal minimum (${idealMin}). May be too small.`);
  } else {
    countScore = 20;
    rationales.push(`Scope areas (${input.scopeAreaCount}) exceed ideal maximum (${idealMax}). May be too large.`);
  }

  // 3. Request clarity
  let clarityScore: number;
  if (input.requestClarity === 'clear') {
    clarityScore = 100;
    rationales.push('Customer request is well-defined and clear.');
  } else if (input.requestClarity === 'vague') {
    clarityScore = 30;
    rationales.push('Customer request is vague. May require back-and-forth to define scope.');
  } else {
    clarityScore = 50;
    rationales.push('Request clarity not determined. Neutral score.');
  }

  const composite = Math.round((coreScore + countScore + clarityScore) / 3);

  return {
    dimension: 'projectScope',
    score: composite,
    rationale: `Project scope: ${composite}/100.\n  Core offering: ${coreScore}/100 — ${rationales[0]}\n  Scope count: ${countScore}/100 — ${rationales[1]}\n  Clarity: ${clarityScore}/100 — ${rationales[2]}`,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Score a category-based match (property type, job type, segment) against
 * a list of preferred values.
 *
 * - Exact match to any preferred → 100
 * - Partial match (e.g., 'both' contains both residential and commercial) → 50
 * - No match → 0
 * - Null → 50 (neutral)
 */
function scoreCategoryMatch(
  value: string | null,
  preferred: string[],
  label: string,
): { score: number; detail: string } {
  if (value === null) {
    return { score: 50, detail: `${label} not provided. Neutral score.` };
  }

  const normalized = value.toLowerCase();
  const normalizedPreferred = preferred.map((p) => p.toLowerCase());

  if (normalizedPreferred.includes(normalized)) {
    return { score: 100, detail: `${label} "${value}" matches ideal profile.` };
  }

  // 'both' is a partial match if at least one preferred value is contained
  if (
    normalized === 'both' &&
    normalizedPreferred.some((p) => p === 'interior' || p === 'exterior' || p === 'residential' || p === 'commercial')
  ) {
    return { score: 50, detail: `${label} "both" is a partial match to ideal profile.` };
  }

  return { score: 0, detail: `${label} "${value}" does not match ideal profile.` };
}

/**
 * Classify a numeric score into a tier.
 */
function classifyTier(score: number): ScoringTier {
  const entries = Object.entries(SCORING_TIERS) as [ScoringTier, { min: number; label: string }][];
  entries.sort((a, b) => b[1].min - a[1].min); // highest first

  for (const [tier, config] of entries) {
    if (score >= config.min) return tier;
  }

  return 'archive';
}

/**
 * Look up the weight for a given dimension.
 */
function weightForDimension(weights: ScoringWeights, dimension: ScoringDimension): number {
  const map: Record<ScoringDimension, keyof ScoringWeights> = {
    budgetAlignment: 'budgetAlignment',
    geographicFit: 'geographicFit',
    archetypeMatch: 'archetypeMatch',
    projectScope: 'projectScope',
  };
  return weights[map[dimension]] ?? 0;
}

/**
 * Format a number as currency (no cents, dollar sign).
 */
function formatCurrency(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(0)}K`;
  }
  return value.toFixed(0);
}