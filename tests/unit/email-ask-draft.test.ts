import { describe, it, expect, vi, afterEach } from 'vitest';
import { EmailContextService } from '../../worker/src/services/email-context-service.js';
import { draftEmailAsks } from '../../worker/src/services/email-ask-draft.js';

const { draftRun, invoiceScan, keepAlive, KEEPALIVE_CRON } = vi.hoisted(() => ({
  draftRun: vi.fn(async () => {}),
  invoiceScan: vi.fn(async () => {}),
  keepAlive: vi.fn(async () => {}),
  KEEPALIVE_CRON: '*/30 * * * *',
}));

vi.mock('../../worker/src/services/email-ask-draft.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../worker/src/services/email-ask-draft.js')>()),
  runEmailAskDraft: draftRun,
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
  vi.unstubAllGlobals();
});

interface Row {
  message_id: string;
  thread_id: string | null;
  from_address: string | null;
  subject: string | null;
  requested_document: string | null;
  confidence: number | null;
  status: string;
  reason: string | null;
  draft_id?: string | null;
  draft_url?: string | null;
  attachment_name?: string | null;
  attachment_source?: string | null;
  attachment_message_id?: string | null;
  updated_at?: string | null;
}

function askRow(over: Partial<Row> = {}): Row {
  return {
    message_id: 'm1',
    thread_id: 't1',
    from_address: 'dana@example.com',
    subject: 'Signed release form',
    requested_document: 'signed release form',
    confidence: 0.9,
    status: 'needs_you',
    reason: 'no draft yet',
    ...over,
  };
}

/** In-memory stand-in for the email_asks table (SELECT of open asks + status/reason/draft patches). */
function db(seed: Row[]) {
  const rows = seed.map((row) => ({ ...row }));
  return {
    rows,
    prepare: (sql: string) => ({
      bind: (...args: Array<string | number | null>) => ({
        all: async () => ({
          results: rows.filter((row) => row.status === 'needs_you' && (row.confidence ?? 0) >= Number(args[0])),
        }),
        run: async () => {
          const id = String(args[args.length - 1]);
          const row = rows.find((item) => item.message_id === id);
          if (row) {
            if (sql.includes("status = 'drafted'")) {
              row.draft_id = args[0] as string;
              row.draft_url = args[1] as string;
              row.attachment_name = args[2] as string | null;
              row.attachment_source = args[3] as string | null;
              row.attachment_message_id = args[4] as string | null;
              row.status = 'drafted';
              row.reason = null;
            } else {
              row.reason = args[0] as string;
            }
            row.updated_at = 'now';
          }
          return { success: true };
        },
      }),
    }),
  };
}

function decodeRaw(raw: string): string {
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  return atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
}

async function actualDraftModule() {
  return vi.importActual<typeof import('../../worker/src/services/email-ask-draft.js')>(
    '../../worker/src/services/email-ask-draft.js',
  );
}

const tokenResponse = { access_token: 'test-access-token', expires_in: 3600, token_type: 'Bearer' };

function attachmentDetail() {
  return {
    id: 'msg1',
    threadId: 't1',
    snippet: 'Can you send the signed release form?',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'Dana <dana@example.com>' },
        { name: 'Subject', value: 'Signed release form' },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: btoa('Can you please send the signed release form?') } },
        { mimeType: 'application/pdf', filename: 'signed-release-form.pdf', body: { attachmentId: 'att1', size: 10 } },
      ],
    },
    internalDate: '1781605800000',
  };
}

