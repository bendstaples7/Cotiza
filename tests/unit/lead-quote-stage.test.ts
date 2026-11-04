import { describe, expect, it } from 'vitest';
import type { ContactEvent } from '../../worker/src/services/lead-contact-service.js';
import { computeLeadWorkflow } from '../../worker/src/services/lead-workflow.js';
import { computeQuoteStage, reviewDecision, type QuoteRef, type QuoteStageInput } from '../../worker/src/services/lead-quote-stage.js';

const draft = (id: string, number: string): QuoteRef => ({ id, number, status: 'draft', webUri: `https://secure.getjobber.com/quotes/${number}` });
const stage = (over: Partial<QuoteStageInput> = {}) => computeQuoteStage({ quotes: [draft('Q1', '716')], reviews: {}, requested: {}, legacyPending: [], ...over });

describe('reviewDecision', () => {
  it('uses an explicit decision first', () => {
    expect(reviewDecision({ decision: 'approved', status: 'edits needed' })).toBe('approved');
    expect(reviewDecision({ decision: 'changes_requested' })).toBe('changes_requested');
  });

  it('reads older records from their status text', () => {
    expect(reviewDecision({ status: 'recheck passed; route to customer' })).toBe('approved');
    expect(reviewDecision({ status: 'Good to go' })).toBe('approved');
    expect(reviewDecision({ status: 'edits listed; team to apply' })).toBe('changes_requested');
    expect(reviewDecision({ status: 'approved once the team applies edits; send back' })).toBe('changes_requested');
    expect(reviewDecision({ status: 'not approved yet' })).toBe('unclear');
    expect(reviewDecision({ status: "hasn't passed the recheck" })).toBe('unclear');
    expect(reviewDecision({ verification: [] })).toBe('unclear');
    expect(reviewDecision(null)).toBe('unclear');
  });
});

describe('computeQuoteStage', () => {
  it('no quote, then drafting', () => {
    expect(stage({ quotes: [] }).kind).toBe('none');
    expect(stage()).toMatchObject({ kind: 'drafting', label: 'Quote #716 · drafting', quote: { id: 'Q1', number: '716' } });
  });

  it('with Ben once the team sends it, until Ben reviews', () => {
    expect(stage({ requested: { Q1: '2026-11-04T15:00:00Z' } })).toMatchObject({ kind: 'ben_review', why: expect.stringContaining('Nothing for you to do') });
    // An older review doesn't count: the team sent it again after edits.
    expect(stage({ requested: { Q1: '2026-11-04T15:00:00Z' }, reviews: { 716: { at: '2026-11-03T15:00:00Z', decision: 'changes_requested' } } }).kind).toBe('ben_review');
    expect(stage({ legacyPending: ['Q1'] }).kind).toBe('ben_review');
  });

  it('ready to send when Ben approves; edits when he asks for changes', () => {
    expect(stage({ requested: { Q1: '2026-11-04T15:00:00Z' }, reviews: { 716: { at: '2026-11-04T17:00:00Z', decision: 'approved' } } }))
      .toMatchObject({ kind: 'ready_to_send', label: 'Quote #716 · ready to send' });
    // Ben can review straight from the team's WhatsApp request, with no Cotiza button pressed.
    expect(stage({ reviews: { 716: { at: '2026-11-04T17:00:00Z', decision: 'approved' } } }).kind).toBe('ready_to_send');
    expect(stage({ reviews: { 716: { at: '2026-11-04T17:00:00Z', decision: 'changes_requested' } } }).kind).toBe('changes');
    expect(stage({ reviews: { 716: { at: '2026-11-04T17:00:00Z', decision: 'unclear' } } })).toMatchObject({ kind: 'ben_review', why: expect.stringContaining('Check with Ben') });
  });

  it('sent once Jobber shows it sent; archived quotes are ignored', () => {
    expect(stage({ quotes: [draft('Q1', '716'), { id: 'Q2', number: '715', status: 'awaiting_response', webUri: null }] }).kind).toBe('sent');
    expect(stage({ quotes: [{ ...draft('Q1', '716'), status: 'archived' }] }).kind).toBe('none');
  });

  it('says so when the review ledger or the older review cycle cannot be read', () => {
    expect(stage({ reviews: 'unknown' })).toMatchObject({ kind: 'unknown', why: expect.stringContaining('could not be read') });
    expect(stage({ legacyPending: 'unknown' }).kind).toBe('unknown');
  });

  it('treats Jobber\'s "sent" status as sent', () => {
    expect(stage({ quotes: [{ ...draft('Q1', '716'), status: 'sent' }] }).kind).toBe('sent');
  });

  it('follows the newest draft', () => {
    expect(stage({ quotes: [draft('Q1', '701'), draft('Q2', '716')] }).quote?.number).toBe('716');
  });
});

