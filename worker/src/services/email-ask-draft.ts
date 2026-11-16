import type { EmailContextService, AttachmentCandidate } from './email-context-service.js';

export const DRAFT_MIN_CONFIDENCE = 0.8;
const MAX_PER_RUN = 25;
const MAX_CANDIDATES = 10;

export interface AskRow {
  message_id: string;
  thread_id: string | null;
  from_address: string | null;
  subject: string | null;
  requested_document: string | null;
}

export interface AskDraftResult {
  drafted: number;
  needs_you: number;
  failed: number;
}

type DraftService = Pick<EmailContextService, 'findAttachmentCandidates' | 'createDraft'>;

/** RFC 822 reply with one base64 attachment part, base64url-encoded for the Gmail drafts API. */
export function buildMimeReply(input: {
  to: string;
  subject: string;
  body: string;
  attachment: { filename: string; data: string };
}): string {
  const subject = /^re:/i.test(input.subject.trim()) ? input.subject : `Re: ${input.subject}`;
  const boundary = 'cotiza-reply-' + Math.random().toString(36).slice(2);
  const content = fromBase64Url(input.attachment.data);
  const mime = [
    `To: ${input.to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    input.body,
    '',
    `--${boundary}`,
    `Content-Type: application/octet-stream; name="${input.attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${input.attachment.filename}"`,
    '',
    content,
    '',
    `--${boundary}--`,
  ].join('\r\n');
  return toBase64Url(mime);
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
}

/** The one clearly-best attachment, or null on a tie (ambiguous) or no candidates. */
export function pickWinner(
  candidates: AttachmentCandidate[],
  doc: string | null,
  asker: string | null,
): AttachmentCandidate | null {
  if (candidates.length === 0) return null;
  const words = ((doc ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 2);
  const askerDomain = asker && asker.includes('@') ? asker.split('@').pop()!.toLowerCase() : null;
  const scored = candidates.map((candidate) => {
    const stem = candidate.filename.toLowerCase().replace(/\.[^.]+$/, '');
    let score = 0;
    for (const word of words) if (stem.includes(word)) score += 2;
    if (askerDomain && candidate.from.toLowerCase().includes('@' + askerDomain)) score += 1;
    return { candidate, score };
  });
  scored.sort((a, b) => b.score - a.score || (b.candidate.date ?? '').localeCompare(a.candidate.date ?? ''));
  const top = scored[0];
  const runnerUp = scored[1];
  if (runnerUp && top.score <= runnerUp.score) return null;
  return top.candidate;
}

/** Gmail search for the asked-for document, preferring the asker's own sent mail. */
export function candidateQuery(ask: Pick<AskRow, 'requested_document' | 'from_address'>): string {
  const words = ((ask.requested_document ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 3);
  const asker = ask.from_address?.trim();
  const from = asker ? `(from:${asker} OR from:me)` : 'from:me';
  return `has:attachment filename:${words.join(' ')} ${from}`;
}

function coverNote(winner: AttachmentCandidate): string {
  return [
    'Hi,',
    '',
    'Attaching the document you requested.',
    '',
    `Attached: ${winner.filename} (from ${winner.from} on ${winner.date ?? 'unknown'}, Gmail message ${winner.messageId})`,
  ].join('\n');
}

export async function draftEmailAsks(deps: {
  asks: AskRow[];
  service: DraftService;
  db: D1Database;
}): Promise<AskDraftResult> {
  const result: AskDraftResult = { drafted: 0, needs_you: 0, failed: 0 };
  for (const ask of deps.asks.slice(0, MAX_PER_RUN)) {
    const candidates = await deps.service.findAttachmentCandidates(candidateQuery(ask), MAX_CANDIDATES);
    const winner = pickWinner(candidates, ask.requested_document, ask.from_address);
    if (!winner) {
      const reason = candidates.length === 0
        ? `attachment not found: ${ask.requested_document ?? ''}`.trim()
        : 'document ambiguous';
      await deps.db
        .prepare("UPDATE email_asks SET reason = ?, updated_at = datetime('now') WHERE message_id = ?")
        .bind(reason, ask.message_id)
        .run();
      result.needs_you++;
      continue;
    }
    const draft = await deps.service.createDraft({
      threadId: ask.thread_id ?? '',
      to: ask.from_address ?? '',
      subject: ask.subject ?? '',
      body: coverNote(winner),
      attachment: {
        filename: winner.filename,
        attachmentId: winner.attachmentId,
        messageId: winner.messageId,
        source: winner.from,
      },
    });
    if (!draft.ok) {
      result.failed++;
      continue;
    }
    await deps.db
      .prepare(
        "UPDATE email_asks SET draft_id = ?, draft_url = ?, attachment_name = ?, attachment_source = ?, attachment_message_id = ?, status = 'drafted', reason = NULL, updated_at = datetime('now') WHERE message_id = ?",
      )
      .bind(draft.draftId, draft.draftUrl, winner.filename, winner.from, winner.messageId, ask.message_id)
      .run();
    result.drafted++;
  }
  return result;
}

export async function runEmailAskDraft(service: DraftService, db: D1Database): Promise<void> {
  try {
    const res = await db
      .prepare(
        "SELECT message_id, thread_id, from_address, subject, requested_document FROM email_asks WHERE status = 'needs_you' AND confidence >= ? LIMIT ?",
      )
      .bind(DRAFT_MIN_CONFIDENCE, MAX_PER_RUN)
      .all<AskRow>();
    const result = await draftEmailAsks({ asks: res.results ?? [], service, db });
    if (result.failed > 0) console.error('[email-asks] draft failed', new Error(`${result.failed} draft(s) failed`));
    console.log(`[email-asks] drafted=${result.drafted} needs_you=${result.needs_you} failed=${result.failed}`);
  } catch (err) {
    console.error('[email-asks] draft failed', err);
  }
}
