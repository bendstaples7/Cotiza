import { describe, expect, it } from 'vitest';
import type { ContactEvent } from '../../worker/src/services/lead-contact-service.js';
import { classifyTeamNote, requestEvents } from '../../worker/src/services/lead-contact-status.js';
import { addDays, computeLeadWorkflow, daysBetween, handbookCadence, shortAsk } from '../../worker/src/services/lead-workflow.js';

// Wed Nov 4 2026, 10:00 in Chicago.
const NOW = Date.parse('2026-11-04T16:00:00Z');

const request = (at: string): ContactEvent => ({ at, channel: 'request', direction: 'incoming', source: 'jobber', label: 'Request came in' });
const out = (at: string, channel: ContactEvent['channel'] = 'text'): ContactEvent => ({ at, channel, direction: 'outgoing', source: 'quo', label: 'Text sent' });
const inc = (at: string, channel: ContactEvent['channel'] = 'text'): ContactEvent => ({ at, channel, direction: 'incoming', source: 'quo', label: 'Text from customer' });
const teamNote = (at: string, message: string) => requestEvents({ notes: [{ message, createdAt: at, createdBy: 'team' }] })[0];

const info = (over: Partial<{ readyToQuote: boolean; total: number; firstAsk: string | null }> = {}) => ({ readyToQuote: false, total: 2, firstAsk: 'Can you send a few photos of the walls?', ...over });
const workflow = (events: ContactEvent[], over: Partial<Parameters<typeof computeLeadWorkflow>[0]> = {}) =>
  computeLeadWorkflow({ events, nextSet: null, info: info(), hasTitle: true, notALead: false, now: NOW, ...over });

describe('dates', () => {
  it('counts calendar days and adds them', () => {
    expect(daysBetween('2026-11-02', '2026-11-04')).toBe(2);
    expect(addDays('2026-11-04', 30)).toBe('2026-12-04');
  });
});

describe('handbookCadence', () => {
  const lead = request('2026-11-02T14:00:00Z'); // Mon Nov 2

  it('step 1: reach out the day the lead comes in', () => {
    expect(handbookCadence([lead], NOW)).toMatchObject({ step: 1, stage: 'Step 1 · reach out on intake', suggested: '2026-11-02', count: 0 });
  });

  it('step 2: the business day after the first touch', () => {
    expect(handbookCadence([lead, out('2026-11-02T15:00:00Z')], NOW)).toMatchObject({ step: 2, suggested: '2026-11-03' });
  });

  it('step 3: every 2 business days, three times, then weekly, then monthly', () => {
    const touches = ['2026-11-02', '2026-11-03', '2026-11-05', '2026-11-09', '2026-11-11', '2026-11-18', '2026-11-25', '2026-12-02']
      .map((d) => out(`${d}T15:00:00Z`));
    const at = (n: number) => handbookCadence([lead, ...touches.slice(0, n)], NOW);
    expect(at(2)).toMatchObject({ step: 3, suggested: '2026-11-05' });
    expect(at(4)).toMatchObject({ step: 3, suggested: '2026-11-11' });
    expect(at(5)).toMatchObject({ step: 4, stage: 'Step 4 · weekly', suggested: '2026-11-18' });
    expect(at(7)).toMatchObject({ step: 4, suggested: '2026-12-02' });
    expect(at(8)).toMatchObject({ step: 5, stage: 'Step 5 · monthly', suggested: '2027-01-01' });
  });

  it('a customer reply means answer the same day, then picks up at step 3', () => {
    const replied = handbookCadence([lead, out('2026-11-02T15:00:00Z'), inc('2026-11-03T15:00:00Z')], NOW);
    expect(replied).toMatchObject({ step: 'replied', stage: 'Customer replied → answer same day', suggested: '2026-11-03' });
    const answered = handbookCadence([lead, out('2026-11-02T15:00:00Z'), inc('2026-11-03T15:00:00Z'), out('2026-11-03T16:00:00Z')], NOW);
    expect(answered).toMatchObject({ step: 3, suggested: '2026-11-05' });
  });

  it('a call where we spoke counts as engagement; we follow up 2 business days later', () => {
    const call: ContactEvent = { at: '2026-11-03T15:00:00Z', channel: 'call', direction: 'outgoing', source: 'quo', label: 'Call made', conversation: true };
    expect(handbookCadence([lead, out('2026-11-02T15:00:00Z'), call], NOW)).toMatchObject({ step: 3, suggested: '2026-11-05' });
  });

  it('a client note at intake (the form\'s attachments) is not a reply', () => {
    const attachments: ContactEvent = { at: '2026-11-02T14:00:20Z', channel: 'note', direction: 'incoming', source: 'jobber', label: 'Note from customer' };
    expect(handbookCadence([lead, attachments], NOW).step).toBe(1);
  });
});

