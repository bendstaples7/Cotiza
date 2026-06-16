import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { QuoteDraft, ErrorResponse } from 'shared';
import { fetchManualRequests, fetchImportableQuotes, importJobberQuote, generateQuote, fetchDrafts } from '../api';
import type { ImportableQuote } from '../api';

// ── Helpers ──

function getClientName(quote: ImportableQuote): string {
  if (!quote.client) return 'Unknown Client';
  const { firstName, lastName, companyName } = quote.client;
  return companyName || [firstName, lastName].filter(Boolean).join(' ') || 'Unknown Client';
}

function getQuoteTotal(quote: ImportableQuote): number {
  return (quote.lineItems || []).reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
}

function formatCurrency(amount: number): string {
  return '$' + amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function QuotesHubPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const createFromRequestId = searchParams.get('createFromRequestId');

  // ── Create New section ──
  const [descriptionText, setDescriptionText] = useState('');
  const [generatingFromRequest, setGeneratingFromRequest] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // ── Accordion state ──
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['create', 'drafts', 'importable', 'finalized']));

  const toggleSection = (name: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // ── Your Work section ──
  const [allDrafts, setAllDrafts] = useState<QuoteDraft[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(true);
  const [draftsError, setDraftsError] = useState<string | null>(null);

  const [importableQuotes, setImportableQuotes] = useState<ImportableQuote[]>([]);
  const [importableLoading, setImportableLoading] = useState(false);
  const [importingIds, setImportingIds] = useState<Set<string>>(new Set());

  // ── Load drafts (used by both active and finalized tabs) ──
  const loadDrafts = useCallback(async () => {
    try {
      setDraftsLoading(true);
      setDraftsError(null);
      const result = await fetchDrafts();
      setAllDrafts(result);
    } catch (err) {
      setDraftsError((err as ErrorResponse).message ?? 'Failed to load drafts.');
    } finally {
      setDraftsLoading(false);
    }
  }, []);

  useEffect(() => { loadDrafts(); }, [loadDrafts]);

  // ── Load importable quotes ──
  const loadImportable = useCallback(async () => {
    try {
      setImportableLoading(true);
      const data = await fetchImportableQuotes();
      setImportableQuotes(data.available ? data.quotes : []);
    } catch {
      setImportableQuotes([]);
    } finally {
      setImportableLoading(false);
    }
  }, []);

  useEffect(() => {
    loadImportable();
  }, [loadImportable]);

  // ── Handle generate from request ──
  const handleGenerateFromRequest = useCallback(async () => {
    if (!createFromRequestId) return;
    setGeneratingFromRequest(true);
    setCreateError(null);
    try {
      const draft = await generateQuote({ jobberRequestId: createFromRequestId });
      navigate('/quotes/drafts/' + draft.id);
    } catch (err) {
      setCreateError((err as ErrorResponse).message ?? 'Generation failed.');
    } finally {
      setGeneratingFromRequest(false);
    }
  }, [createFromRequestId, navigate]);

  useEffect(() => {
    if (createFromRequestId && !generatingFromRequest) {
      handleGenerateFromRequest();
    }
  }, [createFromRequestId]); // only trigger on mount

  // ── Handle new description generate ──
  const handleGenerate = async () => {
    const trimmed = descriptionText.trim();
    if (!trimmed || generating) return;
    setGenerating(true);
    setCreateError(null);
    try {
      const draft = await generateQuote({ customerText: trimmed });
      navigate('/quotes/drafts/' + draft.id);
    } catch (err) {
      setCreateError((err as ErrorResponse).message ?? 'Generation failed.');
    } finally {
      setGenerating(false);
    }
  };

  // ── Handle import ──
  const handleImport = async (quoteId: string) => {
    setImportingIds(prev => new Set(prev).add(quoteId));
    try {
      const result = await importJobberQuote(quoteId);
      navigate('/quotes/drafts/' + result.draft.id);
    } catch {
      // Error displayed via toast from handleResponseWithToast
    } finally {
      setImportingIds(prev => {
        const next = new Set(prev);
        next.delete(quoteId);
        return next;
      });
    }
  };

  // ── Filtered lists ──
  const activeDrafts = allDrafts.filter(d => d.status !== 'finalized');
  const finalizedDrafts = allDrafts.filter(d => d.status === 'finalized');

  // ── Render ──

  return (
    <div style={pageStyle}>
      {/* ── Section 1: Create New Quote ── */}
      {createFromRequestId ? (
        <div style={cardStyle}>
          <h2 style={sectionTitleStyle}>Create New Quote</h2>
          {generatingFromRequest ? (
            <div style={loadingRowStyle}>
              <span style={spinnerStyle} />
              <span style={{ color: '#555', fontSize: '0.9rem' }}>Generating from request…</span>
            </div>
          ) : (
            <div>
              <p style={{ color: '#555', fontSize: '0.9rem', margin: '0 0 0.75rem' }}>
                Generating from request #{createFromRequestId}
              </p>
              {createError && <div role="alert" style={errorStyle}>{createError}</div>}
            </div>
          )}
        </div>
      ) : (
        <div style={cardStyle}>
          <h2 style={sectionTitleStyle}>Create New Quote</h2>
          <textarea
            value={descriptionText}
            onChange={(e) => setDescriptionText(e.target.value)}
            placeholder="Describe the work the customer wants, or paste their message/email…"
            rows={4}
            style={textareaStyle}
            disabled={generating}
            aria-label="Quote description"
          />
          {createError && <div role="alert" style={errorStyle}>{createError}</div>}
          <div style={{ marginTop: '0.75rem' }}>
            <button
              onClick={handleGenerate}
              disabled={!descriptionText.trim() || generating}
              style={{
                ...btnPrimaryStyle,
                opacity: !descriptionText.trim() || generating ? 0.5 : 1,
              }}
              type="button"
            >
              {generating ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={smallSpinnerStyle} />
                  Generating…
                </span>
              ) : (
                'Generate'
              )}
            </button>
          </div>
        </div>
      )}

      {/* ── Section 2: Your Work (accordion sections) ── */}
      <div style={{ marginTop: '2rem' }}>
        <h2 style={sectionTitleStyle}>Your Work</h2>

        {/* Active Drafts accordion */}
        <div style={accordionWrapperStyle}>
          <button onClick={() => toggleSection('drafts')} style={sectionToggleStyle}>
            <span style={{ marginRight: '0.5rem' }}>{expandedSections.has('drafts') ? '▼' : '▶'}</span>
            <span style={{ fontWeight: 600 }}>Active Drafts</span>
            {activeDrafts.length > 0 && (
              <span style={badgeStyle}>{activeDrafts.length}</span>
            )}
          </button>
          {expandedSections.has('drafts') && (
            <div style={sectionContentStyle}>
              {draftsLoading ? (
                <div style={loadingRowStyle}>
                  <span style={spinnerStyle} />
                  <span style={{ color: '#555', fontSize: '0.9rem' }}>Loading drafts…</span>
                </div>
              ) : draftsError ? (
                <div role="alert" style={errorStyle}>{draftsError}</div>
              ) : activeDrafts.length === 0 ? (
                <div style={emptyStyle}>No active drafts. Create a new quote to get started.</div>
              ) : (
                <div style={listStyle}>
                  {activeDrafts.map(draft => (
                    <div
                      key={draft.id}
                      style={draftCardStyle}
                      onClick={() => navigate('/quotes/drafts/' + draft.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') navigate('/quotes/drafts/' + draft.id); }}
                    >
                      <div style={draftCardHeaderStyle}>
                        <span style={draftNumberStyle}>D-{String(draft.draftNumber).padStart(3, '0')}</span>
                        {draft.clientName && (
                          <span style={clientNameLabelStyle}>{draft.clientName}</span>
                        )}
                        <span style={statusBadgeStyle(draft.status)}>{draft.status}</span>
                      </div>
                      <div style={metaTextStyle}>
                        {new Date(draft.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Importable Jobber Quotes accordion */}
        <div style={accordionWrapperStyle}>
          <button onClick={() => toggleSection('importable')} style={sectionToggleStyle}>
            <span style={{ marginRight: '0.5rem' }}>{expandedSections.has('importable') ? '▼' : '▶'}</span>
            <span style={{ fontWeight: 600 }}>Importable Jobber Quotes</span>
            {importableQuotes.length > 0 && (
              <span style={badgeStyle}>{importableQuotes.length}</span>
            )}
          </button>
          {expandedSections.has('importable') && (
            <div style={sectionContentStyle}>
              {importableLoading ? (
                <div style={loadingRowStyle}>
                  <span style={spinnerStyle} />
                  <span style={{ color: '#555', fontSize: '0.9rem' }}>Loading Jobber quotes…</span>
                </div>
              ) : importableQuotes.length === 0 ? (
                <div style={emptyStyle}>No importable quotes available.</div>
              ) : (
                <div style={listStyle}>
                  {importableQuotes.map(quote => {
                    const total = getQuoteTotal(quote);
                    const isImporting = importingIds.has(quote.id);
                    return (
                      <div key={quote.id} style={importableCardStyle}>
                        <div style={importableCardHeaderStyle}>
                          <div>
                            <div style={importableTitleRow}>
                              <span style={quoteNumberStyle}>#{quote.quoteNumber}</span>
                              <span style={clientNameLabelStyle}>{getClientName(quote)}</span>
                            </div>
                            <div style={metaTextStyle}>
                              {formatCurrency(total)} · {quote.quoteStatus}
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleImport(quote.id); }}
                          disabled={isImporting}
                          style={{
                            ...importBtnStyle,
                            opacity: isImporting ? 0.6 : 1,
                          }}
                          type="button"
                        >
                          {isImporting ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                              <span style={smallSpinnerStyle} />
                              Importing…
                            </span>
                          ) : (
                            'Import as Draft'
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Finalized accordion */}
        <div style={accordionWrapperStyle}>
          <button onClick={() => toggleSection('finalized')} style={sectionToggleStyle}>
            <span style={{ marginRight: '0.5rem' }}>{expandedSections.has('finalized') ? '▼' : '▶'}</span>
            <span style={{ fontWeight: 600 }}>Finalized</span>
            {finalizedDrafts.length > 0 && (
              <span style={badgeStyle}>{finalizedDrafts.length}</span>
            )}
          </button>
          {expandedSections.has('finalized') && (
            <div style={sectionContentStyle}>
              {draftsLoading ? (
                <div style={loadingRowStyle}>
                  <span style={spinnerStyle} />
                  <span style={{ color: '#555', fontSize: '0.9rem' }}>Loading finalized quotes…</span>
                </div>
              ) : draftsError ? (
                <div role="alert" style={errorStyle}>{draftsError}</div>
              ) : finalizedDrafts.length === 0 ? (
                <div style={emptyStyle}>No finalized quotes yet.</div>
              ) : (
                <div style={listStyle}>
                  {finalizedDrafts.map(draft => (
                    <div
                      key={draft.id}
                      style={draftCardStyle}
                      onClick={() => navigate('/quotes/drafts/' + draft.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') navigate('/quotes/drafts/' + draft.id); }}
                    >
                      <div style={draftCardHeaderStyle}>
                        <span style={draftNumberStyle}>D-{String(draft.draftNumber).padStart(3, '0')}</span>
                        {draft.clientName && (
                          <span style={clientNameLabelStyle}>{draft.clientName}</span>
                        )}
                        <span style={statusBadgeStyle(draft.status)}>{draft.status}</span>
                      </div>
                      <div style={metaTextStyle}>
                        {new Date(draft.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Styles ──

const pageStyle: React.CSSProperties = {
  padding: '1.5rem',
  background: '#f5f5f5',
  minHeight: '100%',
};

const cardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  padding: '1.25rem',
};

const sectionTitleStyle: React.CSSProperties = {
  margin: '0 0 1rem',
  fontSize: '1.15rem',
  fontWeight: 600,
  color: '#061216',
};

const textareaStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '0.5rem',
  border: '1px solid #ccc',
  borderRadius: 4,
  fontSize: '0.9rem',
  boxSizing: 'border-box',
  resize: 'vertical',
  fontFamily: 'inherit',
};

const btnPrimaryStyle: React.CSSProperties = {
  padding: '0.55rem 1.25rem',
  border: '1px solid #00a89d',
  background: '#00a89d',
  color: '#fff',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.9rem',
  fontWeight: 500,
};

const accordionWrapperStyle: React.CSSProperties = {
  marginBottom: '0.5rem',
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  background: '#fff',
  overflow: 'hidden',
};

const sectionToggleStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  padding: '0.75rem 1rem',
  border: 'none',
  background: '#fafafa',
  cursor: 'pointer',
  fontSize: '0.9rem',
  fontFamily: 'inherit',
  color: '#061216',
  textAlign: 'left',
};

const sectionContentStyle: React.CSSProperties = {
  padding: '0.75rem 1rem',
  borderTop: '1px solid #e0e0e0',
};

const badgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 18,
  height: 18,
  padding: '0 0.3rem',
  borderRadius: 10,
  background: '#00a89d',
  color: '#fff',
  fontSize: '0.7rem',
  fontWeight: 600,
  marginLeft: '0.5rem',
};

const loadingRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  padding: '1rem 0',
};

const spinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 20,
  height: 20,
  border: '2px solid #e0e0e0',
  borderTopColor: '#00a89d',
  borderRadius: '50%',
  animation: 'spin 0.6s linear infinite',
};

const smallSpinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 12,
  height: 12,
  border: '2px solid rgba(255,255,255,0.3)',
  borderTopColor: '#fff',
  borderRadius: '50%',
  animation: 'spin 0.6s linear infinite',
};

const errorStyle: React.CSSProperties = {
  background: '#fdecea',
  color: '#611a15',
  padding: '0.5rem 0.75rem',
  borderRadius: 4,
  marginTop: '0.5rem',
  fontSize: '0.85rem',
};

const emptyStyle: React.CSSProperties = {
  color: '#888',
  fontSize: '0.9rem',
  padding: '1.5rem 0',
  textAlign: 'center',
};

const listStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.6rem',
};

const draftCardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  padding: '0.75rem 1rem',
  cursor: 'pointer',
  transition: 'border-color 0.15s',
};

const draftCardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  marginBottom: '0.25rem',
};

const draftNumberStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: '0.95rem',
  color: '#061216',
};

const clientNameLabelStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#555',
};

const metaTextStyle: React.CSSProperties = {
  fontSize: '0.8rem',
  color: '#888',
};

const statusBadgeStyle = (status: string): React.CSSProperties => ({
  padding: '0.1rem 0.4rem',
  borderRadius: 4,
  fontSize: '0.7rem',
  fontWeight: 500,
  background: status === 'draft' ? '#e3f2fd' : status === 'finalized' ? '#e8f5e9' : '#f5f5f5',
  color: status === 'draft' ? '#1565c0' : status === 'finalized' ? '#2e7d32' : '#666',
  textTransform: 'capitalize' as const,
  marginLeft: 'auto',
});

const importableCardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  padding: '0.75rem 1rem',
};

const importableCardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '0.5rem',
};

const importableTitleRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  marginBottom: '0.15rem',
};

const quoteNumberStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: '0.85rem',
  color: '#00a89d',
};

const importBtnStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.4rem 0',
  border: '1px solid #00a89d',
  background: '#00a89d',
  color: '#fff',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.8rem',
  fontWeight: 500,
  fontFamily: 'inherit',
};