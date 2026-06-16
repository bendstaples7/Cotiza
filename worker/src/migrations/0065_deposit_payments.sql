-- Migration: 0065_deposit_payments.sql
-- Creates the deposit payments tracking system so deposit milestones
-- become actual payment records (not just text in a client message).
--
-- When a quote with a deposit schedule is finalized, deposit_payment rows
-- are created — one per milestone — each with a calculated dollar amount
-- and a pending/paid/cancelled status so deposits can actually be tracked
-- end-to-end.

CREATE TABLE IF NOT EXISTS deposit_payments (
  id TEXT PRIMARY KEY,
  quote_draft_id TEXT NOT NULL REFERENCES quote_drafts(id),
  milestone_index INTEGER NOT NULL,
  percentage INTEGER NOT NULL CHECK(percentage > 0 AND percentage <= 100),
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'cancelled')),
  paid_at TEXT,
  payment_method TEXT,
  paid_amount_cents INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deposit_payments_draft_id ON deposit_payments(quote_draft_id);
CREATE INDEX IF NOT EXISTS idx_deposit_payments_status ON deposit_payments(status);

-- Add deposit tracking metadata to quote_drafts
ALTER TABLE quote_drafts ADD COLUMN deposit_total_cents INTEGER;
ALTER TABLE quote_drafts ADD COLUMN deposit_paid_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quote_drafts ADD COLUMN deposit_status TEXT DEFAULT 'not_applicable' CHECK(deposit_status IN ('not_applicable', 'pending', 'partial', 'paid', 'cancelled'));
