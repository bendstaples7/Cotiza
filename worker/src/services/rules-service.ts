import { PlatformError } from '../errors/index.js';
import type { Rule, RuleGroup, RuleGroupWithRules, StructuredRule, RuleCondition, RuleAction, TriggerMode } from 'shared';
import { validateCondition, validateActions } from './rules-engine.js';
import { validateFormula } from './formula-evaluator.js';
import { resolvePreset } from './extraction-presets.js';

/** Standard column list for rule SELECT queries */
const RULE_COLUMNS = 'id, name, description, rule_group_id, priority_order, is_active, condition_json, action_json, trigger_mode, scope_constraint, created_at, updated_at';

// ---------------------------------------------------------------------------
// Cross-validation helpers
// ---------------------------------------------------------------------------

/**
 * Collect all variableName values from request_text_extract conditions
 * (direct or within a compound condition).
 */
function collectExtractedVariableNames(condition: RuleCondition): Set<string> {
  const names = new Set<string>();
  if (condition.type === 'request_text_extract') {
    names.add(condition.variableName);
  } else if (condition.type === 'compound') {
    for (const sub of condition.conditions) {
      if (sub.type === 'request_text_extract') {
        names.add(sub.variableName);
      }
    }
  }
  return names;
}

/**
 * Resolve presets in a condition tree. Mutates the condition in-place by
 * replacing the `pattern` field with the resolved regex when a `preset` is specified.
 * Returns an error string if a preset ID is unknown, or null on success.
 */
function resolvePresetsInCondition(condition: RuleCondition): string | null {
  if (condition.type === 'request_text_extract') {
    if (condition.preset) {
      const preset = resolvePreset(condition.preset);
      if (!preset) {
        return `Unknown extraction preset: "${condition.preset}"`;
      }
      // Store the resolved regex pattern
      (condition as { pattern: string }).pattern = preset.pattern;
    }
  } else if (condition.type === 'compound') {
    for (const sub of condition.conditions) {
      const err = resolvePresetsInCondition(sub);
      if (err) return err;
    }
  }
  return null;
}

/**
 * Cross-validate formula variables against extracted condition variables.
 * For each compute_quantity action, verify that every variable referenced in
 * the formula is either:
 *   1. Extracted by a request_text_extract condition, OR
 *   2. A known preResolvedContext variable (sqft, productivity rates like drywall_rate)
 *      that will be injected by the QuoteEngine before the rules engine runs.
 *
 * This allows formulas like "sqft / drywall_rate" where drywall_rate comes from
 * the productivity_rates table (injected into preResolvedContext), not from a condition.
 */
const PRE_RESOLVED_CONTEXT_VARIABLES = new Set([
  'sqft',
  'drywall_rate',
  'paint_rate',
  'paint_ceiling_rate',
  'tile_shower_rate',
  'tile_floor_rate',
  'tile_bath_rate',
  'baseboard_rate',
  'crown_molding_rate',
]);

function crossValidateFormulaConditions(
  condition: RuleCondition,
  actions: RuleAction[],
): { valid: boolean; error?: string } {
  const extractedVars = collectExtractedVariableNames(condition);

  for (const action of actions) {
    if (action.type === 'compute_quantity') {
      const formulaResult = validateFormula(action.formula);
      if (!formulaResult.valid) {
        // Formula syntax is invalid — this will be caught by validateAction separately
        continue;
      }
      for (const varName of formulaResult.referencedVariables) {
        if (!extractedVars.has(varName) && !PRE_RESOLVED_CONTEXT_VARIABLES.has(varName)) {
          return {
            valid: false,
            error: `Formula references variable '${varName}' which is not extracted by any condition and is not a known pre-resolved variable (sqft, productivity rates)`,
          };
        }
      }
    }
  }

  return { valid: true };
}

export class RulesService {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  // ── Grouped queries ───────────────────────────────────────────

  /**
   * Fetch all groups with nested rules, ordered by display_order / priority_order.
   */
  async getAllGroupedRules(): Promise<RuleGroupWithRules[]> {
    return this.fetchGroupedRules(false);
  }

  /**
   * Fetch active structured rules (those with valid condition and action JSON).
   * Returns typed StructuredRule[] for use by the rules engine.
   * Skips rules with invalid JSON (logs warning, doesn't throw).
   */
  async getActiveStructuredRules(): Promise<StructuredRule[]> {
    const result = await this.db.prepare(
      `SELECT ${RULE_COLUMNS} FROM rules
       WHERE is_active = 1
         AND condition_json IS NOT NULL
         AND action_json IS NOT NULL
       ORDER BY priority_order ASC`
    ).all();

    const structuredRules: StructuredRule[] = [];

    for (const row of result.results as Record<string, unknown>[]) {
      try {
        const conditionRaw = JSON.parse(row.condition_json as string);
        const actionsRaw = JSON.parse(row.action_json as string);

        // Validate condition schema
        const condResult = validateCondition(conditionRaw);
        if (!condResult.valid) {
          console.warn(`Skipping rule ${row.id}: invalid condition — ${condResult.error}`);
          continue;
        }

        // Validate actions schema
        const actResult = validateActions(actionsRaw);
        if (!actResult.valid) {
          console.warn(`Skipping rule ${row.id}: invalid actions — ${actResult.errors?.join('; ')}`);
          continue;
        }

        structuredRules.push({
          id: row.id as string,
          name: row.name as string,
          priorityOrder: Number(row.priority_order),
          triggerMode: (row.trigger_mode as TriggerMode) ?? 'chained',
          condition: conditionRaw as RuleCondition,
          actions: actionsRaw as RuleAction[],
          scopeConstraint: (row.scope_constraint as import('shared').Scope) ?? null,
        });
      } catch {
        console.warn(`Skipping rule ${row.id}: failed to parse condition/action JSON`);
      }
    }

    return structuredRules;
  }

  // ── Rule CRUD ─────────────────────────────────────────────────

