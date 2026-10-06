CREATE TABLE IF NOT EXISTS salesforce_self_oauth_pending (
  state_hash TEXT PRIMARY KEY NOT NULL,
  team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  instance_url TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  return_url TEXT NOT NULL,
  salesforce_user_id TEXT NOT NULL,
  oauth_token_id TEXT NOT NULL REFERENCES oauth_token(id) ON DELETE CASCADE,
  code_verifier_cipher TEXT NOT NULL,
  code_verifier_iv TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS salesforce_self_oauth_pending_expiry_idx
  ON salesforce_self_oauth_pending(expires_at);

CREATE TABLE IF NOT EXISTS salesforce_self_oauth_credential (
  team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  instance_url TEXT NOT NULL,
  client_id TEXT NOT NULL,
  salesforce_user_id TEXT NOT NULL,
  refresh_token_cipher TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, org_id)
);
