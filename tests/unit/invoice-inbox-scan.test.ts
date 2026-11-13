import { describe, it, expect, vi } from 'vitest';
import {
  classifyInvoiceMessage,
  draftFromMessage,
  invoiceDedupeKey,
  scanInvoiceInbox,
  runInvoiceInboxScan,
  type GmailInvoiceMessage,
} from '../../worker/src/services/invoice-inbox-scan.js';

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
          rows.push({ message_id: String(args[0]), dedupe_key: String(args[7]) });
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

  it('drafts would_log fields and falls back to amount|date for the dedupe key', () => {
    const draft = draftFromMessage(msg());
    expect([draft.status, draft.invoiceNumber, draft.amount, draft.expenseDate]).toEqual([
      'would_log',
      '5511-R-0024',
      216.2,
      '2026-10-29',
    ]);
    expect(draftFromMessage(msg({ bodyText: 'Due on 2026-10-29' })).status).toBe('uncertain');
    expect(invoiceDedupeKey('ACME', null, 216.2, '2026-10-29')).toBe('21620|2026-10-29');
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
