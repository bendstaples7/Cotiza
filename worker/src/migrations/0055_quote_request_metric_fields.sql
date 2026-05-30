-- Add metric tracking columns to quote_drafts for Deathclock timing analytics.
-- These columns capture key lifecycle timestamps and pre-computed durations
-- used to surface cycle-time metrics (time from request → first draft → send).
--
-- IDEMPOTENCY: columns may already exist; deploy will apply manually if needed
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed.
ALTER TABLE quote_drafts ADD COLUMN quote_sent_at            TEXT    DEFAULT NULL;
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed.
ALTER TABLE quote_drafts ADD COLUMN first_draft_created_at   TEXT    DEFAULT NULL;
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed.
ALTER TABLE quote_drafts ADD COLUMN request_to_quote_seconds INTEGER DEFAULT NULL;
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed.
ALTER TABLE quote_drafts ADD COLUMN last_quote_sent_at       TEXT    DEFAULT NULL;