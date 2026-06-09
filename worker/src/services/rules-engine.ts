import type {
  StructuredRule,
  RuleCondition,
  RuleAction,
  EngineLineItem,
  AuditEntry,
  RulesEngineResult,
  ProductCatalogEntry,
  PendingEnrichment,
  DepositSchedule,
} from 'shared';
import { evaluateFormula, validateFormula, FormulaError } from './formula-evaluator.js';

// ---------------------------------------------------------------------------
// Pattern matching helper
// ---------------------------------------------------------------------------

function matchesProductName(
  productName: string,
  pattern: string,
  matchMode: 'exact' | 'starts_with' | 'contains' = 'starts_with',
): boolean {
  const normalizedName = productName.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();
  switch (matchMode) {
    case 'exact':
      return normalizedName === normalizedPattern;
    case 'starts_with':
      return normalizedName.startsWith(normalizedPattern);
    case 'contains':
      return normalizedName.includes(normalizedPattern);
    default:
      return normalizedName.startsWith(normalizedPattern);
  }
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RulesEngineInput {
  lineItems: EngineLineItem[];
  rules: StructuredRule[];
  catalog: ProductCatalogEntry[];
  customerRequestText?: string;
  maxIterations?: number;
  /** Pre-populated context variables (e.g. resolved sqft) injected before rule evaluation */
  preResolvedContext?: Map<string, number>;
  /** Scopes detected from the customer request text (e.g. 'wall', 'ceiling', 'floor') */
  detectedScopes?: Set<string>;
}

// ---------------------------------------------------------------------------
// Internal result types
// ---------------------------------------------------------------------------

interface ConditionResult {
  matched: boolean;
  matchingLineItemIds: string[];
  contextVariables?: Map<string, number>;
  rawExtractedText?: Map<string, string>;
}

interface ActionResult {
  modified: boolean;
  lineItems: EngineLineItem[];
  warning?: string;
  beforeSnapshot?: Array<{ id: string; productName: string; description?: string; quantity: number; unitPrice: number }>;
  afterSnapshot?: Array<{ id: string; productName: string; description?: string; quantity: number; unitPrice: number }>;
  pendingEnrichment?: {
    productNamePattern: string;
    extractionPrompt: string;
    separator?: string;
    matchingLineItemIds: string[];
  };
  customerNoteValue?: string;
  depositScheduleValue?: DepositSchedule;
  computedQuantityMeta?: {
    formula: string;
    variableValues: Record<string, number>;
    rawExtractedText: Record<string, string>;
    previousQuantity: number;
    computedQuantity: number;
  };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const CONDITION_TYPES = new Set([
  'line_item_exists',
  'line_item_not_exists',
  'line_item_name_contains',
  'line_item_quantity_gte',
  'line_item_quantity_lte',
  'request_text_contains',
  'request_text_not_contains',
  'request_text_extract',
  'compound',
  'always',
  'quote_total_gte',
]);

const ACTION_TYPES = new Set([
  'add_line_item',
  'remove_line_item',
  'move_line_item',
  'set_quantity',
  'adjust_quantity',
  'set_unit_price',
  'set_description',
  'append_description',
  'extract_request_context',
  'set_customer_note',
  'append_customer_note',
  'compute_quantity',
  'set_deposit_schedule',
]);

export function validateCondition(condition: unknown): { valid: boolean; error?: string } {
  if (condition === null || condition === undefined || typeof condition !== 'object') {
    return { valid: false, error: 'Condition must be a non-null object' };
  }

  const cond = condition as Record<string, unknown>;

  if (typeof cond.type !== 'string') {
    return { valid: false, error: 'Condition must have a string "type" field' };
  }

  if (!CONDITION_TYPES.has(cond.type)) {
    return { valid: false, error: `Unknown condition type: "${cond.type}"` };
  }

  switch (cond.type) {
    case 'line_item_exists':
    case 'line_item_not_exists':
      if (typeof cond.productNamePattern !== 'string' || cond.productNamePattern.trim().length === 0) {
        return { valid: false, error: `Condition type "${cond.type}" requires a non-empty string "productNamePattern" field` };
      }
      if (cond.matchMode !== undefined) {
        if (cond.matchMode !== 'exact' && cond.matchMode !== 'starts_with' && cond.matchMode !== 'contains') {
          return { valid: false, error: 'matchMode must be "exact", "starts_with", or "contains"' };
        }
      }
      break;

    case 'line_item_name_contains':
      if (typeof cond.substring !== 'string') {
        return { valid: false, error: 'Condition type "line_item_name_contains" requires a string "substring" field' };
      }
      break;

    case 'request_text_contains':
      if (typeof cond.substring !== 'string') {
        return { valid: false, error: 'Condition type "request_text_contains" requires a string "substring" field' };
      }
      break;

    case 'request_text_not_contains':
      if (typeof cond.substring !== 'string') {
        return { valid: false, error: 'Condition type "request_text_not_contains" requires a string "substring" field' };
      }
      break;

    case 'line_item_quantity_gte':
    case 'line_item_quantity_lte':
      if (typeof cond.productNamePattern !== 'string' || cond.productNamePattern.trim().length === 0) {
        return { valid: false, error: `Condition type "${cond.type}" requires a non-empty string "productNamePattern" field` };
      }
      if (typeof cond.threshold !== 'number') {
        return { valid: false, error: `Condition type "${cond.type}" requires a number "threshold" field` };
      }
      if (!Number.isFinite(cond.threshold) || cond.threshold < 0) {
        return { valid: false, error: `Condition type "${cond.type}" threshold must be a finite non-negative number` };
      }
      if (cond.matchMode !== undefined) {
        if (cond.matchMode !== 'exact' && cond.matchMode !== 'starts_with' && cond.matchMode !== 'contains') {
          return { valid: false, error: 'matchMode must be "exact", "starts_with", or "contains"' };
        }
      }
      break;

    case 'quote_total_gte':
      if (typeof cond.threshold !== 'number') {
        return { valid: false, error: 'Condition type "quote_total_gte" requires a number "threshold" field' };
      }
      if (!Number.isFinite(cond.threshold) || cond.threshold < 0) {
        return { valid: false, error: 'Condition type "quote_total_gte" threshold must be a finite non-negative number' };
      }
      break;

    case 'always':
      // No additional fields required
      break;

    case 'request_text_extract': {
      if (typeof cond.pattern !== 'string' || cond.pattern.trim().length === 0) {
        return { valid: false, error: 'Condition type "request_text_extract" requires a non-empty string "pattern" field' };
      }
      if (typeof cond.variableName !== 'string' || cond.variableName.trim().length === 0) {
        return { valid: false, error: 'Condition type "request_text_extract" requires a non-empty string "variableName" field' };
      }
      // Validate regex is syntactically valid
      try {
        new RegExp(cond.pattern as string, 'i');
      } catch (e) {
        return { valid: false, error: `Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}` };
      }
      // Validate exactly one capture group
      {
        const pattern = cond.pattern as string;
        let captureGroupCount = 0;
        for (let i = 0; i < pattern.length; i++) {
          // Skip escaped characters
          if (pattern[i] === '\\') {
            i++;
            continue;
          }
          if (pattern[i] === '(') {
            // Check if this is a non-capturing or lookahead/lookbehind group
            // (?:...) — non-capturing
            // (?=...) — lookahead
            // (?!...) — negative lookahead
            // (?<=...) — lookbehind
            // (?<!...) — negative lookbehind
            // (?<name>...) — named capturing group (IS a capturing group, do NOT skip)
            if (i + 1 < pattern.length && pattern[i + 1] === '?') {
              const nextTwo = pattern.slice(i + 2, i + 4);
              // Non-capturing: (?:, (?=, (?!, (?<= (lookbehind), (?<! (neg lookbehind)
              // Named capture (?<name>) starts with (?< followed by a letter/underscore
              const isNonCapturing =
                nextTwo.startsWith(':') ||
                nextTwo.startsWith('=') ||
                nextTwo.startsWith('!') ||
                (nextTwo.startsWith('<') && (nextTwo[1] === '=' || nextTwo[1] === '!'));
              if (isNonCapturing) {
                continue;
              }
              // (?<name>...) is a named capturing group — fall through to count it
            }
            captureGroupCount++;
          }
        }
        if (captureGroupCount === 0) {
          return { valid: false, error: 'Extraction pattern must contain exactly one capture group' };
        }
        if (captureGroupCount > 1) {
          return { valid: false, error: `Extraction pattern must contain exactly one capture group, found ${captureGroupCount}` };
        }
      }
      break;
    }

    case 'compound': {
      if (!Array.isArray(cond.conditions) || cond.conditions.length === 0) {
        return { valid: false, error: 'Compound condition must contain at least one sub-condition' };
      }
      // Validate each sub-condition recursively, reject nested compounds
      for (let i = 0; i < (cond.conditions as unknown[]).length; i++) {
        const subCond = (cond.conditions as Record<string, unknown>[])[i];
        if (subCond && typeof subCond === 'object' && (subCond as Record<string, unknown>).type === 'compound') {
          return { valid: false, error: 'Compound conditions cannot be nested (max depth: 1)' };
        }
        const subResult = validateCondition(subCond);
        if (!subResult.valid) {
          return { valid: false, error: `Compound sub-condition[${i}]: ${subResult.error}` };
        }
      }
      break;
    }
  }

  return { valid: true };
}

export function validateAction(action: unknown): { valid: boolean; error?: string } {
  if (action === null || action === undefined || typeof action !== 'object') {
    return { valid: false, error: 'Action must be a non-null object' };
  }

  const act = action as Record<string, unknown>;

  if (typeof act.type !== 'string') {
    return { valid: false, error: 'Action must have a string "type" field' };
  }

  if (!ACTION_TYPES.has(act.type)) {
    return { valid: false, error: `Unknown action type: "${act.type}"` };
  }

  switch (act.type) {
    case 'add_line_item':
      if (typeof act.productName !== 'string') {
        return { valid: false, error: 'Action type "add_line_item" requires a string "productName" field' };
      }
      if (typeof act.quantity !== 'number') {
        return { valid: false, error: 'Action type "add_line_item" requires a number "quantity" field' };
      }
      if (!Number.isFinite(act.quantity) || act.quantity < 0) {
        return { valid: false, error: 'Action type "add_line_item" quantity must be a finite non-negative number' };
      }
      if (typeof act.unitPrice !== 'number') {
        return { valid: false, error: 'Action type "add_line_item" requires a number "unitPrice" field' };
      }
      if (!Number.isFinite(act.unitPrice) || act.unitPrice < 0) {
        return { valid: false, error: 'Action type "add_line_item" unitPrice must be a finite non-negative number' };
      }
      if (act.description !== undefined && typeof act.description !== 'string') {
        return { valid: false, error: 'Action type "add_line_item" optional "description" must be a string' };
      }
      if (act.placeAfter !== undefined && typeof act.placeAfter !== 'string') {
        return { valid: false, error: 'Action type "add_line_item" optional "placeAfter" must be a string' };
      }
      if (act.placeBefore !== undefined && typeof act.placeBefore !== 'string') {
        return { valid: false, error: 'Action type "add_line_item" optional "placeBefore" must be a string' };
      }
      if (act.scopeConstraint !== undefined && act.scopeConstraint !== null && typeof act.scopeConstraint !== 'string') {
        return { valid: false, error: 'Action type "add_line_item" optional "scopeConstraint" must be a string or null' };
      }
      break;

    case 'remove_line_item':
      if (typeof act.productNamePattern !== 'string' || act.productNamePattern.trim().length === 0) {
        return { valid: false, error: 'Action type "remove_line_item" requires a non-empty string "productNamePattern" field' };
      }
      if (act.matchMode !== undefined) {
        if (act.matchMode !== 'exact' && act.matchMode !== 'starts_with' && act.matchMode !== 'contains') {
          return { valid: false, error: 'matchMode must be "exact", "starts_with", or "contains"' };
        }
      }
      break;

    case 'move_line_item':
      if (typeof act.productNamePattern !== 'string' || act.productNamePattern.trim().length === 0) {
        return { valid: false, error: 'Action type "move_line_item" requires a non-empty string "productNamePattern" field' };
      }
      if (typeof act.position !== 'string') {
        return { valid: false, error: 'Action type "move_line_item" requires a string "position" field ("start", "end", "before:ProductName", or "after:ProductName")' };
      }
      {
        const normalizedPos = act.position.toLowerCase();
        if (normalizedPos !== 'start' && normalizedPos !== 'end' && !normalizedPos.startsWith('before:') && !normalizedPos.startsWith('after:')) {
          return { valid: false, error: `Action type "move_line_item" position must be "start", "end", "before:ProductName", or "after:ProductName" — got "${act.position}"` };
        }
        if (normalizedPos.startsWith('before:') || normalizedPos.startsWith('after:')) {
          const target = act.position.slice(act.position.indexOf(':') + 1).trim();
          if (!target) {
            return { valid: false, error: `Action type "move_line_item" position "${act.position}" has an empty target — provide a product name after the colon` };
          }
        }
      }
      if (act.matchMode !== undefined) {
        if (act.matchMode !== 'exact' && act.matchMode !== 'starts_with' && act.matchMode !== 'contains') {
          return { valid: false, error: 'matchMode must be "exact", "starts_with", or "contains"' };
        }
      }
      break;

    case 'set_quantity':
      if (typeof act.productNamePattern !== 'string' || act.productNamePattern.trim().length === 0) {
        return { valid: false, error: 'Action type "set_quantity" requires a non-empty string "productNamePattern" field' };
      }
      if (typeof act.quantity !== 'number') {
        return { valid: false, error: 'Action type "set_quantity" requires a number "quantity" field' };
      }
      if (!Number.isFinite(act.quantity) || act.quantity < 0) {
        return { valid: false, error: 'Action type "set_quantity" quantity must be a finite non-negative number' };
      }
      if (act.matchMode !== undefined) {
        if (act.matchMode !== 'exact' && act.matchMode !== 'starts_with' && act.matchMode !== 'contains') {
          return { valid: false, error: 'matchMode must be "exact", "starts_with", or "contains"' };
        }
      }
      break;

    case 'adjust_quantity':
      if (typeof act.productNamePattern !== 'string' || act.productNamePattern.trim().length === 0) {
        return { valid: false, error: 'Action type "adjust_quantity" requires a non-empty string "productNamePattern" field' };
      }
      if (typeof act.delta !== 'number') {
        return { valid: false, error: 'Action type "adjust_quantity" requires a number "delta" field' };
      }
      if (!Number.isFinite(act.delta)) {
        return { valid: false, error: 'Action type "adjust_quantity" delta must be a finite number' };
      }
      if (act.matchMode !== undefined) {
        if (act.matchMode !== 'exact' && act.matchMode !== 'starts_with' && act.matchMode !== 'contains') {
          return { valid: false, error: 'matchMode must be "exact", "starts_with", or "contains"' };
        }
      }
      break;

    case 'set_unit_price':
      if (typeof act.productNamePattern !== 'string' || act.productNamePattern.trim().length === 0) {
        return { valid: false, error: 'Action type "set_unit_price" requires a non-empty string "productNamePattern" field' };
      }
      if (typeof act.unitPrice !== 'number') {
        return { valid: false, error: 'Action type "set_unit_price" requires a number "unitPrice" field' };
      }
      if (!Number.isFinite(act.unitPrice) || act.unitPrice < 0) {
        return { valid: false, error: 'Action type "set_unit_price" unitPrice must be a finite non-negative number' };
      }
      if (act.matchMode !== undefined) {
        if (act.matchMode !== 'exact' && act.matchMode !== 'starts_with' && act.matchMode !== 'contains') {
          return { valid: false, error: 'matchMode must be "exact", "starts_with", or "contains"' };
        }
      }
      break;

    case 'set_description':
      if (typeof act.productNamePattern !== 'string' || act.productNamePattern.trim().length === 0) {
        return { valid: false, error: 'Action type "set_description" requires a non-empty string "productNamePattern" field' };
      }
      if (typeof act.description !== 'string') {
        return { valid: false, error: 'Action type "set_description" requires a string "description" field' };
      }
      if (act.matchMode !== undefined) {
        if (act.matchMode !== 'exact' && act.matchMode !== 'starts_with' && act.matchMode !== 'contains') {
          return { valid: false, error: 'matchMode must be "exact", "starts_with", or "contains"' };
        }
      }
      break;

    case 'append_description':
      if (typeof act.productNamePattern !== 'string' || act.productNamePattern.trim().length === 0) {
        return { valid: false, error: 'Action type "append_description" requires a non-empty string "productNamePattern" field' };
      }
      if (typeof act.text !== 'string' || act.text.trim().length === 0) {
        return { valid: false, error: 'Action type "append_description" requires a non-empty string "text" field' };
      }
      if (act.separator !== undefined && typeof act.separator !== 'string') {
        return { valid: false, error: 'Action type "append_description" optional "separator" must be a string' };
      }
      if (act.matchMode !== undefined) {
        if (act.matchMode !== 'exact' && act.matchMode !== 'starts_with' && act.matchMode !== 'contains') {
          return { valid: false, error: 'matchMode must be "exact", "starts_with", or "contains"' };
        }
      }
      break;

    case 'extract_request_context':
      if (typeof act.productNamePattern !== 'string' || act.productNamePattern.trim().length === 0) {
        return { valid: false, error: 'Action type "extract_request_context" requires a non-empty string "productNamePattern" field' };
      }
      if (typeof act.extractionPrompt !== 'string') {
        return { valid: false, error: 'Action type "extract_request_context" requires a string "extractionPrompt" field' };
      }
      if (act.separator !== undefined && typeof act.separator !== 'string') {
        return { valid: false, error: 'Action type "extract_request_context" optional "separator" must be a string' };
      }
      if (act.matchMode !== undefined) {
        if (act.matchMode !== 'exact' && act.matchMode !== 'starts_with' && act.matchMode !== 'contains') {
          return { valid: false, error: 'matchMode must be "exact", "starts_with", or "contains"' };
        }
      }
      break;

    case 'set_customer_note':
      if (typeof act.text !== 'string' || act.text.trim() === '') {
        return { valid: false, error: 'set_customer_note requires a non-empty string "text" field' };
      }
      break;

    case 'append_customer_note':
      if (typeof act.text !== 'string' || act.text.trim() === '') {
        return { valid: false, error: 'append_customer_note requires a non-empty string "text" field' };
      }
      if (act.separator !== undefined && typeof act.separator !== 'string') {
        return { valid: false, error: 'append_customer_note "separator" must be a string if provided' };
      }
      break;

    case 'compute_quantity':
      if (typeof act.productNamePattern !== 'string' || act.productNamePattern.trim().length === 0) {
        return { valid: false, error: 'Action type "compute_quantity" requires a non-empty string "productNamePattern" field' };
      }
      if (typeof act.formula !== 'string' || act.formula.trim().length === 0) {
        return { valid: false, error: 'Action type "compute_quantity" requires a non-empty string "formula" field' };
      }
      {
        const formulaValidation = validateFormula(act.formula as string);
        if (!formulaValidation.valid) {
          return { valid: false, error: `Invalid formula syntax: ${formulaValidation.error}` };
        }
      }
      if (act.matchMode !== undefined) {
        if (act.matchMode !== 'exact' && act.matchMode !== 'starts_with' && act.matchMode !== 'contains') {
          return { valid: false, error: 'matchMode must be "exact", "starts_with", or "contains"' };
        }
      }
      break;

    case 'set_deposit_schedule': {
      // Validate schedule is a non-null object
      if (act.schedule === null || act.schedule === undefined || typeof act.schedule !== 'object') {
        return { valid: false, error: 'Action type "set_deposit_schedule" requires a non-null object "schedule" field' };
      }
      const schedule = act.schedule as Record<string, unknown>;

      // Validate schedule.label is a non-empty string of 1–100 characters
      if (typeof schedule.label !== 'string' || schedule.label.trim().length === 0) {
        return { valid: false, error: 'set_deposit_schedule "schedule.label" must be a non-empty string' };
      }
      if (schedule.label.length > 100) {
        return { valid: false, error: 'set_deposit_schedule "schedule.label" must be 100 characters or fewer' };
      }

      // Validate schedule.milestones is an array of 1–10 entries
      if (!Array.isArray(schedule.milestones)) {
        return { valid: false, error: 'set_deposit_schedule "schedule.milestones" must be an array' };
      }
      if (schedule.milestones.length === 0) {
        return { valid: false, error: 'set_deposit_schedule "schedule.milestones" must contain at least one entry' };
      }
      if (schedule.milestones.length > 10) {
        return { valid: false, error: 'set_deposit_schedule "schedule.milestones" must contain 10 or fewer entries' };
      }

      // Validate each milestone
      let percentageSum = 0;
      for (let i = 0; i < schedule.milestones.length; i++) {
        const rawMilestone = schedule.milestones[i];

        // Guard: each milestone entry must be a non-null object
        if (rawMilestone === null || rawMilestone === undefined || typeof rawMilestone !== 'object') {
          return { valid: false, error: `set_deposit_schedule milestone[${i}] must be a non-null object` };
        }

        const milestone = rawMilestone as Record<string, unknown>;

        // Validate percentage is a whole integer between 1 and 100
        if (typeof milestone.percentage !== 'number' || !Number.isFinite(milestone.percentage)) {
          return { valid: false, error: `set_deposit_schedule milestone[${i}].percentage must be a number` };
        }
        if (!Number.isInteger(milestone.percentage)) {
          return { valid: false, error: `set_deposit_schedule milestone[${i}].percentage must be a whole integer` };
        }
        if (milestone.percentage < 1 || milestone.percentage > 100) {
          return { valid: false, error: `set_deposit_schedule milestone[${i}].percentage must be between 1 and 100` };
        }

        // Validate description is a non-empty string with max 255 characters
        if (typeof milestone.description !== 'string' || milestone.description.trim().length === 0) {
          return { valid: false, error: `set_deposit_schedule milestone[${i}].description must be a non-empty string with max length 255` };
        }
        if (milestone.description.trim().length > 255) {
          return { valid: false, error: `set_deposit_schedule milestone[${i}].description must be a non-empty string with max length 255` };
        }

        percentageSum += milestone.percentage as number;
      }

      // Validate that the sum of all percentage values equals exactly 100
      if (percentageSum !== 100) {
        return { valid: false, error: `set_deposit_schedule milestone percentages must sum to 100, got ${percentageSum}` };
      }

      break;
    }
  }

  return { valid: true };
}

export function validateActions(actions: unknown): { valid: boolean; errors?: string[] } {
  if (!Array.isArray(actions)) {
    return { valid: false, errors: ['Actions must be an array'] };
  }

  if (actions.length === 0) {
    return { valid: false, errors: ['Actions array must not be empty'] };
  }

  const errors: string[] = [];
  for (let i = 0; i < actions.length; i++) {
    const result = validateAction(actions[i]);
    if (!result.valid) {
      errors.push(`Action[${i}]: ${result.error}`);
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// Condition evaluator
// ---------------------------------------------------------------------------

export function evaluateCondition(
  condition: RuleCondition,
  lineItems: EngineLineItem[],
  customerRequestText?: string,
  preResolvedContext?: Map<string, number>,
  effectiveSqftOverride?: number,
): ConditionResult {
  switch (condition.type) {
    case 'line_item_exists': {
      const matching = lineItems.filter(
        (li) => matchesProductName(li.productName, condition.productNamePattern, condition.matchMode),
      );
      return {
        matched: matching.length > 0,
        matchingLineItemIds: matching.map((li) => li.id),
      };
    }

    case 'line_item_not_exists': {
      const anyMatch = lineItems.some(
        (li) => matchesProductName(li.productName, condition.productNamePattern, condition.matchMode),
      );
      // When no item matches the pattern, the condition is satisfied.
      // There are no specific "matching" line items to return.
      return { matched: !anyMatch, matchingLineItemIds: [] };
    }

    case 'line_item_name_contains': {
      const sub = condition.substring.toLowerCase();
      const matching = lineItems.filter(
        (li) => li.productName.toLowerCase().includes(sub),
      );
      return {
        matched: matching.length > 0,
        matchingLineItemIds: matching.map((li) => li.id),
      };
    }

    case 'line_item_quantity_gte': {
      const matching = lineItems.filter(
        (li) =>
          matchesProductName(li.productName, condition.productNamePattern, condition.matchMode) &&
          li.quantity >= condition.threshold,
      );
      return {
        matched: matching.length > 0,
        matchingLineItemIds: matching.map((li) => li.id),
      };
    }

    case 'line_item_quantity_lte': {
      const matching = lineItems.filter(
        (li) =>
          matchesProductName(li.productName, condition.productNamePattern, condition.matchMode) &&
          li.quantity <= condition.threshold,
      );
      return {
        matched: matching.length > 0,
        matchingLineItemIds: matching.map((li) => li.id),
      };
    }

    case 'request_text_contains': {
      const sub = condition.substring.toLowerCase();
      const text = (customerRequestText ?? '').toLowerCase();
      const matched = text.includes(sub);
      // This condition is about the request text, not specific line items.
      // Return all line item IDs so actions can target any of them.
      return {
        matched,
        matchingLineItemIds: matched ? lineItems.map((li) => li.id) : [],
      };
    }

    case 'request_text_not_contains': {
      const sub = condition.substring.toLowerCase();
      const text = (customerRequestText ?? '').toLowerCase();
      const matched = !text.includes(sub);
      return {
        matched,
        matchingLineItemIds: matched ? lineItems.map((li) => li.id) : [],
      };
    }

    case 'request_text_extract': {
      // Resolution hierarchy for sqft (and any variable):
      //   1. effectiveSqftOverride — per-item space-specific sqft (highest priority)
      //   2. preResolvedContext — whole-property sqft from tiered resolution pipeline
      //   3. regex extraction from customer text (fallback)
      if (condition.variableName === 'sqft' && effectiveSqftOverride !== undefined) {
        const contextVariables = new Map<string, number>([[condition.variableName, effectiveSqftOverride]]);
        const rawExtractedText = new Map<string, string>([[condition.variableName, String(effectiveSqftOverride)]]);
        return {
          matched: true,
          matchingLineItemIds: lineItems.map((li) => li.id),
          contextVariables,
          rawExtractedText,
        };
      }

      // If the variable is already pre-resolved, skip extraction and use the pre-resolved value
      if (preResolvedContext?.has(condition.variableName)) {
        const preResolvedValue = preResolvedContext.get(condition.variableName)!;
        const contextVariables = new Map<string, number>([[condition.variableName, preResolvedValue]]);
        const rawExtractedText = new Map<string, string>([[condition.variableName, String(preResolvedValue)]]);
        return {
          matched: true,
          matchingLineItemIds: lineItems.map((li) => li.id),
          contextVariables,
          rawExtractedText,
        };
      }

      const text = customerRequestText ?? '';
      let regex: RegExp;
      try {
        regex = new RegExp(condition.pattern, 'i');
      } catch {
        // Invalid regex at runtime — treat as non-match
        return { matched: false, matchingLineItemIds: [], contextVariables: new Map(), rawExtractedText: new Map() };
      }

      const match = regex.exec(text);
      if (!match || match[1] === undefined) {
        return { matched: false, matchingLineItemIds: [], contextVariables: new Map(), rawExtractedText: new Map() };
      }

      const rawValue = match[1];
      // Strip commas and parse as number
      const numericValue = parseFloat(rawValue.replace(/,/g, ''));

      const contextVariables = new Map<string, number>();
      const rawExtractedText = new Map<string, string>();

      if (!isNaN(numericValue)) {
        contextVariables.set(condition.variableName, numericValue);
      }
      rawExtractedText.set(condition.variableName, rawValue);

      return {
        matched: true,
        matchingLineItemIds: lineItems.map((li) => li.id),
        contextVariables,
        rawExtractedText,
      };
    }

    case 'compound': {
      const aggregatedVariables = new Map<string, number>();
      const aggregatedRawText = new Map<string, string>();
      // Track line-item-targeting condition IDs for intersection
      let lineItemIds: string[] | null = null;

      for (const subCondition of condition.conditions) {
        const subResult = evaluateCondition(subCondition, lineItems, customerRequestText, preResolvedContext, effectiveSqftOverride);

        // Short-circuit: if any sub-condition doesn't match, compound fails
        if (!subResult.matched) {
          return { matched: false, matchingLineItemIds: [], contextVariables: new Map(), rawExtractedText: new Map() };
        }

        // Aggregate context variables
        if (subResult.contextVariables) {
          for (const [key, value] of subResult.contextVariables) {
            aggregatedVariables.set(key, value);
          }
        }

        // Aggregate raw extracted text
        if (subResult.rawExtractedText) {
          for (const [key, value] of subResult.rawExtractedText) {
            aggregatedRawText.set(key, value);
          }
        }

        // Intersect matchingLineItemIds from line-item-targeting conditions
        // Text-only conditions (request_text_contains, request_text_not_contains, request_text_extract, always)
        // return all line item IDs — don't use those for intersection
        const isLineItemTargeting = subCondition.type !== 'request_text_contains'
          && subCondition.type !== 'request_text_not_contains'
          && subCondition.type !== 'request_text_extract'
          && subCondition.type !== 'always';

        if (isLineItemTargeting && subResult.matchingLineItemIds.length > 0) {
          if (lineItemIds === null) {
            lineItemIds = [...subResult.matchingLineItemIds];
          } else {
            const subSet = new Set(subResult.matchingLineItemIds);
            lineItemIds = lineItemIds.filter((id) => subSet.has(id));
          }
        }
      }

      // If no line-item-targeting conditions, return all line item IDs
      const finalIds = lineItemIds ?? lineItems.map((li) => li.id);

      return {
        matched: true,
        matchingLineItemIds: finalIds,
        contextVariables: aggregatedVariables,
        rawExtractedText: aggregatedRawText,
      };
    }

    case 'quote_total_gte': {
      const total = lineItems.reduce((sum, li) => sum + li.quantity * li.unitPrice, 0);
      const matched = total >= condition.threshold;
      return {
        matched,
        matchingLineItemIds: matched ? lineItems.map((li) => li.id) : [],
      };
    }

    case 'always':
      return { matched: true, matchingLineItemIds: lineItems.map((li) => li.id) };

    default:
      return { matched: false, matchingLineItemIds: [] };
  }
}

// ---------------------------------------------------------------------------
// Action executor
// ---------------------------------------------------------------------------

function snapshot(
  items: EngineLineItem[],
): Array<{ id: string; productName: string; description?: string; quantity: number; unitPrice: number }> {
  return items.map((li) => ({
    id: li.id,
    productName: li.productName,
    description: li.description,
    quantity: li.quantity,
    unitPrice: li.unitPrice,
  }));
}

function generateId(): string {
  return `engine-${crypto.randomUUID()}`;
}

export function executeAction(
  action: RuleAction,
  lineItems: EngineLineItem[],
  catalog: ProductCatalogEntry[],
  ruleId: string,
  customerNote: string | null,
  contextVariables?: Map<string, number>,
  rawExtractedText?: Map<string, string>,
  depositSchedule?: DepositSchedule | null,
  effectiveSqftOverride?: number,
  detectedScopes?: Set<string>,
): ActionResult {
  switch (action.type) {
    case 'add_line_item': {
      const catalogEntry = catalog.find(
        (c) => c.name.toLowerCase() === action.productName.toLowerCase(),
      );

      if (!catalogEntry) {
        return {
          modified: false,
          lineItems,
          warning: `Product "${action.productName}" not found in catalog — skipping add_line_item`,
        };
      }

      // Per-action scope constraint: skip this specific add_line_item if the action
      // has a scopeConstraint that doesn't match the detected scopes.
      // This allows a single rule to add some items unconditionally and others only
      // when a specific scope is present (e.g., painting always, baseboard only for walls).
      if (action.scopeConstraint && detectedScopes && detectedScopes.size > 0) {
        if (!detectedScopes.has(action.scopeConstraint)) {
          return {
            modified: false,
            lineItems,
            warning: `Skipping add_line_item "${action.productName}": scope constraint "${action.scopeConstraint}" not in detected scopes`,
          };
        }
      }

      // Duplicate guard: if an item with this product name already exists, skip the add.
      // This prevents rules from creating duplicates that dedup would resolve incorrectly.
      const alreadyExists = lineItems.some(
        (li) => li.productName.toLowerCase() === catalogEntry.name.toLowerCase(),
      );
      if (alreadyExists) {
        return {
          modified: false,
          lineItems,
          warning: `Product "${catalogEntry.name}" already exists on the quote — skipping add_line_item`,
        };
      }

      const newItem: EngineLineItem = {
        id: generateId(),
        productCatalogEntryId: catalogEntry.id,
        productName: catalogEntry.name,
        description: action.description ?? catalogEntry.description,
        quantity: action.quantity,
        unitPrice: action.unitPrice,
        confidenceScore: 100,
        originalText: '',
        ruleIdsApplied: [ruleId],
        // Inherit the space-specific sqft from the triggering context so that
        // compute_quantity rules on this new item use the correct per-space sqft.
        sqftOverride: effectiveSqftOverride,
      };

      let updated: EngineLineItem[];
      if (action.placeBefore) {
        // Insert the new item right before the specified product
        const beforePattern = action.placeBefore.toLowerCase();
        const beforeIndex = lineItems.findIndex(
          (li) => li.productName.toLowerCase() === beforePattern,
        );
        if (beforeIndex >= 0) {
          updated = [
            ...lineItems.slice(0, beforeIndex),
            newItem,
            ...lineItems.slice(beforeIndex),
          ];
        } else {
          // placeBefore target not found — prepend to beginning
          updated = [newItem, ...lineItems];
        }
      } else if (action.placeAfter) {
        // Insert the new item right after the specified product
        const afterPattern = action.placeAfter.toLowerCase();
        const afterIndex = lineItems.findLastIndex(
          (li) => li.productName.toLowerCase() === afterPattern,
        );
        if (afterIndex >= 0) {
          updated = [
            ...lineItems.slice(0, afterIndex + 1),
            newItem,
            ...lineItems.slice(afterIndex + 1),
          ];
        } else {
          // placeAfter target not found — append to end
          updated = [...lineItems, newItem];
        }
      } else {
        updated = [...lineItems, newItem];
      }

      return {
        modified: true,
        lineItems: updated,
        beforeSnapshot: [], // no existing items affected by an add
        afterSnapshot: snapshot([newItem]),
      };
    }

    case 'remove_line_item': {
      const toRemove = lineItems.filter(
        (li) => matchesProductName(li.productName, action.productNamePattern, action.matchMode),
      );

      if (toRemove.length === 0) {
        return { modified: false, lineItems };
      }

      const before = snapshot(toRemove);
      const updated = lineItems.filter(
        (li) => !matchesProductName(li.productName, action.productNamePattern, action.matchMode),
      );
      return {
        modified: true,
        lineItems: updated,
        beforeSnapshot: before,
        afterSnapshot: [],
      };
    }

    case 'move_line_item': {
      const toMove = lineItems.filter(
        (li) => matchesProductName(li.productName, action.productNamePattern, action.matchMode),
      );

      if (toMove.length === 0) {
        return { modified: false, lineItems, warning: `Product "${action.productNamePattern}" not found on quote — skipping move_line_item` };
      }

      const before = snapshot(toMove);
      // Remove the items from their current position
      const remaining = lineItems.filter(
        (li) => !matchesProductName(li.productName, action.productNamePattern, action.matchMode),
      );

      // Mark items as rule-applied
      const movedItems = toMove.map((li) => ({
        ...li,
        ruleIdsApplied: [...li.ruleIdsApplied, ruleId],
      }));

      let updated: EngineLineItem[];
      const pos = action.position.toLowerCase();

      if (pos === 'start') {
        updated = [...movedItems, ...remaining];
      } else if (pos === 'end') {
        updated = [...remaining, ...movedItems];
      } else if (pos.startsWith('before:')) {
        const targetName = pos.slice('before:'.length).toLowerCase();
        const targetIndex = remaining.findIndex(
          (li) => li.productName.toLowerCase() === targetName,
        );
        if (targetIndex >= 0) {
          updated = [
            ...remaining.slice(0, targetIndex),
            ...movedItems,
            ...remaining.slice(targetIndex),
          ];
        } else {
          // Target not found — prepend
          updated = [...movedItems, ...remaining];
        }
      } else if (pos.startsWith('after:')) {
        const targetName = pos.slice('after:'.length).toLowerCase();
        const targetIndex = remaining.findLastIndex(
          (li) => li.productName.toLowerCase() === targetName,
        );
        if (targetIndex >= 0) {
          updated = [
            ...remaining.slice(0, targetIndex + 1),
            ...movedItems,
            ...remaining.slice(targetIndex + 1),
          ];
        } else {
          // Target not found — append
          updated = [...remaining, ...movedItems];
        }
      } else {
        // Unrecognized position — no-op
        return {
          modified: false,
          lineItems,
          warning: `Unrecognized position "${pos}" — expected "start", "end", "before:ProductName", or "after:ProductName"`,
        };
      }

      return {
        modified: true,
        lineItems: updated,
        beforeSnapshot: before,
        afterSnapshot: snapshot(movedItems),
      };
    }

    case 'set_quantity': {
      let modified = false;
      const affected: EngineLineItem[] = [];

      const updated = lineItems.map((li) => {
        if (matchesProductName(li.productName, action.productNamePattern, action.matchMode)) {
          affected.push(li);
          modified = true;
          return {
            ...li,
            quantity: action.quantity,
            ruleIdsApplied: [...li.ruleIdsApplied, ruleId],
          };
        }
        return li;
      });

      if (!modified) {
        return { modified: false, lineItems };
      }

      return {
        modified: true,
        lineItems: updated,
        beforeSnapshot: snapshot(affected),
        afterSnapshot: snapshot(
          updated.filter((li) => matchesProductName(li.productName, action.productNamePattern, action.matchMode)),
        ),
      };
    }

    case 'adjust_quantity': {
      let modified = false;
      const affected: EngineLineItem[] = [];

      const updated = lineItems.map((li) => {
        if (matchesProductName(li.productName, action.productNamePattern, action.matchMode)) {
          affected.push(li);
          modified = true;
          return {
            ...li,
            quantity: Math.max(0, li.quantity + action.delta),
            ruleIdsApplied: [...li.ruleIdsApplied, ruleId],
          };
        }
        return li;
      });

      if (!modified) {
        return { modified: false, lineItems };
      }

      return {
        modified: true,
        lineItems: updated,
        beforeSnapshot: snapshot(affected),
        afterSnapshot: snapshot(
          updated.filter((li) => matchesProductName(li.productName, action.productNamePattern, action.matchMode)),
        ),
      };
    }

    case 'set_unit_price': {
      let modified = false;
      const affected: EngineLineItem[] = [];

      const updated = lineItems.map((li) => {
        if (matchesProductName(li.productName, action.productNamePattern, action.matchMode)) {
          affected.push(li);
          modified = true;
          return {
            ...li,
            unitPrice: action.unitPrice,
            ruleIdsApplied: [...li.ruleIdsApplied, ruleId],
          };
        }
        return li;
      });

      if (!modified) {
        return { modified: false, lineItems };
      }

      return {
        modified: true,
        lineItems: updated,
        beforeSnapshot: snapshot(affected),
        afterSnapshot: snapshot(
          updated.filter((li) => matchesProductName(li.productName, action.productNamePattern, action.matchMode)),
        ),
      };
    }

    case 'set_description': {
      let modified = false;
      const affected: EngineLineItem[] = [];

      const updated = lineItems.map((li) => {
        if (matchesProductName(li.productName, action.productNamePattern, action.matchMode)) {
          affected.push(li);
          modified = true;
          return {
            ...li,
            description: action.description,
            ruleIdsApplied: [...li.ruleIdsApplied, ruleId],
          };
        }
        return li;
      });

      if (!modified) {
        return { modified: false, lineItems };
      }

      return {
        modified: true,
        lineItems: updated,
        beforeSnapshot: snapshot(affected),
        afterSnapshot: snapshot(
          updated.filter((li) => matchesProductName(li.productName, action.productNamePattern, action.matchMode)),
        ),
      };
    }

    case 'append_description': {
      const separator = action.separator ?? ' ';
      let modified = false;
      const affected: EngineLineItem[] = [];

      // Guard: skip if text is empty (shouldn't reach here after validation, but be safe)
      if (!action.text || !action.text.trim()) {
        return { modified: false, lineItems };
      }

      const updated = lineItems.map((li) => {
        if (matchesProductName(li.productName, action.productNamePattern, action.matchMode)) {
          affected.push(li);
          const existing = li.description.trim();
          if (existing.toLowerCase().includes(action.text.toLowerCase())) {
            return li;
          }
          modified = true;
          const newDesc = existing
            ? `${existing}${separator}${action.text}`
            : action.text;
          return {
            ...li,
            description: newDesc,
            ruleIdsApplied: [...li.ruleIdsApplied, ruleId],
          };
        }
        return li;
      });

      if (!modified) {
        return { modified: false, lineItems };
      }

      return {
        modified: true,
        lineItems: updated,
        beforeSnapshot: snapshot(affected),
        afterSnapshot: snapshot(
          updated.filter((li) => matchesProductName(li.productName, action.productNamePattern, action.matchMode)),
        ),
      };
    }

    case 'extract_request_context': {
      // This action is handled asynchronously after the engine completes.
      // We just record that it matched and return unmodified line items.
      // The caller collects these as pending enrichments.
      const matching = lineItems.filter(
        (li) => matchesProductName(li.productName, action.productNamePattern, action.matchMode),
      );

      if (matching.length === 0) {
        return { modified: false, lineItems };
      }

      // Mark as "modified" so the audit trail records it, but don't change line items
      return {
        modified: false,
        lineItems,
        beforeSnapshot: snapshot(matching),
        afterSnapshot: snapshot(matching),
        pendingEnrichment: {
          productNamePattern: action.productNamePattern,
          extractionPrompt: action.extractionPrompt,
          separator: action.separator,
          matchingLineItemIds: matching.map((li) => li.id),
        },
      };
    }

    case 'set_customer_note': {
      const previousValue = customerNote;
      const newValue = action.text;
      return {
        modified: true,
        lineItems,
        customerNoteValue: newValue,
        beforeSnapshot: [{ id: '__customer_note__', productName: 'Customer Note', description: previousValue ?? '', quantity: 0, unitPrice: 0 }],
        afterSnapshot: [{ id: '__customer_note__', productName: 'Customer Note', description: newValue, quantity: 0, unitPrice: 0 }],
      };
    }

    case 'append_customer_note': {
      const separator = action.separator ?? '\n';
      const previousValue = customerNote;
      const newValue = (!previousValue || previousValue === '')
        ? action.text
        : previousValue + separator + action.text;
      return {
        modified: true,
        lineItems,
        customerNoteValue: newValue,
        beforeSnapshot: [{ id: '__customer_note__', productName: 'Customer Note', description: previousValue ?? '', quantity: 0, unitPrice: 0 }],
        afterSnapshot: [{ id: '__customer_note__', productName: 'Customer Note', description: newValue, quantity: 0, unitPrice: 0 }],
      };
    }

    case 'set_deposit_schedule': {
      const previousSchedule = depositSchedule ?? null;
      const newSchedule = action.schedule;
      return {
        modified: true,
        lineItems,
        depositScheduleValue: newSchedule,
        beforeSnapshot: [{
          id: '__deposit_schedule__',
          productName: 'Deposit Schedule',
          description: previousSchedule !== null ? JSON.stringify(previousSchedule) : '',
          quantity: 0,
          unitPrice: 0,
        }],
        afterSnapshot: [{
          id: '__deposit_schedule__',
          productName: 'Deposit Schedule',
          description: JSON.stringify(newSchedule),
          quantity: 0,
          unitPrice: 0,
        }],
      };
    }

    case 'compute_quantity': {
      const sharedVars = contextVariables ?? new Map<string, number>();
      const rawText = rawExtractedText ?? new Map<string, string>();

      // Find matching line items
      const matching = lineItems.filter(
        (li) => matchesProductName(li.productName, action.productNamePattern, action.matchMode),
      );

      if (matching.length === 0) {
        return { modified: false, lineItems };
      }

      // Process each matching item individually so per-item sqftOverride takes
      // precedence over the shared whole-property sqft in preResolvedContext.
      // This is the core of Option 2: no grouping, no branching — each item
      // carries its own sqft context and the formula is evaluated once per item.
      const updatedLineItems = [...lineItems];
      let anyModifiedByCompute = false;
      const beforeSnapshots: Array<{ id: string; productName: string; description?: string; quantity: number; unitPrice: number }> = [];
      const afterSnapshots: Array<{ id: string; productName: string; description?: string; quantity: number; unitPrice: number }> = [];
      let lastComputedMeta: ActionResult['computedQuantityMeta'] | undefined;
      let lastWarning: string | undefined;

      for (let i = 0; i < updatedLineItems.length; i++) {
        const li = updatedLineItems[i];
        if (!matchesProductName(li.productName, action.productNamePattern, action.matchMode)) continue;

        // Check quantity_mode on the catalog entry for this product.
        // hourly-mode and fixed-mode items bypass sqft formula computation entirely.
        const catalogEntry = catalog.find(
          (c) => c.name.trim().toLowerCase() === li.productName.trim().toLowerCase(),
        );
        const qMode = catalogEntry?.quantityMode ?? null;

        if (qMode === 'fixed') {
          // Fixed items always stay at qty 1 — never recompute
          continue;
        }

        if (qMode === 'hourly') {
          // Hourly items use default_hours as the quantity when set.
          // QuantityEngine historical prediction already ran before the rules engine
          // (in QuoteEngine.generateQuote) and set li.quantity if confident.
          // If the item's quantity is still 1 (AI default) AND default_hours is set,
          // apply the default_hours as a sensible fallback.
          const defaultHours = catalogEntry?.defaultHours ?? null;
          if (defaultHours !== null && li.quantity === 1) {
            beforeSnapshots.push({ id: li.id, productName: li.productName, description: li.description, quantity: li.quantity, unitPrice: li.unitPrice });
            updatedLineItems[i] = {
              ...li,
              quantity: defaultHours,
              ruleIdsApplied: [...li.ruleIdsApplied, ruleId],
            };
            anyModifiedByCompute = true;
            afterSnapshots.push({ id: li.id, productName: li.productName, description: li.description, quantity: defaultHours, unitPrice: li.unitPrice });
            lastComputedMeta = {
              formula: `default_hours=${defaultHours}`,
              variableValues: { default_hours: defaultHours },
              rawExtractedText: {},
              previousQuantity: li.quantity,
              computedQuantity: defaultHours,
            };
          }
          // Otherwise leave the quantity as-is (historical prediction or AI estimate)
          continue;
        }

        // sqft mode (or null = default sqft): run the formula as before

        // Build per-item variable map: start from shared context, then inject
        // this item's sqftOverride if present (space-specific sqft wins).
        const itemVars = new Map<string, number>(sharedVars);
        if (li.sqftOverride !== undefined && li.sqftOverride !== null) {
          itemVars.set('sqft', li.sqftOverride);
        }

        beforeSnapshots.push({ id: li.id, productName: li.productName, description: li.description, quantity: li.quantity, unitPrice: li.unitPrice });

        let computedValue: number;
        try {
          computedValue = evaluateFormula(action.formula, itemVars);
        } catch (e) {
          if (e instanceof FormulaError && e.message.startsWith("Missing variable")) {
            lastWarning = `compute_quantity skipped: ${e.message}`;
          } else {
            lastWarning = `compute_quantity error: ${e instanceof Error ? e.message : String(e)}`;
          }
          afterSnapshots.push({ id: li.id, productName: li.productName, description: li.description, quantity: li.quantity, unitPrice: li.unitPrice });
          continue;
        }

        if (!Number.isFinite(computedValue)) {
          lastWarning = `compute_quantity error: Formula produced a non-finite result`;
          afterSnapshots.push({ id: li.id, productName: li.productName, description: li.description, quantity: li.quantity, unitPrice: li.unitPrice });
          continue;
        }

        let finalQuantity = Math.round(computedValue);
        const clamped = finalQuantity <= 0;
        if (clamped) {
          finalQuantity = 1;
          lastWarning = `compute_quantity: result ${computedValue} was ≤ 0, clamped to 1`;
        }

        updatedLineItems[i] = {
          ...li,
          quantity: finalQuantity,
          ruleIdsApplied: [...li.ruleIdsApplied, ruleId],
        };
        anyModifiedByCompute = true;

        afterSnapshots.push({ id: li.id, productName: li.productName, description: li.description, quantity: finalQuantity, unitPrice: li.unitPrice });

        // Build audit meta from this item (last one processed wins for the audit entry)
        const variableValues: Record<string, number> = {};
        for (const [key, value] of itemVars) {
          variableValues[key] = value;
        }
        const rawExtractedTextRecord: Record<string, string> = {};
        for (const [key, value] of rawText) {
          rawExtractedTextRecord[key] = value;
        }
        lastComputedMeta = {
          formula: action.formula,
          variableValues,
          rawExtractedText: rawExtractedTextRecord,
          previousQuantity: li.quantity,
          computedQuantity: finalQuantity,
        };
      }

      if (!anyModifiedByCompute) {
        return { modified: false, lineItems, warning: lastWarning };
      }

      return {
        modified: true,
        lineItems: updatedLineItems,
        beforeSnapshot: beforeSnapshots,
        afterSnapshot: afterSnapshots,
        warning: lastWarning,
        computedQuantityMeta: lastComputedMeta,
      };
    }

    default:
      return { modified: false, lineItems };
  }
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ITERATIONS = 10;

export function executeRules(input: RulesEngineInput): RulesEngineResult {
  const { rules, catalog, customerRequestText, maxIterations = DEFAULT_MAX_ITERATIONS, preResolvedContext, detectedScopes } = input;

  // Clone input line items to avoid mutation
  let lineItems: EngineLineItem[] = input.lineItems.map((li) => ({
    ...li,
    ruleIdsApplied: [...li.ruleIdsApplied],
  }));

  const auditTrail: AuditEntry[] = [];
  const pendingEnrichments: PendingEnrichment[] = [];
  let customerNote: string | null = null;
  let depositSchedule: DepositSchedule | null = null;
  let depositSchedulePriority: number = Infinity;

  // Early exit: no rules → return unmodified
  if (rules.length === 0) {
    return { lineItems, auditTrail, iterationCount: 0, converged: true, pendingEnrichments: [], customerNote: null, depositSchedule: null };
  }

  // Track which (ruleId, lineItemId) pairs have been applied to prevent
  // duplicate applications within a single execution run.
  const applied = new Set<string>();
  const emittedEnrichments = new Set<string>();

  let iterationCount = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    iterationCount = iteration;
    let anyModified = false;

    // Filter eligible rules by trigger mode
    const eligible = rules
      .filter((r) => {
        if (iteration === 1) return true; // first iteration: all rules
        return r.triggerMode === 'chained'; // subsequent: only chained
      })
      .sort((a, b) => a.priorityOrder - b.priorityOrder);

    for (const rule of eligible) {
      // Skip rule if it has a scope constraint that doesn't match detected scopes
      if (rule.scopeConstraint && detectedScopes && detectedScopes.size > 0) {
        if (!detectedScopes.has(rule.scopeConstraint)) {
          continue;
        }
      }

      // Validate condition at runtime — skip invalid rules
      const condValid = validateCondition(rule.condition);
      if (!condValid.valid) {
        auditTrail.push({
          ruleId: rule.id,
          ruleName: rule.name,
          iteration,
          condition: rule.condition,
          action: rule.actions[0],
          matchingLineItemIds: [],
          beforeSnapshot: [],
          afterSnapshot: [],
          warning: `Skipping rule: invalid condition — ${condValid.error}`,
        });
        continue;
      }

      // Validate actions at runtime — skip invalid rules
      const actionsValid = validateActions(rule.actions);
      if (!actionsValid.valid) {
        auditTrail.push({
          ruleId: rule.id,
          ruleName: rule.name,
          iteration,
          condition: rule.condition,
          action: rule.actions[0],
          matchingLineItemIds: [],
          beforeSnapshot: [],
          afterSnapshot: [],
          warning: `Skipping rule: invalid actions — ${actionsValid.errors?.join('; ')}`,
        });
        continue;
      }

      // Evaluate condition without a single sqftOverride — compute_quantity already
      // handles per-item sqft correctly via li.sqftOverride in the action executor.
      // Passing a single override here would use the wrong space's sqft for rules
      // that match items from multiple spaces.
      const condResultWithSqft = evaluateCondition(
        rule.condition, lineItems, customerRequestText, preResolvedContext,
      );
      if (!condResultWithSqft.matched) continue;

      // For add_line_item inheritance: derive sqftOverride from the matching items
      // so newly added items inherit the correct space's sqft.
      const matchingItemsForInheritance = condResultWithSqft.matchingLineItemIds
        .map((mid) => lineItems.find((li) => li.id === mid))
        .filter((li): li is EngineLineItem => li !== undefined);
      const effectiveSqftOverride = matchingItemsForInheritance.find(
        (li) => li.sqftOverride !== undefined,
      )?.sqftOverride;
      // Capture context variables scoped to this rule only.
      // Merge preResolvedContext as a baseline so compute_quantity formulas can
      // reference pre-resolved variables (e.g. sqft) even when no condition
      // extracted them. Rule-scoped extracted values take precedence.
      const ruleContextVariables = new Map<string, number>(preResolvedContext ?? []);
      if (condResultWithSqft.contextVariables) {
        for (const [key, value] of condResultWithSqft.contextVariables) {
          ruleContextVariables.set(key, value);
        }
      }
      const ruleRawExtractedText = condResultWithSqft.rawExtractedText;

      // Check duplicate application: skip if this rule has already been
      // applied to all of the matching line items in this execution run.
      const matchingIds = condResultWithSqft.matchingLineItemIds;
      const allAlreadyApplied = matchingIds.length > 0
        ? matchingIds.every((id) => applied.has(`${rule.id}:${id}`))
        : applied.has(`${rule.id}:__global__`);
      if (allAlreadyApplied) continue;

      // Execute each action
      for (const action of rule.actions) {
        const actionResult = executeAction(action, lineItems, catalog, rule.id, customerNote, ruleContextVariables, ruleRawExtractedText, depositSchedule, effectiveSqftOverride, detectedScopes);
        lineItems = actionResult.lineItems;

        // Update customer note state if the action produced a new value
        if (actionResult.customerNoteValue !== undefined) {
          customerNote = actionResult.customerNoteValue;
        }

        // Update deposit schedule state — lowest priorityOrder wins
        if (actionResult.depositScheduleValue !== undefined) {
          if (rule.priorityOrder < depositSchedulePriority) {
            depositSchedule = actionResult.depositScheduleValue;
            depositSchedulePriority = rule.priorityOrder;
          }
        }

        if (actionResult.modified || actionResult.warning || actionResult.pendingEnrichment) {
          auditTrail.push({
            ruleId: rule.id,
            ruleName: rule.name,
            iteration,
            condition: rule.condition,
            action,
            matchingLineItemIds: matchingIds,
            beforeSnapshot: actionResult.beforeSnapshot ?? [],
            afterSnapshot: actionResult.afterSnapshot ?? [],
            warning: actionResult.warning,
            computedQuantityMeta: actionResult.computedQuantityMeta,
          });
        }

        if (actionResult.pendingEnrichment) {
          for (const liId of actionResult.pendingEnrichment.matchingLineItemIds) {
            const key = `${rule.id}:${liId}:${actionResult.pendingEnrichment.extractionPrompt}`;
            if (emittedEnrichments.has(key)) continue;
            emittedEnrichments.add(key);
            pendingEnrichments.push({
              lineItemId: liId,
              productNamePattern: actionResult.pendingEnrichment.productNamePattern,
              extractionPrompt: actionResult.pendingEnrichment.extractionPrompt,
              separator: actionResult.pendingEnrichment.separator,
              ruleId: rule.id,
              ruleName: rule.name,
            });
          }
        }

        if (actionResult.modified) {
          anyModified = true;
        }
      }

      // Mark this rule as applied to the matching line items
      for (const id of matchingIds) {
        applied.add(`${rule.id}:${id}`);
      }

      // For conditions with no specific matching IDs (e.g. line_item_not_exists,
      // always), track by a sentinel so the rule isn't re-applied identically.
      if (matchingIds.length === 0) {
        applied.add(`${rule.id}:__global__`);
      }
    }

    // Convergence: no modifications this iteration
    if (!anyModified) {
      return { lineItems, auditTrail, iterationCount, converged: true, pendingEnrichments, customerNote, depositSchedule };
    }
  }

  // Max iterations reached without convergence — record a warning entry.
  // We use a synthetic audit entry with sentinel IDs so consumers can
  // distinguish engine-level warnings from rule-level entries.
  auditTrail.push({
    ruleId: '__engine__',
    ruleName: 'Rules Engine',
    iteration: iterationCount,
    condition: { type: 'always' },
    action: { type: 'adjust_quantity', productNamePattern: '', delta: 0 },
    matchingLineItemIds: [],
    beforeSnapshot: [],
    afterSnapshot: [],
    warning: `Rules engine did not converge after ${maxIterations} iterations`,
  });

  return { lineItems, auditTrail, iterationCount, converged: false, pendingEnrichments, customerNote, depositSchedule };
}