  /**
   * Create a new rule, assigning to "General" group if no groupId provided.
   */
  async createRule(data: {
    name: string;
    description: string;
    ruleGroupId?: string;
    isActive?: boolean;
    conditionJson?: RuleCondition;
    actionJson?: RuleAction[];
    triggerMode?: TriggerMode;
    catalogNames?: string[];
    apiKey?: string;
    apiUrl?: string;
  }): Promise<Rule> {
    const missing: string[] = [];
    if (!data.name || data.name.trim() === '') missing.push('name');
    if (!data.description || data.description.trim() === '') missing.push('description');

    if (missing.length > 0) {
      throw new PlatformError({
        severity: 'error',
        component: 'RulesService',
        operation: 'createRule',
        description: `Rule creation requires a name and description. Missing: ${missing.join(', ')}.`,
        recommendedActions: ['Provide the missing fields'],
      });
    }

    // Reject providing only one of conditionJson/actionJson
    const hasCondition = data.conditionJson !== undefined;
    const hasAction = data.actionJson !== undefined;
    if (hasCondition !== hasAction) {
      throw new PlatformError({
        severity: 'warning',
        component: 'RulesService',
        operation: 'createRule',
        description: 'Structured rules require both conditionJson and actionJson. Provide both or neither.',
        recommendedActions: ['Provide both conditionJson and actionJson together'],
        statusCode: 400,
      });
    }

    // Validate structured rule schemas if provided
    if (data.conditionJson !== undefined) {
      // Resolve presets before validation (replaces preset reference with actual regex)
      const presetError = resolvePresetsInCondition(data.conditionJson);
      if (presetError) {
        throw new PlatformError({
          severity: 'warning',
          component: 'RulesService',
          operation: 'createRule',
          description: presetError,
          recommendedActions: ['Use a valid preset ID (sqft, room_count, floor_count) or provide a custom pattern'],
          statusCode: 400,
        });
      }

      const condResult = validateCondition(data.conditionJson);
      if (!condResult.valid) {
        throw new PlatformError({
          severity: 'warning',
          component: 'RulesService',
          operation: 'createRule',
          description: `Invalid condition schema: ${condResult.error}`,
          recommendedActions: ['Fix the condition JSON and retry'],
          statusCode: 400,
        });
      }
    }

    if (data.actionJson !== undefined) {
      const actResult = validateActions(data.actionJson);
      if (!actResult.valid) {
        throw new PlatformError({
          severity: 'warning',
          component: 'RulesService',
          operation: 'createRule',
          description: `Invalid action schema: ${actResult.errors?.join('; ')}`,
          recommendedActions: ['Fix the action JSON and retry'],
          statusCode: 400,
        });
      }
    }

    // Cross-validate formula variables against condition-extracted variables
    if (data.conditionJson !== undefined && data.actionJson !== undefined) {
      const crossResult = crossValidateFormulaConditions(data.conditionJson, data.actionJson);
      if (!crossResult.valid) {
        throw new PlatformError({
          severity: 'warning',
          component: 'RulesService',
          operation: 'createRule',
          description: crossResult.error!,
          recommendedActions: ['Ensure all formula variables are extracted by a request_text_extract condition'],
          statusCode: 400,
        });
      }
    }

    const VALID_TRIGGER_MODES = new Set(['on_create', 'chained']);
    if (data.triggerMode !== undefined && !VALID_TRIGGER_MODES.has(data.triggerMode)) {
      throw new PlatformError({
        severity: 'warning',
        component: 'RulesService',
        operation: 'createRule',
        description: `Invalid trigger mode: "${data.triggerMode}". Must be "on_create" or "chained".`,
        recommendedActions: ['Use "on_create" or "chained" as the trigger mode'],
        statusCode: 400,
      });
    }

    // Auto-generate structured condition/action if not provided and API key is available
    let conditionJson = data.conditionJson;
    let actionJson = data.actionJson;
    let additionalRules: Array<{ name: string; condition: RuleCondition; actions: RuleAction[] }> = [];

    if (!conditionJson && !actionJson && data.apiKey && data.catalogNames && data.catalogNames.length > 0) {
      const generated = await this.generateStructuredRule(
        data.description,
        data.catalogNames,
        data.apiKey,
        data.apiUrl,
      );
      if (generated && generated.length > 0) {
        // First rule becomes the primary rule being created
        conditionJson = generated[0].condition;
        actionJson = generated[0].actions;
        // Use AI-generated name if the user didn't provide one or it matches the description
        if (generated[0].name && data.name === data.description.slice(0, 60)) {
          data.name = generated[0].name;
        }
        // Additional rules will be created after the primary
        additionalRules = generated.slice(1);
      }
    }

    if (!conditionJson && !actionJson && data.apiKey && data.catalogNames && data.catalogNames.length > 0) {
      throw new PlatformError({
        severity: 'warning',
        component: 'RulesService',
        operation: 'createRule',
        description: 'Could not generate structured conditions/actions for this rule. Please rephrase the rule description and try again.',
        recommendedActions: ['Rephrase the rule description', 'Try using more specific product names from the catalog'],
        statusCode: 400,
      });
    }

    if (!conditionJson || !actionJson) {
      throw new PlatformError({
        severity: 'warning',
        component: 'RulesService',
        operation: 'createRule',
        description: 'Rules require structured conditions and actions. Provide conditionJson and actionJson, or ensure an API key and catalog are available for auto-generation.',
        recommendedActions: ['Provide conditionJson and actionJson', 'Ensure AI_TEXT_API_KEY is configured'],
        statusCode: 400,
      });
    }

    // Auto-categorize into trade group based on rule text
    const groupId = await this.resolveGroupId(
      `${data.name} ${data.description}`,
      data.ruleGroupId,
    );
    const id = crypto.randomUUID();
    const conditionJsonStr = conditionJson ? JSON.stringify(conditionJson) : null;
    const actionJsonStr = actionJson ? JSON.stringify(actionJson) : null;
    const triggerMode = data.triggerMode ?? 'chained';

    try {
      // Atomic INSERT with computed priority_order to avoid race conditions
      await this.db.prepare(
        `INSERT INTO rules (id, name, description, rule_group_id, priority_order, is_active, condition_json, action_json, trigger_mode)
         SELECT ?, ?, ?, ?, COALESCE(MAX(priority_order), -1) + 1, ?, ?, ?, ?
         FROM rules WHERE rule_group_id = ?`
      ).bind(
        id,
        data.name.trim(),
        data.description.trim(),
        groupId,
        (data.isActive ?? true) ? 1 : 0,
        conditionJsonStr,
        actionJsonStr,
        triggerMode,
        groupId,
      ).run();

      const row = await this.db.prepare(
        `SELECT ${RULE_COLUMNS} FROM rules WHERE id = ?`
      ).bind(id).first() as Record<string, unknown>;

      const rule = this.mapRuleRow(row);

      // Update catalog sort orders for any add_line_item actions with placeAfter
      if (actionJson) {
        await this.updateCatalogSortOrders(actionJson);
      }

      // Create additional rules if the AI decomposed the description into multiple rules
      for (const extra of additionalRules) {
        try {
          const extraGroupId = await this.resolveGroupId(
            `${extra.name} ${data.description}`,
          );
          const extraId = crypto.randomUUID();
          await this.db.prepare(
            `INSERT INTO rules (id, name, description, rule_group_id, priority_order, is_active, condition_json, action_json, trigger_mode)
             SELECT ?, ?, ?, ?, COALESCE(MAX(priority_order), -1) + 1, ?, ?, ?, ?
             FROM rules WHERE rule_group_id = ?`
          ).bind(
            extraId,
            extra.name,
            data.description.trim(),
            extraGroupId,
            (data.isActive ?? true) ? 1 : 0,
            JSON.stringify(extra.condition),
            JSON.stringify(extra.actions),
            triggerMode,
            extraGroupId,
          ).run();
          await this.updateCatalogSortOrders(extra.actions);
        } catch (extraErr) {
          console.warn(`Failed to create additional rule "${extra.name}": ${extraErr instanceof Error ? extraErr.message : extraErr}`);
        }
      }

      return rule;
    } catch (err: unknown) {
      if (this.isUniqueViolation(err)) {
        throw new PlatformError({
          severity: 'error',
          component: 'RulesService',
          operation: 'createRule',
          description: `A rule named '${data.name.trim()}' already exists in this group.`,
          recommendedActions: ['Choose a different name', 'Move the rule to another group'],
        });
      }
      throw err;
    }
  }

