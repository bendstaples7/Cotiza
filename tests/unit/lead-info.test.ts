import { describe, expect, it, vi } from 'vitest';
import { LeadInfoError, LeadInfoService, summarize } from '../../worker/src/services/lead-info-service.js';
import { callLeadTool, LeadToolArgsError } from '../../worker/src/services/lead-info-tools.js';
import { ManualRequestService } from '../../worker/src/services/manual-request-service.js';
import { CallBudget, type AssistantDirectory, type AssistantPrincipal } from '../../worker/src/services/assistant-access.js';
import { OpsAssistantRead } from '../../worker/src/services/ops-assistant-read.js';
import { handleMcpPost, readMcpJsonBody } from '../../worker/src/routes/ops-assistant.js';

const REQ = 'Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMzU3NDIzMDM=';
const OTHER = 'Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMQ==';

/**
 * In-memory D1 for exactly the statements LeadInfoService runs (CI's test job runs Node 20,
 * which has no node:sqlite). Any other SQL throws, so a new query can't slip past untested.
 */
function sqliteD1() {
  type Row = Record<string, unknown>;
  const table: Row[] = [];
  const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  const d1 = {
    prepare(rawSql: string) {
      const sql = norm(rawSql);
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async all() {
          if (sql === 'SELECT * FROM lead_info_items WHERE jobber_request_id = ? ORDER BY rowid ASC') {
            // ORDER BY rowid: insertion order.
            return { results: table.filter((r) => r.jobber_request_id === args[0]) };
          }
          if (sql.startsWith('SELECT * FROM lead_info_items WHERE jobber_request_id IN (')) {
            return { results: table.filter((r) => args.includes(r.jobber_request_id)) };
          }
          throw new Error(`unexpected all(): ${sql}`);
        },
        async first() {
          if (sql === 'SELECT * FROM lead_info_items WHERE id = ?') return table.find((r) => r.id === args[0]) ?? null;
          throw new Error(`unexpected first(): ${sql}`);
        },
        async run() {
          if (sql.startsWith('INSERT INTO lead_info_items')) {
            // INSERT ... SELECT ... WHERE (count) < max ON CONFLICT DO NOTHING, plus the partial unique index.
            const [id, jobber_request_id, question, required, created_at, updated_at, created_via, created_by_user_id, updated_by_user_id, updated_via, , max] = args;
            const sameLead = table.filter((r) => r.jobber_request_id === jobber_request_id);
            const dup = sameLead.some((r) => r.status !== 'dropped' && String(r.question).toLowerCase() === String(question).toLowerCase());
            if (sameLead.length >= Number(max) || dup) return { success: true, meta: { changes: 0 } };
            table.push({ id, jobber_request_id, question, status: 'open', answer: null, required, created_at, updated_at, created_via, created_by_user_id, updated_by_user_id, updated_via });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE lead_info_items SET question = ?, status = ?, answer = ?, updated_at = ?, updated_by_user_id = ?, updated_via = ? WHERE id = ?')) {
            const row = table.find((r) => r.id === args[6]);
            if (row && args[1] !== 'dropped' && table.some((r) => r !== row && r.jobber_request_id === row.jobber_request_id && r.status !== 'dropped' && String(r.question).toLowerCase() === String(args[0]).toLowerCase())) {
              throw new Error('UNIQUE constraint failed: lead_info_items.jobber_request_id, lower(question)');
            }
            if (row) Object.assign(row, { question: args[0], status: args[1], answer: args[2], updated_at: args[3], updated_by_user_id: args[4], updated_via: args[5] });
            return { success: true, meta: { changes: row ? 1 : 0 } };
          }
          throw new Error(`unexpected run(): ${sql}`);
        },
      };
      return stmt;
    },
  };
  return { d1: d1 as unknown as D1Database, rows: () => table };
}

const team = { userId: 'user-a', via: 'app' as const };

