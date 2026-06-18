// ---------------------------------------------------------------------------
// Review Quote Types
// ---------------------------------------------------------------------------

/** Review status enum for quote reviews */
export type ReviewStatus = 'pending_review' | 'changes_requested' | 'push_to_jobber';

/** Review outcome type - the final action taken on a review */
export type ReviewOutcome = 'push_to_jobber' | 'changes_requested';

/** Tracks each review cycle on a quote */
export interface QuoteReview {
  id: string;
  quoteDraftId: string;
  status: ReviewStatus;
  submittedAt: string;
  completedAt: string | null;
  snapshotId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Per-line-item feedback within a review cycle */
export interface ReviewLineItemFeedback {
  id: string;
  reviewId: string;
  lineItemId: string;
  fieldName: string;
  comment: string;
  createdAt: string;
}

/** Review notification operation types for the activity log system */
export type ReviewNotificationOperation =
  | 'review_submitted'
  | 'changes_requested'
  | 'pushed_to_jobber';

/** A snapshot of quote data at review submission time for diff computation */
export interface ReviewSnapshot {
  id: string;
  quoteDraftId: string;
  reviewId: string;
  snapshotData: string; // JSON string
  createdAt: string;
}