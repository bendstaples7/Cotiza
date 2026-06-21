import React, { useRef, useState } from 'react';
import type { QuoteLineItem, ProductCatalogEntry, Rule, QuantitySource, QuantityPredictionMeta } from 'shared';
import { fetchCatalog, updateCatalogEntry, updateDraft, fetchDraft } from '../api';

const MANUALLY_ADDED_SENTINEL = 'Manually added';

// ── Types ──

interface LineItemsTableProps {
  lineItems: QuoteLineItem[];
  unresolvedItems: QuoteLineItem[];
  isReadOnly: boolean;
  id: string;
  onLineItemsSaved: (updatedLineItems: QuoteLineItem[]) => void;
  onLoadDraft: () => Promise<void>;
  ruleById: Map<string, Rule>;
  groupNameByRuleId: Map<string, string>;
}

// ── Style helpers ──

const sectionStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  padding: '1rem 1.25rem',
  marginBottom: '1rem',
};

const sectionTitleStyle: React.CSSProperties = {
  margin: '0 0 0.75rem',
  fontSize: '1.1rem',
  fontWeight: 600,
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '0.5rem 0.75rem',
  borderBottom: '2px solid #e0e0e0',
  fontSize: '0.8rem',
  fontWeight: 600,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const tdStyle: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid #f0f0f0',
  fontSize: '0.9rem',
};

function confidenceBadgeStyle(score: number): React.CSSProperties {
  const bg = score >= 90 ? '#e0f7f5' : score >= 70 ? '#fff3e0' : '#fdecea';
  const color = score >= 90 ? '#00a89d' : score >= 70 ? '#e65100' : '#611a15';
  return {
    display: 'inline-block',
    padding: '0.15rem 0.5rem',
    borderRadius: 12,
    fontSize: '0.8rem',
    fontWeight: 600,
    background: bg,
    color,
  };
}

function getQuantitySourceLabel(source: QuantitySource): string {
  switch (source) {
    case 'ai_estimate': return 'AI estimate';
    case 'historical_prediction': return 'Historical prediction';
    case 'rule_override': return 'Rule override';
    default: return '';
  }
}

function getQuantitySourceTooltip(prediction: QuantityPredictionMeta): string {
  const label = getQuantitySourceLabel(prediction.quantitySource);
  if (prediction.quantitySource === 'historical_prediction') {
    const parts = [`${label} (confidence: ${prediction.confidenceScore}%)`];
    if (prediction.sourceQuoteNumbers.length > 0) {
      parts.push(`Source quotes: ${prediction.sourceQuoteNumbers.join(', ')}`);
    }
    return parts.join('\n');
  }
  return label;
}

function quantitySourceBadgeStyle(source: QuantitySource): React.CSSProperties {
  let bg: string;
  let color: string;
  switch (source) {
    case 'historical_prediction':
      bg = '#e3f2fd';
      color = '#1565c0';
      break;
    case 'rule_override':
      bg = '#fce4ec';
      color = '#c62828';
      break;
    case 'ai_estimate':
    default:
      bg = '#f3e5f5';
      color = '#6a1b9a';
      break;
  }
  return {
    display: 'inline-block',
    padding: '0.1rem 0.4rem',
    borderRadius: 8,
    fontSize: '0.65rem',
    fontWeight: 600,
    background: bg,
    color,
    whiteSpace: 'nowrap',
    cursor: source === 'historical_prediction' ? 'help' : 'default',
  };
}

// ── Inline style objects (from QuoteDraftPage) ──

const editableCellStyle: React.CSSProperties = {
  cursor: 'pointer',
  padding: '0.2rem 0.45rem',
  borderRadius: 4,
  border: '1px dashed #ccc',
  background: '#fafafa',
  transition: 'border-color 0.15s, background 0.15s',
  display: 'inline-block',
  minWidth: 40,
  textAlign: 'right',
};

const inlineEditInputStyle: React.CSSProperties = {
  width: 80,
  padding: '0.3rem 0.5rem',
  border: '1px solid #00a89d',
  borderRadius: 4,
  fontSize: '0.9rem',
  textAlign: 'right',
  outline: 'none',
  boxSizing: 'border-box',
};

const inlineEditTextInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.3rem 0.5rem',
  border: '1px solid #00a89d',
  borderRadius: 4,
  fontSize: '0.9rem',
  textAlign: 'left',
  outline: 'none',
  boxSizing: 'border-box' as const,
};

const deleteItemBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: '0.85rem',
  color: '#bbb',
  padding: '0.15rem 0.3rem',
  borderRadius: 4,
  lineHeight: 1,
  transition: 'color 0.15s',
};

const infoIconBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: '1rem',
  padding: '0.15rem 0.35rem',
  borderRadius: 4,
  color: '#00a89d',
  lineHeight: 1,
};

