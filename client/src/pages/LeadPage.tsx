import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ErrorResponse } from 'shared';
import {
  addLeadInfo,
  fetchLead,
  fetchLeadPhotoUrl,
  updateLeadInfo,
} from '../api';
import type { LeadBundle, LeadInfoItem, LeadInfoStatus } from '../api';

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

      <section style={card}>
        <h2 style={h2}>Info needed</h2>
        <p style={muted}>What we still need from the customer before quoting. Ask, then type the answer here.</p>
        {lead.infoNeeded.items.length === 0 && <p style={muted}>No questions yet.</p>}
        <ul style={list}>
          {lead.infoNeeded.items.map((item) => <InfoRow key={item.id} item={item} onSaved={replaceItem} />)}
        </ul>
        <AddQuestion requestId={lead.requestId} onAdded={replaceItem} />
      </section>

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

function InfoRow({ item, onSaved }: { item: LeadInfoItem; onSaved: (item: LeadInfoItem) => void }) {
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
        <span style={{ fontWeight: 600 }}>{item.question}{!item.required && <span style={muted}> (optional)</span>}</span>
        <span style={{ ...chip, ...(done ? chipDone : item.status === 'asked' ? chipAsked : {}) }}>{STATUS_LABEL[item.status]}</span>
      </div>
      {item.status !== 'dropped' && (
        <textarea
          style={textarea}
          rows={2}
          placeholder="Customer's answer"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          aria-label={`Answer: ${item.question}`}
        />
      )}
      <div style={actions}>
        {item.status !== 'dropped' && (
          <button type="button" style={primaryBtn} disabled={saving || !answer.trim() || answer.trim() === (item.answer ?? '')} onClick={() => save({ answer: answer.trim(), status: 'answered' })}>
            Save answer
          </button>
        )}
        {item.status === 'open' && <button type="button" style={btn} disabled={saving} onClick={() => save({ status: 'asked' })}>Mark asked</button>}
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
