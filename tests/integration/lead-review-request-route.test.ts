import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockD1 } from '../unit/helpers/mock-d1.js';
import type { MockD1Database } from '../unit/helpers/mock-d1.js';

const REQ = 'Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMzU3NTY4NzI=';
const QUOTE = 'Z2lkOi8vSm9iYmVyL1F1b3RlLzE=';

const mocks = vi.hoisted(() => ({
  listRequestQuotes: vi.fn(),
  readQuote: vi.fn(),
  requestReview: vi.fn(),
}));

vi.mock('../../worker/src/middleware/session.js', () => ({
  sessionMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', { id: 'user-a', email: 'office@chicago-reno.com' });
    await next();
  },
}));
vi.mock('../../worker/src/services/jobber-integration.js', () => ({
  openJobberIntegration: vi.fn().mockResolvedValue({ jobberIntegration: {} }),
}));
vi.mock('../../worker/src/services/ops-assistant-read.js', () => ({
  OpsAssistantRead: vi.fn().mockImplementation(() => ({
    listRequestQuotes: mocks.listRequestQuotes,
    readQuote: mocks.readQuote,
  })),
}));
vi.mock('../../worker/src/services/lead-quote-stage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../worker/src/services/lead-quote-stage.js')>();
  return { ...actual, requestReview: mocks.requestReview };
});

import leads from '../../worker/src/routes/leads.js';

const env = (db: MockD1Database) => ({ DB: db as unknown as D1Database }) as never;

const draftQuote = {
  outcome: 'ok',
  jobberQuotes: {
    outcome: 'ok',
    items: [
      {
        id: QUOTE,
        quoteNumber: { availability: 'present', value: 'Q-1' },
        status: { availability: 'present', value: 'draft' },
        jobberWebUri: { availability: 'present', value: 'https://app.getjobber.com/quotes/1' },
      },
    ],
    page: { hasNextPage: false },
  },
};

const quoteDetail = {
  outcome: 'ok',
  quote: {
    clientName: { availability: 'present', value: 'Acme' },
    paymentTerms: { availability: 'present', amounts: { total: 1000 } },
  },
};

describe('POST /api/leads/:requestId/quotes/:quoteId/review-request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom has no Web Crypto: the route's note key and note id need it.
    vi.stubGlobal('crypto', {
      randomUUID: () => 'uuid-test',
      subtle: { digest: async () => new ArrayBuffer(32) },
    });
    mocks.listRequestQuotes.mockResolvedValue(draftQuote);
    mocks.readQuote.mockResolvedValue(quoteDetail);
    mocks.requestReview.mockResolvedValue('2026-11-01T12:00:00.000Z');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a sent draft appears', async () => {
    const db = createMockD1();
    const res = await leads.request(
      `/${REQ}/quotes/${QUOTE}/review-request`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      env(db),
    );

    expect(res.status).toBe(200);
    expect(mocks.readQuote).toHaveBeenCalledWith('user-a', { quoteId: QUOTE });
    // The lead name, total and Jobber link are stored on the review request row.
    const update = db._stmts.find((s) => (s.bind.mock.calls[0] ?? [])[0] === 'Acme');
    expect(update).toBeDefined();
    expect(update!.bind).toHaveBeenCalledWith('Acme', 1000, 'https://app.getjobber.com/quotes/1', QUOTE);
  });

  it('a quote that is not a draft is refused and nothing is stored', async () => {
    mocks.listRequestQuotes.mockResolvedValue({
      ...draftQuote,
      jobberQuotes: {
        ...draftQuote.jobberQuotes,
        items: [{ ...draftQuote.jobberQuotes.items[0], status: { availability: 'present', value: 'sent' } }],
      },
    });
    const db = createMockD1();
    const res = await leads.request(
      `/${REQ}/quotes/${QUOTE}/review-request`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      env(db),
    );

    expect(res.status).toBe(409);
    expect(mocks.requestReview).not.toHaveBeenCalled();
    expect(db._stmts.some((s) => (s.bind.mock.calls[0] ?? [])[0] === 'Acme')).toBe(false);
  });
});
