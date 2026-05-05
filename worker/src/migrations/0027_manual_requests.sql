CREATE TABLE IF NOT EXISTS manual_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    customer_name TEXT NOT NULL,
    customer_phone TEXT,
    customer_email TEXT,
    customer_address TEXT,
    service_description TEXT NOT NULL,
    media_item_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_manual_requests_user_id ON manual_requests(user_id);

-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE quote_drafts ADD COLUMN manual_request_id TEXT REFERENCES manual_requests(id);
CREATE INDEX IF NOT EXISTS idx_quote_drafts_manual_request_id ON quote_drafts(manual_request_id);
