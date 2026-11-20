-- The Salesforce channel broker now reads tenant-scoped channel identities
-- from New Panel. Remove the retired per-channel secret tables and the token
-- table reference from pending Salesforce OAuth requests.
CREATE TABLE salesforce_self_oauth_pending_next (
  state_hash TEXT PRIMARY KEY NOT NULL,
  team_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  instance_url TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  return_url TEXT NOT NULL,
  salesforce_user_id TEXT NOT NULL,
  code_verifier_cipher TEXT NOT NULL,
  code_verifier_iv TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

INSERT INTO salesforce_self_oauth_pending_next (
  state_hash, team_id, org_id, instance_url, client_id, redirect_uri, return_url,
  salesforce_user_id, code_verifier_cipher, code_verifier_iv,
  created_at, expires_at, consumed_at
)
SELECT state_hash, team_id, org_id, instance_url, client_id, redirect_uri, return_url,
  salesforce_user_id, code_verifier_cipher, code_verifier_iv,
  created_at, expires_at, consumed_at
FROM salesforce_self_oauth_pending;

DROP TABLE salesforce_self_oauth_pending;
ALTER TABLE salesforce_self_oauth_pending_next RENAME TO salesforce_self_oauth_pending;
CREATE INDEX salesforce_self_oauth_pending_expiry_idx
  ON salesforce_self_oauth_pending(expires_at);

DROP TABLE IF EXISTS salesforce_channel_connection;
DROP TABLE IF EXISTS salesforce_auth_execution_user;
DROP TABLE IF EXISTS salesforce_auth_credential;
DROP TABLE IF EXISTS team_salesforce_deployment;
