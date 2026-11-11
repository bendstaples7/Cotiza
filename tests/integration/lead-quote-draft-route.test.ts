import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../../worker/src/middleware/error-handler.js';
import { PlatformError } from '../../worker/src/errors/platform-error.js';
import { createMockD1 } from '../unit/helpers/mock-d1.js';
import type { MockD1Database } from '../unit/helpers/mock-d1.js';

const REQ = 'req-123';

const mocks = vi.hoisted(() => ({
  generateQuoteDraft: vi.fn(),
  list: vi.fn(),
  log: vi.fn(),
  decorated: null as Record<string, unknown> | null,
}));

vi.mock('../../worker/src/middleware/session.js', () => ({
  sessionMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', { id: 'user-a', email: 'office@chicago-reno.com' });
    await next();
  },
}));
vi.mock('../../worker/src/routes/quotes.js', () => ({ generateQuoteDraft: mocks.generateQuoteDraft }));
vi.mock('../../worker/src/services/lead-info-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../worker/src/services/lead-info-service.js')>();
  return { ...actual, LeadInfoService: vi.fn().mockImplementation(() => ({ list: mocks.list })) };
});
vi.mock('../../worker/src/services/lead-quote-draft.js', () => ({
  buildCustomerNote: (narrative: string | null | undefined, assumptions: string[]) =>
    [narrative, ...assumptions].filter(Boolean).join('\n'),
  findAssumptionConflicts: (assumptions: string[]) =>
    assumptions.map((a) => ({ kind: 'assumption_conflict', detail: `conflict: ${a}` })),
}));
vi.mock('../../worker/src/services/activity-log-service.js', () => ({
  ActivityLogService: vi.fn().mockImplementation(() => ({ log: mocks.log })),
}));

import leads from '../../worker/src/routes/leads.js';

const testApp = () => {
  const app = new Hono();
  app.onError(errorHandler);
  app.route('/api/leads', leads);
  return app;
};

const env = (db: MockD1Database) => ({ DB: db as unknown as D1Database }) as never;

function withExisting(db: MockD1Database, existing: { id: string } | null) {
  db.prepare.mockImplementation(() => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(existing),
      all: vi.fn().mockResolvedValue({ results: [], success: true }),
      run: vi.fn().mockResolvedValue({ success: true, meta: {} }),
      raw: vi.fn().mockResolvedValue([]),
    };
    return stmt;
  });
}

const post = (db: MockD1Database, existing: { id: string } | null) => {
  withExisting(db, existing);
  return testApp().request(`/api/leads/${REQ}/draft`, { method: 'POST' }, env(db));
};
const get = (db: MockD1Database, existing: { id: string } | null) => {
  withExisting(db, existing);
  return testApp().request(`/api/leads/${REQ}/draft`, {}, env(db));
};

describe('lead draft quote route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decorated = null;
    mocks.list.mockResolvedValue([]);
    mocks.log.mockResolvedValue(undefined);
    mocks.generateQuoteDraft.mockImplementation(async (_c: unknown, body: any) => {
      const draft: Record<string, unknown> = {
        id: 'draft-1',
        customerNote: 'narrative',
        customerRequestText: 'the request text',
        lineItems: [{ id: 'li-1' }],
        actionItems: [],
      };
      body.decorate?.(draft);
      mocks.decorated = draft;
      return draft;
    });
  });

  it('generates once and decorates the draft with the lead note and conflicts', async () => {
    mocks.list.mockResolvedValue([
      { id: 'i1', question: 'Assumed: 12ft ceilings', status: 'open', answer: null },
      { id: 'i2', question: 'Assumed: two coats', status: 'open', answer: null },
      { id: 'i3', question: 'Pets?', status: 'answered', answer: 'no' },
    ]);
    const res = await post(createMockD1(), null);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ draftId: 'draft-1' });
    expect(mocks.generateQuoteDraft).toHaveBeenCalledTimes(1);

    const body = mocks.generateQuoteDraft.mock.calls[0][1];
    expect(body.jobberRequestId).toBe(REQ);
    expect(body.leadContextText).toContain('Assumed: 12ft ceilings');
    expect(body.leadContextText).toContain('Pets?: no');

    expect(mocks.decorated?.customerNote).toContain('Assumed: 12ft ceilings');
    expect(mocks.decorated?.customerNote).toContain('Assumed: two coats');
    expect(mocks.decorated?.actionItems).toHaveLength(2);
    expect(mocks.decorated?.actionItems).toEqual([
      expect.objectContaining({ description: 'conflict: Assumed: 12ft ceilings' }),
      expect.objectContaining({ description: 'conflict: Assumed: two coats' }),
    ]);
  });

  it('is idempotent: a second POST returns the stored draft and never regenerates', async () => {
    const db = createMockD1();
    expect(await (await post(db, null)).json()).toEqual({ draftId: 'draft-1' });
    expect(await (await post(db, { id: 'draft-1' })).json()).toEqual({ draftId: 'draft-1' });
    expect(mocks.generateQuoteDraft).toHaveBeenCalledTimes(1);
  });

  it('GET never generates and returns the stored draft id, or null', async () => {
    const db = createMockD1();
    expect(await (await get(db, null)).json()).toEqual({ draftId: null });
    expect(await (await get(db, { id: 'draft-9' })).json()).toEqual({ draftId: 'draft-9' });
    expect(mocks.generateQuoteDraft).not.toHaveBeenCalled();
  });

  it('surfaces a 4xx when the shared path rejects (no request text)', async () => {
    mocks.generateQuoteDraft.mockRejectedValue(
      new PlatformError({
        severity: 'error',
        component: 'QuoteRoutes',
        operation: 'generate',
        description: 'Could not load Jobber request details for this quote.',
        recommendedActions: ['Try again'],
        statusCode: 422,
      }),
    );
    const res = await post(createMockD1(), null);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
