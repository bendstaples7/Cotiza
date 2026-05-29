-- Add backfilled_at column to manual_requests for deathclock backfill tracking.
-- This marks when an existing pre-deathclock request was backfilled
-- with deathclock metrics (T1.12).
--
-- IDEMPOTENCY: columns may already exist; deploy will apply manually if needed.
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed.
ALTER TABLE manual_requests ADD COLUMN backfilled_at TEXT DEFAULT NULL;

-- Add metric_status column to quote_drafts for deathclock backfill tracking.
-- Values:
--   'no_data'   — quote was sent before deathclock feature existed; time-to-send
--                 cannot be accurately computed.
--   'backfilled' — metric was successfully backfilled from existing data.
--   NULL (default) — normal operation (post-deathclock).
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed.
ALTER TABLE quote_drafts ADD COLUMN metric_status TEXT DEFAULT NULL
  CHECK (metric_status IS NULL OR metric_status IN ('no_data', 'backfilled'));