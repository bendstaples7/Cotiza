import type { ActivityLogService } from './activity-log-service.js';

const OPENPHONE_API_BASE = 'https://api.openphone.com/v1';
const API_TIMEOUT_MS = 8_000;

// ── Types for OpenPhone API responses ──────────────────────

interface OpenPhoneConversation {
  id: string;
  name: string | null;
  participants: string[];
  lastActivityAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  phoneNumberId: string;
}

interface OpenPhoneMessage {
  id: string;
  to: string[];
  from: string;
  text: string;
  direction: 'incoming' | 'outgoing';
  status: string;
  createdAt: string;
  userId: string | null;
}

interface OpenPhoneCall {
  id: string;
  direction: 'incoming' | 'outgoing';
  status: string;
  duration: number;
  participants: string[];
  answeredAt: string | null;
  completedAt: string | null;
  createdAt: string;
  aiHandled: string | null;
}

interface OpenPhoneTranscript {
  callId: string;
  status: string;
  dialogue: Array<{ content: string; start: number; end: number; identifier: string | null }> | null;
  duration: number;
}

interface OpenPhoneCallSummary {
  callId: string;
  status: string;
  summary: string[] | null;
  nextSteps: string[] | null;
}

interface OpenPhoneNumber {
  id: string;
}

interface ApiListResponse<T> {
  data: T[];
  totalItems: number;
  nextPageToken: string | null;
}

// ── Service ──────────────────────────────────────────────────────

export class PhoneContextService {
  private apiKey: string;
  private phoneNumberId: string | null;
  private activityLog?: ActivityLogService;
  /** Set when a Quo call fails, so callers can tell a failed read from an empty history. */
  private lastReadFailed = false;
  /** Our Quo number ids: the configured one, or every number in the workspace (looked up once). */
  private numberIds: Promise<string[]> | null = null;

  constructor(
    apiKey: string,
    phoneNumberId: string | null = null,
    activityLog?: ActivityLogService,
  ) {
    this.apiKey = apiKey;
    this.phoneNumberId = phoneNumberId;
    this.activityLog = activityLog;
  }

  /**
   * Returns true if the service is configured with an API key.
   */
  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  // ── Private HTTP helpers ───────────────────────────────────────

