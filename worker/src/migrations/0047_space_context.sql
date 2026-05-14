-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE quote_drafts ADD COLUMN space_context_json TEXT DEFAULT NULL;
