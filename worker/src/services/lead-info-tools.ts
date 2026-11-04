/**
 * Connector tools for the lead hub's "info needed" checklist.
 * Reads (list_open_leads, read_lead_info) come with ops:read; set_lead_info needs lead:write,
 * its own consent tick ("Also allow updating lead questions"). Nothing here touches Jobber,
 * and contact details are never returned or stored.
 */
import type { AssistantPrincipal } from './assistant-access.js';
import { OpsAssistantRead, type JobberReadClient } from './ops-assistant-read.js';
import { LeadContactService } from './lead-contact-service.js';
import { gatherLeadWorkflow, type RequestDetail } from './lead-contact-status.js';
import type { EmailContextService } from './email-context-service.js';
import type { PhoneContextService } from './phone-context-service.js';
import { chicagoDate, daysBetween, type LeadWorkflow } from './lead-workflow.js';
import { applyClosuresToOpenLeads } from './lead-closures.js';
import { LEAD_MAX_PAGES, LEAD_PAGE_SIZE, leadClientName, loadOpenLeads, OPEN_LEAD_DAYS, type LeadNode } from './open-leads.js';
import { sanitizeLogText } from './jobber-log-sanitize.mjs';
import { applyChange, LeadInfoError, LeadInfoService, type LeadInfoItem, MAX_ITEMS_PER_LEAD, questionKey, requireRequestId, summarize, validateQuestion } from './lead-info-service.js';

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
    description: 'List open leads: Jobber requests from the last N days that are still new or in assessment (not converted to a quote or job, not archived), leaving out leads the team closed in Cotiza and adding back postponed leads whose check-back date has come (even from before the window), oldest first (the lead waiting longest comes first), with each one\'s Jobber status, info-needed counts and next step: where it sits in the handbook follow-up cadence, when the next contact is due, and the one action the team should take. Next steps here use Jobber notes and contacts logged in Cotiza only (not Quo or email). Read live from Jobber. No contact details. Read-only. A failed lookup is not an empty list.',
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

const NO_CONTEXT = { isAvailable: () => false } as unknown as PhoneContextService & EmailContextService;
const NEXT_STEP_CONCURRENCY = 4;

function publicNextStep(w: LeadWorkflow) {
  return {
    bucket: w.bucket,
    stage: w.stage,
    nextContactOn: w.next.on,
    due: w.next.overdue ? 'overdue' as const : w.next.dueToday ? 'today' as const : 'later' as const,
    daysOverdue: w.next.daysOverdue,
    action: w.action.label,
    why: w.action.why,
    alsoDo: w.secondary ? { action: w.secondary.label, why: w.secondary.why } : null,
    progress: w.progress,
  };
}

/** Next step per lead from Jobber notes, logged contacts and the checklist. Contact details never leave this function. */
async function leadNextSteps(db: D1Database, jobber: JobberReadClient, userId: string, ids: string[], itemsById: Record<string, LeadInfoItem[]>, now: number) {
  const read = new OpsAssistantRead(jobber, db);
  const contacts = new LeadContactService(db);
  const out: Record<string, ReturnType<typeof publicNextStep> | null> = {};
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const requestId = ids[next++];
      try {
        const request = await read.readRequest(userId, { requestId }) as unknown as { outcome?: string; request?: RequestDetail };
        // Without the request's notes the cadence would be a guess: say "unknown" (null) instead.
        if (request.outcome !== 'ok') { out[requestId] = null; continue; }
        const { workflow } = await gatherLeadWorkflow({
          requestId, detail: request.request, requestFailed: false, contacts,
          phone: NO_CONTEXT, email: NO_CONTEXT, now, items: itemsById[requestId] ?? [],
        });
        out[requestId] = workflow ? publicNextStep(workflow) : null;
      } catch (err) {
        console.warn(`[lead-info] next step failed: ${sanitizeLogText(err instanceof Error ? err.message : String(err)).slice(0, 180)}`);
        out[requestId] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(NEXT_STEP_CONCURRENCY, ids.length) }, worker));
  return out;
}

export async function callLeadTool(db: D1Database, principal: AssistantPrincipal, name: string, rawArgs: unknown, jobber?: JobberReadClient | null, now: number = Date.now()) {
  const info = new LeadInfoService(db);
  try {
    if (name === 'list_open_leads') {
      const args = objectArgs(rawArgs, ['limit', 'days']);
      const limit = args.limit === undefined ? 25 : Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new LeadToolArgsError('limit must be 1 to 50.');
      const days = args.days === undefined ? OPEN_LEAD_DAYS : Number(args.days);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new LeadToolArgsError('days must be 1 to 365.');
      if (!jobber) return { outcome: 'failed' as const, leads: [], failure: { code: 'jobber_unavailable', message: 'Jobber is not connected, so open leads could not be read. This is not an empty list.' } };
      let loaded: { open: LeadNode[]; complete: boolean };
      try {
        loaded = await loadOpenLeads(jobber, days, now);
      } catch (err) {
        console.error(`[lead-info] ${sanitizeLogText(err instanceof Error ? err.message : String(err)).slice(0, 180)}`);
        return { outcome: 'failed' as const, leads: [], failure: { code: 'jobber_read_failed', message: 'Jobber requests could not be read. This is not an empty list.' } };
      }
      // Closed leads leave the list; a postponed one returns on its check-back date.
      const applied = await applyClosuresToOpenLeads(db, jobber, loaded.open, now);
      // The team works the lead waiting longest first.
      const ms = (n: LeadNode) => { const t = Date.parse(n.createdAt ?? ''); return Number.isFinite(t) ? t : Infinity; };
      const oldestFirst = [...applied.open].sort((a, b) => ms(a) - ms(b));
      const page = oldestFirst.slice(0, limit);
      const itemsById = await info.listMany(page.map((node) => node.id));
      const nextSteps = await leadNextSteps(db, jobber, principal.userId, page.map((node) => node.id), itemsById, now);
      return {
        outcome: 'ok' as const,
        total: applied.open.length,
        totalIsComplete: loaded.complete && !applied.postponedUnavailable && !applied.closuresUnavailable,
        days,
        leads: page.map((node) => {
          const created = Date.parse(node.createdAt ?? '');
          return {
            requestId: node.id,
            client: leadClientName(node),
            title: node.title?.trim() || null,
            jobberStatus: node.requestStatus ?? null,
            createdAt: node.createdAt ?? null,
            // Chicago calendar days, the same count the request queue and the lead page show.
            ageDays: Number.isFinite(created) ? Math.max(0, daysBetween(chicagoDate(created), chicagoDate(now))) : null,
            jobberWebUri: node.jobberWebUri ?? null,
            infoNeeded: summarize(itemsById[node.id] ?? []),
            nextStep: nextSteps[node.id] ?? null,
          };
        }),
        notes: [
          'Open means Jobber still shows the request as new or in assessment; converted (quote or job made) and archived requests are left out.',
          'A lead with no checklist has total 0 and is not ready to quote.',
          'Leads the team closed in Cotiza are left out; a postponed one is listed again from its check-back date.',
          ...(applied.closuresUnavailable ? ['Closed leads could not be read, so some leads listed here may already be closed.'] : []),
          ...(applied.postponedUnavailable ? ['Some postponed leads due a check-back could not be read from Jobber and are missing from this list.'] : []),
          'nextStep uses Jobber notes and contacts logged in Cotiza; texts, calls and emails that only live in Quo or Gmail are not counted here (the Cotiza request queue counts them). nextStep is null when it could not be worked out.',
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
