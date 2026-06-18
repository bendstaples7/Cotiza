import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import type { QuoteDraft, QuoteLineItem, LineItemRationale, GenerationTrace, ErrorResponse, RuleGroupWithRules, Rule, ProductCatalogEntry, ActionItem, QuantityPredictionMeta, QuantitySource, ResolutionConfidence, ResolutionTier, DeathclockState } from 'shared';
import { fetchDraft, reviseDraft, fetchRules, fetchJobberRequestDetail, saveTemplateFromDraft, updateDraft, patchDraftSqft, fetchCatalog, updateCatalogEntry, pushDraftToJobber, pushDraftUpdateToJobber, fetchDeathclock, markRequestSent, submitForReview, reSubmitForReview, getPendingReviews } from '../api';
import type { JobberRequestDetail } from '../api';
import SimilarQuotesPanel from './SimilarQuotesPanel';
import DeathclockBadge, { getLabel } from '../components/DeathclockBadge';
import ReviewBadge from '../components/review/ReviewBadge';
import LineItemsTable from '../components/LineItemsTable';

const MANUALLY_ADDED_SENTINEL = 'Manually added';

const DEATHCLOCK_COLOR_MAP: Record<string, string> = {
  green: '#10b981',
  yellow: '#eab308',
  orange: '#f97316',
  red: '#ef4444',
};

