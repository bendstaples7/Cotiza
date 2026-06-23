import type { JobberRequestNote } from './types/quote.js';

const EMAIL_CONTEXT_START = '--- Email Conversation Context ---';
const EMAIL_CONTEXT_END = '--- End Email Context ---';

/** Jobber auto-notes that carry no scope for quoting (attachments-only submissions). */
const BOILERPLATE_NOTE_PATTERNS = [
  /^attachments from request submission$/i,
  /^photos? (attached|provided|included)( by client)?\.?$/i,
  /^see attached\.?$/i,
  /^image(s)? attached\.?$/i,
  /^files? attached\.?$/i,
];

/** True when a Jobber note is a system placeholder, not customer scope. */
export function isBoilerplateJobberNote(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return true;
  return BOILERPLATE_NOTE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** True when a stored/display client name is a Jobber placeholder, not a real person. */
export function isPlaceholderJobberClientName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
  const placeholders = new Set([
    'unknown',
    'home owner',
    'homeowner',
    'property owner',
    'customer',
    'client',
    'n/a',
    'na',
    'none',
    'test',
  ]);
  return placeholders.has(normalized);
}

/** SQLite/webhook placeholders stored as literal strings (e.g. "null"). */
export function isAbsentStoredValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed === '' || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined';
}

function normalizeStoredField(value: string | null | undefined): string | null {
  if (isAbsentStoredValue(value)) return null;
  return value!.trim();
}

function substantiveNotes(notes: JobberRequestNote[]): JobberRequestNote[] {
  return notes.filter((note) => !isBoilerplateJobberNote(note.message));
}

/** Display fields resolved from Jobber webhook columns + request_body JSON. */
export interface JobberRequestDisplayFields {
  customerName: string;
  requestTitle: string | null;
  /** Notes/description/form text for queue display (never duplicates title). */
  requestBodyText: string;
  /** Full text for AI quote generation (may include title fallback). */
  serviceDescription: string;
  noteHighlights: Array<{ label: string; message: string }>;
}

