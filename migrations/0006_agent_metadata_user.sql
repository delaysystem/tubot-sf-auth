CREATE TABLE IF NOT EXISTS sf_agent_metadata_user (
  team_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  integration_user_id TEXT NOT NULL,
  integration_username TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY(team_id,org_id,channel_id)
);
