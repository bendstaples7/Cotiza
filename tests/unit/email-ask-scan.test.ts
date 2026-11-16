import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  looksLikeDocumentAsk,
  parseAskClassification,
  scanEmailAsks,
  type GmailAskMessage,
} from '../../worker/src/services/email-ask-scan.js';
import { EmailContextService } from '../../worker/src/services/email-context-service.js';

const { askScan, invoiceScan, keepAlive, KEEPALIVE_CRON } = vi.hoisted(() => ({
  askScan: vi.fn(async () => {}),
  invoiceScan: vi.fn(async () => {}),
  keepAlive: vi.fn(async () => {}),
  KEEPALIVE_CRON: '*/30 * * * *',
}));

vi.mock('../../worker/src/services/email-ask-scan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../worker/src/services/email-ask-scan.js')>()),
  runEmailAskScan: askScan,
}));
vi.mock('../../worker/src/services/invoice-inbox-scan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../worker/src/services/invoice-inbox-scan.js')>()),
  runInvoiceInboxScan: invoiceScan,
}));
vi.mock('../../worker/src/scheduled/jobber-session-keepalive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../worker/src/scheduled/jobber-session-keepalive.js')>()),
  handleJobberSessionKeepAlive: keepAlive,
  JOBBER_SESSION_KEEPALIVE_CRON: KEEPALIVE_CRON,
}));

import worker from '../../worker/src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function msg(over: Partial<GmailAskMessage> = {}): GmailAskMessage {
  return {
    id: 'm1',
    threadId: 't1',
    from: 'Dana Reyes <dana@example.com>',
    subject: 'Signed release form',
    bodyText: 'Can you please send me the signed release form the former tenant signed?',
    attachmentNames: [],
    receivedAt: '2026-11-16T10:00:00.000Z',
    ...over,
  };
}

interface AskRow {
  message_id: string;
  thread_id?: string | null;
  from_address?: string | null;
  from_name?: string | null;
  subject?: string | null;
  received_at?: string | null;
  ask_summary?: string | null;
  requested_document?: string | null;
  confidence?: number | null;
  status?: string;
  reason?: string | null;
}

/** In-memory stand-in for the email_asks table. */
function db() {
  const rows: AskRow[] = [];
  return {
    rows,
    prepare: (sql: string) => ({
      bind: (...args: Array<string | number | null>) => ({
        run: async () => {
          if (!sql.includes('INSERT INTO email_asks')) return { success: true };
          const messageId = String(args[0]);
          if (!rows.some((row) => row.message_id === messageId)) {
            rows.push({
              message_id: messageId,
              thread_id: args[1] as string | null,
              from_address: args[2] as string | null,
              from_name: args[3] as string | null,
              subject: args[4] as string | null,
              received_at: args[5] as string | null,
              ask_summary: args[6] as string | null,
              requested_document: args[7] as string | null,
              confidence: args[8] as number | null,
              status: String(args[9]),
              reason: args[10] as string | null,
            });
          }
          return { success: true };
        },
      }),
    }),
  };
}