describe('the lead workflow uses the quote stage', () => {
  const NOW = Date.parse('2026-11-04T16:00:00Z');
  const lead: ContactEvent = { at: '2026-11-03T14:00:00Z', channel: 'request', direction: 'incoming', source: 'jobber', label: 'Request came in' };
  const touch: ContactEvent = { at: '2026-11-03T15:00:00Z', channel: 'text', direction: 'outgoing', source: 'quo', label: 'Text sent' };
  const run = (st: ReturnType<typeof stage>, events: ContactEvent[] = [lead, touch]) => computeLeadWorkflow({
    events, nextSet: null, info: { readyToQuote: true, total: 2, firstAsk: null }, hasTitle: true, notALead: false,
    quotes: [{ status: 'draft' }], quoteStage: st, now: NOW,
  });

  it('drafting: finish it, then send it to Ben', () => {
    expect(run(stage())).toMatchObject({ progress: 'quote_drafted', bucket: 'do_now', action: { kind: 'draft_quote', label: 'Finish quote #716' }, quoteStage: { kind: 'drafting' } });
  });

  it('with Ben: nothing to do, so the lead waits', () => {
    const w = run(stage({ requested: { Q1: '2026-11-04T15:00:00Z' } }), [lead, touch, { ...touch, at: '2026-11-04T15:00:00Z' }]);
    expect(w).toMatchObject({ progress: 'ben_review', bucket: 'waiting', action: { kind: 'wait_review', label: 'Waiting on Ben’s review' } });
  });

  it('with Ben on an old lead with a follow-up due: the customer still hears from us', () => {
    const old: ContactEvent = { ...lead, at: '2026-10-28T14:00:00Z' };
    const w = run(stage({ requested: { Q1: '2026-11-04T15:00:00Z' } }), [old, { ...touch, at: '2026-10-28T15:00:00Z' }]);
    // Waiting on Ben stays the main action; the update to the customer is the secondary one.
    expect(w).toMatchObject({ bucket: 'do_now', action: { kind: 'wait_review' }, secondary: { kind: 'quote_update' } });
  });

  it('ready to send and Ben’s edits', () => {
    expect(run(stage({ reviews: { 716: { at: '2026-11-04T17:00:00Z', decision: 'approved' } } })))
      .toMatchObject({ progress: 'ready_to_send', bucket: 'do_now', action: { kind: 'send_quote', label: 'Send quote #716 in Jobber' } });
    expect(run(stage({ reviews: { 716: { at: '2026-11-04T17:00:00Z', decision: 'changes_requested' } } })).action)
      .toMatchObject({ kind: 'ben_edits', label: 'Make Ben’s edits' });
  });

  it('a customer reply while the quote is with Ben still gets answered today', () => {
    const reply: ContactEvent = { at: '2026-11-04T15:30:00Z', channel: 'text', direction: 'incoming', source: 'quo', label: 'Text from customer' };
    const w = run(stage({ requested: { Q1: '2026-11-04T15:00:00Z' } }), [lead, touch, reply]);
    expect(w).toMatchObject({ bucket: 'do_now', action: { kind: 'reply', label: 'Reply today', why: expect.stringContaining('Waiting on Ben') } });
  });

  it('unknown review state says so instead of guessing', () => {
    expect(run(stage({ reviews: 'unknown' })).action).toMatchObject({ label: 'Check the quote with Ben', why: expect.stringContaining('could not be read') });
  });
});
