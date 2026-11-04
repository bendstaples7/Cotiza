import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import DeathclockBadge from '../components/DeathclockBadge';
import RequestJobberQuoteModal from '../components/RequestJobberQuoteModal';
import { formatDay, sourceList, timeAgo } from '../components/LeadContactLine';
import type { ErrorResponse } from 'shared';
import { isPlaceholderJobberClientName } from 'shared';
import {
  fetchRequestQueue,
  enrichManualRequests,
  generateQuote,
  fetchDrafts,
  deleteDraft,
  resolveRequestQuote,
  fetchRequestJobberQuotes,
  fetchLeadSummaries,
  fetchLeadContactStatuses,
  setLeadNotALead,
} from '../api';
import type { JobberQueueStatus, LeadContactStatus, LeadInfoSummary, LeadWorkflow, ManualRequestWithDeathclock, ResolveRequestQuoteResult } from '../api';

// ---------------------------------------------------------------------------
// Deathclock color → hex map (mirrors DeathclockBadge component)
// ---------------------------------------------------------------------------
const DEATHCLOCK_COLORS: Record<string, string> = {
  green: '#10b981',
  yellow: '#eab308',
  orange: '#f97316',
  red: '#ef4444',
} as const;

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

const MAX_BACKGROUND_QUEUE_IDS = 30;
const BACKGROUND_BATCH_SIZE = 10;

