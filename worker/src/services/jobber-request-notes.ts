/**
 * Writes Cotiza's record of team outreach back to Jobber as a short note on the request, so the
 * team records each touch once (in Cotiza) and Jobber stays the record the handbook asks for.
 *
 * The mutation is found in Jobber's live schema each time the isolate starts: requestCreateNote
 * when Jobber offers it, otherwise clientCreateNote on the request's client. Nothing is sent when
 * the schema has neither or asks for fields this code does not know how to fill.
 *
 * Notes are idempotent: each Cotiza action gets one row in lead_jobber_notes, claimed before the
 * write, so a retry or a double click never posts twice. A write whose result is unknown (or a
 * claim abandoned mid-write) is checked against Jobber's recent notes before it is tried again.
 *
 * Note text never carries contact details: phone numbers and emails are replaced with [contact].
 */
import type { JobberReadClient } from './ops-assistant-read.js';
import { sanitizeLogText } from './jobber-log-sanitize.mjs';

/** Every note Cotiza writes starts with this, so the lead workflow can skip its own notes. */
export const COTIZA_NOTE_PREFIX = 'Cotiza ·';
const EXCERPT = 160;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/gi;
// Any run of digits and phone punctuation holding 7 or more digits: US, local and international numbers alike.
const PHONE_LIKE = /\+?\(?\d[\d\s().\/-]{5,}\d/g;

/** Replaces emails and anything that could be a phone number with [contact]. */
export function redactContacts(text: string): string {
  return text
    .replace(EMAIL, '[contact]')
    .replace(PHONE_LIKE, (m) => ((m.match(/\d/g) ?? []).length >= 7 ? '[contact]' : m));
}

export function isCotizaNote(message: string | null | undefined): boolean {
  return (message ?? '').trimStart().startsWith(COTIZA_NOTE_PREFIX);
}

function clean(text: string | null | undefined): string {
  return redactContacts((text ?? '').replace(/\s+/g, ' ')).trim();
}

function excerpt(text: string | null | undefined): string {
  const t = clean(text);
  return t.length > EXCERPT ? `${t.slice(0, EXCERPT - 1)}…` : t;
}

export type NoteAction =
  | { kind: 'text_quo'; text: string }
  | { kind: 'contact'; channel: 'call' | 'text' | 'email' | 'in_person' | 'other'; direction: 'outgoing' | 'incoming'; note: string | null; stepLabel?: string | null }
  | { kind: 'not_a_lead' }
  | { kind: 'not_a_lead_cleared' }
  | { kind: 'lead_closed'; reason: string; note?: string | null; checkBackOn?: string | null }
  | { kind: 'lead_reopened' }
  | { kind: 'review_requested'; quoteNumber: string | null };

const CONTACT_WORDS: Record<string, [string, string]> = {
  call: ['Call logged', 'Call from customer logged'],
  text: ['Text logged', 'Text from customer logged'],
  email: ['Email logged', 'Email from customer logged'],
  in_person: ['Visit logged', 'Customer visit logged'],
  other: ['Contact logged', 'Customer contact logged'],
};

/** The note Cotiza writes for one action. Plain, short, no contact details, no AI byline. */
export function formatJobberNote(action: NoteAction, userName: string): string {
  const by = clean(userName) || 'the team';
  const tail = (s: string | null | undefined) => { const e = excerpt(s); return e ? ` — ${e}` : ''; };
  switch (action.kind) {
    case 'text_quo': return `${COTIZA_NOTE_PREFIX} Text sent via Quo by ${by}${tail(action.text)}`;
    case 'contact': {
      if (action.channel === 'other' && action.direction === 'outgoing' && action.stepLabel) {
        return `${COTIZA_NOTE_PREFIX} ${clean(action.stepLabel)} marked done by ${by}${tail(action.note)}`;
      }
      const [out, inc] = CONTACT_WORDS[action.channel] ?? CONTACT_WORDS.other;
      const what = action.direction === 'incoming' ? inc : out;
      const step = action.stepLabel ? ` (${clean(action.stepLabel)})` : '';
      return `${COTIZA_NOTE_PREFIX} ${what}${step} by ${by}${tail(action.note)}`;
    }
    case 'not_a_lead': return `${COTIZA_NOTE_PREFIX} Marked not a lead by ${by}`;
    case 'not_a_lead_cleared': return `${COTIZA_NOTE_PREFIX} Not-a-lead mark cleared by ${by}`;
    case 'lead_closed': {
      const back = action.checkBackOn ? ` · check back ${action.checkBackOn}` : '';
      return `${COTIZA_NOTE_PREFIX} Lead closed by ${by} — ${clean(action.reason)}${back}${action.note ? `: ${excerpt(action.note)}` : ''}`;
    }
    case 'lead_reopened': return `${COTIZA_NOTE_PREFIX} Lead reopened by ${by}`;
    case 'review_requested': return `${COTIZA_NOTE_PREFIX} Quote ${action.quoteNumber ? `#${clean(action.quoteNumber)}` : ''} sent to Ben for review by ${by}`.replace('Quote  sent', 'Quote sent');
  }
}

const STEP_LABELS: Record<string, string> = {
  intro_text: 'Intro text',
  follow_up: 'Follow-up',
  reply: 'Reply',
  quote_update: 'Quote-in-progress update',
  draft_quote: 'Quote drafting',
  quote_follow_up: 'Quote follow-up',
  check_back: 'Check-back',
};

/** Plain words for a logged step id ("intro_text" → "Intro text"); null for none or unknown. */
export function stepLabel(step: string | null | undefined): string | null {
  if (!step) return null;
  return STEP_LABELS[step] ?? null;
}

// ── Live schema ──────────────────────────────────────────────────────────────

interface TypeRef { kind: string; name: string | null; ofType?: TypeRef | null }
interface Field { name: string; type: TypeRef }
interface MutationField { name: string; args: Field[]; type: TypeRef }

const REF = 'kind name ofType { kind name ofType { kind name ofType { kind name } } }';
export const NOTE_MUTATIONS_QUERY = `query CotizaNoteMutations {
  __schema { mutationType { fields { name args { name type { ${REF} } } type { ${REF} } } } }
}`;
export const NOTE_TYPES_QUERY = `query CotizaNoteTypes($input: String!, $payload: String!) {
  input: __type(name: $input) { inputFields { name type { ${REF} } } }
  payload: __type(name: $payload) { fields { name type { ${REF} } } }
}`;

function baseOf(ref: TypeRef): TypeRef {
  let r = ref;
  while (r.ofType) r = r.ofType;
  return r;
}

function render(ref: TypeRef): string {
  if (ref.kind === 'NON_NULL') return `${render(ref.ofType!)}!`;
  if (ref.kind === 'LIST') return `[${render(ref.ofType!)}]`;
  return String(ref.name);
}

export class NoteSchemaMismatch extends Error {}

export interface NoteShape {
  mutation: 'requestCreateNote' | 'clientCreateNote';
  target: 'request' | 'client';
  idArg: string;
  idType: string;
  inputArg: string;
  inputType: string;
  messageField: string;
  /** Payload field holding the created note, when it has an id. */
  noteField: string | null;
  hasUserErrors: boolean;
}

/** The note mutations Jobber offers, best first: a note on the request, else on its client. Pure. */
export function noteMutationCandidates(fields: MutationField[]): Array<{ field: MutationField; target: 'request' | 'client' }> {
  const out: Array<{ field: MutationField; target: 'request' | 'client' }> = [];
  const request = fields.find((f) => f.name === 'requestCreateNote');
  if (request) out.push({ field: request, target: 'request' });
  const client = fields.find((f) => f.name === 'clientCreateNote');
  if (client) out.push({ field: client, target: 'client' });
  if (!out.length) throw new NoteSchemaMismatch('Jobber offers no requestCreateNote or clientCreateNote mutation.');
  return out;
}

/** The preferred note mutation by name only (the shape is checked in loadNoteShape). */
export function pickNoteMutation(fields: MutationField[]): { field: MutationField; target: 'request' | 'client' } {
  return noteMutationCandidates(fields)[0];
}

export function noteShape(field: MutationField, target: 'request' | 'client', inputFields: Field[], payloadFields: Field[]): NoteShape {
  const idName = target === 'request' ? 'requestId' : 'clientId';
  const idArg = field.args.find((a) => a.name === idName);
  const inputArg = field.args.find((a) => a.name !== idName && baseOf(a.type).kind === 'INPUT_OBJECT');
  if (!idArg || !inputArg) throw new NoteSchemaMismatch(`${field.name} has unexpected arguments.`);
  const otherRequired = field.args.filter((a) => a !== idArg && a !== inputArg && a.type.kind === 'NON_NULL');
  if (otherRequired.length) throw new NoteSchemaMismatch(`${field.name} requires ${otherRequired.map((a) => a.name).join(', ')}.`);
  const message = inputFields.find((f) => f.name === 'message');
  if (!message || !(baseOf(message.type).kind === 'SCALAR' && baseOf(message.type).name === 'String')) {
    throw new NoteSchemaMismatch(`${render(inputArg.type)} has no text message field.`);
  }
  const unknownRequired = inputFields.filter((f) => f.type.kind === 'NON_NULL' && f.name !== 'message');
  if (unknownRequired.length) throw new NoteSchemaMismatch(`${render(inputArg.type)} requires ${unknownRequired.map((f) => f.name).join(', ')}.`);
  const note = payloadFields.find((f) => f.name !== 'userErrors' && baseOf(f.type).kind === 'OBJECT' && /Note$/.test(String(baseOf(f.type).name)));
  return {
    mutation: field.name as NoteShape['mutation'],
    target,
    idArg: idArg.name,
    idType: render(idArg.type),
    inputArg: inputArg.name,
    inputType: render(inputArg.type),
    messageField: 'message',
    noteField: note?.name ?? null,
    hasUserErrors: payloadFields.some((f) => f.name === 'userErrors'),
  };
}

let cachedShape: { shape: NoteShape; at: number } | null = null;
const SHAPE_TTL_MS = 60 * 60_000;

/** For tests. */
export function resetNoteShapeCache() { cachedShape = null; }

export async function loadNoteShape(jobber: JobberReadClient, now: number = Date.now()): Promise<NoteShape> {
  if (cachedShape && now - cachedShape.at < SHAPE_TTL_MS) return cachedShape.shape;
  const data = await jobber.graphqlRequest<{ __schema?: { mutationType?: { fields?: MutationField[] } } }>(NOTE_MUTATIONS_QUERY);
  const problems: string[] = [];
  // A request note is best; when its shape is one Cotiza can't fill, a client note still keeps the record.
  for (const { field, target } of noteMutationCandidates(data.__schema?.mutationType?.fields ?? [])) {
    const inputArg = field.args.find((a) => a.name !== (target === 'request' ? 'requestId' : 'clientId') && baseOf(a.type).kind === 'INPUT_OBJECT');
    const payloadName = baseOf(field.type).name;
    if (!inputArg || !payloadName) { problems.push(`${field.name} has unexpected arguments.`); continue; }
    const types = await jobber.graphqlRequest<{ input?: { inputFields?: Field[] } | null; payload?: { fields?: Field[] } | null }>(
      NOTE_TYPES_QUERY, { input: String(baseOf(inputArg.type).name), payload: payloadName },
    );
    try {
      const shape = noteShape(field, target, types.input?.inputFields ?? [], types.payload?.fields ?? []);
      cachedShape = { shape, at: now };
      return shape;
    } catch (err) {
      if (!(err instanceof NoteSchemaMismatch)) throw err;
      problems.push(err.message);
    }
  }
  throw new NoteSchemaMismatch(problems.join(' '));
}

export function noteMutationText(shape: NoteShape): string {
  const noteSel = shape.noteField ? ` ${shape.noteField} { id }` : '';
  const errSel = shape.hasUserErrors ? ' userErrors { message }' : '';
  const selection = (noteSel + errSel).trim() || '__typename';
  return `mutation CotizaAddNote($id: ${shape.idType}, $input: ${shape.inputType}) {
  ${shape.mutation}(${shape.idArg}: $id, ${shape.inputArg}: $input) { ${selection} }
}`;
}

const REQUEST_CLIENT_QUERY = `query CotizaRequestClient($id: EncodedId!) { request(id: $id) { id client { id } } }`;
export const RECENT_NOTES_QUERY = `query CotizaRecentNotes($id: EncodedId!) {
  request(id: $id) { notes(first: 50) { edges { node { ... on RequestNote { id message } } } } }
}`;

export class JobberNoteRejected extends Error {}

/** "Z2lk…" → "35714897" (Jobber's web number for the request), or the raw id when it isn't a gid. */
export function requestNumber(requestId: string): string {
  try {
    const decoded = atob(requestId.replace(/-/g, '+').replace(/_/g, '/'));
    const m = /\/Request\/(\d+)$/.exec(decoded);
    if (m) return m[1];
  } catch { /* not base64 */ }
  return requestId;
}

/**
 * The text that actually goes to Jobber. A client note is not tied to a request, so it names the
 * request; that also keeps a lost write from matching the same words on another request.
 */
export function noteTextFor(target: 'request' | 'client', requestId: string, message: string): string {
  return target === 'client' ? `${message} · request ${requestNumber(requestId)}` : message;
}

/** Sends one note. Throws on any failure; JobberNoteRejected when Jobber answered with errors (nothing was written). */
export async function postJobberNote(jobber: JobberReadClient, requestId: string, message: string): Promise<{ noteId: string | null; mutation: string; target: 'request' | 'client' }> {
  const shape = await loadNoteShape(jobber);
  let targetId = requestId;
  if (shape.target === 'client') {
    const data = await jobber.graphqlRequest<{ request?: { client?: { id?: string } | null } | null }>(REQUEST_CLIENT_QUERY, { id: requestId });
    const clientId = data.request?.client?.id;
    if (!clientId) throw new JobberNoteRejected('The request has no client to attach the note to.');
    targetId = clientId;
  }
  const data = await jobber.graphqlRequest<Record<string, Record<string, unknown> | null>>(
    noteMutationText(shape), { id: targetId, input: { [shape.messageField]: noteTextFor(shape.target, requestId, message) } },
  );
  const payload = data[shape.mutation];
  const errors = (payload?.userErrors as Array<{ message?: string }> | undefined) ?? [];
  if (errors.length) throw new JobberNoteRejected(errors.map((e) => e.message).filter(Boolean).join('; ') || 'Jobber rejected the note.');
  if (!payload) throw new JobberNoteRejected('Jobber returned no result for the note.');
  const note = shape.noteField ? (payload[shape.noteField] as { id?: string } | null) : null;
  return { noteId: note?.id ?? null, mutation: shape.mutation, target: shape.target };
}

export const RECENT_CLIENT_NOTES_QUERY = `query CotizaRecentClientNotes($id: EncodedId!) {
  request(id: $id) { client { notes(first: 50) { edges { node { ... on ClientNote { id message } } } } } }
}`;

type NoteEdges = { edges?: Array<{ node?: { id?: string; message?: string } | null }> } | null | undefined;

function findNote(edges: NoteEdges, message: string) {
  const hit = (edges?.edges ?? []).map((e) => e.node).find((n) => (n?.message ?? '').trim() === message.trim());
  return { found: Boolean(hit), noteId: hit?.id ?? null };
}

/**
 * True when Jobber already carries this exact note (a write whose answer was lost). Looks where the
 * note would have gone: the request's notes, or its client's when Jobber only offers client notes.
 */
export async function noteAlreadyPosted(jobber: JobberReadClient, requestId: string, message: string): Promise<{ found: boolean; noteId: string | null }> {
  const shape = await loadNoteShape(jobber);
  if (shape.target === 'client') {
    const data = await jobber.graphqlRequest<{ request?: { client?: { notes?: NoteEdges } | null } | null }>(RECENT_CLIENT_NOTES_QUERY, { id: requestId });
    return findNote(data.request?.client?.notes, noteTextFor('client', requestId, message));
  }
  const data = await jobber.graphqlRequest<{ request?: { notes?: NoteEdges } | null }>(RECENT_NOTES_QUERY, { id: requestId });
  return findNote(data.request?.notes, message);
}

// ── Storage and retries ─────────────────────────────────────────────────────

export type NoteStatus = 'pending' | 'posting' | 'posted' | 'failed';

export interface JobberNoteRecord {
  id: string;
  requestId: string;
  message: string;
  status: NoteStatus;
  jobberNoteId: string | null;
  error: string | null;
  /** True when the last attempt may have reached Jobber (network error after sending). */
  uncertain: boolean;
  attempts: number;
  updatedAt: string;
}

type Row = {
  id: string; jobber_request_id: string; message: string; status: NoteStatus; jobber_note_id: string | null;
  error: string | null; uncertain: number; attempts: number; updated_at: string;
};

function toRecord(row: Row): JobberNoteRecord {
  return {
    id: row.id, requestId: row.jobber_request_id, message: row.message, status: row.status, jobberNoteId: row.jobber_note_id,
    error: row.error, uncertain: row.uncertain === 1, attempts: row.attempts, updatedAt: row.updated_at,
  };
}

/** A claim older than this is treated as abandoned (the worker died mid-write) and may be retried. */
const STALE_CLAIM_MS = 2 * 60_000;
export const NOTE_ID_RE = /^jn_[a-z_]+_[A-Za-z0-9_:=+/.-]{1,200}$/;

export function noteKey(kind: 'contact' | 'mark' | 'close' | 'review', ref: string): string {
  return `jn_${kind}_${ref}`;
}

/** A short, fixed-length stand-in for a request id inside a note key (ids can be long). */
export async function requestKeyPart(requestId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestId));
  return Array.from(new Uint8Array(digest).slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface NoteWriterDeps {
  db: D1Database;
  jobber: JobberReadClient | null;
  log?: (operation: string, description: string, severity: 'info' | 'error') => Promise<void>;
  now?: () => number;
}

export class JobberNoteWriter {
  constructor(private deps: NoteWriterDeps) {}

  private now() { return (this.deps.now ?? Date.now)(); }

  async get(id: string): Promise<JobberNoteRecord | null> {
    const row = await this.deps.db.prepare('SELECT * FROM lead_jobber_notes WHERE id = ?').bind(id).first<Row>();
    return row ? toRecord(row) : null;
  }

  /** Notes on a lead that did not make it to Jobber, newest first. */
  async unsent(requestId: string): Promise<JobberNoteRecord[]> {
    const { results } = await this.deps.db
      .prepare("SELECT * FROM lead_jobber_notes WHERE jobber_request_id = ? AND status <> 'posted' ORDER BY created_at DESC LIMIT 20")
      .bind(requestId)
      .all<Row>();
    return (results ?? []).map(toRecord);
  }

  /**
   * Records the note for one Cotiza action and writes it to Jobber once. Calling it again with the
   * same id never posts a second note: a posted note is returned as is, and one being written by
   * another request is left alone.
   */
  async write(id: string, requestId: string, message: string, userId: string): Promise<JobberNoteRecord> {
    if (!NOTE_ID_RE.test(id)) throw new Error('Invalid note id.');
    const at = new Date(this.now()).toISOString();
    await this.deps.db
      .prepare("INSERT OR IGNORE INTO lead_jobber_notes (id, jobber_request_id, message, status, attempts, uncertain, created_at, updated_at, created_by_user_id) VALUES (?, ?, ?, 'pending', 0, 0, ?, ?, ?)")
      .bind(id, requestId, message, at, at, userId)
      .run();
    return this.attempt(id, userId);
  }

  /** Tries an unsent note again. */
  async retry(id: string, userId: string): Promise<JobberNoteRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    return this.attempt(id, userId);
  }

  private async attempt(id: string, userId: string): Promise<JobberNoteRecord> {
    const now = this.now();
    const at = new Date(now).toISOString();
    const staleBefore = new Date(now - STALE_CLAIM_MS).toISOString();
    const token = crypto.randomUUID();
    // Taking over an abandoned 'posting' claim means that write may have landed: mark it uncertain so
    // Jobber is checked before posting again. The token makes only this attempt able to finish the row.
    const claim = await this.deps.db
      .prepare("UPDATE lead_jobber_notes SET uncertain = CASE WHEN status = 'posting' THEN 1 ELSE uncertain END, status = 'posting', attempts = attempts + 1, claim_token = ?, updated_at = ? WHERE id = ? AND (status IN ('pending', 'failed') OR (status = 'posting' AND updated_at < ?))")
      .bind(token, at, id, staleBefore)
      .run();
    const current = await this.get(id);
    if (!current) throw new Error('Note record vanished.');
    // Already posted, or another request is writing it right now: never post twice.
    if (!claim.meta?.changes) return current;

    const finish = async (status: NoteStatus, fields: { noteId?: string | null; error?: string | null; uncertain?: boolean }) => {
      // Only the attempt holding the claim may finish it; one that lost its claim leaves the row alone.
      await this.deps.db
        .prepare('UPDATE lead_jobber_notes SET status = ?, jobber_note_id = ?, error = ?, uncertain = ?, claim_token = NULL, updated_at = ? WHERE id = ? AND claim_token = ?')
        .bind(status, fields.noteId ?? null, fields.error ?? null, fields.uncertain ? 1 : 0, new Date(this.now()).toISOString(), id, token)
        .run();
      return (await this.get(id))!;
    };

    const jobber = this.deps.jobber;
    if (!jobber) {
      await this.deps.log?.('jobber_note', `note=${id} outcome=failed reason=jobber_not_connected`, 'error');
      return finish('failed', { error: 'Jobber is not connected.' });
    }
    try {
      // A previous attempt may have reached Jobber without us hearing back: look before writing again.
      if (current.uncertain) {
        const seen = await noteAlreadyPosted(jobber, current.requestId, current.message);
        if (seen.found) {
          await this.deps.log?.('jobber_note', `note=${id} outcome=posted (found existing) user=${userId}`, 'info');
          return finish('posted', { noteId: seen.noteId });
        }
      }
      const posted = await postJobberNote(jobber, current.requestId, current.message);
      await this.deps.log?.('jobber_note', `note=${id} outcome=posted via=${posted.mutation} user=${userId}`, 'info');
      return finish('posted', { noteId: posted.noteId });
    } catch (err) {
      const rejected = err instanceof JobberNoteRejected || err instanceof NoteSchemaMismatch;
      const reason = sanitizeLogText(err instanceof Error ? err.message : String(err)).slice(0, 200);
      await this.deps.log?.('jobber_note', `note=${id} outcome=failed reason=${reason}`, 'error');
      // A rejected write left nothing behind; any other failure may have reached Jobber.
      return finish('failed', { error: rejected ? reason : 'Jobber did not confirm the note.', uncertain: !rejected || current.uncertain });
    }
  }
}
