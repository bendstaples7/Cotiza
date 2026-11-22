-- Lead name and total for Ben's Jobber review queue, captured when the team sends a draft.
-- The queue reads them from this table, so it makes no Jobber call per row.
-- IDEMPOTENCY: column may already exist
ALTER TABLE lead_quote_reviews ADD COLUMN lead_name TEXT;
-- IDEMPOTENCY: column may already exist
ALTER TABLE lead_quote_reviews ADD COLUMN total_value REAL;
-- IDEMPOTENCY: column may already exist
ALTER TABLE lead_quote_reviews ADD COLUMN jobber_web_uri TEXT;
