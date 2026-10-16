CREATE TABLE IF NOT EXISTS sf_agent_blob_index (
  team_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  b2_snapshot_id TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(team_id,org_id,agent_name)
);
CREATE INDEX IF NOT EXISTS sf_agent_blob_index_org ON sf_agent_blob_index(team_id,org_id,updated_at DESC);
