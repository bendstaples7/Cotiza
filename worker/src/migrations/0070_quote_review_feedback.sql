-- Chicago Reno quote-review ledger (moved from the review skill's feedback.json).
-- Append-only: a change is a new row whose `supersedes` names the old id.
-- Rows carry who wrote them: the assistant token, its OAuth client and the Cotiza user,
-- or written_via = 'import' for the one-time load from feedback.json.
CREATE TABLE IF NOT EXISTS quote_review_feedback (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  author TEXT NOT NULL,
  source TEXT NOT NULL,
  quote_number TEXT,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'conditional', 'accepted/closed', 'superseded', 'proposed')),
  status_detail TEXT,
  scope TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL,
  rule TEXT NOT NULL,
  supersedes TEXT REFERENCES quote_review_feedback(id),
  written_via TEXT NOT NULL CHECK (written_via IN ('assistant', 'import')),
  written_by_user_id TEXT,
  written_by_token_id TEXT,
  written_by_client_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_quote_review_feedback_quote ON quote_review_feedback(quote_number, seq);
CREATE INDEX IF NOT EXISTS idx_quote_review_feedback_supersedes ON quote_review_feedback(supersedes);

-- Per-quote review record: edit register, closed findings, verification notes (JSON).
-- Each write is a new version; the newest row for a quote is current.
CREATE TABLE IF NOT EXISTS quote_review_records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  author TEXT NOT NULL,
  source TEXT NOT NULL,
  quote_number TEXT NOT NULL,
  record TEXT NOT NULL CHECK (json_valid(record)),
  supersedes TEXT REFERENCES quote_review_records(id),
  written_via TEXT NOT NULL CHECK (written_via IN ('assistant', 'import')),
  written_by_user_id TEXT,
  written_by_token_id TEXT,
  written_by_client_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_quote_review_records_quote ON quote_review_records(quote_number, seq);

CREATE TRIGGER IF NOT EXISTS quote_review_feedback_no_update
BEFORE UPDATE ON quote_review_feedback
BEGIN
  SELECT RAISE(ABORT, 'quote_review_feedback is append-only');
END;

CREATE TRIGGER IF NOT EXISTS quote_review_feedback_no_delete
BEFORE DELETE ON quote_review_feedback
BEGIN
  SELECT RAISE(ABORT, 'quote_review_feedback is append-only');
END;

CREATE TRIGGER IF NOT EXISTS quote_review_records_no_update
BEFORE UPDATE ON quote_review_records
BEGIN
  SELECT RAISE(ABORT, 'quote_review_records is append-only');
END;

CREATE TRIGGER IF NOT EXISTS quote_review_records_no_delete
BEFORE DELETE ON quote_review_records
BEGIN
  SELECT RAISE(ABORT, 'quote_review_records is append-only');
END;
