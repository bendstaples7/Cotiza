-- "Info needed" checklist per lead (Jobber request): what still has to come from the customer
-- before a quote can be written, and the answers the team gets back.
-- Written from the Cotiza lead page (team) and the assistant connector (Claude).
CREATE TABLE IF NOT EXISTS lead_info_items (
  id TEXT PRIMARY KEY,
  jobber_request_id TEXT NOT NULL,
  question TEXT NOT NULL,
  -- Case- and Unicode-normalized question, set by the service; backs the duplicate check.
  question_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'asked', 'answered', 'dropped')),
  answer TEXT,
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_via TEXT NOT NULL CHECK (created_via IN ('app', 'assistant')),
  created_by_user_id TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  updated_via TEXT NOT NULL CHECK (updated_via IN ('app', 'assistant'))
);
CREATE INDEX IF NOT EXISTS idx_lead_info_items_request ON lead_info_items(jobber_request_id, created_at);
-- One live copy of each question per lead; a dropped question can be asked again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_info_items_question ON lead_info_items(jobber_request_id, question_key) WHERE status <> 'dropped';
