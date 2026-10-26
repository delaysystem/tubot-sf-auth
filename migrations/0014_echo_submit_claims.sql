-- Submit idempotency claims for broker.echo(): one row per deterministic
-- requestKey (digest of route + conversation + message). The 25s proxy inline
-- race orphan + alarm redelivery invoke echo() twice for slow turns; the
-- claim makes the second invocation return the first invocation's Salesforce
-- requestId instead of POSTing a duplicate notification.
CREATE TABLE IF NOT EXISTS echo_submit_claims (
  request_key TEXT PRIMARY KEY,
  claimant TEXT NOT NULL,
  request_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_echo_submit_claims_updated ON echo_submit_claims(updated_at);