async function enrichInBatches(
  ids: string[],
  batchSize: number,
  fn: (chunk: string[]) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < ids.length; i += batchSize) {
    try {
      await fn(ids.slice(i, i + batchSize));
    } catch {
      // Best-effort — continue with remaining batches
    }
  }
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
  const [jobberStatus, setJobberStatus] = useState<JobberQueueStatus | null>(null);
  const [generatingForId, setGeneratingForId] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [leadSummaries, setLeadSummaries] = useState<Record<string, LeadInfoSummary>>({});
  const [contactStatuses, setContactStatuses] = useState<Record<string, LeadContactStatus | null>>({});
  const contactLoadGeneration = useRef(0);
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
  const generatingRef = useRef<string | null>(null);

  const beginGenerating = (cardKey: string): boolean => {
    if (generatingRef.current) return false;
    generatingRef.current = cardKey;
    setGeneratingForId(cardKey);
    return true;
  };

  const endGenerating = () => {
    generatingRef.current = null;
    setGeneratingForId(null);
  };

  // 1-second tick — drives local age interpolation between polls
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Default to oldest first, so the lead waiting longest is worked first, unless sort=age_desc is set
  const sortParam = searchParams.get('sort');
  const currentSort: 'age_asc' | 'age_desc' =
    sortParam === 'age_desc' ? 'age_desc' : 'age_asc';

  const loadRequests = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    try {
      if (!silent) setLoading(true);
      setError(null);
      const queue = await fetchRequestQueue(currentSort);
      const result = queue.requests;
      setRequests(result);
      setJobberStatus(queue.jobber ?? null);
      lastFetchedAtRef.current = Date.now();

      const sparseJobberIds = result
        .filter((r) =>
          r.requestSource === 'jobber'
          && r.jobberRequestId
          && isPlaceholderJobberClientName(r.customerName),
        )
        .map((r) => r.jobberRequestId as string)
        .slice(0, MAX_BACKGROUND_QUEUE_IDS);
      if (sparseJobberIds.length > 0) {
        void enrichInBatches(sparseJobberIds, BACKGROUND_BATCH_SIZE, async (chunk) => {
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
        });
      }

      const jobberIdsForBadges = result
        .filter((r) => r.jobberRequestId)
        .map((r) => r.jobberRequestId as string)
        .slice(0, MAX_BACKGROUND_QUEUE_IDS);
      // Info-needed counts for the lead badges (best-effort; the queue works without them).
      const leadIds = result.filter((r) => r.jobberRequestId).map((r) => r.jobberRequestId as string).slice(0, 200);
      if (leadIds.length > 0) {
        try {
          fetchLeadSummaries(leadIds)
            .then(({ summaries }) => setLeadSummaries(summaries))
            .catch(() => undefined);
          // Last/next contact reads Jobber, Quo and Gmail per lead, so it arrives after the cards.
          // A slower response from an earlier load must not overwrite a newer one.
          // Batches of 50 (the endpoint's limit); a failed batch marks its leads as unknown (null), never as "do now".
          const generation = ++contactLoadGeneration.current;
          if (!silent) setContactStatuses({});
          for (let i = 0; i < leadIds.length; i += 50) {
            const batch = leadIds.slice(i, i + 50);
            fetchLeadContactStatuses(batch)
              .then(({ statuses }) => {
                if (generation !== contactLoadGeneration.current) return;
                setContactStatuses((prev) => ({ ...prev, ...Object.fromEntries(batch.map((id) => [id, statuses[id] ?? null])) }));
              })
              .catch(() => {
                if (generation !== contactLoadGeneration.current) return;
                setContactStatuses((prev) => ({ ...prev, ...Object.fromEntries(batch.map((id) => [id, prev[id] ?? null])) }));
              });
          }
        } catch {
          // Lead badges are optional; never block the queue.
        }
      }
      const activeBadgeIds = new Set(jobberIdsForBadges);
      if (jobberIdsForBadges.length > 0) {
        setJobberQuoteBadges((prev) => {
          const pruned = { ...prev };
          for (const id of Object.keys(pruned)) {
            if (!activeBadgeIds.has(id)) delete pruned[id];
          }
          return pruned;
        });
        void enrichInBatches(jobberIdsForBadges, BACKGROUND_BATCH_SIZE, async (chunk) => {
          try {
            const quotesByRequest = await fetchRequestJobberQuotes(chunk);
            setJobberQuoteBadges((prev) => {
              const next = { ...prev };
              for (const id of chunk) {
                const badges = quotesByRequest[id];
                if (badges?.length) next[id] = badges;
                else delete next[id];
              }
              return next;
            });
          } catch {
            // Keep prior badges for this chunk when the fetch fails
          }
        });
      } else {
        setJobberQuoteBadges({});
      }
    } catch (err) {
      setJobberStatus(null);
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

  const doGenerateQuote = async (req: ManualRequestWithDeathclock) => {
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
  };

  const runGenerateQuote = async (req: ManualRequestWithDeathclock) => {
    const cardKey = req.jobberRequestId ?? req.id;
    if (!beginGenerating(cardKey)) return;
    setGenerateError(null);

    try {
      await doGenerateQuote(req);
    } catch (err) {
      setGenerateError((err as ErrorResponse).message ?? 'Failed to create quote draft.');
    } finally {
      endGenerating();
    }
  };

  /** Jobber requests open their lead page (with the next action, if any); manual requests keep the quote builder flow. */
  const openRequest = (req: ManualRequestWithDeathclock, action?: string) => {
    if (req.jobberRequestId) {
      navigate('/quotes/leads/' + encodeURIComponent(req.jobberRequestId) + (action ? '?action=' + encodeURIComponent(action) : ''));
      return;
    }
    void handleRequestClick(req);
  };

  const [markingId, setMarkingId] = useState<string | null>(null);
  const markNotALead = async (requestId: string, notALead: boolean) => {
    setMarkingId(requestId);
    try {
      await setLeadNotALead(requestId, notALead);
      // Move the row right away; the next poll recomputes the rest.
      setContactStatuses((prev) => {
        const status = prev[requestId];
        const w = status?.workflow;
        if (!status || !w) return prev;
        return { ...prev, [requestId]: { ...status, workflow: { ...w, notALead, bucket: notALead || w.likelySpam ? 'review' : 'do_now' } } };
      });
      void loadRequests({ silent: true });
    } catch {
      // The API helper already shows a toast.
    } finally {
      setMarkingId(null);
    }
  };

  const handleRequestClick = async (req: ManualRequestWithDeathclock) => {
    const cardKey = req.jobberRequestId ?? req.id;
    if (!beginGenerating(cardKey)) return;
    setGenerateError(null);

    try {
      if (!req.jobberRequestId) {
        await doGenerateQuote(req);
        return;
      }

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

      await doGenerateQuote(req);
    } catch (err) {
      setGenerateError((err as ErrorResponse).message ?? 'Failed to resolve quote for this request.');
    } finally {
      endGenerating();
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

  void tick; // re-render each second so "x min ago" stays current
  const now = Date.now();
  const leads = requests.filter((r) => r.jobberRequestId);
  const manual = requests.filter((r) => !r.jobberRequestId);
  const workflowOf = (r: ManualRequestWithDeathclock): LeadWorkflow | null => contactStatuses[r.jobberRequestId as string]?.workflow ?? null;
  // Rows keep the queue's order (oldest first by default) inside each section. A lead whose next
  // step is still loading, or could not be worked out, is never counted as "do now".
  const doNow = leads.filter((r) => workflowOf(r)?.bucket === 'do_now');
  const waiting = leads.filter((r) => workflowOf(r)?.bucket === 'waiting');
  const review = leads.filter((r) => workflowOf(r)?.bucket === 'review');
  const pending = leads.filter((r) => !(r.jobberRequestId! in contactStatuses));
  const unknown = leads.filter((r) => r.jobberRequestId! in contactStatuses && !workflowOf(r));
  const readyCount = leads.filter((r) => workflowOf(r)?.progress === 'ready_to_quote' && workflowOf(r)?.bucket !== 'review').length;
  const statusesLoaded = pending.length === 0;
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  const renderLeadRow = (req: ManualRequestWithDeathclock) => {
    const id = req.jobberRequestId as string;
    const status = contactStatuses[id];
    const w = status?.workflow ?? null;
    const summary = leadSummaries[id];
    const created = new Date(req.createdAt);
    const ageDays = w?.ageDays ?? Math.max(0, Math.floor((now - created.getTime()) / 86400_000));
    const linkedQuotes = jobberQuoteBadges[id];
    return (
      <article key={id} style={rowStyle} aria-label={`Lead: ${req.customerName}`}>
        <div style={{ ...cellStyle, flex: '1.4 1 220px' }}>
          <a
            href={'/quotes/leads/' + encodeURIComponent(id)}
            onClick={(e) => { e.preventDefault(); openRequest(req); }}
            style={clientLinkStyle}
          >
            {req.customerName}
          </a>
          <span style={projectStyle}>{req.requestTitle?.trim() || req.serviceDescription?.trim() || 'Untitled request'}</span>
          <span style={mutedSmall}>Lead in {created.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {ageDays === 0 ? 'today' : `${ageDays} day${ageDays === 1 ? '' : 's'} ago`}</span>
          {linkedQuotes && linkedQuotes.length > 0 && (
            <span style={mutedSmall}>Jobber quote #{linkedQuotes[0].quoteNumber} · {linkedQuotes[0].quoteStatus.replace(/_/g, ' ')}</span>
          )}
        </div>
        <div style={{ ...cellStyle, flex: '1 1 170px' }}>
          <span style={eyebrowStyle}>Last contact</span>
          {status === undefined ? <span style={mutedSmall}>Checking…</span> : !status ? <span style={mutedSmall}>Could not be read</span> : (
            <>
              <span style={valueStyle}>{status.last && status.last.channel !== 'request' ? status.last.label : 'No outreach yet'}</span>
              <span style={mutedSmall}>
                {status.last && status.last.channel !== 'request' ? timeAgo(status.last.at, now) : 'Only the request itself'}
                {status.unavailable.length > 0 && ` · ${sourceList(status.unavailable)} couldn't be read`}
              </span>
            </>
          )}
        </div>
        <div style={{ ...cellStyle, flex: '1 1 170px' }}>
          <span style={eyebrowStyle}>Next contact</span>
          {w ? (
            <>
              <span style={{ ...valueStyle, fontWeight: 600, color: dueColor(w) }}>{dueText(w, now)}</span>
              <span style={mutedSmall}>{w.stage}</span>
            </>
          ) : <span style={mutedSmall}>{status === undefined ? 'Checking…' : 'Open the lead to see'}</span>}
        </div>
        <div style={{ ...cellStyle, flex: '1.3 1 240px', alignItems: 'flex-start', gap: 8 }}>
          {w && <span style={whyStyle}>{w.action.why}</span>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {w?.bucket === 'review' ? (
              <>
                {w.notALead ? (
                  <button type="button" style={secondaryButtonStyle} disabled={markingId === id} onClick={() => markNotALead(id, false)}>Undo: it is a lead</button>
                ) : (
                  <button type="button" style={secondaryButtonStyle} disabled={markingId === id} onClick={() => markNotALead(id, true)}>Not a lead</button>
                )}
                {!w.notALead && (
                  <button type="button" style={secondaryButtonStyle} onClick={() => openRequest(req, 'intro_text')}>Send intro text</button>
                )}
              </>
            ) : (
              <button type="button" style={primaryButtonStyle} onClick={() => openRequest(req, w?.action.kind)}>
                {w?.action.label ?? 'Open lead'}
              </button>
            )}
            {w && w.bucket !== 'review' && (w.progress === 'ready_to_quote' || (summary?.total ?? 0) > 0) && (
              <span style={readinessChipStyle(w, summary)}>{readinessText(w, summary)}</span>
            )}
            <button type="button" style={linkButtonStyle} onClick={() => handleRequestClick(req)}>Quote builder</button>
          </div>
        </div>
      </article>
    );
  };

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

      <header style={headerStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h1 style={titleStyle}>Requests</h1>
          <p style={subtitleStyle}>{today} · Work top to bottom. Goal: every lead to a sent quote.</p>
        </div>
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
      </header>

      {error && (
        <div role="alert" style={alertStyle}>{error}</div>
      )}

      {generateError && (
        <div role="alert" style={alertStyle}>{generateError}</div>
      )}

      {jobberStatus?.status === 'unavailable' && (
        <div role="alert" style={alertStyle}>
          Jobber could not be reached, so Jobber leads are not shown. Only manual requests are listed. This is not an empty queue.
        </div>
      )}

      {jobberStatus?.status === 'live' && !jobberStatus.complete && (
        <div role="status" style={alertStyle}>
          Only the newest Jobber requests were checked, so some older open leads from the last {jobberStatus.days} days may be missing.
        </div>
      )}

      {requests.length === 0 ? (
        error || jobberStatus?.status === 'unavailable' ? null : (
          <div style={emptyStyle}>
            <p style={{ margin: 0, color: '#888' }}>No pending requests in the queue.</p>
          </div>
        )
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {leads.length > 0 && (
            <div style={tilesStyle}>
              <Tile label="Do now" color="#9a3412" count={statusesLoaded ? doNow.length : null} note="overdue, due today, or ready to quote" />
              <Tile label="Ready to quote" color="#166534" count={statusesLoaded ? readyCount : null} note="enough info, draft the quote" />
              <Tile label="Waiting on customer" color="#1e40af" count={statusesLoaded ? waiting.length : null} note="next touch is scheduled" />
              <Tile label="Review" color="#4b5563" count={statusesLoaded ? review.length : null} note="likely not a lead" />
            </div>
          )}

          {doNow.length > 0 && (
            <Section title="Do now" note="One button per lead. Do it, and the next follow-up date sets itself.">
              {doNow.map(renderLeadRow)}
            </Section>
          )}
          {waiting.length > 0 && (
            <Section title="Waiting on customer" note="Nothing to do until the date shown. These move to Do now on their own.">
              {waiting.map(renderLeadRow)}
            </Section>
          )}
          {pending.length > 0 && (
            <Section title="Checking next steps" note="Reading contact history from Jobber, Quo and email.">
              {pending.map(renderLeadRow)}
            </Section>
          )}
          {unknown.length > 0 && (
            <Section title="Next step unknown" note="Contact history could not be read right now. Open the lead to check it.">
              {unknown.map(renderLeadRow)}
            </Section>
          )}
          {review.length > 0 && (
            <Section title="Review" note="No real project described, or marked not a lead. Archive in Jobber, or send one intro text.">
              {review.map(renderLeadRow)}
            </Section>
          )}

          {manual.length > 0 && (
            <Section title="Manual requests" note="Requests entered in Cotiza. Open one to build its quote.">
              {manual.map((req) => {
                const isGenerating = generatingForId === req.id;
                const liveAge = req.deathclock.ageSeconds + Math.floor((Date.now() - lastFetchedAtRef.current) / 1000);
                const colorHex = DEATHCLOCK_COLORS[req.deathclock.color] ?? '#10b981';
                return (
                  <div
                    key={req.id}
                    style={{ ...manualCardStyle, borderLeft: `4px solid ${colorHex}`, opacity: generatingForId && !isGenerating ? 0.6 : 1 }}
                    onClick={() => { openRequest(req); }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openRequest(req);
                      }
                    }}
                    aria-label={`Request from ${req.customerName}`}
                    aria-busy={isGenerating}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, color: '#111827' }}>{req.customerName}</span>
                      <DeathclockBadge
                        ageSeconds={liveAge}
                        color={req.deathclock.color}
                        isComplete={req.deathclock.isComplete}
                        frozen={req.deathclock.frozen}
                        compact
                      />
                    </div>
                    {req.serviceDescription?.trim() && <p style={{ margin: '4px 0 0', fontSize: 14, color: '#374151' }}>{req.serviceDescription}</p>}
                    <span style={mutedSmall}>Created {new Date(req.createdAt).toLocaleDateString()}</span>
                  </div>
                );
              })}
            </Section>
          )}

          {leads.length > 0 && (
            <section style={keyStyle} aria-label="How next contact is set">
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>How next contact is set (from the handbook)</h2>
              <div style={keyGridStyle}>
                {CADENCE_KEY.map((k) => (
                  <div key={k.title} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{k.title}</span>
                    <span style={{ fontSize: 13, color: '#4b5563' }}>{k.text}</span>
                  </div>
                ))}
              </div>
              <p style={{ margin: 0, fontSize: 13, color: '#4b5563' }}>
                Customer replied? Answer them the same day. No quote 3+ days after the lead came in? Send a “quote in progress” update.
              </p>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

// ── Pieces ──

const CADENCE_KEY = [
  { title: '1 · Intake', text: 'Reach out the day the lead comes in.' },
  { title: '2 · Next day', text: 'Follow up the business day after.' },
  { title: '3 · Every 2–3 days', text: 'Until we get the photos or info we need.' },
  { title: '4 · Weekly', text: 'If still no response.' },
  { title: '5 · Monthly', text: 'After several weekly tries, until they reply or we close it.' },
];

function Tile({ label, color, count, note }: { label: string; color: string; count: number | null; note: string }) {
  return (
    <div style={tileStyle}>
      <span style={{ fontSize: 13, fontWeight: 600, color }}>{label}</span>
      <span style={{ fontSize: 30, fontWeight: 700, color: '#111827' }}>{count ?? '…'}</span>
      <span style={{ fontSize: 13, color: '#4b5563' }}>{note}</span>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }} aria-label={title}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{title}</h2>
        <span style={{ fontSize: 14, color: '#4b5563' }}>{note}</span>
      </div>
      {children}
    </section>
  );
}

function dueText(w: LeadWorkflow, now: number = Date.now()): string {
  if (w.next.overdue) return `Overdue ${w.next.daysOverdue} day${w.next.daysOverdue === 1 ? '' : 's'}`;
  if (w.next.dueToday) return 'Due today';
  return formatDay(w.next.on, now);
}

function dueColor(w: LeadWorkflow): string {
  return w.next.overdue ? '#b91c1c' : w.next.dueToday ? '#9a3412' : '#1e40af';
}

function readinessText(w: LeadWorkflow | null, summary: LeadInfoSummary | undefined): string {
  if (w?.progress === 'ready_to_quote' || summary?.readyToQuote) return 'Ready to quote';
  if (w?.action.kind === 'ask_info') return 'Need: ' + w.action.label.replace(/^Text: ask for /, '');
  if (summary && summary.total > 0) return `${summary.open + summary.asked} info needed`;
  return 'No checklist yet';
}

function readinessChipStyle(w: LeadWorkflow | null, summary: LeadInfoSummary | undefined): React.CSSProperties {
  const ready = w?.progress === 'ready_to_quote' || summary?.readyToQuote;
  const none = !ready && !(summary && summary.total > 0) && w?.action.kind !== 'ask_info';
  return {
    fontSize: 12,
    fontWeight: 600,
    padding: '4px 8px',
    borderRadius: 999,
    background: ready ? '#dcfce7' : none ? '#f3f4f6' : '#fef3c7',
    color: ready ? '#166534' : none ? '#4b5563' : '#92400e',
  };
}

// ── Styles ──

const containerStyle: React.CSSProperties = { maxWidth: 1180, margin: '0 auto' };
const headerStyle: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, marginBottom: 20 };
const titleStyle: React.CSSProperties = { margin: 0, fontSize: 28, fontWeight: 700 };
const subtitleStyle: React.CSSProperties = { margin: 0, fontSize: 14, color: '#4b5563' };

const sortToggleContainerStyle: React.CSSProperties = {
  display: 'inline-flex',
  border: '1px solid #d0d0d0',
  borderRadius: 8,
  overflow: 'hidden',
};

const sortToggleBaseStyle: React.CSSProperties = {
  border: 'none',
  minHeight: 40,
  padding: '0 0.9rem',
  fontSize: '0.85rem',
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'background 0.15s, color 0.15s',
};

const sortToggleActiveStyle: React.CSSProperties = { ...sortToggleBaseStyle, background: '#1d4ed8', color: '#fff' };
const sortToggleInactiveStyle: React.CSSProperties = { ...sortToggleBaseStyle, background: '#fff', color: '#374151' };

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
  borderTopColor: '#1d4ed8',
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

const tilesStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 };
const tileStyle: React.CSSProperties = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 4 };

const rowStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  padding: '16px 20px',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 20,
  alignItems: 'center',
};
const cellStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 };
const clientLinkStyle: React.CSSProperties = { fontSize: 16, fontWeight: 600, color: '#111827', textDecoration: 'none' };
const projectStyle: React.CSSProperties = { fontSize: 14, color: '#374151' };
const mutedSmall: React.CSSProperties = { fontSize: 13, color: '#6b7280' };
const eyebrowStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' };
const valueStyle: React.CSSProperties = { fontSize: 14, color: '#111827' };
const whyStyle: React.CSSProperties = { fontSize: 13, color: '#374151' };

const primaryButtonStyle: React.CSSProperties = {
  minHeight: 44,
  padding: '0 16px',
  border: 0,
  borderRadius: 8,
  background: '#1d4ed8',
  color: '#fff',
  font: 'inherit',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
};
const secondaryButtonStyle: React.CSSProperties = {
  minHeight: 44,
  padding: '0 14px',
  border: '1px solid #d1d5db',
  borderRadius: 8,
  background: '#fff',
  color: '#374151',
  font: 'inherit',
  fontSize: 14,
  cursor: 'pointer',
};
const linkButtonStyle: React.CSSProperties = {
  border: 0,
  background: 'none',
  padding: '0 4px',
  minHeight: 44,
  color: '#1d4ed8',
  font: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
  textDecoration: 'underline',
};

const manualCardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  padding: '12px 16px',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const keyStyle: React.CSSProperties = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 };
const keyGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 };

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
  borderTopColor: '#1d4ed8',
  borderRadius: '50%',
  animation: 'spin 0.7s linear infinite',
};