describe('Jobber team notes', () => {
  it('reads what the team recorded', () => {
    expect(classifyTeamNote('No answer. Left vm. Texting doesnt work. Sent email with questions.')).toBe('outreach');
    expect(classifyTeamNote('Followed up via email.\n- Awaiting reply')).toBe('outreach');
    expect(classifyTeamNote('Hi Denzel... -- sent email intake questions. awaiting response')).toBe('outreach');
    expect(classifyTeamNote("Emma's Text:\nThis is the shower handle leak.")).toBe('reply');
    expect(classifyTeamNote('CHRIS EMAILED: \n\nHi Denzel, first...')).toBe('reply');
    expect(classifyTeamNote('CALL SUMMARY: \nHVAC: Working properly')).toBe('conversation');
    expect(classifyTeamNote('COPIED FROM THE REQUEST FORM\n\nLooking to replace carpeting')).toBe('note');
    expect(classifyTeamNote('RENE SENT VIA WHATSAPP: Hi team')).toBe('note');
  });

  it('treats customer-voiced notes as replies and voicemails as outreach', () => {
    for (const note of ['Customer sent an email asking about timing', 'Client texted back photos', 'Customer reached out about the start date', 'Customer left a voicemail', 'Missed call from customer']) {
      expect(classifyTeamNote(note)).toBe('reply');
    }
    expect(classifyTeamNote('Spoke to voicemail, will try again')).toBe('outreach');
    expect(classifyTeamNote('Spoke with customer. Customer sent photos after.')).toBe('conversation');
    expect(classifyTeamNote('Called the customer, no answer')).toBe('outreach');
  });

  it('counts outreach notes as touches and reply notes as the customer speaking', () => {
    const lead = request('2026-11-01T21:46:00Z');
    const vm = teamNote('2026-11-02T17:27:00Z', 'No answer. Left vm. Sent email with questions.');
    expect(vm).toMatchObject({ direction: 'outgoing', outreach: true, label: 'Outreach (Jobber note)' });
    expect(handbookCadence([lead, vm], NOW)).toMatchObject({ step: 2, suggested: '2026-11-03' });
    const reply = teamNote('2026-11-04T14:22:00Z', "Emma's Text: This is the shower handle leak.");
    expect(reply).toMatchObject({ direction: 'incoming', reply: true });
    expect(handbookCadence([lead, vm, reply], NOW).step).toBe('replied');
    const plain = teamNote('2026-11-03T12:00:00Z', 'COPIED FROM THE REQUEST FORM');
    expect(handbookCadence([lead, plain], NOW).step).toBe(1);
  });
});

