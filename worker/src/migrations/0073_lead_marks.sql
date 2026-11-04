-- A lead the team marked as not a real lead (spam, wrong number, no project). It moves to the
-- request queue's Review section until the team archives it in Jobber or clears the mark.
CREATE TABLE IF NOT EXISTS lead_marks (
  jobber_request_id TEXT PRIMARY KEY,
  not_a_lead INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL
);
