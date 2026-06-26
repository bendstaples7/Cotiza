import type { QuoteReview, ReviewLineItemFeedback, QuoteDraft, ReviewSnapshot, QuoteLineItem, DepositSchedule } from 'shared';
import { PlatformError } from '../errors/index.js';
import { ReviewSnapshotService, type SnapshotPayload } from './review-snapshot-service.js';
import { JobberQuotePushService } from './jobber-quote-push-service.js';
import type { JobberIntegration } from './jobber-integration.js';
import { ActivityLogService } from './activity-log-service.js';

export interface ReviewDiff {
  modifiedItems: Array<{
    lineItemId: string;
    productName: string;
    previous: { quantity: number; unitPrice: number; description: string };
    current: { quantity: number; unitPrice: number; description: string };
  }>;
  addedItems: Array<{
    lineItemId: string;
    productName: string;
    quantity: number;
    unitPrice: number;
  }>;
  removedItems: Array<{
    lineItemId: string;
    productName: string;
    previousQuantity: number;
    previousUnitPrice: number;
  }>;
  resolvedFeedback: Array<{
    feedbackId: string;
    content: string;
    resolvedAt: string;
  }>;
}

export interface ReviewQueueItem {
  id: string;
  quoteDraftId: string;
  draftNumber: number;
  clientName: string | null;
  totalValue: number;
  status: string;
  submittedAt: string;
  reviewCycle: number;
  submittedById: string;
}

export interface ReviewDetail {
  review: QuoteReview;
  quote: Partial<QuoteDraft>;
  feedback: ReviewLineItemFeedback[];
  previousSnapshots: ReviewSnapshot[];
}

export class ReviewService {
  private readonly db: D1Database;
  private readonly snapshotService: ReviewSnapshotService;

  constructor(db: D1Database) {
    this.db = db;
    this.snapshotService = new ReviewSnapshotService(db);
  }

  /**
   * Submit a quote draft for review.
   * Creates a new QuoteReview record with status 'pending_review',
   * takes a snapshot, and updates the draft's review_status.
   */
  async submitForReview(
    quoteDraftId: string,
    submittedById: string,
    reviewerId: string,
    lineItems: QuoteLineItem[],
    customerNote: string | null,
    depositSchedule: DepositSchedule | null,
  ): Promise<{ reviewId: string; reviewCycle: number; status: string }> {
    // Check if already under review
    const draftRow = await this.db.prepare(
      `SELECT id, status, review_status, jobber_quote_id, draft_number
       FROM quote_drafts WHERE id = ?`
    ).bind(quoteDraftId).first() as Record<string, unknown> | null;

    if (!draftRow) {
      throw new PlatformError({
        severity: 'error',
        component: 'ReviewService',
        operation: 'submitForReview',
        description: 'Quote draft not found.',
        recommendedActions: ['Verify the draft exists'],
        statusCode: 404,
      });
    }

    if (draftRow.status === 'finalized') {
      throw new PlatformError({
        severity: 'error',
        component: 'ReviewService',
        operation: 'submitForReview',
        description: 'Cannot submit a finalized quote for review.',
        recommendedActions: ['The quote has already been finalized'],
        statusCode: 400,
      });
    }

    const reviewStatus = draftRow.review_status as string | null;
    if (reviewStatus === 'pending_review') {
      throw new PlatformError({
        severity: 'error',
        component: 'ReviewService',
        operation: 'submitForReview',
        description: 'Quote is already under review.',
        recommendedActions: ['Wait for the current review to complete'],
        statusCode: 400,
      });
    }

    if (draftRow.jobber_quote_id) {
      throw new PlatformError({
        severity: 'error',
        component: 'ReviewService',
        operation: 'submitForReview',
        description: 'Quote has already been pushed to Jobber.',
        recommendedActions: ['A new draft must be created to submit for review'],
        statusCode: 400,
      });
    }

    // Must have at least one line item
    if (!lineItems || lineItems.length === 0) {
      throw new PlatformError({
        severity: 'error',
        component: 'ReviewService',
        operation: 'submitForReview',
        description: 'Quote must have at least one line item to submit for review.',
        recommendedActions: ['Add line items to the quote first'],
        statusCode: 400,
      });
    }

    // Compute next review cycle number
    const cycleRow = await this.db.prepare(
      'SELECT COALESCE(MAX(review_cycle), 0) + 1 AS next_cycle FROM quote_reviews WHERE quote_draft_id = ?'
    ).bind(quoteDraftId).first() as { next_cycle: number } | null;
    const reviewCycle = cycleRow?.next_cycle ?? 1;

    // Create the review record
    const reviewId = crypto.randomUUID();
    await this.db.prepare(
      `INSERT INTO quote_reviews (id, quote_draft_id, status, submitted_by_id, reviewer_id, review_cycle)
       VALUES (?, ?, 'pending_review', ?, ?, ?)`
    ).bind(reviewId, quoteDraftId, submittedById, reviewerId, reviewCycle).run();

    // Take a snapshot of the current quote state
    await this.snapshotService.createSnapshot(
      quoteDraftId,
      reviewId,
      lineItems,
      customerNote,
      depositSchedule,
    );

    // Update the draft's review_status
    await this.db.prepare(
      "UPDATE quote_drafts SET review_status = 'pending_review', updated_at = datetime('now') WHERE id = ?"
    ).bind(quoteDraftId).run();

    // Fire notification for reviewer
    const draftNumber = (draftRow.draft_number as number) ?? 0;
    await this.notifyReviewSubmitted(reviewerId, draftNumber, quoteDraftId);

    return { reviewId, reviewCycle, status: 'pending_review' };
  }