describe('computeLeadWorkflow', () => {
  const lead = request('2026-11-02T14:00:00Z');

  it('nobody has reached out: send the intro text, overdue since intake', () => {
    const w = workflow([lead]);
    expect(w).toMatchObject({ bucket: 'do_now', step: 1, progress: 'lead_in', ageDays: 2 });
    expect(w.action).toMatchObject({ kind: 'intro_text', label: 'Send intro text', step: 'intro_text' });
    expect(w.next).toMatchObject({ on: '2026-11-02', overdue: true, daysOverdue: 2 });
    expect(w.plan[0]).toMatchObject({ label: 'Intake', state: 'missed' });
  });

  it('follow-up due while info is still needed: ask for the first open item', () => {
    const w = workflow([lead, out('2026-11-02T15:00:00Z')]);
    expect(w.action).toMatchObject({ kind: 'ask_info', label: 'Text: ask for photos', why: 'Still need photos to quote.' });
    expect(w.next).toMatchObject({ on: '2026-11-03', overdue: true, daysOverdue: 1 });
    expect(w.plan.map((r) => r.state)).toEqual(['done', 'missed', 'upcoming', 'upcoming', 'upcoming']);
  });

  it('waiting on the customer when the next touch is later', () => {
    const w = workflow([lead, out('2026-11-02T15:00:00Z'), out('2026-11-03T15:00:00Z'), out('2026-11-04T15:00:00Z')]);
    expect(w).toMatchObject({ bucket: 'waiting', step: 3 });
    expect(w.next).toMatchObject({ on: '2026-11-06', overdue: false, dueToday: false });
    expect(w.plan[2]).toMatchObject({ label: 'Every 2–3 business days', state: 'due' });
  });

  it('customer replied: reply today, or draft the quote when we have what we need', () => {
    const events = [lead, out('2026-11-02T15:00:00Z'), inc('2026-11-04T14:00:00Z')];
    expect(workflow(events).action).toMatchObject({ kind: 'reply', label: 'Reply today' });
    const ready = workflow(events, { info: info({ readyToQuote: true, firstAsk: null }) });
    expect(ready).toMatchObject({ bucket: 'do_now', progress: 'ready_to_quote' });
    expect(ready.action).toMatchObject({ kind: 'draft_quote', label: 'Draft quote' });
    // They still get an answer today: as the secondary action under drafting.
    expect(ready.secondary).toMatchObject({ kind: 'reply', label: 'Reply today' });
  });

  it('ready to quote: the main action is drafting; the "quote in progress" update is secondary, only when due and we have been quiet', () => {
    const old = request('2026-10-29T02:11:00Z');
    const events = [old, out('2026-10-29T15:00:00Z'), out('2026-10-30T15:00:00Z')];
    const ready = { info: info({ readyToQuote: true, firstAsk: null }) };
    const w = workflow(events, ready);
    expect(w).toMatchObject({ bucket: 'do_now', ageDays: 7 });
    expect(w.action).toMatchObject({ kind: 'draft_quote', label: 'Draft quote' });
    expect(w.secondary).toMatchObject({ kind: 'quote_update', label: 'Send “quote in progress” text' });
    // We were in touch within 3 days (like an email this morning): no update offered.
    const emailed: ContactEvent = { ...out('2026-11-04T11:00:00Z', 'email'), source: 'gmail', label: 'Email sent' };
    const recent = workflow([...events, emailed], ready);
    expect(recent.action.kind).toBe('draft_quote');
    expect(recent.secondary).toBeNull();
    expect(recent.bucket).toBe('do_now');
  });

  it('ready to quote with the next contact days away: still Do now, drafting, no update', () => {
    const old = request('2026-10-28T20:00:00Z');
    const events = [old, out('2026-10-29T15:00:00Z'), out('2026-10-30T15:00:00Z'), out('2026-11-03T15:00:00Z')];
    const w = workflow(events, { info: info({ readyToQuote: true, firstAsk: null }) });
    expect(w.next.overdue || w.next.dueToday).toBe(false);
    expect(w).toMatchObject({ bucket: 'do_now', action: { kind: 'draft_quote' }, secondary: null });
  });

  it('a reply on an old ready lead: draft the quote, and answer them today as the secondary action', () => {
    const old = request('2026-10-29T02:11:00Z');
    const events = [old, out('2026-10-29T15:00:00Z'), inc('2026-10-29T18:44:00Z')];
    const w = workflow(events, { info: info({ readyToQuote: true, firstAsk: null }) });
    expect(w.action).toMatchObject({ kind: 'draft_quote', label: 'Draft quote' });
    expect(w.secondary).toMatchObject({ kind: 'reply' });
    expect(w.next).toMatchObject({ on: '2026-10-29', daysOverdue: 6 });
  });

  it('counts the lead age in Chicago calendar days', () => {
    // 9pm Oct 28 in Chicago is already Oct 29 in UTC; at 10am Nov 4 Chicago that is 7 days.
    expect(workflow([request('2026-10-29T02:00:00Z')]).ageDays).toBe(7);
  });

  it('a quote in Jobber moves the lead on: finish a draft, follow up on a sent one', () => {
    const events = [lead, out('2026-11-02T15:00:00Z')];
    const drafted = workflow(events, { quotes: [{ status: 'draft' }] });
    expect(drafted).toMatchObject({ progress: 'quote_drafted', bucket: 'do_now', action: { kind: 'draft_quote', label: 'Finish the quote' } });
    const sent = workflow(events, { quotes: [{ status: 'awaiting_response' }], info: info({ readyToQuote: true, firstAsk: null }) });
    expect(sent).toMatchObject({ progress: 'quote_sent', action: { kind: 'quote_follow_up' } });
    const approved = workflow(events, { quotes: [{ status: 'approved' }] });
    expect(approved).toMatchObject({ bucket: 'waiting', action: { kind: 'none', label: 'Quote approved' } });
    // A draft beats the intro text when nobody has reached out yet.
    expect(workflow([lead], { quotes: [{ status: 'draft' }] }).action.label).toBe('Finish the quote');
  });

  it('a ready lead stays in Do now even when the next touch is later', () => {
    const events = [lead, out('2026-11-02T15:00:00Z'), out('2026-11-03T15:00:00Z'), out('2026-11-04T15:00:00Z')];
    expect(workflow(events, { info: info({ readyToQuote: true, firstAsk: null }) }).bucket).toBe('do_now');
  });

  it('the team-set date wins', () => {
    const w = workflow([lead], { nextSet: '2026-11-10' });
    expect(w).toMatchObject({ bucket: 'waiting', stage: 'Step 1 · reach out on intake · date set by the team' });
    expect(w.next).toMatchObject({ on: '2026-11-10', source: 'set', overdue: false });
  });

  it('review: marked not a lead, or an old untitled request nobody has touched', () => {
    expect(workflow([lead], { notALead: true })).toMatchObject({ bucket: 'review', action: { kind: 'review' } });
    const spam = workflow([request('2026-10-11T21:07:00Z')], { hasTitle: false, info: info({ total: 0, firstAsk: null }) });
    expect(spam).toMatchObject({ bucket: 'review', likelySpam: true, action: { kind: 'intro_text' } });
    // A fresh untitled lead is still worked normally.
    expect(workflow([lead], { hasTitle: false, info: info({ total: 0, firstAsk: null }) }).bucket).toBe('do_now');
  });
});

describe('shortAsk', () => {
  it('names the ask in a few words', () => {
    expect(shortAsk('Can you send a few photos of the lower level?')).toBe('photos');
    expect(shortAsk('When can we come by to check the ceiling height?')).toBe('a site visit');
    expect(shortAsk('Can you send the room measurements?')).toBe('measurements');
    expect(shortAsk('Which door is it, front or back?')).toBe('which door is it, front');
  });
});