describe('email ask draft', () => {
  it('creates the draft with the one winning attachment', async () => {
    const logs: unknown[][] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchMock = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      const value = String(url);
      calls.push({ url: value, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body });
      if (value.includes('oauth2')) return { ok: true, json: () => Promise.resolve(tokenResponse) };
      if (value.includes('/drafts')) return { ok: true, json: () => Promise.resolve({ id: 'draft123' }) };
      if (value.includes('/attachments/')) return { ok: true, json: () => Promise.resolve({ data: btoa('PDF-BYTES'), size: 9 }) };
      if (value.includes('/messages?')) return { ok: true, json: () => Promise.resolve({ messages: [{ id: 'msg1', threadId: 't1' }], resultSizeEstimate: 1 }) };
      return { ok: true, json: () => Promise.resolve(attachmentDetail()) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = db([askRow()]);
    const service = new EmailContextService('id', 'secret', 'refresh');

    const actual = await actualDraftModule();
    await actual.runEmailAskDraft(service, store as unknown as D1Database);
    vi.unstubAllGlobals();

    const posts = calls.filter((call) => call.method === 'POST' && !call.url.includes('oauth2'));
    expect(posts.map((call) => call.url)).toEqual(['https://gmail.googleapis.com/gmail/v1/users/me/drafts']);
    const raw = decodeRaw(JSON.parse(String(posts[0].body)).message.raw);
    expect(raw).toContain('signed-release-form.pdf');
    expect(raw).toContain('Attached: signed-release-form.pdf');
    expect(store.rows[0]).toMatchObject({
      message_id: 'm1',
      status: 'drafted',
      draft_id: 'draft123',
      draft_url: 'https://mail.google.com/mail/u/0/#drafts?compose=draft123',
      attachment_name: 'signed-release-form.pdf',
      attachment_source: 'Dana <dana@example.com>',
      attachment_message_id: 'msg1',
      reason: null,
    });
    expect(logs.at(-1)?.[0]).toBe('[email-asks] drafted=1 needs_you=0 failed=0');
  });

  it('leaves the ask needs_you when the file is ambiguous or missing', async () => {
    const createDraft = vi.fn();
    const findAttachmentCandidates = vi
      .fn()
      .mockResolvedValueOnce([
        { filename: 'a.pdf', attachmentId: 'a', messageId: 's1', from: 'x@alpha.com', date: '2026-01-02T00:00:00.000Z' },
        { filename: 'b.pdf', attachmentId: 'b', messageId: 's2', from: 'y@beta.com', date: '2026-01-01T00:00:00.000Z' },
      ])
      .mockResolvedValueOnce([]);
    const store = db([askRow(), askRow({ message_id: 'm2', requested_document: 'w-9', subject: 'W-9 please' })]);
    const service = { findAttachmentCandidates, createDraft };

    const result = await draftEmailAsks({ asks: store.rows, service, db: store as unknown as D1Database });

    expect(createDraft).not.toHaveBeenCalled();
    expect(result).toEqual({ drafted: 0, needs_you: 2, failed: 0 });
    expect(store.rows[0]).toMatchObject({ message_id: 'm1', status: 'needs_you', reason: 'document ambiguous' });
    expect(store.rows[1]).toMatchObject({ message_id: 'm2', status: 'needs_you', reason: 'attachment not found: w-9' });
  });

  it('never posts to /send and the service has no send method', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      const value = String(url);
      calls.push(value);
      if (value.includes('oauth2')) return { ok: true, json: () => Promise.resolve(tokenResponse) };
      if (value.includes('/messages?')) return { ok: true, json: () => Promise.resolve({ messages: [], resultSizeEstimate: 0 }) };
      return { ok: true, json: () => Promise.resolve({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = db([askRow()]);
    const service = new EmailContextService('id', 'secret', 'refresh');

    await draftEmailAsks({ asks: store.rows, service, db: store as unknown as D1Database });
    vi.unstubAllGlobals();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((url) => !url.includes('/send'))).toBe(true);
    const keys = Object.getOwnPropertyNames(EmailContextService.prototype);
    expect(keys.some((key) => /send/i.test(key))).toBe(false);
  });

  it('logs and records nothing when Gmail fails', async () => {
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchMock = vi.fn(async (url: unknown) => {
      const value = String(url);
      if (value.includes('oauth2')) return { ok: true, json: () => Promise.resolve(tokenResponse) };
      if (value.includes('/drafts')) return { ok: false, status: 500, json: () => Promise.resolve({}) };
      if (value.includes('/attachments/')) return { ok: true, json: () => Promise.resolve({ data: btoa('PDF-BYTES'), size: 9 }) };
      if (value.includes('/messages?')) return { ok: true, json: () => Promise.resolve({ messages: [{ id: 'msg1', threadId: 't1' }], resultSizeEstimate: 1 }) };
      return { ok: true, json: () => Promise.resolve(attachmentDetail()) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = db([askRow()]);
    const service = new EmailContextService('id', 'secret', 'refresh');

    const actual = await actualDraftModule();
    await actual.runEmailAskDraft(service, store as unknown as D1Database);
    vi.unstubAllGlobals();

    expect(errors.some((args) => args[0] === '[email-asks] draft failed')).toBe(true);
    expect(store.rows[0]).toMatchObject({ message_id: 'm1', status: 'needs_you', reason: 'no draft yet' });
  });
});

describe('email ask draft cron', () => {
  it('drafts only when EMAIL_ASK_DRAFTS is true', async () => {
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
    expect(draftRun).not.toHaveBeenCalled();

    const onWait = vi.fn();
    await worker.scheduled(
      { cron: KEEPALIVE_CRON } as never,
      { ...baseEnv, EMAIL_ASK_DRAFTS: 'true' } as never,
      { waitUntil: onWait } as never,
    );
    expect(draftRun).toHaveBeenCalledTimes(1);
    expect(onWait.mock.calls.length - offWait.mock.calls.length).toBe(1);
  });
});
