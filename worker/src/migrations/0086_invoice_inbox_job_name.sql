-- The PO/job name read from a Home Depot receipt email (card f9e131f8 T2).
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE invoice_inbox_items ADD COLUMN job_name TEXT;
