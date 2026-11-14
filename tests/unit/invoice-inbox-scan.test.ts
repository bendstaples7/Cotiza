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
  vendor?: string | null;
  invoice_number?: string | null;
  amount?: number | null;
  expense_date?: string | null;
  status?: string;
  reason?: string | null;
  jobber_expense_id?: string | null;
}

/** In-memory stand-in for the invoice_inbox_items table. */
function db() {
  const rows: DbRow[] = [];
  return {
    rows,
    prepare: (sql: string) => ({
      bind: (...args: Array<string | number | null>) => ({
        first: async () => {
          if (sql.includes('SELECT 1')) {
            return rows.some((row) => row.dedupe_key === args[0] && row.message_id !== args[1]) ? { 1: 1 } : null;
          }
          if (sql.includes('WHERE message_id')) {
            return rows.find((row) => row.message_id === args[0]) ?? null;
          }
          return null;
        },
        run: async () => {
          if (sql.includes('UPDATE')) {
            const row = rows.find((item) => item.message_id === args[3]);
            if (row) {
              row.status = String(args[0]);
              row.reason = args[1] as string | null;
              row.jobber_expense_id = args[2] as string | null;
            }
            return { success: true };
          }
          const messageId = String(args[0]);
          if (!rows.some((row) => row.message_id === messageId)) {
            rows.push({
              message_id: messageId,
              dedupe_key: String(args[7]),
              vendor: args[2] as string | null,
              invoice_number: args[3] as string | null,
              amount: args[4] as number | null,
              expense_date: args[5] as string | null,
              status: String(args[8]),
              reason: args[9] as string | null,
              jobber_expense_id: null,
            });
          }
          return { success: true };
        },
      }),
    }),
  };
}

const SQUARE_LINK = 'https://a.squareupmessaging.com/CL0/https%3A%2F%2Fsquareup.com%2Finvoices%2F1/1/0101';

function jobber(pages: Array<Array<Record<string, unknown>>> = []) {
  let call = 0;
  return {
    graphqlRequest: vi.fn(async () => {
      const edges = (pages[call] ?? []).map((node) => ({ node }));
      const hasNextPage = call < pages.length;
      const pageInfo = { hasNextPage, endCursor: hasNextPage ? `cursor-${call}` : null };
      call++;
      return { expenses: { edges, pageInfo } };
    }),
  };
}

