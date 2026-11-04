import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  formatJobberNote,
  isCotizaNote,
  JobberNoteWriter,
  noteKey,
  noteMutationText,
  noteShape,
  pickNoteMutation,
  resetNoteShapeCache,
  stepLabel,
  NoteSchemaMismatch,
} from '../../worker/src/services/jobber-request-notes.js';
import { requestEvents } from '../../worker/src/services/lead-contact-status.js';

const REQ = 'Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMzU3NTQyMjI=';

// ── Introspection fixtures ───────────────────────────────────────────────────
const nn = (inner: object) => ({ kind: 'NON_NULL', name: null, ofType: inner });
const scalar = (name: string) => ({ kind: 'SCALAR', name, ofType: null });
const input = (name: string) => ({ kind: 'INPUT_OBJECT', name, ofType: null });
const object = (name: string) => ({ kind: 'OBJECT', name, ofType: null });

const requestCreateNote = {
  name: 'requestCreateNote',
  args: [{ name: 'requestId', type: nn(scalar('EncodedId')) }, { name: 'input', type: nn(input('RequestCreateNoteInput')) }],
  type: nn(object('RequestCreateNotePayload')),
};
const clientCreateNote = {
  name: 'clientCreateNote',
  args: [{ name: 'clientId', type: nn(scalar('EncodedId')) }, { name: 'input', type: nn(input('ClientCreateNoteInput')) }],
  type: nn(object('ClientCreateNotePayload')),
};
const inputFields = [{ name: 'message', type: nn(scalar('String')) }, { name: 'attachments', type: { kind: 'LIST', name: null, ofType: input('X') } }];
const userErrors = { name: 'userErrors', type: nn({ kind: 'LIST', name: null, ofType: object('UserError') }) };
const payloadFields = [{ name: 'requestNote', type: object('RequestNote') }, userErrors];
const clientPayloadFields = [{ name: 'clientNote', type: object('ClientNote') }, userErrors];

/** A Jobber client that answers introspection and records mutations. */
function fakeJobber(opts: { mutations?: object[]; fail?: 'reject' | 'network'; existingNotes?: string[]; requestInputFields?: object[] } = {}) {
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  const graphqlRequest = vi.fn(async (query: string, variables?: Record<string, unknown>) => {
    calls.push({ query, variables });
    if (query.includes('CotizaNoteMutations')) return { __schema: { mutationType: { fields: opts.mutations ?? [requestCreateNote, clientCreateNote] } } };
    if (query.includes('CotizaNoteTypes')) {
      const isClient = variables?.payload === 'ClientCreateNotePayload';
      return { input: { inputFields: isClient ? inputFields : opts.requestInputFields ?? inputFields }, payload: { fields: isClient ? clientPayloadFields : payloadFields } };
    }
    if (query.includes('CotizaRecentClientNotes')) return { request: { client: { notes: { edges: (opts.existingNotes ?? []).map((m, i) => ({ node: { id: `CN${i}`, message: m } })) } } } };
    if (query.includes('CotizaRecentNotes')) return { request: { notes: { edges: (opts.existingNotes ?? []).map((m, i) => ({ node: { id: `N${i}`, message: m } })) } } };
    if (query.includes('CotizaRequestClient')) return { request: { id: REQ, client: { id: 'C1' } } };
    if (query.includes('CotizaAddNote')) {
      if (opts.fail === 'network') throw new Error('Jobber API error (502): bad gateway');
      if (opts.fail === 'reject') return { requestCreateNote: { requestNote: null, userErrors: [{ message: 'Message is too long' }] } };
      // Answer only with the fields the mutation actually selected, as Jobber would.
      if (query.includes('requestCreateNote')) return { requestCreateNote: { ...(query.includes('requestNote { id }') ? { requestNote: { id: 'NOTE1' } } : {}), userErrors: [] } };
      return { clientCreateNote: { ...(query.includes('clientNote { id }') ? { clientNote: { id: 'CNOTE1' } } : {}), userErrors: [] } };
    }
    throw new Error(`unexpected query ${query.slice(0, 40)}`);
  });
  return { client: { graphqlRequest }, calls, mutationCalls: () => calls.filter((c) => c.query.includes('CotizaAddNote')) };
}

