import type { ActivityLogService } from './activity-log-service.js';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
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
  private tokenExpiresAt: number = 0;

  constructor(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
    activityLog?: ActivityLogService,
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
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
        return null;
      }
      return (await res.json()) as T;
    } catch {
      return null; // network failure or timeout — graceful degradation
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Decode base64 Gmail body ───────────────────────────────────

  private decodeBase64(data: string): string {
    // Gmail uses URL-safe base64 with padding
    try {
      // Replace URL-safe chars and fix padding
      const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
      // Use atob in the worker environment (Cloudflare Workers have it)
      const decoded = atob(padded);
      // Limit body text to 500 chars to avoid bloating the prompt
      return decoded.slice(0, 500);
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
   * Searches for messages from or to this address, limited to the 10 most recent.
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
      const from = this.getHeader(msg.payload.headers, 'From');
      const to = this.getHeader(msg.payload.headers, 'To');
      const subject = this.getHeader(msg.payload.headers, 'Subject');
      const date = this.getHeader(msg.payload.headers, 'Date');

      // Try to get body text
      let body = msg.snippet || '';
      if (msg.payload.parts) {
        const extractedText = this.extractTextFromParts(msg.payload.parts);
        if (extractedText) body = extractedText;
      } else if (msg.payload.body?.data) {
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
}

/** Extract the email address from a "Name <email@example.com>" header value. */
function extractEmail(header: string): string {
  const match = header.match(/<([^>]+)>/);
  return match ? match[1] : header.trim();
}