  /**
   * Update an existing rule's fields.
   */
  async updateRule(ruleId: string, data: {
    name?: string;
    description?: string;
    ruleGroupId?: string;
    isActive?: boolean;
    conditionJson?: RuleCondition | null;
    actionJson?: RuleAction[] | null;
    triggerMode?: TriggerMode;
  }): Promise<Rule> {
    if (data.name !== undefined && data.name.trim() === '') {
      throw new PlatformError({
        severity: 'error',
        component: 'RulesService',
        operation: 'updateRule',
        description: 'Rule name cannot be empty.',
        recommendedActions: ['Provide a non-empty name'],
      });
    }
    if (data.description !== undefined && data.description.trim() === '') {
      throw new PlatformError({
        severity: 'error',
        component: 'RulesService',
        operation: 'updateRule',
        description: 'Rule description cannot be empty.',
        recommendedActions: ['Provide a non-empty description'],
      });
    }

    // Reject providing only one of conditionJson/actionJson
    const hasCondition = data.conditionJson !== undefined;
    const hasAction = data.actionJson !== undefined;
    if (hasCondition !== hasAction) {
      throw new PlatformError({
        severity: 'warning',
        component: 'RulesService',
        operation: 'updateRule',
        description: 'Structured rules require both conditionJson and actionJson. Provide both or neither.',
        recommendedActions: ['Provide both conditionJson and actionJson together'],
        statusCode: 400,
      });
    }

    const VALID_TRIGGER_MODES = new Set(['on_create', 'chained']);
    if (data.triggerMode !== undefined && !VALID_TRIGGER_MODES.has(data.triggerMode as string)) {
      throw new PlatformError({
        severity: 'warning',
        component: 'RulesService',
        operation: 'updateRule',
        description: `Invalid trigger mode: "${data.triggerMode}". Must be "on_create" or "chained".`,
        recommendedActions: ['Use "on_create" or "chained" as the trigger mode'],
        statusCode: 400,
      });
    }

    const setClauses: string[] = ["updated_at = datetime('now')"];
    const values: unknown[] = [];

    if (data.name !== undefined) {
      setClauses.push('name = ?');
      values.push(data.name.trim());
    }
    if (data.description !== undefined) {
      setClauses.push('description = ?');
      values.push(data.description.trim());
    }
    if (data.ruleGroupId !== undefined) {
      setClauses.push('rule_group_id = ?');
      values.push(data.ruleGroupId);
    }
    if (data.isActive !== undefined) {
      setClauses.push('is_active = ?');
      values.push(data.isActive ? 1 : 0);
    }

    // Validate and apply structured rule fields
    if (data.conditionJson !== undefined) {
      if (data.conditionJson !== null) {
        // Resolve presets before validation (replaces preset reference with actual regex)
        const presetError = resolvePresetsInCondition(data.conditionJson);
        if (presetError) {
          throw new PlatformError({
            severity: 'warning',
            component: 'RulesService',
            operation: 'updateRule',
            description: presetError,
            recommendedActions: ['Use a valid preset ID (sqft, room_count, floor_count) or provide a custom pattern'],
            statusCode: 400,
          });
        }

        const condResult = validateCondition(data.conditionJson);
        if (!condResult.valid) {
          throw new PlatformError({
            severity: 'warning',
            component: 'RulesService',
            operation: 'updateRule',
            description: `Invalid condition schema: ${condResult.error}`,
            recommendedActions: ['Fix the condition JSON and retry'],
            statusCode: 400,
          });
        }
      }
      setClauses.push('condition_json = ?');
      values.push(data.conditionJson !== null ? JSON.stringify(data.conditionJson) : null);
    }

    if (data.actionJson !== undefined) {
      if (data.actionJson !== null) {
        const actResult = validateActions(data.actionJson);
        if (!actResult.valid) {
          throw new PlatformError({
            severity: 'warning',
            component: 'RulesService',
            operation: 'updateRule',
            description: `Invalid action schema: ${actResult.errors?.join('; ')}`,
            recommendedActions: ['Fix the action JSON and retry'],
            statusCode: 400,
          });
        }
      }
      setClauses.push('action_json = ?');
      values.push(data.actionJson !== null ? JSON.stringify(data.actionJson) : null);
    }

    // Cross-validate formula variables against condition-extracted variables
    if (data.conditionJson !== undefined && data.conditionJson !== null &&
        data.actionJson !== undefined && data.actionJson !== null) {
      const crossResult = crossValidateFormulaConditions(data.conditionJson, data.actionJson);
      if (!crossResult.valid) {
        throw new PlatformError({
          severity: 'warning',
          component: 'RulesService',
          operation: 'updateRule',
          description: crossResult.error!,
          recommendedActions: ['Ensure all formula variables are extracted by a request_text_extract condition'],
          statusCode: 400,
        });
      }
    }

    if (data.triggerMode !== undefined) {
      setClauses.push('trigger_mode = ?');
      values.push(data.triggerMode);
    }

    values.push(ruleId);

    try {
      await this.db.prepare(
        `UPDATE rules SET ${setClauses.join(', ')} WHERE id = ?`
      ).bind(...values).run();

      const row = await this.db.prepare(
        `SELECT ${RULE_COLUMNS} FROM rules WHERE id = ?`
      ).bind(ruleId).first() as Record<string, unknown> | null;

      if (!row) {
        throw new PlatformError({
          severity: 'error',
          component: 'RulesService',
          operation: 'updateRule',
          description: 'The rule was not found.',
          recommendedActions: ['Verify the rule ID is correct'],
        });
      }

      // Update catalog sort orders for any add_line_item actions with placeAfter
      if (data.actionJson !== undefined && data.actionJson !== null) {
        await this.updateCatalogSortOrders(data.actionJson);
      }

      return this.mapRuleRow(row);
    } catch (err: unknown) {
      if (err instanceof PlatformError) throw err;
      if (this.isUniqueViolation(err)) {
        const name = data.name ?? 'this rule';
        throw new PlatformError({
          severity: 'error',
          component: 'RulesService',
          operation: 'updateRule',
          description: `A rule named '${name}' already exists in this group.`,
          recommendedActions: ['Choose a different name', 'Move the rule to another group'],
        });
      }
      throw err;
    }
  }

