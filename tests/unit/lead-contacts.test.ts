import { describe, expect, it, vi } from 'vitest';
import {
  addBusinessDays,
  chicagoDate,
  computeContactStatus,
  LeadContactError,
  LeadContactService,
  suggestNextContact,
  validateContact,
  type ContactEvent,
} from '../../worker/src/services/lead-contact-service.js';
import { gatherContactStatus, requestEvents } from '../../worker/src/services/lead-contact-status.js';

const REQ = 'Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMzU3NTY4NzI=';
// Wed Nov 4 2026, 10:00 in Chicago.
const NOW = Date.parse('2026-11-04T16:00:00Z');

const out = (at: string, channel: ContactEvent['channel'] = 'text'): ContactEvent => ({ at, channel, direction: 'outgoing', source: 'quo', label: 'Text sent' });
const inc = (at: string, channel: ContactEvent['channel'] = 'text'): ContactEvent => ({ at, channel, direction: 'incoming', source: 'quo', label: 'Text from customer' });
const request = (at: string): ContactEvent => ({ at, channel: 'request', direction: 'incoming', source: 'jobber', label: 'Request came in' });

/** In-memory D1 for exactly the statements LeadContactService runs. */
function fakeD1() {
  const contacts: Array<Record<string, unknown>> = [];
  const followups = new Map<string, Record<string, unknown>>();
  const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  const d1 = {
    prepare(raw: string) {
      const sql = norm(raw);
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async all() {
          if (sql === 'SELECT * FROM lead_contacts WHERE jobber_request_id = ? ORDER BY contacted_at DESC LIMIT 50') {
            return { results: contacts.filter((r) => r.jobber_request_id === args[0]).sort((a, b) => String(b.contacted_at).localeCompare(String(a.contacted_at))) };
          }
          throw new Error(`unexpected all(): ${sql}`);
        },
        async first() {
          if (sql === 'SELECT next_contact_on FROM lead_followups WHERE jobber_request_id = ?') return followups.get(args[0] as string) ?? null;
          throw new Error(`unexpected first(): ${sql}`);
        },
        async run() {
          if (sql.startsWith('INSERT INTO lead_contacts')) {
            const [id, jobber_request_id, channel, direction, note, step, contacted_at, created_at, created_by_user_id] = args;
            contacts.push({ id, jobber_request_id, channel, direction, note, step, contacted_at, created_at, created_by_user_id });
            return { success: true };
          }
          if (sql.startsWith('INSERT INTO lead_followups')) {
            followups.set(args[0] as string, { next_contact_on: args[1] });
            return { success: true };
          }
          if (sql === 'DELETE FROM lead_followups WHERE jobber_request_id = ?') {
            followups.delete(args[0] as string);
            return { success: true };
          }
          throw new Error(`unexpected run(): ${sql}`);
        },
      };
      return stmt;
    },
  };
  return { d1: d1 as unknown as D1Database, contacts };
}

describe('dates', () => {
  it('uses Chicago calendar days and skips weekends', () => {
    expect(chicagoDate(Date.parse('2026-11-05T03:00:00Z'))).toBe('2026-11-04');
    expect(addBusinessDays('2026-11-06', 1)).toBe('2026-11-09'); // Fri + 1 -> Mon
    expect(addBusinessDays('2026-11-04', 2)).toBe('2026-11-06');
    expect(addBusinessDays('2026-11-05', 4)).toBe('2026-11-11');
  });
});

describe('suggestNextContact', () => {
  it('is today when nobody has reached out yet', () => {
    expect(suggestNextContact([request('2026-11-02T12:00:00Z')], NOW)).toEqual({ on: '2026-11-04', reason: 'No outreach yet' });
    expect(suggestNextContact([], NOW).on).toBe('2026-11-04');
  });

  it('is today when the customer spoke last', () => {
    const s = suggestNextContact([out('2026-11-02T15:00:00Z'), inc('2026-11-03T15:00:00Z')], NOW);
    expect(s).toEqual({ on: '2026-11-04', reason: 'Customer replied; get back to them' });
  });

  it('steps 1, 2, then 4 business days after unanswered outreach, ignoring team notes', () => {
    const base = [request('2026-11-02T12:00:00Z')];
    expect(suggestNextContact([...base, out('2026-11-02T15:00:00Z')], NOW).on).toBe('2026-11-03');
    expect(suggestNextContact([...base, out('2026-11-02T15:00:00Z'), out('2026-11-03T15:00:00Z', 'call')], NOW).on).toBe('2026-11-05');
    const three = [...base, out('2026-11-02T15:00:00Z'), out('2026-11-03T15:00:00Z'), out('2026-11-05T15:00:00Z', 'email')];
    expect(suggestNextContact(three, NOW)).toEqual({ on: '2026-11-11', reason: 'No reply after 3 attempts; follow up' });
    const note: ContactEvent = { at: '2026-11-04T15:00:00Z', channel: 'note', direction: 'outgoing', source: 'jobber', label: 'Team note in Jobber' };
    expect(suggestNextContact([...base, out('2026-11-02T15:00:00Z'), note], NOW).on).toBe('2026-11-03');
  });
});

describe('computeContactStatus', () => {
  it('reports the newest event, overdue and set dates', () => {
    const events = [request('2026-11-01T12:00:00Z'), out('2026-11-02T15:00:00Z')];
    const status = computeContactStatus(events, null, [], NOW);
    expect(status.last?.label).toBe('Text sent');
    expect(status.next).toMatchObject({ on: '2026-11-03', source: 'suggested', overdue: true, dueToday: false });
    const set = computeContactStatus(events, '2026-11-04', ['gmail'], NOW, ['quo']);
    expect(set.next).toMatchObject({ on: '2026-11-04', source: 'set', overdue: false, dueToday: true, reason: 'Set by the team' });
    expect(set.unavailable).toEqual(['gmail']);
    expect(set.notConnected).toEqual(['quo']);
  });
});