/** Enough of D1 for lead_jobber_notes. */
function fakeDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async run() {
          if (sql.startsWith('INSERT OR IGNORE INTO lead_jobber_notes')) {
            const [id, req, message, created, updated, user] = args as string[];
            if (!rows.has(id)) rows.set(id, { id, jobber_request_id: req, message, status: 'pending', jobber_note_id: null, error: null, uncertain: 0, attempts: 0, created_at: created, updated_at: updated, created_by_user_id: user });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE lead_jobber_notes SET uncertain = CASE')) {
            const [token, at, id, staleBefore] = args as string[];
            const row = rows.get(id);
            const claimable = row && (row.status === 'pending' || row.status === 'failed' || (row.status === 'posting' && String(row.updated_at) < staleBefore));
            if (!claimable) return { meta: { changes: 0 } };
            Object.assign(row!, { uncertain: row!.status === 'posting' ? 1 : row!.uncertain, status: 'posting', attempts: Number(row!.attempts) + 1, claim_token: token, updated_at: at });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE lead_jobber_notes SET status = ?')) {
            const [status, noteId, error, uncertain, at, id, token] = args as [string, string | null, string | null, number, string, string, string];
            const row = rows.get(id)!;
            if (row.claim_token !== token) return { meta: { changes: 0 } };
            Object.assign(row, { status, jobber_note_id: noteId, error, uncertain, claim_token: null, updated_at: at });
            return { meta: { changes: 1 } };
          }
          throw new Error(`unexpected run ${sql}`);
        },
        async first() {
          if (sql.startsWith('SELECT * FROM lead_jobber_notes WHERE id')) return rows.get(args[0] as string) ?? null;
          throw new Error(`unexpected first ${sql}`);
        },
        async all() {
          const req = args[0];
          return { results: [...rows.values()].filter((r) => r.jobber_request_id === req && r.status !== 'posted') };
        },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, rows };
}

beforeEach(() => resetNoteShapeCache());

describe('formatJobberNote', () => {
  it('writes short plain notes that start with the Cotiza prefix', () => {
    expect(formatJobberNote({ kind: 'text_quo', text: 'Hi Bryan, could you text a few photos?' }, 'Denzel')).toBe('Cotiza · Text sent via Quo by Denzel — Hi Bryan, could you text a few photos?');
    expect(formatJobberNote({ kind: 'contact', channel: 'call', direction: 'outgoing', note: 'Left a voicemail' }, 'Garlien')).toBe('Cotiza · Call logged by Garlien — Left a voicemail');
    expect(formatJobberNote({ kind: 'contact', channel: 'text', direction: 'outgoing', note: null, stepLabel: stepLabel('intro_text') }, 'Denzel')).toBe('Cotiza · Text logged (Intro text) by Denzel');
    expect(formatJobberNote({ kind: 'contact', channel: 'other', direction: 'outgoing', note: null, stepLabel: stepLabel('draft_quote') }, 'Denzel')).toBe('Cotiza · Quote drafting marked done by Denzel');
    expect(formatJobberNote({ kind: 'not_a_lead' }, 'Denzel')).toBe('Cotiza · Marked not a lead by Denzel');
    expect(formatJobberNote({ kind: 'not_a_lead' }, '')).toBe('Cotiza · Marked not a lead by the team');
  });

  it('redacts international and local numbers too, but keeps short numbers', () => {
    const note = formatJobberNote({ kind: 'contact', channel: 'call', direction: 'outgoing', note: 'Called +44 20 7946 0958 and 555-0100, quote for 3 windows, 12 ft' }, 'Denzel');
    expect(note).not.toMatch(/7946|555-0100/);
    expect(note).toContain('3 windows, 12 ft');
  });

  it('keeps contact details out and cuts long text', () => {
    const note = formatJobberNote({ kind: 'text_quo', text: `Call us at 224-433-7953 or email office@chicago-reno.com ${'x'.repeat(300)}` }, 'Denzel');
    expect(note).not.toMatch(/224-433-7953|office@chicago-reno\.com/);
    expect(note).toContain('[contact]');
    expect(note.length).toBeLessThan(220);
    expect(note.endsWith('…')).toBe(true);
  });

  it('recognises its own notes', () => {
    expect(isCotizaNote('Cotiza · Call logged by Denzel')).toBe(true);
    expect(isCotizaNote('  Cotiza · Text sent via Quo')).toBe(true);
    expect(isCotizaNote('CHRIS EMAILED: yes we own')).toBe(false);
  });
});

