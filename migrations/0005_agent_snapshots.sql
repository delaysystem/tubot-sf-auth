CREATE TABLE IF NOT EXISTS sf_agent_snapshot_job (
  id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('retrieving','complete','incomplete','failed')),
  state_json TEXT NOT NULL,
  manifest_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(team_id,org_id,channel_id,id)
);
CREATE INDEX IF NOT EXISTS sf_agent_snapshot_latest ON sf_agent_snapshot_job(team_id,org_id,channel_id,agent_name,status,created_at DESC);
CREATE TABLE IF NOT EXISTS sf_agent_snapshot_file (
  team_id TEXT NOT NULL, org_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  job_id TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL,
  PRIMARY KEY(team_id,org_id,channel_id,job_id,path),
  FOREIGN KEY(team_id,org_id,channel_id,job_id) REFERENCES sf_agent_snapshot_job(team_id,org_id,channel_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sf_agent_snapshot_chunk (
  team_id TEXT NOT NULL, org_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  job_id TEXT NOT NULL, path TEXT NOT NULL, chunk_index INTEGER NOT NULL, content BLOB NOT NULL,
  PRIMARY KEY(team_id,org_id,channel_id,job_id,path,chunk_index),
  FOREIGN KEY(team_id,org_id,channel_id,job_id,path) REFERENCES sf_agent_snapshot_file(team_id,org_id,channel_id,job_id,path) ON DELETE CASCADE
);
