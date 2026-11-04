-- When the team sent a lead's draft quote to Ben for review from Cotiza (one row per Jobber quote;
-- sending it again after edits moves requested_at on). Ben's decision itself lives in the review
-- ledger (quote_review_records); together they say whose move it is on the quote.
CREATE TABLE IF NOT EXISTS lead_quote_reviews (
  jobber_quote_id TEXT PRIMARY KEY,
  jobber_request_id TEXT NOT NULL,
  quote_number TEXT,
  requested_at TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_quote_reviews_request ON lead_quote_reviews(jobber_request_id);
