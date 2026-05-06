import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { Rule, RuleGroupWithRules, ProductCatalogEntry, RuleCondition, RuleAction, MatchMode, ProductivityRate } from 'shared';
import {
  fetchRules,
  createRule,
  updateRule,
  deactivateRule,
  createRuleGroup,
  deleteRuleGroup,
  summarizeRuleTitle,
  regenerateRuleTitles,
  autoCategorizeRules,
  fetchCatalog,
  reorderCatalog,
  fetchExtractionPresets,
  fetchProductivityRates,
  updateProductivityRate,
} from '../api';
import type { ExtractionPreset } from '../api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TabId = 'rules' | 'ordering' | 'rates';
type RuleFormType = 'standard' | 'context_aware_quantity';

interface ExtractionConfig {
  presetId: string; // '' means custom
  customPattern: string;
  variableName: string;
}

interface ContextAwareFormData {
  productNamePattern: string;
  matchMode: MatchMode;
  extractions: ExtractionConfig[];
  formula: string;
}

interface RuleFormData {
  name: string;
  description: string;
  ruleGroupId: string;
  isActive: boolean;
  ruleType: RuleFormType;
  contextAware: ContextAwareFormData;
}

const emptyExtractionConfig: ExtractionConfig = { presetId: '', customPattern: '', variableName: '' };

const emptyContextAware: ContextAwareFormData = {
  productNamePattern: '',
  matchMode: 'contains',
  extractions: [{ ...emptyExtractionConfig }],
  formula: '',
};

const emptyForm: RuleFormData = {
  name: '',
  description: '',
  ruleGroupId: '',
  isActive: true,
  ruleType: 'standard',
  contextAware: { ...emptyContextAware, extractions: [{ ...emptyExtractionConfig }] },
};

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

// ── Auto-scroll constants (used by ProductOrderingTab drag-and-drop) ──
const SCROLL_ZONE = 80; // px from viewport edge to start scrolling
const MAX_SCROLL_SPEED = 12; // px per animation frame

const TAB_STYLE_BASE: React.CSSProperties = {
  padding: '0.6rem 1.25rem',
  border: 'none',
  borderBottom: '2px solid transparent',
  background: 'none',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: '0.95rem',
  color: '#666',
};

const TAB_STYLE_ACTIVE: React.CSSProperties = {
  ...TAB_STYLE_BASE,
  color: '#00a89d',
  borderBottomColor: '#00a89d',
};

// ---------------------------------------------------------------------------
// Pure helper: merge productivity rates into a formula variables map (non-overwrite)
// Lives in rules-utils.ts to keep this file component-only (Vite Fast Refresh).
// ---------------------------------------------------------------------------

import { mergeRatesIntoVariables } from './rules-utils.js';

// ---------------------------------------------------------------------------
// Client-side formula preview evaluator (simple recursive-descent)
// ---------------------------------------------------------------------------

