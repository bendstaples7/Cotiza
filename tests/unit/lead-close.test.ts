import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactEvent, LeadClosure } from '../../worker/src/services/lead-contact-service.js';
import { addMonths, validateClose, validateNextContactDate } from '../../worker/src/services/lead-contact-service.js';
import { computeLeadWorkflow } from '../../worker/src/services/lead-workflow.js';
import { applyClosuresToOpenLeads, closureListed } from '../../worker/src/services/lead-closures.js';
import { archiveShape, resetArchiveShapeCache, setRequestArchived } from '../../worker/src/services/jobber-request-archive.js';
import { formatJobberNote } from '../../worker/src/services/jobber-request-notes.js';

// Wed Nov 4 2026, 10:00 in Chicago.
const NOW = Date.parse('2026-11-04T16:00:00Z');
const closure = (over: Partial<LeadClosure> = {}): LeadClosure => ({ reason: 'went_elsewhere', label: 'Went with someone else', note: null, checkBackOn: null, closedAt: '2026-11-04T15:00:00Z', jobberArchived: false, ...over });

describe('validateClose', () => {
  it('needs a known reason; Other needs a note', () => {
    expect(() => validateClose({}, NOW)).toThrow('reason must be one of');
    expect(() => validateClose({ reason: 'other' }, NOW)).toThrow('short note');
    expect(validateClose({ reason: 'other', note: '  moved   away ' }, NOW)).toEqual({ reason: 'other', note: 'moved away', checkBackOn: null });
  });

  it('postponed defaults to a check-back 3 months out and refuses past dates', () => {
    expect(validateClose({ reason: 'postponed' }, NOW).checkBackOn).toBe('2027-02-04');
    expect(validateClose({ reason: 'postponed', checkBackOn: '2026-12-01' }, NOW).checkBackOn).toBe('2026-12-01');
    expect(() => validateClose({ reason: 'postponed', checkBackOn: '2026-11-04' }, NOW)).toThrow('after today');
    expect(() => validateClose({ reason: 'no_response', checkBackOn: '2026-12-01' }, NOW)).toThrow('Only a postponed lead');
  });

  it('refuses reasons that are not its own, and impossible dates', () => {
    expect(() => validateClose({ reason: 'toString' }, NOW)).toThrow('reason must be one of');
    expect(() => validateClose({ reason: 'postponed', checkBackOn: '2027-02-31' }, NOW)).toThrow('YYYY-MM-DD');
    expect(() => validateNextContactDate('2026-11-31')).toThrow('YYYY-MM-DD');
    expect(validateNextContactDate('2026-11-30')).toBe('2026-11-30');
  });

  it('keeps contact details out of the note', () => {
    expect(() => validateClose({ reason: 'other', note: 'call 773-555-0100' }, NOW)).toThrow('phone number or email');
  });

  it('adds months without spilling into the next month', () => {
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });
});

describe('the workflow for a closed lead', () => {
  const lead: ContactEvent = { at: '2026-10-01T14:00:00Z', channel: 'request', direction: 'incoming', source: 'jobber', label: 'Request came in' };
  const run = (closed: LeadClosure | null) => computeLeadWorkflow({
    events: [lead], nextSet: null, info: { readyToQuote: false, total: 0, firstAsk: null }, hasTitle: true, notALead: false, closed, now: NOW,
  });

  it('a closed lead leaves Do now / Waiting / Review, with nothing due and no cadence rows', () => {
    expect(run(closure())).toMatchObject({ bucket: 'closed', stage: 'Closed · Went with someone else', action: { kind: 'none', label: 'Lead closed' }, next: { overdue: false, dueToday: false }, plan: [] });
  });

  it('a lead marked not a lead stays in Review even when a postponed closure is due', () => {
    const w = computeLeadWorkflow({
      events: [lead], nextSet: null, info: { readyToQuote: false, total: 0, firstAsk: null }, hasTitle: true, notALead: true,
      closed: closure({ reason: 'postponed', label: 'Postponed', checkBackOn: '2026-11-01' }), now: NOW,
    });
    expect(w).toMatchObject({ bucket: 'review', action: { kind: 'review' } });
  });

  it('a postponed lead waits until its check-back date, then returns as "Check back in"', () => {
    expect(run(closure({ reason: 'postponed', label: 'Postponed', checkBackOn: '2027-02-04' }))).toMatchObject({ bucket: 'closed', stage: 'Postponed → back on Thu, Feb 4' });
    expect(run(closure({ reason: 'postponed', label: 'Postponed', checkBackOn: '2026-11-04' }))).toMatchObject({
      bucket: 'do_now', stage: 'Postponed → every 3 months',
      next: { on: '2026-11-04', dueToday: true },
      action: { kind: 'check_back', label: 'Check back in', step: 'check_back' },
      plan: [{ label: 'Wed, Nov 4 · Check back in', state: 'due' }],
    });
  });
});

