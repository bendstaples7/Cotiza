import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { LeadInfoError, LeadInfoService, summarize } from '../../worker/src/services/lead-info-service.js';
import { callLeadTool, LeadToolArgsError } from '../../worker/src/services/lead-info-tools.js';
import { CallBudget, type AssistantDirectory, type AssistantPrincipal } from '../../worker/src/services/assistant-access.js';
import { OpsAssistantRead } from '../../worker/src/services/ops-assistant-read.js';
import { handleMcpPost, readMcpJsonBody } from '../../worker/src/routes/ops-assistant.js';

// Vitest 2's resolver doesn't know node:sqlite, so load it through Node's own require.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const MIGRATION = readFileSync(new URL('../../worker/src/migrations/0071_lead_info_items.sql', import.meta.url), 'utf8');
const REQ = 'Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMzU3NDIzMDM=';
const OTHER = 'Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMQ==';

/** Minimal D1 over node:sqlite so the real SQL runs. */
function sqliteD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATION);
  const d1 = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async all() { return { results: db.prepare(sql).all(...(args as never[])) }; },
        async first() { return db.prepare(sql).get(...(args as never[])) ?? null; },
        async run() { db.prepare(sql).run(...(args as never[])); return { success: true, meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  return { d1: d1 as unknown as D1Database, rows: () => db.prepare('SELECT * FROM lead_info_items').all() };
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
  const principal: AssistantPrincipal = { tokenId: 't', userId: 'user-a', clientId: 'claude', resource: 'http://127.0.0.1:8787/mcp', scope: 'ops:read review:write' };

  it('adds and answers questions through set_lead_info and reads them back', async () => {
    const { d1 } = sqliteD1();
    const added = await callLeadTool(d1, principal, 'set_lead_info', { requestId: REQ, add: [{ question: 'Is the tub staying?' }, { question: 'Tile or vinyl walls?' }] }) as { items: Array<{ id: string; question: string }> };
    expect(added.items.map((i) => i.question)).toEqual(['Is the tub staying?', 'Tile or vinyl walls?']);
    await callLeadTool(d1, principal, 'set_lead_info', { requestId: REQ, update: added.items.map((i) => ({ itemId: i.id, answer: 'Yes' })) });
    const read = await callLeadTool(d1, principal, 'read_lead_info', { requestId: REQ }) as { summary: { readyToQuote: boolean }; items: Array<{ createdVia: string; untrusted: boolean }> };
    expect(read.summary.readyToQuote).toBe(true);
    expect(read.items[0]).toMatchObject({ createdVia: 'assistant', untrusted: true });
  });

  it('writes nothing when any question in the batch is invalid', async () => {
    const { d1, rows } = sqliteD1();
    await expect(callLeadTool(d1, principal, 'set_lead_info', { requestId: REQ, add: [{ question: 'Tile size?' }, { question: 'Text 773-392-8835' }] })).rejects.toThrow(LeadToolArgsError);
    expect(rows()).toHaveLength(0);
    await expect(callLeadTool(d1, principal, 'set_lead_info', { requestId: REQ, update: [{ itemId: 'lii_00000000-0000-0000-0000-000000000000', status: 'asked' }] })).rejects.toThrow('itemId');
    await expect(callLeadTool(d1, principal, 'set_lead_info', { requestId: REQ })).rejects.toThrow('at least one');
    await expect(callLeadTool(d1, principal, 'read_lead_info', { requestId: REQ, extra: 1 })).rejects.toThrow('Unknown field');
  });

  it('lists set_lead_info only for review:write tokens and refuses it otherwise', async () => {
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
    expect(await names('ops:read review:write')).toContain('set_lead_info');
    const call = readMcpJsonBody(await (await handleMcpPost(mcp('tools/call', { name: 'set_lead_info', arguments: { requestId: REQ, add: [{ question: 'Tile size?' }] } }), deps('ops:read'))).text()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(call.result.content[0].text)).toMatchObject({ outcome: 'forbidden', failure: { code: 'insufficient_scope' } });
    expect(rows()).toHaveLength(0);
  });
});
