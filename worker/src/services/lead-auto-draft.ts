// Auto-draft (card 96c6f073 T7): a checklist that turns ready to quote drafts the quote itself via
// generateQuoteDraft. Cotiza draft only, no Jobber quote, no send.
import type { Bindings } from '../bindings.js';
import { generateQuoteDraft } from '../routes/quotes.js';
import { buildCustomerNote, findAssumptionConflicts } from './lead-quote-draft.js';
import { LeadInfoService, summarize } from './lead-info-service.js';
import { ActivityLogService } from './activity-log-service.js';
import { sanitizeLogText } from './jobber-log-sanitize.mjs';

const ASSUMED_RE = /^assumed:\s*/i;

async function draftQuoteForRequest(env: Bindings, userId: string, requestId: string): Promise<string> {
  const existing = await env.DB.prepare(
    'SELECT id FROM quote_drafts WHERE jobber_request_id = ? ORDER BY created_at ASC LIMIT 1',
  ).bind(requestId).first<{ id: string }>();
  if (existing) return existing.id;

  const items = await new LeadInfoService(env.DB).list(requestId);
  const assumptions = items.filter((i) => ASSUMED_RE.test(i.question)).map((i) => i.question);
  const answers = items
    .filter((i) => i.status === 'answered' && i.answer)
    .map((i) => `${i.question}: ${i.answer}`);
  const leadContextText = [...assumptions, ...answers].join('\n');

  const draft = await generateQuoteDraft({ env, get: () => ({ id: userId }) }, {
    jobberRequestId: requestId,
    leadContextText,
    decorate: (d) => {
      d.customerNote = buildCustomerNote(d.customerNote, assumptions);
      const lineItemId = d.lineItems[0]?.id ?? '';
      const conflicts = findAssumptionConflicts(assumptions, [d.customerRequestText ?? '']);
      d.actionItems = [
        ...(d.actionItems ?? []),
        ...conflicts.map((risk) => ({
          id: crypto.randomUUID(), quoteDraftId: d.id, lineItemId, description: risk.detail, completed: false,
        })),
      ];
    },
  });
  return draft.id;
}

// Draft once when a lead turns ready. Not ready or already drafted: nothing. Failure: logged, swallowed.
export async function autoDraftIfReady(env: Bindings, userId: string, requestId: string): Promise<void> {
  try {
    const items = await new LeadInfoService(env.DB).list(requestId);
    if (!summarize(items).readyToQuote) return;
    const existing = await env.DB.prepare(
      'SELECT id FROM quote_drafts WHERE jobber_request_id = ? LIMIT 1',
    ).bind(requestId).first<{ id: string }>();
    if (existing) return;
    await draftQuoteForRequest(env, userId, requestId);
    await new ActivityLogService(env.DB).log({
      userId, component: 'LeadHub', operation: 'auto_draft_quote', severity: 'info',
      description: `Cotiza drafted a quote for ${requestId}.`,
    }).catch(() => undefined);
  } catch (err) {
    console.error('[leads] auto draft failed', sanitizeLogText(err instanceof Error ? err.message : String(err)).slice(0, 180));
    await new ActivityLogService(env.DB).log({
      userId, component: 'LeadHub', operation: 'auto_draft_quote', severity: 'error',
      description: `Cotiza could not draft a quote for ${requestId}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 240),
      recommendedAction: 'Draft the quote from the lead page.',
    }).catch(() => undefined);
  }
}
