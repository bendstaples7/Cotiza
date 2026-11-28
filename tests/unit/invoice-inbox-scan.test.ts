import { describe, it, expect, vi } from 'vitest';
import {
  classifyInvoiceMessage,
  draftFromMessage,
  invoiceDedupeKey,
  scanInvoiceInbox,
  runInvoiceInboxScan,
  matchHomeDepotJobs,
  type GmailInvoiceMessage,
} from '../../worker/src/services/invoice-inbox-scan.js';
import { EmailContextService, homeDepotReceiptLink } from '../../worker/src/services/email-context-service.js';
import { EXPENSE_CREATE_QUERIES, logExpense } from '../../worker/src/services/jobber-expense-create.js';

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
  job_name?: string | null;
  status?: string;
  reason?: string | null;
  jobber_expense_id?: string | null;
  jobber_job_id?: string | null;
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
              if (sql.includes('jobber_job_id')) row.jobber_job_id = args[2] as string | null;
              else row.jobber_expense_id = args[2] as string | null;
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
              job_name: args[10] as string | null,
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

function jobber(
  pages: Array<Array<Record<string, unknown>>> = [],
  jobs: Array<Record<string, unknown>> = [],
) {
  let call = 0;
  return {
    graphqlRequest: vi.fn(async (query: string) => {
      if (query.includes('jobs(')) {
        return { jobs: { edges: jobs.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      const edges = (pages[call] ?? []).map((node) => ({ node }));
      const hasNextPage = call < pages.length;
      const pageInfo = { hasNextPage, endCursor: hasNextPage ? `cursor-${call}` : null };
      call++;
      return { expenses: { edges, pageInfo } };
    }),
  };
}

function liveDeps(over: { log?: unknown; jobber?: ReturnType<typeof jobber>; homeDepotGoLive?: boolean } = {}) {
  return {
    jobber: (over.jobber ?? jobber()) as never,
    target: { bucket: {} as never, origin: 'https://cotiza.test' },
    userId: 'invoice-inbox',
    log: (over.log ?? vi.fn()) as never,
    ...(over.homeDepotGoLive === undefined ? {} : { homeDepotGoLive: over.homeDepotGoLive }),
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

  it('classifies a Home Depot e-receipt with no PDF', () => {
    expect(
      classifyInvoiceMessage(
        msg({
          from: 'Home Depot <HomeDepot@email.homedepot.com>',
          subject: 'Your Home Depot receipt for order #W12345678',
          bodyText: 'Order Total $143.27',
          attachmentNames: [],
        }),
      ),
    ).toBe(true);
    expect(
      classifyInvoiceMessage(
        msg({ from: 'Home Depot <HomeDepot@email.homedepot.com>', subject: 'Save big this week', bodyText: 'Deals inside', attachmentNames: [] }),
      ),
    ).toBe(false);
    expect(
      classifyInvoiceMessage(
        msg({ from: 'Home Depot <HomeDepot@email.homedepot.com>', subject: 'Black Friday deals', bodyText: 'Order now and save', attachmentNames: [] }),
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
  it('keeps a caller-supplied live.label instead of the service addLabel', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const log = vi.fn(async () => ({ outcome: 'created' as const, expenseId: 'exp-new', verified: true }));
    const callerLabel = vi.fn(async () => ({ ok: true } as const));
    const addLabel = vi.fn(async () => ({ ok: true } as const));
    await runInvoiceInboxScan(
      { fetchMailboxAddress: () => Promise.resolve('b@x.com'), fetchInvoiceMessages: () => Promise.resolve([msg({ receiptUrl: SQUARE_LINK })]), addLabel },
      store as unknown as D1Database,
      { ...liveDeps({ log }), label: callerLabel },
    );
    expect(callerLabel).toHaveBeenCalledWith('m1');
    expect(addLabel).not.toHaveBeenCalled();
    expect(store.rows[0]).toMatchObject({ status: 'logged', jobber_expense_id: 'exp-new', reason: null });
    vi.restoreAllMocks();
  });
});

describe('Home Depot receipts (card f9e131f8 T3)', () => {
  const receipt = (over: Partial<GmailInvoiceMessage> = {}) =>
    msg({
      from: 'Home Depot <HomeDepot@email.homedepot.com>',
      subject: 'Your Home Depot receipt for order #W12345678',
      bodyText: 'Order Total $143.27\nPlaced on November 20, 2026\nJob Name: 4123 N Kedzie',
      attachmentNames: [],
      ...over,
    });

  it('drafts the vendor, order number, total, date and job name', () => {
    const draft = draftFromMessage(receipt());
    expect([draft.vendor, draft.invoiceNumber, draft.amount, draft.expenseDate, draft.jobName, draft.status]).toEqual([
      'Home Depot',
      'W12345678',
      143.27,
      '2026-11-20',
      '4123 N Kedzie',
      'uncertain',
    ]);
    expect(draft.reason).toBe('home depot receipt: job match pending');
  });

  it('does not read a perk line as a PO/job name', () => {
    const draft = draftFromMessage(receipt({ bodyText: 'Earn Pro Xtra points on power tools\nOrder Total $10.00' }));
    expect(draft.jobName).toBeNull();
  });

  it('reads a dotted PO label as the job name', () => {
    const draft = draftFromMessage(receipt({ bodyText: 'P.O.: 4123 N Kedzie\nOrder Total $143.27' }));
    expect(draft.jobName).toBe('4123 N Kedzie');
  });

  it('does not treat a spoofed Home Depot display name as the sender', () => {
    const spoof = msg({
      from: 'HomeDepot@email.homedepot.com <attacker@evil.test>',
      subject: 'Your Home Depot receipt for order #W12345678',
      bodyText: 'Order Total $143.27',
      attachmentNames: [],
    });
    expect(classifyInvoiceMessage(spoof)).toBe(false);
    expect(draftFromMessage(spoof).vendor).not.toBe('Home Depot');
  });

  it('reads an HTML-only Home Depot receipt through the Gmail HTML fallback', async () => {
    const html = '<table><tr><td>Order #W123456</td></tr><tr><td>Order Total</td><td>&#36;143.27</td></tr><tr><td>Job Name: 4123 N Kedzie</td></tr></table>';
    const gmailMessage = {
      id: 'hd1',
      threadId: 't1',
      snippet: '',
      payload: {
        mimeType: 'text/html',
        headers: [
          { name: 'From', value: 'Home Depot <HomeDepot@email.homedepot.com>' },
          { name: 'Subject', value: 'Your Home Depot receipt for order #W123456' },
        ],
        body: { data: btoa(html) },
      },
      internalDate: '1781605800000',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600, token_type: 'Bearer' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ messages: [], resultSizeEstimate: 0 }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ messages: [{ id: 'hd1', threadId: 't1' }], resultSizeEstimate: 1 }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(gmailMessage) });
    vi.stubGlobal('fetch', fetchMock);
    const service = new EmailContextService('cid', 'secret', 'refresh');
    const [message] = await service.fetchInvoiceMessages();
    vi.unstubAllGlobals();
    const draft = draftFromMessage(message);
    expect([draft.invoiceNumber, draft.amount, draft.jobName]).toEqual(['W123456', 143.27, '4123 N Kedzie']);
  });

  it('queues a Home Depot receipt on the review list and never logs it yet', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const j = jobber();
    const log = vi.fn();
    await runInvoiceInboxScan(
      { fetchMailboxAddress: () => Promise.resolve('b@x.com'), fetchInvoiceMessages: () => Promise.resolve([receipt()]) },
      store as unknown as D1Database,
      liveDeps({ jobber: j, log }),
    );
    expect(j.graphqlRequest).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(store.rows[0]).toMatchObject({ vendor: 'Home Depot', job_name: '4123 N Kedzie', status: 'uncertain' });
    vi.restoreAllMocks();
  });

  it('marks a repeat Home Depot receipt skipped', async () => {
    const store = db();
    const first = await scanInvoiceInbox({ messages: [receipt()], db: store as unknown as D1Database });
    const second = await scanInvoiceInbox({ messages: [receipt({ id: 'm2' })], db: store as unknown as D1Database });
    expect(first.uncertain).toBe(1);
    expect(second.skipped).toBe(1);
  });
});

describe('Home Depot job matching (card f9e131f8 T4)', () => {
  const receipt = (over: Partial<GmailInvoiceMessage> = {}) =>
    msg({
      from: 'Home Depot <HomeDepot@email.homedepot.com>',
      subject: 'Your Home Depot receipt for order #W12345678',
      bodyText: 'Order Total $143.27\nJob Name: 4123 N Kedzie',
      attachmentNames: [],
      ...over,
    });

  const seed = (store: ReturnType<typeof db>, over: Partial<DbRow> = {}) => {
    store.rows.push({
      message_id: 'm1',
      dedupe_key: '',
      vendor: 'Home Depot',
      job_name: '4123 N Kedzie',
      status: 'uncertain',
      reason: 'home depot receipt: job match pending',
      ...over,
    });
  };

  it('a Home Depot row matching one active job becomes would_log with the job id', async () => {
    const store = db();
    seed(store);
    const j = jobber([], [{ id: 'job-1', title: '4123 N Kedzie', jobStatus: 'active' }]);
    const out = await matchHomeDepotJobs([receipt()], store as unknown as D1Database, j as never);
    expect(out).toEqual({ matched: 1, unmatched: 0, ambiguous: 0 });
    expect(store.rows[0]).toMatchObject({ status: 'would_log', jobber_job_id: 'job-1', reason: null });
  });

  it('a Home Depot row matching no job stays uncertain', async () => {
    const store = db();
    seed(store);
    const j = jobber([], [{ id: 'job-1', title: 'Some Other Job', jobStatus: 'active' }]);
    const out = await matchHomeDepotJobs([receipt()], store as unknown as D1Database, j as never);
    expect(out).toEqual({ matched: 0, unmatched: 1, ambiguous: 0 });
    expect(store.rows[0]).toMatchObject({ status: 'uncertain', reason: 'home depot receipt: no matching job' });
  });

  it('a Home Depot row matching several jobs stays uncertain', async () => {
    const store = db();
    seed(store);
    const j = jobber([], [
      { id: 'job-1', title: '4123 N Kedzie', jobStatus: 'active' },
      { id: 'job-2', title: '4123 N Kedzie', jobStatus: 'active' },
    ]);
    const out = await matchHomeDepotJobs([receipt()], store as unknown as D1Database, j as never);
    expect(out).toEqual({ matched: 0, unmatched: 0, ambiguous: 1 });
    expect(store.rows[0]).toMatchObject({ status: 'uncertain', reason: 'home depot receipt: several matching jobs' });
  });

  it('an archived job is not a match', async () => {
    const store = db();
    seed(store);
    const j = jobber([], [{ id: 'job-1', title: '4123 N Kedzie', jobStatus: 'archived' }]);
    const out = await matchHomeDepotJobs([receipt()], store as unknown as D1Database, j as never);
    expect(out).toEqual({ matched: 0, unmatched: 1, ambiguous: 0 });
    expect(store.rows[0]).toMatchObject({ status: 'uncertain', reason: 'home depot receipt: no matching job' });
  });
});

describe('Home Depot receipt logging (card f9e131f8 T8)', () => {
  const HD_LINK = 'https://www.homedepot.com/order/view/W12345678';
  const receipt = (over: Partial<GmailInvoiceMessage> = {}) =>
    msg({
      from: 'Home Depot <HomeDepot@email.homedepot.com>',
      subject: 'Your Home Depot receipt for order #W12345678',
      bodyText: 'Order Total $143.27\nPlaced on November 20, 2026\nJob Name: 4123 N Kedzie',
      attachmentNames: [],
      receiptUrl: HD_LINK,
      ...over,
    });

  it('reads the one Home Depot link from an email body', () => {
    expect(homeDepotReceiptLink(`<a href="${HD_LINK}">receipt</a>`)).toBe(HD_LINK);
    expect(homeDepotReceiptLink('no link here')).toBeNull();
    expect(homeDepotReceiptLink(`${HD_LINK} ${HD_LINK}?x=1`)).toBeNull();
  });

  it('a matched Home Depot receipt with only an HTML link is logged once with the link in the description', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const j = jobber([], [{ id: 'job-1', title: '4123 N Kedzie', jobStatus: 'active' }]);
    const log = vi.fn()
      .mockResolvedValueOnce({ outcome: 'failed' as const, failure: { code: 'receipt_unavailable', message: 'not a PDF', detail: 'not_a_pdf' } })
      .mockResolvedValueOnce({ outcome: 'created' as const, expenseId: 'exp-hd', verified: true });
    await runInvoiceInboxScan(
      { fetchMailboxAddress: () => Promise.resolve('b@x.com'), fetchInvoiceMessages: () => Promise.resolve([receipt()]) },
      store as unknown as D1Database,
      liveDeps({ jobber: j, log, homeDepotGoLive: true }),
    );
    expect(log).toHaveBeenCalledTimes(2);
    const retry = log.mock.calls[1][4] as { noReceipt?: boolean; description: string };
    expect(retry.noReceipt).toBe(true);
    expect(retry.description).toContain('W12345678');
    expect(retry.description).toContain(HD_LINK);
    expect(store.rows[0]).toMatchObject({ status: 'logged', reason: 'no PDF receipt; link in description', jobber_expense_id: 'exp-hd' });
    vi.restoreAllMocks();
  });

  it('a Home Depot receipt with no receipt link stays uncertain', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const j = jobber([], [{ id: 'job-1', title: '4123 N Kedzie', jobStatus: 'active' }]);
    const log = vi.fn();
    await runInvoiceInboxScan(
      { fetchMailboxAddress: () => Promise.resolve('b@x.com'), fetchInvoiceMessages: () => Promise.resolve([receipt({ receiptUrl: null })]) },
      store as unknown as D1Database,
      liveDeps({ jobber: j, log, homeDepotGoLive: true }),
    );
    vi.restoreAllMocks();
    expect(log).not.toHaveBeenCalled();
    expect(store.rows[0]).toMatchObject({ status: 'uncertain' });
  });

  it('logExpense with no receipt file creates one expense with the link in the description and no attachment', async () => {
    const rows = new Map<string, { status: string; jobber_expense_id: string | null }>();
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async run() {
                const key = (sql.includes('UPDATE') ? args[2] : args[0]) as string;
                if (sql.includes('INSERT')) {
                  if (rows.has(key)) return { meta: { changes: 0 } };
                  rows.set(key, { status: 'pending', jobber_expense_id: null });
                  return { meta: { changes: 1 } };
                }
                if (sql.includes('DELETE')) { rows.delete(key); return { meta: { changes: 1 } }; }
                if (sql.includes('UPDATE')) { const r = rows.get(key); if (r) Object.assign(r, { status: args[0], jobber_expense_id: args[1] }); return { meta: { changes: 1 } }; }
                throw new Error(sql);
              },
              async first() { return rows.get(args[0] as string) ?? null; },
            };
          },
        };
      },
    };
    const title = 'Home Depot W12345678';
    const description = `Home Depot order #W12345678 (hd-w12345678) receipt: ${HD_LINK}`;
    const create = { expenseCreate: { expense: { id: 'exp-hd', title, total: 143.27, date: '2026-11-20T12:00:00Z' }, userErrors: [] } };
    const j = {
      graphqlRequest: vi.fn(async (query: string, vars?: Record<string, unknown>) => {
        if (query === EXPENSE_CREATE_QUERIES.EXPENSES_QUERY) return { expenses: { edges: [] } };
        if (query === EXPENSE_CREATE_QUERIES.EXPENSE_CREATE) return create;
        if (query === EXPENSE_CREATE_QUERIES.EXPENSE_QUERY) return { expense: { id: vars?.id, title, total: 143.27, date: '2026-11-20T12:00:00Z' } };
        throw new Error('unexpected query');
      }),
    };
    const fetchReceipt = vi.fn();
    const r = await logExpense(
      j as never,
      db as never,
      { bucket: {} as never, origin: 'https://cotiza.test' },
      'u',
      { sourceKey: 'hd-w12345678', title, description, date: '2026-11-20', total: 143.27, noReceipt: true },
      fetchReceipt as never,
    );
    expect(r).toMatchObject({ outcome: 'created', expenseId: 'exp-hd', verified: true });
    const creates = j.graphqlRequest.mock.calls.filter(([q]) => q === EXPENSE_CREATE_QUERIES.EXPENSE_CREATE);
    expect(creates).toHaveLength(1);
    const input = (creates[0][1] as { input: Record<string, unknown> }).input;
    expect('receiptUrl' in input).toBe(false);
    expect(input.description).toContain(HD_LINK);
    expect(fetchReceipt).not.toHaveBeenCalled();
  });
});