  private async apiFetch<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
    const url = new URL(OPENPHONE_API_BASE + path);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const res = await fetch(url.toString(), {
        headers: { Authorization: this.apiKey },
        signal: controller.signal,
      });
      if (!res.ok) {
        // Non-200 means the API key is missing, expired, or the phone number lookup failed
        this.lastReadFailed = true;
        return null;
      }
      return (await res.json()) as T;
    } catch {
      this.lastReadFailed = true;
      return null;  // network failure or timeout — graceful degradation
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * The Quo numbers to search. QUO_PHONE_NUMBER_ID is optional: without it, every number in the
   * workspace is used (GET /phone-numbers). A failed lookup marks the read as failed.
   */
  protected ourNumberIds(): Promise<string[]> {
    if (this.phoneNumberId) return Promise.resolve([this.phoneNumberId]);
    if (!this.numberIds) {
      this.numberIds = this.apiFetch<{ data?: OpenPhoneNumber[] }>('/phone-numbers').then((result) => {
        if (!result || !Array.isArray(result.data)) {
          this.lastReadFailed = true;
          this.numberIds = null; // try again on the next read rather than caching a failure
          return [];
        }
        return result.data.map((n) => n.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
      });
    }
    return this.numberIds;
  }

  // ── Fetch conversations ────────────────────────────────────────

  /**
   * Fetch conversations involving the given customer phone number.
   * Uses the conversations endpoint which can be filtered by participant phone number.
   */
  private async fetchConversations(customerPhone: string): Promise<OpenPhoneConversation[]> {
    const result = await this.apiFetch<ApiListResponse<OpenPhoneConversation>>(
      '/conversations',
      {
        maxResults: '10',
        phoneNumbers: JSON.stringify([customerPhone]),
      },
    );
    return result?.data ?? [];
  }

  // ── Fetch messages ─────────────────────────────────────────────

  /**
   * Fetch recent text messages between our OpenPhone number and the customer.
   * Requires phoneNumberId (our OpenPhone number's ID) to be configured.
   */
  protected async fetchMessages(customerPhone: string): Promise<OpenPhoneMessage[]> {
    const ids = await this.ourNumberIds();
    const pages = await Promise.all(ids.map((phoneNumberId) => this.apiFetch<ApiListResponse<OpenPhoneMessage>>(
      '/messages',
      {
        phoneNumberId,
        participants: JSON.stringify([customerPhone]),
        maxResults: '20',
      },
    )));
    return newestFirst(pages.flatMap((page) => page?.data ?? [])).slice(0, 20);
  }

  // ── Fetch calls ────────────────────────────────────────────────

  /**
   * Fetch recent calls between our OpenPhone number and the customer.
   */
  protected async fetchCalls(customerPhone: string): Promise<OpenPhoneCall[]> {
    const ids = await this.ourNumberIds();
    const pages = await Promise.all(ids.map((phoneNumberId) => this.apiFetch<ApiListResponse<OpenPhoneCall>>(
      '/calls',
      {
        phoneNumberId,
        participants: JSON.stringify([customerPhone]),
        maxResults: '10',
      },
    )));
    return newestFirst(pages.flatMap((page) => page?.data ?? [])).slice(0, 10);
  }

  // ── Fetch transcripts and summaries for completed calls ────────

  // Transcripts and summaries are often absent (short calls, plan limits): a missing one is not a failed read.
  private async fetchTranscript(callId: string): Promise<OpenPhoneTranscript | null> {
    const failedBefore = this.lastReadFailed;
    const result = await this.apiFetch<{ data: OpenPhoneTranscript }>(`/call-transcripts/${callId}`);
    this.lastReadFailed = failedBefore;
    return result?.data ?? null;
  }

  private async fetchCallSummary(callId: string): Promise<OpenPhoneCallSummary | null> {
    const failedBefore = this.lastReadFailed;
    const result = await this.apiFetch<{ data: OpenPhoneCallSummary }>(`/call-summaries/${callId}`);
    this.lastReadFailed = failedBefore;
    return result?.data ?? null;
  }

  // ── Format messages into readable text ─────────────────────────

  private formatMessages(messages: OpenPhoneMessage[]): string {
    if (messages.length === 0) return '';

    const parts: string[] = [];
    for (const msg of messages.slice().reverse()) {
      const sender = msg.direction === 'incoming' ? '[Customer]' : '[Business]';
      const time = msg.createdAt ? new Date(msg.createdAt).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      }) : '';
      parts.push(`${sender} (${time}): ${msg.text}`);
    }
    return parts.join('\n');
  }

  // ── Format calls into readable text ────────────────────────────

  private async formatCalls(calls: OpenPhoneCall[]): Promise<string> {
    if (calls.length === 0) return '';

    const parts: string[] = [];
    for (const call of calls) {
      const dir = call.direction === 'incoming' ? 'Incoming call' : 'Outgoing call';
      const time = call.createdAt ? new Date(call.createdAt).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      }) : '';
      const dur = call.duration > 0 ? `${Math.round(call.duration / 60)}m ${call.duration % 60}s` : 'no answer';
      parts.push(`- ${dir} (${time}) — ${dur} — status: ${call.status}`);

      // Try to enrich with transcript and summary (graceful if unavailable)
      if (call.status === 'completed' && call.duration > 0) {
        const [transcript, summary] = await Promise.all([
          this.fetchTranscript(call.id),
          this.fetchCallSummary(call.id),
        ]);
        if (summary?.summary && summary.summary.length > 0) {
          parts.push(`  Summary: ${summary.summary.join('; ')}`);
        }
        if (summary?.nextSteps && summary.nextSteps.length > 0) {
          parts.push(`  Action items: ${summary.nextSteps.join(', ')}`);
        }
        if (transcript?.dialogue && transcript.dialogue.length > 0) {
          const dialogueText = transcript.dialogue
            .map(d => {
              const speaker = d.identifier ? (d.identifier === call.participants.find(p => p.startsWith('+')) ? '[Customer]' : '[Business]') : '[Unknown]';
              return `  ${speaker}: ${d.content}`;
            })
            .join('\n');
          parts.push(`  Transcript:\n${dialogueText}`);
        }
      }
    }
    return parts.join('\n');
  }

  // ── Public API ─────────────────────────────────────────────────

  /**
   * Fetch phone conversation context for a customer phone number.
   * Returns a formatted string of phone conversations, messages, and call logs
   * that can be prepended to the customer text for quote generation context.
   *
   * Gracefully degrades: returns empty string if API key is missing, network
   * fails, or no conversations are found.
   */
  async fetchContext(customerPhone: string): Promise<string> {
    if (!this.isAvailable()) {
      return '';
    }

    const normalizedPhone = toE164(customerPhone);
    if (!normalizedPhone) return '';

    const [conversations, messages, calls] = await Promise.all([
      this.fetchConversations(normalizedPhone),
      this.fetchMessages(normalizedPhone),
      this.fetchCalls(normalizedPhone),
    ]);

    if (conversations.length === 0 && messages.length === 0 && calls.length === 0) {
      return '';
    }

    const parts: string[] = ['--- Phone Conversation Context ---'];

    if (messages.length > 0) {
      parts.push('\n[Text Messages]:');
      parts.push(this.formatMessages(messages));
    }

    if (calls.length > 0) {
      parts.push('\n[Call History]:');
      const callDetails = await this.formatCalls(calls);
      parts.push(callDetails);
    }

    if (conversations.length > 0 && messages.length === 0 && calls.length === 0) {
      // Conversations exist but we couldn't fetch messages or calls (e.g., no phoneNumberId)
      parts.push(`\n[Conversation Threads Found: ${conversations.length}]`);
      for (const conv of conversations) {
        const lastActive = conv.lastActivityAt
          ? new Date(conv.lastActivityAt).toLocaleString('en-US', {
              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            })
          : 'unknown';
        parts.push(`- ${conv.name ?? 'Unnamed'} (last activity: ${lastActive})`);
      }
    }

    parts.push('\n--- End Phone Context ---');
    return parts.join('\n');
  }

  /**
   * Sends one text from our Quo number (QUO_PHONE_NUMBER_ID, or the workspace's first number).
   * Only called after a team member confirms the exact text in Cotiza. Never retried
   * automatically: a failed send might still have gone out.
   */
  async sendText(customerPhone: string, content: string): Promise<{ status: 'sent'; id: string | null } | { status: 'failed'; reason: string }> {
    const to = toE164(customerPhone);
    if (!this.isAvailable()) return { status: 'failed', reason: 'Quo is not connected.' };
    if (!to) return { status: 'failed', reason: 'The customer has no usable phone number in Jobber.' };
    this.lastReadFailed = false;
    const [from] = await this.ourNumberIds();
    if (this.lastReadFailed) return { status: 'failed', reason: 'Could not read Chicago Reno\'s Quo numbers, so nothing was sent. Try again in a minute.' };
    if (!from) return { status: 'failed', reason: 'There is no Quo number to send from, so nothing was sent.' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetch(OPENPHONE_API_BASE + '/messages', {
        method: 'POST',
        headers: { Authorization: this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, from, to: [to] }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // A 4xx is a refusal; a 5xx doesn't prove the text didn't go out.
        return res.status >= 500
          ? { status: 'failed', reason: `Quo returned an error (HTTP ${res.status}). The text may have gone out: check Quo before sending again.` }
          : { status: 'failed', reason: `Quo did not send the text (HTTP ${res.status}).` };
      }
      const body = await res.json().catch(() => null) as { data?: { id?: string } } | null;
      return { status: 'sent', id: body?.data?.id ?? null };
    } catch {
      return { status: 'failed', reason: 'Quo could not be reached; check Quo before sending again.' };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Texts and calls with the customer as dated events (newest first), for last-contact tracking.
   * Message text is not returned. A failed read is reported, never an empty history.
   */
  async fetchActivityResult(customerPhone: string): Promise<
    { status: 'ok'; events: Array<{ at: string; kind: 'text' | 'call'; direction: 'incoming' | 'outgoing'; answered: boolean }> } | { status: 'failed' }
  > {
    this.lastReadFailed = false;
    const phone = toE164(customerPhone);
    if (!this.isAvailable() || !phone) return { status: 'ok', events: [] };
    const [messages, calls] = await Promise.all([this.fetchMessages(phone), this.fetchCalls(phone)]);
    if (this.lastReadFailed) return { status: 'failed' };
    const events = [
      ...messages.map((m) => ({ at: m.createdAt, kind: 'text' as const, direction: m.direction, answered: true })),
      ...calls.map((c) => ({ at: c.createdAt, kind: 'call' as const, direction: c.direction, answered: c.duration > 0 })),
    ].filter((e) => Number.isFinite(Date.parse(e.at)));
    events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { status: 'ok', events };
  }

  /** Like fetchContext, but reports a failed read instead of returning an empty string for it. */
  async fetchContextResult(customerPhone: string): Promise<{ status: 'ok'; text: string } | { status: 'failed' }> {
    this.lastReadFailed = false;
    const text = await this.fetchContext(customerPhone);
    return this.lastReadFailed ? { status: 'failed' } : { status: 'ok', text };
  }
}

/** Newest first by createdAt; entries without a date go last. */
function newestFirst<T extends { createdAt?: string | null }>(items: T[]): T[] {
  const at = (item: T) => {
    const ms = Date.parse(item.createdAt ?? '');
    return Number.isFinite(ms) ? ms : -Infinity;
  };
  return [...items].sort((a, b) => at(b) - at(a));
}

/**
 * A US phone number as Quo expects it (+1XXXXXXXXXX). Jobber stores numbers like "(773) 555-0100";
 * numbers already in +E.164 form are kept. Returns null when no usable number is left.
 */
export function toE164(raw: string): string | null {
  // Drop an extension ("x123", "ext. 123"): Quo matches the main number only.
  const trimmed = raw.trim().replace(/\s*(?:x|ext\.?|extension)\s*\d+\s*$/i, '');
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return digits.length >= 8 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits.length >= 8 ? `+${digits}` : null;
}