describe('closed leads in the open-lead list', () => {
  it('lists a closed lead only when it is postponed and due', () => {
    expect(closureListed(undefined, '2026-11-04')).toBe(true);
    expect(closureListed(closure(), '2026-11-04')).toBe(false);
    expect(closureListed(closure({ reason: 'postponed', checkBackOn: '2026-12-01' }), '2026-11-04')).toBe(false);
    expect(closureListed(closure({ reason: 'postponed', checkBackOn: '2026-11-04' }), '2026-11-04')).toBe(true);
  });

  const db = (rows: Array<{ jobber_request_id: string; closed_reason: string; check_back_on: string | null }>) => ({
    prepare: () => ({ bind: () => ({}), all: async () => ({ results: rows.map((r) => ({ closed_note: null, closed_at: '2026-08-01T00:00:00Z', jobber_archived: 0, ...r })) }) }),
  }) as unknown as D1Database;

  it('drops closed leads and brings back due postponed ones from outside the window', async () => {
    const graphqlRequest = vi.fn(async (_q: string, vars: { id: string }) => ({ request: { id: vars.id, title: 'Basement', requestStatus: 'new', createdAt: '2026-07-01T00:00:00Z' } }));
    const open = [{ id: 'A', createdAt: '2026-11-01T00:00:00Z' }, { id: 'B', createdAt: '2026-11-02T00:00:00Z' }];
    const result = await applyClosuresToOpenLeads(db([
      { jobber_request_id: 'A', closed_reason: 'no_response', check_back_on: null },
      { jobber_request_id: 'OLD', closed_reason: 'postponed', check_back_on: '2026-11-01' },
      { jobber_request_id: 'LATER', closed_reason: 'postponed', check_back_on: '2027-01-01' },
    ]), { graphqlRequest }, open, NOW);
    expect(result.open.map((n) => n.id)).toEqual(['B', 'OLD']);
    expect(result.postponedUnavailable).toBe(false);
    expect(graphqlRequest).toHaveBeenCalledTimes(1);
  });

  it('flags a due postponed lead that could not be read, instead of dropping it silently', async () => {
    const graphqlRequest = vi.fn(async () => { throw new Error('Jobber 502'); });
    const result = await applyClosuresToOpenLeads(db([{ jobber_request_id: 'OLD', closed_reason: 'postponed', check_back_on: '2026-11-01' }]), { graphqlRequest }, [], NOW);
    expect(result).toMatchObject({ open: [], postponedUnavailable: true });
  });

  it('shows everything, and says so, when closures cannot be read', async () => {
    const broken = { prepare: () => { throw new Error('D1 down'); } } as unknown as D1Database;
    const result = await applyClosuresToOpenLeads(broken, { graphqlRequest: vi.fn() }, [{ id: 'A' }], NOW);
    expect(result).toEqual({ open: [{ id: 'A' }], closuresUnavailable: true, postponedUnavailable: false });
  });
});

