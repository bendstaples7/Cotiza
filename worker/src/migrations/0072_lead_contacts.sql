-- Outreach on a lead (one Jobber request), as the team logs it in Cotiza: calls, texts, emails and
-- visits that happened outside Quo/Gmail or that the team wants on record. Quo, Gmail and Jobber
-- notes are read live and not copied here.
CREATE TABLE IF NOT EXISTS lead_contacts (
  id TEXT PRIMARY KEY,
  jobber_request_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('call', 'text', 'email', 'in_person', 'other')),
  direction TEXT NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
  note TEXT,
  -- Outreach checklist step this contact completed, if any (e.g. 'intro_text').
  step TEXT,
  contacted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_contacts_request ON lead_contacts(jobber_request_id, contacted_at);

-- The date the team plans to contact the lead next. No row means "use the suggested date".
CREATE TABLE IF NOT EXISTS lead_followups (
  jobber_request_id TEXT PRIMARY KEY,
  next_contact_on TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL
);