describe('validateContact', () => {
  it('accepts a logged contact and rejects bad input', () => {
    expect(validateContact({ channel: 'call', note: ' left voicemail ' }, NOW)).toMatchObject({ channel: 'call', direction: 'outgoing', note: 'left voicemail', step: null, contactedAt: new Date(NOW).toISOString() });
    expect(() => validateContact({ channel: 'fax' }, NOW)).toThrow(LeadContactError);
    expect(() => validateContact({ channel: 'call', direction: 'sideways' }, NOW)).toThrow('direction');
    expect(() => validateContact({ channel: 'call', note: 'call 773-555-0100' }, NOW)).toThrow('contact details');
    expect(() => validateContact({ channel: 'call', contactedAt: '2026-12-01T00:00:00Z' }, NOW)).toThrow('future');
    expect(() => validateContact({ channel: 'call', step: 'Bad Step!' }, NOW)).toThrow('step');
    expect(() => validateContact({ channel: 'call', extra: 1 }, NOW)).toThrow('Unknown field');
    expect(() => validateContact(null, NOW)).toThrow(LeadContactError);
  });
});

describe('LeadContactService', () => {
  it('logs contacts and sets, reads and clears the next contact date', async () => {
    const { d1 } = fakeD1();
    const service = new LeadContactService(d1);
    await service.log(REQ, { channel: 'text', step: 'intro_text' }, 'user-a', NOW - 3600_000);
    await service.log(REQ, { channel: 'call', direction: 'incoming' }, 'user-a', NOW);
    expect((await service.list(REQ)).map((c) => c.channel)).toEqual(['call', 'text']);
    expect(await service.setNextContact(REQ, '2026-11-06', 'user-a')).toBe('2026-11-06');
    expect(await service.nextContact(REQ)).toBe('2026-11-06');
    expect(await service.setNextContact(REQ, null, 'user-a')).toBeNull();
    expect(await service.nextContact(REQ)).toBeNull();
    await expect(service.setNextContact(REQ, 'Friday', 'user-a')).rejects.toThrow('YYYY-MM-DD');
  });
});

describe('gatherContactStatus', () => {
  const detail = {
    createdAt: { availability: 'present', value: '2026-11-02T23:09:37Z' },
    phone: { availability: 'present', value: '(773) 555-0100' },
    email: { availability: 'present', value: 'customer@example.com' },
    notes: [
      { message: 'CALL SUMMARY: works properly', createdAt: '2026-11-02T23:10:33Z', createdBy: 'team' },
      { message: 'Attachments', createdAt: '2026-11-02T23:09:40Z', createdBy: 'client' },
      { message: 'system', createdAt: '2026-11-02T23:09:41Z', createdBy: 'system' },
    ],
  };

  it('merges Jobber, Quo, Gmail and logged contacts without returning contact details', async () => {
    const { d1 } = fakeD1();
    const contacts = new LeadContactService(d1);
    await contacts.log(REQ, { channel: 'in_person', note: 'walked the job' }, 'user-a', Date.parse('2026-11-03T15:00:00Z'));
    const phone = { isAvailable: () => true, fetchActivityResult: vi.fn().mockResolvedValue({ status: 'ok', events: [{ at: '2026-11-04T14:00:00Z', kind: 'text', direction: 'outgoing', answered: true }] }) };
    const email = { isAvailable: () => true, fetchActivityResult: vi.fn().mockResolvedValue({ status: 'failed' }) };
    const { status } = await gatherContactStatus({ requestId: REQ, detail, requestFailed: false, contacts, phone: phone as never, email: email as never, now: NOW });
    expect(phone.fetchActivityResult).toHaveBeenCalledWith('(773) 555-0100');
    expect(status.last).toMatchObject({ label: 'Text sent', source: 'quo' });
    expect(status.unavailable).toEqual(['gmail']);
    expect(status.recent.map((e) => e.label)).toEqual(['Text sent', 'Visited', 'Team note in Jobber', 'Note from customer', 'Request came in']);
    expect(status.next).toMatchObject({ on: '2026-11-06', source: 'suggested' }); // 2 attempts: +2 business days
    expect(JSON.stringify(status)).not.toMatch(/773|example\.com/);
  });

  it('marks unconnected sources instead of treating them as empty', async () => {
    const { d1 } = fakeD1();
    const phone = { isAvailable: () => false, fetchActivityResult: vi.fn() };
    const email = { isAvailable: () => false, fetchActivityResult: vi.fn() };
    const { status } = await gatherContactStatus({ requestId: REQ, detail: null, requestFailed: true, contacts: new LeadContactService(d1), phone: phone as never, email: email as never, now: NOW });
    expect(status.notConnected).toEqual(['quo', 'gmail']);
    expect(status.unavailable).toEqual(['jobber']);
    expect(status.last).toBeNull();
    expect(phone.fetchActivityResult).not.toHaveBeenCalled();
  });

  it('shortens long team notes', () => {
    const events = requestEvents({ notes: [{ message: 'x'.repeat(400), createdAt: '2026-11-02T00:00:00Z', createdBy: 'team' }] });
    expect(events[0].note).toHaveLength(140);
  });
});