function liveDeps(over: { log?: unknown; jobber?: ReturnType<typeof jobber> } = {}) {
  return {
    jobber: (over.jobber ?? jobber()) as never,
    target: { bucket: {} as never, origin: 'https://cotiza.test' },
    userId: 'invoice-inbox',
    log: (over.log ?? vi.fn()) as never,
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
  it('leaves the expense date uncertain when the ISO date is impossible', () => {
    const draft = draftFromMessage(msg({ bodyText: 'Amount due $216.20 on 2026-02-30' }));
    expect(draft.expenseDate).toBeNull();
  });

  it('classifies Square receipt wording (Invoice Paid / Total Paid) as paid', () => {
    expect(
      classifyInvoiceMessage(
        msg({
          from: '20four7VA <messenger@messaging.squareup.com>',
          subject: 'You paid an invoice! (#5511-R-0026)',
          bodyText: 'Invoice Paid $216.20 Total Paid $216.20 Paid with Visa 0391',
          attachmentNames: [],
        }),
      ),
    ).toBe(true);
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

  it('go-live off leaves the would_log row alone and never calls Jobber', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const j = jobber();
    await runInvoiceInboxScan(
      {
        fetchMailboxAddress: () => Promise.resolve('ben@gmail.com'),
        fetchInvoiceMessages: () => Promise.resolve([msg({ receiptUrl: SQUARE_LINK })]),
      },
      store as unknown as D1Database,
      liveDeps({ jobber: j, log: vi.fn() }),
      false,
    );
    vi.restoreAllMocks();
    expect(j.graphqlRequest).not.toHaveBeenCalled();
    expect(store.rows[0]).toMatchObject({ status: 'would_log', jobber_expense_id: null });
  });

  it('finds a hand-entered expense on a later expenses page', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const j = jobber([
      [{ id: 'exp-other', title: 'Unrelated', total: 10, date: '2026-10-29T12:00:00Z' }],
      [{ id: 'exp-late', title: 'Garlien Weekly 20Four7 VA', total: 216.2, date: '2026-10-29T12:00:00Z' }],
    ]);
    const log = vi.fn();
    await runInvoiceInboxScan(
      {
        fetchMailboxAddress: () => Promise.resolve('ben@gmail.com'),
        fetchInvoiceMessages: () => Promise.resolve([msg({ receiptUrl: SQUARE_LINK })]),
      },
      store as unknown as D1Database,
      liveDeps({ log, jobber: j }),
    );
    expect(j.graphqlRequest).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalled();
    expect(store.rows[0]).toMatchObject({ status: 'skipped', jobber_expense_id: 'exp-late' });
    vi.restoreAllMocks();
  });

  it('marks the row uncertain when the expenses pages are unfinished', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const j = jobber(Array.from({ length: 10 }, () => []));
    const log = vi.fn();
    await runInvoiceInboxScan(
      {
        fetchMailboxAddress: () => Promise.resolve('ben@gmail.com'),
        fetchInvoiceMessages: () => Promise.resolve([msg({ receiptUrl: SQUARE_LINK })]),
      },
      store as unknown as D1Database,
      liveDeps({ log, jobber: j }),
    );
    expect(j.graphqlRequest).toHaveBeenCalledTimes(10);
    expect(log).not.toHaveBeenCalled();
    expect(store.rows[0]).toMatchObject({ status: 'uncertain', reason: 'existing-expense check incomplete' });
    vi.restoreAllMocks();
  });

  it('matches a prior-day expense by calendar day', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const j = jobber([[{ id: 'exp-prior', title: 'Garlien Weekly 20Four7 VA', total: 216.2, date: '2026-10-28T00:00:00Z' }]]);
    const log = vi.fn();
    await runInvoiceInboxScan(
      {
        fetchMailboxAddress: () => Promise.resolve('ben@gmail.com'),
        fetchInvoiceMessages: () => Promise.resolve([msg({ receiptUrl: SQUARE_LINK })]),
      },
      store as unknown as D1Database,
      liveDeps({ log, jobber: j }),
    );
    vi.restoreAllMocks();
    expect(log).not.toHaveBeenCalled();
    expect(store.rows[0]).toMatchObject({ status: 'skipped', jobber_expense_id: 'exp-prior' });
  });

  it('marks the row uncertain when log throws and continues', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const log = vi.fn()
      .mockRejectedValueOnce(new Error('jobber exploded'))
      .mockResolvedValueOnce({ outcome: 'created' as const, expenseId: 'exp-2', verified: true });
    await runInvoiceInboxScan(
      {
        fetchMailboxAddress: () => Promise.resolve('ben@gmail.com'),
        fetchInvoiceMessages: () => Promise.resolve([
          msg({ id: 'm1', receiptUrl: SQUARE_LINK }),
          msg({ id: 'm2', subject: 'Invoice #5511-R-0025', receiptUrl: SQUARE_LINK }),
        ]),
      },
      store as unknown as D1Database,
      liveDeps({ log }),
    );
    vi.restoreAllMocks();
    expect(store.rows[0]).toMatchObject({ status: 'uncertain', reason: 'jobber exploded' });
    expect(store.rows[1]).toMatchObject({ status: 'logged', jobber_expense_id: 'exp-2' });
  });

  it('marks a hand-entered Jobber expense skipped instead of creating a duplicate', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const j = jobber([[{ id: 'exp-old', title: 'Garlien Weekly 20Four7 VA', total: 216.2, date: '2026-10-30T12:00:00Z' }]]);
    const log = vi.fn();
    await runInvoiceInboxScan(
      {
        fetchMailboxAddress: () => Promise.resolve('ben@gmail.com'),
        fetchInvoiceMessages: () => Promise.resolve([msg({ receiptUrl: SQUARE_LINK })]),
      },
      store as unknown as D1Database,
      liveDeps({ log, jobber: j }),
    );
    vi.restoreAllMocks();
    expect(log).not.toHaveBeenCalled();
    expect(store.rows[0]).toMatchObject({ status: 'skipped', jobber_expense_id: 'exp-old' });
  });

  it('logs a new invoice with one logExpense call and records the expense id', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const log = vi.fn(async (..._args: unknown[]) => ({ outcome: 'created' as const, expenseId: 'exp-new', verified: true }));
    await runInvoiceInboxScan(
      {
        fetchMailboxAddress: () => Promise.resolve('ben@gmail.com'),
        fetchInvoiceMessages: () => Promise.resolve([msg({ receiptUrl: SQUARE_LINK })]),
      },
      store as unknown as D1Database,
      liveDeps({ log }),
    );
    expect(log).toHaveBeenCalledTimes(1);
    const args = log.mock.calls[0][4] as { sourceKey: string; description: string; total: number };
    expect(args.sourceKey).toBe('20four7va|5511-r-0024');
    expect(args.description).toContain('5511-R-0024');
    expect(args.total).toBe(216.2);
    expect(store.rows[0]).toMatchObject({ status: 'logged', jobber_expense_id: 'exp-new' });
    vi.restoreAllMocks();
  });

  it('marks the row uncertain on an unknown Jobber reply and never retries', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const log = vi.fn(async () => ({ outcome: 'unknown' as const, message: 'Jobber did not confirm the expense' }));
    const deps = liveDeps({ log });
    const service = {
      fetchMailboxAddress: () => Promise.resolve('ben@gmail.com'),
      fetchInvoiceMessages: () => Promise.resolve([msg({ receiptUrl: SQUARE_LINK })]),
    };
    await runInvoiceInboxScan(service, store as unknown as D1Database, deps);
    await runInvoiceInboxScan(service, store as unknown as D1Database, deps);
    expect(log).toHaveBeenCalledTimes(1);
    expect(store.rows[0]).toMatchObject({ status: 'uncertain', reason: 'Jobber did not confirm the expense' });
    vi.restoreAllMocks();
  });

  it('marks the row uncertain and does not log when the vendor needle is empty', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const log = vi.fn();
    await runInvoiceInboxScan(
      {
        fetchMailboxAddress: () => Promise.resolve('ben@gmail.com'),
        fetchInvoiceMessages: () => Promise.resolve([msg({ from: '& <billing@20four7va.com>', receiptUrl: SQUARE_LINK })]),
      },
      store as unknown as D1Database,
      liveDeps({ log }),
    );
    vi.restoreAllMocks();
    expect(log).not.toHaveBeenCalled();
    expect(store.rows[0]).toMatchObject({ status: 'uncertain', reason: 'existing-expense check incomplete' });
  });

  it("maps 'receipt is not a PDF' from failure.detail, not the message", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const log = vi.fn(async () => ({ outcome: 'failed' as const, failure: { code: 'receipt_unavailable', message: 'the receipt could not be read', detail: 'not_a_pdf' } }));
    await runInvoiceInboxScan({ fetchMailboxAddress: () => Promise.resolve('b@x.com'), fetchInvoiceMessages: () => Promise.resolve([msg({ receiptUrl: SQUARE_LINK })]) }, store as unknown as D1Database, liveDeps({ log }));
    vi.restoreAllMocks();
    expect(store.rows[0]).toMatchObject({ status: 'uncertain', reason: 'receipt is not a PDF' });
  });
  it('adds the Cotiza/Logged label after a live log', async () => {
    const store = db();
    const log = vi.fn(async () => ({ outcome: 'created' as const, expenseId: 'exp-new', verified: true }));
    const addLabel = vi.fn(async () => ({ ok: true } as const));
    await runInvoiceInboxScan({ fetchMailboxAddress: () => Promise.resolve('b@x.com'), fetchInvoiceMessages: () => Promise.resolve([msg({ receiptUrl: SQUARE_LINK })]), addLabel }, store as unknown as D1Database, liveDeps({ log }));
    expect(addLabel).toHaveBeenCalledWith('m1', 'Cotiza/Logged');
    expect(store.rows[0]).toMatchObject({ status: 'logged', jobber_expense_id: 'exp-new', reason: null });
  });
  it('keeps the row logged with a note when the label scope is missing', async () => {
    const store = db();
    const log = vi.fn(async () => ({ outcome: 'created' as const, expenseId: 'exp-new', verified: true }));
    const addLabel = vi.fn(async () => ({ ok: false, reason: 'needs gmail.modify' } as const));
    await runInvoiceInboxScan({ fetchMailboxAddress: () => Promise.resolve('b@x.com'), fetchInvoiceMessages: () => Promise.resolve([msg({ receiptUrl: SQUARE_LINK })]), addLabel }, store as unknown as D1Database, liveDeps({ log }));
    expect(store.rows[0]).toMatchObject({ status: 'logged', jobber_expense_id: 'exp-new', reason: 'label skipped: needs gmail.modify' });
  });
  it('labels the logged message through a this-using addLabel without throwing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const log = vi.fn(async () => ({ outcome: 'created' as const, expenseId: 'exp-new', verified: true }));
    const seen: string[][] = [];
    class LabelingService {
      tag = 'Cotiza/Logged';
      async fetchMailboxAddress() {
        return 'b@x.com';
      }
      async fetchInvoiceMessages() {
        return [msg({ receiptUrl: SQUARE_LINK })];
      }
      async addLabel(id: string, name: string) {
        seen.push([id, name, this.tag]);
        return { ok: true } as const;
      }
    }
    await runInvoiceInboxScan(new LabelingService(), store as unknown as D1Database, liveDeps({ log }));
    expect(errors).not.toHaveBeenCalled();
    expect(seen).toEqual([['m1', 'Cotiza/Logged', 'Cotiza/Logged']]);
    expect(store.rows[0]).toMatchObject({ status: 'logged', jobber_expense_id: 'exp-new' });
    vi.restoreAllMocks();
  });
});
