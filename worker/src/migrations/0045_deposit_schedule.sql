-- Add deposit_schedule column to quote_drafts
-- SQLite ALTER TABLE ADD COLUMN with DEFAULT NULL is non-destructive:
-- existing rows get NULL without a table rewrite.
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE quote_drafts ADD COLUMN deposit_schedule TEXT DEFAULT NULL;