describe('Home Depot job linking and dry run (card f9e131f8 T4/T8)', () => {
  const HD_LINK = 'https://www.homedepot.com/order/view/W12345678';
  const hdReceipt = (over: Partial<GmailInvoiceMessage> = {}) =>
    msg({
      from: 'Home Depot <HomeDepot@email.homedepot.com>',
      subject: 'Your Home Depot receipt for order #W12345678',
      bodyText: 'Order Total $143.27\nPlaced on November 20, 2026\nJob Name: 4123 N Kedzie',
      attachmentNames: [],
      receiptUrl: HD_LINK,
      ...over,
    });

  it('passes the matched job id to log as jobId for a Home Depot row', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const j = jobber([], [{ id: 'job-1', title: '4123 N Kedzie', jobStatus: 'active' }]);
    const log = vi.fn(async () => ({ outcome: 'created' as const, expenseId: 'exp-hd', verified: true }));
    await runInvoiceInboxScan(
      { fetchMailboxAddress: () => Promise.resolve('b@x.com'), fetchInvoiceMessages: () => Promise.resolve([hdReceipt()]) },
      store as unknown as D1Database,
      liveDeps({ jobber: j, log, homeDepotGoLive: true }),
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect((log.mock.calls[0][4] as { jobId?: string }).jobId).toBe('job-1');
    expect(store.rows[0]).toMatchObject({ status: 'logged', jobber_expense_id: 'exp-hd' });
    vi.restoreAllMocks();
  });

  it('sends no jobId for a row with no matched job', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const log = vi.fn(async () => ({ outcome: 'created' as const, expenseId: 'exp-sq', verified: true }));
    await runInvoiceInboxScan(
      { fetchMailboxAddress: () => Promise.resolve('b@x.com'), fetchInvoiceMessages: () => Promise.resolve([msg({ receiptUrl: SQUARE_LINK })]) },
      store as unknown as D1Database,
      liveDeps({ jobber: jobber(), log }),
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect((log.mock.calls[0][4] as { jobId?: string }).jobId).toBeUndefined();
    expect(store.rows[0]).toMatchObject({ status: 'logged' });
    vi.restoreAllMocks();
  });

  it('logExpense links the expense to jobId and omits linkedJobId without it', async () => {
    const rows = new Map<string, { status: string; jobber_expense_id: string | null }>();
    const store = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async run() {
                const key = (sql.includes('UPDATE') ? args[2] : args[0]) as string;
                if (sql.includes('INSERT')) {
                  if (rows.has(key)) return { meta: { changes: 0 } };
                  rows.set(key, { status: 'pending', jobber_expense_id: null });
                  return { meta: { changes: 1 } };
                }
                if (sql.includes('DELETE')) { rows.delete(key); return { meta: { changes: 1 } }; }
                if (sql.includes('UPDATE')) { const r = rows.get(key); if (r) Object.assign(r, { status: args[0], jobber_expense_id: args[1] }); return { meta: { changes: 1 } }; }
                throw new Error(sql);
              },
              async first() { return rows.get(args[0] as string) ?? null; },
            };
          },
        };
      },
    };
    const title = 'Home Depot W12345678';
    const j = {
      graphqlRequest: vi.fn(async (query: string, vars?: Record<string, unknown>) => {
        if (query === EXPENSE_CREATE_QUERIES.EXPENSES_QUERY) return { expenses: { edges: [] } };
        if (query === EXPENSE_CREATE_QUERIES.EXPENSE_CREATE) return { expenseCreate: { expense: { id: 'exp-hd', title, total: 143.27, date: '2026-11-20T12:00:00Z' }, userErrors: [] } };
        if (query === EXPENSE_CREATE_QUERIES.EXPENSE_QUERY) return { expense: { id: vars?.id, title, total: 143.27, date: '2026-11-20T12:00:00Z' } };
        throw new Error('unexpected query');
      }),
    };
    const target = { bucket: {} as never, origin: 'https://cotiza.test' };
    const base = { title, date: '2026-11-20', total: 143.27, noReceipt: true };
    await logExpense(j as never, store as never, target, 'u', { ...base, sourceKey: 'hd-w1', description: 'Home Depot order #W1 (hd-w1)', jobId: 'job-1' }, vi.fn() as never);
    await logExpense(j as never, store as never, target, 'u', { ...base, sourceKey: 'hd-w2', description: 'Home Depot order #W2 (hd-w2)' }, vi.fn() as never);
    const creates = j.graphqlRequest.mock.calls.filter(([q]) => q === EXPENSE_CREATE_QUERIES.EXPENSE_CREATE);
    expect(creates).toHaveLength(2);
    expect((creates[0][1] as { input: Record<string, unknown> }).input.linkedJobId).toBe('job-1');
    expect('linkedJobId' in (creates[1][1] as { input: Record<string, unknown> }).input).toBe(false);
  });

  it('rejects a jobId that is not a Jobber encoded id', async () => {
    const j = { graphqlRequest: vi.fn() };
    await expect(logExpense(
      j as never,
      { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }), first: async () => null }) }) } as never,
      { bucket: {} as never, origin: 'https://cotiza.test' },
      'u',
      { sourceKey: 'hd-w3', title: 'Home Depot W3', description: 'Home Depot order #W3 (hd-w3)', date: '2026-11-20', total: 143.27, noReceipt: true, jobId: 'not a real id!' },
      vi.fn() as never,
    )).rejects.toThrow(/jobId/);
    expect(j.graphqlRequest).not.toHaveBeenCalled();
  });

  it('keeps a matched Home Depot row would_log on dry run while still logging a Square row', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const j = jobber([], [{ id: 'job-1', title: '4123 N Kedzie', jobStatus: 'active' }]);
    const log = vi.fn(async () => ({ outcome: 'created' as const, expenseId: 'exp-sq', verified: true }));
    await runInvoiceInboxScan(
      {
        fetchMailboxAddress: () => Promise.resolve('b@x.com'),
        fetchInvoiceMessages: () => Promise.resolve([
          hdReceipt(),
          msg({ id: 'm2', subject: 'Invoice #5511-R-0025', receiptUrl: SQUARE_LINK }),
        ]),
      },
      store as unknown as D1Database,
      liveDeps({ jobber: j, log, homeDepotGoLive: false }),
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect((log.mock.calls[0][4] as { sourceKey: string }).sourceKey).toBe('20four7va|5511-r-0025');
    expect(store.rows.find((row) => row.message_id === 'm1')).toMatchObject({ status: 'would_log', reason: 'home depot dry run' });
    expect(store.rows.find((row) => row.message_id === 'm2')).toMatchObject({ status: 'logged' });
    vi.restoreAllMocks();
  });

  it('logs a matched Home Depot row once when HOME_DEPOT_GO_LIVE is true', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = db();
    const j = jobber([], [{ id: 'job-1', title: '4123 N Kedzie', jobStatus: 'active' }]);
    const log = vi.fn(async () => ({ outcome: 'created' as const, expenseId: 'exp-hd', verified: true }));
    await runInvoiceInboxScan(
      { fetchMailboxAddress: () => Promise.resolve('b@x.com'), fetchInvoiceMessages: () => Promise.resolve([hdReceipt()]) },
      store as unknown as D1Database,
      liveDeps({ jobber: j, log, homeDepotGoLive: true }),
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(store.rows[0]).toMatchObject({ status: 'logged', jobber_expense_id: 'exp-hd' });
    vi.restoreAllMocks();
  });
});
