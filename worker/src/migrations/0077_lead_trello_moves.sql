-- Trello cards Cotiza moved when a lead was closed, so reopening the lead can move each card back
-- to the list it came from. restored_at is set once a card has been moved back.
CREATE TABLE IF NOT EXISTS lead_trello_moves (
  jobber_request_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  card_url TEXT NOT NULL,
  card_name TEXT NOT NULL,
  from_list_id TEXT NOT NULL,
  to_list_id TEXT NOT NULL,
  moved_at TEXT NOT NULL,
  restored_at TEXT,
  PRIMARY KEY (jobber_request_id, card_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_trello_moves_active ON lead_trello_moves(jobber_request_id, restored_at);
