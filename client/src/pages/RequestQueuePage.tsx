import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import DeathclockBadge from '../components/DeathclockBadge';
import RequestJobberQuoteModal from '../components/RequestJobberQuoteModal';
import type { ErrorResponse } from 'shared';
import { isPlaceholderJobberClientName } from 'shared';
import {
  fetchManualRequests,
  enrichManualRequests,
  generateQuote,
  fetchDrafts,
  deleteDraft,
  resolveRequestQuote,
  fetchRequestJobberQuotes,
} from '../api';
import type { ManualRequestWithDeathclock, ResolveRequestQuoteResult } from '../api';

// ---------------------------------------------------------------------------
// Deathclock color → hex map (mirrors DeathclockBadge component)
// ---------------------------------------------------------------------------
const DEATHCLOCK_COLORS: Record<string, string> = {
  green: '#10b981',
  yellow: '#eab308',
  orange: '#f97316',
  red: '#ef4444',
} as const;

/** Convert #rrggbb hex to "r, g, b" string for CSS custom properties. */
const hexToRgb = (hex: string): string => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
};

/** Draft created before Jobber/email enrichment finished — should be regenerated. */
function isSparseDraft(draft: {
  customerRequestText?: string;
  lineItems?: unknown[];
  unresolvedItems?: unknown[];
}): boolean {
  const hasText = (draft.customerRequestText ?? '').trim().length > 0;
  const itemCount = (draft.lineItems?.length ?? 0) + (draft.unresolvedItems?.length ?? 0);
  return !hasText && itemCount === 0;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RequestQueuePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [requests, setRequests] = useState<ManualRequestWithDeathclock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatingForId, setGeneratingForId] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [jobberQuoteBadges, setJobberQuoteBadges] = useState<
    Record<string, Array<{ quoteNumber: string; quoteStatus: string }>>
  >({});
  const [quoteModal, setQuoteModal] = useState<{
    req: ManualRequestWithDeathclock;
    resolution: ResolveRequestQuoteResult;
  } | null>(null);

  // Tick counter to trigger re-renders every second for live deathclock age
  const [tick, setTick] = useState(0);
  const lastFetchedAtRef = useRef(0);

  // 1-second tick — drives local age interpolation between polls
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Default to newest first unless sort=age_asc is explicitly set
  const sortParam = searchParams.get('sort');
  const currentSort: 'age_asc' | 'age_desc' =
    sortParam === 'age_asc' ? 'age_asc' : 'age_desc';

  const loadRequests = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    try {
      if (!silent) setLoading(true);
      setError(null);
      const result = await fetchManualRequests(currentSort);
      setRequests(result);
      lastFetchedAtRef.current = Date.now();

      const sparseJobberIds = result
        .filter((r) =>
          r.requestSource === 'jobber'
          && r.jobberRequestId
          && isPlaceholderJobberClientName(r.customerName),
        )
        .map((r) => r.jobberRequestId as string);
      const enrichInBatches = async (ids: string[], batchSize: number, fn: (chunk: string[]) => Promise<void>) => {
        for (let i = 0; i < ids.length; i += batchSize) {
          await fn(ids.slice(i, i + batchSize));
        }
      };
      if (sparseJobberIds.length > 0) {
        void enrichInBatches(sparseJobberIds, 10, async (chunk) => {
          const enriched = await enrichManualRequests(chunk);
          if (enriched.length === 0) return;
          setRequests((prev) => prev.map((req) => {
            const hit = enriched.find((e) => e.jobberRequestId === req.jobberRequestId);
            if (!hit) return req;
            return {
              ...req,
              customerName: hit.customerName,
              requestTitle: hit.requestTitle,
              requestBodyText: hit.requestBodyText,
              noteHighlights: hit.noteHighlights,
              serviceDescription: hit.serviceDescription,
            };
          }));
        }).catch(() => { /* best-effort background enrich */ });
      }

      const jobberIdsForBadges = result
        .filter((r) => r.jobberRequestId)
        .map((r) => r.jobberRequestId as string);
      if (jobberIdsForBadges.length > 0) {
        void enrichInBatches(jobberIdsForBadges, 10, async (chunk) => {
          const quotesByRequest = await fetchRequestJobberQuotes(chunk);
          setJobberQuoteBadges((prev) => {
            const next = { ...prev };
            for (const id of chunk) {
              if (quotesByRequest[id]?.length) {
                next[id] = quotesByRequest[id];
              } else {
                delete next[id];
              }
            }
            return next;
          });
        }).catch(() => { /* best-effort badge fetch */ });
      }
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Failed to load request queue.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [currentSort]);

  useEffect(() => { loadRequests(); }, [loadRequests]);

  const quoteModalOpenRef = useRef(false);
  useEffect(() => {
    quoteModalOpenRef.current = quoteModal !== null;
  }, [quoteModal]);

  // 60-second polling with visibility detection and immediate poll on focus
  useEffect(() => {
    const POLL_INTERVAL_MS = 60_000;

    let pollInterval: ReturnType<typeof setInterval> | undefined;

    function startPolling() {
      stopPolling();
      pollInterval = setInterval(() => {
        if (quoteModalOpenRef.current) return;
        loadRequests({ silent: true });
      }, POLL_INTERVAL_MS);
    }

    function stopPolling() {
      if (pollInterval !== undefined) {
        clearInterval(pollInterval);
        pollInterval = undefined;
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        startPolling();
      } else {
        stopPolling();
      }
    }

    function handleWindowFocus() {
      if (quoteModalOpenRef.current) return;
      loadRequests({ silent: true });
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);

    // Start polling only if the page is visible on mount
    if (document.visibilityState === 'visible') {
      startPolling();
    }

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [loadRequests]);

  const handleSortChange = (sort: 'age_asc' | 'age_desc') => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('sort', sort);
    navigate('?' + params.toString(), { replace: false });
  };

  const runGenerateQuote = async (req: ManualRequestWithDeathclock) => {
    const cardKey = req.jobberRequestId ?? req.id;
    if (generatingForId) return;
    setGenerateError(null);
    setGeneratingForId(cardKey);

    try {
      const drafts = await fetchDrafts();
      const existingDraft = drafts
        .filter((d) => d.status !== 'finalized')
        .find((d) =>
          req.jobberRequestId
            ? d.jobberRequestId === req.jobberRequestId
            : d.manualRequestId === req.id,
        );

      if (existingDraft) {
        if (!isSparseDraft(existingDraft)) {
          navigate('/quotes/drafts/' + existingDraft.id);
          return;
        }
        await deleteDraft(existingDraft.id);
      }

      const payload = req.jobberRequestId
        ? { jobberRequestId: req.jobberRequestId }
        : { manualRequestId: req.id, customerText: '' };
      const draft = await generateQuote(payload);
      navigate('/quotes/drafts/' + draft.id);
    } catch (err) {
      setGenerateError((err as ErrorResponse).message ?? 'Failed to create quote draft.');
    } finally {
      setGeneratingForId(null);
    }
  };

  const handleRequestClick = async (req: ManualRequestWithDeathclock) => {
    if (generatingForId) return;

    if (!req.jobberRequestId) {
      await runGenerateQuote(req);
      return;
    }

    const cardKey = req.jobberRequestId;
    setGenerateError(null);
    setGeneratingForId(cardKey);

    try {
      const resolution = await resolveRequestQuote(req.jobberRequestId);

      if (resolution.recommendedAction === 'import_jobber') {
        setQuoteModal({ req, resolution });
        return;
      }

      if (resolution.recommendedAction === 'open_cotiza') {
        const importedDraftId = resolution.jobberQuotes.find((q) => q.importedDraftId)?.importedDraftId;
        const draftId = importedDraftId ?? resolution.cotizaDraft?.id;
        if (draftId) {
          navigate('/quotes/drafts/' + draftId);
          return;
        }
      }

      await runGenerateQuote(req);
    } catch (err) {
      setGenerateError((err as ErrorResponse).message ?? 'Failed to resolve quote for this request.');
    } finally {
      setGeneratingForId(null);
    }
  };

  // ── Loading state (initial load only — keep list + modal visible during background refresh) ──
  if (loading && requests.length === 0) {
    return (
      <div style={containerStyle}>
        <div style={loadingContainerStyle}>
          <span style={spinnerStyle} />
          <p style={{ margin: '0.75rem 0 0', color: '#555' }}>Loading request queue…</p>
        </div>
      </div>
    );
  }

  // Check if any card needs the pulsing glow animation
  const anyShouldPulse = requests.some(
    (r) => !r.deathclock.frozen && !r.deathclock.isComplete && ['yellow', 'orange', 'red'].includes(r.deathclock.color)
  );

  return (
    <div style={containerStyle}>
      {quoteModal && (
        <RequestJobberQuoteModal
          resolution={quoteModal.resolution}
          customerName={quoteModal.req.customerName}
          onClose={() => setQuoteModal(null)}
          onOpenCotiza={(draftId) => {
            setQuoteModal(null);
            navigate('/quotes/drafts/' + draftId);
          }}
          onGenerateNew={() => {
            const req = quoteModal.req;
            setQuoteModal(null);
            void runGenerateQuote(req);
          }}
        />
      )}
      {generatingForId && (
        <>
          <style>{`
@keyframes spin {
  to { transform: rotate(360deg); }
}
`}</style>
          <div style={generatingOverlayStyle} role="status" aria-live="polite">
            <span style={overlaySpinnerStyle} />
            <p style={{ margin: '1rem 0 0', color: '#061216', fontWeight: 500 }}>
              Creating quote draft…
            </p>
            <p style={{ margin: '0.35rem 0 0', color: '#666', fontSize: '0.85rem' }}>
              Pulling request details and generating line items
            </p>
          </div>
        </>
      )}
      {anyShouldPulse && (
        <style>{`
@keyframes dc-card-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(var(--dc-card-rgb), 0.3); }
  50% { box-shadow: 0 0 8px 2px rgba(var(--dc-card-rgb), 0.15); }
}
`}</style>
      )}
      <h1 style={titleStyle}>Request Queue</h1>

      {/* Sort toggle */}
      <div style={sortToggleContainerStyle}>
        <button
          type="button"
          style={currentSort === 'age_asc' ? sortToggleActiveStyle : sortToggleInactiveStyle}
          onClick={() => handleSortChange('age_asc')}
          aria-label="Sort oldest first"
        >
          Oldest First
        </button>
        <button
          type="button"
          style={currentSort === 'age_desc' ? sortToggleActiveStyle : sortToggleInactiveStyle}
          onClick={() => handleSortChange('age_desc')}
          aria-label="Sort newest first"
        >
          Newest First
        </button>
      </div>

      {error && (
        <div role="alert" style={alertStyle}>{error}</div>
      )}

      {generateError && (
        <div role="alert" style={alertStyle}>{generateError}</div>
      )}

      {requests.length === 0 ? (
        <div style={emptyStyle}>
          <p style={{ margin: 0, color: '#888' }}>No pending requests in the queue.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {requests.map((req) => {
            const cardKey = req.jobberRequestId ?? req.id;
            const colorHex = DEATHCLOCK_COLORS[req.deathclock.color] ?? '#10b981';
            const liveAge = req.deathclock.ageSeconds + Math.floor((Date.now() - lastFetchedAtRef.current) / 1000);
            const shouldPulse = !req.deathclock.frozen && !req.deathclock.isComplete &&
              (req.deathclock.color === 'yellow' || req.deathclock.color === 'orange' || req.deathclock.color === 'red');
            const isGenerating = generatingForId === cardKey;
            const linkedQuotes = req.jobberRequestId ? jobberQuoteBadges[req.jobberRequestId] : undefined;
            const bodyText = (req.requestBodyText ?? '').trim();
            const noteHighlights = req.noteHighlights ?? [];
            const titleDuplicatesBody = !!(
              req.requestTitle?.trim()
              && bodyText
              && req.requestTitle.trim() === bodyText
            );
            return (
              <div
                key={cardKey}
                style={{
                  ...cardStyle,
                  borderLeft: `4px solid ${colorHex}`,
                  opacity: generatingForId && !isGenerating ? 0.6 : 1,
                  pointerEvents: generatingForId ? 'none' : 'auto',
                  ...(shouldPulse ? { '--dc-card-rgb': hexToRgb(colorHex), animation: 'dc-card-glow 2s ease-in-out infinite' } as React.CSSProperties : {}),
                }}
                onClick={() => { handleRequestClick(req); }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleRequestClick(req);
                    }
                  }}
                aria-label={`Request from ${req.customerName}`}
                aria-busy={isGenerating}
              >
                <div style={cardInnerStyle}>
                  <div style={cardHeaderStyle}>
                    <span style={customerNameStyle}>
                      {req.customerName}
                    </span>
                    <DeathclockBadge
                      ageSeconds={liveAge}
                      color={req.deathclock.color}
                      isComplete={req.deathclock.isComplete}
                      frozen={req.deathclock.frozen}
                      compact
                    />
                  </div>
                  {req.requestTitle?.trim() && (
                    <p style={requestTitleStyle}>{req.requestTitle}</p>
                  )}
                  {noteHighlights.length > 0 && (
                    <div style={highlightsContainerStyle}>
                      {noteHighlights.slice(0, 2).map((note, i) => (
                        <div
                          key={i}
                          style={{
                            ...highlightBoxStyle,
                            ...(note.label === 'Client' ? clientHighlightStyle : {}),
                          }}
                        >
                          <span style={highlightLabelStyle}>{note.label}</span>
                          <p style={highlightTextStyle}>
                            {note.message.length > 200
                              ? note.message.slice(0, 200) + '…'
                              : note.message}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                  {noteHighlights.length === 0 && bodyText && !titleDuplicatesBody && (
                    <div style={highlightsContainerStyle}>
                      <div style={highlightBoxStyle}>
                        <span style={highlightLabelStyle}>Request</span>
                        <p style={highlightTextStyle}>
                          {bodyText.length > 200 ? bodyText.slice(0, 200) + '…' : bodyText}
                        </p>
                      </div>
                    </div>
                  )}
                  <div style={metaRowStyle}>
                    <span style={metaStyle}>
                      Created {new Date(req.createdAt).toLocaleDateString()}
                    </span>
                    {req.jobberRequestId && (
                      <span style={metaStyle}>
                        Jobber #{decodeJobberId(req.jobberRequestId)}
                      </span>
                    )}
                    {linkedQuotes && linkedQuotes.length > 0 && (
                      <span style={jobberQuoteBadgeStyle}>
                        Jobber quote #{linkedQuotes[0].quoteNumber} · {linkedQuotes[0].quoteStatus.replace(/_/g, ' ')}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Styles ──

const containerStyle: React.CSSProperties = { maxWidth: 800, margin: '0 auto' };
const titleStyle: React.CSSProperties = { margin: '0 0 1.25rem', fontSize: '1.5rem' };

const sortToggleContainerStyle: React.CSSProperties = {
  display: 'inline-flex',
  border: '1px solid #d0d0d0',
  borderRadius: 6,
  overflow: 'hidden',
  marginBottom: '1rem',
};

const sortToggleBaseStyle: React.CSSProperties = {
  border: 'none',
  padding: '0.4rem 0.9rem',
  fontSize: '0.85rem',
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'background 0.15s, color 0.15s',
  outline: 'none',
} as const;

const sortToggleActiveStyle: React.CSSProperties = {
  ...sortToggleBaseStyle,
  background: '#00a89d',
  color: '#fff',
};

const sortToggleInactiveStyle: React.CSSProperties = {
  ...sortToggleBaseStyle,
  background: '#fff',
  color: '#555',
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

const alertStyle: React.CSSProperties = {
  background: '#fdecea',
  color: '#611a15',
  padding: '0.75rem 1rem',
  borderRadius: 4,
  marginBottom: '1rem',
};

const emptyStyle: React.CSSProperties = {
  textAlign: 'center',
  padding: '3rem 1rem',
  background: '#fff',
  borderRadius: 8,
  border: '1px solid #e0e0e0',
};

const cardStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  background: '#fff',
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  overflow: 'hidden',
  cursor: 'pointer',
};

const cardInnerStyle: React.CSSProperties = {
  flex: 1,
  padding: '0.75rem 1rem',
  minWidth: 0,
};

const cardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  marginBottom: '0.25rem',
};

const customerNameStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: '0.95rem',
  color: '#061216',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const requestTitleStyle: React.CSSProperties = {
  margin: '0 0 0.5rem',
  fontSize: '0.9rem',
  fontWeight: 600,
  color: '#00a89d',
  lineHeight: 1.35,
};

const highlightsContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.4rem',
  marginBottom: '0.5rem',
};

const highlightBoxStyle: React.CSSProperties = {
  padding: '0.5rem 0.65rem',
  background: '#f8f9fa',
  borderLeft: '3px solid #cbd5e1',
  borderRadius: 4,
};

const clientHighlightStyle: React.CSSProperties = {
  background: '#f0fdf9',
  borderLeftColor: '#00a89d',
};

const highlightLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.7rem',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: '#888',
  marginBottom: '0.2rem',
};

const highlightTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '0.85rem',
  color: '#333',
  lineHeight: 1.45,
  whiteSpace: 'pre-wrap',
};

const descriptionStyle: React.CSSProperties = {
  margin: '0 0 0.4rem',
  fontSize: '0.9rem',
  fontWeight: 500,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const metaRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '0.75rem',
  alignItems: 'center',
  flexWrap: 'wrap',
};

const metaStyle: React.CSSProperties = {
  fontSize: '0.8rem',
  color: '#888',
};

const jobberQuoteBadgeStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  fontWeight: 500,
  color: '#1565c0',
  background: '#e3f2fd',
  padding: '0.1rem 0.4rem',
  borderRadius: 4,
};

const generatingOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(255, 255, 255, 0.92)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const overlaySpinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 40,
  height: 40,
  border: '4px solid #e0e0e0',
  borderTopColor: '#00a89d',
  borderRadius: '50%',
  animation: 'spin 0.7s linear infinite',
};

/** Decode a base64 Jobber GraphQL ID and extract the numeric request ID for display. */
function decodeJobberId(id: string): string {
  try {
    const decoded = atob(id);
    // Format: gid://Jobber/Request/29995593
    const parts = decoded.split('/');
    return parts[parts.length - 1] || id.slice(0, 12);
  } catch {
    return id.slice(0, 12);
  }
}