export default function QuoteDraftPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const cameFromReview = searchParams.get('from') === 'reviews';

  const navigate = useNavigate();

  const [draft, setDraft] = useState<QuoteDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [revising, setRevising] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [feedbackValidation, setFeedbackValidation] = useState<string | null>(null);
  const [expandedRuleRows, setExpandedRuleRows] = useState<Set<string>>(new Set());
  const [ruleGroups, setRuleGroups] = useState<RuleGroupWithRules[]>([]);
  const [createRuleToggle, setCreateRuleToggle] = useState(false);
  const [ruleCreatedMsg, setRuleCreatedMsg] = useState<string | null>(null);
  const [ruleCreationWarning, setRuleCreationWarning] = useState<string | null>(null);
  const [requestDetail, setRequestDetail] = useState<JobberRequestDetail | null>(null);
  const [deathclock, setDeathclock] = useState<DeathclockState | null>(null);
  const [deathclockLoading, setDeathclockLoading] = useState(false);
  const [showMarkSentDialog, setShowMarkSentDialog] = useState(false);
  const [markSentTimestamp, setMarkSentTimestamp] = useState('');
  const [markSentError, setMarkSentError] = useState<string | null>(null);
  const [markingSent, setMarkingSent] = useState(false);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateSavedMsg, setTemplateSavedMsg] = useState<string | null>(null);
  const [templateSaveError, setTemplateSaveError] = useState(false);

  // Review workflow state
  const [submittingReview, setSubmittingReview] = useState(false);
  const [submitReviewError, setSubmitReviewError] = useState<string | null>(null);
  const [currentReviewId, setCurrentReviewId] = useState<string | null>(null);

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

  // Customer note state
  const [customerNoteValue, setCustomerNoteValue] = useState('');
  const [customerNoteSaved, setCustomerNoteSaved] = useState('');

  // Payment schedule edit state
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [scheduleLabel, setScheduleLabel] = useState('');
  const [scheduleMilestones, setScheduleMilestones] = useState<Array<{ description: string; percentage: string }>>([]);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  // Push to Jobber state
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [customQty, setCustomQty] = useState('1');
  const [customPrice, setCustomPrice] = useState('');

  // Sqft override state
  const [sqftOverrideInput, setSqftOverrideInput] = useState('');
  const [sqftOverrideSaving, setSqftOverrideSaving] = useState(false);
  const [sqftOverrideError, setSqftOverrideError] = useState<string | null>(null);

  // Generation trace toggle state
  const [showGenerationTrace, setShowGenerationTrace] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  const loadDraft = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      setError(null);
      const params = cameFromReview ? { reviewAccess: 'true' } : undefined;
      const d = await fetchDraft(id, params);
      setDraft(d);
      // After setting draft, fetch deathclock if manualRequestId exists
      if (d.manualRequestId) {
        setDeathclockLoading(true);
        fetchDeathclock(d.manualRequestId).then(setDeathclock).catch(() => { /* non-critical */ }).finally(() => setDeathclockLoading(false));
      }
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Failed to load quote draft.');
    } finally {
      setLoading(false);
    }
  }, [id, cameFromReview]);

  useEffect(() => { loadDraft(); }, [loadDraft]);

  useEffect(() => {
    fetchRules().then(setRuleGroups).catch(() => { /* rules are supplementary; ignore errors */ });
  }, []);

  // Fetch Jobber request details when draft has a jobberRequestId
  useEffect(() => {
    if (!draft?.jobberRequestId) {
      setRequestDetail(null);
      return;
    }
    let cancelled = false;
    setRequestDetail(null);
    fetchJobberRequestDetail(draft.jobberRequestId)
      .then((data) => { if (!cancelled) setRequestDetail(data.request); })
      .catch(() => { /* supplementary; ignore errors */ });
    return () => { cancelled = true; };
  }, [draft?.jobberRequestId]);

  // Sync customer note state when draft loads or changes
  useEffect(() => {
    const note = draft?.customerNote ?? '';
    setCustomerNoteValue(note);
    setCustomerNoteSaved(note);
  }, [draft?.customerNote]);

  // Look up reviewId when draft has reviewStatus but no stored reviewId
  useEffect(() => {
    if (id && draft?.reviewStatus === 'pending_review' && !currentReviewId) {
      getPendingReviews()
        .then((reviews) => {
          const match = reviews.find((r) => r.quoteDraftId === id);
          if (match) setCurrentReviewId(match.id);
        })
        .catch(() => {});
    }
  }, [id, draft?.reviewStatus, currentReviewId]);

  const handleSubmitFeedback = async () => {
    if (!id || !feedbackText.trim()) {
      setFeedbackValidation('Please enter feedback before submitting.');
      return;
    }
    setFeedbackValidation(null);
    setRevisionError(null);
    setRuleCreatedMsg(null);
    setRuleCreationWarning(null);
    setRevising(true);
    try {
      const updated = await reviseDraft(id, feedbackText, createRuleToggle || undefined);
      setDraft(updated);
      setFeedbackText('');
      setCreateRuleToggle(false);
      if (updated.ruleCreated) {
        setRuleCreatedMsg(`Rule "${updated.ruleCreated.name}" was created and will apply to future quotes.`);
        // Refresh rules so traceability panel has the latest
        fetchRules().then(setRuleGroups).catch(() => {});
      } else if (updated.ruleCreationError) {
        setRuleCreationWarning(`Quote revised successfully, but rule creation failed: ${updated.ruleCreationError}`);
      }
    } catch (err) {
      setRevisionError((err as ErrorResponse).message ?? 'Revision failed. Please try again.');
    } finally {
      setRevising(false);
    }
  };

  // Build a lookup map: ruleId -> Rule
  const ruleById = new Map<string, Rule>();
  for (const group of ruleGroups) {
    for (const rule of group.rules) {
      ruleById.set(rule.id, rule);
    }
  }

  // Build a lookup map: ruleId -> group name
  const groupNameByRuleId = new Map<string, string>();
  for (const group of ruleGroups) {
    for (const rule of group.rules) {
      groupNameByRuleId.set(rule.id, group.name);
    }
  }

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

  /** Get applied rules for a line item, grouped by group name */
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

  const handleSaveAsTemplate = async () => {
    if (savingTemplate) return;
    const name = templateName.trim();
    if (!id || !name) return;
    setSavingTemplate(true);
    setTemplateSaveError(false);
    try {
      await saveTemplateFromDraft(id, name);
      setTemplateSavedMsg(`Template "${name}" saved!`);
      setTemplateSaveError(false);
      setTemplateName('');
      setShowSaveTemplate(false);
      setTimeout(() => setTemplateSavedMsg(null), 4000);
    } catch (err) {
      setTemplateSavedMsg((err as any).message ?? 'Failed to save template.');
      setTemplateSaveError(true);
    } finally {
      setSavingTemplate(false);
    }
  };

  /** Mark the request's quote as sent (manual/offline send). */
  const handleMarkSent = async () => {
    if (!draft || !draft.manualRequestId) return;
    setMarkingSent(true);
    setMarkSentError(null);
    try {
      const raw = markSentTimestamp.trim();
      // datetime-local returns "YYYY-MM-DDTHH:mm" without timezone.
      // Convert to a proper UTC ISO 8601 string so the backend's
      // elapsed-time calculations are accurate.
      const timestamp = raw ? new Date(raw).toISOString() : undefined;
      await markRequestSent(draft.manualRequestId, timestamp);
      // Refresh the deathclock to show the completed state
      const dc = await fetchDeathclock(draft.manualRequestId);
      setDeathclock(dc);
      setShowMarkSentDialog(false);
      setMarkSentTimestamp('');
    } catch (err) {
      setMarkSentError((err as ErrorResponse).message ?? 'Failed to mark as sent. Please try again.');
    } finally {
      setMarkingSent(false);
    }
  };

  /** Submit the quote draft for review. */
  const handleSubmitForReview = async () => {
    if (!id || submittingReview) return;
    setSubmittingReview(true);
    setSubmitReviewError(null);
    try {
      const result = await submitForReview(id);
      setCurrentReviewId(result.reviewId);
      await loadDraft();
    } catch (err) {
      setSubmitReviewError((err as ErrorResponse).message ?? 'Failed to submit for review.');
    } finally {
      setSubmittingReview(false);
    }
  };

  /** Re-submit after changes_requested. */
  const handleReSubmitForReview = async () => {
    if (!id || submittingReview) return;
    setSubmittingReview(true);
    setSubmitReviewError(null);
    try {
      const result = await reSubmitForReview(id);
      setCurrentReviewId(result.reviewId);
      await loadDraft();
    } catch (err) {
      setSubmitReviewError((err as ErrorResponse).message ?? 'Failed to re-submit for review.');
    } finally {
      setSubmittingReview(false);
    }
  };

  // ── Customer note save-on-blur handler ──

  const handleCustomerNoteBlur = async () => {
    const trimmed = customerNoteValue.trim() || null;
    const savedTrimmed = customerNoteSaved.trim() || null;
    if (trimmed === savedTrimmed) return;

    try {
      await updateDraft(id!, { customerNote: trimmed });
      setCustomerNoteSaved(customerNoteValue);
    } catch {
      // Error toast is shown automatically by the API layer
    }
  };

  // ── Push to Jobber handler ──

  const handlePushToJobber = async () => {
    if (pushing || !draft || !id) return;
    setPushing(true);
    setPushError(null);
    try {
      const result = await pushDraftToJobber(id);
      setDraft({
        ...draft,
        jobberQuoteId: result.jobberQuoteId,
        jobberQuoteNumber: result.jobberQuoteNumber,
        jobberQuoteWebUri: result.jobberQuoteWebUri,
        status: 'finalized',
      });
    } catch (err) {
      setPushError((err as any).message ?? 'Failed to push to Jobber.');
    } finally {
      setPushing(false);
    }
  };

  // ── Push Update handler ──
  const handlePushUpdate = async () => {
    if (pushing || !draft || !id) return;
    setPushing(true);
    setPushError(null);
    try {
      const result = await pushDraftUpdateToJobber(id);
      setDraft({
        ...draft,
        jobberQuoteId: result.jobberQuoteId,
        jobberQuoteNumber: result.jobberQuoteNumber,
        jobberQuoteWebUri: result.jobberQuoteWebUri,
        status: 'finalized',
      });
    } catch (err) {
      setPushError((err as any).message ?? 'Failed to push updates to Jobber.');
    } finally {
      setPushing(false);
    }
  };

  // ── Sqft override handlers ──

  const handleSaveSqftOverride = async () => {
    if (!draft || !id || sqftOverrideSaving) return;
    setSqftOverrideError(null);
    const val = parseFloat(sqftOverrideInput);
    if (isNaN(val) || val <= 0) {
      setSqftOverrideError('Enter a valid positive number for square footage.');
      return;
    }
    if (val > 100000) {
      setSqftOverrideError('Square footage value seems unreasonably large (max 100,000).');
      return;
    }
    setSqftOverrideSaving(true);
    try {
      const updated = await patchDraftSqft(id, val);
      setDraft(updated);
      setSqftOverrideInput('');
    } catch {
      // Error toast shown automatically by the API layer
    } finally {
      setSqftOverrideSaving(false);
    }
  };

  const handleClearSqftOverride = async () => {
    if (!draft || !id || sqftOverrideSaving) return;
    setSqftOverrideSaving(true);
    setSqftOverrideError(null);
    try {
      const updated = await patchDraftSqft(id, null);
      setDraft(updated);
      setSqftOverrideInput('');
    } catch {
      // Error toast shown automatically by the API layer
    } finally {
      setSqftOverrideSaving(false);
    }
  };

  // ── Inline editing handlers ──

  const startEditing = (itemId: string, field: 'quantity' | 'unitPrice' | 'productName' | 'description', currentValue: number | string) => {
    setEditingCell({ itemId, field });
    setEditValue(String(currentValue));
    setUpdateCatalogChecked(false);
    setTimeout(() => editInputRef.current?.select(), 0);
  };

  const saveEdit = async () => {
    if (!editingCell || !draft || !id) return;
    const { field, itemId } = editingCell;
    const editingItem = draft.lineItems.find((i) => i.id === itemId);
    let updatedLineItems: QuoteLineItem[];
    if (field === 'productName' || field === 'description') {
      updatedLineItems = draft.lineItems.map((item) =>
        item.id === itemId ? { ...item, [field]: editValue } : item,
      );
    } else {
      const numVal = parseFloat(editValue);
      if (isNaN(numVal) || numVal < 0) {
        setEditingCell(null);
        return;
      }
      updatedLineItems = draft.lineItems.map((item) =>
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
      const updated = await updateDraft(id, { lineItems: updatedLineItems, unresolvedItems: draft.unresolvedItems });
      setDraft(updated);
      // Update the catalog entry if checkbox was checked
      if (shouldUpdateCatalog && editingItem?.productCatalogEntryId) {
        const catalogKey = field === 'productName' ? 'name' : 'description';
        try {
          await updateCatalogEntry(editingItem.productCatalogEntryId, { [catalogKey]: editValue });
        } catch (catalogErr) {
          console.warn('[QuoteDraftPage] Failed to update catalog entry:', catalogErr);
        }
      }
    } catch {
      await loadDraft();
    } finally {
      setSaving(false);
    }
  };

  const handleReorder = async (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || !draft || !id) return;
    const items = [...draft.lineItems];
    const [moved] = items.splice(fromIdx, 1);
    items.splice(toIdx, 0, moved);
    setSaving(true);
    try {
      const updated = await updateDraft(id, { lineItems: items, unresolvedItems: draft.unresolvedItems });
      setDraft(updated);
    } catch {
      await loadDraft();
    } finally {
      setSaving(false);
    }
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
    if (e.key === 'Escape') { setEditingCell(null); }
  };

  const deleteLineItem = (itemId: string) => {
    if (!draft || !id) return;
    const itemToDelete = draft.lineItems.find((item) => item.id === itemId);
    if (!itemToDelete) return;

    // Cancel any existing pending delete first (commit it immediately)
    if (pendingDelete) {
      clearTimeout(pendingDelete.timerId);
      const prevItem = pendingDelete.item;
      const withoutPrev = draft.lineItems.filter((i) => i.id !== prevItem.id);
      updateDraft(id, { lineItems: withoutPrev, unresolvedItems: draft.unresolvedItems }).catch(() => {});
    }

    // Optimistically remove from view
    setDraft({ ...draft, lineItems: draft.lineItems.filter((i) => i.id !== itemId) });

    // Start 5-second undo window — on expiry, commit the delete to the API
    const timerId = setTimeout(async () => {
      setPendingDelete(null);
      setSaving(true);
      try {
        const currentDraft = await fetchDraft(id);
        const withoutItem = currentDraft.lineItems.filter((i) => i.id !== itemId);
        const updated = await updateDraft(id, { lineItems: withoutItem, unresolvedItems: currentDraft.unresolvedItems });
        setDraft(updated);
      } catch {
        await loadDraft();
      } finally {
        setSaving(false);
      }
    }, 5000);

    setPendingDelete({ item: itemToDelete, timerId });
  };

  const handleUndoDelete = () => {
    if (!pendingDelete || !draft) return;
    clearTimeout(pendingDelete.timerId);
    // Restore the item at the end of the list
    setDraft({ ...draft, lineItems: [...draft.lineItems, pendingDelete.item] });
    setPendingDelete(null);
  };

  // ── Add line item handlers ──

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
    if (!draft || !id) return;
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
    const updatedLineItems = [...draft.lineItems, newItem];
    setSaving(true);
    try {
      const updated = await updateDraft(id, { lineItems: updatedLineItems, unresolvedItems: draft.unresolvedItems });
      setDraft(updated);
      setShowAddRow(false);
      setCatalogSearch('');
      setCatalogResults([]);
    } catch {
      await loadDraft();
    } finally {
      setSaving(false);
    }
  };

  const addCustomItem = async () => {
    if (!draft || !id) return;
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
    const updatedLineItems = [...draft.lineItems, newItem];
    setSaving(true);
    try {
      const updated = await updateDraft(id, { lineItems: updatedLineItems, unresolvedItems: draft.unresolvedItems });
      setDraft(updated);
      setShowAddRow(false);
      setShowCustomForm(false);
      setCustomName('');
      setCustomQty('1');
      setCustomPrice('');
      setCatalogSearch('');
      setCatalogResults([]);
    } catch {
      await loadDraft();
    } finally {
      setSaving(false);
    }
  };

  // ── Action item toggle handler ──

  const handleToggleActionItem = async (actionItemId: string) => {
    if (!draft || !id) return;
    const prevCompleted = (draft.actionItems ?? []).find(i => i.id === actionItemId)?.completed;
    const updatedActionItems = (draft.actionItems ?? []).map((item) =>
      item.id === actionItemId ? { ...item, completed: !item.completed } : item,
    );
    // Optimistic update
    setDraft({ ...draft, actionItems: updatedActionItems });
    try {
      await updateDraft(id, { actionItems: updatedActionItems });
    } catch {
      // Revert only the specific item — error toast is shown automatically by the API layer
      setDraft(prev => prev ? {
        ...prev,
        actionItems: (prev.actionItems ?? []).map(i =>
          i.id === actionItemId ? { ...i, completed: prevCompleted ?? false } : i,
        ),
      } : prev);
    }
  };

  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={loadingContainerStyle}>
          <span style={spinnerStyle} />
          <p style={{ margin: '0.75rem 0 0', color: '#555' }}>Loading quote draft…</p>
        </div>
      </div>
    );
  }

  if (error || !draft) {
    return (
      <div style={containerStyle}>
        <button onClick={() => navigate(cameFromReview ? '/quotes/reviews' : '/quotes')} style={backBtnStyle}>{cameFromReview ? '← Back to Review Queue' : '← Back to New Quote'}</button>
        <div role="alert" style={alertStyle}>{error ?? 'Quote draft not found.'}</div>
      </div>
    );
  }

  const hasUnresolved = draft.unresolvedItems.length > 0;
  const showSidePanel = !!(draft.customerRequestText || requestDetail || draft.jobberQuoteId);
  const isReadOnly = draft.reviewStatus === 'pending_review';

  return (
    <div style={{ display: 'flex', gap: '1.5rem', maxWidth: showSidePanel ? 1200 : 800, margin: '0 auto' }}>
      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0 }}>
      <button onClick={() => navigate(cameFromReview ? '/quotes/reviews' : '/quotes')} style={backBtnStyle}>{cameFromReview ? '← Back to Review Queue' : '← Back to New Quote'}</button>

      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap',
        marginBottom: '0.5rem',
        paddingLeft: 12,
        borderLeft: deathclock ? `4px solid ${DEATHCLOCK_COLOR_MAP[deathclock.color]}` : '4px solid transparent',
      }}>
        <h1 style={{ ...titleStyle, margin: 0 }}>Quote Draft D-{String(draft.draftNumber).padStart(3, '0')}</h1>
        {deathclock && (
          <DeathclockBadge
            ageSeconds={deathclock.ageSeconds}
            color={deathclock.color}
            isComplete={deathclock.isComplete}
            frozen={deathclock.frozen}
          />
        )}
        {deathclockLoading && !deathclock && (
          <span style={{ fontSize: '0.8rem', color: '#999' }}>Loading...</span>
        )}
        {deathclock && deathclock.siblingQuotes && deathclock.siblingQuotes.length > 1 && (
          <span style={{ fontSize: '0.8rem', color: '#666', fontWeight: 500 }}>
            {deathclock.siblingQuotes.length} quotes
          </span>
        )}
        {draft.jobberQuoteNumber && (
          <span style={{ fontSize: '0.9rem', color: '#00a89d', fontWeight: 600 }}>
            (Jobber {draft.jobberQuoteNumber})
          </span>
        )}
        <button
          onClick={() => setShowSaveTemplate(!showSaveTemplate)}
          style={{ ...saveTemplateBtnStyle, background: showSaveTemplate ? '#e0e0e0' : '#f5f5f5' }}
        >
          📋 Save as Template
        </button>
      </div>

      {/* Review status badge and actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.75rem', paddingLeft: 12 }}>
        <ReviewBadge status={draft.reviewStatus as any} />
        {(!draft.reviewStatus || draft.reviewStatus === 'changes_requested') && (
          draft.reviewStatus === 'changes_requested' ? (
            <button
              onClick={handleReSubmitForReview}
              disabled={submittingReview}
              style={{
                padding: '0.4rem 1rem', borderRadius: 6, border: 'none',
                background: submittingReview ? '#ccc' : '#7c3aed', color: '#fff',
                fontWeight: 600, fontSize: '0.85rem',
                cursor: submittingReview ? 'not-allowed' : 'pointer',
                opacity: submittingReview ? 0.5 : 1,
              }}
              aria-label="Re-submit quote for review"
            >
              {submittingReview ? 'Submitting…' : 'Re-submit for Review'}
            </button>
          ) : (
            <button
              onClick={handleSubmitForReview}
              disabled={submittingReview}
              style={{
                padding: '0.4rem 1rem', borderRadius: 6, border: 'none',
                background: submittingReview ? '#ccc' : '#7c3aed', color: '#fff',
                fontWeight: 600, fontSize: '0.85rem',
                cursor: submittingReview ? 'not-allowed' : 'pointer',
                opacity: submittingReview ? 0.5 : 1,
              }}
              aria-label="Submit quote for review"
            >
              {submittingReview ? 'Submitting…' : 'Submit for Review'}
            </button>
          )
        )}
      </div>

      {/* Changes requested banner */}
      {draft.reviewStatus === 'changes_requested' && (
        <div role="alert" style={{
          padding: '0.65rem 1rem', background: '#fff7ed', border: '1px solid #fdba74',
          borderRadius: 6, marginBottom: '0.75rem', fontSize: '0.88rem', color: '#9a3412',
          display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
        }}>
          <span>⚠️ Changes requested — </span>
          {currentReviewId ? (
            <span style={{ color: '#9a3412' }}>review feedback provided</span>
          ) : (
            <span style={{ color: '#9a3412' }}>review feedback provided</span>
          )}
        </div>
      )}

      {/* Submit review error */}
      {submitReviewError && (
        <div role="alert" style={{
          padding: '0.5rem 0.75rem', background: '#fdecea', border: '1px solid #ef9a9a',
          borderRadius: 6, marginBottom: '0.75rem', fontSize: '0.85rem', color: '#b71c1c',
        }}>
          {submitReviewError}
        </div>
      )}

      {deathclock && (
        <div style={{ marginBottom: '0.5rem' }}>
        <div style={{
          display: 'flex', gap: '1rem', flexWrap: 'wrap',
          fontSize: '0.8rem', color: '#666',
          padding: '0.4rem 0 0.4rem 16px',
          borderTop: '1px solid #e0e0e0',
        }}>
          <span>Request age: {deathclock.ageLabel}</span>
          {deathclock.quoteCreationLagSeconds !== undefined && (
            <span>Quote creation lag: {getLabel(deathclock.quoteCreationLagSeconds)}</span>
          )}
          {deathclock.sendLagSeconds !== undefined && deathclock.isComplete && (
            <span>Send lag: {getLabel(deathclock.sendLagSeconds)}</span>
          )}
          {deathclock.isComplete && deathclock.requestToQuoteSeconds !== undefined && (
            <span>Original time: {getLabel(deathclock.requestToQuoteSeconds)}</span>
          )}
          {deathclock.lastQuoteSentAt && deathclock.isComplete && (() => {
            const now = Date.now();
            const lastSent = new Date(deathclock.lastQuoteSentAt!).getTime();
            const elapsedSec = Math.floor((now - lastSent) / 1000);
            return elapsedSec > 0 ? (
              <span>Last sent: {getLabel(elapsedSec)} ago</span>
            ) : null;
          })()}
        </div>

        {/* Mark as sent button — only when deathclock is still active */}
        {!deathclock.isComplete && !deathclock.frozen && draft.manualRequestId && (
          <>
          <div style={{
            padding: '0.4rem 0 0.4rem 16px',
            borderTop: '1px solid #e0e0e0',
          }}>
            <button
              type="button"
              onClick={() => setShowMarkSentDialog(true)}
              style={{
                background: '#f5f5f5',
                border: '1px solid #d0d0d0',
                borderRadius: 6,
                padding: '0.35rem 0.8rem',
                fontSize: '0.8rem',
                color: '#333',
                cursor: 'pointer',
                fontWeight: 500,
              }}
              aria-label="Mark quote as sent"
            >
              ✓ Mark as sent
            </button>
          </div>

          {/* Mark as sent confirmation dialog */}
          {showMarkSentDialog && (
            <div
              style={{
                position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                zIndex: 1000,
              }}
              onClick={() => setShowMarkSentDialog(false)}
              role="dialog"
              aria-modal="true"
              aria-label="Mark as sent confirmation"
            >
              <div
                style={{
                  background: '#fff', borderRadius: 8, padding: '1.5rem',
                  maxWidth: 400, width: '90%', boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 600 }}>
                  Mark quote as sent
                </h3>
                <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: '#666' }}>
                  This records the quote as sent and freezes the deathclock timer.
                </p>

                <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.8rem', fontWeight: 500, color: '#333' }}>
                  Optional timestamp (defaults to now)
                </label>
                <input
                  type="datetime-local"
                  value={markSentTimestamp}
                  onChange={(e) => setMarkSentTimestamp(e.target.value)}
                  style={{
                    width: '100%', padding: '0.5rem', borderRadius: 6,
                    border: '1px solid #d0d0d0', fontSize: '0.85rem',
                    marginBottom: '0.75rem', boxSizing: 'border-box',
                  }}
                  aria-label="Optional send timestamp"
                />

                {markSentError && (
                  <p role="alert" style={{ margin: '0 0 0.75rem', fontSize: '0.8rem', color: '#d32f2f' }}>
                    {markSentError}
                  </p>
                )}

                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    onClick={() => { setShowMarkSentDialog(false); setMarkSentError(null); }}
                    style={{
                      background: '#fff', border: '1px solid #d0d0d0', borderRadius: 6,
                      padding: '0.45rem 1rem', fontSize: '0.85rem', cursor: 'pointer',
                    }}
                    disabled={markingSent}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleMarkSent}
                    disabled={markingSent}
                    style={{
                      background: markingSent ? '#bbb' : '#00a89d',
                      color: '#fff', border: 'none', borderRadius: 6,
                      padding: '0.45rem 1rem', fontSize: '0.85rem',
                      fontWeight: 600, cursor: markingSent ? 'default' : 'pointer',
                    }}
                    aria-label="Confirm mark as sent"
                  >
                    {markingSent ? 'Saving…' : 'Confirm'}
                  </button>
                </div>
              </div>
            </div>
          )}
          </>
        )}

        {deathclock.isComplete && deathclock.sendEvents && deathclock.sendEvents.length > 0 && (() => {
          const events = deathclock.sendEvents!;
          return (
          <div style={{
            display: 'flex', gap: '1rem', flexWrap: 'wrap',
            fontSize: '0.8rem', color: '#666',
            padding: '0.4rem 0 0.4rem 16px',
            borderTop: '1px solid #e0e0e0',
          }}>
            <span style={{ fontWeight: 600, color: '#333' }}>Send events:</span>
            {events.map((ev, idx) => (
              <span key={ev.id}>
                {idx === 0 ? 'Original' : idx === events.length - 1 ? 'Last sent' : `Resend #${idx}`}: {getLabel(ev.elapsedSecondsFromRequest)}
                <span style={{ marginLeft: '0.25rem', opacity: 0.6 }}>
                  ({new Date(ev.sentAt).toLocaleString()})
                </span>
              </span>
            ))}
          </div>
          );
        })()}

        {/* T4.5: Sibling quotes list — show when a request has multiple quote drafts */}
        {deathclock && deathclock.siblingQuotes && deathclock.siblingQuotes.length > 1 && (
          <div style={{
            display: 'flex', gap: '1rem', flexWrap: 'wrap',
            fontSize: '0.8rem', color: '#666',
            padding: '0.4rem 0 0.4rem 16px',
            borderTop: '1px solid #e0e0e0',
          }}>
            <span style={{ fontWeight: 600, color: '#333' }}>Quotes for this request:</span>
            {deathclock.siblingQuotes.map((sq, idx) => (
              <span key={sq.id}>
                D-{String(sq.draftNumber).padStart(3, '0')}
                {sq.quoteSentAt ? (
                  <>: {getLabel(sq.requestToQuoteSeconds ?? deathclock.ageSeconds)} sent</>
                ) : (
                  <span style={{ fontStyle: 'italic', opacity: 0.7 }}>: unsent</span>
                )}
                {idx === 0 && <span style={{ marginLeft: '0.25rem', opacity: 0.5 }}>(earliest)</span>}
              </span>
            ))}
          </div>
        )}
        </div>
      )}

      {templateSavedMsg && (
        <div style={{ padding: '0.5rem 0.75rem', background: templateSaveError ? '#fdecea' : '#e8f5e9', borderRadius: 6, marginBottom: '0.75rem', fontSize: '0.85rem' }} role={templateSaveError ? 'alert' : 'status'} aria-live="polite" aria-atomic="true">
          {templateSavedMsg}
        </div>
      )}

      {showSaveTemplate && (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '1rem', padding: '0.75rem', background: '#f9f9f9', borderRadius: 8, border: '1px solid #e0e0e0' }}>
          <input
            type="text"
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            placeholder="Template name (e.g. Bathroom Renovation)"
            style={{ flex: 1, padding: '0.5rem 0.75rem', borderRadius: 6, border: '1px solid #ccc', fontSize: '0.9rem' }}
            aria-label="Template name"
            onKeyDown={(e) => { if (e.key === 'Enter') handleSaveAsTemplate(); }}
          />
          <button
            onClick={handleSaveAsTemplate}
            disabled={!templateName.trim() || savingTemplate}
            style={{
              padding: '0.5rem 1rem', borderRadius: 6, border: 'none', background: '#00a89d', color: '#fff',
              fontWeight: 600, cursor: templateName.trim() && !savingTemplate ? 'pointer' : 'not-allowed',
              opacity: templateName.trim() && !savingTemplate ? 1 : 0.5, fontSize: '0.9rem',
            }}
          >
            {savingTemplate ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => { setShowSaveTemplate(false); setTemplateName(''); }} aria-label="Close save template" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.1rem', color: '#888' }}>✕</button>
        </div>
      )}

      {/* Selected template */}
      {draft.selectedTemplateName && (
        <div style={templateBannerStyle}>
          <span style={{ fontWeight: 600 }}>Template:</span> {draft.selectedTemplateName}
        </div>
      )}

      {/* Similar past quotes panel — hidden when empty */}
      {draft.similarQuotes && draft.similarQuotes.length > 0 && (
        <SimilarQuotesPanel similarQuotes={draft.similarQuotes} />
      )}

      {/* Square Footage Resolution */}
      <div style={sqftResolutionSectionStyle}>
        <h2 style={sectionTitleStyle}>📐 Square Footage</h2>
        {draft.sqftResolution?.resolution.resolved ? (
          <>
            {/* Active resolution display */}
            <div style={sqftResolutionRowStyle}>
              <span style={sqftValueStyle}>
                {(draft.sqftResolution.manualOverride ?? draft.sqftResolution.resolution.value)?.toLocaleString()} sq ft
              </span>
              <span style={sqftTierLabelStyle}>
                {getTierLabel(draft.sqftResolution.resolution.tier)}
              </span>
              {draft.sqftResolution.resolution.confidence && (
                <span style={sqftConfidenceBadgeStyle(draft.sqftResolution.resolution.confidence)}>
                  {draft.sqftResolution.resolution.confidence}
                </span>
              )}
            </div>

            {/* Tier-specific metadata */}
            {draft.sqftResolution.resolution.tier === 'text_extraction' && draft.sqftResolution.resolution.metadata.matchedText && (
              <p style={sqftMetaTextStyle}>
                Matched: &ldquo;{draft.sqftResolution.resolution.metadata.matchedText}&rdquo;
              </p>
            )}
            {draft.sqftResolution.resolution.tier === 'layout_diagram' && (
              <div style={sqftMetaTextStyle}>
                {draft.sqftResolution.resolution.metadata.imageId && (
                  <span>Image: {draft.sqftResolution.resolution.metadata.imageId}</span>
                )}
                {draft.sqftResolution.resolution.metadata.aiReasoning && (
                  <p style={{ margin: '0.25rem 0 0', fontStyle: 'italic' }}>
                    {draft.sqftResolution.resolution.metadata.aiReasoning}
                  </p>
                )}
              </div>
            )}
            {draft.sqftResolution.resolution.tier === 'public_records' && draft.sqftResolution.resolution.metadata.propertyAddress && (
              <p style={sqftMetaTextStyle}>
                Property: {draft.sqftResolution.resolution.metadata.propertyAddress}
              </p>
            )}
            {draft.sqftResolution.resolution.tier === 'public_records' && draft.sqftResolution.resolution.metadata.isSubUnit && (
              <div role="alert" style={{ marginTop: '0.5rem', padding: '0.5rem 0.75rem', background: '#fff8e1', border: '1px solid #ffe082', borderRadius: 6, fontSize: '0.82rem', color: '#7a5c00' }}>
                {(() => {
                  const meta = draft.sqftResolution.resolution.metadata;
                  const unitSqft = (draft.sqftResolution.manualOverride ?? draft.sqftResolution.resolution.value)?.toLocaleString();
                  const totalSqft = meta.totalPropertySqft?.toLocaleString();
                  const unitLabel = meta.structuralQualifier ? 'est. coach house' : meta.unitCount && meta.unitCount > 1 ? `est. unit (1 of ${meta.unitCount})` : 'est. unit';

                  if (totalSqft) {
                    return (
                      <>
                        <span>⚠️ Sub-structure detected — showing estimated unit area only.</span>
                        <div style={{ marginTop: '0.35rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                          <span><strong>{unitSqft} sq ft</strong> ({unitLabel})</span>
                          <span style={{ color: '#a07800' }}>·</span>
                          <span><strong>{totalSqft} sq ft</strong> total property</span>
                        </div>
                        <div style={{ marginTop: '0.25rem', fontSize: '0.78rem', color: '#9a6e00' }}>
                          Verify and override if the scope covers a different area.
                        </div>
                      </>
                    );
                  }

                  // Fallback: no total available (e.g. hd_sf source, no divisor applied)
                  return meta.unitCount && meta.unitCount > 1
                    ? `⚠️ This address includes a sub-structure qualifier. The square footage shown is an average unit size estimated from a ${meta.unitCount}-unit building — verify and override if needed.`
                    : '⚠️ This address includes a unit or sub-structure qualifier (e.g. rear coach house, apt, unit). The square footage shown is an estimate — verify and override if needed.';
                })()}
              </div>
            )}

            {/* Original resolution when override is active */}
            {draft.sqftResolution.manualOverride !== null && (
              <div style={sqftOriginalResolutionStyle}>
                {draft.sqftResolution.originalResolution?.resolved && (
                  <>
                    <span style={{ fontWeight: 600, fontSize: '0.75rem', color: '#888' }}>Original: </span>
                    <span style={{ fontSize: '0.8rem', color: '#666' }}>
                      {draft.sqftResolution.originalResolution.value?.toLocaleString()} sq ft
                      {' '}({getTierLabel(draft.sqftResolution.originalResolution.tier)})
                    </span>
                  </>
                )}
                <button
                  onClick={handleClearSqftOverride}
                  disabled={sqftOverrideSaving}
                  style={sqftClearBtnStyle}
                  aria-label="Clear manual override and restore original resolution"
                >
                  {sqftOverrideSaving ? 'Clearing…' : 'Clear override'}
                </button>
              </div>
            )}
          </>
        ) : (
          <p style={sqftUnavailableStyle} role="status">
            Square footage unavailable — quantity rules requiring it will use default values.
          </p>
        )}

        {/* Manual override input — only shown when no override is currently active */}
        {(draft.sqftResolution?.manualOverride === null || draft.sqftResolution?.manualOverride === undefined) && (
          <div style={sqftOverrideFormStyle}>
            <label htmlFor="sqft-override-input" style={sqftOverrideLabelStyle}>
              {draft.sqftResolution?.resolution.resolved ? 'Override square footage:' : 'Set square footage manually:'}
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                id="sqft-override-input"
                type="number"
                min={1}
                max={100000}
                step={1}
                value={sqftOverrideInput}
                onChange={(e) => { setSqftOverrideInput(e.target.value); setSqftOverrideError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveSqftOverride(); }}
                placeholder="e.g. 1500"
                style={sqftOverrideInputStyle}
                aria-label="Manual square footage override value"
                disabled={sqftOverrideSaving}
              />
              <button
                onClick={handleSaveSqftOverride}
                disabled={!sqftOverrideInput.trim() || sqftOverrideSaving}
                style={{
                  ...sqftSaveBtnStyle,
                  opacity: sqftOverrideInput.trim() && !sqftOverrideSaving ? 1 : 0.5,
                  cursor: sqftOverrideInput.trim() && !sqftOverrideSaving ? 'pointer' : 'not-allowed',
                }}
                aria-label="Save manual square footage override"
              >
                {sqftOverrideSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
            {sqftOverrideError && (
              <p style={sqftOverrideErrorStyle} role="alert">{sqftOverrideError}</p>
            )}
          </div>
        )}
      </div>

      {/* Generation Trace section — only shown when trace data is available */}
      {draft.generationTrace && (
        <div style={sectionStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: showGenerationTrace ? '0.75rem' : 0 }}>
            <h2 style={{ ...sectionTitleStyle, margin: 0 }}>🔍 Generation Trace</h2>
            <button
              onClick={() => setShowGenerationTrace((v) => !v)}
              style={infoIconBtnStyle}
              aria-label={showGenerationTrace ? 'Hide generation trace' : 'Show generation trace'}
              aria-expanded={showGenerationTrace}
              title="View generation pipeline details"
            >
              {showGenerationTrace ? '▲' : '▼'}
            </button>
          </div>
          {showGenerationTrace && (
            <GenerationTracePanel trace={draft.generationTrace} />
          )}
        </div>
      )}

      {/* Matched line items table */}
      <div style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Matched Line Items</h2>

        <LineItemsTable
          lineItems={draft.lineItems}
          unresolvedItems={draft.unresolvedItems}
          isReadOnly={isReadOnly}
          id={id!}
          onLineItemsSaved={(updated) => {
            setDraft({ ...draft, lineItems: updated });
          }}
          onLoadDraft={loadDraft}
          ruleById={ruleById}
          groupNameByRuleId={groupNameByRuleId}
        />
      </div>

      {/* Unresolved items section — hidden when zero */}
      {hasUnresolved && (
        <div style={unresolvedSectionStyle}>
          <h2 style={{ ...sectionTitleStyle, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={warningIconStyle}>⚠️</span>
            Unresolved Items
          </h2>
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Original Text</th>
                  <th style={thStyle}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {draft.unresolvedItems.map((item: QuoteLineItem) => (
                  <tr key={item.id}>
                    <td style={tdStyle}>{item.originalText}</td>
                    <td style={tdStyle}>{item.unmatchedReason ?? 'Unknown'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Action Items Panel — hidden when empty or undefined */}
      {draft.actionItems && draft.actionItems.length > 0 && (() => {
        const allLineItems = [...draft.lineItems, ...draft.unresolvedItems];
        const incompleteCount = draft.actionItems.filter((ai) => !ai.completed).length;
        return (
          <div style={actionItemsSectionStyle}>
            <h2 style={sectionTitleStyle}>
              📋 Action Items ({incompleteCount} remaining)
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {draft.actionItems.map((actionItem) => {
                const linkedLineItem = allLineItems.find((li) => li.id === actionItem.lineItemId);
                const productName = linkedLineItem?.productName ?? 'Unknown item';
                return (
                  <label
                    key={actionItem.id}
                    style={{
                      ...actionItemRowStyle,
                      opacity: actionItem.completed ? 0.5 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={actionItem.completed}
                      onChange={() => handleToggleActionItem(actionItem.id)}
                      style={actionItemCheckboxStyle}
                      aria-label={`Mark "${actionItem.description}" for ${productName} as ${actionItem.completed ? 'incomplete' : 'complete'}`}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{
                        fontWeight: 600,
                        fontSize: '0.9rem',
                        color: '#333',
                        textDecoration: actionItem.completed ? 'line-through' : 'none',
                      }}>
                        {productName}
                      </span>
                      <span style={{
                        display: 'block',
                        fontSize: '0.8rem',
                        color: '#666',
                        marginTop: '0.15rem',
                        textDecoration: actionItem.completed ? 'line-through' : 'none',
                      }}>
                        {actionItem.description}
                      </span>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Note to Customer */}
      <div style={{ marginTop: '1.5rem' }}>
        <label htmlFor="customer-note" style={{ fontWeight: 600, display: 'block', marginBottom: '0.5rem' }}>
          Note to Customer
        </label>
        <textarea
          id="customer-note"
          rows={4}
          placeholder="Optional note visible to the customer on the published quote..."
          value={customerNoteValue}
          onChange={(e) => setCustomerNoteValue(e.target.value)}
          onBlur={handleCustomerNoteBlur}
          disabled={draft.status === 'finalized'}
          readOnly={draft.status === 'finalized'}
          style={{ ...feedbackInputStyle, resize: 'vertical' }}
        />
      </div>

      {/* Payment Schedule section */}
      {(() => {
        const quoteTotal = draft.lineItems.reduce(
          (sum, item) => sum + item.quantity * item.unitPrice,
          0,
        );
        const formatUSD = (amount: number) =>
          new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

        const isFinalized = draft.status === 'finalized';

        const handleEditSchedule = () => {
          const current = draft.depositSchedule;
          setScheduleLabel(current?.label ?? 'Payment Schedule');
          setScheduleMilestones(
            current?.milestones.map((m) => ({
              description: m.description,
              percentage: String(m.percentage),
            })) ?? [{ description: '', percentage: '' }],
          );
          setScheduleError(null);
          setEditingSchedule(true);
        };

        const handleCancelSchedule = () => {
          setEditingSchedule(false);
          setScheduleError(null);
        };

        const handleSaveSchedule = async () => {
          if (!id) return;
          if (isFinalized) {
            setScheduleError('Cannot modify a finalized draft.');
            return;
          }
          setScheduleError(null);

          if (!scheduleLabel.trim()) {
            setScheduleError('Schedule name is required.');
            return;
          }
          if (scheduleMilestones.length === 0) {
            setScheduleError('At least one milestone is required.');
            return;
          }
          for (let i = 0; i < scheduleMilestones.length; i++) {
            if (!scheduleMilestones[i].description.trim()) {
              setScheduleError(`Milestone ${i + 1} description is required.`);
              return;
            }
            const pct = parseFloat(scheduleMilestones[i].percentage);
            if (isNaN(pct) || !Number.isInteger(pct) || pct < 1 || pct > 100) {
              setScheduleError(`Milestone ${i + 1} percentage must be a whole integer between 1 and 100.`);
              return;
            }
          }
          const total = scheduleMilestones.reduce((sum, m) => sum + parseFloat(m.percentage || '0'), 0);
          if (Math.round(total * 100) !== 10000) {
            setScheduleError(`Percentages must sum to 100. Current total: ${total.toFixed(2)}%.`);
            return;
          }

          setScheduleSaving(true);
          try {
            const updated = await updateDraft(id, {
              depositSchedule: {
                label: scheduleLabel.trim(),
                milestones: scheduleMilestones.map((m) => ({
                  description: m.description.trim(),
                  percentage: parseFloat(m.percentage),
                })),
              },
            });
            setDraft(updated);
            setEditingSchedule(false);
          } catch {
            setScheduleError('Failed to save payment schedule. Please try again.');
          } finally {
            setScheduleSaving(false);
          }
        };

        const percentageTotal = scheduleMilestones.reduce(
          (sum, m) => sum + (parseFloat(m.percentage) || 0),
          0,
        );
        const percentageTotalOk = Math.round(percentageTotal * 100) === 10000;

        return (
          <div style={{ ...sectionStyle, marginTop: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <h2 style={{ ...sectionTitleStyle, margin: 0 }}>Payment Schedule</h2>
              {!isFinalized && !editingSchedule && (
                <button
                  onClick={handleEditSchedule}
                  style={{ background: 'none', border: '1px solid #ccc', borderRadius: 5, padding: '0.25rem 0.75rem', fontSize: '0.8rem', cursor: 'pointer', color: '#555' }}
                >
                  ✏️ Edit
                </button>
              )}
            </div>

            {editingSchedule ? (
              <div>
                <div style={{ marginBottom: '0.75rem' }}>
                  <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#555', display: 'block', marginBottom: '0.25rem' }}>
                    Schedule Name
                  </label>
                  <input
                    type="text"
                    value={scheduleLabel}
                    onChange={(e) => setScheduleLabel(e.target.value)}
                    style={{ width: '100%', padding: '0.4rem 0.6rem', borderRadius: 5, border: '1px solid #ccc', fontSize: '0.9rem', boxSizing: 'border-box' }}
                    placeholder="e.g. Standard Deposit"
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.75rem' }}>
                  {scheduleMilestones.map((m, i) => (
                    <div key={i} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <input
                        type="text"
                        value={m.description}
                        onChange={(e) => {
                          const updated = [...scheduleMilestones];
                          updated[i] = { ...updated[i], description: e.target.value };
                          setScheduleMilestones(updated);
                        }}
                        placeholder="Milestone description"
                        style={{ flex: 1, padding: '0.4rem 0.6rem', borderRadius: 5, border: '1px solid #ccc', fontSize: '0.85rem' }}
                        aria-label={`Milestone ${i + 1} description`}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <input
                          type="number"
                          value={m.percentage}
                          onChange={(e) => {
                            const updated = [...scheduleMilestones];
                            updated[i] = { ...updated[i], percentage: e.target.value };
                            setScheduleMilestones(updated);
                          }}
                          placeholder="%"
                          min={1}
                          max={100}
                          step={1}
                          style={{ width: 64, padding: '0.4rem 0.5rem', borderRadius: 5, border: '1px solid #ccc', fontSize: '0.85rem', textAlign: 'right' }}
                          aria-label={`Milestone ${i + 1} percentage`}
                        />
                        <span style={{ fontSize: '0.85rem', color: '#555' }}>%</span>
                        <span style={{ fontSize: '0.8rem', color: '#888', minWidth: 72, textAlign: 'right' }}>
                          {(() => {
                            const pct = parseFloat(m.percentage);
                            return isNaN(pct) ? '—' : formatUSD((pct / 100) * quoteTotal);
                          })()}
                        </span>
                      </div>
                      <button
                        onClick={() => setScheduleMilestones(scheduleMilestones.filter((_, j) => j !== i))}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c00', fontSize: '1rem', padding: '0 0.25rem' }}
                        aria-label={`Remove milestone ${i + 1}`}
                        title="Remove milestone"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: percentageTotalOk ? '#2a7a2a' : '#c00', fontWeight: 600 }}>
                  Total: {percentageTotal.toFixed(2)}% {percentageTotalOk ? '✓' : '(must equal 100%)'}
                </p>

                {scheduleMilestones.length < 10 && (
                  <button
                    onClick={() => setScheduleMilestones([...scheduleMilestones, { description: '', percentage: '' }])}
                    style={{ background: 'none', border: '1px dashed #aaa', borderRadius: 5, padding: '0.3rem 0.75rem', fontSize: '0.8rem', cursor: 'pointer', color: '#555', marginBottom: '0.75rem' }}
                  >
                    + Add Milestone
                  </button>
                )}

                {scheduleError && (
                  <p style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', color: '#c00' }} role="alert">{scheduleError}</p>
                )}

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    onClick={handleSaveSchedule}
                    disabled={scheduleSaving}
                    style={{ padding: '0.4rem 1rem', borderRadius: 5, border: 'none', background: '#00a89d', color: '#fff', fontWeight: 600, fontSize: '0.85rem', cursor: scheduleSaving ? 'not-allowed' : 'pointer', opacity: scheduleSaving ? 0.6 : 1 }}
                  >
                    {scheduleSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={handleCancelSchedule}
                    disabled={scheduleSaving}
                    style={{ padding: '0.4rem 1rem', borderRadius: 5, border: '1px solid #ccc', background: '#fff', fontSize: '0.85rem', cursor: 'pointer', color: '#555' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : draft.depositSchedule ? (
              <>
                <p style={{ margin: '0 0 0.75rem', fontWeight: 600, fontSize: '0.95rem', color: '#333' }}>
                  {draft.depositSchedule.label}
                </p>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Milestone</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>%</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.depositSchedule.milestones.map((milestone, idx) => (
                      <tr key={idx}>
                        <td style={tdStyle}>{milestone.description}</td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>{milestone.percentage}%</td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                          {formatUSD((milestone.percentage / 100) * quoteTotal)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <div>
                <p style={{ margin: '0 0 0.75rem', fontSize: '0.9rem', color: '#888' }}>
                  No payment schedule has been assigned to this quote.
                </p>
                {!isFinalized && (
                  <button
                    onClick={handleEditSchedule}
                    style={{ background: 'none', border: '1px dashed #aaa', borderRadius: 5, padding: '0.3rem 0.75rem', fontSize: '0.8rem', cursor: 'pointer', color: '#555' }}
                  >
                    + Add Payment Schedule
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Feedback input */}
      <div style={{ ...sectionStyle, marginTop: '1rem' }}>
        <h2 style={sectionTitleStyle}>Revise This Quote</h2>
        <p style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', color: '#666' }}>
          Describe the changes you want (e.g., "increase drywall to 12 sheets", "remove painting").
        </p>
        <textarea
          value={feedbackText}
          onChange={(e) => {
            setFeedbackText(e.target.value);
            if (feedbackValidation) setFeedbackValidation(null);
          }}
          disabled={revising}
          placeholder="Type your feedback here…"
          rows={3}
          style={feedbackInputStyle}
          aria-label="Feedback for quote revision"
        />
        {feedbackValidation && (
          <p style={validationMsgStyle} role="alert">{feedbackValidation}</p>
        )}
        {revisionError && (
          <div role="alert" style={revisionErrorStyle}>{revisionError}</div>
        )}
        <div style={toggleRowStyle}>
          <label style={toggleLabelStyle}>
            <span
              role="switch"
              aria-checked={createRuleToggle}
              tabIndex={0}
              onClick={() => setCreateRuleToggle((v) => !v)}
              onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setCreateRuleToggle((v) => !v); } }}
              style={{
                ...toggleTrackStyle,
                background: createRuleToggle ? '#00a89d' : '#ccc',
              }}
            >
              <span style={{
                ...toggleThumbStyle,
                transform: createRuleToggle ? 'translateX(16px)' : 'translateX(0)',
              }} />
            </span>
            <span style={{ fontSize: '0.85rem', color: '#555' }}>Also save as rule for future quotes</span>
          </label>
        </div>
        <button
          onClick={handleSubmitFeedback}
          disabled={!feedbackText.trim() || revising}
          style={{
            ...submitBtnStyle,
            opacity: (!feedbackText.trim() || revising) ? 0.5 : 1,
            cursor: (!feedbackText.trim() || revising) ? 'not-allowed' : 'pointer',
          }}
        >
          {revising ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={smallSpinnerStyle} /> Revising…
            </span>
          ) : (
            'Submit Feedback'
          )}
        </button>
        {ruleCreatedMsg && (
          <div style={ruleCreatedMsgStyle} role="status">{ruleCreatedMsg}</div>
        )}
        {ruleCreationWarning && (
          <div style={ruleCreationWarningStyle} role="alert">{ruleCreationWarning}</div>
        )}
      </div>

      {/* Revision history */}
      {draft.revisionHistory && draft.revisionHistory.length > 0 && (
        <div style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Revision History</h2>
          <div style={historyListStyle}>
            {draft.revisionHistory.map((entry) => (
              <div key={entry.id} style={historyEntryStyle}>
                <p style={{ margin: 0, fontSize: '0.9rem' }}>{entry.feedbackText}</p>
                <span style={historyTimestampStyle}>
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Draft metadata */}
      <div style={{ fontSize: '0.8rem', color: '#888', marginTop: '1.5rem' }}>
        Created: {new Date(draft.createdAt).toLocaleString()}
      </div>

      {/* Push to Jobber section */}
      <div style={{ ...sectionStyle, marginTop: '1rem' }}>
        <h2 style={sectionTitleStyle}>
          {draft.jobberQuoteId ? 'Update Jobber Quote' : 'Push to Jobber'}
        </h2>
        {draft.jobberQuoteId && draft.jobberQuoteNumber ? (
          <div>
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.9rem', color: '#333' }}>
              🔄 Imported from Jobber Quote <strong>{draft.jobberQuoteNumber}</strong>
            </p>
            <a
              href={draft.jobberQuoteWebUri || `https://secure.getjobber.com/quotes/${draft.jobberQuoteNumber}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#00a89d', fontSize: '0.9rem', fontWeight: 600, display: 'inline-block', marginBottom: '0.75rem' }}
            >
              View in Jobber →
            </a>
            <div>
              <button
                onClick={handlePushUpdate}
                disabled={pushing || isReadOnly}
                style={{
                  padding: '0.6rem 1.5rem',
                  background: pushing || isReadOnly ? '#ccc' : '#00a89d',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: '0.95rem',
                  fontWeight: 600,
                  cursor: pushing || isReadOnly ? 'not-allowed' : 'pointer',
                }}
              >
                {pushing ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={smallSpinnerStyle} /> Pushing Updates…
                  </span>
                ) : (
                  '🚀 Push Updates to Jobber'
                )}
              </button>
            </div>
          </div>
        ) : (
          <div>
            {draft.jobberRequestId && !draft.jobberQuoteId ? (
              <p style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', color: '#888' }}>
                Generated from Jobber request. Push to create a linked quote in Jobber.
              </p>
            ) : !draft.jobberRequestId && !draft.jobberQuoteId ? (
              <p style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', color: '#888' }}>
                This draft was created manually. Pushing will create a new quote in Jobber.
              </p>
            ) : null}
            <button
              onClick={handlePushToJobber}
              disabled={pushing || isReadOnly}
              style={{
                padding: '0.6rem 1.5rem',
                background: pushing || isReadOnly ? '#ccc' : '#00a89d',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                fontSize: '0.95rem',
                fontWeight: 600,
                cursor: pushing || isReadOnly ? 'not-allowed' : 'pointer',
              }}
            >
              {pushing ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={smallSpinnerStyle} /> Pushing to Jobber…
                </span>
              ) : (
                '🚀 Push to Jobber'
              )}
            </button>
          </div>
        )}
        {pushError && (
          <div role="alert" style={{ ...revisionErrorStyle, marginTop: '0.5rem' }}>
            {pushError}
          </div>
        )}
      </div>
      </div>{/* end main content column */}

      {/* Request details side panel */}
      {showSidePanel && (
        <aside style={sidePanelStyle}>
          <h2 style={{ margin: '0 0 0.75rem', fontSize: '1.1rem', fontWeight: 600 }}>Request Details</h2>

          {requestDetail?.title && (
            <div style={{ marginBottom: '0.75rem' }}>
              <h3 style={sidePanelLabelStyle}>Title</h3>
              <p style={sidePanelTextStyle}>{requestDetail.title}</p>
            </div>
          )}

          {requestDetail?.clientName && (
            <div style={{ marginBottom: '0.75rem' }}>
              <h3 style={sidePanelLabelStyle}>Client</h3>
              <p style={sidePanelTextStyle}>{requestDetail.clientName}</p>
            </div>
          )}

          {/* Property address — used for sqft Tier 3 public records lookup */}
          {(requestDetail?.propertyAddress) && (
            <div style={{ marginBottom: '0.75rem' }}>
              <h3 style={sidePanelLabelStyle}>Property Address</h3>
              <p style={{ ...sidePanelTextStyle, fontWeight: 500 }}>📍 {requestDetail.propertyAddress}</p>
            </div>
          )}

          {draft.customerRequestText && (
            <div style={{ marginBottom: '0.75rem' }}>
              <h3 style={sidePanelLabelStyle}>{requestDetail ? 'Request Body' : 'Customer Request'}</h3>
              <p style={{ ...sidePanelTextStyle, whiteSpace: 'pre-wrap' }}>{draft.customerRequestText}</p>
            </div>
          )}

          {requestDetail && requestDetail.description && requestDetail.description !== draft.customerRequestText && (
            <div style={{ marginBottom: '0.75rem' }}>
              <h3 style={sidePanelLabelStyle}>Description</h3>
              <p style={{ ...sidePanelTextStyle, whiteSpace: 'pre-wrap' }}>{requestDetail.description}</p>
            </div>
          )}

          {requestDetail && requestDetail.imageUrls.length > 0 && (
            <div style={{ marginBottom: '0.75rem' }}>
              <h3 style={sidePanelLabelStyle}>Images ({requestDetail.imageUrls.length})</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {requestDetail.imageUrls.map((url, i) => (
                  <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                    <img
                      src={url}
                      alt={`Request image ${i + 1}`}
                      style={{ width: '100%', borderRadius: 6, border: '1px solid #e0e0e0', cursor: 'pointer' }}
                    />
                  </a>
                ))}
              </div>
            </div>
          )}

          {requestDetail && requestDetail.notes.length > 0 && (
            <div style={{ marginBottom: '0.75rem' }}>
              <h3 style={sidePanelLabelStyle}>Notes ({requestDetail.notes.length})</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {requestDetail.notes.map((note, i) => (
                  <div key={i} style={sidePanelNoteStyle}>
                    <p style={{ margin: 0, fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}>{note.message}</p>
                    <span style={{ fontSize: '0.7rem', color: '#999', marginTop: '0.2rem', display: 'block' }}>
                      {note.createdBy === 'team' ? '👤 Team' : '💬 Client'}
                      {note.createdAt && ` · ${new Date(note.createdAt).toLocaleDateString()}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!requestDetail && draft.clientName && (
            <div style={{ marginBottom: '0.75rem' }}>
              <h3 style={sidePanelLabelStyle}>Client</h3>
              <p style={sidePanelTextStyle}>{draft.clientName}</p>
            </div>
          )}

          {!requestDetail && draft.propertyAddress && (
            <div style={{ marginBottom: '0.75rem' }}>
              <h3 style={sidePanelLabelStyle}>Property Address</h3>
              <p style={{ ...sidePanelTextStyle, fontWeight: 500 }}>📍 {draft.propertyAddress}</p>
            </div>
          )}

          {!requestDetail && draft.customerRequestText && (
            <div style={{ marginBottom: '0.75rem' }}>
              <h3 style={sidePanelLabelStyle}>Customer Request</h3>
              <p style={{ ...sidePanelTextStyle, whiteSpace: 'pre-wrap' }}>{draft.customerRequestText}</p>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

// ── Styles ──

const containerStyle: React.CSSProperties = { maxWidth: 800, margin: '0 auto' };
const titleStyle: React.CSSProperties = { margin: '0 0 1rem', fontSize: '1.5rem' };

const backBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#00a89d',
  cursor: 'pointer',
  fontSize: '0.9rem',
  padding: 0,
  marginBottom: '1rem',
  display: 'inline-block',
};

const saveTemplateBtnStyle: React.CSSProperties = {
  border: '1px solid #ccc',
  borderRadius: 6,
  padding: '0.35rem 0.75rem',
  cursor: 'pointer',
  fontSize: '0.8rem',
  fontWeight: 500,
  color: '#333',
};

const alertStyle: React.CSSProperties = {
  background: '#fdecea',
  color: '#611a15',
  padding: '0.75rem 1rem',
  borderRadius: 4,
  marginBottom: '1rem',
};

const loadingContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '3rem 0',
};

const spinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 28,
  height: 28,
  border: '3px solid #e0e0e0',
  borderTopColor: '#00a89d',
  borderRadius: '50%',
  animation: 'spin 0.6s linear infinite',
};

const templateBannerStyle: React.CSSProperties = {
  background: '#e0f7f5',
  color: '#00a89d',
  padding: '0.6rem 1rem',
  borderRadius: 6,
  marginBottom: '1.25rem',
  fontSize: '0.9rem',
};

const requestSectionStyle: React.CSSProperties = {
  background: '#f8f9fa',
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  padding: '1rem 1.25rem',
  marginBottom: '1rem',
};

const requestBodyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '0.9rem',
  color: '#333',
  whiteSpace: 'pre-wrap',
  lineHeight: 1.5,
};

const sectionStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  padding: '1rem 1.25rem',
  marginBottom: '1rem',
};

const unresolvedSectionStyle: React.CSSProperties = {
  background: '#fff8e1',
  border: '1px solid #ffe082',
  borderRadius: 8,
  padding: '1rem 1.25rem',
  marginBottom: '1rem',
};

const actionItemsSectionStyle: React.CSSProperties = {
  background: '#e8f5e9',
  border: '1px solid #a5d6a7',
  borderRadius: 8,
  padding: '1rem 1.25rem',
  marginBottom: '1rem',
};

const actionItemRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.6rem',
  padding: '0.5rem 0.6rem',
  background: '#fff',
  borderRadius: 6,
  border: '1px solid #e0e0e0',
  cursor: 'pointer',
  transition: 'opacity 0.2s',
};

const actionItemCheckboxStyle: React.CSSProperties = {
  marginTop: '0.2rem',
  width: 16,
  height: 16,
  flexShrink: 0,
  cursor: 'pointer',
  accentColor: '#00a89d',
};

const sectionTitleStyle: React.CSSProperties = {
  margin: '0 0 0.75rem',
  fontSize: '1.1rem',
  fontWeight: 600,
};

const warningIconStyle: React.CSSProperties = {
  fontSize: '1.1rem',
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

// ---------------------------------------------------------------------------
// LineItemRationalePanel — shown when the ℹ button is clicked on a line item
// ---------------------------------------------------------------------------

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

      {/* ── Why was this item added? ── */}
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

      {/* ── Why is the quantity what it is? ── */}
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

      {/* ── Applied rules (legacy lookup by ID) ── */}
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

      {/* ── Catalog scope ── */}
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

      {/* ── Space context ── */}
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

// ---------------------------------------------------------------------------
// GenerationTracePanel — shown when the Generation Trace section is expanded
// ---------------------------------------------------------------------------

function GenerationTracePanel({ trace }: { trace: GenerationTrace }) {
  const [showAllCatalogFiltered, setShowAllCatalogFiltered] = useState(false);
  const [showAllRules, setShowAllRules] = useState(false);

  const CATALOG_COLLAPSE_THRESHOLD = 3;
  const RULES_COLLAPSE_THRESHOLD = 5;

  const visibleCatalogFiltered = showAllCatalogFiltered
    ? trace.catalogFilteredProducts
    : trace.catalogFilteredProducts.slice(0, CATALOG_COLLAPSE_THRESHOLD);

  const visibleRules = showAllRules
    ? trace.rulesFired
    : trace.rulesFired.slice(0, RULES_COLLAPSE_THRESHOLD);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.85rem' }}>

      {/* Detected scopes */}
      <div>
        <p style={ruleGroupHeadingStyle}>Detected Scopes</p>
        {trace.detectedScopes.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
            {trace.detectedScopes.map((scope) => (
              <span key={scope} style={{
                display: 'inline-block',
                padding: '0.15rem 0.5rem',
                borderRadius: 10,
                fontSize: '0.75rem',
                fontWeight: 600,
                background: '#e3f2fd',
                color: '#1565c0',
              }}>
                {scope}
              </span>
            ))}
          </div>
        ) : (
          <p style={noRulesTextStyle}>No scopes detected</p>
        )}
      </div>

      {/* Catalog filtered */}
      <div>
        <p style={ruleGroupHeadingStyle}>
          Catalog Pre-filter — {trace.catalogFilteredCount} product{trace.catalogFilteredCount !== 1 ? 's' : ''} excluded
        </p>
        {trace.catalogFilteredProducts.length > 0 ? (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
              {visibleCatalogFiltered.map((name) => (
                <span key={name} style={{
                  display: 'inline-block',
                  padding: '0.1rem 0.4rem',
                  borderRadius: 6,
                  fontSize: '0.75rem',
                  background: '#fce4ec',
                  color: '#c62828',
                }}>
                  {name}
                </span>
              ))}
            </div>
            {trace.catalogFilteredProducts.length > CATALOG_COLLAPSE_THRESHOLD && (
              <button
                onClick={() => setShowAllCatalogFiltered((v) => !v)}
                style={{ ...customItemLinkStyle, fontSize: '0.75rem', marginTop: '0.3rem', display: 'block' }}
              >
                {showAllCatalogFiltered
                  ? 'Show less'
                  : `+${trace.catalogFilteredProducts.length - CATALOG_COLLAPSE_THRESHOLD} more`}
              </button>
            )}
          </>
        ) : (
          <p style={noRulesTextStyle}>No products excluded</p>
        )}
      </div>

      {/* Space contexts */}
      {trace.spaceContexts.length > 0 && (
        <div>
          <p style={ruleGroupHeadingStyle}>Space Contexts Extracted ({trace.spaceContexts.length})</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            {trace.spaceContexts.map((sc, i) => (
              <div key={i} style={ruleEntryStyle}>
                <span style={ruleNameStyle}>{sc.normalizedLabel}</span>
                <span style={ruleDescStyle}>
                  {sc.sqftIsExplicit
                    ? `${sc.explicitSqft?.toLocaleString()} sq ft (explicit)`
                    : sc.estimatedSqft != null
                    ? `${sc.estimatedSqft.toLocaleString()} sq ft (estimated)`
                    : 'no sqft'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Rules fired */}
      <div>
        <p style={ruleGroupHeadingStyle}>
          Rules Fired — {trace.rulesFiredCount} rule{trace.rulesFiredCount !== 1 ? 's' : ''}
        </p>
        {trace.rulesFired.length > 0 ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
              {visibleRules.map((name) => (
                <span key={name} style={{ fontSize: '0.8rem', color: '#333', paddingLeft: '0.5rem', borderLeft: '2px solid #00a89d' }}>
                  {name}
                </span>
              ))}
            </div>
            {trace.rulesFired.length > RULES_COLLAPSE_THRESHOLD && (
              <button
                onClick={() => setShowAllRules((v) => !v)}
                style={{ ...customItemLinkStyle, fontSize: '0.75rem', marginTop: '0.3rem', display: 'block' }}
              >
                {showAllRules
                  ? 'Show less'
                  : `+${trace.rulesFired.length - RULES_COLLAPSE_THRESHOLD} more`}
              </button>
            )}
          </>
        ) : (
          <p style={noRulesTextStyle}>No rules fired</p>
        )}
      </div>

      {/* Scope mismatches */}
      {trace.scopeMismatchCount > 0 && (
        <div>
          <p style={ruleGroupHeadingStyle}>
            Scope Mismatches — {trace.scopeMismatchCount} item{trace.scopeMismatchCount !== 1 ? 's' : ''} moved to unresolved
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
            {trace.scopeMismatchedProducts.map((name) => (
              <span key={name} style={{
                display: 'inline-block',
                padding: '0.1rem 0.4rem',
                borderRadius: 6,
                fontSize: '0.75rem',
                background: '#fff8e1',
                color: '#e65100',
              }}>
                {name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Fallback enrichment */}
      {trace.fallbackEnrichmentCount > 0 && (
        <div>
          <p style={ruleGroupHeadingStyle}>Fallback Enrichment</p>
          <p style={{ ...noRulesTextStyle, fontStyle: 'normal', color: '#555' }}>
            {trace.fallbackEnrichmentCount} item{trace.fallbackEnrichmentCount !== 1 ? 's' : ''} enriched via fallback pass
          </p>
        </div>
      )}
    </div>
  );
}

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

// ── Quantity Source Badge Helpers ──

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

const feedbackInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.6rem 0.75rem',
  border: '1px solid #ccc',
  borderRadius: 6,
  fontSize: '0.9rem',
  fontFamily: 'inherit',
  resize: 'vertical',
  boxSizing: 'border-box',
};

const validationMsgStyle: React.CSSProperties = {
  color: '#d32f2f',
  fontSize: '0.8rem',
  margin: '0.25rem 0 0',
};

const revisionErrorStyle: React.CSSProperties = {
  background: '#fdecea',
  color: '#611a15',
  padding: '0.5rem 0.75rem',
  borderRadius: 4,
  fontSize: '0.85rem',
  marginTop: '0.5rem',
};

const submitBtnStyle: React.CSSProperties = {
  marginTop: '0.75rem',
  padding: '0.5rem 1.25rem',
  background: '#00a89d',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  fontSize: '0.9rem',
  fontWeight: 600,
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

const historyListStyle: React.CSSProperties = {
  maxHeight: 300,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};

const historyEntryStyle: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  background: '#f9f9f9',
  borderRadius: 6,
  border: '1px solid #eee',
};

const historyTimestampStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  color: '#999',
  marginTop: '0.25rem',
  display: 'block',
};

// ── Rule Traceability Styles ──

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

const ruleTraceabilityPanelStyle: React.CSSProperties = {
  textAlign: 'left',
  background: '#f8f9fa',
  border: '1px solid #e0e0e0',
  borderRadius: 6,
  padding: '0.75rem 1rem',
  margin: '0.25rem 0.75rem 0.5rem',
  cursor: 'pointer',
};

const noRulesTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '0.8rem',
  color: '#888',
  fontStyle: 'italic',
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

// ── Rule Creation Toggle Styles ──

const toggleRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  marginTop: '0.5rem',
};

const toggleLabelStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
  cursor: 'pointer',
};

const toggleTrackStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 36,
  height: 20,
  borderRadius: 10,
  position: 'relative',
  transition: 'background 0.2s',
  flexShrink: 0,
};

const toggleThumbStyle: React.CSSProperties = {
  display: 'block',
  width: 16,
  height: 16,
  borderRadius: '50%',
  background: '#fff',
  position: 'absolute',
  top: 2,
  left: 2,
  transition: 'transform 0.2s',
  boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
};

const ruleCreatedMsgStyle: React.CSSProperties = {
  background: '#e0f7f5',
  color: '#00695c',
  padding: '0.5rem 0.75rem',
  borderRadius: 4,
  fontSize: '0.85rem',
  marginTop: '0.5rem',
};

const ruleCreationWarningStyle: React.CSSProperties = {
  background: '#fff8e1',
  color: '#e65100',
  padding: '0.5rem 0.75rem',
  borderRadius: 4,
  fontSize: '0.85rem',
  marginTop: '0.5rem',
};

// ── Request Details Side Panel Styles ──

const sidePanelStyle: React.CSSProperties = {
  width: 320,
  flexShrink: 0,
  background: '#f8f9fa',
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  padding: '1rem 1.25rem',
  alignSelf: 'flex-start',
  position: 'sticky',
  top: '1rem',
  maxHeight: 'calc(100vh - 2rem)',
  overflowY: 'auto',
};

const sidePanelLabelStyle: React.CSSProperties = {
  margin: '0 0 0.25rem',
  fontSize: '0.75rem',
  fontWeight: 600,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const sidePanelTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '0.9rem',
  color: '#333',
  lineHeight: 1.4,
};

const sidePanelNoteStyle: React.CSSProperties = {
  padding: '0.5rem 0.6rem',
  background: '#fff',
  borderRadius: 6,
  border: '1px solid #eee',
};

// ── Inline Editing Styles ──

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

const addCustomBtnStyle: React.CSSProperties = {
  padding: '0.4rem 0.9rem',
  background: '#00a89d',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  fontSize: '0.85rem',
  fontWeight: 600,
};

const lineItemDescStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  color: '#888',
  marginTop: '0.15rem',
  lineHeight: 1.3,
};

const dragHandleStyle: React.CSSProperties = {
  color: '#ccc',
  fontSize: '1rem',
  cursor: 'grab',
  userSelect: 'none',
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

const updateCatalogLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  fontSize: '0.7rem',
  color: '#888',
  marginTop: '0.25rem',
  cursor: 'pointer',
  userSelect: 'none',
};

// ── Sqft Resolution Helpers ──

function getTierLabel(tier: ResolutionTier | null): string {
  switch (tier) {
    case 'text_extraction': return 'Extracted from request text';
    case 'layout_diagram': return 'Estimated from layout diagram';
    case 'public_records': return 'From public records';
    case 'manual_override': return 'Manual override';
    default: return 'Unknown source';
  }
}

function sqftConfidenceBadgeStyle(confidence: ResolutionConfidence): React.CSSProperties {
  const map: Record<ResolutionConfidence, { bg: string; color: string }> = {
    high: { bg: '#e0f7f5', color: '#00695c' },
    medium: { bg: '#fff8e1', color: '#e65100' },
    low: { bg: '#f5f5f5', color: '#757575' },
  };
  const { bg, color } = map[confidence] ?? { bg: '#f5f5f5', color: '#757575' };
  return {
    display: 'inline-block',
    padding: '0.15rem 0.5rem',
    borderRadius: 12,
    fontSize: '0.75rem',
    fontWeight: 600,
    background: bg,
    color,
    textTransform: 'capitalize',
  };
}

// ── Sqft Resolution Styles ──

const sqftResolutionSectionStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  padding: '1rem 1.25rem',
  marginBottom: '1rem',
};

const sqftResolutionRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.6rem',
  flexWrap: 'wrap',
  marginBottom: '0.4rem',
};

const sqftValueStyle: React.CSSProperties = {
  fontSize: '1.1rem',
  fontWeight: 700,
  color: '#333',
};

const sqftTierLabelStyle: React.CSSProperties = {
  fontSize: '0.8rem',
  color: '#666',
  background: '#f5f5f5',
  padding: '0.15rem 0.5rem',
  borderRadius: 10,
};

const sqftMetaTextStyle: React.CSSProperties = {
  margin: '0 0 0.5rem',
  fontSize: '0.8rem',
  color: '#888',
};

const sqftOriginalResolutionStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  flexWrap: 'wrap',
  marginTop: '0.5rem',
  padding: '0.4rem 0.6rem',
  background: '#f9f9f9',
  borderRadius: 6,
  border: '1px solid #eee',
};

const sqftClearBtnStyle: React.CSSProperties = {
  marginLeft: 'auto',
  background: 'none',
  border: '1px solid #ccc',
  borderRadius: 4,
  padding: '0.2rem 0.6rem',
  fontSize: '0.75rem',
  color: '#555',
  cursor: 'pointer',
};

const sqftUnavailableStyle: React.CSSProperties = {
  margin: '0 0 0.75rem',
  fontSize: '0.85rem',
  color: '#888',
  fontStyle: 'italic',
};

const sqftOverrideFormStyle: React.CSSProperties = {
  marginTop: '0.75rem',
  paddingTop: '0.75rem',
  borderTop: '1px solid #f0f0f0',
};

const sqftOverrideLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.8rem',
  fontWeight: 600,
  color: '#555',
  marginBottom: '0.4rem',
};

const sqftOverrideInputStyle: React.CSSProperties = {
  width: 120,
  padding: '0.4rem 0.6rem',
  border: '1px solid #ccc',
  borderRadius: 6,
  fontSize: '0.9rem',
  boxSizing: 'border-box',
};

const sqftSaveBtnStyle: React.CSSProperties = {
  padding: '0.4rem 0.9rem',
  background: '#00a89d',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  fontSize: '0.85rem',
  fontWeight: 600,
};

const sqftOverrideErrorStyle: React.CSSProperties = {
  margin: '0.35rem 0 0',
  fontSize: '0.8rem',
  color: '#d32f2f',
};
