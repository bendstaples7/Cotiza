CREATE TABLE IF NOT EXISTS quantity_history (
  id TEXT PRIMARY KEY,
  product_name TEXT NOT NULL,
  quantity REAL NOT NULL CHECK(quantity > 0),
  source_quote_id TEXT NOT NULL,
  source_quote_number TEXT,
  context_text TEXT,
  extracted_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_name, source_quote_id)
);

CREATE INDEX IF NOT EXISTS idx_quantity_history_product_name
  ON quantity_history(product_name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_quantity_history_source_quote
  ON quantity_history(source_quote_id);