describe('note mutation from the live schema', () => {
  it('prefers requestCreateNote and falls back to clientCreateNote', () => {
    expect(pickNoteMutation([clientCreateNote, requestCreateNote] as never).target).toBe('request');
    expect(pickNoteMutation([clientCreateNote] as never).target).toBe('client');
    expect(() => pickNoteMutation([] as never)).toThrow(NoteSchemaMismatch);
  });

  it('builds the mutation from the argument and payload shapes', () => {
    const shape = noteShape(requestCreateNote as never, 'request', inputFields as never, payloadFields as never);
    expect(shape).toMatchObject({ idArg: 'requestId', idType: 'EncodedId!', inputArg: 'input', inputType: 'RequestCreateNoteInput!', noteField: 'requestNote', hasUserErrors: true });
    expect(noteMutationText(shape)).toContain('requestCreateNote(requestId: $id, input: $input) { requestNote { id } userErrors { message } }');
  });

  it('refuses a schema it cannot fill', () => {
    expect(() => noteShape(requestCreateNote as never, 'request', [{ name: 'body', type: nn(scalar('String')) }] as never, payloadFields as never)).toThrow('no text message field');
    expect(() => noteShape(requestCreateNote as never, 'request', [...inputFields, { name: 'linkedTo', type: nn(scalar('ID')) }] as never, payloadFields as never)).toThrow('requires linkedTo');
  });
});

