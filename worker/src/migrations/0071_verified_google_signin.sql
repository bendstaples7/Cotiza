-- Revoke credentials minted by the previous email-only sign-in.
DELETE FROM sessions;
DELETE FROM assistant_tokens;
DELETE FROM assistant_auth_codes;
DELETE FROM assistant_oauth_tx;
CREATE TABLE IF NOT EXISTS google_signin_challenges (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, source_hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_google_signin_expiry ON google_signin_challenges(expires_at);

-- Legacy worker instances during rollout cannot mint credentials accepted by the new worker.
-- IDEMPOTENCY: D1 applies this numbered migration once; SQLite has no ADD COLUMN IF NOT EXISTS.
ALTER TABLE sessions ADD COLUMN identity_verified INTEGER NOT NULL DEFAULT 0;
-- IDEMPOTENCY: D1 applies this numbered migration once; SQLite has no ADD COLUMN IF NOT EXISTS.
ALTER TABLE assistant_tokens ADD COLUMN identity_verified INTEGER NOT NULL DEFAULT 0;
-- IDEMPOTENCY: D1 applies this numbered migration once; SQLite has no ADD COLUMN IF NOT EXISTS.
ALTER TABLE assistant_auth_codes ADD COLUMN identity_verified INTEGER NOT NULL DEFAULT 0;
-- IDEMPOTENCY: D1 applies this numbered migration once; SQLite has no ADD COLUMN IF NOT EXISTS.
ALTER TABLE assistant_oauth_tx ADD COLUMN identity_verified INTEGER NOT NULL DEFAULT 0;

-- Isolate verified transaction payloads from legacy workers which can update the old table.
CREATE TABLE IF NOT EXISTS verified_assistant_oauth_tx (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at TEXT NOT NULL,
  identity_verified INTEGER NOT NULL DEFAULT 1
);
