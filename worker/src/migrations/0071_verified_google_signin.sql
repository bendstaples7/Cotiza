-- Revoke credentials minted by the previous email-only sign-in.
DELETE FROM sessions;
DELETE FROM assistant_tokens;
DELETE FROM assistant_auth_codes;
DELETE FROM assistant_oauth_tx;
CREATE TABLE google_signin_challenges (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX idx_google_signin_expiry ON google_signin_challenges(expires_at);
