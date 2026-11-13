import { describe, it, expect, vi } from 'vitest';
import {
  classifyInvoiceMessage,
  draftFromMessage,
  invoiceDedupeKey,
  scanInvoiceInbox,
  runInvoiceInboxScan,
  type GmailInvoiceMessage,
} from '../../worker/src/services/invoice-inbox-scan.js';
import { EmailContextService } from '../../worker/src/services/email-context-service.js';

function msg(over: Partial<GmailInvoiceMessage> = {}): GmailInvoiceMessage {
  return {
    id: 'm1',
    threadId: 't1',
    from: '20four7VA <billing@20four7va.com>',
    subject: 'Invoice #5511-R-0024',
    bodyText: 'Amount due $216.20 on 2026-10-29',
    attachmentNames: ['5511-R-0024.pdf'],
    ...over,
  };
}

interface DbRow {
  message_id: string;
  dedupe_key: string;
}

/** In-memory stand-in for the invoice_inbox_items table. */
function db() {
  const rows: DbRow[] = [];
  return {
    rows,
    prepare: (_sql: string) => ({
      bind: (...args: Array<string | number | null>) => ({
        first: async () =>
          rows.some((row) => row.dedupe_key === args[0] && row.message_id !== args[1]) ? { 1: 1 } : null,
        run: async () => {
          const messageId = String(args[0]);
          if (!rows.some((row) => row.message_id === messageId)) {
            rows.push({ message_id: messageId, dedupe_key: String(args[7]) });
          }
          return { success: true };
        },
      }),
    }),
  };
}

