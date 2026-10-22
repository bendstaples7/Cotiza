-- Per-invoice write authorization. Existing ops:read grants alone cannot authorize an expense.
CREATE TABLE IF NOT EXISTS assistant_expense_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  invoice_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  state TEXT NOT NULL,
  expense_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assistant_expense_actions_user ON assistant_expense_actions(user_id);

-- Files are stored in private R2 keys, never in the public media library.
CREATE TABLE IF NOT EXISTS assistant_receipts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  storage_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_receipts_expiry ON assistant_receipts(expires_at);

CREATE TABLE IF NOT EXISTS assistant_receipt_grants (
  token_hash TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES assistant_receipts(id),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_receipt_grants_receipt ON assistant_receipt_grants(receipt_id);
