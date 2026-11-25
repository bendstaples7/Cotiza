/**
 * Card 96c6f073 T11: seed one lead's checklist from its job type, once, and pre-answer what the
 * lead already sent. Idempotent on question_key, so a poll that runs again adds nothing.
 */
import type { Bindings } from '../bindings.js';
import { LeadInfoService, questionKey, type LeadInfoItem } from './lead-info-service.js';
import { ActivityLogService } from './activity-log-service.js';
import { CHECKLIST_TEMPLATES, jobTypeKey, type ChecklistTemplateItem } from './lead-checklist-templates.js';

export type LeadChecklistContext = { title?: string | null; notes?: string | null; photoCount?: () => Promise<number> };

// Test: `flags a video-only item to check the video`.
export function videoQuestion(item: ChecklistTemplateItem): string {
  return item.videoOnly ? `Check the video: ${item.question}` : item.question;
}

/** Test: `seed the job type checklist once for a new lead`. Returns the lead's full checklist. */
export async function ensureLeadChecklist(
  env: Bindings,
  userId: string,
  requestId: string,
  context: LeadChecklistContext,
): Promise<LeadInfoItem[]> {
  const service = new LeadInfoService(env.DB);
  const items = await service.list(requestId);
  const have = new Set(items.map((i) => questionKey(i.question)));
  const template = CHECKLIST_TEMPLATES[jobTypeKey(context.title)];
  let added = 0;
  for (const item of template) {
    const question = videoQuestion(item);
    if (have.has(questionKey(question))) continue;
    await service.add(requestId, { question, required: item.required !== false }, { userId, via: 'app' });
    added++;
  }
  if (added > 0) {
    await answerFromLead(service, userId, requestId, template, context);
    await new ActivityLogService(env.DB).log({
      userId, component: 'LeadHub', operation: 'lead_checklist_seeded', severity: 'info',
      description: `Seeded ${added} checklist items for ${requestId}.`.slice(0, 240),
    }).catch(() => undefined);
  }
  return service.list(requestId);
}

/**
 * Test: `answers measurement items from the photos Jobber already holds` and
 * `leaves an unanswered item open when the lead sent nothing`. A video-only item is skipped.
 */
async function answerFromLead(
  service: LeadInfoService,
  userId: string,
  requestId: string,
  template: ChecklistTemplateItem[],
  context: LeadChecklistContext,
): Promise<void> {
  const lines = (context.notes ?? '').split(/\r?\n|(?<=[.!?])\s+/).map((l) => l.trim()).filter(Boolean);
  const photoCount = context.photoCount ? await context.photoCount().catch(() => 0) : 0;
  const items = await service.list(requestId);
  for (const item of template) {
    if (item.videoOnly) continue;
    const match = items.find((i) => questionKey(i.question) === questionKey(item.question) && i.status !== 'answered');
    if (!match) continue;
    const answer = item.fromPhotos && photoCount > 0
      ? `Seen in the ${photoCount} photo(s) Jobber holds.`
      : matchingNotes(lines, item.keywords);
    if (answer) await service.update(match.id, { answer }, { userId, via: 'app' });
  }
}

/** Test: `answers only the item whose keyword appears, with that line only`. The note lines that mention a keyword, max 300 chars. */
function matchingNotes(lines: string[], keywords: string[]): string {
  return lines.filter((line) => keywords.some((k) => line.toLowerCase().includes(k))).join('\n').slice(0, 300).trim();
}
