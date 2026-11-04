import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ErrorResponse } from 'shared';
import {
  addLeadInfo,
  fetchLead,
  fetchLeadPhotoUrl,
  logLeadContact,
  sendLeadText,
  setLeadNextContact,
  updateLeadInfo,
} from '../api';
import type { LeadBundle, LeadContactChannel, LeadContactStatus, LeadInfoItem, LeadInfoStatus } from '../api';
import { formatDay, sourceList, timeAgo } from '../components/LeadContactLine';
import { buildOutreach, itemKind, mailtoLink, OUTREACH_STEPS, smsLink, type ItemKind } from '../leadOutreach';

/**
 * Lead hub: everything known about one Jobber request, and the "info needed" list the team
 * works from. Questions come from Claude's reviews or the team; answers typed here are what
 * the next quote draft and review use.
 */
export default function LeadPage() {
  const { requestId = '' } = useParams();
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

  const replaceItem = (item: LeadInfoItem) => setLead((prev) => {
    // A save that finishes after the user moved to another lead must not land on it.
    if (!prev || prev.requestId !== item.requestId) return prev;
    const exists = prev.infoNeeded.items.some((i) => i.id === item.id);
    const items = exists ? prev.infoNeeded.items.map((i) => (i.id === item.id ? item : i)) : [...prev.infoNeeded.items, item];
    return { ...prev, infoNeeded: { items, summary: summarize(items) } };
  });

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

  return (
    <div style={page}>
      <Link to="/quotes/requests" style={back}>← Request queue</Link>

      <header style={headerRow}>
        <div>
          <h1 style={h1}>{val(req?.clientName) ?? (requestUnavailable ? 'Lead' : 'Unknown client')}</h1>
          <p style={subtitle}>{val(req?.title) ?? 'Untitled request'}</p>
          <p style={muted}>
            {val(req?.createdAt) ? `Requested ${new Date(val(req?.createdAt)!).toLocaleDateString()}` : ''}
            {val(req?.jobberWebUri) && <> · <a href={val(req?.jobberWebUri)!} target="_blank" rel="noreferrer">Open in Jobber</a></>}
          </p>
        </div>
        <ReadyBadge ready={summary.readyToQuote} total={summary.total} open={summary.open + summary.asked} />
      </header>

      {lead.contactStatus && <ContactPanel requestId={lead.requestId} status={lead.contactStatus} onChanged={reload} />}

      <OutreachPanel lead={lead} onChanged={reload} />

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
 * The team's outreach checklist for this lead, with proposed messages they can copy, open in
 * their own phone or mail app, or send through Quo after confirming the exact text.
 */
function OutreachPanel({ lead, onChanged }: { lead: LeadBundle; onChanged: () => void }) {
  const req = lead.request.request;
  const clientName = req?.clientName?.availability === 'present' ? req.clientName.value ?? null : null;
  const title = req?.title?.availability === 'present' ? req.title.value ?? null : null;
  const messages = buildOutreach({ clientName, title, items: lead.infoNeeded.items });
  const [text, setText] = useState(messages.text);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Rebuild the proposed text when the checklist changes (until the team edits it).
  const [edited, setEdited] = useState(false);
  useEffect(() => { if (!edited) setText(messages.text); }, [messages.text, edited]);

  const quoConnected = !(lead.contactStatus?.notConnected ?? []).includes('quo');
  const phone = lead.contact.phone;
  const email = lead.contact.email;
  const mailto = email ? mailtoLink(email, messages.emailSubject, messages.emailBody) : null;
  const done = new Map<string, string>();
  for (const c of lead.loggedContacts ?? []) if (c.step && !done.has(c.step)) done.set(c.step, c.contactedAt);

  const copy = async (what: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError('Could not copy. Select the text and copy it by hand.');
    }
  };

  const markStep = async (step: string, channel: LeadContactChannel) => {
    setBusy(true);
    setError(null);
    try {
      await logLeadContact(lead.requestId, { channel, step });
      onChanged();
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
      await sendLeadText(lead.requestId, text.trim(), done.has('intro_text') ? undefined : 'intro_text');
      setConfirming(false);
      setNotice('Text sent through Quo and logged.');
      onChanged();
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'The text was not sent.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={card}>
      <h2 style={h2}>Outreach</h2>
      <ol style={stepList}>
        {OUTREACH_STEPS.map((s) => (
          <li key={s.step} style={stepRow}>
            <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', cursor: done.has(s.step) ? 'default' : 'pointer' }}>
              <input
                type="checkbox"
                checked={done.has(s.step)}
                disabled={busy || done.has(s.step)}
                onChange={() => { void markStep(s.step, s.channel); }}
              />
              <span style={done.has(s.step) ? { textDecoration: 'line-through', color: '#666' } : {}}>{s.label}</span>
            </label>
            {done.has(s.step) && <span style={muted}>done {timeAgo(done.get(s.step)!)}</span>}
          </li>
        ))}
      </ol>

      <h3 style={h3}>Proposed text</h3>
      <textarea style={{ ...textarea, minHeight: 120 }} value={text} onChange={(e) => { setText(e.target.value); setEdited(true); }} aria-label="Proposed text message" />
      <div style={{ ...actions, marginTop: '0.5rem' }}>
        <button type="button" style={btn} onClick={() => copy('text', text)}>{copied === 'text' ? 'Copied' : 'Copy text'}</button>
        {phone && <a style={btnLink} href={smsLink(phone, text)}>Text from my phone</a>}
        {phone && quoConnected && <button type="button" style={primaryBtn} disabled={busy || !text.trim()} onClick={() => { setConfirming(true); setNotice(null); }}>Send via Quo…</button>}
        {edited && <button type="button" style={linkBtn} onClick={() => { setEdited(false); setText(messages.text); }}>Reset to proposed</button>}
      </div>
      {!phone && <p style={muted}>No phone number in Jobber for this lead.</p>}
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

      <h3 style={h3}>Proposed email</h3>
      <p style={{ ...muted, margin: '0 0 0.25rem' }}>Subject: {messages.emailSubject}</p>
      <p style={{ ...pre, ...emailPreview }}>{messages.emailBody}</p>
      <div style={{ ...actions, marginTop: '0.5rem' }}>
        <button type="button" style={btn} onClick={() => copy('email', `Subject: ${messages.emailSubject}\n\n${messages.emailBody}`)}>{copied === 'email' ? 'Copied' : 'Copy email'}</button>
        {mailto && <a style={btnLink} href={mailto}>Open in my email</a>}
      </div>
      {!email && <p style={muted}>No email address in Jobber for this lead.</p>}
      <p style={{ ...muted, marginTop: '0.5rem' }}>After sending from your own phone or email, tick the step above so it's logged.</p>
      {notice && <p role="status" style={{ ...muted, color: '#166534' }}>{notice}</p>}
      {error && <p role="alert" style={inlineError}>{error}</p>}
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

/** Last contact, next contact, a way to log outreach done elsewhere, and the recent timeline. */
function ContactPanel({ requestId, status, onChanged }: { requestId: string; status: LeadContactStatus; onChanged: () => void }) {
  const [channel, setChannel] = useState<LeadContactChannel>('call');
  const [direction, setDirection] = useState<'outgoing' | 'incoming'>('outgoing');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(status.next.source === 'set' ? status.next.on : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { setDate(status.next.source === 'set' ? status.next.on : ''); }, [status.next.on, status.next.source]);

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

  const next = status.next;
  const nextStyle = next.overdue ? { color: '#b91c1c', fontWeight: 600 } : next.dueToday ? { color: '#92400e', fontWeight: 600 } : {};
  const recent = showAll ? status.recent : status.recent.slice(0, 5);
  return (
    <section style={card}>
      <h2 style={h2}>Contact</h2>
      <div style={contactGrid}>
        <div>
          <span style={label}>Last contact</span>
          <p style={{ margin: '0.15rem 0 0' }}>
            {status.last ? <>{status.last.label} · {timeAgo(status.last.at)} <span style={muted}>({SOURCE_NAME[status.last.source]})</span></> : 'No contact yet'}
          </p>
        </div>
        <div>
          <span style={label}>Next contact</span>
          <p style={{ margin: '0.15rem 0 0', ...nextStyle }}>
            {formatDay(next.on)}{next.overdue ? ' · overdue' : ''}
            <span style={{ ...muted, fontWeight: 400 }}> · {next.source === 'suggested' ? `suggested: ${next.reason}` : 'set by the team'}</span>
          </p>
          <div style={{ ...actions, marginTop: '0.35rem' }}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Next contact date" style={dateInput} />
            <button type="button" style={btn} disabled={saving || !date || date === (next.source === 'set' ? next.on : '')} onClick={() => run(() => setLeadNextContact(requestId, date))}>Set date</button>
            {next.source === 'set' && <button type="button" style={btn} disabled={saving} onClick={() => run(() => setLeadNextContact(requestId, null))}>Use suggestion</button>}
          </div>
        </div>
      </div>
      {(status.unavailable.length > 0 || status.notConnected.length > 0) && (
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          {status.unavailable.length > 0 && <>Could not read {sourceList(status.unavailable)} right now, so contact history may be incomplete. </>}
          {status.notConnected.length > 0 && <>{sourceList(status.notConnected)} not connected to Cotiza.</>}
        </p>
      )}

      <form
        style={{ ...addRow, flexWrap: 'wrap', marginTop: '0.75rem' }}
        onSubmit={(e) => { e.preventDefault(); void run(() => logLeadContact(requestId, { channel, direction, note: note.trim() || undefined }), () => setNote('')); }}
      >
        <select value={channel} onChange={(e) => setChannel(e.target.value as LeadContactChannel)} aria-label="Contact type" style={select}>
          {CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <select value={direction} onChange={(e) => setDirection(e.target.value as 'outgoing' | 'incoming')} aria-label="Who reached out" style={select}>
          <option value="outgoing">We reached out</option>
          <option value="incoming">Customer reached us</option>
        </select>
        <input style={{ ...input, minWidth: 180 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (e.g. left voicemail)" aria-label="Contact note" maxLength={500} />
        <button type="submit" style={primaryBtn} disabled={saving}>Log contact</button>
      </form>
      {error && <p role="alert" style={inlineError}>{error}</p>}

      {status.recent.length > 0 && (
        <>
          <h3 style={h3}>Recent activity</h3>
          <ul style={list}>
            {recent.map((e, i) => (
              <li key={`${e.at}-${i}`} style={timelineRow}>
                <span>{e.label}{e.note ? <span style={muted}> — {e.note}</span> : null}</span>
                <span style={muted}>{timeAgo(e.at)} · {SOURCE_NAME[e.source]}</span>
              </li>
            ))}
          </ul>
          {status.recent.length > 5 && (
            <button type="button" style={linkBtn} onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show less' : `Show all ${status.recent.length}`}</button>
          )}
        </>
      )}
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

function ReadyBadge({ ready, total, open }: { ready: boolean; total: number; open: number }) {
  if (total === 0) return <span style={{ ...badge, background: '#f3f4f6', color: '#555' }}>No checklist yet</span>;
  return ready
    ? <span style={{ ...badge, background: '#dcfce7', color: '#166534' }}>Ready to quote</span>
    : <span style={{ ...badge, background: '#fef3c7', color: '#92400e' }}>{open} still needed</span>;
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
      <section style={card}>
        <h2 style={h2}>Need from the customer</h2>
        <p style={muted}>Only what we can't reasonably assume. Ask, then type the answer here.</p>
        {asks.length === 0 && <p style={muted}>Nothing needed from the customer to quote this lead.</p>}
        <ul style={list}>
          {asks.map((item) => <InfoRow key={item.id} item={item} kind={itemKind(item)} onSaved={onSaved} />)}
        </ul>
        <AddQuestion requestId={requestId} onAdded={onSaved} />
      </section>
      {assumptions.length > 0 && (
        <section style={card}>
          <h2 style={h2}>Our assumptions</h2>
          <p style={muted}>What the quote is based on. These go to the customer with the quote; if they correct one, type the correction here.</p>
          <ul style={list}>
            {assumptions.map((item) => <InfoRow key={item.id} item={item} kind="assumption" onSaved={onSaved} />)}
          </ul>
        </section>
      )}
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
      onAdded((await addLeadInfo(requestId, question.trim())).item);
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
const page: React.CSSProperties = { maxWidth: 860, margin: '0 auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' };
const back: React.CSSProperties = { color: '#00a89d', textDecoration: 'none', fontSize: '0.9rem' };
const headerRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' };
const h1: React.CSSProperties = { margin: 0, fontSize: '1.4rem', color: '#061216' };
const h2: React.CSSProperties = { margin: '0 0 0.5rem', fontSize: '1.05rem', color: '#061216' };
const h3: React.CSSProperties = { margin: '0.75rem 0 0.25rem', fontSize: '0.95rem' };
const subtitle: React.CSSProperties = { margin: '0.25rem 0', fontWeight: 600, color: '#00a89d' };
const muted: React.CSSProperties = { margin: '0.25rem 0', color: '#666', fontSize: '0.88rem' };
const card: React.CSSProperties = { background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8, padding: '1rem' };
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
const btn: React.CSSProperties = { font: 'inherit', fontSize: '0.85rem', padding: '0.35rem 0.75rem', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer' };
const primaryBtn: React.CSSProperties = { ...btn, background: '#00a89d', borderColor: '#00a89d', color: '#fff' };
const addRow: React.CSSProperties = { display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' };
const inlineError: React.CSSProperties = { margin: 0, color: '#b91c1c', fontSize: '0.85rem', width: '100%' };
const pre: React.CSSProperties = { margin: '0.25rem 0', whiteSpace: 'pre-wrap', fontSize: '0.9rem', lineHeight: 1.45 };
const note: React.CSSProperties = { borderLeft: '3px solid #e5e7eb', paddingLeft: '0.75rem', margin: '0.5rem 0' };
const label: React.CSSProperties = { fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#888' };
const quoteRow: React.CSSProperties = { display: 'flex', gap: '0.75rem', alignItems: 'baseline', flexWrap: 'wrap' };
const photoGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '0.5rem' };
const photoBox: React.CSSProperties = { aspectRatio: '4 / 3', background: '#f3f4f6', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', textAlign: 'center' };
const photo: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover' };
const contactGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' };
const dateInput: React.CSSProperties = { font: 'inherit', fontSize: '0.85rem', padding: '0.3rem 0.4rem', border: '1px solid #d1d5db', borderRadius: 6 };
const select: React.CSSProperties = { font: 'inherit', padding: '0.45rem', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff' };
const timelineRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: '0.75rem', fontSize: '0.88rem', flexWrap: 'wrap' };
const linkBtn: React.CSSProperties = { font: 'inherit', fontSize: '0.85rem', background: 'none', border: 'none', color: '#00a89d', cursor: 'pointer', padding: '0.25rem 0' };
const stepList: React.CSSProperties = { margin: '0 0 0.5rem', paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' };
const stepRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' };
const btnLink: React.CSSProperties = { font: 'inherit', fontSize: '0.85rem', padding: '0.35rem 0.75rem', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', color: 'inherit', textDecoration: 'none' };
const confirmBox: React.CSSProperties = { marginTop: '0.75rem', padding: '0.75rem', border: '1px solid #f59e0b', background: '#fffbeb', borderRadius: 8 };
const emailPreview: React.CSSProperties = { margin: 0, padding: '0.5rem', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: '0.88rem', maxHeight: 240, overflow: 'auto' };
