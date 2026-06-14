import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockD1, configurePrepareResults } from './helpers/mock-d1.js';
import type { MockD1Database } from './helpers/mock-d1.js';
import { ReviewService } from '../../worker/src/services/review-service.js';
import { PlatformError } from '../../worker/src/errors/platform-error.js';
import type { QuoteLineItem, DepositSchedule } from 'shared';

// Mock crypto.randomUUID
const mockUUID = vi.fn();
vi.stubGlobal('crypto', { randomUUID: mockUUID });

describe('ReviewService', () => {
  let db: MockD1Database;
  let service: ReviewService;

  const mockLineItems: QuoteLineItem[] = [
    {
      id: 'li-1',
      productName: 'Drywall Installation',
      description: 'Install drywall for living room',
      quantity: 1200,
      unitPrice: 8.50,
      confidenceScore: 0.95,
      originalText: 'drywall installation',
      resolved: true,
      productCatalogEntryId: null,
    },
  ];

  const mockDepositSchedule: DepositSchedule = {
    label: 'Standard',
    milestones: [
      { description: 'Deposit', percentage: 50 },
      { description: 'Completion', percentage: 50 },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUUID.mockReset();
    mockUUID.mockReturnValue('mock-uuid-123');
    db = createMockD1();
    service = new ReviewService(db as unknown as D1Database);
  });

  describe('submitForReview', () => {
    it('creates a review record', async () => {
      // Draft row returns a valid draft
      configurePrepareResults(db, [
        { first: { id: 'draft-1', status: 'draft', review_status: null, jobber_quote_id: null, draft_number: 42 } },
        { first: { next_cycle: 1 } },
        { run: { success: true, meta: { changes: 1 } } },
        { run: { success: true, meta: { changes: 1 } } },
        { run: { success: true, meta: { changes: 1 } } },
      ]);

      const result = await service.submitForReview(
        'draft-1',
        'user-1',
        'reviewer-1',
        mockLineItems,
        'Customer note text',
        mockDepositSchedule,
      );

      expect(result).toEqual({
        reviewId: 'mock-uuid-123',
        reviewCycle: 1,
        status: 'pending_review',
      });

      // Should have inserted a quote_reviews row
      const insertCall = db.prepare.mock.calls.find(
        (call: [string]) => call[0].includes('INSERT INTO quote_reviews'),
      );
      expect(insertCall).toBeDefined();

      // Should have updated draft review_status
      const updateCall = db.prepare.mock.calls.find(
        (call: [string]) => call[0].includes('UPDATE quote_drafts'),
      );
      expect(updateCall).toBeDefined();
    });

    it('takes a snapshot when submitting for review', async () => {
      configurePrepareResults(db, [
        { first: { id: 'draft-1', status: 'draft', review_status: null, jobber_quote_id: null, draft_number: 42 } },
        { first: { next_cycle: 1 } },
        { run: { success: true, meta: { changes: 1 } } },
        { run: { success: true, meta: { changes: 1 } } },
        { run: { success: true, meta: { changes: 1 } } },
      ]);

      await service.submitForReview(
        'draft-1',
        'user-1',
        'reviewer-1',
        mockLineItems,
        null,
        null,
      );

      // Should have inserted a snapshot via snapshotService
      const snapshotInsertCall = db.prepare.mock.calls.find(
        (call: [string]) => call[0].includes('INSERT INTO quote_review_snapshots'),
      );
      expect(snapshotInsertCall).toBeDefined();
    });

    it('rejects if quote is already under review', async () => {
      configurePrepareResults(db, [
        { first: { id: 'draft-1', status: 'draft', review_status: 'pending_review', jobber_quote_id: null, draft_number: 42 } },
        { first: { id: 'draft-1', status: 'draft', review_status: 'pending_review', jobber_quote_id: null, draft_number: 42 } },
      ]);

      // First call
      try {
        await service.submitForReview('draft-1', 'user-1', 'reviewer-1', mockLineItems, null, null);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PlatformError);
        expect((err as PlatformError).description).toMatch(/already under review/i);
        expect((err as PlatformError).statusCode).toBe(400);
      }

      // Second call should also reject (configured with same result)
      try {
        await service.submitForReview('draft-1', 'user-1', 'reviewer-1', mockLineItems, null, null);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PlatformError);
        expect((err as PlatformError).description).toMatch(/already under review/i);
        expect((err as PlatformError).statusCode).toBe(400);
      }
    });

    it('rejects if quote draft does not exist', async () => {
      configurePrepareResults(db, [
        { first: null },
      ]);

      try {
        await service.submitForReview('draft-missing', 'user-1', 'reviewer-1', mockLineItems, null, null);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PlatformError);
        expect((err as PlatformError).description).toMatch(/not found/i);
        expect((err as PlatformError).statusCode).toBe(404);
      }
    });

    it('rejects if quote has no line items', async () => {
      configurePrepareResults(db, [
        { first: { id: 'draft-1', status: 'draft', review_status: null, jobber_quote_id: null, draft_number: 42 } },
      ]);

      try {
        await service.submitForReview('draft-1', 'user-1', 'reviewer-1', [], null, null);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PlatformError);
        expect((err as PlatformError).description).toMatch(/at least one line item/i);
        expect((err as PlatformError).statusCode).toBe(400);
      }
    });
  });

  describe('addFeedback', () => {
    it('creates a feedback record', async () => {
      configurePrepareResults(db, [
        { first: { id: 'review-1', status: 'pending_review' } },
        { run: { success: true, meta: { changes: 1 } } },
      ]);

      const result = await service.addFeedback(
        'review-1',
        'li-1',
        'quantity',
        'Quantity seems too high',
        'user-1',
      );

      expect(result).toHaveProperty('feedbackId');
      expect(result).toHaveProperty('createdAt');

      // Check insert was called with correct params
      const insertCall = db.prepare.mock.calls.find(
        (call: [string]) => call[0].includes('INSERT INTO review_line_item_feedback'),
      );
      expect(insertCall).toBeDefined();
    });

    it('throws if review does not exist', async () => {
      configurePrepareResults(db, [
        { first: null },
      ]);

      try {
        await service.addFeedback('review-missing', 'li-1', 'quantity', 'Comment', 'user-1');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PlatformError);
        expect((err as PlatformError).description).toMatch(/not found/i);
        expect((err as PlatformError).statusCode).toBe(404);
      }
    });

    it('throws if review is already completed', async () => {
      configurePrepareResults(db, [
        { first: { id: 'review-1', status: 'push_to_jobber' } },
      ]);

      try {
        await service.addFeedback('review-1', 'li-1', 'quantity', 'Comment', 'user-1');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PlatformError);
        expect((err as PlatformError).description).toMatch(/completed/i);
        expect((err as PlatformError).statusCode).toBe(400);
      }
    });
  });

  describe('completeReview', () => {
    it('marks review with push_to_jobber outcome', async () => {
      mockUUID.mockReturnValue('mock-uuid-123');
      configurePrepareResults(db, [
        { first: { id: 'review-1', quote_draft_id: 'draft-1', status: 'pending_review', review_cycle: 1 } },
        // completeWithPush: get draft row
        { first: { id: 'draft-1', status: 'draft', review_status: 'pending_review', jobber_quote_id: null, draft_number: 42, user_id: 'user-1', customer_request_text: 'test', customer_note: null, deposit_schedule: null } },
        // completeWithPush without jobber: just update review + draft
        { run: { success: true, meta: { changes: 1 } } },
        { run: { success: true, meta: { changes: 1 } } },
        // notifyPushedToJobber: activity log insert
        { run: { success: true, meta: { changes: 1 } } },
      ]);

      const result = await service.completeReview('review-1', 'push_to_jobber');

      expect(result.status).toBe('push_to_jobber');
      expect(result).toHaveProperty('reviewCompletedAt');

      // Verify review was updated to push_to_jobber
      const updateReviewCall = db.prepare.mock.calls.find(
        (call: [string]) => call[0].includes("SET status = 'push_to_jobber'"),
      );
      expect(updateReviewCall).toBeDefined();
    });

    it('marks review with changes_requested outcome', async () => {
      configurePrepareResults(db, [
        { first: { id: 'review-1', quote_draft_id: 'draft-1', status: 'pending_review', review_cycle: 1 } },
        // completeWithChangesRequested: update review + draft + notify
        { run: { success: true, meta: { changes: 1 } } },
        { run: { success: true, meta: { changes: 1 } } },
        // notifyChangesRequested: get submitted_by
        { first: { submitted_by_id: 'user-2', draft_number: 42 } },
        // notifyChangesRequested: activity log
        { run: { success: true, meta: { changes: 1 } } },
      ]);

      const result = await service.completeReview('review-1', 'changes_requested');

      expect(result.status).toBe('changes_requested');
      expect(result).toHaveProperty('reviewCompletedAt');

      // Verify review was updated to changes_requested
      const updateReviewCall = db.prepare.mock.calls.find(
        (call: [string]) => call[0].includes("SET status = 'changes_requested'"),
      );
      expect(updateReviewCall).toBeDefined();

      // Verify draft was updated
      const updateDraftCall = db.prepare.mock.calls.find(
        (call: [string]) => call[0].includes("SET review_status = 'changes_requested'"),
      );
      expect(updateDraftCall).toBeDefined();
    });

    it('throws if review is not found', async () => {
      configurePrepareResults(db, [
        { first: null },
      ]);

      try {
        await service.completeReview('review-missing', 'push_to_jobber');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PlatformError);
        expect((err as PlatformError).description).toMatch(/not found/i);
        expect((err as PlatformError).statusCode).toBe(404);
      }
    });

    it('throws if review is already completed', async () => {
      configurePrepareResults(db, [
        { first: { id: 'review-1', quote_draft_id: 'draft-1', status: 'push_to_jobber', review_cycle: 1 } },
      ]);

      try {
        await service.completeReview('review-1', 'push_to_jobber');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PlatformError);
        expect((err as PlatformError).description).toMatch(/already completed/i);
        expect((err as PlatformError).statusCode).toBe(400);
      }
    });
  });

  describe('pushToJobber', () => {
    it('updates status after push', async () => {
      mockUUID.mockReturnValue('mock-uuid-123');
      configurePrepareResults(db, [
        // pushToJobber: get review row
        { first: { id: 'review-1', quote_draft_id: 'draft-1', status: 'pending_review' } },
        // completeReview: get review row
        { first: { id: 'review-1', quote_draft_id: 'draft-1', status: 'pending_review', review_cycle: 1 } },
        // completeWithPush: get draft row (no jobber integration → skip push)
        { first: { id: 'draft-1', status: 'draft', review_status: 'pending_review', jobber_quote_id: null, draft_number: 42, user_id: 'user-1', customer_request_text: 'test', customer_note: null, deposit_schedule: null } },
        // completeWithPush: UPDATE quote_reviews
        { run: { success: true, meta: { changes: 1 } } },
        // completeWithPush: UPDATE quote_drafts
        { run: { success: true, meta: { changes: 1 } } },
        // notifyPushedToJobber: activity log
        { run: { success: true, meta: { changes: 1 } } },
      ]);

      // Pass undefined jobberIntegration so it skips the Jobber push path
      const result = await service.pushToJobber('review-1', undefined as any);

      expect(result).toHaveProperty('jobberQuoteId');
      expect(result).toHaveProperty('jobberQuoteNumber');
      expect(result).toHaveProperty('jobberQuoteWebUri');
    });
  });

  describe('getPendingReviewCount', () => {
    it('returns count from DB', async () => {
      configurePrepareResults(db, [
        { first: { count: 5 } },
      ]);

      const count = await service.getPendingReviewCount();

      expect(count).toBe(5);
    });

    it('returns 0 when no results', async () => {
      configurePrepareResults(db, [
        { first: null },
      ]);

      const count = await service.getPendingReviewCount();

      expect(count).toBe(0);
    });
  });
});