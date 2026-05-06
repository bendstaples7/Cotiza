-- Add rationale_json column to quote_line_items.
-- Stores a JSON blob explaining why the line item was added and why the
-- quantity is what it is, derived from the rules engine audit trail at
-- quote generation time.
ALTER TABLE quote_line_items ADD COLUMN rationale_json TEXT;
