/**
 * Connector tools for the lead hub's "info needed" checklist.
 * Reads (list_open_leads, read_lead_info) come with ops:read; set_lead_info needs lead:write,
 * its own consent tick ("Also allow updating lead questions"). Nothing here touches Jobber,
 * and contact details are never returned or stored.
 */
import type { AssistantPrincipal } from './assistant-access.js';
import type { JobberReadClient } from './ops-assistant-read.js';
import { sanitizeLogText } from './jobber-log-sanitize.mjs';
import { applyChange, LeadInfoError, LeadInfoService, MAX_ITEMS_PER_LEAD, questionKey, requireRequestId, summarize, validateQuestion } from './lead-info-service.js';

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
    description: 'List open leads: Jobber requests from the last N days that are still new or in assessment (not converted to a quote or job, not archived), newest first, with each one\'s Jobber status and info-needed counts. Read live from Jobber. No contact details. Read-only. A failed lookup is not an empty list.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Default 25, max 50.' },
        days: { type: 'number', description: 'How far back to look. Default 60, max 365.' },
      },
    },
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

/** Jobber request statuses that mean the lead is handled: a quote or job was made, or it was dropped. */
export const CLOSED_REQUEST_STATUSES = new Set(['converted', 'archived']);
const LEAD_PAGE_SIZE = 50;
const LEAD_MAX_PAGES = 10;

export const OPEN_LEADS_QUERY = `
  query AssistantOpenLeads($first: Int!, $after: String) {
    requests(first: $first, after: $after, sort: [{ key: REQUESTED_AT, direction: DESCENDING }]) {
      edges { node { id title requestStatus createdAt jobberWebUri companyName client { firstName lastName companyName } } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

type LeadNode = {
  id: string; title?: string | null; requestStatus?: string | null; createdAt?: string | null; jobberWebUri?: string | null;
  companyName?: string | null; client?: { firstName?: string | null; lastName?: string | null; companyName?: string | null } | null;
};
type LeadPage = { requests?: { edges?: Array<{ node: LeadNode }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } };

function leadClientName(node: LeadNode): string | null {
  const person = [node.client?.firstName, node.client?.lastName].map((part) => (part ?? '').trim()).filter(Boolean).join(' ');
  return person || (node.client?.companyName ?? node.companyName ?? '').trim() || null;
}

/** Reads requests newest first until one is older than the window, keeping the ones not yet converted or archived. */
async function loadOpenLeads(jobber: JobberReadClient, days: number, now: number): Promise<{ open: LeadNode[]; complete: boolean }> {
  const cutoff = now - days * 86400_000;
  const open: LeadNode[] = [];
  let after: string | null = null;
  for (let page = 0; page < LEAD_MAX_PAGES; page++) {
    const data: LeadPage = await jobber.graphqlRequest<LeadPage>(OPEN_LEADS_QUERY, { first: LEAD_PAGE_SIZE, after });
    const edges = data.requests?.edges ?? [];
    for (const { node } of edges) {
      const created = Date.parse(node.createdAt ?? '');
      if (Number.isFinite(created) && created < cutoff) return { open, complete: true };
      if (!CLOSED_REQUEST_STATUSES.has(String(node.requestStatus ?? '').toLowerCase())) open.push(node);
    }
    if (!data.requests?.pageInfo?.hasNextPage || !data.requests.pageInfo.endCursor) return { open, complete: true };
    after = data.requests.pageInfo.endCursor;
  }
  return { open, complete: false };
}

export async function callLeadTool(db: D1Database, principal: AssistantPrincipal, name: string, rawArgs: unknown, jobber?: JobberReadClient | null, now: number = Date.now()) {
  const info = new LeadInfoService(db);
  try {
    if (name === 'list_open_leads') {
      const args = objectArgs(rawArgs, ['limit', 'days']);
      const limit = args.limit === undefined ? 25 : Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new LeadToolArgsError('limit must be 1 to 50.');
      const days = args.days === undefined ? 60 : Number(args.days);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new LeadToolArgsError('days must be 1 to 365.');
      if (!jobber) return { outcome: 'failed' as const, leads: [], failure: { code: 'jobber_unavailable', message: 'Jobber is not connected, so open leads could not be read. This is not an empty list.' } };
      let loaded: { open: LeadNode[]; complete: boolean };
      try {
        loaded = await loadOpenLeads(jobber, days, now);
      } catch (err) {
        console.error(`[lead-info] ${sanitizeLogText(err instanceof Error ? err.message : String(err)).slice(0, 180)}`);
        return { outcome: 'failed' as const, leads: [], failure: { code: 'jobber_read_failed', message: 'Jobber requests could not be read. This is not an empty list.' } };
      }
      const page = loaded.open.slice(0, limit);
      const summaries = await info.summaries(page.map((node) => node.id));
      return {
        outcome: 'ok' as const,
        total: loaded.open.length,
        totalIsComplete: loaded.complete,
        days,
        leads: page.map((node) => {
          const created = Date.parse(node.createdAt ?? '');
          return {
            requestId: node.id,
            client: leadClientName(node),
            title: node.title?.trim() || null,
            jobberStatus: node.requestStatus ?? null,
            createdAt: node.createdAt ?? null,
            ageDays: Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / 86400_000)) : null,
            jobberWebUri: node.jobberWebUri ?? null,
            infoNeeded: summaries[node.id] ?? summarize([]),
          };
        }),
        notes: [
          'Open means Jobber still shows the request as new or in assessment; converted (quote or job made) and archived requests are left out.',
          'A lead with no checklist has total 0 and is not ready to quote.',
          ...(loaded.complete ? [] : [`Only the newest ${LEAD_PAGE_SIZE * LEAD_MAX_PAGES} requests were checked; older ones in the window were not.`]),
        ],
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
      // Check the whole batch before writing any of it.
      const current = await info.list(requestId);
      const byId = new Map(current.map((i) => [i.id, i]));
      const updates = update.map((change) => {
        const c = objectArgs(change, ['itemId', 'status', 'answer', 'question']);
        const item = typeof c.itemId === 'string' ? byId.get(c.itemId) : undefined;
        if (!item) throw new LeadToolArgsError('Every update needs an itemId from this lead\'s checklist.');
        const fields = Object.fromEntries(Object.entries(c).filter(([key]) => key !== 'itemId'));
        applyChange(item, fields);
        return { itemId: item.id, fields };
      });
      const adds = add.map((entry) => {
        const e = objectArgs(entry, ['question', 'required']);
        validateQuestion(e.question);
        if (e.required !== undefined && typeof e.required !== 'boolean') throw new LeadToolArgsError('required must be true or false.');
        return e;
      });
      const newQuestions = new Set(adds.map((e) => questionKey(String(e.question))));
      const alreadyThere = current.filter((i) => i.status !== 'dropped' && newQuestions.has(questionKey(i.question))).length;
      if (current.length + newQuestions.size - alreadyThere > MAX_ITEMS_PER_LEAD) {
        throw new LeadToolArgsError(`A lead can have at most ${MAX_ITEMS_PER_LEAD} questions; this batch would go over.`);
      }
      for (const u of updates) await info.update(u.itemId, u.fields, by);
      for (const e of adds) await info.add(requestId, e, by);
      const items = await info.list(requestId);
      return { outcome: 'ok' as const, requestId, added: adds.length, updated: updates.length, items: items.map((i) => ({ ...i, untrusted: true })), summary: summarize(items) };
    }
    throw new LeadToolArgsError('Unknown tool');
  } catch (err) {
    if (err instanceof LeadInfoError) throw new LeadToolArgsError(err.message);
    throw err;
  }
}