/** Extract customer email from a stored Jobber request_body value (JSON string or object). */
export function extractCustomerEmailFromRequestBody(requestBody: unknown): string | null {
  if (isAbsentStoredValue(requestBody)) return null;
  let detail: Record<string, unknown> | null = null;
  if (typeof requestBody === 'string') {
    try {
      const parsed = JSON.parse(requestBody);
      if (parsed == null || typeof parsed !== 'object') return null;
      detail = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (typeof requestBody === 'object') {
    detail = requestBody as Record<string, unknown>;
  }
  if (!detail) return null;

  const candidates = [
    detail.email,
    (detail.request as { email?: string } | undefined)?.email,
    (detail.client as { email?: string } | undefined)?.email,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function extractClientNameFromBody(detail: Record<string, unknown>): string | null {
  const companyName = typeof detail.companyName === 'string' ? detail.companyName.trim() : '';
  const contactName = typeof detail.contactName === 'string' ? detail.contactName.trim() : '';
  const client = detail.client as {
    firstName?: string;
    lastName?: string;
    companyName?: string;
  } | undefined;
  const fromClient = client
    ? `${client.firstName || ''} ${client.lastName || ''}`.trim() || (client.companyName?.trim() ?? '')
    : '';
  for (const candidate of [contactName, fromClient, companyName]) {
    if (candidate && !isPlaceholderJobberClientName(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Resolve customer name, title, description, and note highlights for queue/draft display. */
export function resolveJobberRequestFields(input: {
  clientName?: string | null;
  title?: string | null;
  description?: string | null;
  requestBody?: unknown;
  formText?: string | null;
}): JobberRequestDisplayFields {
  let detail: Record<string, unknown> | null = null;
  if (input.requestBody != null && !isAbsentStoredValue(input.requestBody)) {
    if (typeof input.requestBody === 'string') {
      try {
        const parsed = JSON.parse(input.requestBody);
        if (parsed != null && typeof parsed === 'object') {
          detail = parsed as Record<string, unknown>;
        }
      } catch {
        detail = null;
      }
    } else if (typeof input.requestBody === 'object') {
      detail = input.requestBody as Record<string, unknown>;
    }
  }

  const structuredNotes = detail ? parseStructuredNotesFromRequestBody(detail) : [];
  const titleFromBody = typeof detail?.title === 'string' ? detail.title.trim() : '';
  const requestTitle = (normalizeStoredField(input.title) || titleFromBody || null);
  const description = normalizeStoredField(input.description)
    || (typeof detail?.description === 'string' ? detail.description.trim() : '')
    || null;

  const storedName = normalizeStoredField(input.clientName);
  const nameFromBody = detail ? extractClientNameFromBody(detail) : null;
  const usableStoredName = storedName && !isPlaceholderJobberClientName(storedName) ? storedName : null;
  const usableBodyName = nameFromBody && !isPlaceholderJobberClientName(nameFromBody) ? nameFromBody : null;
  const customerName = usableStoredName || usableBodyName || 'Unknown';

  let requestBodyText = buildRequestBodyText({
    description,
    structuredNotes,
  });
  const formText = input.formText?.trim();
  if (!requestBodyText && formText) {
    requestBodyText = formText;
  }
  if (requestTitle && requestBodyText.trim() === requestTitle.trim()) {
    requestBodyText = '';
  }

  const serviceDescription = buildJobberCustomerText({
    title: requestTitle,
    description,
    structuredNotes,
  }) || formText || requestTitle || description || '';

  const noteHighlights = substantiveNotes(structuredNotes)
    .filter((n) => n.message.trim())
    .slice(0, 3)
    .map((n) => ({
      label: n.createdBy === 'client' ? 'Client' : n.createdBy === 'team' ? 'Team' : 'Note',
      message: n.message.trim(),
    }));

  return { customerName, requestTitle, requestBodyText, serviceDescription, noteHighlights };
}

/** Build display body from notes/description only — no title fallback. */
export function buildRequestBodyText(input: {
  description?: string | null;
  structuredNotes?: JobberRequestNote[];
}): string {
  const parts: string[] = [];
  const structuredNotes = input.structuredNotes ?? [];

  if (input.description) {
    const trimmedDesc = input.description.trim();
    if (trimmedDesc && !isBoilerplateJobberNote(trimmedDesc)) {
      const noteTexts = substantiveNotes(structuredNotes).map((n) => n.message.trim());
      const notesJoined = noteTexts.join('\n\n');
      if (trimmedDesc !== notesJoined) {
        parts.push(trimmedDesc);
      }
    }
  }

  for (const note of substantiveNotes(structuredNotes)) {
    const trimmed = note.message.trim();
    if (!trimmed) continue;
    const label =
      note.createdBy === 'team' ? '[Team Note]' :
      note.createdBy === 'client' ? '[Client]' :
      '[System]';
    parts.push(`${label} ${trimmed}`);
  }

  return parts.join('\n\n');
}

/** Build customer text from Jobber request notes/description (mirrors QuoteInputPage). */
export function buildJobberCustomerText(input: {
  title?: string | null;
  description?: string | null;
  structuredNotes?: JobberRequestNote[];
}): string {
  const parts: string[] = [];
  const structuredNotes = substantiveNotes(input.structuredNotes ?? []);

  if (input.description) {
    const trimmedDesc = input.description.trim();
    if (trimmedDesc && !isBoilerplateJobberNote(trimmedDesc)) {
      const noteTexts = structuredNotes.map((n) => n.message.trim());
      const notesJoined = noteTexts.join('\n\n');
      if (trimmedDesc !== notesJoined) {
        parts.push(trimmedDesc);
      }
    }
  }

  for (const note of structuredNotes) {
    const trimmed = note.message.trim();
    if (!trimmed) continue;
    const label =
      note.createdBy === 'team' ? '[Team Note]' :
      note.createdBy === 'client' ? '[Client]' :
      '[System]';
    parts.push(`${label} ${trimmed}`);
  }

  const body = parts.join('\n\n');
  const title = input.title?.trim() ?? '';

  if (!body) return title;
  if (!title) return body;
  if (body.toLowerCase().includes(title.toLowerCase())) return body;
  return `${title}\n\n${body}`;
}

/** Parse structured notes from a stored Jobber request_body JSON object. */
export function parseStructuredNotesFromRequestBody(detail: unknown): JobberRequestNote[] {
  const noteEdges = (detail as { notes?: { edges?: Array<{ node?: Record<string, unknown> }> } })?.notes?.edges ?? [];

  return noteEdges
    .map((edge) => {
      const node = edge.node;
      if (!node) return null;

      const typename = (node.createdBy as { __typename?: string } | undefined)?.__typename ?? '';
      let createdBy: JobberRequestNote['createdBy'] = 'system';
      if (typename === 'User' || typename === 'Staff') createdBy = 'team';
      else if (typename === 'Client') createdBy = 'client';

      const message = typeof node.message === 'string' ? node.message : '';
      if (!message.trim()) return null;

      return {
        message,
        createdBy,
        createdAt: typeof node.createdAt === 'string' ? node.createdAt : '',
      };
    })
    .filter((note): note is JobberRequestNote => note !== null);
}

/** Split stored customerRequestText into email context and core request text. */
export function splitEmailContextFromCustomerText(text: string): {
  emailContext: string | null;
  requestText: string;
} {
  const startIdx = text.indexOf(EMAIL_CONTEXT_START);
  if (startIdx === -1) {
    return { emailContext: null, requestText: text.trim() };
  }

  const endIdx = text.indexOf(EMAIL_CONTEXT_END, startIdx);
  const emailContext = endIdx === -1
    ? text.slice(startIdx).trim()
    : text.slice(startIdx, endIdx + EMAIL_CONTEXT_END.length).trim();

  const before = text.slice(0, startIdx);
  const after = endIdx === -1 ? '' : text.slice(endIdx + EMAIL_CONTEXT_END.length);
  const requestText = (before + after).trim();

  return { emailContext, requestText };
}

export interface ParsedEmailMessage {
  direction: 'Incoming' | 'Outgoing';
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

/** Parse individual email messages from a formatted email context block. */
export function parseEmailMessages(emailContext: string): ParsedEmailMessage[] {
  const messages: ParsedEmailMessage[] = [];
  const blocks = emailContext.split(/\n--- (Incoming|Outgoing) Email ---\n/).slice(1);

  for (let i = 0; i < blocks.length; i += 2) {
    const direction = blocks[i] as 'Incoming' | 'Outgoing';
    const bodyBlock = blocks[i + 1] ?? '';
    const lines = bodyBlock.split('\n');

    let from = '';
    let to = '';
    let subject = '';
    let date = '';
    const bodyLines: string[] = [];
    let inBody = false;

    for (const line of lines) {
      if (line.startsWith('From: ')) from = line.slice(6);
      else if (line.startsWith('To: ')) to = line.slice(4);
      else if (line.startsWith('Subject: ')) subject = line.slice(9);
      else if (line.startsWith('Date: ')) date = line.slice(6);
      else if (line.startsWith('Body: ')) {
        inBody = true;
        bodyLines.push(line.slice(6));
      } else if (inBody) {
        bodyLines.push(line);
      }
    }

    messages.push({
      direction,
      from,
      to,
      subject,
      date,
      body: bodyLines.join('\n').trim(),
    });
  }

  return messages;
}