describe('archiving the Jobber request', () => {
  beforeEach(() => resetArchiveShapeCache());
  const nn = (inner: object) => ({ kind: 'NON_NULL', name: null, ofType: inner });
  const id = nn({ kind: 'SCALAR', name: 'EncodedId', ofType: null });
  const payload = nn({ kind: 'OBJECT', name: 'RequestArchivePayload', ofType: null });

  it('uses requestArchive only when it takes just the request id', () => {
    expect(archiveShape([], [], 'archive')).toBeNull();
    expect(archiveShape([{ name: 'requestArchive', args: [{ name: 'requestId', type: id }], type: payload }] as never, [{ name: 'userErrors', type: id }] as never, 'archive'))
      .toEqual({ mutation: 'requestArchive', idArg: 'requestId', idType: 'EncodedId!', hasUserErrors: true });
    expect(archiveShape([{ name: 'requestArchive', args: [{ name: 'requestId', type: id }, { name: 'reason', type: id }], type: payload }] as never, [], 'archive')).toBeNull();
  });

  it('reports "not offered" when Jobber has no archive mutation, and sends nothing', async () => {
    const graphqlRequest = vi.fn(async () => ({ __schema: { mutationType: { fields: [] } } }));
    const result = await setRequestArchived({ graphqlRequest }, 'R1', true);
    expect(result).toMatchObject({ status: 'not_offered', message: expect.stringContaining('Archive this request in Jobber') });
    expect(graphqlRequest).toHaveBeenCalledTimes(1);
  });

  it('archives when offered and reports Jobber errors as failed', async () => {
    const fields = [{ name: 'requestArchive', args: [{ name: 'requestId', type: id }], type: payload }];
    const answers = (mutationResult: object) => vi.fn(async (q: string) => (
      q.includes('CotizaArchiveMutations') ? { __schema: { mutationType: { fields } } }
        : q.includes('CotizaArchivePayload') ? { payload: { fields: [{ name: 'userErrors' }] } }
          : { requestArchive: mutationResult }
    ));
    expect(await setRequestArchived({ graphqlRequest: answers({ userErrors: [] }) }, 'R1', true)).toEqual({ status: 'archived' });
    expect(await setRequestArchived({ graphqlRequest: answers({ userErrors: [{ message: 'Has an open quote' }] }) }, 'R1', true)).toEqual({ status: 'failed', message: 'Has an open quote' });
  });

  it('unarchives with requestUnarchive, or says to do it in Jobber when not offered', async () => {
    expect(archiveShape([{ name: 'requestUnarchive', args: [{ name: 'requestId', type: id }], type: payload }] as never, [], 'unarchive')).toMatchObject({ mutation: 'requestUnarchive' });
    expect(archiveShape([{ name: 'requestArchive', args: [{ name: 'requestId', type: id }], type: payload }] as never, [], 'unarchive')).toBeNull();
    const fields = [{ name: 'requestUnarchive', args: [{ name: 'requestId', type: id }], type: payload }];
    const graphqlRequest = vi.fn(async (q: string) => (
      q.includes('CotizaArchiveMutations') ? { __schema: { mutationType: { fields } } }
        : q.includes('CotizaArchivePayload') ? { payload: { fields: [] } }
          : { requestUnarchive: { __typename: 'X' } }
    ));
    expect(await setRequestArchived({ graphqlRequest }, 'R1', false)).toEqual({ status: 'unarchived' });
    expect(graphqlRequest.mock.calls.at(-1)?.[0]).toContain('requestUnarchive(requestId: $id)');
    resetArchiveShapeCache();
    const none = await setRequestArchived({ graphqlRequest: vi.fn(async () => ({ __schema: { mutationType: { fields: [] } } })) }, 'R1', false);
    expect(none).toMatchObject({ status: 'not_offered', message: expect.stringContaining('Unarchive this request in Jobber') });
  });

  it('remembers the schema answer instead of introspecting on every close', async () => {
    const graphqlRequest = vi.fn(async () => ({ __schema: { mutationType: { fields: [] } } }));
    await setRequestArchived({ graphqlRequest }, 'R1', true);
    await setRequestArchived({ graphqlRequest }, 'R2', true);
    expect(graphqlRequest).toHaveBeenCalledTimes(1);
  });
});

describe('the Jobber note for a closed lead', () => {
  it('says who closed it and why', () => {
    expect(formatJobberNote({ kind: 'lead_closed', reason: 'Postponed', checkBackOn: '2027-02-04', note: 'after the holidays' }, 'Denzel'))
      .toBe('Cotiza · Lead closed by Denzel — Postponed · check back 2027-02-04: after the holidays');
    expect(formatJobberNote({ kind: 'lead_closed', reason: 'No response' }, 'Denzel')).toBe('Cotiza · Lead closed by Denzel — No response');
  });
});
