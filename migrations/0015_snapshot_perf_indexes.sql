-- Composite indexes for org-wide snapshot discovery and team/org/agent latest lookup.
CREATE INDEX IF NOT EXISTS sf_agent_snapshot_org_status_team_idx
  ON sf_agent_snapshot_job(org_id, status, team_id);

CREATE INDEX IF NOT EXISTS sf_agent_snapshot_team_org_agent_idx
  ON sf_agent_snapshot_job(team_id, org_id, agent_name, status, created_at DESC);
