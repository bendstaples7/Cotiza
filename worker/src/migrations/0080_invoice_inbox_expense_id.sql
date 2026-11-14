-- Jobber expense id for a logged/skipped invoice row (card fae9e3e9 slice 3).
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE invoice_inbox_items ADD COLUMN jobber_expense_id TEXT;