  /**
   * Re-submit a quote for review after changes were requested.
   */
  async reSubmitForReview(
    quoteDraftId: string,
    submittedById: string,
    reviewerId: string,
    lineItems: QuoteLineItem[],
    customerNote: string | null,
    depositSchedule: DepositSchedule | null,
  ): Promise<{ reviewId: string; reviewCycle: number; status: string }> {
    const draftRow = await this.db.prepare(
      'SELECT review_status FROM quote_drafts WHERE id = ?'
    ).bind(quoteDraftId).first() as { review_status: string | null } | null;

    if (!draftRow) {
      throw new PlatformError({
        severity: 'error',
        component: 'ReviewService',
        operation: 'reSubmitForReview',
        description: 'Quote draft not found.',
        recommendedActions: ['Verify the draft exists'],
        statusCode: 404,
      });
    }

    if (draftRow.review_status !== 'changes_requested') {
      throw new PlatformError({
        severity: 'error',
        component: 'ReviewService',
        operation: 'reSubmitForReview',
        description: 'Quote is not in changes_requested status. Cannot re-submit.',
        recommendedActions: ['Only quotes with changes_requested can be re-submitted'],
        statusCode: 400,
      });
    }

    return this.submitForReview(quoteDraftId, submittedById, reviewerId, lineItems, customerNote, depositSchedule);
  }

  /**
   * Get the review queue — all pending_review reviews, sorted by submittedAt (oldest first).
   */
  async getReviewQueue(): Promise<ReviewQueueItem[]> {
    const result = await this.db.prepare(
      `SELECT qr.id, qr.quote_draft_id, qd.draft_number, qd.customer_request_text, qd.deposit_schedule,
              qr.status, qr.submitted_at, qr.review_cycle, qr.submitted_by_id
       FROM quote_reviews qr
       JOIN quote_drafts qd ON qd.id = qr.quote_draft_id
       WHERE qr.status = 'pending_review'
       ORDER BY qr.submitted_at ASC`
    ).all();

    const rows = result.results as Array<Record<string, unknown>>;

    return rows.map((row) => {
      // Compute total value from line items linked to the draft
      let totalValue = 0;
      const depositScheduleRaw = row.deposit_schedule as string | null;
      // We'll fetch line items to compute total value
      return {
        id: row.id as string,
        quoteDraftId: row.quote_draft_id as string,
        draftNumber: (row.draft_number as number) ?? 0,
        clientName: null, // Will be populated from line items context
        totalValue,
        status: row.status as string,
        submittedAt: row.submitted_at as string,
        reviewCycle: (row.review_cycle as number) ?? 1,
        submittedById: row.submitted_by_id as string,
      };
    });
  }