describe('LeadInfoService', () => {
  it('adds questions, ignores duplicates and reports readiness', async () => {
    const { d1 } = sqliteD1();
    const service = new LeadInfoService(d1);
    const panels = await service.add(REQ, { question: 'Who supplies the shower panels?' }, team);
    const again = await service.add(REQ, { question: '  who supplies the shower panels? ' }, team);
    expect(again.id).toBe(panels.id);
    const balance = await service.add(REQ, { question: 'When is the balance due?', required: false }, team);
    expect(summarize(await service.list(REQ))).toEqual({ total: 2, open: 2, asked: 0, answered: 0, readyToQuote: false });

    await service.update(panels.id, { status: 'asked' }, team);
    const answered = await service.update(panels.id, { answer: 'Customer buys them' }, { userId: 'user-a', via: 'assistant' });
    expect(answered).toMatchObject({ status: 'answered', answer: 'Customer buys them', updatedVia: 'assistant' });
    // The optional question doesn't hold the lead back.
    expect(summarize(await service.list(REQ)).readyToQuote).toBe(true);
    expect(balance.required).toBe(false);
  });

  it('keeps contact details out and validates input', async () => {
    const { d1, rows } = sqliteD1();
    const service = new LeadInfoService(d1);
    await expect(service.add(REQ, { question: 'Call her at 773-392-8835?' }, team)).rejects.toThrow(LeadInfoError);
    await expect(service.add(REQ, { question: 'Email keeley@example.com about tile' }, team)).rejects.toThrow('contact');
    await expect(service.add('bad id!', { question: 'Tile size?' }, team)).rejects.toThrow('requestId');
    await expect(service.add(REQ, { question: 'ok' }, team)).rejects.toThrow('question');
    expect(rows()).toHaveLength(0);
    const item = await service.add(REQ, { question: 'Tile size?' }, team);
    await expect(service.update(item.id, { status: 'answered' }, team)).rejects.toThrow('needs the answer');
    await expect(service.update(item.id, { status: 'done' }, team)).rejects.toThrow('status');
    await expect(service.update('lii_nope', { status: 'asked' }, team)).rejects.toThrow('itemId');
  });

  it('rejects empty payloads, and reopening a dropped duplicate', async () => {
    const { d1 } = sqliteD1();
    const service = new LeadInfoService(d1);
    await expect(service.add(REQ, null, team)).rejects.toThrow(LeadInfoError);
    const first = await service.add(REQ, { question: 'Tile size?' }, team);
    await expect(service.update(first.id, null, team)).rejects.toThrow(LeadInfoError);
    await service.update(first.id, { status: 'dropped' }, team);
    const second = await service.add(REQ, { question: 'Tile size?' }, team);
    expect(second.id).not.toBe(first.id);
    await expect(service.update(first.id, { status: 'open' }, team)).rejects.toThrow('already on the list');
  });

  it('stops at 30 questions per lead', async () => {
    const { d1 } = sqliteD1();
    const service = new LeadInfoService(d1);
    for (let i = 0; i < 30; i++) await service.add(REQ, { question: `Question number ${i}?` }, team);
    await expect(service.add(REQ, { question: 'One more?' }, team)).rejects.toThrow('at most 30');
  });

  it('summarizes many leads at once and omits leads without questions', async () => {
    const { d1 } = sqliteD1();
    const service = new LeadInfoService(d1);
    await service.add(REQ, { question: 'Tile size?' }, team);
    const summaries = await service.summaries([REQ, OTHER, 'bad id!']);
    expect(Object.keys(summaries)).toEqual([REQ]);
    expect(summaries[REQ]).toMatchObject({ total: 1, open: 1, readyToQuote: false });
  });
});

