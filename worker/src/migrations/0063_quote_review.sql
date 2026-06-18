-- Migration: 0063_quote_review.sql
-- Phase 1: Data Model for the Review Quote & Push to Jobber feature
--
-- Adds review_status column to quote_drafts and creates three new tables:
--   quote_reviews           - Tracks each review cycle on a quote
--   review_line_item_feedback - Per-line-item feedback within a review cycle
--   quote_review_snapshots   - Lightweight snapshot at each review submission point
--
-- All operations are idempotent (CREATE TABLE IF NOT EXISTS, ALTER TABLE ... IF NOT EXISTS).

-- T-1.2: Add review_status column to quote_drafts
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE quote_drafts ADD COLUMN review_status TEXT NOT NULL DEFAULT 'none';
-- Values:
--   'none'              = not submitted for review (default for existing rows)
--   'pending_review'    = submitted, awaiting reviewer action
--   'changes_requested' = reviewer requested changes, quote is editable again
--   'push_to_jobber'    = review completed, quote was pushed to Jobber
CREATE INDEX IF NOT EXISTS idx_quote_drafts_review_status ON quote_drafts(review_status)
    WHERE review_status != 'none';

-- T-1.3: Create quote_reviews table
CREATE TABLE IF NOT EXISTS quote_reviews (
    id TEXT PRIMARY KEY,
    quote_draft_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_review',  -- pending_review | changes_requested | push_to_jobber
    submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    snapshot_id TEXT,
    notes TEXT,
    reviewer_notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (quote_draft_id) REFERENCES quote_drafts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quote_reviews_quote_id ON quote_reviews(quote_draft_id);
CREATE INDEX IF NOT EXISTS idx_quote_reviews_status ON quote_reviews(status);

-- T-1.4: Create review_line_item_feedback table
CREATE TABLE IF NOT EXISTS review_line_item_feedback (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL,
    line_item_id TEXT NOT NULL,
    field_name TEXT NOT NULL,                       -- The field being commented on (e.g., 'quantity', 'unit_price')
    comment TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (review_id) REFERENCES quote_reviews(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_review_feedback_review ON review_line_item_feedback(review_id);
CREATE INDEX IF NOT EXISTS idx_review_feedback_line_item ON review_line_item_feedback(line_item_id);

-- T-1.5: Create quote_review_snapshots table
CREATE TABLE IF NOT EXISTS quote_review_snapshots (
    id TEXT PRIMARY KEY,
    quote_draft_id TEXT NOT NULL,
    review_id TEXT NOT NULL,
    snapshot_data TEXT NOT NULL,                    -- JSON string of quote state at submission time
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (quote_draft_id) REFERENCES quote_drafts(id) ON DELETE CASCADE,
    FOREIGN KEY (review_id) REFERENCES quote_reviews(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quote_snapshots_review ON quote_review_snapshots(review_id);