  /**
   * Get a single review with its feedback.
   */
  async getReview(reviewId: string): Promise<ReviewDetail | null> {
    const row = await this.db.prepare(
      `SELECT id, quote_draft_id, status, submitted_at, completed_at, snapshot_id,
              notes, reviewer_notes, created_at, updated_at, submitted_by_id, reviewer_id, review_cycle, outcome
       FROM quote_reviews WHERE id = ?`
    ).bind(reviewId).first() as Record<string, unknown> | null;

    if (!row) return null;

    const review: QuoteReview = {
      id: row.id as string,
      quoteDraftId: row.quote_draft_id as string,
      status: row.status as QuoteReview['status'],
      submittedAt: row.submitted_at as string,
      completedAt: (row.completed_at as string) ?? null,
      snapshotId: (row.snapshot_id as string) ?? null,
      notes: (row.notes as string) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };

    // Get feedback for this review
    const feedbackResult = await this.db.prepare(
      `SELECT rf.id, rf.review_id, rf.line_item_id, rf.field_name, rf.comment, rf.created_at,
              li.product_name
       FROM review_line_item_feedback rf
       LEFT JOIN quote_line_items li ON li.id = rf.line_item_id
       WHERE rf.review_id = ?
       ORDER BY rf.created_at ASC`
    ).bind(reviewId).all();

    const feedback: ReviewLineItemFeedback[] = (feedbackResult.results as any[]).map((r) => ({
      id: r.id as string,
      reviewId: r.review_id as string,
      lineItemId: r.line_item_id as string,
      fieldName: r.field_name as string,
      comment: r.comment as string,
      createdAt: r.created_at as string,
    }));

    // Get previous snapshots
    const snapResult = await this.db.prepare(
      'SELECT id, quote_draft_id, review_id, snapshot_data, created_at FROM quote_review_snapshots WHERE review_id = ? ORDER BY created_at DESC'
    ).bind(reviewId).all();

    const previousSnapshots: ReviewSnapshot[] = (snapResult.results as any[]).map((r) => ({
      id: r.id as string,
      quoteDraftId: r.quote_draft_id as string,
      reviewId: r.review_id as string,
      snapshotData: r.snapshot_data as string,
      createdAt: r.created_at as string,
    }));

    return {
      review,
      quote: { id: row.quote_draft_id as string },
      feedback,
      previousSnapshots,
    };
  }

