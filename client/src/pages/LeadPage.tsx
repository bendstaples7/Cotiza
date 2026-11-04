import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { ErrorResponse } from 'shared';
import {
  addLeadInfo,
  fetchLead,
  fetchLeadPhotoUrl,
  logLeadContact,
  retryJobberNote,
  sendLeadText,
  setLeadNextContact,
  setLeadNotALead,
  updateLeadInfo,
} from '../api';
import type { JobberNoteStatus, LeadBundle, LeadContactChannel, LeadContactStatus, LeadInfoItem, LeadInfoStatus, LeadWorkflow } from '../api';
import { formatDay, sourceList, timeAgo } from '../components/LeadContactLine';
import { ASSUMED_PREFIX, buildActionMessage, itemKind, mailtoLink, MAX_TEXT_LENGTH, smsLink, type ItemKind } from '../leadOutreach';

/**
 * Lead hub: everything known about one Jobber request, and the "info needed" list the team
 * works from. Questions come from Claude's reviews or the team; answers typed here are what
 * the next quote draft and review use.
 */
export default function LeadPage() {
  const { requestId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const nextStepRef = useRef<HTMLElement | null>(null);
  const [lead, setLead] = useState<LeadBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Bumped after logging a contact or changing the next-contact date, to refresh the contact status.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    // Ignore a slower response for a lead the user has already navigated away from.
    let current = true;
    setLoading(true);
    setError(null);
    setLead(null);
    fetchLead(requestId)
      .then((bundle) => { if (current) setLead(bundle); })
      .catch((err) => { if (current) setError((err as ErrorResponse).message ?? 'This lead could not be loaded.'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [requestId]);

  useEffect(() => {
    if (reloadKey === 0) return;
    // Refresh in place: the page stays up, and a failed refresh keeps what is shown.
    let current = true;
    fetchLead(requestId)
      .then((bundle) => { if (current && bundle.requestId === requestId) setLead(bundle); })
      .catch(() => undefined);
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  // Opened from a queue action button: bring the next step into view.
  const fromAction = searchParams.get('action');
  useEffect(() => {
    if (fromAction && lead && nextStepRef.current) nextStepRef.current.scrollIntoView?.({ block: 'start' });
  }, [fromAction, lead?.requestId]);

  const replaceItem = (item: LeadInfoItem) => {
    setLead((prev) => {
      // A save that finishes after the user moved to another lead must not land on it.
      if (!prev || prev.requestId !== item.requestId) return prev;
      const exists = prev.infoNeeded.items.some((i) => i.id === item.id);
      const items = exists ? prev.infoNeeded.items.map((i) => (i.id === item.id ? item : i)) : [...prev.infoNeeded.items, item];
      return { ...prev, infoNeeded: { items, summary: summarize(items) } };
    });
    // The checklist decides the next action, so refresh it from the server.
    reload();
  };

  if (loading) return <div style={page}><p style={muted}>Loading lead…</p></div>;
  if (error || !lead) {
    return (
      <div style={page}>
        <Link to="/quotes/requests" style={back}>← Request queue</Link>
        <div role="alert" style={alert}>{error ?? 'This lead could not be loaded.'}</div>
      </div>
    );
  }

  const req = lead.request.request;
  const requestUnavailable = lead.request.outcome !== 'ok' || !req;
  const val = <T,>(f: { availability: string; value?: T } | undefined): T | null => (f && f.availability === 'present' ? (f.value ?? null) : null);
  const summary = lead.infoNeeded.summary;
  const quotes = lead.quotes.jobberQuotes?.items ?? [];
  const photos = (req?.attachments ?? []).map((a, index) => ({ index, name: val(a.fileName) ?? `Photo ${index + 1}`, type: val(a.contentType) ?? '' }))
    .filter((p) => p.type.startsWith('image/'));

  const workflow = lead.workflow ?? null;
  const createdAt = val(req?.createdAt);
  const ageDays = workflow?.ageDays ?? (createdAt ? Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 86400_000)) : null);

  return (
    <div style={page}>
      <Link to="/quotes/requests" style={back}>← Requests</Link>

      <header style={headerRow}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h1 style={h1}>{val(req?.clientName) ?? (requestUnavailable ? 'Lead' : 'Unknown client')}</h1>
          <p style={subtitle}>{val(req?.title) ?? 'Untitled request'}</p>
          <p style={{ ...muted, margin: 0 }}>
            {createdAt ? `Lead in ${new Date(createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${ageDays !== null ? ` (${ageDays === 0 ? 'today' : `${ageDays} day${ageDays === 1 ? '' : 's'} ago`})` : ''}` : ''}
            {val(req?.jobberWebUri) && <> · <a href={val(req?.jobberWebUri)!} target="_blank" rel="noreferrer">Open in Jobber</a></>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {workflow && <NextContactChip workflow={workflow} />}
          <ReadyBadge ready={summary.readyToQuote} total={summary.total} open={summary.open + summary.asked} workflow={workflow} />
        </div>
      </header>

      <JobberNotesBanner notes={lead.unsentJobberNotes ?? []} unavailable={lead.unsentJobberNotesUnavailable === true} onChanged={reload} />

      {workflow && <ProgressBar progress={workflow.progress} />}

      <div style={twoCol}>
        <div style={mainCol}>
          {workflow
            ? <NextStepPanel lead={lead} workflow={withRequestedAction(workflow, fromAction)} onChanged={reload} panelRef={nextStepRef} />
            : <section style={card}><p style={muted}>The next step could not be worked out right now: Jobber's quotes for this request could not be fully read, so a quote may already be out. Check the quotes in Jobber before reaching out.</p></section>}
        </div>
        <aside style={sideCol}>
          {workflow && <FollowUpPlan workflow={workflow} />}
          {lead.contactStatus && <ContactPanel requestId={lead.requestId} status={lead.contactStatus} onChanged={reload} />}
        </aside>
      </div>

      <InfoSections requestId={lead.requestId} items={lead.infoNeeded.items} onSaved={replaceItem} />

      <section style={card}>
        <h2 style={h2}>Request</h2>
        {requestUnavailable && (
          <p role="alert" style={alert}>
            {lead.request.outcome === 'not_found' ? 'Jobber has no request with this id.' : 'The Jobber request could not be read right now. This is not an empty request.'}
          </p>
        )}
        {!requestUnavailable && (val(req?.requestBody) ? <p style={pre}>{val(req?.requestBody)}</p> : <p style={muted}>No request text.</p>)}
        {(req?.notes ?? []).length > 0 && (
          <>
            <h3 style={h3}>Notes</h3>
            {req!.notes.map((n, i) => (
              <div key={i} style={note}>
                <span style={label}>{n.createdBy === 'client' ? 'Client' : 'Team'}{n.createdAt ? ` · ${new Date(n.createdAt).toLocaleDateString()}` : ''}</span>
                <p style={pre}>{n.message}</p>
              </div>
            ))}
          </>
        )}
      </section>

      {photos.length > 0 && (
        <section style={card}>
          <h2 style={h2}>Photos ({photos.length})</h2>
          <div style={photoGrid}>
            {photos.map((p) => <LeadPhoto key={p.index} requestId={lead.requestId} index={p.index} name={p.name} />)}
          </div>
        </section>
      )}

      <section style={card}>
        <h2 style={h2}>Quotes</h2>
        {quotes.length === 0
          ? <p style={muted}>{lead.quotes.jobberQuotes?.outcome === 'ok' ? 'No Jobber quotes on this request yet.' : 'Quotes could not be read.'}</p>
          : (
            <ul style={list}>
              {quotes.map((q) => (
                <li key={q.id} style={quoteRow}>
                  <span>#{val(q.quoteNumber)} · {val(q.title)}</span>
                  <span style={muted}>{(val(q.status) ?? '').replace(/_/g, ' ')}</span>
                  {val(q.jobberWebUri) && <a href={val(q.jobberWebUri)!} target="_blank" rel="noreferrer">Open</a>}
                </li>
              ))}
            </ul>
          )}
      </section>

      <section style={card}>
        <h2 style={h2}>Email</h2>
        <ContextText block={lead.email} kind="email" />
      </section>

      <section style={card}>
        <h2 style={h2}>Calls and texts (Quo)</h2>
        <ContextText block={lead.phone} kind="phone" />
      </section>
    </div>
  );
}

/**
 * The queue can open a lead with an action other than the workflow's, e.g. "Send intro text" on a
 * lead sitting in Review. Only that case differs today; any other request keeps the workflow's action.
 */
function withRequestedAction(workflow: LeadWorkflow, requested: string | null): LeadWorkflow {
  // A lead the team marked "not a lead" keeps its review action whatever the link asked for.
  if (workflow.notALead || requested !== 'intro_text' || workflow.action.kind === 'intro_text' || !workflow.likelySpam) return workflow;
  return { ...workflow, action: { kind: 'intro_text', label: 'Send intro text', why: 'No project described yet. One intro text to find out what they need.', step: 'intro_text', channel: 'text' } };
}

const PROGRESS_STEPS: Array<{ key: LeadWorkflow['progress']; label: string }> = [
  { key: 'lead_in', label: 'Lead in' },
  { key: 'getting_info', label: 'Getting info' },
  { key: 'ready_to_quote', label: 'Ready to quote' },
  { key: 'quote_drafted', label: 'Quote drafted' },
  { key: 'quote_sent', label: 'Quote sent' },
];

function ProgressBar({ progress }: { progress: LeadWorkflow['progress'] }) {
  const at = PROGRESS_STEPS.findIndex((p) => p.key === progress);
  return (
    <ol style={progressList} aria-label="Progress toward a sent quote">
      {PROGRESS_STEPS.map((p, i) => (
        <li key={p.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }} aria-current={i === at ? 'step' : undefined}>
          <span style={{ height: 6, borderRadius: 3, background: i < at ? '#1d4ed8' : i === at ? '#93c5fd' : '#e5e7eb' }} />
          <span style={{ fontSize: 13, fontWeight: i <= at ? 600 : 400, color: i === at ? '#1d4ed8' : i < at ? '#111827' : '#6b7280' }}>
            {p.label}{i === at ? ' · here' : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

function dueLabel(w: LeadWorkflow): string {
  if (w.next.overdue) return `overdue ${w.next.daysOverdue} day${w.next.daysOverdue === 1 ? '' : 's'}`;
  if (w.next.dueToday) return 'due today';
  return formatDay(w.next.on);
}

function NextContactChip({ workflow }: { workflow: LeadWorkflow }) {
  const n = workflow.next;
  const style = n.overdue ? { background: '#fee2e2', color: '#991b1b' } : n.dueToday ? { background: '#ffedd5', color: '#9a3412' } : { background: '#dbeafe', color: '#1e40af' };
  return <span style={{ ...badge, ...style }}>Next contact {dueLabel(workflow)}</span>;
}

/**
 * The one thing to do next on this lead, with the message to send, ways to send it, and
 * "Mark done", which logs the contact so the handbook cadence picks the next date.
 */
function NextStepPanel({ lead, workflow, onChanged, panelRef }: { lead: LeadBundle; workflow: LeadWorkflow; onChanged: () => void; panelRef: React.MutableRefObject<HTMLElement | null> }) {
  const req = lead.request.request;
  const clientName = req?.clientName?.availability === 'present' ? req.clientName.value ?? null : null;
  const title = req?.title?.availability === 'present' ? req.title.value ?? null : null;
  const jobberUrl = req?.jobberWebUri?.availability === 'present' ? req.jobberWebUri.value ?? null : null;
  const action = workflow.action;
  const messages = buildActionMessage(action.kind, { clientName, title, items: lead.infoNeeded.items });
  const [text, setText] = useState(messages?.text ?? '');
  const [edited, setEdited] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; warn: boolean } | null>(null);
  const [doneAt, setDoneAt] = useState<string | null>(null);
  const [changingDate, setChangingDate] = useState(false);
  const [date, setDate] = useState('');
  // Rebuild the proposed text when the action or checklist changes (until the team edits it).
  useEffect(() => { if (!edited) setText(messages?.text ?? ''); }, [messages?.text, edited]);
  useEffect(() => { setEdited(false); setConfirming(false); }, [action.kind]);

  const quoConnected = !(lead.contactStatus?.notConnected ?? []).includes('quo');
  const phone = lead.contact.phone;
  const email = lead.contact.email;
  const mailto = email && messages ? mailtoLink(email, messages.emailSubject, messages.emailBody) : null;
  const today = workflow.next.overdue || workflow.next.dueToday || workflow.bucket === 'do_now';

  const afterContact = async () => {
    // The contact is logged whatever happens next, so never report it as failed after this point.
    setDoneAt(new Date().toISOString());
    if (workflow.next.source === 'set') {
      // Let the cadence choose the next date again.
      try {
        await setLeadNextContact(lead.requestId, null);
      } catch {
        setNotice({ text: 'Logged. The date set by hand could not be cleared, so change it below. Do not log this again.', warn: true });
      }
    }
    onChanged();
  };

  const markDone = async () => {
    setBusy(true);
    setError(null);
    try {
      await logLeadContact(lead.requestId, { channel: action.channel, step: action.step });
      await afterContact();
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const sendViaQuo = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await sendLeadText(lead.requestId, text.trim(), action.step);
      setConfirming(false);
      setNotice(result.logged ? { text: 'Text sent through Quo and logged.', warn: false } : { text: result.warning, warn: true });
      if (result.logged) await afterContact(); else onChanged();
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'The text was not sent.');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy. Select the text and copy it by hand.');
    }
  };

  const setNotALead = async (value: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await setLeadNotALead(lead.requestId, value);
      onChanged();
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const saveDate = async () => {
    setBusy(true);
    setError(null);
    try {
      await setLeadNextContact(lead.requestId, date || null);
      setChangingDate(false);
      onChanged();
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section ref={panelRef} style={nextStepCard} aria-label="Next step">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={eyebrow}>Next step · {today ? 'do today' : `due ${formatDay(workflow.next.on)}`}</span>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#111827' }}>{action.label}</h2>
        <p style={{ ...muted, margin: 0 }}>{action.why} {workflow.stage}.</p>
      </div>

      {action.kind === 'review' && (
        <div style={actions}>
          {jobberUrl && <a style={btnLink} href={jobberUrl} target="_blank" rel="noreferrer">Open in Jobber to archive</a>}
          <button type="button" style={btn} disabled={busy} onClick={() => { void setNotALead(false); }}>Undo: it is a lead</button>
        </div>
      )}

      {action.kind === 'draft_quote' && (
        <>
          <p style={{ ...muted, margin: 0 }}>We have what we need. Draft the quote in Jobber from the request and the assumptions below, then mark this done.</p>
          <div style={actions}>
            {jobberUrl && <a style={primaryLink} href={jobberUrl} target="_blank" rel="noreferrer">Open in Jobber</a>}
          </div>
        </>
      )}

      {messages && (
        <>
          <label htmlFor="next-step-text" style={fieldLabel}>Proposed text</label>
          <textarea
            id="next-step-text"
            style={{ ...textarea, minHeight: 130, fontSize: 15, lineHeight: 1.5 }}
            maxLength={MAX_TEXT_LENGTH}
            value={text}
            onChange={(e) => { setText(e.target.value); setEdited(true); }}
          />
          <div style={actions}>
            {phone && quoConnected && (
              <button type="button" style={primaryBtn} disabled={busy || !text.trim()} onClick={() => { setConfirming(true); setNotice(null); }}>Send via Quo</button>
            )}
            <button type="button" style={btn} onClick={() => { void copy(); }}>{copied ? 'Copied' : 'Copy'}</button>
            {phone && <a style={btnLink} href={smsLink(phone, text)}>Text from my phone</a>}
            {mailto && <a style={btnLink} href={mailto}>Email instead</a>}
            {edited && <button type="button" style={linkBtn} onClick={() => { setEdited(false); setText(messages.text); }}>Reset to proposed</button>}
          </div>
          {!phone && <p style={muted}>No phone number in Jobber for this lead.{email ? ' Email them instead.' : ''}</p>}
          {confirming && phone && (
            <div role="dialog" aria-label="Confirm text" style={confirmBox}>
              <p style={{ margin: 0, fontWeight: 600 }}>Send this text to {phone} from Chicago Reno's Quo number?</p>
              <p style={{ ...pre, margin: '0.5rem 0' }}>{text.trim()}</p>
              <div style={actions}>
                <button type="button" style={primaryBtn} disabled={busy} onClick={() => { void sendViaQuo(); }}>{busy ? 'Sending…' : 'Send now'}</button>
                <button type="button" style={btn} disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
              </div>
            </div>
          )}
        </>
      )}

      {action.kind !== 'review' && action.kind !== 'none' && (
        <div style={doneRow}>
          <button type="button" style={doneBtn} disabled={busy} onClick={() => { void markDone(); }}>Mark done</button>
          <span style={{ fontSize: 14, color: '#4b5563' }}>
            {doneAt ? <>Logged. Next contact: <strong style={{ color: '#111827' }}>{formatDay(workflow.next.on)}</strong> ({workflow.stage})</>
              : <>Next contact: <strong style={{ color: '#111827' }}>{formatDay(workflow.next.on)}</strong>{workflow.next.source === 'set' ? ' (set by the team)' : ''}</>}
            {' · '}
            <button type="button" style={linkBtn} onClick={() => { setChangingDate((v) => !v); setDate(workflow.next.source === 'set' ? workflow.next.on : ''); }}>change date</button>
          </span>
          {workflow.likelySpam && !workflow.notALead && (
            <button type="button" style={linkBtn} disabled={busy} onClick={() => { void setNotALead(true); }}>Not a lead</button>
          )}
        </div>
      )}
      {changingDate && (
        <div style={actions}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Next contact date" style={dateInput} />
          <button type="button" style={btn} disabled={busy || !date} onClick={() => { void saveDate(); }}>Set date</button>
          {workflow.next.source === 'set' && <button type="button" style={btn} disabled={busy} onClick={() => { setDate(''); void (async () => { setBusy(true); try { await setLeadNextContact(lead.requestId, null); setChangingDate(false); onChanged(); } catch (err) { setError((err as ErrorResponse).message ?? 'Could not save.'); } finally { setBusy(false); } })(); }}>Use the cadence</button>}
        </div>
      )}
      {notice && <p role="status" style={{ ...muted, color: notice.warn ? '#92400e' : '#166534', fontWeight: notice.warn ? 600 : 400 }}>{notice.text}</p>}
      {error && <p role="alert" style={inlineError}>{error}</p>}
    </section>
  );
}

const PLAN_DOT: Record<LeadWorkflow['plan'][number]['state'], { dot: string; ring: string; color: string }> = {
  done: { dot: '#1d4ed8', ring: '#1d4ed8', color: '#111827' },
  missed: { dot: '#fff', ring: '#b91c1c', color: '#b91c1c' },
  due: { dot: '#fff', ring: '#1d4ed8', color: '#1d4ed8' },
  upcoming: { dot: '#fff', ring: '#d1d5db', color: '#6b7280' },
};

/** The handbook cadence for this lead: what's done, what was missed, what's next. */
function FollowUpPlan({ workflow }: { workflow: LeadWorkflow }) {
  return (
    <section style={card} aria-label="Follow-up plan">
      <h2 style={h2}>Follow-up plan</h2>
      <ol style={{ ...list, gap: '0.6rem' }}>
        {workflow.plan.map((row, i) => {
          const look = PLAN_DOT[row.state];
          return (
            <li key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span aria-hidden="true" style={{ flex: 'none', width: 12, height: 12, marginTop: 4, borderRadius: 999, background: look.dot, border: `2px solid ${look.ring}` }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: look.color }}>{row.label}{row.state === 'missed' ? ' · missed' : ''}</span>
                <span style={{ fontSize: 13, color: '#4b5563' }}>{row.detail}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const CHANNELS: Array<{ value: LeadContactChannel; label: string }> = [
  { value: 'call', label: 'Call' },
  { value: 'text', label: 'Text' },
  { value: 'email', label: 'Email' },
  { value: 'in_person', label: 'In person' },
  { value: 'other', label: 'Other' },
];

const SOURCE_NAME: Record<string, string> = { quo: 'Quo', gmail: 'Gmail', jobber: 'Jobber', cotiza: 'logged in Cotiza' };

/** Everything that has happened with this lead, newest first, and a way to log outreach done elsewhere. */
function ContactPanel({ requestId, status, onChanged }: { requestId: string; status: LeadContactStatus; onChanged: () => void }) {
  const [channel, setChannel] = useState<LeadContactChannel>('call');
  const [direction, setDirection] = useState<'outgoing' | 'incoming'>('outgoing');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [logging, setLogging] = useState(false);

  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setSaving(true);
    setError(null);
    try {
      await fn();
      after?.();
      onChanged();
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const recent = showAll ? status.recent : status.recent.slice(0, 6);
  return (
    <section style={card} aria-label="Contact history">
      <h2 style={h2}>Contact history</h2>
      {(status.unavailable.length > 0 || status.notConnected.length > 0) && (
        <p style={{ ...muted, marginTop: 0 }}>
          {status.unavailable.length > 0 && <>Could not read {sourceList(status.unavailable)} right now, so history may be incomplete. </>}
          {status.notConnected.length > 0 && <>{sourceList(status.notConnected)} not connected to Cotiza.</>}
        </p>
      )}
      {status.recent.length === 0 ? <p style={muted}>No contact yet.</p> : (
        <ul style={{ ...list, gap: '0.6rem' }}>
          {recent.map((e, i) => (
            <li key={`${e.at}-${i}`} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{new Date(e.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {e.label}</span>
              <span style={{ fontSize: 13, color: '#4b5563' }}>{e.note ? `${e.note} · ` : ''}{timeAgo(e.at)} · {SOURCE_NAME[e.source]}</span>
            </li>
          ))}
        </ul>
      )}
      {status.recent.length > 6 && (
        <button type="button" style={linkBtn} onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show less' : `Show all ${status.recent.length}`}</button>
      )}

      {!logging ? (
        <button type="button" style={{ ...btn, borderStyle: 'dashed', marginTop: '0.75rem', minHeight: 44 }} onClick={() => setLogging(true)}>Log a call or visit</button>
      ) : (
        <form
          style={{ ...addRow, flexWrap: 'wrap' }}
          onSubmit={(e) => { e.preventDefault(); void run(() => logLeadContact(requestId, { channel, direction, note: note.trim() || undefined }), () => { setNote(''); setLogging(false); }); }}
        >
          <select value={channel} onChange={(e) => setChannel(e.target.value as LeadContactChannel)} aria-label="Contact type" style={select}>
            {CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <select value={direction} onChange={(e) => setDirection(e.target.value as 'outgoing' | 'incoming')} aria-label="Who reached out" style={select}>
            <option value="outgoing">We reached out</option>
            <option value="incoming">Customer reached us</option>
          </select>
          <input style={{ ...input, minWidth: 160 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (e.g. left voicemail)" aria-label="Contact note" maxLength={500} />
          <button type="submit" style={primaryBtn} disabled={saving}>Log contact</button>
          <button type="button" style={btn} disabled={saving} onClick={() => setLogging(false)}>Cancel</button>
        </form>
      )}
      {error && <p role="alert" style={inlineError}>{error}</p>}
    </section>
  );
}

function summarize(items: LeadInfoItem[]) {
  const count = (s: LeadInfoStatus) => items.filter((i) => i.status === s).length;
  const required = items.filter((i) => i.required);
  return {
    total: items.length,
    open: count('open'),
    asked: count('asked'),
    answered: count('answered'),
    readyToQuote: items.length > 0 && required.every((i) => i.status === 'answered' || i.status === 'dropped'),
  };
}

function ReadyBadge({ ready, total, open, workflow }: { ready: boolean; total: number; open: number; workflow: LeadWorkflow | null }) {
  if (total === 0) return <span style={{ ...badge, background: '#f3f4f6', color: '#555' }}>No checklist yet</span>;
  if (ready) return <span style={{ ...badge, background: '#dcfce7', color: '#166534' }}>Ready to quote</span>;
  const need = workflow?.action.kind === 'ask_info' ? `Need: ${workflow.action.label.replace(/^Text: ask for /, '')}` : `${open} still needed`;
  return <span style={{ ...badge, background: '#fef3c7', color: '#92400e' }}>{need}</span>;
}

const STATUS_LABEL: Record<LeadInfoStatus, string> = { open: 'Not asked', asked: 'Asked', answered: 'Answered', dropped: 'Not needed' };

function InfoSections({ requestId, items, onSaved }: { requestId: string; items: LeadInfoItem[]; onSaved: (item: LeadInfoItem) => void }) {
  const [showDropped, setShowDropped] = useState(false);
  const live = items.filter((i) => i.status !== 'dropped');
  const asks = live.filter((i) => itemKind(i) !== 'assumption');
  const assumptions = live.filter((i) => itemKind(i) === 'assumption');
  const dropped = items.filter((i) => i.status === 'dropped');
  return (
    <>
      {assumptions.length > 0 && (
        <section style={card} aria-label="What the quote will assume">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <h2 style={h2}>What the quote will assume</h2>
            <span style={{ ...muted, margin: 0 }}>Goes in the note to the customer. Edit if they tell us otherwise.</span>
          </div>
          <ul style={{ ...list, gap: 0 }}>
            {assumptions.map((item) => <AssumptionRow key={item.id} item={item} onSaved={onSaved} />)}
          </ul>
        </section>
      )}
      <section style={card}>
        <h2 style={h2}>Need from the customer</h2>
        <p style={muted}>Only what we can't reasonably assume. Ask, then type the answer here.</p>
        {asks.length === 0 && <p style={muted}>Nothing needed from the customer to quote this lead.</p>}
        <ul style={list}>
          {asks.map((item) => <InfoRow key={item.id} item={item} kind={itemKind(item)} onSaved={onSaved} />)}
        </ul>
        <AddQuestion requestId={requestId} onAdded={onSaved} />
      </section>
      {dropped.length > 0 && (
        <div>
          <button type="button" style={linkBtn} onClick={() => setShowDropped((v) => !v)}>
            {showDropped ? 'Hide' : 'Show'} {dropped.length} retired question{dropped.length === 1 ? '' : 's'}
          </button>
          {showDropped && (
            <ul style={{ ...list, marginTop: '0.5rem' }}>
              {dropped.map((item) => <InfoRow key={item.id} item={item} kind={itemKind(item)} onSaved={onSaved} />)}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

/** One assumption: shown as a line; Edit opens the correction box. */
function AssumptionRow({ item, onSaved }: { item: LeadInfoItem; onSaved: (item: LeadInfoItem) => void }) {
  const [editing, setEditing] = useState(false);
  const text = item.question.replace(/^assumed:\s*/i, '');
  return (
    <li style={{ borderTop: '1px solid #f3f4f6', padding: '10px 0' }}>
      {!editing ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 14, color: '#111827' }}>
            {text}
            {item.status === 'answered' && item.answer && <span style={{ display: 'block', color: '#166534', fontSize: 13 }}>Corrected: {item.answer}</span>}
          </span>
          <button type="button" style={{ ...btn, minHeight: 44, flex: 'none' }} onClick={() => setEditing(true)}>Edit</button>
        </div>
      ) : (
        <ul style={list}>
          <InfoRow item={item} kind="assumption" onSaved={(saved) => { onSaved(saved); setEditing(false); }} />
          <li><button type="button" style={linkBtn} onClick={() => setEditing(false)}>Close</button></li>
        </ul>
      )}
    </li>
  );
}

function InfoRow({ item, kind, onSaved }: { item: LeadInfoItem; kind: ItemKind; onSaved: (item: LeadInfoItem) => void }) {
  const [answer, setAnswer] = useState(item.answer ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setAnswer(item.answer ?? ''); }, [item.answer]);

  const save = async (changes: { status?: LeadInfoStatus; answer?: string | null }) => {
    setSaving(true);
    setError(null);
    try {
      onSaved((await updateLeadInfo(item.id, changes)).item);
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const done = item.status === 'answered' || item.status === 'dropped';
  return (
    <li style={{ ...infoRow, opacity: item.status === 'dropped' ? 0.6 : 1 }}>
      <div style={infoHead}>
        <span style={{ fontWeight: 600 }}>{kind === 'assumption' ? item.question.replace(/^assumed:\s*/i, '') : item.question}{kind === 'optional' && <span style={muted}> (optional)</span>}</span>
        <span style={{ ...chip, ...(done ? chipDone : item.status === 'asked' ? chipAsked : {}) }}>{kind === 'assumption' && item.status !== 'dropped' ? (item.status === 'answered' ? 'Corrected' : 'Assumed') : STATUS_LABEL[item.status]}</span>
      </div>
      {item.status !== 'dropped' && (
        <textarea
          style={textarea}
          rows={2}
          placeholder={kind === 'assumption' ? "Customer's correction, if any" : "Customer's answer"}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          aria-label={`Answer: ${item.question}`}
        />
      )}
      <div style={actions}>
        {item.status !== 'dropped' && (
          <button type="button" style={primaryBtn} disabled={saving || !answer.trim() || answer.trim() === (item.answer ?? '')} onClick={() => save({ answer: answer.trim(), status: 'answered' })}>
            {kind === 'assumption' ? 'Save correction' : 'Save answer'}
          </button>
        )}
        {item.status === 'open' && kind !== 'assumption' && <button type="button" style={btn} disabled={saving} onClick={() => save({ status: 'asked' })}>Mark asked</button>}
        {item.status !== 'dropped'
          ? <button type="button" style={btn} disabled={saving} onClick={() => save({ status: 'dropped' })}>Not needed</button>
          : <button type="button" style={btn} disabled={saving} onClick={() => save({ status: 'open' })}>Reopen</button>}
      </div>
      {error && <p role="alert" style={inlineError}>{error}</p>}
    </li>
  );
}

function AddQuestion({ requestId, onAdded }: { requestId: string; onAdded: (item: LeadInfoItem) => void }) {
  const [question, setQuestion] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;
    setSaving(true);
    setError(null);
    try {
      // An "Assumed: …" line is a documented assumption, not an ask: it never holds the quote back.
      onAdded((await addLeadInfo(requestId, question.trim(), !ASSUMED_PREFIX.test(question.trim()))).item);
      setQuestion('');
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Could not add the question.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={submit} style={addRow}>
      <input style={input} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Add a question for the customer" aria-label="New question" />
      <button type="submit" style={btn} disabled={saving || !question.trim()}>Add</button>
      {error && <p role="alert" style={inlineError}>{error}</p>}
    </form>
  );
}

function LeadPhoto({ requestId, index, name }: { requestId: string; index: number; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    fetchLeadPhotoUrl(requestId, index)
      .then((u) => { objectUrl = u; if (!revoked) setUrl(u); else URL.revokeObjectURL(u); })
      .catch(() => { if (!revoked) setFailed(true); });
    return () => { revoked = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [requestId, index]);
  if (failed) return <div style={photoBox}><span style={muted}>{name} could not load</span></div>;
  if (!url) return <div style={photoBox}><span style={muted}>Loading…</span></div>;
  return <a href={url} target="_blank" rel="noreferrer" style={photoBox}><img src={url} alt={name} style={photo} /></a>;
}

function ContextText({ block, kind }: { block: LeadBundle['email']; kind: 'email' | 'phone' }) {
  if (block.status === 'ok') return block.text.trim() ? <p style={pre}>{block.text}</p> : <p style={muted}>No {kind === 'email' ? 'emails' : 'calls or texts'} found.</p>;
  const messages: Record<string, string> = {
    not_connected: kind === 'email' ? 'Email is not connected in Cotiza.' : 'Quo is not connected in Cotiza yet.',
    no_address: 'Jobber has no email address on this request.',
    no_number: 'Jobber has no phone number on this request.',
    failed: kind === 'email' ? 'Email could not be read right now. This is not an empty history.' : 'Quo could not be read right now. This is not an empty history.',
  };
  return <p style={muted}>{messages[block.status]}</p>;
}

// ── Styles ──
const page: React.CSSProperties = { maxWidth: 1180, margin: '0 auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' };
const back: React.CSSProperties = { color: '#1d4ed8', textDecoration: 'none', fontSize: '0.9rem' };
const twoCol: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' };
const mainCol: React.CSSProperties = { flex: '999 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 };
const sideCol: React.CSSProperties = { flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 };
const progressList: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 8 };
const nextStepCard: React.CSSProperties = { background: '#fff', border: '2px solid #1d4ed8', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 14, scrollMarginTop: 16 };
const eyebrow: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: '0.06em' };
const fieldLabel: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: '#374151' };
const doneRow: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', paddingTop: 12, borderTop: '1px solid #e5e7eb' };
const doneBtn: React.CSSProperties = { font: 'inherit', fontSize: 14, fontWeight: 600, minHeight: 44, padding: '0 16px', border: '1px solid #166534', background: '#f0fdf4', color: '#166534', borderRadius: 8, cursor: 'pointer' };
const headerRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' };
const h1: React.CSSProperties = { margin: 0, fontSize: 28, fontWeight: 700, color: '#111827' };
const h2: React.CSSProperties = { margin: '0 0 0.5rem', fontSize: '1.05rem', color: '#061216' };
const h3: React.CSSProperties = { margin: '0.75rem 0 0.25rem', fontSize: '0.95rem' };
const subtitle: React.CSSProperties = { margin: 0, fontSize: 16, color: '#374151' };
const muted: React.CSSProperties = { margin: '0.25rem 0', color: '#666', fontSize: '0.88rem' };
const card: React.CSSProperties = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '1rem 1.25rem' };
const alert: React.CSSProperties = { background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, padding: '0.75rem' };
const badge: React.CSSProperties = { borderRadius: 999, padding: '0.3rem 0.75rem', fontWeight: 600, fontSize: '0.85rem', whiteSpace: 'nowrap' };
const list: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.75rem' };
const infoRow: React.CSSProperties = { border: '1px solid #eee', borderRadius: 8, padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' };
const infoHead: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start' };
const chip: React.CSSProperties = { borderRadius: 999, padding: '0.1rem 0.6rem', fontSize: '0.78rem', background: '#f3f4f6', color: '#374151', whiteSpace: 'nowrap' };
const chipAsked: React.CSSProperties = { background: '#e0f2fe', color: '#075985' };
const chipDone: React.CSSProperties = { background: '#dcfce7', color: '#166534' };
const textarea: React.CSSProperties = { width: '100%', boxSizing: 'border-box', font: 'inherit', padding: '0.5rem', border: '1px solid #d1d5db', borderRadius: 6 };
const input: React.CSSProperties = { flex: 1, minWidth: 200, font: 'inherit', padding: '0.5rem', border: '1px solid #d1d5db', borderRadius: 6 };
const actions: React.CSSProperties = { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' };
const btn: React.CSSProperties = { font: 'inherit', fontSize: '0.88rem', minHeight: 40, padding: '0 0.9rem', border: '1px solid #d1d5db', borderRadius: 8, background: '#fff', color: '#374151', cursor: 'pointer' };
const primaryBtn: React.CSSProperties = { ...btn, background: '#1d4ed8', borderColor: '#1d4ed8', color: '#fff', fontWeight: 600 };
const addRow: React.CSSProperties = { display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' };
const inlineError: React.CSSProperties = { margin: 0, color: '#b91c1c', fontSize: '0.85rem', width: '100%' };
const pre: React.CSSProperties = { margin: '0.25rem 0', whiteSpace: 'pre-wrap', fontSize: '0.9rem', lineHeight: 1.45 };
const note: React.CSSProperties = { borderLeft: '3px solid #e5e7eb', paddingLeft: '0.75rem', margin: '0.5rem 0' };
const label: React.CSSProperties = { fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#888' };
const quoteRow: React.CSSProperties = { display: 'flex', gap: '0.75rem', alignItems: 'baseline', flexWrap: 'wrap' };
const photoGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '0.5rem' };
const photoBox: React.CSSProperties = { aspectRatio: '4 / 3', background: '#f3f4f6', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', textAlign: 'center' };
const photo: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover' };
const dateInput: React.CSSProperties = { font: 'inherit', fontSize: '0.85rem', padding: '0.3rem 0.4rem', border: '1px solid #d1d5db', borderRadius: 6 };
const select: React.CSSProperties = { font: 'inherit', padding: '0.45rem', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff' };
const linkBtn: React.CSSProperties = { font: 'inherit', fontSize: '0.85rem', background: 'none', border: 'none', color: '#1d4ed8', cursor: 'pointer', padding: '0.25rem 0', textDecoration: 'underline' };
const btnLink: React.CSSProperties = { font: 'inherit', fontSize: '0.88rem', minHeight: 40, padding: '0 0.9rem', border: '1px solid #d1d5db', borderRadius: 8, background: '#fff', color: '#374151', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' };
const primaryLink: React.CSSProperties = { ...btnLink, background: '#1d4ed8', borderColor: '#1d4ed8', color: '#fff', fontWeight: 600 };
const confirmBox: React.CSSProperties = { marginTop: '0.75rem', padding: '0.75rem', border: '1px solid #f59e0b', background: '#fffbeb', borderRadius: 8 };

/**
 * Cotiza actions whose note did not reach the Jobber request. The action itself is saved in Cotiza;
 * this says so plainly and offers a retry, so a failed Jobber write is never hidden.
 */
export function JobberNotesBanner({ notes, unavailable = false, onChanged }: { notes: JobberNoteStatus[]; unavailable?: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (unavailable) {
    return (
      <section role="alert" style={{ border: '1px solid #fcd34d', background: '#fffbeb', borderRadius: 12, padding: '12px 16px', fontSize: 14, color: '#92400e' }}>
        Cotiza couldn&rsquo;t check whether every action here reached Jobber as a note. Reload to check again.
      </section>
    );
  }
  if (!notes.length) return null;
  const retry = async (id: string) => {
    setBusy(id);
    try {
      const { jobberNote } = await retryJobberNote(id);
      setErrors((e) => {
        const next = { ...e };
        if (jobberNote.status === 'failed') next[id] = jobberNote.error ?? 'Jobber still did not take the note.';
        else delete next[id];
        return next;
      });
      onChanged();
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: (err as ErrorResponse).message ?? 'Jobber still did not take the note.' }));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section role="alert" style={{ border: '1px solid #fca5a5', background: '#fef2f2', borderRadius: 12, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {notes.map((n) => (
        <div key={n.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#991b1b' }}>
              {n.status === 'posting' || n.status === 'pending' ? 'Adding the note to Jobber…' : 'Saved in Cotiza; couldn\u2019t add the Jobber note'}
            </span>
            {n.message && <span style={{ fontSize: 13, color: '#4b5563', overflowWrap: 'anywhere' }}>{n.message}</span>}
            {(errors[n.id] ?? n.error) && <span style={{ fontSize: 13, color: '#991b1b' }}>{errors[n.id] ?? n.error}</span>}
          </div>
          <button type="button" disabled={busy === n.id} onClick={() => { void retry(n.id); }} aria-label={`Retry adding the Jobber note: ${n.message ?? n.id}`}
            style={{ minHeight: 44, padding: '0 16px', border: '1px solid #991b1b', background: '#ffffff', color: '#991b1b', borderRadius: 8, font: 'inherit', fontSize: 14, fontWeight: 600 }}>
            {busy === n.id ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ))}
    </section>
  );
}