const dragHandleStyle: React.CSSProperties = {
  color: '#ccc',
  fontSize: '1rem',
  cursor: 'grab',
  userSelect: 'none',
};

const lineItemDescStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  color: '#888',
  marginTop: '0.15rem',
  lineHeight: 1.3,
};

const undoToastStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  padding: '0.6rem 1rem',
  marginBottom: '0.75rem',
  background: '#323232',
  color: '#fff',
  borderRadius: 8,
  fontSize: '0.875rem',
};

const undoBtnStyle: React.CSSProperties = {
  background: 'none',
  border: '1px solid rgba(255,255,255,0.5)',
  color: '#fff',
  borderRadius: 5,
  padding: '0.25rem 0.75rem',
  cursor: 'pointer',
  fontSize: '0.85rem',
  fontWeight: 600,
  whiteSpace: 'nowrap',
};

const savingIndicatorStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.4rem',
  fontSize: '0.8rem',
  color: '#00a89d',
  padding: '0.35rem 0',
};

const smallSpinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 14,
  height: 14,
  border: '2px solid rgba(255,255,255,0.3)',
  borderTopColor: '#fff',
  borderRadius: '50%',
  animation: 'spin 0.6s linear infinite',
};

const addItemBtnStyle: React.CSSProperties = {
  marginTop: '0.5rem',
  padding: '0.4rem 0.9rem',
  background: 'none',
  border: '1px dashed #00a89d',
  borderRadius: 6,
  color: '#00a89d',
  fontSize: '0.85rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const addRowContainerStyle: React.CSSProperties = {
  marginTop: '0.5rem',
  padding: '0.75rem',
  background: '#f9f9f9',
  borderRadius: 8,
  border: '1px solid #e0e0e0',
};

const addRowCloseBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: '1rem',
  color: '#888',
  padding: '0 0.25rem',
  lineHeight: 1,
};

const catalogSearchInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.5rem 0.75rem',
  border: '1px solid #ccc',
  borderRadius: 6,
  fontSize: '0.9rem',
  boxSizing: 'border-box',
};

const catalogDropdownStyle: React.CSSProperties = {
  position: 'absolute',
  top: '100%',
  left: 0,
  right: 0,
  background: '#fff',
  border: '1px solid #e0e0e0',
  borderRadius: 6,
  boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
  zIndex: 10,
  maxHeight: 240,
  overflowY: 'auto',
  marginTop: 2,
};

const catalogDropdownItemStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  width: '100%',
  padding: '0.5rem 0.75rem',
  background: 'none',
  border: 'none',
  borderBottom: '1px solid #f0f0f0',
  cursor: 'pointer',
  fontSize: '0.85rem',
  textAlign: 'left',
};

const customItemLinkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#00a89d',
  cursor: 'pointer',
  fontSize: '0.85rem',
  fontWeight: 600,
  padding: 0,
  textDecoration: 'underline',
};

const customFormStyle: React.CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'center',
  marginTop: '0.5rem',
  flexWrap: 'wrap',
};

const customFormInputStyle: React.CSSProperties = {
  padding: '0.4rem 0.6rem',
  border: '1px solid #ccc',
  borderRadius: 6,
  fontSize: '0.85rem',
  flex: 1,
  minWidth: 80,
};

const updateCatalogLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  fontSize: '0.7rem',
  color: '#888',
  marginTop: '0.25rem',
  cursor: 'pointer',
  userSelect: 'none',
};

const ruleTraceabilityPanelStyle: React.CSSProperties = {
  textAlign: 'left',
  background: '#f8f9fa',
  border: '1px solid #e0e0e0',
  borderRadius: 6,
  padding: '0.75rem 1rem',
  margin: '0.25rem 0.75rem 0.5rem',
  cursor: 'pointer',
};

const ruleGroupHeadingStyle: React.CSSProperties = {
  margin: '0 0 0.25rem',
  fontSize: '0.8rem',
  fontWeight: 600,
  color: '#555',
  textTransform: 'uppercase',
  letterSpacing: '0.3px',
};

const ruleEntryStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.1rem',
  padding: '0.25rem 0 0.25rem 0.5rem',
  borderLeft: '2px solid #00a89d',
  marginBottom: '0.35rem',
};

const ruleNameStyle: React.CSSProperties = {
  fontSize: '0.8rem',
  fontWeight: 600,
  color: '#333',
};

const ruleDescStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  color: '#666',
};

const noRulesTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '0.8rem',
  color: '#888',
  fontStyle: 'italic',
};

// ── Sub-component: LineItemRationalePanel ──

