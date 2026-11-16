CREATE TABLE IF NOT EXISTS email_asks (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT,
  from_address TEXT,
  from_name TEXT,
  subject TEXT,
  received_at TEXT,
  ask_summary TEXT,
  requested_document TEXT,
  confidence REAL,
  draft_id TEXT,
  draft_url TEXT,
  attachment_name TEXT,
  attachment_source TEXT,
  attachment_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('needs_you', 'drafted', 'done', 'dismissed')),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_asks_open ON email_asks(status, created_at);
