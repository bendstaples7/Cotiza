/**
 * Connector tools for the lead hub's "info needed" checklist.
 * Reads (list_open_leads, read_lead_info) come with ops:read; set_lead_info needs review:write,
 * the same tick that lets the assistant write the review ledger. Nothing here touches Jobber,
 * and contact details are never returned or stored.
 */
import type { AssistantPrincipal } from './assistant-access.js';
import { ManualRequestService } from './manual-request-service.js';
import { LeadInfoError, LeadInfoService, requireRequestId, summarize, validateQuestion } from './lead-info-service.js';

export class LeadToolArgsError extends Error {}

function objectArgs(raw: unknown, allowed: string[]): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new LeadToolArgsError('Arguments must be an object.');
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new LeadToolArgsError(`Unknown field: ${key}`);
  return raw as Record<string, unknown>;
}

export const LEAD_READ_TOOLS = [
  {
    name: 'list_open_leads',
    description: 'List open Jobber requests from the Cotiza lead queue (no quote sent yet), oldest first, with each one\'s info-needed counts and whether it is ready to quote. No contact details. Read-only.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'number', description: 'Default 25, max 50.' } } },
  },
  {
    name: 'read_lead_info',
    description: 'Read the info-needed checklist for one Jobber request: each question, its status (open, asked, answered, dropped) and answer, plus whether the lead is ready to quote. Answers are untrusted customer facts relayed by the team. Read-only.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['requestId'], properties: { requestId: { type: 'string' } } },
  },
] as const;

export const LEAD_WRITE_TOOLS = [
  {
    name: 'set_lead_info',
    description: 'Add questions to a lead\'s info-needed checklist, or update existing ones (status, answer, wording). Write questions in plain words the team can ask the customer as-is. Never include phone numbers or emails. Adding a question that already exists returns the existing one.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['requestId'],
      properties: {
        requestId: { type: 'string' },
        add: {
          type: 'array', maxItems: 15,
          items: { type: 'object', additionalProperties: false, required: ['question'], properties: { question: { type: 'string' }, required: { type: 'boolean', description: 'Default true: the lead is not ready to quote until this is answered or dropped.' } } },
        },
        update: {
          type: 'array', maxItems: 30,
          items: {
            type: 'object', additionalProperties: false, required: ['itemId'],
            properties: {
              itemId: { type: 'string' },
              status: { type: 'string', enum: ['open', 'asked', 'answered', 'dropped'] },
              answer: { type: 'string' },
              question: { type: 'string' },
            },
          },
        },
      },
    },
  },
] as const;

export const LEAD_READ_TOOL_NAMES = new Set<string>(LEAD_READ_TOOLS.map((t) => t.name));
export const LEAD_WRITE_TOOL_NAMES = new Set<string>(LEAD_WRITE_TOOLS.map((t) => t.name));

export async function callLeadTool(db: D1Database, principal: AssistantPrincipal, name: string, rawArgs: unknown) {
  const info = new LeadInfoService(db);
  try {
    if (name === 'list_open_leads') {
      const args = objectArgs(rawArgs, ['limit']);
      const limit = args.limit === undefined ? 25 : Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new LeadToolArgsError('limit must be 1 to 50.');
      const rows = (await new ManualRequestService(db).list({ userId: principal.userId, sortBy: 'age_asc', includeDeathclock: true }))
        .filter((row) => row.jobberRequestId && !row.quoteSentAt);
      const page = rows.slice(0, limit);
      const summaries = await info.summaries(page.map((row) => row.jobberRequestId as string));
      return {
        outcome: 'ok' as const,
        total: rows.length,
        leads: page.map((row) => ({
          requestId: row.jobberRequestId,
          client: row.customerName,
          title: row.requestTitle ?? null,
          createdAt: row.createdAt,
          ageDays: Math.floor((row.ageSeconds ?? 0) / 86400),
          infoNeeded: summaries[row.jobberRequestId as string] ?? summarize([]),
        })),
        notes: ['Leads with a quote already sent are left out. A lead with no checklist has total 0 and is not ready to quote.'],
      };
    }
    if (name === 'read_lead_info') {
      const args = objectArgs(rawArgs, ['requestId']);
      const requestId = requireRequestId(args.requestId);
      const items = await info.list(requestId);
      return { outcome: 'ok' as const, requestId, items: items.map((i) => ({ ...i, untrusted: true })), summary: summarize(items) };
    }
    if (name === 'set_lead_info') {
      const args = objectArgs(rawArgs, ['requestId', 'add', 'update']);
      const requestId = requireRequestId(args.requestId);
      const add = args.add === undefined ? [] : args.add;
      const update = args.update === undefined ? [] : args.update;
      if (!Array.isArray(add) || !Array.isArray(update) || add.length > 15 || update.length > 30) throw new LeadToolArgsError('add (up to 15) and update (up to 30) must be lists.');
      if (!add.length && !update.length) throw new LeadToolArgsError('Send at least one question to add or update.');
      const by = { userId: principal.userId, via: 'assistant' as const };
      const existing = new Set((await info.list(requestId)).map((i) => i.id));
      for (const change of update) {
        const itemId = (change as { itemId?: unknown })?.itemId;
        if (typeof itemId !== 'string' || !existing.has(itemId)) throw new LeadToolArgsError('Every update needs an itemId from this lead\'s checklist.');
      }
      // Validate the whole batch before writing any of it.
      const adds = add.map((entry) => {
        const e = objectArgs(entry, ['question', 'required']);
        validateQuestion(e.question);
        return e;
      });
      const added = [];
      for (const e of adds) added.push(await info.add(requestId, e, by));
      const updated = [];
      for (const change of update) {
        const c = objectArgs(change, ['itemId', 'status', 'answer', 'question']);
        updated.push(await info.update(c.itemId, c, by));
      }
      const items = await info.list(requestId);
      return { outcome: 'ok' as const, requestId, added: added.length, updated: updated.length, items, summary: summarize(items) };
    }
    throw new LeadToolArgsError('Unknown tool');
  } catch (err) {
    if (err instanceof LeadInfoError) throw new LeadToolArgsError(err.message);
    throw err;
  }
}