  /**
   * Set a rule to inactive (soft delete).
   */
  async deactivateRule(ruleId: string): Promise<Rule> {
    await this.db.prepare(
      "UPDATE rules SET is_active = 0, updated_at = datetime('now') WHERE id = ?"
    ).bind(ruleId).run();

    const row = await this.db.prepare(
      `SELECT ${RULE_COLUMNS} FROM rules WHERE id = ?`
    ).bind(ruleId).first() as Record<string, unknown> | null;

    if (!row) {
      throw new PlatformError({
        severity: 'error',
        component: 'RulesService',
        operation: 'deactivateRule',
        description: 'The rule was not found.',
        recommendedActions: ['Verify the rule ID is correct'],
      });
    }

    return this.mapRuleRow(row);
  }

  // ── Group CRUD ────────────────────────────────────────────────

  /**
   * Create a new rule group.
   */
  async createGroup(data: { name: string; description?: string }): Promise<RuleGroup> {
    if (!data.name || data.name.trim() === '') {
      throw new PlatformError({
        severity: 'error',
        component: 'RulesService',
        operation: 'createGroup',
        description: 'Group creation requires a name.',
        recommendedActions: ['Provide a group name'],
      });
    }

    // Check for duplicate group name (case-insensitive)
    const existing = await this.db.prepare(
      'SELECT id FROM rule_groups WHERE name = ? COLLATE NOCASE'
    ).bind(data.name.trim()).first();

    if (existing) {
      throw new PlatformError({
        severity: 'error',
        component: 'RulesService',
        operation: 'createGroup',
        description: `A group named '${data.name.trim()}' already exists.`,
        recommendedActions: ['Choose a different name'],
      });
    }

    const id = crypto.randomUUID();

    try {
      // Atomic INSERT with computed display_order to avoid race conditions
      await this.db.prepare(
        `INSERT INTO rule_groups (id, name, description, display_order)
         SELECT ?, ?, ?, COALESCE(MAX(display_order), -1) + 1
         FROM rule_groups`
      ).bind(id, data.name.trim(), data.description?.trim() ?? null).run();

      const row = await this.db.prepare(
        'SELECT id, name, description, display_order, created_at FROM rule_groups WHERE id = ?'
      ).bind(id).first() as Record<string, unknown>;

      return this.mapGroupRow(row);
    } catch (err: unknown) {
      if (this.isUniqueViolation(err)) {
        throw new PlatformError({
          severity: 'error',
          component: 'RulesService',
          operation: 'createGroup',
          description: `A group named '${data.name.trim()}' already exists.`,
          recommendedActions: ['Choose a different name'],
        });
      }
      throw err;
    }
  }

