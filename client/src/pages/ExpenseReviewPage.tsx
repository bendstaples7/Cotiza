import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { API_BASE, getToken } from '../api';

type Details = { supplier: string; invoiceNumber: string; title: string; description: string; date: string; total: number; receiptId?: string; operation?: 'create' | 'attach'; targetExpenseId?: string; accountingCodeId?: string; linkedJobId?: string; reimbursableToId?: string };
type Review = { state: string; expenseId?: string; expiresAt: string; details: Details; receiptSource: string };
type Result = { outcome: string; message?: string; expenseId?: string; expense?: { id: string }; receiptSubmitted?: boolean };
async function request(path: string, init?: RequestInit) {
  const response = await fetch(API_BASE + '/api/assistant' + path, { ...init, headers: { Authorization: `Bearer ${getToken() || ''}`, ...(init?.headers ?? {}) } });
  if (!response.ok) throw new Error(response.status === 404 ? 'This review is unavailable for your account.' : 'Could not load the expense. Please check your connection.');
  return response;
}
export default function ExpenseReviewPage() {
  const { id } = useParams();
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [replace, setReplace] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [optionsReady, setOptionsReady] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setReview(null); setError(''); setResult(null); setSubmitted(false); setOptionsReady(false);
    (async () => {
      const r: Review = await (await request(`/expense-reviews/${id}`, { signal: controller.signal })).json();
      if (controller.signal.aborted) return; setReview(r);
      const resolved: Record<string, string> = {};
      for (const [key, kind] of [['accountingCodeId', 'categories'], ['linkedJobId', 'jobs'], ['reimbursableToId', 'users']] as const) {
        const selected = r.details[key]; if (!selected || r.details.operation === 'attach') continue;
        let cursor: string | undefined;
        for (let page = 0; page < 5; page++) {
          const options = await (await request(`/expense-options?kind=${kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: controller.signal })).json();
          const item = options.items?.find((x: { id: string }) => x.id === selected);
          if (item) { resolved[key] = [item.jobNumber ? `#${item.jobNumber}` : '', typeof item.name === 'string' ? item.name : item.name?.full || [item.name?.first, item.name?.last].filter(Boolean).join(' '), item.title || item.code || item.email].filter(Boolean).join(' — ') || 'Verified selection'; break; }
          if (!options.page?.hasNextPage || !options.page.endCursor) break; cursor = options.page.endCursor;
        }
        if (!resolved[key]) throw new Error('A selected category, job or reimbursement recipient could not be confirmed. Ask ChatGPT to prepare the expense again.');
      }
      if (!controller.signal.aborted) { setLabels(resolved); setOptionsReady(true); }
    })().catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [id]);
  async function preview() {
    if (!review?.details.receiptId) return;
    try {
      const file = await (await request(`/receipts/${review.details.receiptId}`)).blob();
      const url = URL.createObjectURL(file); const link = document.createElement('a'); link.href = url; link.download = 'receipt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) { setError(e instanceof Error ? e.message : 'Receipt could not be downloaded.'); }
  }
  async function approve() {
    if (busy || submitted || !review) return;
    setBusy(true); setSubmitted(true); setError('');
    try {
      setResult(await (await request(`/expense-reviews/${id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, confirmReplacement: replace }) })).json());
    } catch {
      setResult({ outcome: 'unknown', message: 'The submission response was interrupted. Do not submit again; ask ChatGPT to check this expense action.' });
    } finally { setBusy(false); }
  }
  if (!review) return <main style={{ maxWidth: 720, margin: '40px auto', padding: 24 }}><h1>Review expense</h1><p role={error ? 'alert' : 'status'}>{error || 'Loading your expense…'}</p></main>;
  const d = review.details; const attach = d.operation === 'attach';
  const expired = Date.parse(review.expiresAt) <= Date.now();
  const canApprove = review.state === 'pending' && !expired && optionsReady && (!attach || replace) && !submitted && !busy;
  const accepted = result && ['created', 'receipt_submitted', 'already_recorded'].includes(result.outcome);
  return <main style={{ maxWidth: 720, margin: '32px auto', padding: 28, background: '#fff', borderRadius: 12, border: '1px solid #dde3e5' }}>
    <p style={{ color: '#52616a' }}>Chicago Reno · Jobber</p>
    <h1>{attach ? 'Review receipt attachment' : 'Review new expense'}</h1>
    <p>{attach ? 'Set the receipt on the existing expense shown below.' : 'Check these details before recording this expense.'}</p>
    <table style={{ width: '100%', borderCollapse: 'collapse', margin: '24px 0', textAlign: 'left' }}><tbody>
      {Object.entries({ Supplier: d.supplier, 'Invoice / receipt': d.invoiceNumber, Title: d.title, Date: d.date, Amount: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(d.total), Category: labels.accountingCodeId || (d.accountingCodeId ? 'Confirming selection…' : 'No category selected'), Job: labels.linkedJobId || (d.linkedJobId ? 'Confirming selection…' : 'General business expense'), 'Reimburse to': labels.reimbursableToId || (d.reimbursableToId ? 'Confirming selection…' : 'No reimbursement') }).map(([label, value]) => <tr key={label}><th style={{ padding: '10px 16px 10px 0', borderBottom: '1px solid #eee' }}>{label}</th><td style={{ padding: '10px 0', borderBottom: '1px solid #eee' }}>{value}</td></tr>)}
    </tbody></table>
    <p style={{ whiteSpace: 'pre-wrap' }}>{d.description}</p>
    {d.receiptId ? <button type="button" onClick={preview}>Download receipt to review</button> : <p>Receipt: original Square invoice PDF.</p>}
    <p style={{ color: '#52616a' }}>We verify the expense details after submission. Jobber does not let us reopen its saved receipt here, so attachment verification will be reported as unavailable.</p>
    {attach && <label style={{ display: 'block', margin: '20px 0' }}><input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} /> I understand this sets or replaces the expense’s existing receipt.</label>}
    {error && <p role="alert">{error}</p>}
    {expired && <p role="alert">This review has expired. Ask ChatGPT to prepare it again.</p>}
    {!result && review.state !== 'pending' && <p role="status">Current state: {review.state}. Ask ChatGPT to check the action; do not create a second expense.</p>}
    {result ? <section role="status"><h2>{accepted ? 'Submission accepted' : 'Review required'}</h2><p>{result.message || (accepted ? 'The expense details were confirmed and the receipt request was accepted. Independent receipt verification is unavailable.' : 'Do not submit again. Ask ChatGPT to check this action before any further write.')}</p>{(result.expenseId || result.expense?.id) && <p>Jobber record: {result.expenseId || result.expense?.id}</p>}</section> : <button type="button" disabled={!canApprove} onClick={approve} style={{ marginTop: 24, padding: '12px 20px' }}>{busy ? 'Submitting…' : attach ? 'Approve receipt submission' : 'Approve and record expense'}</button>}
  </main>;
}
