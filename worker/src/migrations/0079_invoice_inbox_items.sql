-- One row per invoice email the scheduled Gmail poller found (card fae9e3e9).
-- status: would_log (all fields read), uncertain (something missing, review list),
-- skipped (a later email with the same dedupe_key), logged (slice 3 only).
CREATE TABLE IF NOT EXISTS invoice_inbox_items (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT,
  vendor TEXT,
  invoice_number TEXT,
  amount REAL,
  expense_date TEXT,
  attachment_name TEXT,
  dedupe_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('would_log', 'uncertain', 'skipped', 'logged')),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoice_inbox_dedupe ON invoice_inbox_items(dedupe_key);