describe('lead connector tools', () => {
  const principal: AssistantPrincipal = { tokenId: 't', userId: 'user-a', clientId: 'claude', resource: 'http://127.0.0.1:8787/mcp', scope: 'ops:read lead:write' };

  it('adds and answers questions through set_lead_info and reads them back', async () => {
    const { d1 } = sqliteD1();
    const added = await callLeadTool(d1, principal, 'set_lead_info', { requestId: REQ, add: [{ question: 'Is the tub staying?' }, { question: 'Tile or vinyl walls?' }] }) as { items: Array<{ id: string; question: string }> };
    expect(added.items.map((i) => i.question)).toEqual(['Is the tub staying?', 'Tile or vinyl walls?']);
    await callLeadTool(d1, principal, 'set_lead_info', { requestId: REQ, update: added.items.map((i) => ({ itemId: i.id, answer: 'Yes' })) });
    const read = await callLeadTool(d1, principal, 'read_lead_info', { requestId: REQ }) as { summary: { readyToQuote: boolean }; items: Array<{ createdVia: string; untrusted: boolean }> };
    expect(read.summary.readyToQuote).toBe(true);
    expect(read.items[0]).toMatchObject({ createdVia: 'assistant', untrusted: true });
  });

  it('lists open Jobber leads with their checklist summaries', async () => {
    const { d1 } = sqliteD1();
    await callLeadTool(d1, principal, 'set_lead_info', { requestId: REQ, add: [{ question: 'Tile size?' }] });
    const listSpy = vi.spyOn(ManualRequestService.prototype, 'list').mockResolvedValue([
      { id: 'a', jobberRequestId: REQ, customerName: 'Keeley', requestTitle: 'Shower', createdAt: '2026-11-02T00:00:00Z', ageSeconds: 2 * 86400, quoteSentAt: null },
      { id: 'b', jobberRequestId: OTHER, customerName: 'Nick', requestTitle: null, createdAt: '2026-11-03T00:00:00Z', ageSeconds: 3600, quoteSentAt: null },
      { id: 'c', jobberRequestId: 'Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMg==', customerName: 'Sent', createdAt: '2026-11-01T00:00:00Z', ageSeconds: 9e5, quoteSentAt: '2026-11-03T00:00:00Z' },
      { id: 'd', jobberRequestId: null, customerName: 'Manual', createdAt: '2026-11-01T00:00:00Z', ageSeconds: 9e5, quoteSentAt: null },
    ] as never);
    const result = await callLeadTool(d1, principal, 'list_open_leads', { limit: 10 }) as { total: number; leads: Array<{ client: string; ageDays: number; infoNeeded: { total: number } }> };
    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-a', sortBy: 'age_asc' }));
    expect(result.total).toBe(2);
    expect(result.leads.map((l) => [l.client, l.ageDays, l.infoNeeded.total])).toEqual([['Keeley', 2, 1], ['Nick', 0, 0]]);
    expect(JSON.stringify(result)).not.toMatch(/customerPhone|customerEmail/);
    await expect(callLeadTool(d1, principal, 'list_open_leads', { limit: 0 })).rejects.toThrow('limit');
    listSpy.mockRestore();
  });

  it('writes nothing when any question in the batch is invalid', async () => {
    const { d1, rows } = sqliteD1();
    await expect(callLeadTool(d1, principal, 'set_lead_info', { requestId: REQ, add: [{ question: 'Tile size?' }, { question: 'Text 773-392-8835' }] })).rejects.toThrow(LeadToolArgsError);
    expect(rows()).toHaveLength(0);
    await expect(callLeadTool(d1, principal, 'set_lead_info', { requestId: REQ, update: [{ itemId: 'lii_00000000-0000-0000-0000-000000000000', status: 'asked' }] })).rejects.toThrow('itemId');
    await expect(callLeadTool(d1, principal, 'set_lead_info', { requestId: REQ })).rejects.toThrow('at least one');
    const ok = await callLeadTool(d1, principal, 'set_lead_info', { requestId: REQ, add: [{ question: 'Tile size?' }] }) as { items: Array<{ id: string; untrusted: boolean }> };
    expect(ok.items[0].untrusted).toBe(true);
    // A bad update later in the batch stops the whole batch, including the valid add before it.
    await expect(callLeadTool(d1, principal, 'set_lead_info', { requestId: REQ, add: [{ question: 'Grout color?' }], update: [{ itemId: ok.items[0].id, status: 'answered' }] })).rejects.toThrow('needs the answer');
    expect(rows()).toHaveLength(1);
    await expect(callLeadTool(d1, principal, 'read_lead_info', { requestId: REQ, extra: 1 })).rejects.toThrow('Unknown field');
  });

  it('lists set_lead_info only for lead:write tokens and refuses it otherwise', async () => {
    const { d1, rows } = sqliteD1();
    const directory = (p: AssistantPrincipal): AssistantDirectory => ({
      authenticateAccessToken: async () => p, authenticateRefreshToken: async () => null,
      mintToken: async () => ({ id: 'n', token: 'ctz', expiresAt: '2099-01-01T00:00:00Z' }), revoke: async () => true, revokeByHash: async () => true,
      list: async () => [], findClient: async () => null, saveClient: async () => undefined, saveTx: async () => undefined,
      loadTx: async () => null, saveCode: async () => undefined, consumeCode: async () => null,
    });
    const audit = { prepare: vi.fn(() => ({ bind: () => ({ run: async () => ({}) }) })) };
    const db = new Proxy(d1 as object, { get: (target, key) => (key === 'prepare' ? (sql: string) => (/activity_log/.test(sql) ? audit.prepare() : (target as { prepare: (s: string) => unknown }).prepare(sql)) : (target as Record<string | symbol, unknown>)[key]) });
    const mcp = (method: string, params?: unknown) => new Request('http://127.0.0.1:8787/mcp', {
      method: 'POST', headers: { Authorization: 'Bearer ctz', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const deps = (scope: string) => ({ directory: directory({ ...principal, scope }), read: new OpsAssistantRead({ graphqlRequest: vi.fn() }, db as never), db: db as never, budget: new CallBudget() });
    const names = async (scope: string) => ((readMcpJsonBody(await (await handleMcpPost(mcp('tools/list'), deps(scope))).text()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name));
    expect(await names('ops:read')).toEqual(expect.arrayContaining(['list_open_leads', 'read_lead_info']));
    expect(await names('ops:read')).not.toContain('set_lead_info');
    // A review-ledger grant is not a lead grant.
    expect(await names('ops:read review:write')).not.toContain('set_lead_info');
    expect(await names('ops:read lead:write')).toContain('set_lead_info');
    const call = readMcpJsonBody(await (await handleMcpPost(mcp('tools/call', { name: 'set_lead_info', arguments: { requestId: REQ, add: [{ question: 'Tile size?' }] } }), deps('ops:read review:write'))).text()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(call.result.content[0].text)).toMatchObject({ outcome: 'forbidden', failure: { code: 'insufficient_scope' } });
    expect(rows()).toHaveLength(0);
  });
});
