-- One row per expense the ops assistant has tried to log, keyed by the source
-- (for example a vendor invoice number) so the same source is never logged twice.
-- status: pending (in flight), created (Jobber returned an id), unknown (Jobber did not confirm).
CREATE TABLE IF NOT EXISTS assistant_expense_writes (
  source_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  jobber_expense_id TEXT,
  title TEXT NOT NULL,
  total REAL NOT NULL,
  expense_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