  /**
   * Update an existing rule group.
   */
  async updateGroup(groupId: string, data: {
    name?: string;
    description?: string;
    displayOrder?: number;
  }): Promise<RuleGroup> {
    if (data.name !== undefined && data.name.trim() === '') {
      throw new PlatformError({
        severity: 'error',
        component: 'RulesService',
        operation: 'updateGroup',
        description: 'Group name cannot be empty.',
        recommendedActions: ['Provide a non-empty name'],
      });
    }

    // Prevent renaming the default "General" group
    if (data.name !== undefined) {
      const defaultGroupId = await this.getDefaultGroupId();
      if (groupId === defaultGroupId) {
        throw new PlatformError({
          severity: 'error',
          component: 'RulesService',
          operation: 'updateGroup',
          description: "The default 'General' group cannot be renamed.",
          recommendedActions: ['Create a new group instead'],
        });
      }

      // Check for duplicate group name (case-insensitive), excluding the current group
      const duplicate = await this.db.prepare(
        'SELECT id FROM rule_groups WHERE name = ? COLLATE NOCASE AND id != ?'
      ).bind(data.name.trim(), groupId).first();

      if (duplicate) {
        throw new PlatformError({
          severity: 'error',
          component: 'RulesService',
          operation: 'updateGroup',
          description: `A group named '${data.name.trim()}' already exists.`,
          recommendedActions: ['Choose a different name'],
        });
      }
    }

    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (data.name !== undefined) {
      setClauses.push('name = ?');
      values.push(data.name.trim());
    }
    if (data.description !== undefined) {
      setClauses.push('description = ?');
      values.push(data.description.trim());
    }
    if (data.displayOrder !== undefined) {
      setClauses.push('display_order = ?');
      values.push(data.displayOrder);
    }

    if (setClauses.length === 0) {
      const current = await this.db.prepare(
        'SELECT id, name, description, display_order, created_at FROM rule_groups WHERE id = ?'
      ).bind(groupId).first() as Record<string, unknown> | null;

      if (!current) {
        throw new PlatformError({
          severity: 'error',
          component: 'RulesService',
          operation: 'updateGroup',
          description: 'The rule group was not found.',
          recommendedActions: ['Verify the group ID is correct'],
        });
      }
      return this.mapGroupRow(current);
    }

    values.push(groupId);

    await this.db.prepare(
      `UPDATE rule_groups SET ${setClauses.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    const row = await this.db.prepare(
      'SELECT id, name, description, display_order, created_at FROM rule_groups WHERE id = ?'
    ).bind(groupId).first() as Record<string, unknown> | null;

    if (!row) {
      throw new PlatformError({
        severity: 'error',
        component: 'RulesService',
        operation: 'updateGroup',
        description: 'The rule group was not found.',
        recommendedActions: ['Verify the group ID is correct'],
      });
    }

    return this.mapGroupRow(row);
  }

  /**
   * Delete a group, reassigning its rules to the "General" group first.
   * The default "General" group cannot be deleted.
   */
  async deleteGroup(groupId: string): Promise<void> {
    const group = await this.db.prepare(
      'SELECT id, name FROM rule_groups WHERE id = ?'
    ).bind(groupId).first() as { id: string; name: string } | null;

    if (!group) {
      throw new PlatformError({
        severity: 'error',
        component: 'RulesService',
        operation: 'deleteGroup',
        description: 'The rule group was not found.',
        recommendedActions: ['Verify the group ID is correct'],
      });
    }

    const defaultGroupId = await this.getDefaultGroupId();

    if (group.id === defaultGroupId) {
      throw new PlatformError({
        severity: 'error',
        component: 'RulesService',
        operation: 'deleteGroup',
        description: "The default 'General' group cannot be deleted.",
        recommendedActions: ['Delete or reassign rules individually instead'],
      });
    }

    // Use batch to reassign rules then delete the group atomically
    await this.db.batch([
      this.db.prepare(
        "UPDATE rules SET rule_group_id = ?, updated_at = datetime('now') WHERE rule_group_id = ?"
      ).bind(defaultGroupId, groupId),
      this.db.prepare('DELETE FROM rule_groups WHERE id = ?').bind(groupId),
    ]);
  }

  /**
   * Get the default "General" group ID.
   */
  async getDefaultGroupId(): Promise<string> {
    const row = await this.db.prepare(
      "SELECT id FROM rule_groups WHERE name = 'General' ORDER BY created_at ASC LIMIT 1"
    ).first() as { id: string } | null;

    if (!row) {
      throw new PlatformError({
        severity: 'error',
        component: 'RulesService',
        operation: 'getDefaultGroupId',
        description: 'The default "General" rule group was not found. The database may not be properly migrated.',
        recommendedActions: ['Run database migrations'],
      });
    }

    return row.id;
  }

  // ── AI Title Summarization ───────────────────────────────────

  /**
   * Use OpenAI to generate a concise, descriptive title for a rule based on its description.
   * Falls back to the simple truncation method if the API call fails.
   */
  async summarizeRuleTitle(
    description: string,
    apiKey: string,
    apiUrl?: string,
  ): Promise<string> {
    if (!apiKey) return this.deriveRuleName(description);

    const url = apiUrl || 'https://api.openai.com/v1/chat/completions';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content:
                'You are a concise title generator for business rules used in a home renovation quoting system. ' +
                'Given a rule description, produce a short, clear title (max 8 words) that summarizes the rule\'s intent. ' +
                'Do NOT use quotes or punctuation at the end. Just return the title text, nothing else.',
            },
            { role: 'user', content: description },
          ],
          temperature: 0.2,
          max_tokens: 30,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        console.warn(`Rule title summarization failed (${response.status}), falling back to truncation`);
        return this.deriveRuleName(description);
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const title = data.choices?.[0]?.message?.content?.trim();
      if (!title || title.length === 0) return this.deriveRuleName(description);
      // Cap at 80 chars just in case
      return title.length > 80 ? title.slice(0, 80) : title;
    } catch {
      clearTimeout(timeout);
      console.warn('Rule title summarization error, falling back to truncation');
      return this.deriveRuleName(description);
    }
  }

  /**
   * Regenerate summarized titles for all rules that currently have truncated names.
   * Returns the count of rules updated.
   */
  async regenerateAllTitles(apiKey: string, apiUrl?: string): Promise<{ updated: number; total: number }> {
    const result = await this.db.prepare(
      `SELECT ${RULE_COLUMNS} FROM rules ORDER BY priority_order ASC`
    ).all();

    const rules = (result.results as Record<string, unknown>[]).map((row) => this.mapRuleRow(row));
    let updated = 0;

    for (const rule of rules) {
      // Only regenerate if the name looks like a truncation of the description
      const nameIsTruncated = rule.description.toLowerCase().startsWith(rule.name.toLowerCase().replace('…', ''))
        || rule.name.endsWith('…');

      if (nameIsTruncated) {
        const newTitle = await this.summarizeRuleTitle(rule.description, apiKey, apiUrl);
        if (newTitle !== rule.name) {
          await this.db.prepare(
            'UPDATE rules SET name = ?, updated_at = datetime(\'now\') WHERE id = ?'
          ).bind(newTitle, rule.id).run();
          updated++;
        }
      }
    }

    return { updated, total: rules.length };
  }

  /**
   * Auto-categorize rules into trade-based groups by matching rule descriptions
   * against known trade keywords. Rules that don't match any trade stay in their
   * current group.
   */
  async autoCategorizeRules(): Promise<{ moved: number; total: number }> {
    // Fetch all groups to build a name→id map
    const groupsResult = await this.db.prepare(
      'SELECT id, name FROM rule_groups'
    ).all();
    const groupNameToId = new Map<string, string>();
    for (const row of groupsResult.results as Record<string, unknown>[]) {
      groupNameToId.set((row.name as string).toLowerCase(), row.id as string);
    }

    // Fetch all rules
    const rulesResult = await this.db.prepare(
      `SELECT ${RULE_COLUMNS} FROM rules ORDER BY priority_order ASC`
    ).all();
    const rules = (rulesResult.results as Record<string, unknown>[]).map((row) => this.mapRuleRow(row));

    let moved = 0;
    const statements: D1PreparedStatement[] = [];

    for (const rule of rules) {
      const textToMatch = `${rule.name} ${rule.description}`;
      const matchedGroupName = this.matchTradeGroupName(textToMatch);

      if (matchedGroupName) {
        const targetGroupId = groupNameToId.get(matchedGroupName.toLowerCase());
        if (targetGroupId && targetGroupId !== rule.ruleGroupId) {
          statements.push(
            this.db.prepare(
              "UPDATE rules SET rule_group_id = ?, updated_at = datetime('now') WHERE id = ?"
            ).bind(targetGroupId, rule.id),
          );
          moved++;
        }
      }
    }

    if (statements.length > 0) {
      await this.db.batch(statements);
    }

    return { moved, total: rules.length };
  }

  // ── Feedback & line-item-rules ────────────────────────────────

  /**
   * Create a rule from revision feedback text.
   * Uses AI summarization for the title when an API key is provided.
   */
  async createRuleFromFeedback(
    feedbackText: string,
    apiKey?: string,
    apiUrl?: string,
    catalogNames?: string[],
  ): Promise<Rule> {
    const name = apiKey
      ? await this.summarizeRuleTitle(feedbackText, apiKey, apiUrl)
      : this.deriveRuleName(feedbackText);

    return this.createRule({
      name,
      description: feedbackText,
      isActive: true,
      catalogNames,
      apiKey,
      apiUrl,
    });
  }

  /**
   * Persist rule-to-line-item associations for a draft.
   * Clears existing associations for the draft first, then inserts new ones.
   */
  async saveLineItemRules(
    quoteDraftId: string,
    lineItemRules: Array<{ lineItemId: string; ruleIds: string[] }>,
  ): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db.prepare('DELETE FROM line_item_rules WHERE quote_draft_id = ?').bind(quoteDraftId),
    ];

    for (const { lineItemId, ruleIds } of lineItemRules) {
      for (const ruleId of ruleIds) {
        statements.push(
          this.db.prepare(
            `INSERT OR IGNORE INTO line_item_rules (line_item_id, rule_id, quote_draft_id)
             VALUES (?, ?, ?)`
          ).bind(lineItemId, ruleId, quoteDraftId),
        );
      }
    }

    await this.db.batch(statements);
  }

  /**
   * Fetch all rule associations for a draft, returned as a Map of lineItemId → Rule[].
   */
  async getLineItemRules(quoteDraftId: string): Promise<Map<string, Rule[]>> {
    const result = await this.db.prepare(
      `SELECT lir.line_item_id, r.id, r.name, r.description, r.rule_group_id,
              r.priority_order, r.is_active, r.condition_json, r.action_json,
              r.trigger_mode, r.created_at, r.updated_at
       FROM line_item_rules lir
       JOIN rules r ON r.id = lir.rule_id
       WHERE lir.quote_draft_id = ?
       ORDER BY r.priority_order ASC`
    ).bind(quoteDraftId).all();

    const map = new Map<string, Rule[]>();
    for (const row of result.results as Record<string, unknown>[]) {
      const lineItemId = row.line_item_id as string;
      const rule = this.mapRuleRow(row);
      const existing = map.get(lineItemId) ?? [];
      existing.push(rule);
      map.set(lineItemId, existing);
    }

    return map;
  }

  // ── Private helpers ───────────────────────────────────────────

  /** Trade keyword patterns for auto-categorization. Order matters: specific patterns first. */
  private static readonly TRADE_KEYWORDS: Array<{ groupName: string; pattern: RegExp }> = [
    { groupName: 'Exterior', pattern: /\b(exterior|drain tile|siding|gutter)\b/i },
    { groupName: 'Tile', pattern: /\b((?<!drain )tile|tiling|durock|shower surround|shower pan|waterproof|grout)\b/i },
    { groupName: 'Painting', pattern: /\b(paint|painting|primer)\b/i },
    { groupName: 'Electrical', pattern: /\b(electric|electrical|outlet|switch|circuit|wiring|dimmer|can light|light fixture|vanity light)\b/i },
    { groupName: 'Plumbing', pattern: /\b(plumb|plumbing|toilet|shower|faucet|disposal|drain|valve|pipe|sink)\b/i },
    { groupName: 'Carpentry', pattern: /\b(carpentry|cabinet|baseboard|trim|door|window frame|medicine cabinet|wood)\b/i },
    { groupName: 'Drywall', pattern: /\b(drywall|hole patch)\b/i },
    { groupName: 'HVAC', pattern: /\b(hvac|furnace|vent|heating|cooling|air condition)\b/i },
    { groupName: 'Demo', pattern: /\b(demo|demolition|tear out|rip out)\b/i },
    { groupName: 'Insulation', pattern: /\b(insulation|insulate)\b/i },
    { groupName: 'Appliances', pattern: /\b(appliance|range hood|dishwasher|refrigerator|microwave|stove)\b/i },
    { groupName: 'Countertops', pattern: /\b(countertop|counter top|granite|quartz|laminate counter)\b/i },
  ];

  /**
   * Match text against trade keywords and return the group name, or null if no match.
   */
  private matchTradeGroupName(text: string): string | null {
    for (const { groupName, pattern } of RulesService.TRADE_KEYWORDS) {
      if (pattern.test(text)) return groupName;
    }
    return null;
  }

  /**
   * Update catalog sort orders when a rule with add_line_item + placeAfter or placeBefore is created.
   * For placeAfter: sets the added product's sort_order to parent's sort_order + 1, and bumps
   * any products at or above that sort_order within the same range.
   * For placeBefore: sets the added product's sort_order to the parent's sort_order,
   * bumping the parent and following items up by 1.
   */
  private async updateCatalogSortOrders(actions: RuleAction[]): Promise<void> {
    for (const action of actions) {
      if (action.type !== 'add_line_item') continue;

      // Handle placeAfter: set the new product's sort_order to parent's sort_order + 1,
      // bumping any products at or above that sort_order within the same range.
      if (action.placeAfter) {
        const parentRow = await this.db.prepare(
          'SELECT sort_order, user_id FROM product_catalog WHERE name = ? COLLATE NOCASE LIMIT 1'
        ).bind(action.placeAfter).first() as { sort_order: number; user_id: string } | null;

        if (!parentRow) continue;

        const parentOrder = parentRow.sort_order;
        const parentUserId = parentRow.user_id;
        const childOrder = parentOrder + 1;
        const rangeMax = Math.floor(parentOrder / 100) * 100 + 100;

        await this.db.batch([
          this.db.prepare(
            "UPDATE product_catalog SET sort_order = sort_order + 1, updated_at = datetime('now') WHERE user_id = ? AND sort_order >= ? AND sort_order < ? AND name != ? COLLATE NOCASE"
          ).bind(parentUserId, childOrder, rangeMax, action.productName),
          this.db.prepare(
            "UPDATE product_catalog SET sort_order = ?, updated_at = datetime('now') WHERE user_id = ? AND name = ? COLLATE NOCASE"
          ).bind(childOrder, parentUserId, action.productName),
        ]);
      }

      // Handle placeBefore: set the new product's sort_order to the parent's sort_order,
      // bumping the parent and following items up by 1.
      if (action.placeBefore && !action.placeAfter) {
        const parentRow = await this.db.prepare(
          'SELECT sort_order, user_id FROM product_catalog WHERE name = ? COLLATE NOCASE LIMIT 1'
        ).bind(action.placeBefore).first() as { sort_order: number; user_id: string } | null;

        if (!parentRow) continue;

        const parentOrder = parentRow.sort_order;
        const parentUserId = parentRow.user_id;
        const rangeMax = Math.floor(parentOrder / 100) * 100 + 100;

        await this.db.batch([
          this.db.prepare(
            "UPDATE product_catalog SET sort_order = sort_order + 1, updated_at = datetime('now') WHERE user_id = ? AND sort_order >= ? AND sort_order < ? AND name != ? COLLATE NOCASE"
          ).bind(parentUserId, parentOrder, rangeMax, action.productName),
          this.db.prepare(
            "UPDATE product_catalog SET sort_order = ?, updated_at = datetime('now') WHERE user_id = ? AND name = ? COLLATE NOCASE"
          ).bind(parentOrder, parentUserId, action.productName),
        ]);
      }
    }
  }

  /**
   * Find the best trade group ID for the given text, falling back to the default group.
   */
  private async resolveGroupId(text: string, explicitGroupId?: string): Promise<string> {
    // If an explicit group was provided, use it
    if (explicitGroupId !== undefined && explicitGroupId !== '') {
      return explicitGroupId;
    }

    // Try to auto-categorize by trade keywords
    const matchedGroupName = this.matchTradeGroupName(text);
    if (matchedGroupName) {
      const row = await this.db.prepare(
        'SELECT id FROM rule_groups WHERE name = ? COLLATE NOCASE'
      ).bind(matchedGroupName).first() as { id: string } | null;
      if (row) return row.id;
    }

    return this.getDefaultGroupId();
  }

  /**
   * Use OpenAI to generate structured condition/action JSON from a natural language
   * rule description and the product catalog. Uses JSON mode with validation and retry.
   * Returns null if the rule cannot be expressed as a structured rule.
   */
  async generateStructuredRule(
    description: string,
    catalogNames: string[],
    apiKey: string,
    apiUrl?: string,
  ): Promise<Array<{ name: string; condition: RuleCondition; actions: RuleAction[] }> | null> {
    if (!apiKey) return null;

    const url = apiUrl || 'https://api.openai.com/v1/chat/completions';

    const systemContent = [
      'You convert natural language business rules into structured JSON for a deterministic rules engine used in a home renovation quoting system.',
      'The engine evaluates rules AFTER the AI generates initial line items. Rules fire based on conditions about which line items exist or what the customer request text contains.',
      '',
      'CONDITION TYPES:',
      '  line_item_exists — { "type": "line_item_exists", "productNamePattern": "exact catalog name" }',
      '  line_item_not_exists — { "type": "line_item_not_exists", "productNamePattern": "exact catalog name" }',
      '  line_item_name_contains — { "type": "line_item_name_contains", "substring": "partial name" }',
      '  line_item_quantity_gte — { "type": "line_item_quantity_gte", "productNamePattern": "exact catalog name", "threshold": 5 }',
      '  line_item_quantity_lte — { "type": "line_item_quantity_lte", "productNamePattern": "exact catalog name", "threshold": 1 }',
      '  request_text_contains — checks if the customer request text contains a substring: { "type": "request_text_contains", "substring": "wood floor" }',
      '  always — { "type": "always" }',
      '',
      'ACTION TYPES:',
      '  add_line_item — { "type": "add_line_item", "productName": "exact catalog name", "quantity": 1, "unitPrice": 100, "placeAfter": "item it should follow" } — use either placeAfter OR placeBefore (not both). placeBefore defaults to prepending if target not found; placeAfter defaults to appending.',
      '  remove_line_item — { "type": "remove_line_item", "productNamePattern": "exact catalog name" }',
      '  move_line_item — { "type": "move_line_item", "productNamePattern": "exact catalog name", "position": "start" or "end" or "before:Product Name" or "after:Product Name" }',
      '  set_quantity — { "type": "set_quantity", "productNamePattern": "exact catalog name", "quantity": 5 }',
      '  adjust_quantity — { "type": "adjust_quantity", "productNamePattern": "exact catalog name", "delta": 1 }',
      '  set_unit_price — { "type": "set_unit_price", "productNamePattern": "exact catalog name", "unitPrice": 50 }',
      '  set_description — { "type": "set_description", "productNamePattern": "exact catalog name", "description": "new description" }',
      '  append_description — { "type": "append_description", "productNamePattern": "exact catalog name", "text": "additional text" }',
      '  extract_request_context — AI extracts specifics from customer request and appends to description: { "type": "extract_request_context", "productNamePattern": "exact catalog name", "extractionPrompt": "Extract the TV size and mounting location" }',
      '',
      'PRODUCT CATALOG:',
      ...catalogNames.map(n => `  - ${n}`),
      '',
      'INSTRUCTIONS:',
      '- Find the CLOSEST matching catalog name for what the user describes. Example: "TV mounting" → "Carpentry: TV Mount".',
      '- For exact product matches, use line_item_exists. For partial/fuzzy matches, use line_item_name_contains.',
      '- Use request_text_contains when the rule depends on what the customer asked for (e.g., "if the customer mentions wood floors" → { "type": "request_text_contains", "substring": "wood floor" }).',
      '- Use extract_request_context when the rule says to include specifics from the customer request (sizes, locations, quantities). The extractionPrompt is plain English.',
      '- For add_line_item, set placeAfter to the catalog name of the item the new item should follow (e.g., materials after their parent labor item). Use placeBefore when the new item should come before another item (e.g., demo work before the main scope). If the item should be first on the quote, use placeBefore with any likely first item — if the target is not found it defaults to the beginning.',
      '- IMPORTANT: add_line_item will NOT add a duplicate if the product already exists on the quote. To reposition an existing item, use move_line_item instead.',
      '- Use move_line_item to reposition an existing line item. Use "start" or "end" for absolute positioning, or "before:Product Name" / "after:Product Name" for relative positioning.',
      '- IMPORTANT: If the description requires MULTIPLE distinct behaviors (e.g., adding an item AND updating its description, or adding an item AND positioning it), create SEPARATE rules for each behavior.',
      '- Each rule in the "rules" array should have a "name" (short title), "condition", and "actions".',
      '- If the rule truly cannot be expressed, set "unsupported" to true.',
      '',
      'EXAMPLE INPUT: "When kitchen cabinets are being replaced, add a demo line item that references removing the existing cabinets"',
      'EXAMPLE OUTPUT: {"unsupported":false,"rules":[{"name":"Add Demo for Cabinet Replacement","condition":{"type":"line_item_exists","productNamePattern":"Materials: Cabinets"},"actions":[{"type":"add_line_item","productName":"Demo","quantity":1,"unitPrice":100,"placeAfter":"Materials: Cabinets"}]},{"name":"Describe Demo for Cabinet Removal","condition":{"type":"line_item_name_contains","substring":"Demo"},"actions":[{"type":"extract_request_context","productNamePattern":"Demo","extractionPrompt":"Extract what is being demoed or removed (e.g. existing kitchen cabinets, old flooring)"}]}]}',
      '',
      'EXAMPLE INPUT: "When interior painting is on the quote, add paint supplies"',
      'EXAMPLE OUTPUT: {"unsupported":false,"rules":[{"name":"Add Paint Supplies with Painting","condition":{"type":"line_item_exists","productNamePattern":"Interior Painting"},"actions":[{"type":"add_line_item","productName":"Materials: Paint Supplies","quantity":1,"unitPrice":100,"placeAfter":"Interior Painting"}]}]}',
      '',
      'Return ONLY a JSON object with "unsupported" (boolean) and "rules" (array of {name, condition, actions}). No markdown, no explanation.',
    ].join('\n');

    const makeRequest = async (attempt: number): Promise<Array<{ name: string; condition: RuleCondition; actions: RuleAction[] }> | null> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + apiKey,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: systemContent },
              { role: 'user', content: description },
            ],
            temperature: attempt === 0 ? 0.1 : 0.3,
            max_tokens: 1000,
            response_format: { type: 'json_object' },
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errBody = await response.text().catch(() => '');
          console.warn(`Structured rule generation failed (${response.status}) attempt ${attempt + 1}: ${errBody}`);
          return null;
        }

        const data = (await response.json()) as {
          choices: Array<{ message: { content: string } }>;
        };
        const raw = data.choices?.[0]?.message?.content?.trim();
        if (!raw) return null;

        const parsed = JSON.parse(raw);

        if (parsed.unsupported) return null;

        // Handle both single-rule (legacy) and multi-rule response formats
        const ruleEntries: Array<{ name?: string; condition: unknown; actions: unknown }> = parsed.rules
          ? parsed.rules
          : [{ condition: parsed.condition, actions: parsed.actions }];

        const validRules: Array<{ name: string; condition: RuleCondition; actions: RuleAction[] }> = [];

        for (let i = 0; i < ruleEntries.length; i++) {
          const entry = ruleEntries[i];
          const condResult = validateCondition(entry.condition);
          if (!condResult.valid) {
            console.warn(`AI-generated rule[${i}] condition invalid (attempt ${attempt + 1}): ${condResult.error}`);
            continue;
          }

          const actResult = validateActions(entry.actions);
          if (!actResult.valid) {
            console.warn(`AI-generated rule[${i}] actions invalid (attempt ${attempt + 1}): ${actResult.errors?.join('; ')}`);
            continue;
          }

          validRules.push({
            name: entry.name ?? `Rule ${i + 1}`,
            condition: entry.condition as RuleCondition,
            actions: entry.actions as RuleAction[],
          });
        }

        return validRules.length > 0 ? validRules : null;
      } catch (err) {
        clearTimeout(timeout);
        console.warn(`Structured rule generation error (attempt ${attempt + 1}): ${err instanceof Error ? err.message : err}`);
        return null;
      }
    };

    const result = await makeRequest(0);
    if (result) return result;

    console.warn('Retrying structured rule generation...');
    return makeRequest(1);
  }

  private async fetchGroupedRules(activeOnly: boolean): Promise<RuleGroupWithRules[]> {
    const groupsResult = await this.db.prepare(
      'SELECT id, name, description, display_order, created_at FROM rule_groups ORDER BY display_order ASC'
    ).all();

    const rulesQuery = activeOnly
      ? `SELECT ${RULE_COLUMNS} FROM rules WHERE is_active = 1 ORDER BY priority_order ASC`
      : `SELECT ${RULE_COLUMNS} FROM rules ORDER BY priority_order ASC`;

    const rulesResult = await this.db.prepare(rulesQuery).all();

    // Group rules by rule_group_id
    const rulesByGroup = new Map<string, Rule[]>();
    for (const row of rulesResult.results as Record<string, unknown>[]) {
      const groupId = row.rule_group_id as string;
      const rule = this.mapRuleRow(row);
      const existing = rulesByGroup.get(groupId) ?? [];
      existing.push(rule);
      rulesByGroup.set(groupId, existing);
    }

    return (groupsResult.results as Record<string, unknown>[]).map((row) => ({
      ...this.mapGroupRow(row),
      rules: rulesByGroup.get(row.id as string) ?? [],
    }));
  }

  private mapRuleRow(row: Record<string, unknown>): Rule {
    let conditionJson: RuleCondition | null = null;
    let actionJson: RuleAction[] | null = null;
    let triggerMode: TriggerMode = 'chained';

    if (row.condition_json != null && typeof row.condition_json === 'string') {
      try {
        conditionJson = JSON.parse(row.condition_json) as RuleCondition;
      } catch {
        // Invalid JSON — treat as legacy rule
        conditionJson = null;
      }
    }

    if (row.action_json != null && typeof row.action_json === 'string') {
      try {
        actionJson = JSON.parse(row.action_json) as RuleAction[];
      } catch {
        // Invalid JSON — treat as legacy rule
        actionJson = null;
      }
    }

    if (row.trigger_mode != null && typeof row.trigger_mode === 'string') {
      triggerMode = row.trigger_mode as TriggerMode;
    }

    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      ruleGroupId: row.rule_group_id as string,
      priorityOrder: Number(row.priority_order),
      isActive: row.is_active === 1 || row.is_active === true,
      conditionJson,
      actionJson,
      triggerMode,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  private mapGroupRow(row: Record<string, unknown>): RuleGroup {
    return {
      id: row.id as string,
      name: row.name as string,
      description: (row.description as string) ?? null,
      displayOrder: Number(row.display_order),
      createdAt: new Date(row.created_at as string),
    };
  }

  private deriveRuleName(feedbackText: string): string {
    const trimmed = feedbackText.trim();
    const sentenceEnd = trimmed.search(/[.!?]\s/);
    if (sentenceEnd > 0 && sentenceEnd <= 60) {
      return trimmed.slice(0, sentenceEnd + 1);
    }
    if (trimmed.length <= 60) return trimmed;
    const truncated = trimmed.slice(0, 60);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 20) return truncated.slice(0, lastSpace) + '…';
    return truncated + '…';
  }

  private isUniqueViolation(err: unknown): boolean {
    // D1/SQLite uses SQLITE_CONSTRAINT (code 19) or includes "UNIQUE constraint failed" in message
    if (typeof err === 'object' && err !== null) {
      const msg = (err as { message?: string }).message ?? '';
      return msg.includes('UNIQUE constraint failed');
    }
    return false;
  }
}
