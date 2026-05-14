-- Add generation_trace_json column to quote_drafts for pipeline debugging and triage.
-- Stores a GenerationTrace JSON blob capturing scope detection, catalog filtering,
-- space contexts, rules fired, and enrichment results for each generated quote.

-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE quote_drafts ADD COLUMN generation_trace_json TEXT DEFAULT NULL;