describe('JobberNoteWriter', () => {
  it('posts once, and a repeat of the same action never posts again', async () => {
    const { db, rows } = fakeDb();
    const jobber = fakeJobber();
    const log = vi.fn().mockResolvedValue(undefined);
    const writer = new JobberNoteWriter({ db, jobber: jobber.client, log });
    const id = noteKey('contact', 'lct_1');
    const first = await writer.write(id, REQ, 'Cotiza · Call logged by Denzel', 'user-a');
    expect(first).toMatchObject({ status: 'posted', jobberNoteId: 'NOTE1' });
    const again = await writer.write(id, REQ, 'Cotiza · Call logged by Denzel', 'user-a');
    expect(again.status).toBe('posted');
    const retried = await writer.retry(id, 'user-a');
    expect(retried?.status).toBe('posted');
    expect(jobber.mutationCalls()).toHaveLength(1);
    expect(jobber.mutationCalls()[0].variables).toEqual({ id: REQ, input: { message: 'Cotiza · Call logged by Denzel' } });
    expect(rows.get(id)?.attempts).toBe(1);
    expect(log).toHaveBeenCalledWith('jobber_note', expect.stringContaining('outcome=posted'), 'info');
  });

  it('leaves a note being written by another request alone', async () => {
    const { db, rows } = fakeDb();
    const jobber = fakeJobber();
    let now = Date.parse('2026-11-04T18:00:00Z');
    const writer = new JobberNoteWriter({ db, jobber: jobber.client, now: () => now });
    const id = noteKey('contact', 'lct_2');
    rows.set(id, { id, jobber_request_id: REQ, message: 'm', status: 'posting', jobber_note_id: null, error: null, uncertain: 0, attempts: 1, created_at: '2026-11-04T18:00:00.000Z', updated_at: '2026-11-04T18:00:00.000Z', created_by_user_id: 'u' });
    expect((await writer.retry(id, 'u'))?.status).toBe('posting');
    expect(jobber.mutationCalls()).toHaveLength(0);
    // A claim abandoned for minutes may be taken over, but that write may have landed: Jobber is checked first.
    now += 5 * 60_000;
    expect((await writer.retry(id, 'u'))?.status).toBe('posted');
    expect(jobber.calls.some((c) => c.query.includes('CotizaRecentNotes'))).toBe(true);
  });

  it('reports a rejected note as failed, keeps the action, and retries cleanly', async () => {
    const { db } = fakeDb();
    const rejecting = fakeJobber({ fail: 'reject' });
    const log = vi.fn().mockResolvedValue(undefined);
    const id = noteKey('mark', `${REQ}:1`);
    const failed = await new JobberNoteWriter({ db, jobber: rejecting.client, log }).write(id, REQ, 'Cotiza · Marked not a lead by Denzel', 'u');
    expect(failed).toMatchObject({ status: 'failed', error: 'Message is too long', uncertain: false });
    expect(log).toHaveBeenCalledWith('jobber_note', expect.stringContaining('outcome=failed'), 'error');
    const ok = fakeJobber();
    const retried = await new JobberNoteWriter({ db, jobber: ok.client }).retry(id, 'u');
    expect(retried?.status).toBe('posted');
    // A rejected write left nothing in Jobber, so the retry does not look for it first.
    expect(ok.calls.some((c) => c.query.includes('CotizaRecentNotes'))).toBe(false);
  });

  it('after an unconfirmed write, checks Jobber before posting again', async () => {
    const { db } = fakeDb();
    const id = noteKey('contact', 'lct_3');
    const message = 'Cotiza · Text sent via Quo by Denzel — Hi';
    const lost = await new JobberNoteWriter({ db, jobber: fakeJobber({ fail: 'network' }).client }).write(id, REQ, message, 'u');
    expect(lost).toMatchObject({ status: 'failed', uncertain: true, error: 'Jobber did not confirm the note.' });
    // The note did land: the retry finds it and does not post a second one.
    const landed = fakeJobber({ existingNotes: [message] });
    const retried = await new JobberNoteWriter({ db, jobber: landed.client }).retry(id, 'u');
    expect(retried).toMatchObject({ status: 'posted', jobberNoteId: 'N0' });
    expect(landed.mutationCalls()).toHaveLength(0);
  });

  it('fails plainly when Jobber is not connected', async () => {
    const { db } = fakeDb();
    const note = await new JobberNoteWriter({ db, jobber: null }).write(noteKey('contact', 'lct_4'), REQ, 'm', 'u');
    expect(note).toMatchObject({ status: 'failed', error: 'Jobber is not connected.' });
  });

  it('falls back to a client note when Jobber has no request note mutation', async () => {
    const { db } = fakeDb();
    const jobber = fakeJobber({ mutations: [clientCreateNote] });
    const note = await new JobberNoteWriter({ db, jobber: jobber.client }).write(noteKey('contact', 'lct_5'), REQ, 'm', 'u');
    expect(note).toMatchObject({ status: 'posted', jobberNoteId: 'CNOTE1' });
    expect(jobber.mutationCalls()[0].query).toContain('clientCreateNote(clientId: $id, input: $input) { clientNote { id } userErrors { message } }');
    expect(jobber.mutationCalls()[0].variables).toEqual({ id: 'C1', input: { message: 'm' } });
  });

  it('falls back to a client note when the request note needs fields Cotiza cannot fill', async () => {
    const { db } = fakeDb();
    const jobber = fakeJobber({ requestInputFields: [...inputFields, { name: 'linkedTo', type: nn(scalar('ID')) }] });
    const note = await new JobberNoteWriter({ db, jobber: jobber.client }).write(noteKey('contact', 'lct_6'), REQ, 'm', 'u');
    expect(note).toMatchObject({ status: 'posted', jobberNoteId: 'CNOTE1' });
    expect(jobber.mutationCalls()[0].query).toContain('clientCreateNote');
  });

  it('with client notes, a lost write is looked for on the client before posting again', async () => {
    const { db } = fakeDb();
    const id = noteKey('contact', 'lct_8');
    await new JobberNoteWriter({ db, jobber: fakeJobber({ mutations: [clientCreateNote], fail: 'network' }).client }).write(id, REQ, 'm', 'u');
    const landed = fakeJobber({ mutations: [clientCreateNote], existingNotes: ['m'] });
    const retried = await new JobberNoteWriter({ db, jobber: landed.client }).retry(id, 'u');
    expect(retried).toMatchObject({ status: 'posted', jobberNoteId: 'CN0' });
    expect(landed.mutationCalls()).toHaveLength(0);
  });

  it('an attempt that lost its claim cannot overwrite the outcome', async () => {
    const { db, rows } = fakeDb();
    const id = noteKey('contact', 'lct_7');
    const writer = new JobberNoteWriter({ db, jobber: fakeJobber().client });
    await writer.write(id, REQ, 'm', 'u');
    // Someone else's token now holds the row: a late finish from an old attempt changes nothing.
    rows.get(id)!.claim_token = 'other';
    const stmt = db.prepare('UPDATE lead_jobber_notes SET status = ?').bind('failed', null, 'late', 0, 'x', id, 'old-token');
    expect((await stmt.run()).meta.changes).toBe(0);
    expect(rows.get(id)!.status).toBe('posted');
  });
});

describe('the lead workflow skips Cotiza notes', () => {
  it('does not count a Cotiza note as another touch', () => {
    const events = requestEvents({
      notes: [
        { message: 'Cotiza · Call logged by Denzel — no answer, left vm', createdAt: '2026-11-03T15:00:00Z', createdBy: 'team' },
        { message: 'No answer. Left vm.', createdAt: '2026-11-02T15:00:00Z', createdBy: 'team' },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ at: '2026-11-02T15:00:00Z', outreach: true });
  });
});
