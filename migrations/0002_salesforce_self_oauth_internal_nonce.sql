CREATE TABLE IF NOT EXISTS salesforce_self_oauth_internal_nonce (
  nonce_hash TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS salesforce_self_oauth_internal_nonce_expiry_idx
  ON salesforce_self_oauth_internal_nonce(expires_at);
