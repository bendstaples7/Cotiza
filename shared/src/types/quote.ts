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
  | 'always';

/** A typed condition for a structured rule */
export type RuleCondition =
  | { type: 'line_item_exists'; productNamePattern: string; matchMode?: MatchMode }
  | { type: 'line_item_not_exists'; productNamePattern: string; matchMode?: MatchMode }
  | { type: 'line_item_name_contains'; substring: string }
  | { type: 'line_item_quantity_gte'; productNamePattern: string; threshold: number; matchMode?: MatchMode }
  | { type: 'line_item_quantity_lte'; productNamePattern: string; threshold: number; matchMode?: MatchMode }
  | { type: 'request_text_contains'; substring: string }
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
  | 'append_customer_note';

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
  | { type: 'append_customer_note'; text: string; separator?: string };

/** A structured rule with typed condition and actions */
export interface StructuredRule {
  id: string;
  name: string;
  priorityOrder: number;
  triggerMode: TriggerMode;
  condition: RuleCondition;
  actions: RuleAction[];
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
