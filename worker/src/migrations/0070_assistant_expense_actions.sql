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
