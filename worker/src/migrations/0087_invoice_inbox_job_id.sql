-- The matched Jobber job id (card f9e131f8 T4).
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE invoice_inbox_items ADD COLUMN jobber_job_id TEXT;
