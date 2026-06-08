// ---------------------------------------------------------------------------
// Lead Scoring Engine — Types
// Based on the lead scoring algorithm design spec: 4 dimensions (Budget
// Alignment 25%, Geographic Fit 20%, Archetype Match 30%, Project Scope 25%),
// configurable weights, overrides, and modifiers.
// ---------------------------------------------------------------------------

// ── Scoring Configuration ──────────────────────────────────────────

/** Default scoring weights from the design spec. Weights sum to 1.0. */
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  budgetAlignment: 0.25,
  geographicFit: 0.20,
  archetypeMatch: 0.30,
  projectScope: 0.25,
};

/** Configurable weights for each scoring dimension. Must sum to 1.0. */
export interface ScoringWeights {
  budgetAlignment: number;
  geographicFit: number;
  archetypeMatch: number;
  projectScope: number;
}

/** Thresholds for tier classification (inclusive lower bound). */
export const SCORING_TIERS = {
  hot: { min: 85, label: 'hot', description: 'High-priority — pursue immediately' },
  warm: { min: 70, label: 'warm', description: 'Good prospect — engage within 24h' },
  lukewarm: { min: 50, label: 'lukewarm', description: 'Moderate interest — nurture' },
  cold: { min: 30, label: 'cold', description: 'Low priority — monitor' },
  archive: { min: 0, label: 'archive', description: 'Not actionable — archive' },
} as const;

export type ScoringTier = keyof typeof SCORING_TIERS;

/** The four scoring dimensions. */
export type ScoringDimension = 'budgetAlignment' | 'geographicFit' | 'archetypeMatch' | 'projectScope';

/** Forced override that bypasses the computed score. */
export type ScoreOverride = 'is_referral' | 'is_existing_client' | 'regulatory_block';

// ── Inputs ─────────────────────────────────────────────────────────

/** Input attributes for the budget alignment dimension. */
export interface BudgetAlignmentInput {
  /** The customer's declared budget in dollars, or null if not provided. */
  declaredBudget: number | null;
  /** The estimated project cost in dollars (from the quoting engine). */
  estimatedCost: number | null;
  /**
   * Budget-to-cost ratio tolerance. The scoring function maps:
   *   >= tolerance → score 100 (budget easily covers cost)
   *   >= 0.75      → linearly decreasing from 100
   *   < 0.5        → score 10 (significant gap)
   * Default: 1.2 (20% headroom)
   */
  tolerance?: number;
}

/** Input attributes for the geographic fit dimension. */
export interface GeographicFitInput {
  /** Whether the lead's location falls within the primary service area. */
  inServiceArea: boolean | null;
  /** Driving distance in miles (null if unknown). */
  distanceMiles: number | null;
  /** The service radius limit in miles. Default: 50. */
  serviceRadius?: number;
}

/** Input attributes for the archetype match dimension. */
export interface ArchetypeMatchInput {
  /** Property type match: 'residential' | 'commercial' | 'both' | null. */
  propertyType: string | null;
  /** Job type match: e.g., 'interior', 'exterior', 'both' | null. */
  jobType: string | null;
  /** Customer segment: 'homeowner' | 'landlord' | 'property_manager' | 'business' | null. */
  customerSegment: string | null;
  /** Whether the lead matches the ideal property value range. */
  propertyValueMatch: boolean | null;
  /** Whether the lead matches the ideal project size range. */
  projectSizeMatch: boolean | null;
  /** Optional ideal archetype configuration. */
  idealProfile?: ArchetypeIdealProfile;
}

/** Defines the "ideal lead" profile for scoring. */
export interface ArchetypeIdealProfile {
  preferredPropertyTypes: string[];
  preferredJobTypes: string[];
  preferredSegments: string[];
  /** Weight for property type match (default: 0.35). */
  propertyTypeWeight?: number;
  /** Weight for job type match (default: 0.25). */
  jobTypeWeight?: number;
  /** Weight for customer segment match (default: 0.15). */
  segmentWeight?: number;
  /** Weight for property value match (default: 0.10). */
  propertyValueWeight?: number;
  /** Weight for project size match (default: 0.15). */
  projectSizeWeight?: number;
}

/** Default ideal archetype profile. */
export const DEFAULT_IDEAL_PROFILE: ArchetypeIdealProfile = {
  preferredPropertyTypes: ['residential'],
  preferredJobTypes: ['interior', 'exterior'],
  preferredSegments: ['homeowner'],
  propertyTypeWeight: 0.35,
  jobTypeWeight: 0.25,
  segmentWeight: 0.15,
  propertyValueWeight: 0.10,
  projectSizeWeight: 0.15,
};

/** Input attributes for the project scope dimension. */
export interface ProjectScopeInput {
  /** Whether the project involves our core service offerings. */
  inCoreOffering: boolean | null;
  /** Number of distinct scope areas (e.g., interior walls, ceiling, trim, exterior). */
  scopeAreaCount: number | null;
  /** Whether the customer's request is clear and well-defined. */
  requestClarity: 'clear' | 'vague' | 'unknown' | null;
  /** Minimum scope areas for ideal scoring. Default: 2. */
  idealScopeAreaMin?: number;
  /** Maximum scope areas before it's too large. Default: 6. */
  idealScopeAreaMax?: number;
}

/** Complete input for the lead scoring engine. */
export interface LeadScoringInput {
  budget: BudgetAlignmentInput;
  geographic: GeographicFitInput;
  archetype: ArchetypeMatchInput;
  scope: ProjectScopeInput;
  /** Optional weight overrides (defaults to DEFAULT_SCORING_WEIGHTS). */
  weights?: ScoringWeights;
  /** Forced overrides that bypass computed score. */
  overrides?: ScoreOverride[];
  /** True if the lead is a remote-first/async-capable team. Applies +15 modifier. */
  isRemoteFirst?: boolean;
}

// ── Outputs ─────────────────────────────────────────────────────────

/** The result of scoring a single dimension. */
export interface DimensionScore {
  /** The dimension name. */
  dimension: ScoringDimension;
  /** Raw score 0–100. */
  score: number;
  /** Human-readable explanation of the score. */
  rationale: string;
}

/** The full lead scoring result. */
export interface LeadScoringResult {
  /** Overall composite score (0–100, after modifiers applied). */
  totalScore: number;
  /** The tier label. */
  tier: ScoringTier;
  /** Per-dimension breakdown for audit trail. */
  dimensions: DimensionScore[];
  /** Applied overrides (may be empty). */
  appliedOverrides: ScoreOverride[];
  /** Applied modifiers (e.g., remote_first +15). */
  appliedModifiers: Array<{ name: string; delta: number; rationale: string }>;
  /** Whether any forced override set the final score directly. */
  overridden: boolean;
}
