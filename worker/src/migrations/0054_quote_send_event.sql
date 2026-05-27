-- Create QuoteSendEvent table for tracking quote send metrics (Deathclock).
-- Each row records when a quote was sent to a customer, including the elapsed
-- time from the original customer request for analytics.
--
-- IDEMPOTENCY: CREATE TABLE IF NOT EXISTS ensures this is safe to re-run.
-- Foreign keys reference quote_drafts and manual_requests.

CREATE TABLE IF NOT EXISTS quote_send_events (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id                  TEXT    NOT NULL REFERENCES quote_drafts(id),
  request_id                TEXT    NOT NULL REFERENCES manual_requests(id),
  sent_at                   TEXT    NOT NULL,  -- ISO 8601 UTC timestamp
  elapsed_seconds_from_request INTEGER NOT NULL,  -- pre-computed bigint
  send_type                 TEXT    NOT NULL CHECK (send_type IN ('first', 'resend'))
);

-- Index for querying send events by quote.
CREATE INDEX IF NOT EXISTS idx_quote_send_events_quote_id ON quote_send_events(quote_id);

-- Index for querying send events by request (for request-level metrics).
CREATE INDEX IF NOT EXISTS idx_quote_send_events_request_id ON quote_send_events(request_id);