describe('invoice inbox scan', () => {
  it('treats a 20four7VA message with a PDF and #5511-R-0024 as an invoice', () => {
    expect(classifyInvoiceMessage(msg())).toBe(true);
    expect(
      classifyInvoiceMessage(
        msg({ from: 'Bob <bob@example.com>', subject: 'Lunch next week', bodyText: 'noon?', attachmentNames: [] }),
      ),
    ).toBe(false);
    expect(classifyInvoiceMessage(msg({ attachmentNames: ['5511-R-0024.png'] }))).toBe(false);
  });

  it('treats a Square "You paid an invoice" email with no attachment as would_log', () => {
    const square = msg({
      from: '20four7VA <messenger@messaging.squareup.com>',
      subject: 'You paid an invoice! (#5511-R-0025)',
      bodyText: 'You have paid invoice #5511-R-0025 from 20four7VA for $216.20.',
      snippet: 'Charged to Visa 0391 on file on November 5, 2026',
      attachmentNames: [],
    });
    expect(classifyInvoiceMessage(square)).toBe(true);
    const draft = draftFromMessage(square);
    expect([
      draft.vendor,
      draft.invoiceNumber,
      draft.amount,
      draft.expenseDate,
      draft.attachmentName,
      draft.status,
    ]).toEqual(['20four7VA', '5511-R-0025', 216.2, '2026-11-05', null, 'would_log']);
  });

  it('does not classify a lookalike sender whose display name contains the Square domain', () => {
    expect(
      classifyInvoiceMessage(
        msg({
          from: '"messaging.squareup.com" <x@evil.test>',
          subject: 'You paid an invoice! (#5511-R-0027)',
          bodyText: 'You have paid invoice #5511-R-0027 for $10.00.',
          attachmentNames: [],
        }),
      ),
    ).toBe(false);
  });

  it('does not classify Square mail without a paid statement in the body or snippet', () => {
    expect(
      classifyInvoiceMessage(
        msg({
          from: '20four7VA <messenger@messaging.squareup.com>',
          subject: 'You paid an invoice! (#5511-R-0028)',
          bodyText: 'Your invoice #5511-R-0028 is overdue. Amount due $10.00.',
          snippet: 'This invoice is now past due',
          attachmentNames: [],
        }),
      ),
    ).toBe(false);
  });

  it('leaves the expense date uncertain when the named date is impossible', () => {
    const draft = draftFromMessage(msg({ bodyText: 'Amount due $216.20 on February 30, 2026' }));
    expect(draft.expenseDate).toBeNull();
  });

  it('drafts would_log fields and falls back to vendor|amount|date for the dedupe key', () => {
    const draft = draftFromMessage(msg());
    expect([draft.status, draft.invoiceNumber, draft.amount, draft.expenseDate]).toEqual([
      'would_log',
      '5511-R-0024',
      216.2,
      '2026-10-29',
    ]);
    expect(draftFromMessage(msg({ bodyText: 'Due on 2026-10-29' })).status).toBe('uncertain');
    expect(invoiceDedupeKey('ACME', null, 216.2, '2026-10-29')).toBe('acme|21620|2026-10-29');
    expect(invoiceDedupeKey(null, '5511-R-0024', 216.2, '2026-10-29')).toBeNull();
  });

  it('prefers a labelled total and reports uncertainty when no unambiguous total exists', () => {
    const subtotalAndTotal = draftFromMessage(
      msg({ bodyText: 'Subtotal: $200.00\nTotal: $216.20 due on 2026-10-29' }),
    );
    expect([subtotalAndTotal.status, subtotalAndTotal.amount]).toEqual(['would_log', 216.2]);
    const conflicting = draftFromMessage(
      msg({ bodyText: 'Total: $100.00\nAmount Due: $120.00 on 2026-10-29' }),
    );
    expect([conflicting.status, conflicting.amount, conflicting.reason]).toEqual([
      'uncertain',
      null,
      'no unambiguous total',
    ]);
    const unlabelled = draftFromMessage(msg({ bodyText: 'Please pay $99.00 on 2026-10-29' }));
    expect([unlabelled.status, unlabelled.amount, unlabelled.reason]).toEqual([
      'uncertain',
      null,
      'no unambiguous total',
    ]);
  });

  it('records one row per invoice and marks a repeat dedupe key skipped', async () => {
    const store = db();
    const result = await scanInvoiceInbox({
      messages: [
        msg(),
        msg({
          id: 'm2',
          from: 'Other <other@example.com>',
          subject: 'Team offsite',
          bodyText: 'See you there',
          attachmentNames: [],
        }),
        msg({ id: 'm3' }),
      ],
      db: store as unknown as D1Database,
    });
    expect(result).toEqual({ scanned: 3, wouldLog: 1, uncertain: 0, skipped: 1 });
    expect(store.rows.map((row) => row.message_id)).toEqual(['m1', 'm3']);
  });

  it('re-running over the same messages adds no duplicate rows', async () => {
    const store = db();
    const messages = [
      msg(),
      msg({
        id: 'm2',
        from: 'Other <other@example.com>',
        subject: 'Team offsite',
        bodyText: 'See you there',
        attachmentNames: [],
      }),
    ];
    const first = await scanInvoiceInbox({ messages, db: store as unknown as D1Database });
    const second = await scanInvoiceInbox({ messages, db: store as unknown as D1Database });
    expect(first).toEqual({ scanned: 2, wouldLog: 1, uncertain: 0, skipped: 0 });
    expect(second).toEqual(first);
    expect(store.rows.map((row) => row.message_id)).toEqual(['m1']);
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
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600, token_type: 'Bearer' }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ emailAddress: 'ben@gmail.com' }) })
        .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({}) }),
    );
    const store = db();
    await runInvoiceInboxScan(new EmailContextService('id', 'secret', 'refresh'), store as unknown as D1Database);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(store.rows).toEqual([]);
    expect(logs).toEqual([]);
    expect(errors).toEqual([['[invoice-inbox] scan failed', expect.any(Error)]]);
  });

  it('swallows a mailbox that throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      runInvoiceInboxScan(
        {
          fetchInvoiceMessages: () => Promise.reject(new Error('Gmail down')),
          fetchMailboxAddress: () => Promise.resolve('ben@gmail.com'),
        },
        db() as unknown as D1Database,
      ),
    ).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });

  it('logs the mailbox the scan reads, after the profile call', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    const order: string[] = [];
    await runInvoiceInboxScan(
      {
        fetchMailboxAddress: () => {
          order.push('profile');
          return Promise.resolve('ben@gmail.com');
        },
        fetchInvoiceMessages: () => {
          order.push('messages');
          return Promise.resolve([msg()]);
        },
      },
      db() as unknown as D1Database,
    );
    vi.restoreAllMocks();
    expect(order).toEqual(['profile', 'messages']);
    expect(lines).toEqual([
      '[invoice-inbox] dry-run scanned=1 would_log=1 uncertain=0 skipped=0 mailbox=ben@gmail.com',
    ]);
  });
});
