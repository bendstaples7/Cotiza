/** A manually-created customer request */
export interface ManualRequest {
  id: string;
  userId: string;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  customerAddress: string | null;
  serviceDescription: string;
  mediaItemIds: string[];
  requestSource: 'manual';
  createdAt: Date;
}

/** Payload for creating a manual request */
export interface CreateManualRequestPayload {
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  customerAddress?: string;
  serviceDescription: string;
  mediaItemIds?: string[];
}

/** A product from the Jobber catalog or manual entry */
export interface ProductCatalogEntry {
  id: string;
  name: string;
  unitPrice: number;
  description: string;
  category?: string;
  sortOrder?: number;
  keywords?: string;
  source: 'jobber' | 'manual';
  /**
   * Scope constraint for AI line item generation.
   * Values: 'any' | 'ceiling' | 'wall' | 'floor' | 'perimeter' | 'exterior' | 'plumbing' | 'electrical'
   * When set, the AI will only include this product when the customer's request involves the matching scope.
   * Null/undefined means no constraint (same as 'any').
   */
  scope?: Scope | null;
}

/** A line item within a quote template */
export interface TemplateLineItem {
  name: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

/** A quote template from manual entry */
export interface QuoteTemplate {
  id: string;
  name: string;
  content: string;
  category?: string;
  lineItems: TemplateLineItem[];
  source: 'manual';
}

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

/** An action item requiring user input before a line item can be finalized */
export interface ActionItem {
  id: string;
  quoteDraftId: string;
  lineItemId: string;
  description: string;
  completed: boolean;
}

/**
 * Human-readable rationale for why a line item was added and why its
 * quantity is what it is. Derived from the rules engine audit trail at
 * quote generation time and stored as a JSON blob on the line item row.
 */
export interface LineItemRationale {
  /** Name of the rule that added this line item (null if AI-matched, not rule-added) */
  addedByRuleName: string | null;
  /** Human-readable summary of the condition that triggered the rule */
  conditionSummary: string | null;
  /** The compute_quantity formula used, if any (e.g. "sqft / drywall_rate") */
  quantityFormula: string | null;
  /** Variable values substituted into the formula (e.g. { sqft: 1200, drywall_rate: 40 }) */
  quantityVariables: Record<string, number> | null;
  /** The quantity before the compute_quantity action ran */
  quantityBefore: number | null;
  /** The quantity after the compute_quantity action ran */
  quantityAfter: number | null;
  /** The space context that drove the sqft used in this item's formula, if any */
  spaceContext?: {
    spaceName: string;
    normalizedLabel: string;
    sqftUsed: number;
    sqftSource: 'explicit' | 'estimated' | 'whole_property';
  } | null;
  /** The catalog scope value for this product, if set */
  catalogScope?: string | null;
  /** The description set by the enrichment pass, if any */
  enrichmentApplied?: string | null;
}

/**
 * Quote-level generation trace capturing the full pipeline for a quote.
 * Stored as a JSON blob on the draft for debugging and triage.
 */
export interface GenerationTrace {
  /** Scopes detected from the customer request text */
  detectedScopes: string[];
  /** Number of catalog products filtered out due to scope mismatch before the AI call */
  catalogFilteredCount: number;
  /** Names of products filtered out of the catalog before the AI call */
  catalogFilteredProducts: string[];
  /** The whole-property sqft resolved (null if not resolved) */
  wholePropSqft: number | null;
  /** The sqft resolution tier used */
  sqftResolutionTier: string | null;
  /** Space contexts extracted from the customer text */
  spaceContexts: Array<{
    spaceName: string;
    normalizedLabel: string;
    explicitSqft: number | null;
    estimatedSqft: number | null;
    sqftIsExplicit: boolean;
  }>;
  /** Number of rules that fired during generation */
  rulesFiredCount: number;
  /** Names of rules that fired */
  rulesFired: string[];
  /** Number of items moved to unresolved due to scope mismatch post-generation */
  scopeMismatchCount: number;
  /** Names of items moved to unresolved due to scope mismatch */
  scopeMismatchedProducts: string[];
  /** Whether the fallback enrichment pass ran and how many items it enriched */
  fallbackEnrichmentCount: number;
}

/** A matched line item in a quote draft */
export interface QuoteLineItem {
  id: string;
  productCatalogEntryId: string | null;
  productName: string;
  description: string;
  quantity: number;
  unitPrice: number;
  confidenceScore: number;
  originalText: string;
  resolved: boolean;
  unmatchedReason?: string;
  ruleIdsApplied?: string[];
  quantityPrediction?: QuantityPredictionMeta;
  /** Rationale for why this item was added and why the quantity is what it is */
  rationale?: LineItemRationale;
}

/** A single payment milestone within a deposit schedule */
export interface PaymentMilestone {
  /** Human-readable label for when this payment is due (max 255 chars) */
  description: string;
  /** Whole integer percentage of total quote value due at this milestone (1–100 inclusive); all milestones in a schedule must sum to exactly 100 */
  percentage: number;
}

/** A structured payment plan attached to a quote draft */
export interface DepositSchedule {
  /** Human-readable name for the schedule (1–100 chars) */
  label: string;
  /** Ordered list of payment milestones (1–10 entries); percentages must sum to 100.00 */
  milestones: PaymentMilestone[];
}

/** The full quote draft */
export interface QuoteDraft {
  id: string;
  draftNumber: number;
  userId: string;
  customerRequestText: string;
  selectedTemplateId: string | null;
  selectedTemplateName: string | null;
  lineItems: QuoteLineItem[];
  unresolvedItems: QuoteLineItem[];
  jobberRequestId: string | null;
  manualRequestId?: string | null;
  clientName?: string | null;
  jobberQuoteId?: string | null;
  jobberQuoteNumber?: string | null;
  jobberQuoteWebUri?: string | null;
  status: 'draft' | 'finalized';
  actionItems?: ActionItem[];
  similarQuotes?: SimilarQuote[];
  revisionHistory?: RevisionHistoryEntry[];
  customerNote: string | null;
  /** Deposit schedule assigned to this quote draft, or null if none has been set */
  depositSchedule: DepositSchedule | null;
  /** Resolved square footage result, including any manual override */
  sqftResolution?: SqftResolutionResult | null;
  /** Spaces extracted from the customer request text, with sqft context */
  spaceContext?: SpaceContext[] | null;
  /** Full generation pipeline trace for debugging and triage */
  generationTrace?: GenerationTrace | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Form answer from a Jobber request submission */
export interface JobberFormAnswer {
  label: string;
  value: string | null;
}

/** Form section from a Jobber request submission */
export interface JobberFormSection {
  label: string;
  sortOrder: number;
  answers: JobberFormAnswer[];
}

/** Form data from a Jobber request submission */
export interface JobberRequestFormData {
  sections: JobberFormSection[];
  text: string;
}

/** A note on a Jobber customer request */
export interface JobberRequestNote {
  message: string;
  createdBy: 'team' | 'client' | 'system';
  createdAt: string;
}

/** A customer request from Jobber */
export interface JobberCustomerRequest {
  id: string;
  title: string;
  clientName: string;
  description: string;
  notes: string[];
  structuredNotes: JobberRequestNote[];
  imageUrls: string[];
  jobberWebUri: string;
  formData?: JobberRequestFormData;
  createdAt: string;
}

/** A similar past quote found via embedding similarity search */
export interface SimilarQuote {
  jobberQuoteId: string;
  quoteNumber: string;
  title: string;
  message: string;
  similarityScore: number;
}

/** A single entry in the revision history for a quote draft */
export interface RevisionHistoryEntry {
  id: string;
  quoteDraftId: string;
  feedbackText: string;
  createdAt: Date;
}

/** Update payload for editing a draft */
export interface QuoteDraftUpdate {
  lineItems?: Partial<QuoteLineItem>[];
  unresolvedItems?: Partial<QuoteLineItem>[];
  actionItems?: ActionItem[];
  selectedTemplateId?: string | null;
  status?: 'draft' | 'finalized';
  customerNote?: string | null;
  /** Deposit schedule to assign; omit to leave unchanged, null to clear */
  depositSchedule?: DepositSchedule | null;
  /** Set to a positive number to apply a manual sqft override; null to clear */
  sqftOverride?: number | null;
}

// ---------------------------------------------------------------------------
// Sqft Resolution Types
// ---------------------------------------------------------------------------

/** The source tier that produced a square footage resolution */
export type ResolutionTier = 'text_extraction' | 'layout_diagram' | 'public_records' | 'manual_override';

/** Confidence level of a square footage resolution */
export type ResolutionConfidence = 'high' | 'medium' | 'low';

/** Supporting metadata for a square footage resolution result */
export interface ResolutionMetadata {
  /** Tier 1: the matched text segment from the customer request */
  matchedText?: string;
  /** Tier 2: which image was analyzed */
  imageId?: string;
  /** Tier 2: AI explanation of the estimate */
  aiReasoning?: string;
  /** Tier 3: property address used for the public records lookup */
  propertyAddress?: string;
  /** Tier 3: Cook County assessor record identifier */
  assessorRecordId?: string;
  /**
   * Tier 3: true when the address contained a sub-unit qualifier (APT, UNIT, REAR,
   * COACH HOUSE, GARDEN, etc.).
   * When unitCount > 1, buildingSqft is divided by unitCount (average unit size).
   * When unitCount is absent or 1, a heuristic divisor is applied:
   *   - structural qualifiers (REAR, COACH HOUSE, etc.) → ÷ 3
   *   - generic qualifiers (APT, UNIT, #, etc.) → ÷ 2
   * Exception: if the assessor record used hd_sf (unit-level field), no divisor is applied.
   */
  isSubUnit?: boolean;
  /**
   * Tier 3: number of apartment units from the assessor record.
   * When present and > 1, the sqft value is an average (total ÷ units).
   */
  unitCount?: number;
  /**
   * Tier 3: the full building/parcel sqft from the assessor record, before any
   * sub-unit divisor was applied. Only present when isSubUnit is true and a
   * divisor was applied (i.e. the displayed value is less than the total).
   * Use this to show "X sq ft (est. unit) · Y sq ft total property" in the UI.
   */
  totalPropertySqft?: number;
  /**
   * Tier 3: true when the sub-unit qualifier was a structural secondary unit
   * (coach house, carriage house, rear, front, garden, basement).
   * False/absent for generic qualifiers (APT, UNIT, #, etc.).
   */
  structuralQualifier?: boolean;
}

/** The result of a square footage resolution attempt */
export interface ResolutionResult {
  /** Whether a square footage value was successfully resolved */
  resolved: boolean;
  /** The resolved square footage value, or null if not resolved */
  value: number | null;
  /** The tier that produced the value, or null if not resolved */
  tier: ResolutionTier | null;
  /** Confidence level of the resolved value, or null if not resolved */
  confidence: ResolutionConfidence | null;
  /** Supporting metadata about how the value was determined */
  metadata: ResolutionMetadata;
}

/** Full sqft resolution state for a quote draft, including optional manual override */
export interface SqftResolutionResult {
  /** The active resolution result (may reflect a manual override) */
  resolution: ResolutionResult;
  /** The user-entered manual override value, or null if no override is active */
  manualOverride: number | null;
  /** The original automated resolution, preserved when a manual override is applied */
  originalResolution: ResolutionResult | null;
}

// ---------------------------------------------------------------------------
// Rules Engine Types
// ---------------------------------------------------------------------------

/** Scope constraint values for catalog products and rules */
export type Scope = 'any' | 'ceiling' | 'wall' | 'floor' | 'perimeter' | 'exterior' | 'plumbing' | 'electrical';

/** Trigger mode for structured rules */
export type TriggerMode = 'on_create' | 'chained';

/** Match mode for productNamePattern comparisons */
export type MatchMode = 'exact' | 'starts_with' | 'contains';

/** Condition types supported by the rules engine */
export type RuleConditionType =
  | 'line_item_exists'
  | 'line_item_not_exists'
  | 'line_item_name_contains'
  | 'line_item_quantity_gte'
  | 'line_item_quantity_lte'
  | 'request_text_contains'
  | 'request_text_not_contains'
  | 'request_text_extract'
  | 'compound'
  | 'always'
  | 'quote_total_gte';

/** A typed condition for a structured rule */
export type RuleCondition =
  | { type: 'line_item_exists'; productNamePattern: string; matchMode?: MatchMode }
  | { type: 'line_item_not_exists'; productNamePattern: string; matchMode?: MatchMode }
  | { type: 'line_item_name_contains'; substring: string }
  | { type: 'line_item_quantity_gte'; productNamePattern: string; threshold: number; matchMode?: MatchMode }
  | { type: 'line_item_quantity_lte'; productNamePattern: string; threshold: number; matchMode?: MatchMode }
  | { type: 'request_text_contains'; substring: string }
  | { type: 'request_text_not_contains'; substring: string }
  | { type: 'request_text_extract'; pattern: string; variableName: string; preset?: string }
  | { type: 'compound'; conditions: RuleCondition[] }
  | { type: 'always' }
  | { type: 'quote_total_gte'; threshold: number };

/** Action types supported by the rules engine */
export type RuleActionType =
  | 'add_line_item'
  | 'remove_line_item'
  | 'move_line_item'
  | 'set_quantity'
  | 'adjust_quantity'
  | 'set_unit_price'
  | 'set_description'
  | 'append_description'
  | 'extract_request_context'
  | 'set_customer_note'
  | 'append_customer_note'
  | 'compute_quantity'
  | 'set_deposit_schedule';

/** A typed action for a structured rule */
export type RuleAction =
  | { type: 'add_line_item'; productName: string; quantity: number; unitPrice: number; description?: string; placeAfter?: string; placeBefore?: string; scopeConstraint?: Scope | null }
  | { type: 'remove_line_item'; productNamePattern: string; matchMode?: MatchMode }
  | { type: 'move_line_item'; productNamePattern: string; position: 'start' | 'end' | `before:${string}` | `after:${string}`; matchMode?: MatchMode }
  | { type: 'set_quantity'; productNamePattern: string; quantity: number; matchMode?: MatchMode }
  | { type: 'adjust_quantity'; productNamePattern: string; delta: number; matchMode?: MatchMode }
  | { type: 'set_unit_price'; productNamePattern: string; unitPrice: number; matchMode?: MatchMode }
  | { type: 'set_description'; productNamePattern: string; description: string; matchMode?: MatchMode }
  | { type: 'append_description'; productNamePattern: string; text: string; separator?: string; matchMode?: MatchMode }
  | { type: 'extract_request_context'; productNamePattern: string; extractionPrompt: string; separator?: string; matchMode?: MatchMode }
  | { type: 'set_customer_note'; text: string }
  | { type: 'append_customer_note'; text: string; separator?: string }
  | { type: 'compute_quantity'; productNamePattern: string; formula: string; matchMode?: MatchMode }
  | { type: 'set_deposit_schedule'; schedule: DepositSchedule };

/** A structured rule with typed condition and actions */
export interface StructuredRule {
  id: string;
  name: string;
  priorityOrder: number;
  triggerMode: TriggerMode;
  condition: RuleCondition;
  actions: RuleAction[];
  /** Optional scope constraint — if set, rule only fires when detectedScopes contains this value */
  scopeConstraint?: Scope | null;
}

// ---------------------------------------------------------------------------
// Quantity Engine Types
// ---------------------------------------------------------------------------

/** Source of a line item's quantity value */
export type QuantitySource = 'ai_estimate' | 'historical_prediction' | 'rule_override';

/** Metadata about a quantity prediction applied to a line item */
export interface QuantityPredictionMeta {
  predictedQuantity: number;
  confidenceScore: number;
  sourceQuoteNumbers: string[];
  quantitySource: QuantitySource;
}

/** Line item representation used internally by the rules engine */
export interface EngineLineItem {
  id: string;
  productCatalogEntryId: string | null;
  productName: string;
  description: string;
  quantity: number;
  unitPrice: number;
  confidenceScore: number;
  originalText: string;
  ruleIdsApplied: string[];
  quantityPrediction?: QuantityPredictionMeta;
  /**
   * Per-item sqft override resolved from space extraction context.
   * When set, this value takes precedence over the whole-property sqft in
   * preResolvedContext for compute_quantity formula evaluation.
   */
  sqftOverride?: number;
}

/** Metadata about a computed quantity derivation */
export interface ComputedQuantityMeta {
  formula: string;
  variableValues: Record<string, number>;
  rawExtractedText: Record<string, string>;
  previousQuantity: number;
  computedQuantity: number;
}

/** An audit entry produced by the rules engine */
export interface AuditEntry {
  ruleId: string;
  ruleName: string;
  iteration: number;
  condition: RuleCondition;
  action: RuleAction;
  matchingLineItemIds: string[];
  beforeSnapshot: Array<{ id: string; productName: string; description?: string; quantity: number; unitPrice: number }>;
  afterSnapshot: Array<{ id: string; productName: string; description?: string; quantity: number; unitPrice: number }>;
  warning?: string;
  computedQuantityMeta?: ComputedQuantityMeta;
}

/** Result of evaluating a rule condition */
export interface ConditionResult {
  matched: boolean;
  matchingLineItemIds: string[];
  contextVariables?: Map<string, number>;
  rawExtractedText?: Map<string, string>;
}

/** Result of a rules engine execution */
export interface RulesEngineResult {
  lineItems: EngineLineItem[];
  auditTrail: AuditEntry[];
  iterationCount: number;
  converged: boolean;
  pendingEnrichments: PendingEnrichment[];
  customerNote: string | null;
  depositSchedule: DepositSchedule | null;
}

/** A pending AI enrichment for a line item description */
export interface PendingEnrichment {
  lineItemId: string;
  productNamePattern: string;
  extractionPrompt: string;
  separator?: string;
  ruleId: string;
  ruleName: string;
}

/** A business rule that influences quote generation */
export interface Rule {
  id: string;
  name: string;
  description: string;
  ruleGroupId: string;
  priorityOrder: number;
  isActive: boolean;
  conditionJson?: RuleCondition | null;
  actionJson?: RuleAction[] | null;
  triggerMode: TriggerMode;
  createdAt: Date;
  updatedAt: Date;
}

/** A named group for organizing related rules */
export interface RuleGroup {
  id: string;
  name: string;
  description: string | null;
  displayOrder: number;
  createdAt: Date;
}

/** A rule group with its nested rules */
export interface RuleGroupWithRules extends RuleGroup {
  rules: Rule[];
}

// ---------------------------------------------------------------------------
// Productivity Rates Types
// ---------------------------------------------------------------------------

/** A global productivity rate used in compute_quantity formulas */
export interface ProductivityRate {
  id: string;
  variableName: string;
  displayName: string;
  sqftPerHour: number;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Payload for updating a productivity rate */
export interface UpdateProductivityRatePayload {
  sqftPerHour: number;
  displayName?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Deathclock / Send Metrics Types
// ---------------------------------------------------------------------------

/** The type of quote send event */
export type SendType = 'first' | 'resend';

/** A record of a quote being sent to a customer, used for cycle-time analytics (Deathclock). */
export interface QuoteSendEvent {
  id: number;
  quoteId: string;
  requestId: string;
  /** ISO 8601 UTC timestamp of when the quote was sent */
  sentAt: string;
  /** Seconds elapsed between the original customer request and this send */
  elapsedSecondsFromRequest: number;
  /** Whether this was the first send or a resend */
  sendType: SendType;
}

/** The color buckets for the deathclock badge (server-side computed) */
export type DeathclockColor = 'green' | 'yellow' | 'orange' | 'red';

/** The computed visual state of a deathclock badge, returned by computeDeathclock(). */
export interface DeathclockState {
  /** Elapsed seconds from request creation (or frozen time if quote was sent). */
  ageSeconds: number;
  /** Human-readable label: e.g. "8h", "2.5d", "5d 12h", "99+ days" */
  ageLabel: string;
  /** Color bucket: green < 24h, yellow < 48h, orange < 72h, red >= 72h */
  color: DeathclockColor;
  /** True when the quote has been sent and the clock is frozen */
  isComplete: boolean;
  /** True when the badge should not animate / tick */
  frozen: boolean;
  /** Seconds from request creation to first draft creation (optional). */
  quoteCreationLagSeconds?: number;
  /** Seconds from first draft creation to quote sent (optional, only present for completed quotes). */
  sendLagSeconds?: number;
  /** Frozen request-to-quote seconds (same as ageSeconds when isComplete). */
  requestToQuoteSeconds?: number;
  /** Quote send events for re-send tracking. */
  sendEvents?: QuoteSendEvent[];
}