describe('email ask scan', () => {
  it('stores a needs_you row for a prefetched document ask and skips a newsletter', async () => {
    const ask = msg();
    const newsletter = msg({
      id: 'm2',
      from: 'Weekly <news@noreply.example.com>',
      subject: 'This week in renovations',
      bodyText: 'Top stories and tips for homeowners.',
    });
    const nearMiss = msg({
      id: 'm3',
      from: 'Sam <sam@example.com>',
      subject: 'Quick question',
      bodyText: 'Could you share the signed form when you get a chance?',
    });
    const classify = vi.fn(async (message: GmailAskMessage) =>
      message.id === 'm1'
        ? { isDocumentRequest: true, requestedDocument: 'signed release form', summary: 'Dana asked for the signed release form.', confidence: 0.9 }
        : { isDocumentRequest: false, requestedDocument: null, summary: null, confidence: 0 },
    );
    const store = db();

    const result = await scanEmailAsks({
      messages: [ask, newsletter, nearMiss],
      db: store as unknown as D1Database,
      openai: { apiKey: 'key' },
      classify,
    });

    expect(result).toEqual({ scanned: 3, asks: 1, skipped: 2, failed: 0 });
    expect(classify).toHaveBeenCalledTimes(2);
    expect(store.rows).toEqual([
      expect.objectContaining({
        message_id: 'm1',
        thread_id: 't1',
        from_address: 'dana@example.com',
        from_name: 'Dana Reyes',
        subject: 'Signed release form',
        received_at: '2026-11-16T10:00:00.000Z',
        ask_summary: 'Dana asked for the signed release form.',
        requested_document: 'signed release form',
        confidence: 0.9,
        status: 'needs_you',
        reason: 'no draft yet',
      }),
    ]);
  });

  it('reads inbox candidates with the ask query and a received date', async () => {
    const urls: string[] = [];
    const tokenResponse = { access_token: 'test-access-token', expires_in: 3600, token_type: 'Bearer' };
    const listResponse = { messages: [{ id: 'msg1', threadId: 'thread1' }], resultSizeEstimate: 1 };
    const detail = {
      id: 'msg1',
      threadId: 'thread1',
      snippet: 'Can you send the signed form?',
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'Dana <dana@example.com>' },
          { name: 'Subject', value: 'Signed form' },
        ],
        body: { data: btoa('Can you please send me the signed release form?') },
      },
      internalDate: '1781605800000',
    };
    const fetchMock = vi.fn(async (url: unknown) => {
      const value = String(url);
      urls.push(value);
      if (value.includes('oauth2')) return { ok: true, json: () => Promise.resolve(tokenResponse) };
      if (value.includes('/messages?')) return { ok: true, json: () => Promise.resolve(listResponse) };
      return { ok: true, json: () => Promise.resolve(detail) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = new EmailContextService('id', 'secret', 'refresh');
    const candidates = await service.fetchAskCandidates();

    vi.unstubAllGlobals();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].receivedAt).toBe(new Date(1781605800000).toISOString());
    expect(candidates[0].attachmentNames).toEqual([]);
    const listUrl = decodeURIComponent(urls.find((value) => value.includes('/messages?')) ?? '');
    expect(listUrl).toContain('in:inbox');
    expect(listUrl).toContain('newer_than:2d');
    expect(urls.every((value) => !value.includes('/send') && !value.includes('/drafts'))).toBe(true);
  });

  it('runs the ask scan on the 30-minute cron only when EMAIL_ASK_WATCHER is on', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const baseEnv = {
      DB: {},
      R2_BUCKET: { list: vi.fn(async () => ({ objects: [], truncated: false })) },
      GMAIL_CLIENT_ID: 'id',
      GMAIL_CLIENT_SECRET: 'secret',
      GMAIL_REFRESH_TOKEN: 'refresh',
    };

    const offWait = vi.fn();
    await worker.scheduled({ cron: KEEPALIVE_CRON } as never, baseEnv as never, { waitUntil: offWait } as never);
    await Promise.all(offWait.mock.calls.map((call) => call[0]));
    expect(askScan).not.toHaveBeenCalled();

    const onWait = vi.fn();
    await worker.scheduled(
      { cron: KEEPALIVE_CRON } as never,
      { ...baseEnv, EMAIL_ASK_WATCHER: 'on' } as never,
      { waitUntil: onWait } as never,
    );
    expect(askScan).toHaveBeenCalledTimes(1);
    expect(onWait.mock.calls.length - offWait.mock.calls.length).toBe(1);
  });

  it('logs scan failed and records nothing when the Gmail read fails', async () => {
    const errors: unknown[][] = [];
    const logs: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
    const actual = await vi.importActual<typeof import('../../worker/src/services/email-ask-scan.js')>(
      '../../worker/src/services/email-ask-scan.js',
    );
    const store = db();

    await expect(
      actual.runEmailAskScan(
        {
          fetchMailboxAddress: () => Promise.resolve('ben@gmail.com'),
          fetchAskCandidates: () => Promise.reject(new Error('Gmail down')),
        },
        store as unknown as D1Database,
        { apiKey: 'key', apiUrl: 'https://api.test/chat' },
      ),
    ).resolves.toBeUndefined();

    expect(store.rows).toEqual([]);
    expect(logs).toEqual([]);
    expect(errors).toEqual([['[email-asks] scan failed', expect.any(Error)]]);
  });
});

describe('ask parsing', () => {
  it('accepts only a JSON object with a boolean isDocumentRequest', () => {
    expect(parseAskClassification('{"isDocumentRequest":true,"requestedDocument":" W-9 ","summary":"Needs a W-9.","confidence":2}')).toEqual({
      isDocumentRequest: true,
      requestedDocument: 'W-9',
      summary: 'Needs a W-9.',
      confidence: 1,
    });
    expect(parseAskClassification('{"isDocumentRequest":"yes"}')).toBeNull();
    expect(parseAskClassification('not json')).toBeNull();
    expect(looksLikeDocumentAsk(msg())).toBe(true);
    expect(looksLikeDocumentAsk(msg({ from: 'News <news@noreply.example.com>', subject: 'Digest', bodyText: 'send us money' }))).toBe(false);
    expect(looksLikeDocumentAsk(msg({ subject: 'Lunch next week', bodyText: 'noon?' }))).toBe(false);
  });
});