  /**
   * Add feedback to a line item within a review.
   */
  async addFeedback(
    reviewId: string,
    lineItemId: string,
    fieldName: string,
    comment: string,
    authorId?: string,
  ): Promise<{ feedbackId: string; createdAt: string }> {
    // Verify review exists
    const review = await this.db.prepare(
      'SELECT id, status FROM quote_reviews WHERE id = ?'
    ).bind(reviewId).first() as { id: string; status: string } | null;

    if (!review) {
      throw new PlatformError({
        severity: 'error',
        component: 'ReviewService',
        operation: 'addFeedback',
        description: 'Review not found.',
        recommendedActions: ['Verify the review ID'],
        statusCode: 404,
      });
    }

    if (review.status !== 'pending_review') {
      throw new PlatformError({
        severity: 'error',
        component: 'ReviewService',
        operation: 'addFeedback',
        description: 'Cannot add feedback to a completed review.',
        recommendedActions: ['Only pending reviews can receive feedback'],
        statusCode: 400,
      });
    }

    const feedbackId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    await this.db.prepare(
      `INSERT INTO review_line_item_feedback (id, review_id, line_item_id, field_name, comment, author_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(feedbackId, reviewId, lineItemId, fieldName, comment, authorId ?? null, createdAt).run();

    return { feedbackId, createdAt };
  }

  /**
   * Complete a review with an outcome.
   * If outcome='push_to_jobber', calls jobber push service.
   * If outcome='changes_requested', resets draft review_status.
   */
  async completeReview(
    reviewId: string,
    outcome: 'push_to_jobber' | 'changes_requested',
    reviewerNotes?: string | null,
    jobberIntegration?: JobberIntegration,
  ): Promise<{
    status: string;
    jobberQuoteId?: string;
    jobberQuoteNumber?: string;
    jobberQuoteWebUri?: string;
    reviewCompletedAt?: string;
  }> {
    // Get the review record
    const row = await this.db.prepare(
      'SELECT id, quote_draft_id, status, review_cycle FROM quote_reviews WHERE id = ?'
    ).bind(reviewId).first() as Record<string, unknown> | null;

    if (!row) {
      throw new PlatformError({
        severity: 'error',
        component: 'ReviewService',
        operation: 'completeReview',
        description: 'Review not found.',
        recommendedActions: ['Verify the review ID'],
        statusCode: 404,
      });
    }

    if (row.status !== 'pending_review') {
      throw new PlatformError({
        severity: 'error',
        component: 'ReviewService',
        operation: 'completeReview',
        description: 'Review is already completed.',
        recommendedActions: ['This review has already been completed'],
        statusCode: 400,
      });
    }

    const quoteDraftId = row.quote_draft_id as string;
    const completedAt = new Date().toISOString();

    if (outcome === 'push_to_jobber') {
      return this.completeWithPush(reviewId, quoteDraftId, reviewerNotes, completedAt, jobberIntegration);
    } else {
      return this.completeWithChangesRequested(reviewId, quoteDraftId, reviewerNotes, completedAt);
    }
  }

  /**
   * Complete review with push to Jobber.
   */
  private async completeWithPush(
    reviewId: string,
    quoteDraftId: string,
    reviewerNotes: string | null | undefined,
    completedAt: string,
    jobberIntegration?: JobberIntegration,
  ): Promise<{
    status: string;
    jobberQuoteId?: string;
    jobberQuoteNumber?: string;
    jobberQuoteWebUri?: string;
    reviewCompletedAt: string;
  }> {
    // Get quote draft for push
    const draftRow = await this.db.prepare(
      `SELECT id, status, review_status, jobber_quote_id, jobber_request_id, draft_number, user_id,
              customer_request_text, customer_note, deposit_schedule
       FROM quote_drafts WHERE id = ?`
    ).bind(quoteDraftId).first() as Record<string, unknown> | null;

    if (!draftRow) {
      throw new PlatformError({
        severity: 'error',
        component: 'ReviewService',
        operation: 'completeWithPush',
        description: 'Quote draft not found.',
        recommendedActions: ['Verify the draft exists'],
        statusCode: 404,
      });
    }

    // Push to Jobber if integration is provided
    if (jobberIntegration) {
      const pushService = new JobberQuotePushService(this.db, jobberIntegration);

      // We need the full draft with line items
      const lineItemsResult = await this.db.prepare(
        `SELECT id, product_name, description, quantity, unit_price, confidence_score, original_text,
                resolved, unmatched_reason, display_order, product_catalog_entry_id, rationale_json
         FROM quote_line_items WHERE quote_draft_id = ? AND resolved = 1 ORDER BY display_order ASC`
      ).bind(quoteDraftId).all();

      const unresolvedResult = await this.db.prepare(
        `SELECT id, product_name, description, quantity, unit_price, confidence_score, original_text,
                resolved, unmatched_reason, display_order, product_catalog_entry_id, rationale_json
         FROM quote_line_items WHERE quote_draft_id = ? AND resolved = 0 ORDER BY display_order ASC`
      ).bind(quoteDraftId).all();

      const lineItems: QuoteLineItem[] = (lineItemsResult.results as any[]).map((r) => ({
        id: r.id as string,
        productName: r.product_name as string,
        description: (r.description as string) ?? '',
        quantity: Number(r.quantity),
        unitPrice: Number(r.unit_price),
        confidenceScore: r.confidence_score as number,
        originalText: r.original_text as string,
        resolved: true as const,
        productCatalogEntryId: (r.product_catalog_entry_id as string) ?? null,
        unmatchedReason: (r.unmatched_reason as string) ?? undefined,
      }));

      const unresolvedItems: QuoteLineItem[] = (unresolvedResult.results as any[]).map((r) => ({
        id: r.id as string,
        productName: r.product_name as string,
        description: (r.description as string) ?? '',
        quantity: Number(r.quantity),
        unitPrice: Number(r.unit_price),
        confidenceScore: r.confidence_score as number,
        originalText: r.original_text as string,
        resolved: false as const,
        productCatalogEntryId: (r.product_catalog_entry_id as string) ?? null,
        unmatchedReason: (r.unmatched_reason as string) ?? undefined,
      }));

      let depositSchedule: DepositSchedule | null = null;
      if (draftRow.deposit_schedule) {
        try {
          depositSchedule = JSON.parse(draftRow.deposit_schedule as string) as DepositSchedule;
        } catch { /* ignore */ }
      }

      const draft: QuoteDraft = {
        id: draftRow.id as string,
        draftNumber: (draftRow.draft_number as number) ?? 0,
        userId: draftRow.user_id as string,
        customerRequestText: (draftRow.customer_request_text as string) ?? '',
        selectedTemplateId: null,
        selectedTemplateName: null,
        lineItems,
        unresolvedItems,
        jobberRequestId: (draftRow.jobber_request_id as string) ?? null,
        jobberQuoteId: (draftRow.jobber_quote_id as string) ?? null,
        customerNote: (draftRow.customer_note as string) ?? null,
        depositSchedule,
        status: 'draft',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      try {
        const pushResult = await pushService.pushToJobber(draft);

        // Update review record
        await this.db.prepare(
          `UPDATE quote_reviews
           SET status = 'push_to_jobber', outcome = 'push_to_jobber', completed_at = ?,
               reviewer_notes = ?, updated_at = datetime('now')
           WHERE id = ?`
        ).bind(completedAt, reviewerNotes ?? null, reviewId).run();

        // Clear review_status on draft
        await this.db.prepare(
          `UPDATE quote_drafts
           SET review_status = 'none', updated_at = datetime('now')
           WHERE id = ?`
        ).bind(quoteDraftId).run();

        // Fire notification for the draft owner
        const draftOwnerId = draftRow.user_id as string;
        const draftNumber = (draftRow.draft_number as number) ?? 0;
        await this.notifyPushedToJobber(
          draftOwnerId,
          draftNumber,
          quoteDraftId,
          pushResult.jobberQuoteNumber,
        );

        return {
          status: 'push_to_jobber',
          jobberQuoteId: pushResult.jobberQuoteId,
          jobberQuoteNumber: pushResult.jobberQuoteNumber,
          jobberQuoteWebUri: pushResult.jobberQuoteWebUri,
          reviewCompletedAt: completedAt,
        };
      } catch (err) {
        throw new PlatformError({
          severity: 'error',
          component: 'ReviewService',
          operation: 'completeWithPush',
          description: err instanceof Error ? err.message : 'Jobber push failed',
          recommendedActions: ['Review the error details and try again'],
          statusCode: 422,
        });
      }
    }

    // No jobber integration — just mark the review complete
    await this.db.prepare(
      `UPDATE quote_reviews
       SET status = 'push_to_jobber', outcome = 'push_to_jobber', completed_at = ?,
           reviewer_notes = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).bind(completedAt, reviewerNotes ?? null, reviewId).run();

    await this.db.prepare(
      `UPDATE quote_drafts
       SET review_status = 'none', updated_at = datetime('now')
       WHERE id = ?`
    ).bind(quoteDraftId).run();

    // Fire notification for the draft owner
    const draftOwnerId = draftRow.user_id as string;
    const draftNumber = (draftRow.draft_number as number) ?? 0;
    await this.notifyPushedToJobber(draftOwnerId, draftNumber, quoteDraftId);

    return { status: 'push_to_jobber', reviewCompletedAt: completedAt };
  }

