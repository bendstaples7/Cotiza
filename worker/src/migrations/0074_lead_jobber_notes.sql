-- One row per Cotiza action that is also written to Jobber as a note on the request (a logged
-- contact, a text sent via Quo, a not-a-lead mark). The row is claimed before the write so a retry
-- or a double click never posts the same note twice.
CREATE TABLE IF NOT EXISTS lead_jobber_notes (
  id TEXT PRIMARY KEY,
  jobber_request_id TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'posting', 'posted', 'failed')),
  jobber_note_id TEXT,
  error TEXT,
  -- 1 when the last attempt may have reached Jobber; the next attempt checks the request's notes first.
  uncertain INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- Set by the attempt that holds the claim; only that attempt may record the outcome.
  claim_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_jobber_notes_request ON lead_jobber_notes(jobber_request_id, status);