function evaluateFormulaPreview(formula: string, variables: Record<string, number>): number {
  let pos = 0;
  const peek = () => formula[pos] || '';
  const advance = () => formula[pos++];
  const skipWhitespace = () => { while (pos < formula.length && /\s/.test(formula[pos])) pos++; };

  function parseExpression(): number {
    let result = parseTerm();
    skipWhitespace();
    while (peek() === '+' || peek() === '-') {
      const op = advance();
      const right = parseTerm();
      result = op === '+' ? result + right : result - right;
      skipWhitespace();
    }
    return result;
  }

  function parseTerm(): number {
    let result = parseUnary();
    skipWhitespace();
    while (peek() === '*' || peek() === '/') {
      const op = advance();
      const right = parseUnary();
      result = op === '*' ? result * right : result / right;
      skipWhitespace();
    }
    return result;
  }

  function parseUnary(): number {
    skipWhitespace();
    if (peek() === '-') {
      advance();
      return -parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    skipWhitespace();
    if (peek() === '(') {
      advance();
      const result = parseExpression();
      skipWhitespace();
      if (peek() === ')') advance();
      return result;
    }
    // Number
    if (/[\d.]/.test(peek())) {
      let numStr = '';
      while (pos < formula.length && /[\d.]/.test(formula[pos])) {
        numStr += advance();
      }
      return parseFloat(numStr);
    }
    // Variable
    if (/[a-zA-Z_]/.test(peek())) {
      let name = '';
      while (pos < formula.length && /[a-zA-Z0-9_]/.test(formula[pos])) {
        name += advance();
      }
      if (!(name in variables)) {
        throw new Error(`Variable '${name}' not found in extracted values`);
      }
      return variables[name];
    }
    throw new Error(`Unexpected character: '${peek()}'`);
  }

  const result = parseExpression();
  skipWhitespace();
  if (pos < formula.length) {
    throw new Error(`Unexpected character at position ${pos}: '${formula[pos]}'`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function RulesPage() {
  const [activeTab, setActiveTab] = useState<TabId>('rules');
  const [orderingDirty, setOrderingDirty] = useState(false);

  // Load productivity rates once at the page level so both BusinessRulesTab
  // (formula test panel) and ProductivityRatesTab share the same data.
  const [rates, setRates] = useState<ProductivityRate[]>([]);
  const loadRates = useCallback(async () => {
    try {
      const data = await fetchProductivityRates();
      setRates(data);
    } catch {
      // Non-fatal — formula test panel degrades gracefully without rates
    }
  }, []);
  useEffect(() => { loadRates(); }, [loadRates]);

  return (
    <div style={{ maxWidth: 800 }}>
      {/* Tab bar */}
      <div role="tablist" style={{ display: 'flex', borderBottom: '1px solid #e0e0e0', marginBottom: '1.25rem' }}>
        <button
          style={activeTab === 'rules' ? TAB_STYLE_ACTIVE : TAB_STYLE_BASE}
          onClick={() => {
            if (activeTab === 'rules') return;
            if (activeTab === 'ordering' && orderingDirty) {
              if (!confirm('You have unsaved ordering changes. Discard them?')) return;
            }
            setActiveTab('rules');
            setOrderingDirty(false);
          }}
          aria-selected={activeTab === 'rules'}
          aria-controls="business-rules-panel"
          role="tab"
        >
          Business Rules
        </button>
        <button
          style={activeTab === 'ordering' ? TAB_STYLE_ACTIVE : TAB_STYLE_BASE}
          onClick={() => {
            if (activeTab === 'ordering') return;
            if (orderingDirty) {
              if (!confirm('You have unsaved ordering changes. Discard them?')) return;
            }
            setActiveTab('ordering');
          }}
          aria-selected={activeTab === 'ordering'}
          aria-controls="product-ordering-panel"
          role="tab"
        >
          Product Ordering
        </button>
        <button
          style={activeTab === 'rates' ? TAB_STYLE_ACTIVE : TAB_STYLE_BASE}
          onClick={() => {
            if (activeTab === 'rates') return;
            if (activeTab === 'ordering' && orderingDirty) {
              if (!confirm('You have unsaved ordering changes. Discard them?')) return;
            }
            setActiveTab('rates');
            setOrderingDirty(false);
          }}
          aria-selected={activeTab === 'rates'}
          aria-controls="productivity-rates-panel"
          role="tab"
        >
          Productivity Rates
        </button>
      </div>

      {activeTab === 'rules' && <div role="tabpanel" id="business-rules-panel"><BusinessRulesTab rates={rates} /></div>}
      {activeTab === 'ordering' && <div role="tabpanel" id="product-ordering-panel"><ProductOrderingTab onDirtyChange={setOrderingDirty} /></div>}
      {activeTab === 'rates' && <div role="tabpanel" id="productivity-rates-panel"><ProductivityRatesTab rates={rates} onRatesChange={setRates} /></div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Business Rules Tab (existing functionality, extracted)
// ---------------------------------------------------------------------------

function BusinessRulesTab({ rates }: { rates: ProductivityRate[] }) {
  const [groups, setGroups] = useState<RuleGroupWithRules[]>([]);
  const [loading, setLoading] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [formData, setFormData] = useState<RuleFormData>(emptyForm);
  const [summarizingTitle, setSummarizingTitle] = useState(false);

  const [showGroupForm, setShowGroupForm] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupDescription, setGroupDescription] = useState('');
  const [groupError, setGroupError] = useState<string | null>(null);
  const [savingGroup, setSavingGroup] = useState(false);

  const [regenerating, setRegenerating] = useState(false);
  const [regenerateResult, setRegenerateResult] = useState<string | null>(null);
  const [categorizing, setCategorizing] = useState(false);
  const [categorizeResult, setCategorizeResult] = useState<string | null>(null);

  // Context-aware quantity state
  const [presets, setPresets] = useState<ExtractionPreset[]>([]);
  const [testRequestText, setTestRequestText] = useState('');
  const [testResult, setTestResult] = useState<{ variables: Record<string, number>; rawText: Record<string, string>; quantity: number | null; error?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchRules();
      setGroups(data);
    } catch {
      setLoadError('Failed to load rules. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Load extraction presets for context-aware rules
  useEffect(() => {
    fetchExtractionPresets().then(setPresets).catch(() => {});
  }, []);

  // Client-side formula test helper
  const runFormulaTest = useCallback(() => {
    if (!testRequestText.trim() || !formData.contextAware.formula.trim()) {
      setTestResult(null);
      return;
    }
    const variables: Record<string, number> = {};
    const rawText: Record<string, string> = {};

    for (const ext of formData.contextAware.extractions) {
      const pattern = ext.presetId
        ? presets.find((p) => p.id === ext.presetId)?.pattern || ''
        : ext.customPattern;
      const varName = ext.presetId
        ? presets.find((p) => p.id === ext.presetId)?.variableName || ext.variableName
        : ext.variableName;
      if (!pattern || !varName) continue;
      try {
        const regex = new RegExp(pattern, 'i');
        const match = regex.exec(testRequestText);
        if (match && match[1]) {
          const numStr = match[1].replace(/,/g, '');
          const num = parseFloat(numStr);
          if (!isNaN(num)) {
            variables[varName] = num;
            rawText[varName] = match[0];
          }
        }
      } catch {
        // Invalid regex — skip
      }
    }

    // Merge productivity rates so formulas like sqft / drywall_rate work
    const variablesWithRates = mergeRatesIntoVariables(variables, rates);

    // Simple formula evaluator for preview
    try {
      const formula = formData.contextAware.formula.trim();
      const result = evaluateFormulaPreview(formula, variablesWithRates);
      if (!isFinite(result)) {
        setTestResult({ variables, rawText, quantity: null, error: 'Formula produced non-finite result' });
      } else {
        const rounded = Math.max(1, Math.round(result));
        setTestResult({ variables, rawText, quantity: rounded });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Formula evaluation error';
      setTestResult({ variables, rawText, quantity: null, error: msg });
    }
  }, [testRequestText, formData.contextAware, presets, rates]);

  const defaultGroupId = groups.find((g) => g.name === 'General')?.id || groups[0]?.id || '';

  const filteredGroups = useMemo(() => {
    if (!searchQuery.trim()) return groups;
    const q = searchQuery.toLowerCase();
    return groups
      .map((group) => ({
        ...group,
        rules: group.rules.filter(
          (rule) =>
            rule.name.toLowerCase().includes(q) ||
            rule.description.toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.rules.length > 0 || group.name.toLowerCase().includes(q));
  }, [groups, searchQuery]);

  const totalRuleCount = useMemo(
    () => groups.reduce((sum, g) => sum + g.rules.length, 0),
    [groups],
  );

  const filteredRuleCount = useMemo(
    () => filteredGroups.reduce((sum, g) => sum + g.rules.length, 0),
    [filteredGroups],
  );

  const startCreate = () => {
    setEditingRuleId('new');
    setFormData({ ...emptyForm, ruleGroupId: defaultGroupId, contextAware: { ...emptyContextAware, extractions: [{ ...emptyExtractionConfig }] } });
    setFormError(null);
    setTestRequestText('');
    setTestResult(null);
  };

  const startEdit = (rule: Rule) => {
    setEditingRuleId(rule.id);
    // Detect if this is a context-aware quantity rule
    let ruleType: RuleFormType = 'standard';
    let contextAware: ContextAwareFormData = { ...emptyContextAware, extractions: [{ ...emptyExtractionConfig }] };

    if (rule.actionJson && rule.actionJson.some((a) => a.type === 'compute_quantity')) {
      ruleType = 'context_aware_quantity';
      const computeAction = rule.actionJson.find((a) => a.type === 'compute_quantity') as { type: 'compute_quantity'; productNamePattern: string; formula: string; matchMode?: MatchMode } | undefined;
      if (computeAction) {
        contextAware.productNamePattern = computeAction.productNamePattern;
        contextAware.matchMode = computeAction.matchMode || 'contains';
        contextAware.formula = computeAction.formula;
      }
      // Parse extractions from condition
      if (rule.conditionJson) {
        const extractions: ExtractionConfig[] = [];
        const extractFromCondition = (cond: RuleCondition) => {
          if (cond.type === 'request_text_extract') {
            extractions.push({
              presetId: cond.preset || '',
              customPattern: cond.preset ? '' : cond.pattern,
              variableName: cond.variableName,
            });
          } else if (cond.type === 'compound') {
            for (const sub of cond.conditions) {
              extractFromCondition(sub);
            }
          }
        };
        extractFromCondition(rule.conditionJson);
        if (extractions.length > 0) {
          contextAware.extractions = extractions;
        }
      }
    }

    setFormData({
      name: rule.name,
      description: rule.description,
      ruleGroupId: rule.ruleGroupId,
      isActive: rule.isActive,
      ruleType,
      contextAware,
    });
    setFormError(null);
    setTestRequestText('');
    setTestResult(null);
  };

  const cancelEdit = () => {
    setEditingRuleId(null);
    setFormData(emptyForm);
    setFormError(null);
    setTestRequestText('');
    setTestResult(null);
  };

  const handleSummarizeTitle = async () => {
    if (!formData.description.trim()) return;
    setSummarizingTitle(true);
    try {
      const title = await summarizeRuleTitle(formData.description);
      setFormData((prev) => ({ ...prev, name: title }));
    } catch {
      // Silently fail
    } finally {
      setSummarizingTitle(false);
    }
  };

  const handleSubmit = async () => {
    setSaving(true);
    setFormError(null);
    try {
      let nameToUse = formData.name;
      if (!nameToUse.trim() && formData.description.trim()) {
        try {
          nameToUse = await summarizeRuleTitle(formData.description);
        } catch {
          nameToUse = formData.description.slice(0, 60);
        }
      }

      // Build conditionJson and actionJson for context-aware rules
      let conditionJson: RuleCondition | undefined;
      let actionJson: RuleAction[] | undefined;

      if (formData.ruleType === 'context_aware_quantity') {
        const { productNamePattern, matchMode, extractions, formula } = formData.contextAware;

        // Build extraction conditions
        const extractConditions: RuleCondition[] = extractions
          .filter((ext) => {
            const hasPattern = ext.presetId || ext.customPattern.trim();
            const hasVarName = ext.presetId || ext.variableName.trim();
            return hasPattern && hasVarName;
          })
          .map((ext): RuleCondition => {
            if (ext.presetId) {
              const preset = presets.find((p) => p.id === ext.presetId);
              return {
                type: 'request_text_extract',
                pattern: preset?.pattern || ext.customPattern,
                variableName: preset?.variableName || ext.variableName,
                preset: ext.presetId,
              };
            }
            return {
              type: 'request_text_extract',
              pattern: ext.customPattern,
              variableName: ext.variableName,
            };
          });

        // Build compound condition with line_item_exists + extractions
        const subConditions: RuleCondition[] = [];
        if (productNamePattern.trim()) {
          subConditions.push({
            type: 'line_item_exists',
            productNamePattern: productNamePattern.trim(),
            matchMode,
          });
        }
        subConditions.push(...extractConditions);

        if (subConditions.length === 1) {
          conditionJson = subConditions[0];
        } else if (subConditions.length > 1) {
          conditionJson = { type: 'compound', conditions: subConditions };
        }

        actionJson = [{
          type: 'compute_quantity',
          productNamePattern: productNamePattern.trim(),
          formula: formula.trim(),
          matchMode,
        }];

        // Auto-generate name if empty
        if (!nameToUse.trim()) {
          nameToUse = `Compute quantity: ${formula.trim()}`;
        }
      }

      if (editingRuleId === 'new') {
        await createRule({
          name: nameToUse,
          description: formData.description,
          ruleGroupId: formData.ruleGroupId || undefined,
          isActive: formData.isActive,
          conditionJson,
          actionJson,
        });
      } else if (editingRuleId) {
        await updateRule(editingRuleId, {
          name: nameToUse,
          description: formData.description,
          ruleGroupId: formData.ruleGroupId,
          isActive: formData.isActive,
          conditionJson,
          actionJson,
        });
      }
      cancelEdit();
      await load();
    } catch (err: unknown) {
      const e = err as { message?: string; description?: string };
      setFormError(e.description || e.message || 'Failed to save rule.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async (ruleId: string) => {
    try {
      await deactivateRule(ruleId);
      await load();
    } catch {
      // handled by global error display
    }
  };

  const handleCreateGroup = async () => {
    setSavingGroup(true);
    setGroupError(null);
    try {
      await createRuleGroup({ name: groupName, description: groupDescription || undefined });
      setShowGroupForm(false);
      setGroupName('');
      setGroupDescription('');
      await load();
    } catch (err: unknown) {
      const e = err as { message?: string; description?: string };
      setGroupError(e.description || e.message || 'Failed to create group.');
    } finally {
      setSavingGroup(false);
    }
  };

  const handleDeleteGroup = async (groupId: string, groupNameLabel: string) => {
    if (!confirm(`Delete group "${groupNameLabel}"? Its rules will be moved to the General group.`)) return;
    try {
      await deleteRuleGroup(groupId);
      await load();
    } catch {
      // handled by global error display
    }
  };

  const handleRegenerateTitles = async () => {
    setRegenerating(true);
    setRegenerateResult(null);
    try {
      const result = await regenerateRuleTitles();
      setRegenerateResult(`Updated ${result.updated} of ${result.total} rule titles.`);
      await load();
    } catch {
      setRegenerateResult('Failed to regenerate titles. Please try again.');
    } finally {
      setRegenerating(false);
    }
  };

  const handleAutoCategorize = async () => {
    setCategorizing(true);
    setCategorizeResult(null);
    try {
      const result = await autoCategorizeRules();
      setCategorizeResult(
        result.moved > 0
          ? `Moved ${result.moved} of ${result.total} rules into trade groups.`
          : `All ${result.total} rules are already categorized.`,
      );
      await load();
    } catch {
      setCategorizeResult('Failed to auto-categorize. Please try again.');
    } finally {
      setCategorizing(false);
    }
  };

  if (loading) return <p>Loading rules…</p>;

  const renderForm = () => (
    <div style={{ background: '#f9f9f9', border: '1px solid #e0e0e0', borderRadius: 6, padding: '1rem', marginBottom: '1rem' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {/* Rule Type Selector */}
        <div>
          <label style={{ display: 'block', fontWeight: 600, marginBottom: 4, fontSize: '0.85rem' }}>Rule Type</label>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              onClick={() => setFormData({ ...formData, ruleType: 'standard' })}
              style={{
                padding: '0.4rem 0.75rem',
                borderRadius: 4,
                border: formData.ruleType === 'standard' ? '2px solid #00a89d' : '1px solid #ccc',
                background: formData.ruleType === 'standard' ? '#e0f7f5' : '#fff',
                cursor: 'pointer',
                fontSize: '0.85rem',
                fontWeight: formData.ruleType === 'standard' ? 600 : 400,
              }}
            >
              Standard Rule
            </button>
            <button
              type="button"
              onClick={() => setFormData({ ...formData, ruleType: 'context_aware_quantity' })}
              style={{
                padding: '0.4rem 0.75rem',
                borderRadius: 4,
                border: formData.ruleType === 'context_aware_quantity' ? '2px solid #00a89d' : '1px solid #ccc',
                background: formData.ruleType === 'context_aware_quantity' ? '#e0f7f5' : '#fff',
                cursor: 'pointer',
                fontSize: '0.85rem',
                fontWeight: formData.ruleType === 'context_aware_quantity' ? 600 : 400,
              }}
            >
              Context-Aware Quantity
            </button>
          </div>
        </div>

        {formData.ruleType === 'standard' && (
          <>
            <div>
              <label htmlFor="rule-description" style={{ display: 'block', fontWeight: 600, marginBottom: 4, fontSize: '0.85rem' }}>Description</label>
              <textarea
                id="rule-description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Describe what this rule does"
                rows={3}
                style={{ width: '100%', padding: '0.5rem', borderRadius: 4, border: '1px solid #ccc', boxSizing: 'border-box', resize: 'vertical' }}
              />
            </div>
            <div>
              <label htmlFor="rule-name" style={{ display: 'block', fontWeight: 600, marginBottom: 4, fontSize: '0.85rem' }}>
                Title
                <span style={{ fontWeight: 400, color: '#888', marginLeft: 6, fontSize: '0.8rem' }}>
                  (auto-generated if left blank)
                </span>
              </label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  id="rule-name"
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="Leave blank to auto-generate from description"
                  style={{ flex: 1, padding: '0.5rem', borderRadius: 4, border: '1px solid #ccc', boxSizing: 'border-box' }}
                />
                <button
                  type="button"
                  onClick={handleSummarizeTitle}
                  disabled={summarizingTitle || !formData.description.trim()}
                  title="Generate a concise title from the description"
                  style={{
                    background: '#fff',
                    color: '#00a89d',
                    border: '1px solid #00a89d',
                    padding: '0.5rem 0.75rem',
                    borderRadius: 4,
                    cursor: summarizingTitle || !formData.description.trim() ? 'not-allowed' : 'pointer',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    opacity: summarizingTitle || !formData.description.trim() ? 0.5 : 1,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {summarizingTitle ? 'Generating…' : '✨ Summarize'}
                </button>
              </div>
            </div>
          </>
        )}

        {formData.ruleType === 'context_aware_quantity' && (
          <>
            {/* Product Name Pattern */}
            <div>
              <label htmlFor="ca-product-pattern" style={{ display: 'block', fontWeight: 600, marginBottom: 4, fontSize: '0.85rem' }}>
                Target Product Name
              </label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  id="ca-product-pattern"
                  type="text"
                  value={formData.contextAware.productNamePattern}
                  onChange={(e) => setFormData({ ...formData, contextAware: { ...formData.contextAware, productNamePattern: e.target.value } })}
                  placeholder="e.g., Drywall Installation"
                  style={{ flex: 1, padding: '0.5rem', borderRadius: 4, border: '1px solid #ccc', boxSizing: 'border-box' }}
                />
                <select
                  value={formData.contextAware.matchMode}
                  onChange={(e) => setFormData({ ...formData, contextAware: { ...formData.contextAware, matchMode: e.target.value as MatchMode } })}
                  style={{ padding: '0.5rem', borderRadius: 4, border: '1px solid #ccc' }}
                  aria-label="Match mode"
                >
                  <option value="contains">Contains</option>
                  <option value="exact">Exact</option>
                  <option value="starts_with">Starts with</option>
                </select>
              </div>
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#888' }}>
                The line item whose quantity will be computed
              </p>
            </div>

            {/* Extraction Patterns */}
            <div>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: 4, fontSize: '0.85rem' }}>
                Value Extractions
              </label>
              <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: '#666' }}>
                Extract numeric values from the customer request text to use in the formula
              </p>
              {formData.contextAware.extractions.map((ext, idx) => (
                <div key={idx} style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 4, padding: '0.75rem', marginBottom: '0.5rem' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: '0.8rem', color: '#555', marginBottom: 2 }}>Pattern Source</label>
                      <select
                        value={ext.presetId}
                        onChange={(e) => {
                          const updated = [...formData.contextAware.extractions];
                          const presetId = e.target.value;
                          const preset = presets.find((p) => p.id === presetId);
                          updated[idx] = {
                            presetId,
                            customPattern: presetId ? '' : ext.customPattern,
                            variableName: preset ? preset.variableName : ext.variableName,
                          };
                          setFormData({ ...formData, contextAware: { ...formData.contextAware, extractions: updated } });
                        }}
                        style={{ width: '100%', padding: '0.4rem', borderRadius: 4, border: '1px solid #ccc', fontSize: '0.85rem' }}
                        aria-label="Extraction preset"
                      >
                        <option value="">Custom regex pattern</option>
                        {presets.map((p) => (
                          <option key={p.id} value={p.id}>{p.name} — {p.description}</option>
                        ))}
                      </select>
                    </div>
                    {formData.contextAware.extractions.length > 1 && (
                      <button
                        type="button"
                        onClick={() => {
                          const updated = formData.contextAware.extractions.filter((_, i) => i !== idx);
                          setFormData({ ...formData, contextAware: { ...formData.contextAware, extractions: updated } });
                        }}
                        style={{ background: 'none', border: '1px solid #b71c1c', color: '#b71c1c', padding: '0.25rem 0.5rem', borderRadius: 4, cursor: 'pointer', fontSize: '0.75rem', marginTop: '1.2rem' }}
                        aria-label="Remove extraction"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  {!ext.presetId && (
                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                      <div style={{ flex: 2 }}>
                        <label style={{ display: 'block', fontSize: '0.8rem', color: '#555', marginBottom: 2 }}>Regex Pattern (one capture group)</label>
                        <input
                          type="text"
                          value={ext.customPattern}
                          onChange={(e) => {
                            const updated = [...formData.contextAware.extractions];
                            updated[idx] = { ...updated[idx], customPattern: e.target.value };
                            setFormData({ ...formData, contextAware: { ...formData.contextAware, extractions: updated } });
                          }}
                          placeholder="e.g., (\d+)\s*sqft"
                          style={{ width: '100%', padding: '0.4rem', borderRadius: 4, border: '1px solid #ccc', fontSize: '0.85rem', fontFamily: 'monospace', boxSizing: 'border-box' }}
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', fontSize: '0.8rem', color: '#555', marginBottom: 2 }}>Variable Name</label>
                        <input
                          type="text"
                          value={ext.variableName}
                          onChange={(e) => {
                            const updated = [...formData.contextAware.extractions];
                            updated[idx] = { ...updated[idx], variableName: e.target.value };
                            setFormData({ ...formData, contextAware: { ...formData.contextAware, extractions: updated } });
                          }}
                          placeholder="e.g., sqft"
                          style={{ width: '100%', padding: '0.4rem', borderRadius: 4, border: '1px solid #ccc', fontSize: '0.85rem', fontFamily: 'monospace', boxSizing: 'border-box' }}
                        />
                      </div>
                    </div>
                  )}
                  {ext.presetId && (
                    <p style={{ margin: '0.35rem 0 0', fontSize: '0.75rem', color: '#888' }}>
                      Variable: <code style={{ background: '#f0f0f0', padding: '1px 4px', borderRadius: 2 }}>{presets.find((p) => p.id === ext.presetId)?.variableName}</code>
                      {' · '}Matches: {presets.find((p) => p.id === ext.presetId)?.exampleMatches.join(', ')}
                    </p>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  setFormData({
                    ...formData,
                    contextAware: {
                      ...formData.contextAware,
                      extractions: [...formData.contextAware.extractions, { ...emptyExtractionConfig }],
                    },
                  });
                }}
                style={{ background: '#fff', color: '#00a89d', border: '1px solid #00a89d', padding: '0.3rem 0.75rem', borderRadius: 4, cursor: 'pointer', fontSize: '0.8rem' }}
              >
                + Add Extraction
              </button>
            </div>

            {/* Formula */}
            <div>
              <label htmlFor="ca-formula" style={{ display: 'block', fontWeight: 600, marginBottom: 4, fontSize: '0.85rem' }}>
                Quantity Formula
              </label>
              <input
                id="ca-formula"
                type="text"
                value={formData.contextAware.formula}
                onChange={(e) => setFormData({ ...formData, contextAware: { ...formData.contextAware, formula: e.target.value } })}
                placeholder="e.g., sqft / 100 * 4"
                style={{ width: '100%', padding: '0.5rem', borderRadius: 4, border: '1px solid #ccc', boxSizing: 'border-box', fontFamily: 'monospace' }}
              />
              {formData.contextAware.extractions.some((e) => e.presetId || e.variableName) && (
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#888' }}>
                  Available variables:{' '}
                  {formData.contextAware.extractions
                    .map((ext) => ext.presetId ? presets.find((p) => p.id === ext.presetId)?.variableName : ext.variableName)
                    .filter(Boolean)
                    .map((v) => (
                      <code key={v} style={{ background: '#f0f0f0', padding: '1px 4px', borderRadius: 2, marginRight: 4 }}>{v}</code>
                    ))}
                </p>
              )}
            </div>

            {/* Title (optional for context-aware) */}
            <div>
              <label htmlFor="rule-name-ca" style={{ display: 'block', fontWeight: 600, marginBottom: 4, fontSize: '0.85rem' }}>
                Title
                <span style={{ fontWeight: 400, color: '#888', marginLeft: 6, fontSize: '0.8rem' }}>
                  (auto-generated if left blank)
                </span>
              </label>
              <input
                id="rule-name-ca"
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Leave blank to auto-generate"
                style={{ width: '100%', padding: '0.5rem', borderRadius: 4, border: '1px solid #ccc', boxSizing: 'border-box' }}
              />
            </div>

            {/* Description (optional for context-aware) */}
            <div>
              <label htmlFor="rule-description-ca" style={{ display: 'block', fontWeight: 600, marginBottom: 4, fontSize: '0.85rem' }}>
                Description
                <span style={{ fontWeight: 400, color: '#888', marginLeft: 6, fontSize: '0.8rem' }}>(optional)</span>
              </label>
              <textarea
                id="rule-description-ca"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Describe what this rule does"
                rows={2}
                style={{ width: '100%', padding: '0.5rem', borderRadius: 4, border: '1px solid #ccc', boxSizing: 'border-box', resize: 'vertical' }}
              />
            </div>

            {/* Test Formula Section */}
            <div style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 4, padding: '0.75rem' }}>
              <label htmlFor="ca-test-text" style={{ display: 'block', fontWeight: 600, marginBottom: 4, fontSize: '0.85rem' }}>
                Test Formula
              </label>
              <textarea
                id="ca-test-text"
                value={testRequestText}
                onChange={(e) => setTestRequestText(e.target.value)}
                placeholder="Enter sample request text to test extraction and formula (e.g., 'fully gutted 1500 sqft property needs drywall')"
                rows={2}
                style={{ width: '100%', padding: '0.5rem', borderRadius: 4, border: '1px solid #ccc', boxSizing: 'border-box', resize: 'vertical', fontSize: '0.85rem' }}
              />
              <button
                type="button"
                onClick={runFormulaTest}
                disabled={!testRequestText.trim() || !formData.contextAware.formula.trim()}
                style={{
                  marginTop: '0.5rem',
                  background: '#fff',
                  color: '#00a89d',
                  border: '1px solid #00a89d',
                  padding: '0.3rem 0.75rem',
                  borderRadius: 4,
                  cursor: !testRequestText.trim() || !formData.contextAware.formula.trim() ? 'not-allowed' : 'pointer',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  opacity: !testRequestText.trim() || !formData.contextAware.formula.trim() ? 0.5 : 1,
                }}
              >
                Run Test
              </button>
              {testResult && (
                <div style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                  {Object.keys(testResult.variables).length > 0 && (
                    <div style={{ marginBottom: '0.25rem' }}>
                      <span style={{ fontWeight: 600, color: '#555' }}>Extracted:</span>{' '}
                      {Object.entries(testResult.variables).map(([k, v]) => (
                        <span key={k} style={{ marginRight: 8 }}>
                          <code style={{ background: '#f0f0f0', padding: '1px 4px', borderRadius: 2 }}>{k}</code> = {v}
                          {testResult.rawText[k] && <span style={{ color: '#888' }}> (from "{testResult.rawText[k]}")</span>}
                        </span>
                      ))}
                    </div>
                  )}
                  {Object.keys(testResult.variables).length === 0 && !testResult.error && (
                    <div style={{ color: '#e65100' }}>No values extracted from the text.</div>
                  )}
                  {testResult.quantity !== null && (
                    <div style={{ color: '#2e7d32', fontWeight: 600 }}>
                      Computed quantity: {testResult.quantity}
                    </div>
                  )}
                  {testResult.error && (
                    <div style={{ color: '#b71c1c' }}>Error: {testResult.error}</div>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {/* Common fields */}
        <div>
          <label htmlFor="rule-group" style={{ display: 'block', fontWeight: 600, marginBottom: 4, fontSize: '0.85rem' }}>Group</label>
          <select
            id="rule-group"
            value={formData.ruleGroupId}
            onChange={(e) => setFormData({ ...formData, ruleGroupId: e.target.value })}
            style={{ width: '100%', padding: '0.5rem', borderRadius: 4, border: '1px solid #ccc', boxSizing: 'border-box' }}
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            id="rule-active"
            checked={formData.isActive}
            onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
          />
          <label htmlFor="rule-active" style={{ fontSize: '0.85rem' }}>Active</label>
        </div>
        {formError && (
          <div role="alert" style={{ padding: '0.5rem 0.75rem', background: '#fdecea', color: '#b71c1c', borderRadius: 4, fontSize: '0.85rem' }}>
            {formError}
          </div>
        )}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={handleSubmit}
            disabled={saving}
            style={{ background: '#00a89d', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
          >
            {saving ? 'Saving…' : editingRuleId === 'new' ? 'Create Rule' : 'Save Changes'}
          </button>
          <button
            onClick={cancelEdit}
            style={{ background: '#fff', color: '#666', border: '1px solid #ccc', padding: '0.5rem 1rem', borderRadius: 6, cursor: 'pointer' }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Business Rules</h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={() => setShowGroupForm(!showGroupForm)}
            style={{ background: '#fff', color: '#00a89d', border: '1px solid #00a89d', padding: '0.5rem 1rem', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
          >
            {showGroupForm ? 'Cancel' : '+ Add Group'}
          </button>
          <button
            onClick={startCreate}
            disabled={editingRuleId !== null}
            style={{ background: '#00a89d', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: 6, cursor: 'pointer', fontWeight: 600, opacity: editingRuleId !== null ? 0.5 : 1 }}
          >
            + Add Rule
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search rules by title or description…"
            aria-label="Search rules"
            style={{
              width: '100%',
              padding: '0.6rem 0.75rem 0.6rem 2.25rem',
              borderRadius: 6,
              border: '1px solid #ccc',
              boxSizing: 'border-box',
              fontSize: '0.9rem',
            }}
          />
          <span
            style={{
              position: 'absolute',
              left: '0.75rem',
              top: '50%',
              transform: 'translateY(-50%)',
              color: '#999',
              fontSize: '0.9rem',
              pointerEvents: 'none',
            }}
            aria-hidden="true"
          >
            🔍
          </span>
        </div>
        {searchQuery.trim() && (
          <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', color: '#666' }}>
            Showing {filteredRuleCount} of {totalRuleCount} rules
          </p>
        )}
      </div>

      {/* Rule management actions */}
      {totalRuleCount > 0 && (
        <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button
            onClick={handleRegenerateTitles}
            disabled={regenerating}
            style={{
              background: '#fff',
              color: '#555',
              border: '1px solid #ccc',
              padding: '0.4rem 0.75rem',
              borderRadius: 6,
              cursor: regenerating ? 'not-allowed' : 'pointer',
              fontSize: '0.8rem',
              opacity: regenerating ? 0.6 : 1,
            }}
          >
            {regenerating ? 'Regenerating…' : '✨ Regenerate Rule Titles'}
          </button>
          <button
            onClick={handleAutoCategorize}
            disabled={categorizing}
            style={{
              background: '#fff',
              color: '#555',
              border: '1px solid #ccc',
              padding: '0.4rem 0.75rem',
              borderRadius: 6,
              cursor: categorizing ? 'not-allowed' : 'pointer',
              fontSize: '0.8rem',
              opacity: categorizing ? 0.6 : 1,
            }}
          >
            {categorizing ? 'Categorizing…' : '🏷️ Auto-Categorize by Trade'}
          </button>
          {regenerateResult && (
            <span style={{ fontSize: '0.8rem', color: '#666' }}>{regenerateResult}</span>
          )}
          {categorizeResult && (
            <span style={{ fontSize: '0.8rem', color: '#666' }}>{categorizeResult}</span>
          )}
        </div>
      )}

      {/* Group creation form */}
      {showGroupForm && (
        <div style={{ background: '#f9f9f9', border: '1px solid #e0e0e0', borderRadius: 6, padding: '1rem', marginBottom: '1.5rem' }}>
          <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem' }}>New Group</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div>
              <label htmlFor="group-name" style={{ display: 'block', fontWeight: 600, marginBottom: 4, fontSize: '0.85rem' }}>Name</label>
              <input
                id="group-name"
                type="text"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="Group name"
                style={{ width: '100%', padding: '0.5rem', borderRadius: 4, border: '1px solid #ccc', boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <label htmlFor="group-description" style={{ display: 'block', fontWeight: 600, marginBottom: 4, fontSize: '0.85rem' }}>Description</label>
              <input
                id="group-description"
                type="text"
                value={groupDescription}
                onChange={(e) => setGroupDescription(e.target.value)}
                placeholder="Description (optional)"
                style={{ width: '100%', padding: '0.5rem', borderRadius: 4, border: '1px solid #ccc', boxSizing: 'border-box' }}
              />
            </div>
            {groupError && (
              <div role="alert" style={{ padding: '0.5rem 0.75rem', background: '#fdecea', color: '#b71c1c', borderRadius: 4, fontSize: '0.85rem' }}>
                {groupError}
              </div>
            )}
            <button
              onClick={handleCreateGroup}
              disabled={savingGroup || !groupName.trim()}
              style={{ alignSelf: 'flex-start', background: '#00a89d', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
            >
              {savingGroup ? 'Creating…' : 'Create Group'}
            </button>
          </div>
        </div>
      )}

      {/* New rule form (top-level) */}
      {editingRuleId === 'new' && renderForm()}

      {/* Rule groups */}
      {filteredGroups.map((group) => (
        <section
          key={group.id}
          style={{ background: '#fff', borderRadius: 8, padding: '1.25rem', marginBottom: '1rem', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{group.name}</h2>
              {group.description && (
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#666' }}>{group.description}</p>
              )}
            </div>
            {group.name !== 'General' && (
              <button
                onClick={() => handleDeleteGroup(group.id, group.name)}
                style={{ background: 'none', border: '1px solid #b71c1c', color: '#b71c1c', padding: '0.3rem 0.75rem', borderRadius: 4, cursor: 'pointer', fontSize: '0.8rem' }}
              >
                Delete Group
              </button>
            )}
          </div>

          {group.rules.length === 0 ? (
            <p style={{ color: '#999', fontStyle: 'italic', margin: 0 }}>No rules in this group yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {group.rules.map((rule) => (
                <div key={rule.id}>
                  {editingRuleId === rule.id ? (
                    renderForm()
                  ) : (
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        padding: '0.75rem',
                        borderRadius: 6,
                        border: '1px solid #e0e0e0',
                        opacity: rule.isActive ? 1 : 0.5,
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontWeight: 600 }}>{rule.name}</span>
                          {rule.conditionJson && rule.actionJson && (
                            <span style={{
                              fontSize: '0.7rem',
                              background: rule.actionJson.some((a: RuleAction) => a.type === 'compute_quantity') ? '#e8f5e9' : '#e3f2fd',
                              color: rule.actionJson.some((a: RuleAction) => a.type === 'compute_quantity') ? '#2e7d32' : '#1565c0',
                              padding: '1px 6px',
                              borderRadius: 10,
                            }}
                            title={rule.actionJson.some((a: RuleAction) => a.type === 'compute_quantity')
                              ? "This rule computes quantity from extracted context values"
                              : "This rule has structured conditions and actions that are enforced deterministically"}
                            >
                              {rule.actionJson.some((a: RuleAction) => a.type === 'compute_quantity') ? 'Context-Aware' : 'Structured'}
                            </span>
                          )}
                          {!rule.isActive && (
                            <span style={{
                              fontSize: '0.7rem',
                              background: '#999',
                              color: '#fff',
                              padding: '1px 6px',
                              borderRadius: 10,
                            }}>
                              Inactive
                            </span>
                          )}
                        </div>
                        <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#555' }}>{rule.description}</p>
                      </div>
                      <div style={{ display: 'flex', gap: '0.35rem', marginLeft: '0.75rem', flexShrink: 0 }}>
                        <button
                          onClick={() => startEdit(rule)}
                          disabled={editingRuleId !== null}
                          style={{ background: 'none', border: '1px solid #00a89d', color: '#00a89d', padding: '0.25rem 0.6rem', borderRadius: 4, cursor: 'pointer', fontSize: '0.8rem' }}
                        >
                          Edit
                        </button>
                        {rule.isActive && (
                          <button
                            onClick={() => handleDeactivate(rule.id)}
                            style={{ background: 'none', border: '1px solid #e65100', color: '#e65100', padding: '0.25rem 0.6rem', borderRadius: 4, cursor: 'pointer', fontSize: '0.8rem' }}
                          >
                            Deactivate
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      ))}

      {filteredGroups.length === 0 && searchQuery.trim() && (
        <p style={{ color: '#999', textAlign: 'center', marginTop: '2rem' }}>
          No rules match "{searchQuery}".
        </p>
      )}

      {groups.length === 0 && !loadError && !searchQuery.trim() && (
        <p style={{ color: '#999', textAlign: 'center', marginTop: '2rem' }}>
          No rule groups found. Create a group to get started.
        </p>
      )}

      {loadError && (
        <div
          role="alert"
          style={{
            background: '#fff3e0',
            border: '1px solid #ffb74d',
            borderRadius: 8,
            padding: '1.25rem',
            marginTop: '1.5rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
          }}
        >
          <span style={{ color: '#e65100', fontWeight: 500 }}>{loadError}</span>
          <button
            onClick={load}
            style={{
              background: '#e65100',
              color: '#fff',
              border: 'none',
              padding: '0.5rem 1rem',
              borderRadius: 6,
              cursor: 'pointer',
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            Retry
          </button>
        </div>
      )}
    </>
  );
}


// ---------------------------------------------------------------------------
// Productivity Rates Tab
// ---------------------------------------------------------------------------

interface RateRowState {
  displayName: string;
  sqftPerHour: string; // string for controlled input
  description: string;
  saving: boolean;
  saveStatus: 'success' | 'error' | null;
  saveMessage: string | null;
}

function ProductivityRatesTab({
  rates,
  onRatesChange,
}: {
  rates: ProductivityRate[];
  onRatesChange: (rates: ProductivityRate[]) => void;
}) {
  const [loading, setLoading] = useState(rates.length === 0);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Per-row edit state keyed by rate id
  const [rowState, setRowState] = useState<Record<string, RateRowState>>({});

  // Initialise row state whenever rates change (e.g. after load or save)
  useEffect(() => {
    setRowState((prev) => {
      const next: Record<string, RateRowState> = {};
      for (const rate of rates) {
        // Preserve in-progress edits if the row is currently saving
        if (prev[rate.id]?.saving) {
          next[rate.id] = prev[rate.id];
        } else {
          next[rate.id] = {
            displayName: rate.displayName,
            sqftPerHour: String(rate.sqftPerHour),
            description: rate.description ?? '',
            saving: false,
            saveStatus: prev[rate.id]?.saveStatus ?? null,
            saveMessage: prev[rate.id]?.saveMessage ?? null,
          };
        }
      }
      return next;
    });
  }, [rates]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchProductivityRates();
      onRatesChange(data);
    } catch {
      setLoadError('Failed to load productivity rates. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [onRatesChange]);

  // Only fetch on mount if rates haven't been loaded yet
  useEffect(() => {
    if (rates.length === 0) {
      load();
    } else {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateRow = (id: string, patch: Partial<RateRowState>) => {
    setRowState((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const handleSave = async (rate: ProductivityRate) => {
    const row = rowState[rate.id];
    if (!row) return;

    const sqftPerHour = parseFloat(row.sqftPerHour);
    if (!Number.isFinite(sqftPerHour) || sqftPerHour <= 0) {
      updateRow(rate.id, {
        saveStatus: 'error',
        saveMessage: 'sqft/hr must be a positive number.',
      });
      return;
    }

    updateRow(rate.id, { saving: true, saveStatus: null, saveMessage: null });
    try {
      const updated = await updateProductivityRate(rate.id, {
        sqftPerHour,
        displayName: row.displayName.trim() || undefined,
        description: row.description.trim() || undefined,
      });
      // Update the shared rates list
      onRatesChange(rates.map((r) => (r.id === updated.id ? updated : r)));
      updateRow(rate.id, {
        saving: false,
        saveStatus: 'success',
        saveMessage: 'Saved.',
      });
    } catch (err: unknown) {
      const e = err as { description?: string; message?: string };
      updateRow(rate.id, {
        saving: false,
        saveStatus: 'error',
        saveMessage: e.description || e.message || 'Failed to save.',
      });
    }
  };

  if (loading) {
    return <p style={{ color: '#666' }}>Loading productivity rates…</p>;
  }

  if (loadError) {
    return (
      <div
        role="alert"
        style={{
          background: '#fff3e0',
          border: '1px solid #ffb74d',
          borderRadius: 8,
          padding: '1.25rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
        }}
      >
        <span style={{ color: '#e65100', fontWeight: 500 }}>{loadError}</span>
        <button
          onClick={load}
          style={{
            background: '#e65100',
            color: '#fff',
            border: 'none',
            padding: '0.5rem 1rem',
            borderRadius: 6,
            cursor: 'pointer',
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      <div style={{ marginBottom: '1rem' }}>
        <h1 style={{ margin: '0 0 0.25rem' }}>Productivity Rates</h1>
        <p style={{ margin: 0, fontSize: '0.85rem', color: '#666' }}>
          Use these variable names in <code style={{ background: '#f0f0f0', padding: '1px 4px', borderRadius: 2 }}>compute_quantity</code> formulas — e.g.,{' '}
          <code style={{ background: '#f0f0f0', padding: '1px 4px', borderRadius: 2 }}>sqft / drywall_rate</code>
        </p>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e0e0e0', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem 0.75rem', fontWeight: 600, color: '#444' }}>Display Name</th>
              <th style={{ padding: '0.5rem 0.75rem', fontWeight: 600, color: '#444' }}>Variable Name</th>
              <th style={{ padding: '0.5rem 0.75rem', fontWeight: 600, color: '#444', width: 110 }}>sqft/hr</th>
              <th style={{ padding: '0.5rem 0.75rem', fontWeight: 600, color: '#444' }}>Description</th>
              <th style={{ padding: '0.5rem 0.75rem', fontWeight: 600, color: '#444', width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {rates.map((rate) => {
              const row = rowState[rate.id];
              if (!row) return null;
              return (
                <tr
                  key={rate.id}
                  style={{ borderBottom: '1px solid #f0f0f0', verticalAlign: 'top' }}
                >
                  {/* Display Name */}
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    <input
                      type="text"
                      value={row.displayName}
                      onChange={(e) => updateRow(rate.id, { displayName: e.target.value, saveStatus: null, saveMessage: null })}
                      aria-label={`Display name for ${rate.variableName}`}
                      style={{
                        width: '100%',
                        padding: '0.35rem 0.5rem',
                        borderRadius: 4,
                        border: '1px solid #ccc',
                        fontSize: '0.85rem',
                        boxSizing: 'border-box',
                      }}
                    />
                  </td>

                  {/* Variable Name (read-only) */}
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    <code
                      style={{
                        background: '#f0f0f0',
                        padding: '0.3rem 0.5rem',
                        borderRadius: 4,
                        fontSize: '0.82rem',
                        display: 'inline-block',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {rate.variableName}
                    </code>
                  </td>

                  {/* sqft/hr */}
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    <input
                      type="number"
                      value={row.sqftPerHour}
                      onChange={(e) => updateRow(rate.id, { sqftPerHour: e.target.value, saveStatus: null, saveMessage: null })}
                      min={0.01}
                      step="any"
                      aria-label={`sqft per hour for ${rate.variableName}`}
                      style={{
                        width: '100%',
                        padding: '0.35rem 0.5rem',
                        borderRadius: 4,
                        border: '1px solid #ccc',
                        fontSize: '0.85rem',
                        boxSizing: 'border-box',
                      }}
                    />
                  </td>

                  {/* Description */}
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    <input
                      type="text"
                      value={row.description}
                      onChange={(e) => updateRow(rate.id, { description: e.target.value, saveStatus: null, saveMessage: null })}
                      aria-label={`Description for ${rate.variableName}`}
                      placeholder="Optional description"
                      style={{
                        width: '100%',
                        padding: '0.35rem 0.5rem',
                        borderRadius: 4,
                        border: '1px solid #ccc',
                        fontSize: '0.85rem',
                        boxSizing: 'border-box',
                      }}
                    />
                  </td>

                  {/* Save button + feedback */}
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    <button
                      onClick={() => handleSave(rate)}
                      disabled={row.saving}
                      style={{
                        background: '#00a89d',
                        color: '#fff',
                        border: 'none',
                        padding: '0.35rem 0.75rem',
                        borderRadius: 4,
                        cursor: row.saving ? 'not-allowed' : 'pointer',
                        fontWeight: 600,
                        fontSize: '0.8rem',
                        opacity: row.saving ? 0.6 : 1,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {row.saving ? 'Saving…' : 'Save'}
                    </button>
                    {row.saveMessage && (
                      <div
                        role="status"
                        style={{
                          marginTop: '0.25rem',
                          fontSize: '0.75rem',
                          color: row.saveStatus === 'error' ? '#b71c1c' : '#2e7d32',
                        }}
                      >
                        {row.saveMessage}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}


// ---------------------------------------------------------------------------
// Product Ordering Tab
// ---------------------------------------------------------------------------

function ProductOrderingTab({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const [catalog, setCatalog] = useState<ProductCatalogEntry[]>([]);
  const [snapshotCatalog, setSnapshotCatalog] = useState<ProductCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [dropPosition, setDropPosition] = useState<'before' | 'after' | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const scrollSpeedRef = useRef(0);

  const startAutoScroll = useCallback(() => {
    const tick = () => {
      if (scrollSpeedRef.current !== 0) {
        window.scrollBy(0, scrollSpeedRef.current);
      }
      scrollRafRef.current = requestAnimationFrame(tick);
    };
    if (scrollRafRef.current === null) {
      scrollRafRef.current = requestAnimationFrame(tick);
    }
  }, []);

  const stopAutoScroll = useCallback(() => {
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    scrollSpeedRef.current = 0;
  }, []);

  const updateAutoScroll = useCallback((clientY: number) => {
    const vh = window.innerHeight;
    if (clientY < SCROLL_ZONE) {
      // Near top — scroll up (negative). Faster the closer to edge.
      const ratio = 1 - clientY / SCROLL_ZONE;
      scrollSpeedRef.current = -Math.round(MAX_SCROLL_SPEED * ratio);
      startAutoScroll();
    } else if (clientY > vh - SCROLL_ZONE) {
      // Near bottom — scroll down (positive). Faster the closer to edge.
      const ratio = 1 - (vh - clientY) / SCROLL_ZONE;
      scrollSpeedRef.current = Math.round(MAX_SCROLL_SPEED * ratio);
      startAutoScroll();
    } else {
      // Outside scroll zones — stop the loop entirely to avoid idle RAF ticks
      stopAutoScroll();
    }
  }, [startAutoScroll, stopAutoScroll]);

  // Clean up auto-scroll on unmount
  useEffect(() => () => stopAutoScroll(), [stopAutoScroll]);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => { onDirtyChange?.(false); };
  }, [dirty, onDirtyChange]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchCatalog();
      setCatalog(data);
      setSnapshotCatalog(data);
      setDirty(false);
    } catch {
      setLoadError('Failed to load product catalog. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const moveItem = (index: number, direction: 'up' | 'down') => {
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= catalog.length) return;
    const updated = [...catalog];
    [updated[index], updated[target]] = [updated[target], updated[index]];
    setCatalog(updated);
    setDirty(true);
    setSaveMessage(null);
    setSaveStatus(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      const orderedIds = catalog.map((c) => c.id);
      const updated = await reorderCatalog(orderedIds);
      setCatalog(updated);
      setSnapshotCatalog(updated);
      setDirty(false);
      setSaveStatus('success');
      setSaveMessage('Product ordering saved.');
    } catch {
      setSaveStatus('error');
      setSaveMessage('Failed to save ordering. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setCatalog(snapshotCatalog);
    setDirty(false);
    setSaveMessage(null);
    setSaveStatus(null);
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    updateAutoScroll(e.clientY);
    if (dragIndex === null || index === dragIndex) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position = e.clientY < midY ? 'before' : 'after';
    setDragOverIndex(index);
    setDropPosition(position);
  };

  const handleDrop = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    stopAutoScroll();
    if (dragIndex === null || dragIndex === index) {
      setDragIndex(null);
      setDragOverIndex(null);
      setDropPosition(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const after = e.clientY >= midY;

    const updated = [...catalog];
    const [moved] = updated.splice(dragIndex, 1);
    // Calculate insert position: after removing source, indices above dragIndex stay,
    // indices at/below dragIndex shift down by 1
    let insertAt: number;
    if (after) {
      insertAt = dragIndex < index ? index : index + 1;
    } else {
      insertAt = dragIndex < index ? index - 1 : index;
    }
    // Clamp to valid range
    insertAt = Math.max(0, Math.min(updated.length, insertAt));
    updated.splice(insertAt, 0, moved);
    setCatalog(updated);
    setDirty(true);
    setSaveMessage(null);
    setSaveStatus(null);
    setDragIndex(null);
    setDragOverIndex(null);
    setDropPosition(null);
  };

  const handleDragEnd = () => {
    stopAutoScroll();
    setDragIndex(null);
    setDragOverIndex(null);
    setDropPosition(null);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Only clear if leaving the row entirely (not entering a child element)
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOverIndex(null);
      setDropPosition(null);
    }
  };

  if (loading) return <p>Loading product catalog…</p>;

  if (loadError) {
    return (
      <div
        role="alert"
        style={{
          background: '#fff3e0',
          border: '1px solid #ffb74d',
          borderRadius: 8,
          padding: '1.25rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
        }}
      >
        <span style={{ color: '#e65100', fontWeight: 500 }}>{loadError}</span>
        <button
          onClick={load}
          style={{
            background: '#e65100',
            color: '#fff',
            border: 'none',
            padding: '0.5rem 1rem',
            borderRadius: 6,
            cursor: 'pointer',
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (catalog.length === 0) {
    return (
      <div style={{ textAlign: 'center', marginTop: '2rem', color: '#999' }}>
        <p>No products in the catalog yet.</p>
        <p style={{ fontSize: '0.85rem' }}>Add products via the Catalog & Templates page first.</p>
      </div>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
        <div>
          <h1 style={{ margin: '0 0 0.25rem' }}>Product Ordering</h1>
          <p style={{ margin: 0, fontSize: '0.85rem', color: '#666' }}>
            Set the default order products appear in new quotes. Items at the top of this list appear first on generated quotes.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
          {dirty && (
            <button
              onClick={handleReset}
              disabled={saving}
              style={{
                background: '#fff',
                color: '#666',
                border: '1px solid #ccc',
                padding: '0.5rem 1rem',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              Reset
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            style={{
              background: dirty ? '#00a89d' : '#ccc',
              color: '#fff',
              border: 'none',
              padding: '0.5rem 1rem',
              borderRadius: 6,
              cursor: dirty && !saving ? 'pointer' : 'not-allowed',
              fontWeight: 600,
            }}
          >
            {saving ? 'Saving…' : 'Save Order'}
          </button>
        </div>
      </div>

      {saveMessage && (
        <div
          style={{
            padding: '0.5rem 0.75rem',
            background: saveStatus === 'error' ? '#fdecea' : '#e8f5e9',
            color: saveStatus === 'error' ? '#b71c1c' : '#2e7d32',
            borderRadius: 4,
            fontSize: '0.85rem',
            marginBottom: '1rem',
          }}
        >
          {saveMessage}
        </div>
      )}

      <div
        style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}
        onDragOver={(e) => { e.preventDefault(); updateAutoScroll(e.clientY); }}
      >
        {catalog.map((entry, index) => (
          <div
            key={entry.id}
            onDragOver={(e) => handleDragOver(e, index)}
            onDrop={(e) => handleDrop(e, index)}
            onDragEnd={handleDragEnd}
            onDragLeave={handleDragLeave}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              padding: '0.65rem 0.75rem',
              background: '#fff',
              border: '1px solid #e0e0e0',
              borderRadius: 6,
              opacity: dragIndex === index ? 0.4 : 1,
              boxShadow: dragOverIndex === index
                ? (dropPosition === 'after'
                  ? 'inset 0 -2px 0 0 #00a89d, 0 1px 2px rgba(0,0,0,0.04)'
                  : 'inset 0 2px 0 0 #00a89d, 0 1px 2px rgba(0,0,0,0.04)')
                : '0 1px 2px rgba(0,0,0,0.04)',
              transition: 'opacity 0.15s ease',
            }}
          >
            {/* Drag handle */}
            <span
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              aria-label={`Drag to reorder ${entry.name}`}
              style={{
                width: 28,
                height: 28,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'grab',
                fontSize: '1rem',
                color: '#999',
                flexShrink: 0,
                userSelect: 'none',
                touchAction: 'none',
              }}
            >
              ☰
            </span>

            {/* Position number */}
            <span
              style={{
                width: 28,
                height: 28,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#f0f0f0',
                borderRadius: '50%',
                fontSize: '0.8rem',
                fontWeight: 600,
                color: '#666',
                flexShrink: 0,
              }}
            >
              {index + 1}
            </span>

            {/* Product info */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{entry.name}</div>
              {entry.description && (
                <div style={{ fontSize: '0.8rem', color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {entry.description}
                </div>
              )}
            </div>

            {/* Price */}
            <span style={{ fontSize: '0.85rem', color: '#555', flexShrink: 0 }}>
              ${entry.unitPrice.toFixed(2)}
            </span>

            {/* Move buttons */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
              <button
                onClick={() => moveItem(index, 'up')}
                disabled={index === 0}
                aria-label={`Move ${entry.name} up`}
                style={{
                  background: 'none',
                  border: '1px solid #ccc',
                  borderRadius: 3,
                  padding: '1px 6px',
                  cursor: index === 0 ? 'not-allowed' : 'pointer',
                  opacity: index === 0 ? 0.3 : 1,
                  fontSize: '0.75rem',
                  lineHeight: 1,
                }}
              >
                ▲
              </button>
              <button
                onClick={() => moveItem(index, 'down')}
                disabled={index === catalog.length - 1}
                aria-label={`Move ${entry.name} down`}
                style={{
                  background: 'none',
                  border: '1px solid #ccc',
                  borderRadius: 3,
                  padding: '1px 6px',
                  cursor: index === catalog.length - 1 ? 'not-allowed' : 'pointer',
                  opacity: index === catalog.length - 1 ? 0.3 : 1,
                  fontSize: '0.75rem',
                  lineHeight: 1,
                }}
              >
                ▼
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
