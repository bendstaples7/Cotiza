-- One row per vendor invoice the ops assistant tried to log as a Jobber expense (log_expense).
-- source_key is the caller's stable reference (e.g. "20four7VA invoice #5511-R-0026"); the primary key
-- makes a second call for the same invoice return duplicate / unresolved instead of creating again.
-- status: pending (claim held), created (jobber_expense_id set), unknown (uncertain reply; never retried).
CREATE TABLE IF NOT EXISTS assistant_expense_writes (
  source_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  jobber_expense_id TEXT,
  title TEXT NOT NULL,
  total REAL NOT NULL,
  expense_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