  /**
   * Complete review with changes requested.
   */
  private async completeWithChangesRequested(
    reviewId: string,
    quoteDraftId: string,
    reviewerNotes: string | null | undefined,
    completedAt: string,
  ): Promise<{ status: string; reviewCompletedAt: string }> {
    await this.db.prepare(
      `UPDATE quote_reviews
       SET status = 'changes_requested', outcome = 'changes_requested', completed_at = ?,
           reviewer_notes = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).bind(completedAt, reviewerNotes ?? null, reviewId).run();

    // Set draft review_status to 'changes_requested' so it can be edited
    await this.db.prepare(
      `UPDATE quote_drafts
       SET review_status = 'changes_requested', updated_at = datetime('now')
       WHERE id = ?`
    ).bind(quoteDraftId).run();

    // Fire notification for the preparer (submitted_by)
    const reviewRow = await this.db.prepare(
      `SELECT qr.submitted_by_id, qd.draft_number
       FROM quote_reviews qr
       JOIN quote_drafts qd ON qd.id = qr.quote_draft_id
       WHERE qr.id = ?`
    ).bind(reviewId).first() as { submitted_by_id: string; draft_number: number } | null;

    if (reviewRow) {
      await this.notifyChangesRequested(
        reviewRow.submitted_by_id,
        reviewRow.draft_number,
        quoteDraftId,
      );
    }

    return { status: 'changes_requested', reviewCompletedAt: completedAt };
  }

  /**
   * Push a quote to Jobber from a review context.
   */
  async pushToJobber(
    reviewId: string,
    jobberIntegration: JobberIntegration,
  ): Promise<{
    jobberQuoteId: string;
    jobberQuoteNumber: string;
    jobberQuoteWebUri: string;
  }> {
    const row = await this.db.prepare(
      'SELECT id, quote_draft_id, status FROM quote_reviews WHERE id = ?'
    ).bind(reviewId).first() as { id: string; quote_draft_id: string; status: string } | null;

    if (!row) {
      throw new PlatformError({
        severity: 'error',
        component: 'ReviewService',
        operation: 'pushToJobber',
        description: 'Review not found.',
        recommendedActions: ['Verify the review ID'],
        statusCode: 404,
      });
    }

    const result = await this.completeReview(reviewId, 'push_to_jobber', null, jobberIntegration);

    return {
      jobberQuoteId: result.jobberQuoteId!,
      jobberQuoteNumber: result.jobberQuoteNumber!,
      jobberQuoteWebUri: result.jobberQuoteWebUri!,
    };
  }

  /**
   * Compute the diff between the latest snapshot and current quote state.
   */
  async getDiff(reviewId: string): Promise<ReviewDiff | null> {
    // Get the latest snapshot for this review
    const reviewRow = await this.db.prepare(
      'SELECT quote_draft_id FROM quote_reviews WHERE id = ?'
    ).bind(reviewId).first() as { quote_draft_id: string } | null;

    if (!reviewRow) return null;

    const snapshot = await this.snapshotService.getLatestSnapshot(reviewRow.quote_draft_id);
    if (!snapshot) return null;

    const previousData = this.snapshotService.parseSnapshotData(snapshot);

    // Get current line items
    const currentItemsResult = await this.db.prepare(
      `SELECT id, product_name, description, quantity, unit_price
       FROM quote_line_items WHERE quote_draft_id = ? AND resolved = 1 ORDER BY display_order ASC`
    ).bind(reviewRow.quote_draft_id).all();

    const currentItems = (currentItemsResult.results as any[]).map((r) => ({
      id: r.id as string,
      productName: r.product_name as string,
      description: (r.description as string) ?? '',
      quantity: Number(r.quantity),
      unitPrice: Number(r.unit_price),
    }));

    // Build maps for comparison
    const previousMap = new Map(previousData.lineItems.map((li) => [li.id, li]));
    const currentMap = new Map(currentItems.map((li) => [li.id, li]));

    const modifiedItems: ReviewDiff['modifiedItems'] = [];
    const addedItems: ReviewDiff['addedItems'] = [];
    const removedItems: ReviewDiff['removedItems'] = [];

    // Check for modified and removed items
    for (const prevItem of previousData.lineItems) {
      const current = currentMap.get(prevItem.id);
      if (current) {
        // Item exists in both — check for changes
        if (
          current.quantity !== prevItem.quantity ||
          current.unitPrice !== prevItem.unitPrice ||
          current.description !== prevItem.description
        ) {
          modifiedItems.push({
            lineItemId: prevItem.id,
            productName: prevItem.productName,
            previous: {
              quantity: prevItem.quantity,
              unitPrice: prevItem.unitPrice,
              description: prevItem.description,
            },
            current: {
              quantity: current.quantity,
              unitPrice: current.unitPrice,
              description: current.description,
            },
          });
        }
      } else {
        // Item was removed
        removedItems.push({
          lineItemId: prevItem.id,
          productName: prevItem.productName,
          previousQuantity: prevItem.quantity,
          previousUnitPrice: prevItem.unitPrice,
        });
      }
    }

    // Check for added items
    for (const current of currentItems) {
      if (!previousMap.has(current.id)) {
        addedItems.push({
          lineItemId: current.id,
          productName: current.productName,
          quantity: current.quantity,
          unitPrice: current.unitPrice,
        });
      }
    }

    return {
      modifiedItems,
      addedItems,
      removedItems,
      resolvedFeedback: [],
    };
  }

  /**
   * Get pending review count for badge display.
   */
  async getPendingReviewCount(): Promise<number> {
    const row = await this.db.prepare(
      "SELECT COUNT(*) as count FROM quote_reviews WHERE status = 'pending_review'"
    ).first() as { count: number } | null;

    return row?.count ?? 0;
  }

  /**
   * Get the latest review for a quote draft.
   */
  async getLatestReview(quoteDraftId: string): Promise<QuoteReview | null> {
    const row = await this.db.prepare(
      `SELECT id, quote_draft_id, status, submitted_at, completed_at, snapshot_id,
              notes, reviewer_notes, created_at, updated_at, submitted_by_id, reviewer_id, review_cycle, outcome
       FROM quote_reviews WHERE quote_draft_id = ? ORDER BY created_at DESC LIMIT 1`
    ).bind(quoteDraftId).first() as Record<string, unknown> | null;

    if (!row) return null;

    return {
      id: row.id as string,
      quoteDraftId: row.quote_draft_id as string,
      status: row.status as QuoteReview['status'],
      submittedAt: row.submitted_at as string,
      completedAt: (row.completed_at as string) ?? null,
      snapshotId: (row.snapshot_id as string) ?? null,
      notes: (row.notes as string) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  // ── Notification helpers ──────────────────────────────────────

  /**
   * Create a notification that a quote was submitted for review.
   */
  async notifyReviewSubmitted(
    userId: string,
    draftNumber: number,
    quoteDraftId: string,
  ): Promise<void> {
    const activityLog = new ActivityLogService(this.db);
    await activityLog.log({
      userId,
      component: 'ReviewService',
      operation: 'review_submitted',
      severity: 'info',
      description: `Quote D-${String(draftNumber).padStart(3, '0')} submitted for review`,
      recommendedAction: `/quotes/drafts/${quoteDraftId}/review`,
    });
  }

  /**
   * Create a notification that changes were requested on a quote.
   */
  async notifyChangesRequested(
    userId: string,
    draftNumber: number,
    quoteDraftId: string,
    reviewerName?: string,
  ): Promise<void> {
    const activityLog = new ActivityLogService(this.db);
    await activityLog.log({
      userId,
      component: 'ReviewService',
      operation: 'changes_requested',
      severity: 'warning',
      description: reviewerName
        ? `${reviewerName} requested changes on Quote D-${String(draftNumber).padStart(3, '0')}`
        : `Changes requested on Quote D-${String(draftNumber).padStart(3, '0')}`,
      recommendedAction: `/quotes/drafts/${quoteDraftId}`,
    });
  }

  /**
   * Create a notification that a quote was pushed to Jobber.
   */
  async notifyPushedToJobber(
    userId: string,
    draftNumber: number,
    quoteDraftId: string,
    jobberQuoteNumber?: string,
    pusherName?: string,
  ): Promise<void> {
    const activityLog = new ActivityLogService(this.db);
    const quoteLabel = `D-${String(draftNumber).padStart(3, '0')}`;
    const jobberLabel = jobberQuoteNumber ? ` (J-${jobberQuoteNumber})` : '';

    await activityLog.log({
      userId,
      component: 'ReviewService',
      operation: 'pushed_to_jobber',
      severity: 'info',
      description: pusherName
        ? `${pusherName} pushed Quote ${quoteLabel} to Jobber${jobberLabel}`
        : `Quote ${quoteLabel} was pushed to Jobber${jobberLabel}`,
      recommendedAction: `/quotes/drafts/${quoteDraftId}`,
    });
  }
}