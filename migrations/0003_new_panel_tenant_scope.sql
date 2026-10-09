-- Tenant scope is verified by the authenticated New Panel service.
-- Kinde tenant IDs are independent of the retired Panel team and token tables.
CREATE TABLE salesforce_self_oauth_pending_next (
  state_hash TEXT PRIMARY KEY NOT NULL,
  team_id TEXT NOT NULL ,
  org_id TEXT NOT NULL,
  instance_url TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  return_url TEXT NOT NULL,
  salesforce_user_id TEXT NOT NULL,
  oauth_token_id TEXT ,
  code_verifier_cipher TEXT NOT NULL,
  code_verifier_iv TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

INSERT INTO salesforce_self_oauth_pending_next (
  state_hash, team_id, org_id, instance_url, client_id, redirect_uri, return_url,
  salesforce_user_id, oauth_token_id, code_verifier_cipher, code_verifier_iv,
  created_at, expires_at, consumed_at
)
SELECT state_hash, team_id, org_id, instance_url, client_id, redirect_uri, return_url,
  salesforce_user_id, oauth_token_id, code_verifier_cipher, code_verifier_iv,
  created_at, expires_at, consumed_at
FROM salesforce_self_oauth_pending;

DROP TABLE salesforce_self_oauth_pending;
ALTER TABLE salesforce_self_oauth_pending_next RENAME TO salesforce_self_oauth_pending;

CREATE INDEX salesforce_self_oauth_pending_expiry_idx
  ON salesforce_self_oauth_pending(expires_at);

CREATE TABLE salesforce_self_oauth_credential_next (
  team_id TEXT NOT NULL, org_id TEXT NOT NULL, instance_url TEXT NOT NULL,
  client_id TEXT NOT NULL, salesforce_user_id TEXT NOT NULL,
  refresh_token_cipher TEXT NOT NULL, refresh_token_iv TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, org_id)
);
INSERT INTO salesforce_self_oauth_credential_next SELECT * FROM salesforce_self_oauth_credential;
DROP TABLE salesforce_self_oauth_credential;
ALTER TABLE salesforce_self_oauth_credential_next RENAME TO salesforce_self_oauth_credential;
