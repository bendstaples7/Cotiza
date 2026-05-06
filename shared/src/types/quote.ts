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
  /** Resolved square footage result, including any manual override */
  sqftResolution?: SqftResolutionResult | null;
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
  | 'request_text_extract'
  | 'compound'
  | 'always';

/** A typed condition for a structured rule */
export type RuleCondition =
  | { type: 'line_item_exists'; productNamePattern: string; matchMode?: MatchMode }
  | { type: 'line_item_not_exists'; productNamePattern: string; matchMode?: MatchMode }
  | { type: 'line_item_name_contains'; substring: string }
  | { type: 'line_item_quantity_gte'; productNamePattern: string; threshold: number; matchMode?: MatchMode }
  | { type: 'line_item_quantity_lte'; productNamePattern: string; threshold: number; matchMode?: MatchMode }
  | { type: 'request_text_contains'; substring: string }
  | { type: 'request_text_extract'; pattern: string; variableName: string; preset?: string }
  | { type: 'compound'; conditions: RuleCondition[] }
  | { type: 'always' };

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
  | 'compute_quantity';

/** A typed action for a structured rule */
export type RuleAction =
  | { type: 'add_line_item'; productName: string; quantity: number; unitPrice: number; description?: string; placeAfter?: string; placeBefore?: string }
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
  | { type: 'compute_quantity'; productNamePattern: string; formula: string; matchMode?: MatchMode };

/** A structured rule with typed condition and actions */
export interface StructuredRule {
  id: string;
  name: string;
  priorityOrder: number;
  triggerMode: TriggerMode;
  condition: RuleCondition;
  actions: RuleAction[];
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
