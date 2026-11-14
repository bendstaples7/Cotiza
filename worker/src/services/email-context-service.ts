import type { ActivityLogService } from './activity-log-service.js';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** Invoice bodies are capped so one huge email cannot exhaust Worker memory (card fae9e3e9). */
const INVOICE_BODY_MAX_CHARS = 50_000;
const INVOICE_HTML_MAX_CHARS = 200_000;
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_TIMEOUT_MS = 8_000;

// ── Types for Gmail API responses ──────────────────────

interface GmailThread {
  id: string;
  snippet: string;
  historyId?: string;
  messages?: GmailMessage[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    mimeType?: string;
    parts?: Array<{ mimeType: string; body?: { data?: string } }>;
    body?: { data?: string };
  };
  internalDate: string;
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate: number;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

// ── Service ──────────────────────────────────────────────────────

export class EmailContextService {
  private clientId: string;
  private clientSecret: string;
  private refreshToken: string;
  private activityLog?: ActivityLogService;
  private cachedAccessToken: string | null = null;
  /** Set when a Gmail call fails, so callers can tell a failed read from an empty history. */
  private lastReadFailed = false;
  private tokenExpiresAt: number = 0;

  constructor(
    clientId: string | undefined,
    clientSecret: string | undefined,
    refreshToken: string | undefined,
    activityLog?: ActivityLogService,
  ) {
    this.clientId = clientId ?? '';
    this.clientSecret = clientSecret ?? '';
    this.refreshToken = refreshToken ?? '';
    this.activityLog = activityLog;
  }

  /**
   * Returns true if the service is configured with credentials.
   */
  isAvailable(): boolean {
    return this.clientId.length > 0 && this.clientSecret.length > 0 && this.refreshToken.length > 0;
  }

  // ── OAuth token management ─────────────────────────────────────

  private async getAccessToken(): Promise<string | null> {
    // Return cached token if still valid (with 5 min buffer)
    if (this.cachedAccessToken && Date.now() < this.tokenExpiresAt - 300_000) {
      return this.cachedAccessToken;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      const res = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: this.refreshToken,
          grant_type: 'refresh_token',
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        return null;
      }

      const data = (await res.json()) as TokenResponse;
      this.cachedAccessToken = data.access_token;
      this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
      return this.cachedAccessToken;
    } catch {
      return null;
    }
  }

  // ── Private HTTP helpers ───────────────────────────────────────

