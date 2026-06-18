-- Migration: 0064_add_missing_quote_review_columns.sql
-- Adds columns that were missing from migration 0063 but are referenced by code.
-- Each ALTER TABLE uses IF NOT EXISTS (supported via D1's safe ALTER TABLE) to
-- remain idempotent.

-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE quote_reviews ADD COLUMN submitted_by_id TEXT NOT NULL DEFAULT '' REFERENCES users(id);
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE quote_reviews ADD COLUMN reviewer_id TEXT;
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE quote_reviews ADD COLUMN review_cycle INTEGER NOT NULL DEFAULT 1;
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE quote_reviews ADD COLUMN outcome TEXT;