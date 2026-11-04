-- Closing a lead with a reason, on the same per-lead row as the not-a-lead mark (lead_marks), so
-- one table holds a lead's lifecycle marks. A row may now carry a closure without the not-a-lead
-- mark (not_a_lead = 0). Postponed leads come back on check_back_on.
-- IDEMPOTENCY: columns may already exist; deploy will apply manually if needed.
ALTER TABLE lead_marks ADD COLUMN closed_reason TEXT CHECK (closed_reason IN ('went_elsewhere', 'too_small', 'no_response', 'postponed', 'other'));
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed.
ALTER TABLE lead_marks ADD COLUMN closed_note TEXT;
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed.
ALTER TABLE lead_marks ADD COLUMN check_back_on TEXT;
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed.
ALTER TABLE lead_marks ADD COLUMN closed_at TEXT;
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed.
ALTER TABLE lead_marks ADD COLUMN closed_by_user_id TEXT;
-- 1 when Cotiza archived the Jobber request on close, so reopening can unarchive it.
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed.
ALTER TABLE lead_marks ADD COLUMN jobber_archived INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_lead_marks_closed ON lead_marks(closed_reason, check_back_on);