  private async apiFetch<T>(accessToken: string, path: string): Promise<T | null> {
    const url = GMAIL_API_BASE + path;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + accessToken },
        signal: controller.signal,
      });
      if (!res.ok) {
        this.lastReadFailed = true;
        return null;
      }
      return (await res.json()) as T;
    } catch {
      this.lastReadFailed = true;
      return null; // network failure or timeout — graceful degradation
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Decode base64 Gmail body ───────────────────────────────────

  private decodeBase64(data: string, maxChars = 500): string {
    // Gmail uses URL-safe base64 with padding
    try {
      // Replace URL-safe chars and fix padding
      const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
      // Use atob in the worker environment (Cloudflare Workers have it)
      const decoded = atob(padded);
      // Conversation context caps body text to 500 chars to avoid bloating the prompt
      return decoded.slice(0, maxChars);
    } catch {
      return '';
    }
  }

  // ── Extract plain text from message parts ──────────────────────

  private extractTextFromParts(parts: Array<{ mimeType: string; body?: { data?: string } }>): string {
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return this.decodeBase64(part.body.data);
      }
    }
    // Fallback: look in nested parts
    for (const part of parts) {
      if (part.mimeType === 'multipart/alternative' && (part as any).parts) {
        return this.extractTextFromParts((part as any).parts);
      }
    }
    return '';
  }

  // ── Extract header value ───────────────────────────────────────

  private getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
    return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
  }

  // ── Fetch messages ─────────────────────────────────────────────

  /**
   * Fetch recent email messages involving the given customer email address.
   * Searches for messages from or to this address, limited to the 3 most recent.
   */
  private async fetchMessages(accessToken: string, customerEmail: string): Promise<GmailMessage[]> {
    // Search for messages involving this email address
    const query = encodeURIComponent(`from:${customerEmail} OR to:${customerEmail}`);
    const listResult = await this.apiFetch<GmailListResponse>(
      accessToken,
      `/messages?q=${query}&maxResults=3`,
    );

    if (!listResult?.messages || listResult.messages.length === 0) {
      return [];
    }

    // Fetch each message detail in parallel
    const messagePromises = listResult.messages.map((msgRef) =>
      this.apiFetch<GmailMessage>(
        accessToken,
        `/messages/${msgRef.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
      )
    );
    const results = await Promise.all(messagePromises);
    const messages = results.filter((msg): msg is GmailMessage => msg !== null);

    // Sort by internalDate descending (newest first)
    messages.sort((a, b) => parseInt(b.internalDate) - parseInt(a.internalDate));

    return messages;
  }

  // ── Format messages into readable text ─────────────────────────

  private formatMessages(messages: GmailMessage[], customerEmail: string): string {
    if (messages.length === 0) return '';

    const parts: string[] = [];

    for (const msg of messages) {
      const headers = msg.payload?.headers ?? [];
      const from = this.getHeader(headers, 'From');
      const to = this.getHeader(headers, 'To');
      const subject = this.getHeader(headers, 'Subject');
      const date = this.getHeader(headers, 'Date');

      // Try to get body text
      let body = msg.snippet || '';
      if (msg.payload?.parts) {
        const extractedText = this.extractTextFromParts(msg.payload.parts);
        if (extractedText) body = extractedText;
      } else if (msg.payload?.body?.data) {
        body = this.decodeBase64(msg.payload.body.data);
      }

      // Format date nicely
      let formattedDate = date;
      try {
        const d = new Date(msg.internalDate ? parseInt(msg.internalDate) : Date.parse(date));
        if (!isNaN(d.getTime())) {
          formattedDate = d.toLocaleString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
          });
        }
      } catch {
        // Keep original date string
      }

      const fromAddr = extractEmail(from);
      const direction = fromAddr.toLowerCase() === customerEmail.toLowerCase() ? 'Incoming' : 'Outgoing';

      parts.push(`--- ${direction} Email ---`);
      parts.push(`From: ${from}`);
      parts.push(`To: ${to}`);
      parts.push(`Subject: ${subject}`);
      parts.push(`Date: ${formattedDate}`);
      if (body) {
        parts.push(`Body: ${body}`);
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  // ── Public API ─────────────────────────────────────────────────

  /**
   * When Jobber does not provide an email, search Gmail for threads mentioning
   * the client name and extract a customer address from message snippets/headers.
   */
  async findCustomerEmailByName(clientName: string): Promise<string | null> {
    const normalizedName = clientName.trim();
    if (!this.isAvailable() || !normalizedName) return null;

    const accessToken = await this.getAccessToken();
    if (!accessToken) return null;

    const lastName = normalizedName.split(/\s+/).pop();
    const queries = [normalizedName];
    if (lastName && lastName !== normalizedName) {
      queries.push(lastName);
    }
    const seenIds = new Set<string>();
    const nameParts = normalizedName.toLowerCase().split(/\s+/).filter((part) => part.length > 2);
    let bestEmail: string | null = null;
    let bestScore = -1;

    for (const rawQuery of queries) {
      const query = encodeURIComponent(rawQuery.includes(' ') ? `"${rawQuery}"` : rawQuery);
      const listResult = await this.apiFetch<GmailListResponse>(
        accessToken,
        `/messages?q=${query}&maxResults=5`,
      );
      if (!listResult?.messages?.length) continue;

      const newRefs = listResult.messages.filter((msgRef) => !seenIds.has(msgRef.id));
      for (const msgRef of newRefs) {
        seenIds.add(msgRef.id);
      }

      const messageDetails = await Promise.all(
        newRefs.map((msgRef) => this.apiFetch<GmailMessage & { snippet?: string }>(
          accessToken,
          `/messages/${msgRef.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`,
        )),
      );

      for (const msg of messageDetails) {
        if (!msg) continue;

        const headerText = (msg.payload?.headers ?? [])
          .filter((h) => ['From', 'To', 'Subject'].includes(h.name))
          .map((h) => h.value)
          .join(' ');
        const candidate = pickCustomerEmail(
          `${headerText}\n${msg.snippet ?? ''}`,
          normalizedName,
        );
        if (!candidate) continue;
        const score = scoreCustomerEmail(candidate, nameParts);
        if (score > bestScore) {
          bestScore = score;
          bestEmail = candidate;
        }
      }
    }

    return bestEmail;
  }

  /**
   * Fetch email conversation context for a customer email address.
   * Returns a formatted string of recent email exchanges that can be
   * prepended to the customer text for quote generation context.
   *
   * Gracefully degrades: returns empty string if credentials are missing,
   * network fails, or no emails are found.
   */
  async fetchContext(customerEmail: string): Promise<string> {
    if (!this.isAvailable() || !customerEmail) {
      return '';
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(customerEmail)) {
      return '';
    }

    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      return '';
    }

    const messages = await this.fetchMessages(accessToken, customerEmail);

    if (messages.length === 0) {
      return '';
    }

    const parts: string[] = [
      '--- Email Conversation Context ---',
      '',
      this.formatMessages(messages, customerEmail),
      '--- End Email Context ---',
    ];

    return parts.join('\n');
  }

  /**
   * Emails with the customer as dated events (newest first), for last-contact tracking. Bodies
   * are not returned. A failed read is reported, never an empty history.
   */
  async fetchActivityResult(customerEmail: string): Promise<
    { status: 'ok'; events: Array<{ at: string; direction: 'incoming' | 'outgoing' }> } | { status: 'failed' }
  > {
    this.lastReadFailed = false;
    if (!this.isAvailable() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) return { status: 'ok', events: [] };
    const accessToken = await this.getAccessToken();
    if (!accessToken) return { status: 'failed' };
    const messages = await this.fetchMessages(accessToken, customerEmail);
    if (this.lastReadFailed) return { status: 'failed' };
    const events = messages.map((msg) => {
      const from = extractEmail(this.getHeader(msg.payload?.headers ?? [], 'From'));
      const ms = Number(msg.internalDate);
      return {
        at: Number.isFinite(ms) ? new Date(ms).toISOString() : '',
        direction: from.toLowerCase() === customerEmail.toLowerCase() ? 'incoming' as const : 'outgoing' as const,
      };
    }).filter((e) => e.at);
    return { status: 'ok', events };
  }

  /** Like fetchContext, but reports a failed read instead of returning an empty string for it. */
  async fetchContextResult(customerEmail: string): Promise<{ status: 'ok'; text: string } | { status: 'failed' }> {
    this.lastReadFailed = false;
    if (this.isAvailable() && !(await this.getAccessToken())) return { status: 'failed' };
    const text = await this.fetchContext(customerEmail);
    return this.lastReadFailed ? { status: 'failed' } : { status: 'ok', text };
  }

  /** Recent PDF invoice emails for the dry-run invoice poller (card fae9e3e9). Throws when Gmail cannot be read. */
  async fetchInvoiceMessages(limit = 25): Promise<import('./invoice-inbox-scan.js').GmailInvoiceMessage[]> {
    if (!this.isAvailable()) return [];
    this.lastReadFailed = false;
    const accessToken = await this.getAccessToken();
    if (!accessToken) throw new Error('Gmail token refresh failed');
    const list = await this.apiFetch<GmailListResponse>(
      accessToken,
      '/messages?q=' + encodeURIComponent('newer_than:2d (has:attachment filename:pdf OR from:messaging.squareup.com subject:"You paid an invoice")') + '&maxResults=' + limit,
    );
    if (this.lastReadFailed) throw new Error('Gmail invoice list read failed');
    const messages: import('./invoice-inbox-scan.js').GmailInvoiceMessage[] = [];
    for (const ref of (list?.messages ?? []).slice(0, limit)) {
      const msg = await this.apiFetch<GmailMessage>(accessToken, `/messages/${ref.id}?format=full`);
      if (this.lastReadFailed || !msg) throw new Error('Gmail invoice message read failed');
      const collected = { texts: [] as string[], names: [] as string[], htmls: [] as string[] };
      collectMimeParts(msg.payload, collected);
      messages.push({
        id: ref.id,
        threadId: msg.threadId,
        from: this.getHeader(msg.payload?.headers ?? [], 'From'),
        subject: this.getHeader(msg.payload?.headers ?? [], 'Subject'),
        bodyText: collected.texts.map((data) => this.decodeBase64(data, Infinity)).filter(Boolean).join('\n').slice(0, INVOICE_BODY_MAX_CHARS),
        snippet: msg.snippet,
        attachmentNames: collected.names,
        receiptUrl: squareInvoiceLink(collected.htmls.map((data) => this.decodeBase64(data, INVOICE_HTML_MAX_CHARS)).join('\n').slice(0, INVOICE_HTML_MAX_CHARS)),
      });
    }
    return messages;
  }

  /** Mailbox the Gmail token reads, for the invoice poller log line (card fae9e3e9). Never throws. */
  async fetchMailboxAddress(): Promise<string | null> {
    if (!this.isAvailable()) return null;
    const accessToken = await this.getAccessToken();
    if (!accessToken) return null;
    const profile = await this.apiFetch<{ emailAddress?: string }>(accessToken, '/profile');
    return profile?.emailAddress ?? null;
  }

  /** Add one label to one message, creating it once when missing. A missing `gmail.modify` scope is
   *  a reason to skip, never retried and never allowed to undo a logged row. */
  async addLabel(messageId: string, name: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.isAvailable()) return { ok: false, reason: 'not configured' };
    const token = await this.getAccessToken();
    if (!token) return { ok: false, reason: 'no access token' };
    const list = await this.apiFetch<{ labels?: Array<{ id?: string; name?: string }> }>(token, '/labels');
    let id = (list?.labels ?? []).find((label) => label.name === name)?.id;
    if (!id) {
      const created = await this.gmailPost<{ id?: string }>(token, '/labels', { name });
      if (!created.ok) return { ok: false, reason: created.status === 403 ? 'needs gmail.modify' : `Gmail ${created.status}` };
      id = created.data?.id;
    }
    if (!id) return { ok: false, reason: 'Gmail label create returned no id' };
    const res = await this.gmailPost(token, `/messages/${messageId}/modify`, { addLabelIds: [id] });
    return res.ok ? { ok: true } : { ok: false, reason: res.status === 403 ? 'needs gmail.modify' : `Gmail ${res.status}` };
  }

  /** POST one JSON body; status is returned so 403 is told apart from a 5xx. */
  private async gmailPost<T>(token: string, path: string, body: unknown): Promise<{ ok: boolean; status: number; data: T | null }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetch(GMAIL_API_BASE + path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) return { ok: false, status: res.status, data: null };
      return { ok: true, status: res.status, data: (await res.json()) as T };
    } catch {
      return { ok: false, status: 0, data: null };
    } finally {
      clearTimeout(timer);
    }
  }
}

interface MimePartLike {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: MimePartLike[];
}

/** Depth-first walk of a Gmail MIME tree: every text body and every attachment filename. */
function collectMimeParts(part: MimePartLike | undefined, acc: { texts: string[]; names: string[]; htmls: string[] }): void {
  if (!part) return;
  if (part.filename) acc.names.push(part.filename);
  if (part.mimeType === 'text/plain' && part.body?.data) acc.texts.push(part.body.data);
  if (part.mimeType === 'text/html' && part.body?.data) acc.htmls.push(part.body.data);
  for (const child of part.parts ?? []) collectMimeParts(child, acc);
}

/** The one Square invoice link in an email body; null when none or more than one. */
export function squareInvoiceLink(html: string): string | null {
  const links = new Set<string>();
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>()]+/g)) {
    let url: URL;
    try {
      url = new URL(match[0].replace(/&amp;/g, '&'));
    } catch {
      continue;
    }
    if (url.hostname === 'a.squareupmessaging.com' && url.pathname.startsWith('/CL0/')) {
      links.add(url.toString());
    } else if ((url.hostname === 'squareup.com' || url.hostname === 'app.squareup.com') && /^\/(?:invoices?|receipts?)(?:\/|$)/.test(url.pathname)) {
      links.add(url.toString());
    }
  }
  return links.size === 1 ? [...links][0] : null;
}

/** Extract the email address from a "Name <email@example.com>" header value. */
function extractEmail(header: string): string {
  const match = header.match(/<([^>]+)>/);
  return match ? match[1] : header.trim();
}

function isCompanyEmail(email: string): boolean {
  const lower = email.toLowerCase();
  return lower.endsWith('@chicago-reno.com') || lower.endsWith('@chicagoreno.com');
}

function isAutomatedEmail(email: string): boolean {
  const lower = email.toLowerCase();
  return lower.includes('noreply')
    || lower.includes('no-reply')
    || lower.includes('getjobber.com')
    || lower.includes('xsmtpapi')
    || lower.includes('@em9688.')
    || /\.ip-\d/i.test(lower);
}

/** Pick the best customer email from message text (Jobber notifications include email in snippet). */
function pickCustomerEmail(text: string, clientName: string): string | null {
  const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
  const nameParts = clientName.toLowerCase().split(/\s+/).filter((part) => part.length > 2);
  const candidates = [...new Set(matches)]
    .filter((email) => !isCompanyEmail(email) && !isAutomatedEmail(email))
    .sort((a, b) => scoreCustomerEmail(b, nameParts) - scoreCustomerEmail(a, nameParts));
  return candidates[0] ?? null;
}

function scoreCustomerEmail(email: string, nameParts: string[]): number {
  const lower = email.toLowerCase();
  let score = 0;
  for (const part of nameParts) {
    if (lower.includes(part)) score += 2;
  }
  if (lower.endsWith('@gmail.com') || lower.endsWith('@yahoo.com') || lower.endsWith('@hotmail.com')) {
    score += 1;
  }
  return score;
}