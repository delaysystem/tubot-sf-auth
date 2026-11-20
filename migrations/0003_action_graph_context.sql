CREATE TABLE IF NOT EXISTS action_graph_context (
  team_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  action_route TEXT NOT NULL,
  graph_name TEXT NOT NULL,
  root_schema_json TEXT NOT NULL,
  owned_model_name TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, org_id, channel_id, action_route)
);
