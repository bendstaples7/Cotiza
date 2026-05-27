-- Add database indexes for Deathclock query performance.
--
-- These indexes optimize the common query patterns used by the Deathclock
-- feature: finding active (unsent) drafts, sorting requests by age, and
-- fetching active requests ordered by creation time.
--
-- IDEMPOTENCY: CREATE INDEX IF NOT EXISTS ensures these are safe to re-run.

-- Partial index: only rows where quote_sent_at IS NULL (active clocks).
-- Speeds up "which drafts are still pending send?" queries.
CREATE INDEX IF NOT EXISTS idx_quote_sent_at
  ON quote_drafts(quote_sent_at)
  WHERE quote_sent_at IS NULL;

-- Index on manual_requests.created_at for sort-by-age queries (oldest first).
CREATE INDEX IF NOT EXISTS idx_request_created_at
  ON manual_requests(created_at);

-- Composite index on (status, created_at) for fetching active requests
-- sorted by age. This covers the common Deathclock query pattern:
--   SELECT * FROM manual_requests WHERE status = ? ORDER BY created_at ASC
CREATE INDEX IF NOT EXISTS idx_request_status_created
  ON manual_requests(status, created_at);