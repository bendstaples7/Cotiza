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
        return null;
      }
      return (await res.json()) as T;
    } catch {
      return null;  // network failure or timeout — graceful degradation
    } finally {
      clearTimeout(timeout);
    }
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
  private async fetchMessages(customerPhone: string): Promise<OpenPhoneMessage[]> {
    if (!this.phoneNumberId) return [];

    const result = await this.apiFetch<ApiListResponse<OpenPhoneMessage>>(
      '/messages',
      {
        phoneNumberId: this.phoneNumberId,
        participants: JSON.stringify([customerPhone]),
        maxResults: '20',
      },
    );
    return result?.data ?? [];
  }

  // ── Fetch calls ────────────────────────────────────────────────

  /**
   * Fetch recent calls between our OpenPhone number and the customer.
   */
  private async fetchCalls(customerPhone: string): Promise<OpenPhoneCall[]> {
    if (!this.phoneNumberId) return [];

    const result = await this.apiFetch<ApiListResponse<OpenPhoneCall>>(
      '/calls',
      {
        phoneNumberId: this.phoneNumberId,
        participants: JSON.stringify([customerPhone]),
        maxResults: '10',
      },
    );
    return result?.data ?? [];
  }

  // ── Fetch transcripts and summaries for completed calls ────────

  private async fetchTranscript(callId: string): Promise<OpenPhoneTranscript | null> {
    return this.apiFetch<{ data: OpenPhoneTranscript }>(`/call-transcripts/${callId}`)
      .then(r => r?.data ?? null);
  }

  private async fetchCallSummary(callId: string): Promise<OpenPhoneCallSummary | null> {
    return this.apiFetch<{ data: OpenPhoneCallSummary }>(`/call-summaries/${callId}`)
      .then(r => r?.data ?? null);
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

    const normalizedPhone = customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`;

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
}