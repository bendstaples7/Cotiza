import { describe, expect, it } from 'vitest';
import type { Bindings } from '../../worker/src/bindings.js';
import { ensureLeadChecklist, videoQuestion } from '../../worker/src/services/lead-checklist.js';
import { CHECKLIST_TEMPLATES, jobTypeKey } from '../../worker/src/services/lead-checklist-templates.js';

const REQ = 'Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMzYwNzQ0NTg=';

/** In-memory D1 for the statements ensureLeadChecklist runs (mirrors lead-info.test.ts). */
function sqliteD1() {
  type Row = Record<string, unknown>;
  const items: Row[] = [];
  const logs: Row[] = [];
  const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  const d1 = {
    prepare(rawSql: string) {
      const sql = norm(rawSql);
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async all() {
          if (sql === 'SELECT * FROM lead_info_items WHERE jobber_request_id = ? ORDER BY rowid ASC') {
            return { results: items.filter((r) => r.jobber_request_id === args[0]) };
          }
          throw new Error(`unexpected all(): ${sql}`);
        },
        async first() {
          if (sql === 'SELECT * FROM lead_info_items WHERE id = ?') return items.find((r) => r.id === args[0]) ?? null;
          throw new Error(`unexpected first(): ${sql}`);
        },
        async run() {
          if (sql.startsWith('INSERT INTO lead_info_items')) {
            const [id, jobber_request_id, question, question_key, required, created_at, updated_at, created_via, created_by_user_id, updated_by_user_id, updated_via, , max] = args;
            const sameLead = items.filter((r) => r.jobber_request_id === jobber_request_id);
            const dup = sameLead.some((r) => r.status !== 'dropped' && r.question_key === question_key);
            if (sameLead.length >= Number(max) || dup) return { success: true, meta: { changes: 0 } };
            items.push({ id, jobber_request_id, question, question_key, status: 'open', answer: null, required, created_at, updated_at, created_via, created_by_user_id, updated_by_user_id, updated_via });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE lead_info_items SET question = ?, question_key = ?, status = ?, answer = ?, updated_at = ?, updated_by_user_id = ?, updated_via = ? WHERE id = ?')) {
            const row = items.find((r) => r.id === args[7]);
            if (row) Object.assign(row, { question: args[0], question_key: args[1], status: args[2], answer: args[3], updated_at: args[4], updated_by_user_id: args[5], updated_via: args[6] });
            return { success: true, meta: { changes: row ? 1 : 0 } };
          }
          if (sql.startsWith('INSERT INTO activity_log_entries')) {
            logs.push({ operation: args[3], description: args[5] });
            return { success: true, meta: { changes: 1 } };
          }
          throw new Error(`unexpected run(): ${sql}`);
        },
      };
      return stmt;
    },
  };
  return { d1: d1 as unknown as D1Database, items: () => items, logs: () => logs };
}

const env = (db: D1Database) => ({ DB: db }) as unknown as Bindings;
const userId = 'user-a';

describe('ensureLeadChecklist', () => {
  it('seed the job type checklist once for a new lead', async () => {
    const { d1, items, logs } = sqliteD1();
    const first = await ensureLeadChecklist(env(d1), userId, REQ, { title: 'Kitchen remodel' });
    expect(first.map((i) => i.question)).toEqual(CHECKLIST_TEMPLATES.KITCHEN.map((t) => videoQuestion(t)));
    const second = await ensureLeadChecklist(env(d1), userId, REQ, { title: 'Kitchen remodel' });
    expect(second).toHaveLength(first.length);
    expect(items()).toHaveLength(first.length);
    expect(logs().map((l) => l.operation)).toEqual(['lead_checklist_seeded']);
  });

  it('answers measurement items from the photos Jobber already holds', async () => {
    const { d1 } = sqliteD1();
    const list = await ensureLeadChecklist(env(d1), userId, REQ, { title: 'Bathroom redo', photoCount: async () => 3 });
    const measured = list.find((i) => i.question === 'What are the room measurements?');
    expect(measured?.status).toBe('answered');
    expect(measured?.answer).toContain('3 photo');
  });

  it('flags a video-only item to check the video', () => {
    const video = CHECKLIST_TEMPLATES.DEFAULT.find((i) => i.videoOnly)!;
    expect(videoQuestion(video)).toBe('Check the video: Send us a walkthrough video of the space');
  });

  it('an unrelated request body leaves every question open and the lead is not ready to quote', async () => {
    const { d1 } = sqliteD1();
    const list = await ensureLeadChecklist(env(d1), userId, REQ, {
      title: 'Kitchen remodel',
      notes: 'Hi, I would like a quote for my home.\nLooking forward to hearing from you.',
      photoCount: async () => 0,
    });
    expect(list.every((i) => i.status === 'open')).toBe(true);
    expect(list.find((i) => i.question === 'What cabinets and countertops do you want?')?.status).toBe('open');
  });

  it('answers only the item whose keyword appears, with that line only', async () => {
    const { d1 } = sqliteD1();
    const list = await ensureLeadChecklist(env(d1), userId, REQ, {
      title: 'Kitchen remodel',
      notes: 'We want new cabinets.\nThe weather is nice today.',
      photoCount: async () => 0,
    });
    const cabinets = list.find((i) => i.question === 'What cabinets and countertops do you want?');
    expect(cabinets?.status).toBe('answered');
    expect(cabinets?.answer).toBe('We want new cabinets.');
    expect(list.find((i) => i.question === 'What are the room measurements?')?.status).toBe('open');
  });

  it('a second poll does not re-answer or read photos again', async () => {
    const { d1 } = sqliteD1();
    let reads = 0;
    const photoCount = async () => { reads++; return 2; };
    await ensureLeadChecklist(env(d1), userId, REQ, { title: 'Bathroom redo', photoCount });
    await ensureLeadChecklist(env(d1), userId, REQ, { title: 'Bathroom redo', photoCount });
    expect(reads).toBe(1);
  });

  it('leaves an unanswered item open when the lead sent nothing', async () => {
    const { d1 } = sqliteD1();
    const list = await ensureLeadChecklist(env(d1), userId, REQ, { title: 'Basement finish', notes: null, photoCount: async () => 0 });
    const scope = list.find((i) => i.question === 'What is being finished in the basement?');
    expect(scope?.status).toBe('open');
    expect(scope?.answer).toBeNull();
  });

  it('a lead with no known title gets the DEFAULT checklist', async () => {
    expect(jobTypeKey(null)).toBe('DEFAULT');
    expect(jobTypeKey('Fix the roof')).toBe('DEFAULT');
    const { d1 } = sqliteD1();
    const list = await ensureLeadChecklist(env(d1), userId, REQ, { title: null });
    expect(list.map((i) => i.question)).toEqual(CHECKLIST_TEMPLATES.DEFAULT.map((t) => videoQuestion(t)));
  });

  it('request 36074458 (Monica Di Stefano) shows items', async () => {
    const { d1 } = sqliteD1();
    const list = await ensureLeadChecklist(env(d1), userId, '36074458', { title: 'Monica Di Stefano bathroom' });
    expect(list.length).toBeGreaterThan(0);
  });
});