function LineItemRationalePanel({
  item,
  appliedGrouped,
}: {
  item: QuoteLineItem;
  appliedGrouped: Map<string, Rule[]>;
}) {
  const r = item.rationale;
  const hasRules = appliedGrouped.size > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div>
        <p style={ruleGroupHeadingStyle}>Why was this item added?</p>
        {r?.addedByRuleName ? (
          <div style={ruleEntryStyle}>
            <span style={ruleNameStyle}>Rule: {r.addedByRuleName}</span>
            {r.conditionSummary && (
              <span style={ruleDescStyle}>Condition: {r.conditionSummary}</span>
            )}
          </div>
        ) : item.originalText && item.originalText !== MANUALLY_ADDED_SENTINEL ? (
          <p style={{ ...noRulesTextStyle, fontStyle: 'normal' }}>
            AI matched from customer request: &ldquo;{item.originalText}&rdquo;
          </p>
        ) : item.originalText === MANUALLY_ADDED_SENTINEL ? (
          <p style={noRulesTextStyle}>Manually added by user</p>
        ) : (
          <p style={noRulesTextStyle}>AI-generated — no specific rule triggered this item</p>
        )}
      </div>

      <div>
        <p style={ruleGroupHeadingStyle}>Why is the quantity {item.quantity}?</p>
        {r?.quantityFormula ? (
          <div style={ruleEntryStyle}>
            <span style={ruleNameStyle}>
              Formula: <code style={{ fontFamily: 'monospace', background: '#f5f5f5', padding: '0.1rem 0.3rem', borderRadius: 3 }}>{r.quantityFormula}</code>
            </span>
            {r.quantityVariables && Object.keys(r.quantityVariables).length > 0 && (
              <div style={{ marginTop: '0.3rem' }}>
                <span style={ruleDescStyle}>Variables used:</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.2rem' }}>
                  {Object.entries(r.quantityVariables).map(([key, val]) => (
                    <span key={key} style={{ fontFamily: 'monospace', fontSize: '0.78rem', background: '#e8f5e9', color: '#2e7d32', padding: '0.1rem 0.4rem', borderRadius: 4 }}>
                      {key} = {typeof val === 'number' ? val.toLocaleString() : val}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {r.quantityBefore != null && r.quantityAfter != null && (
              <span style={{ ...ruleDescStyle, marginTop: '0.25rem', display: 'block' }}>
                Result: {r.quantityBefore} → <strong>{r.quantityAfter}</strong>
              </span>
            )}
          </div>
        ) : item.quantityPrediction ? (
          <p style={noRulesTextStyle}>
            {item.quantityPrediction.quantitySource === 'historical_prediction'
              ? `Predicted from ${item.quantityPrediction.sourceQuoteNumbers.length} similar past quote(s) (confidence: ${item.quantityPrediction.confidenceScore}%)`
              : item.quantityPrediction.quantitySource === 'rule_override'
              ? 'Set by a business rule'
              : 'AI estimate based on customer request'}
          </p>
        ) : (
          <p style={noRulesTextStyle}>AI estimate based on customer request</p>
        )}
      </div>

      {hasRules && (
        <div>
          <p style={ruleGroupHeadingStyle}>Applied Rules</p>
          {Array.from(appliedGrouped.entries()).map(([groupName, rules]) => (
            <div key={groupName} style={{ marginBottom: '0.4rem' }}>
              <span style={{ fontSize: '0.75rem', color: '#888', fontWeight: 600 }}>{groupName}</span>
              {rules.map((rule) => (
                <div key={rule.id} style={ruleEntryStyle}>
                  <span style={ruleNameStyle}>{rule.name}</span>
                  {rule.description && <span style={ruleDescStyle}>{rule.description}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {r?.catalogScope && (
        <div>
          <p style={ruleGroupHeadingStyle}>Catalog Scope</p>
          <span style={{
            display: 'inline-block',
            padding: '0.15rem 0.5rem',
            borderRadius: 10,
            fontSize: '0.75rem',
            fontWeight: 600,
            background: '#e8f5e9',
            color: '#2e7d32',
          }}>
            scope: {r.catalogScope}
          </span>
        </div>
      )}

      {r?.spaceContext && (
        <div>
          <p style={ruleGroupHeadingStyle}>Space Context</p>
          <div style={ruleEntryStyle}>
            <span style={ruleNameStyle}>{r.spaceContext.normalizedLabel}</span>
            <span style={ruleDescStyle}>
              {r.spaceContext.sqftUsed.toLocaleString()} sq ft
              {' · '}
              {r.spaceContext.sqftSource === 'explicit' ? 'explicitly stated' : r.spaceContext.sqftSource === 'estimated' ? 'estimated' : 'whole property'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Component ──

export default function LineItemsTable({
  lineItems,
  unresolvedItems,
  isReadOnly,
  id,
  onLineItemsSaved,
  onLoadDraft,
  ruleById,
  groupNameByRuleId,
}: LineItemsTableProps) {
  // Inline editing state
  const [editingCell, setEditingCell] = useState<{ itemId: string; field: 'quantity' | 'unitPrice' | 'productName' | 'description' } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [updateCatalogChecked, setUpdateCatalogChecked] = useState(false);
  const [saving, setSaving] = useState(false);

  // Drag-to-reorder state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Pending delete (undo) state
  const [pendingDelete, setPendingDelete] = useState<{ item: QuoteLineItem; timerId: ReturnType<typeof setTimeout> } | null>(null);

  // Add line item state
  const [showAddRow, setShowAddRow] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogResults, setCatalogResults] = useState<ProductCatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [allCatalog, setAllCatalog] = useState<ProductCatalogEntry[] | null>(null);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customQty, setCustomQty] = useState('1');
  const [customPrice, setCustomPrice] = useState('');

  // Rule expanded rows
  const [expandedRuleRows, setExpandedRuleRows] = useState<Set<string>>(new Set());

  const pendingDeleteCommitRef = useRef<Promise<void>>(Promise.resolve());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const effectiveReadOnly = isReadOnly;

  // Build applied rules lookup
  const getAppliedRulesGrouped = (item: QuoteLineItem): Map<string, Rule[]> => {
    const grouped = new Map<string, Rule[]>();
    if (!item.ruleIdsApplied || item.ruleIdsApplied.length === 0) return grouped;
    for (const ruleId of item.ruleIdsApplied) {
      const rule = ruleById.get(ruleId);
      if (!rule) continue;
      const groupName = groupNameByRuleId.get(ruleId) ?? 'Unknown';
      const list = grouped.get(groupName) ?? [];
      list.push(rule);
      grouped.set(groupName, list);
    }
    return grouped;
  };

  // ── Inline editing handlers ──

  const startEditing = (itemId: string, field: 'quantity' | 'unitPrice' | 'productName' | 'description', currentValue: number | string) => {
    if (effectiveReadOnly) return;
    setEditingCell({ itemId, field });
    setEditValue(String(currentValue));
    setUpdateCatalogChecked(false);
    setTimeout(() => editInputRef.current?.select(), 0);
  };

  const saveEdit = async () => {
    if (!editingCell) return;
    const { field, itemId } = editingCell;
    const editingItem = lineItems.find((i) => i.id === itemId);
    let updatedLineItems: QuoteLineItem[];
    if (field === 'productName' || field === 'description') {
      updatedLineItems = lineItems.map((item) =>
        item.id === itemId ? { ...item, [field]: editValue } : item,
      );
    } else {
      const numVal = parseFloat(editValue);
      if (isNaN(numVal) || numVal < 0) {
        setEditingCell(null);
        return;
      }
      updatedLineItems = lineItems.map((item) =>
        item.id === itemId
          ? { ...item, [field]: field === 'quantity' ? Math.max(1, Math.round(numVal)) : Math.round(numVal * 100) / 100 }
          : item,
      );
    }
    const shouldUpdateCatalog = updateCatalogChecked && editingItem?.productCatalogEntryId && (field === 'productName' || field === 'description');
    setEditingCell(null);
    setUpdateCatalogChecked(false);
    setSaving(true);
    try {
      const updated = await updateDraft(id, { lineItems: updatedLineItems, unresolvedItems: unresolvedItems });
      onLineItemsSaved(updated.lineItems);
      if (shouldUpdateCatalog && editingItem?.productCatalogEntryId) {
        const catalogKey = field === 'productName' ? 'name' : 'description';
        try {
          await updateCatalogEntry(editingItem.productCatalogEntryId, { [catalogKey]: editValue });
        } catch (catalogErr) {
          console.warn('[LineItemsTable] Failed to update catalog entry:', catalogErr);
        }
      }
    } catch {
      await onLoadDraft();
    } finally {
      setSaving(false);
    }
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
    if (e.key === 'Escape') { setEditingCell(null); }
  };

  const handleReorder = async (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || effectiveReadOnly) return;
    const items = [...lineItems];
    const [moved] = items.splice(fromIdx, 1);
    items.splice(toIdx, 0, moved);
    setSaving(true);
    try {
      const updated = await updateDraft(id, { lineItems: items, unresolvedItems: unresolvedItems });
      onLineItemsSaved(updated.lineItems);
    } catch {
      await onLoadDraft();
    } finally {
      setSaving(false);
    }
  };

  const toggleRuleRow = (itemId: string) => {
    setExpandedRuleRows((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  const deleteLineItem = (itemId: string) => {
    if (effectiveReadOnly) return;
    const itemToDelete = lineItems.find((item) => item.id === itemId);
    if (!itemToDelete) return;

    // Commit any existing pending delete before starting a new one (serialized)
    if (pendingDelete) {
      clearTimeout(pendingDelete.timerId);
      const prev = pendingDelete;
      setPendingDelete(null);
      pendingDeleteCommitRef.current = pendingDeleteCommitRef.current.then(async () => {
        const currentDraft = await fetchDraft(id);
        const withoutPrev = currentDraft.lineItems.filter((i) => i.id !== prev.item.id);
        const updated = await updateDraft(id, { lineItems: withoutPrev, unresolvedItems: currentDraft.unresolvedItems });
        onLineItemsSaved(updated.lineItems);
      }).catch(() => onLoadDraft());
    }

    // Optimistically remove from view
    const filteredItems = lineItems.filter((i) => i.id !== itemId);
    onLineItemsSaved(filteredItems);

    // Start 5-second undo window — on expiry, commit the delete to the API
    const timerId = setTimeout(() => {
      pendingDeleteCommitRef.current = pendingDeleteCommitRef.current.then(async () => {
        setPendingDelete(null);
        setSaving(true);
        try {
          const currentDraft = await fetchDraft(id);
          const withoutItem = currentDraft.lineItems.filter((i) => i.id !== itemId);
          const updated = await updateDraft(id, { lineItems: withoutItem, unresolvedItems: currentDraft.unresolvedItems });
          onLineItemsSaved(updated.lineItems);
        } catch {
          await onLoadDraft();
        } finally {
          setSaving(false);
        }
      });
    }, 5000);

    setPendingDelete({ item: itemToDelete, timerId });
  };

  const handleUndoDelete = () => {
    if (!pendingDelete) return;
    clearTimeout(pendingDelete.timerId);
    // Restore the item
    onLineItemsSaved([...lineItems, pendingDelete.item]);
    setPendingDelete(null);
  };

  // ── Catalog / add item handlers ──

  const loadCatalog = async () => {
    if (allCatalog) return allCatalog;
    setCatalogLoading(true);
    try {
      const catalog = await fetchCatalog();
      setAllCatalog(catalog);
      return catalog;
    } catch {
      return [];
    } finally {
      setCatalogLoading(false);
    }
  };

  const handleCatalogSearch = (value: string) => {
    setCatalogSearch(value);
    setShowCustomForm(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!value.trim()) {
      setCatalogResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const catalog = await loadCatalog();
      const lower = value.toLowerCase();
      const matches = catalog.filter(
        (entry) => entry.name.toLowerCase().includes(lower) || (entry.description && entry.description.toLowerCase().includes(lower)),
      );
      setCatalogResults(matches);
    }, 300);
  };

  const addCatalogItem = async (entry: ProductCatalogEntry) => {
    const newItem: QuoteLineItem = {
      id: crypto.randomUUID(),
      productCatalogEntryId: entry.id,
      productName: entry.name,
      description: entry.description ?? '',
      quantity: 1,
      unitPrice: entry.unitPrice,
      confidenceScore: 100,
      originalText: entry.name,
      resolved: true,
    };
    const updatedLineItems = [...lineItems, newItem];
    setSaving(true);
    try {
      const updated = await updateDraft(id, { lineItems: updatedLineItems, unresolvedItems: unresolvedItems });
      onLineItemsSaved(updated.lineItems);
      setShowAddRow(false);
      setCatalogSearch('');
      setCatalogResults([]);
    } catch {
      await onLoadDraft();
    } finally {
      setSaving(false);
    }
  };

  const addCustomItem = async () => {
    const name = customName.trim();
    const qty = parseInt(customQty, 10);
    const price = parseFloat(customPrice);
    if (!name || isNaN(qty) || qty < 1 || isNaN(price) || price < 0) return;
    const newItem: QuoteLineItem = {
      id: crypto.randomUUID(),
      productCatalogEntryId: null,
      productName: name,
      description: '',
      quantity: qty,
      unitPrice: Math.round(price * 100) / 100,
      confidenceScore: 100,
      originalText: MANUALLY_ADDED_SENTINEL,
      resolved: true,
    };
    const updatedLineItems = [...lineItems, newItem];
    setSaving(true);
    try {
      const updated = await updateDraft(id, { lineItems: updatedLineItems, unresolvedItems: unresolvedItems });
      onLineItemsSaved(updated.lineItems);
      setShowAddRow(false);
      setShowCustomForm(false);
      setCustomName('');
      setCustomQty('1');
      setCustomPrice('');
      setCatalogSearch('');
      setCatalogResults([]);
    } catch {
      await onLoadDraft();
    } finally {
      setSaving(false);
    }
  };

  const isItemLocked = (itemId: string): boolean => {
    return false;
  };

  return (
    <div style={sectionStyle}>
      <h2 style={sectionTitleStyle}>Line Items</h2>

      {/* Undo delete toast */}
      {pendingDelete && (
        <div style={undoToastStyle} role="status" aria-live="polite">
          <span>
            <strong>{pendingDelete.item.productName}</strong> removed.
          </span>
          <button onClick={handleUndoDelete} style={undoBtnStyle}>
            Undo
          </button>
        </div>
      )}

      {lineItems.length === 0 ? (
        <p style={{ color: '#888', margin: '0.5rem 0' }}>No line items.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                {!effectiveReadOnly && (
                  <th style={{ ...thStyle, width: 24, padding: '0.5rem 0.25rem' }}></th>
                )}
                <th style={thStyle}>Product Name</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Quantity</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Unit Price</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Total</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Confidence</th>
                <th style={{ ...thStyle, textAlign: 'center', width: 40 }}>Rules</th>
                {!effectiveReadOnly && (
                  <th style={{ ...thStyle, textAlign: 'center', width: 36 }}></th>
                )}
              </tr>
            </thead>
            <tbody>
              {lineItems.map((item: QuoteLineItem, idx: number) => {
                const isExpanded = expandedRuleRows.has(item.id);
                const locked = isItemLocked(item.id);
                const isEditingQty = editingCell?.itemId === item.id && editingCell.field === 'quantity';
                const isEditingPrice = editingCell?.itemId === item.id && editingCell.field === 'unitPrice';
                const isEditingName = editingCell?.itemId === item.id && editingCell.field === 'productName';
                const isEditingDesc = editingCell?.itemId === item.id && editingCell.field === 'description';
                return (
                  <React.Fragment key={item.id}>
                    <tr
                      draggable={!effectiveReadOnly}
                      onDragStart={effectiveReadOnly ? undefined : (e) => { setDragIndex(idx); e.dataTransfer.effectAllowed = 'move'; }}
                      onDragOver={effectiveReadOnly ? undefined : (e) => { e.preventDefault(); setDragOverIndex(idx); }}
                      onDragLeave={effectiveReadOnly ? undefined : () => setDragOverIndex(null)}
                      onDrop={effectiveReadOnly ? undefined : (e) => { e.preventDefault(); handleReorder(dragIndex!, idx); setDragIndex(null); setDragOverIndex(null); }}
                      onDragEnd={effectiveReadOnly ? undefined : () => { setDragIndex(null); setDragOverIndex(null); }}
                      style={{
                        verticalAlign: 'top',
                        cursor: effectiveReadOnly ? 'default' : 'grab',
                        opacity: dragIndex === idx ? 0.4 : 1,
                        borderTop: dragOverIndex === idx ? '2px solid #00a89d' : undefined,
                      }}
                    >
                      {!effectiveReadOnly && (
                        <td style={{ ...tdStyle, padding: '0.5rem 0.25rem', textAlign: 'center' }}>
                          <span style={dragHandleStyle}>⠿</span>
                        </td>
                      )}
                      <td style={tdStyle}>
                        {isEditingName ? (
                          <div>
                            <input
                              ref={editInputRef}
                              type="text"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onBlur={() => setTimeout(saveEdit, 150)}
                              onKeyDown={handleEditKeyDown}
                              style={inlineEditTextInputStyle}
                              autoFocus
                              aria-label={`Edit product name for ${item.productName}`}
                            />
                            {item.productCatalogEntryId && (
                              <label style={updateCatalogLabelStyle}>
                                <input
                                  type="checkbox"
                                  checked={updateCatalogChecked}
                                  onChange={(e) => setUpdateCatalogChecked(e.target.checked)}
                                  style={{ marginRight: '0.3rem' }}
                                />
                                Update in catalog
                              </label>
                            )}
                          </div>
                        ) : (
                          <div>
                            {effectiveReadOnly || locked ? (
                              <span style={{ textAlign: 'left', display: 'inline-block', minWidth: 80, color: '#333' }}>
                                {item.productName}
                              </span>
                            ) : (
                              <span
                                onClick={() => startEditing(item.id, 'productName', item.productName)}
                                style={{ ...editableCellStyle, textAlign: 'left', display: 'inline-block', minWidth: 80 }}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => { if (e.key === 'Enter') startEditing(item.id, 'productName', item.productName); }}
                                aria-label={`Product name: ${item.productName}. Click to edit.`}
                              >
                                {item.productName}
                              </span>
                            )}
                          </div>
                        )}
                        {isEditingDesc ? (
                          <div>
                            <input
                              ref={editInputRef}
                              type="text"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onBlur={() => setTimeout(saveEdit, 150)}
                              onKeyDown={handleEditKeyDown}
                              style={{ ...inlineEditTextInputStyle, fontSize: '0.75rem', marginTop: '0.15rem' }}
                              autoFocus
                              aria-label={`Edit description for ${item.productName}`}
                            />
                            {item.productCatalogEntryId && (
                              <label style={updateCatalogLabelStyle}>
                                <input
                                  type="checkbox"
                                  checked={updateCatalogChecked}
                                  onChange={(e) => setUpdateCatalogChecked(e.target.checked)}
                                  style={{ marginRight: '0.3rem' }}
                                />
                                Update in catalog
                              </label>
                            )}
                          </div>
                        ) : item.description ? (
                          effectiveReadOnly || locked ? (
                            <div style={{ ...lineItemDescStyle, display: 'inline-block' }}>
                              {item.description}
                            </div>
                          ) : (
                            <div
                              onClick={() => startEditing(item.id, 'description', item.description)}
                              style={{ ...lineItemDescStyle, cursor: 'pointer', borderBottom: '1px dashed #ccc', display: 'inline-block' }}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(e) => { if (e.key === 'Enter') startEditing(item.id, 'description', item.description); }}
                              aria-label={`Description: ${item.description}. Click to edit.`}
                            >
                              {item.description}
                            </div>
                          )
                        ) : effectiveReadOnly || locked ? null : (
                          <div
                            onClick={() => startEditing(item.id, 'description', '')}
                            style={{ fontSize: '0.75rem', color: '#bbb', cursor: 'pointer', marginTop: '0.15rem' }}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter') startEditing(item.id, 'description', ''); }}
                            aria-label={`Add description for ${item.productName}`}
                          >
                            + Add description
                          </div>
                        )}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', padding: isEditingQty ? '0.3rem 0.5rem' : undefined }}>
                        {isEditingQty ? (
                          <input
                            ref={editInputRef}
                            type="number"
                            min={1}
                            step={1}
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={saveEdit}
                            onKeyDown={handleEditKeyDown}
                            style={inlineEditInputStyle}
                            autoFocus
                            aria-label={`Edit quantity for ${item.productName}`}
                          />
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.2rem' }}>
                            {effectiveReadOnly || locked ? (
                              <span style={{ color: '#333' }}>{item.quantity}</span>
                            ) : (
                              <span
                                onClick={() => startEditing(item.id, 'quantity', item.quantity)}
                                style={editableCellStyle}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => { if (e.key === 'Enter') startEditing(item.id, 'quantity', item.quantity); }}
                                aria-label={`Quantity: ${item.quantity}. Click to edit.`}
                              >
                                {item.quantity}
                              </span>
                            )}
                            {item.quantityPrediction && (
                              <span
                                style={quantitySourceBadgeStyle(item.quantityPrediction.quantitySource)}
                                title={getQuantitySourceTooltip(item.quantityPrediction)}
                                aria-label={getQuantitySourceTooltip(item.quantityPrediction)}
                              >
                                {getQuantitySourceLabel(item.quantityPrediction.quantitySource)}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', padding: isEditingPrice ? '0.3rem 0.5rem' : undefined }}>
                        {isEditingPrice ? (
                          <input
                            ref={editInputRef}
                            type="number"
                            min={0}
                            step={0.01}
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={saveEdit}
                            onKeyDown={handleEditKeyDown}
                            style={inlineEditInputStyle}
                            autoFocus
                            aria-label={`Edit unit price for ${item.productName}`}
                          />
                        ) : (
                          <span
                            onClick={() => startEditing(item.id, 'unitPrice', item.unitPrice)}
                            style={effectiveReadOnly || locked ? { cursor: 'default' } : editableCellStyle}
                            role={effectiveReadOnly || locked ? undefined : 'button'}
                            tabIndex={effectiveReadOnly || locked ? undefined : 0}
                            onKeyDown={effectiveReadOnly || locked ? undefined : (e) => { if (e.key === 'Enter') startEditing(item.id, 'unitPrice', item.unitPrice); }}
                            aria-label={`Unit price: $${item.unitPrice.toFixed(2)}.${effectiveReadOnly || locked ? '' : ' Click to edit.'}`}
                          >
                            ${item.unitPrice.toFixed(2)}
                          </span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                        ${(item.quantity * item.unitPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        <span style={confidenceBadgeStyle(item.confidenceScore)}>
                          {item.confidenceScore}%
                        </span>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'center' }}>
                        <button
                          onClick={() => toggleRuleRow(item.id)}
                          style={infoIconBtnStyle}
                          aria-label={isExpanded ? 'Hide applied rules' : 'Show applied rules'}
                          aria-expanded={isExpanded}
                          title="View applied rules"
                        >
                          ℹ
                        </button>
                      </td>
                      {!effectiveReadOnly && (
                        <td style={{ ...tdStyle, textAlign: 'center', padding: '0.5rem 0.25rem' }}>
                          <button
                            onClick={() => deleteLineItem(item.id)}
                            style={deleteItemBtnStyle}
                            aria-label={`Delete ${item.productName}`}
                            title="Remove line item"
                          >
                            ✕
                          </button>
                        </td>
                      )}
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td
                          colSpan={effectiveReadOnly ? 6 : 8}
                          style={{ padding: 0, border: 'none' }}
                        >
                          <div
                            onClick={() => toggleRuleRow(item.id)}
                            style={ruleTraceabilityPanelStyle}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRuleRow(item.id); } }}
                            aria-label="Click to close rules panel"
                          >
                            <LineItemRationalePanel item={item} appliedGrouped={getAppliedRulesGrouped(item)} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={effectiveReadOnly ? 3 : 4} style={{ padding: '0.6rem 0.75rem', borderTop: '2px solid #e0e0e0', fontWeight: 700, fontSize: '0.9rem', textAlign: 'right', color: '#333' }}>
                  Quote Total
                </td>
                <td style={{ padding: '0.6rem 0.75rem', borderTop: '2px solid #e0e0e0', fontWeight: 700, fontSize: '0.95rem', textAlign: 'right', color: '#00a89d' }}>
                  ${lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td colSpan={effectiveReadOnly ? 2 : 3} style={{ borderTop: '2px solid #e0e0e0' }} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Saving indicator */}
      {saving && (
        <div style={savingIndicatorStyle} role="status" aria-live="polite">
          <span style={smallSpinnerStyle} /> Saving…
        </div>
      )}

      {/* Add line item button and form */}
      {!effectiveReadOnly && (
        <>
          {!showAddRow ? (
            <button
              onClick={() => { setShowAddRow(true); loadCatalog(); }}
              style={addItemBtnStyle}
              aria-label="Add line item"
            >
              + Add Item
            </button>
          ) : (
            <div style={addRowContainerStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <span style={{ fontWeight: 600, fontSize: '0.85rem', color: '#555' }}>Add Line Item</span>
                <button onClick={() => { setShowAddRow(false); setCatalogSearch(''); setCatalogResults([]); setShowCustomForm(false); }} style={addRowCloseBtnStyle} aria-label="Cancel adding item">✕</button>
              </div>
              <div style={{ position: 'relative' }}>
                <input
                  type="text"
                  value={catalogSearch}
                  onChange={(e) => handleCatalogSearch(e.target.value)}
                  placeholder="Search product catalog…"
                  style={catalogSearchInputStyle}
                  aria-label="Search product catalog"
                  autoFocus
                />
                {catalogLoading && <span style={{ fontSize: '0.75rem', color: '#888', marginLeft: '0.5rem' }}>Loading catalog…</span>}
                {catalogSearch.trim() && catalogResults.length > 0 && (
                  <div style={catalogDropdownStyle}>
                    {catalogResults.slice(0, 8).map((entry) => (
                      <button
                        key={entry.id}
                        onClick={() => addCatalogItem(entry)}
                        style={catalogDropdownItemStyle}
                      >
                        <span style={{ fontWeight: 500 }}>{entry.name}</span>
                        <span style={{ color: '#888', fontSize: '0.8rem' }}>${entry.unitPrice.toFixed(2)}</span>
                      </button>
                    ))}
                  </div>
                )}
                {catalogSearch.trim() && !catalogLoading && catalogResults.length === 0 && allCatalog !== null && (
                  <div style={catalogDropdownStyle}>
                    <div style={{ padding: '0.5rem 0.75rem', fontSize: '0.85rem', color: '#888' }}>
                      No catalog matches.{' '}
                      <button onClick={() => { setShowCustomForm(true); setCatalogResults([]); }} style={customItemLinkStyle}>
                        Add custom item
                      </button>
                    </div>
                  </div>
                )}
              </div>
              {showCustomForm && (
                <div style={customFormStyle}>
                  <input
                    type="text"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder="Item name"
                    style={customFormInputStyle}
                    aria-label="Custom item name"
                  />
                  <input
                    type="number"
                    value={customQty}
                    onChange={(e) => setCustomQty(e.target.value)}
                    placeholder="Qty"
                    min={1}
                    step={1}
                    style={{ ...customFormInputStyle, width: 70 }}
                    aria-label="Custom item quantity"
                  />
                  <input
                    type="number"
                    value={customPrice}
                    onChange={(e) => setCustomPrice(e.target.value)}
                    placeholder="Unit price"
                    min={0}
                    step={0.01}
                    style={{ ...customFormInputStyle, width: 100 }}
                    aria-label="Custom item unit price"
                  />
                  <button
                    onClick={addCustomItem}
                    disabled={!customName.trim() || !customPrice || saving}
                    style={{
                      padding: '0.4rem 0.9rem',
                      background: '#00a89d',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      fontSize: '0.85rem',
                      fontWeight: 600,
                      opacity: customName.trim() && customPrice && !saving ? 1 : 0.5,
                      cursor: customName.trim() && customPrice && !saving ? 'pointer' : 'not-allowed',
                    }}
                  >
                    Add
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}