/**
 * Integration Tests — Review Quote API Routes
 *
 * Tests all review API endpoints by creating a Hono app with
 * mocked bindings (DB, env) and session middleware.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { User } from 'shared';
import { createMockD1, configurePrepareResults } from '../unit/helpers/mock-d1.js';
import type { MockD1Database } from '../unit/helpers/mock-d1.js';
import { errorHandler } from '../../worker/src/middleware/error-handler.js';
import reviewsApp from '../../worker/src/routes/reviews.js';

// Mock AuthService so sessionMiddleware passes without a real DB session lookup.
// verifySession returns TEST_USER for any non-empty token.
vi.mock('../../worker/src/services/auth-service.js', () => ({
  AuthService: vi.fn().mockImplementation(() => ({
    verifySession: vi.fn().mockResolvedValue({
      id: 'user-test-001',
      email: 'test@chicago-reno.com',
      name: 'Test User',
      createdAt: new Date('2025-01-01T00:00:00Z'),
      lastActiveAt: new Date('2025-01-01T00:00:00Z'),
    }),
  })),
}));

// Mock JobberIntegration and JobberTokenStore so the /push route works in tests
// without real Jobber credentials.
vi.mock('../../worker/src/services/jobber-integration.js', () => ({
  JobberIntegration: vi.fn().mockImplementation(() => ({
    loadPersistedTokens: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../worker/src/services/jobber-token-store.js', () => ({
  JobberTokenStore: vi.fn().mockImplementation(() => ({})),
}));

// Mock JobberQuotePushService so the /push route returns stub Jobber IDs
// without making real API calls.
vi.mock('../../worker/src/services/jobber-quote-push-service.js', () => ({
  JobberQuotePushService: vi.fn().mockImplementation(() => ({
    pushToJobber: vi.fn().mockResolvedValue({
      jobberQuoteId: 'jobber-quote-id-stub',
      jobberQuoteNumber: 'Q-9999',
      jobberQuoteWebUri: 'https://app.getjobber.com/quotes/stub',
    }),
  })),
}));

const TEST_USER: User = {
  id: 'user-test-001',
  email: 'test@chicago-reno.com',
  name: 'Test User',
  createdAt: new Date('2025-01-01T00:00:00Z'),
  lastActiveAt: new Date('2025-01-01T00:00:00Z'),
};

describe('Review API Routes', () => {
  let db: MockD1Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockD1();
  });

  // Helper to re-create app with the middleware order correct
  function createTestApp(): Hono {
    const testApp = new Hono();

    // Register error handler so PlatformError instances return their correct statusCode
    // instead of a generic 500.
    testApp.onError(errorHandler);

    // Bind DB first — sessionMiddleware inside reviewsApp needs c.env.DB
    testApp.use('*', async (c, next) => {
      c.env = { DB: db as unknown as D1Database } as any;
      await next();
    });

    testApp.route('/api', reviewsApp);
    return testApp;
  }

  /**
   * All requests must include this header. sessionMiddleware checks for a Bearer
   * token before calling verifySession — without it the middleware throws 401
   * before the route handler even runs. The AuthService mock above ensures
   * verifySession accepts any non-empty token and returns TEST_USER.
   */
  const AUTH_HEADERS = { Authorization: 'Bearer test-token' };

  describe('POST /api/quotes/:id/submit-review', () => {
    it('submits a quote for review', async () => {
      vi.stubGlobal('crypto', { randomUUID: () => 'review-uuid-999' });

      configurePrepareResults(db, [
        // Route: QuoteDraftService.getById — draft row (scoped to userId)
        { first: {
          id: 'draft-1', user_id: TEST_USER.id, customer_request_text: 'test',
          selected_template_id: null, selected_template_name: null,
          status: 'draft', review_status: null, jobber_request_id: null, customer_note: null,
          manual_request_id: null, draft_number: 42,
          jobber_quote_id: null, jobber_quote_number: null, jobber_quote_web_uri: null,
          sqft_resolution_json: null, deposit_schedule: null,
          space_context_json: null, generation_trace_json: null,
          created_at: '2026-06-14T12:00:00Z', updated_at: '2026-06-14T12:00:00Z',
        } },
        // Route: QuoteDraftService.getById — line items (resolved=1 so submitForReview passes the
        // "must have at least one line item" validation check)
        { all: { results: [
          { id: 'li-1', product_catalog_entry_id: null, product_name: 'Drywall', description: '',
            quantity: 1, unit_price: 100, confidence_score: 100, original_text: 'drywall',
            resolved: 1, unmatched_reason: null, display_order: 0, rationale_json: null },
        ] } },
        // Route: QuoteDraftService.getById — action items
        { all: { results: [] } },
        // submitForReview: check draft exists (status/review_status guards)
        { first: { id: 'draft-1', status: 'draft', review_status: null, jobber_quote_id: null, draft_number: 42 } },
        // submitForReview: get review cycle
        { first: { next_cycle: 1 } },
        // submitForReview: insert review record
        { run: { success: true, meta: { changes: 1 } } },
        // submitForReview: insert snapshot
        { run: { success: true, meta: { changes: 1 } } },
        // submitForReview: update draft review_status = 'pending_review'
        { run: { success: true, meta: { changes: 1 } } },
        // submitForReview: notifyReviewSubmitted → ActivityLog
        { run: { success: true, meta: { changes: 1 } } },
        // Route: post-submit activity log
        { run: { success: true, meta: { changes: 1 } } },
      ]);

      const testApp = createTestApp();
      const res = await testApp.request('/api/quotes/draft-1/submit-review', {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('reviewId', 'review-uuid-999');
      expect(body).toHaveProperty('status', 'pending_review');
    });
  });

  describe('GET /api/reviews/pending', () => {
    it('returns pending reviews', async () => {
      const now = new Date().toISOString();
      configurePrepareResults(db, [
        {
          all: {
            results: [
              {
                id: 'review-1',
                quote_draft_id: 'draft-1',
                draft_number: 42,
                customer_request_text: 'Kitchen renovation',
                status: 'pending_review',
                submitted_at: now,
                review_cycle: 1,
                submitted_by_id: TEST_USER.id,
                total_value: 15000,
                submitted_by_name: 'Test User',
              },
            ],
          },
        },
      ]);

      const testApp = createTestApp();
      const res = await testApp.request('/api/reviews/pending', {
        headers: AUTH_HEADERS,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reviews).toHaveLength(1);
      expect(body.reviews[0].draftNumber).toBe(42);
      expect(body.reviews[0].status).toBe('pending_review');
    });
  });

  describe('GET /api/reviews/:id', () => {
    it('returns review detail', async () => {
      const now = new Date().toISOString();
      configurePrepareResults(db, [
        // getReview: get review row
        {
          first: {
            id: 'review-1', quote_draft_id: 'draft-1', status: 'pending_review',
            submitted_at: now, completed_at: null, snapshot_id: null,
            notes: null, reviewer_notes: null,
            created_at: now, updated_at: now,
            submitted_by_id: TEST_USER.id, reviewer_id: TEST_USER.id,
            review_cycle: 1, outcome: null,
          },
        },
        // getReview: get feedback
        { all: { results: [] } },
        // getReview: get snapshots
        { all: { results: [] } },
        // QuoteDraftService.getByIdForReview: draft row (no user filter)
        {
          first: {
            id: 'draft-1', user_id: TEST_USER.id, customer_request_text: 'Kitchen renovation',
            selected_template_id: null, selected_template_name: null,
            status: 'draft', review_status: null, jobber_request_id: null, customer_note: null,
            manual_request_id: null, draft_number: 42,
            jobber_quote_id: null, jobber_quote_number: null, jobber_quote_web_uri: null,
            sqft_resolution_json: null, deposit_schedule: null,
            space_context_json: null, generation_trace_json: null,
            created_at: now, updated_at: now,
          },
        },
        // QuoteDraftService.getByIdForReview: line items
        { all: { results: [] } },
        // QuoteDraftService.getByIdForReview: action items
        { all: { results: [] } },
      ]);

      const testApp = createTestApp();
      const res = await testApp.request('/api/reviews/review-1', {
        headers: AUTH_HEADERS,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('review');
      expect(body.review.id).toBe('review-1');
      expect(body).toHaveProperty('feedback');
      expect(body).toHaveProperty('quote');
    });

    it('returns 404 for non-existent review', async () => {
      configurePrepareResults(db, [
        { first: null },
      ]);

      const testApp = createTestApp();
      const res = await testApp.request('/api/reviews/review-missing', {
        headers: AUTH_HEADERS,
      });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/reviews/:id/feedback', () => {
    it('adds feedback to a review', async () => {
      vi.stubGlobal('crypto', { randomUUID: () => 'feedback-uuid-777' });

      configurePrepareResults(db, [
        { first: { id: 'review-1', status: 'pending_review' } },
        { run: { success: true, meta: { changes: 1 } } },
      ]);

      const testApp = createTestApp();
      const res = await testApp.request('/api/reviews/review-1/feedback', {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'line_item',
          lineItemId: 'li-1',
          fieldName: 'quantity',
          content: 'Quantity seems too high',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('feedbackId', 'feedback-uuid-777');
    });

    it('rejects empty feedback content', async () => {
      const testApp = createTestApp();
      const res = await testApp.request('/api/reviews/review-1/feedback', {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'line_item',
          lineItemId: 'li-1',
          fieldName: 'quantity',
          content: '',
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/reviews/:id/complete', () => {
    it('completes review with changes_requested outcome', async () => {
      vi.stubGlobal('crypto', { randomUUID: () => 'complete-uuid' });

      configurePrepareResults(db, [
        // completeReview: get review
        { first: { id: 'review-1', quote_draft_id: 'draft-1', status: 'pending_review', review_cycle: 1 } },
        // completeWithChangesRequested: update review status
        { run: { success: true, meta: { changes: 1 } } },
        // completeWithChangesRequested: update draft review_status = 'changes_requested'
        { run: { success: true, meta: { changes: 1 } } },
        // completeWithChangesRequested: get review for notify (JOIN query)
        { first: { submitted_by_id: TEST_USER.id, draft_number: 42 } },
        // completeWithChangesRequested: notifyChangesRequested → ActivityLog
        { run: { success: true, meta: { changes: 1 } } },
        // Complete endpoint: get draft info for activity logging
        { first: { draft_number: 42, quote_draft_id: 'draft-1' } },
        // Complete endpoint: activity log for changes_requested
        { run: { success: true, meta: { changes: 1 } } },
      ]);

      const testApp = createTestApp();
      const res = await testApp.request('/api/reviews/review-1/complete', {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome: 'changes_requested' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('changes_requested');
    });

    it('rejects invalid outcome', async () => {
      const testApp = createTestApp();
      const res = await testApp.request('/api/reviews/review-1/complete', {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome: 'invalid_outcome' }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/reviews/:id/push', () => {
    it('pushes review to Jobber', async () => {
      vi.stubGlobal('crypto', { randomUUID: () => 'push-uuid' });

      configurePrepareResults(db, [
        // pushToJobber: first GET review (existence/status check in pushToJobber)
        { first: { id: 'review-1', quote_draft_id: 'draft-1', status: 'pending_review' } },
        // completeReview: second GET review (status guard before dispatching outcome)
        { first: { id: 'review-1', quote_draft_id: 'draft-1', status: 'pending_review', review_cycle: 1 } },
        // completeWithPush: get draft row
        { first: { id: 'draft-1', status: 'draft', review_status: 'pending_review', jobber_quote_id: null,
                   draft_number: 42, user_id: TEST_USER.id, customer_request_text: 'test',
                   customer_note: null, deposit_schedule: null } },
        // completeWithPush: get resolved line items (for push payload)
        { all: { results: [] } },
        // completeWithPush: get unresolved line items (for push payload)
        { all: { results: [] } },
        // completeWithPush: update review status = 'push_to_jobber'
        { run: { success: true, meta: { changes: 1 } } },
        // completeWithPush: update draft review_status = 'none'
        { run: { success: true, meta: { changes: 1 } } },
        // completeWithPush: notifyPushedToJobber → ActivityLog
        { run: { success: true, meta: { changes: 1 } } },
        // Route: activity log for push
        { run: { success: true, meta: { changes: 1 } } },
      ]);

      const testApp = createTestApp();
      const res = await testApp.request('/api/reviews/review-1/push', {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('jobberQuoteId');
      expect(body).toHaveProperty('jobberQuoteNumber');
      expect(body).toHaveProperty('jobberQuoteWebUri');
    });
  });

  describe('GET /api/reviews/:id/diff', () => {
    it('returns diff between snapshot and current state', async () => {
      const snapshotData = JSON.stringify({
        lineItems: [
          { id: 'li-1', productName: 'Drywall', description: 'Old desc', quantity: 100, unitPrice: 10, total: 1000 },
          { id: 'li-2', productName: 'Paint', description: 'Paint', quantity: 50, unitPrice: 5, total: 250 },
        ],
        terms: null, notes: null, customerNote: null,
        depositSchedule: null, totalValue: 1250,
      });

      const snapRow = {
        id: 'snap-1', quote_draft_id: 'draft-1', review_id: 'review-1',
        snapshot_data: snapshotData, created_at: '2026-06-14T12:00:00Z',
      };

      configurePrepareResults(db, [
        // getDiff: get review
        { first: { quote_draft_id: 'draft-1' } },
        // getDiff: get latest snapshot
        { first: snapRow },
        // getDiff: get current resolved line items
        {
          all: {
            results: [
              { id: 'li-1', product_name: 'Drywall', description: 'New desc', quantity: 110, unit_price: 10 },
              { id: 'li-3', product_name: 'New Item', description: 'Added later', quantity: 5, unit_price: 20 },
            ],
          },
        },
      ]);

      const testApp = createTestApp();
      const res = await testApp.request('/api/reviews/review-1/diff', {
        headers: AUTH_HEADERS,
      });

      expect(res.status).toBe(200);
      const body = await res.json();

      // li-1 modified (quantity 100→110, description changed)
      expect(body.modifiedItems).toHaveLength(1);
      expect(body.modifiedItems[0].lineItemId).toBe('li-1');
      expect(body.modifiedItems[0].previous.quantity).toBe(100);
      expect(body.modifiedItems[0].current.quantity).toBe(110);

      // li-2 removed
      expect(body.removedItems).toHaveLength(1);
      expect(body.removedItems[0].lineItemId).toBe('li-2');

      // li-3 added
      expect(body.addedItems).toHaveLength(1);
      expect(body.addedItems[0].lineItemId).toBe('li-3');
    });

    it('returns 404 when review not found', async () => {
      configurePrepareResults(db, [
        { first: null },
      ]);

      const testApp = createTestApp();
      const res = await testApp.request('/api/reviews/review-missing/diff', {
        headers: AUTH_HEADERS,
      });

      expect(res.status).toBe(404);
    });
  });
});
