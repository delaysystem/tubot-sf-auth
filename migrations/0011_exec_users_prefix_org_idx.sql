-- F14: activeChannelExecutionUsers substr SCAN (src/index.ts):
--   WHERE substr(channel_id, 1, 15)=?
-- channel_id is the 3rd column of the PRIMARY KEY
-- (team_id, org_id, channel_id, integration_user_id), so the substr predicate
-- cannot seek and every call scans the whole table (+ TEMP B-TREE for the
-- ORDER BY). This expression index mirrors the proven 0010 pattern for
-- panel_salesforce_channels and turns the lookup into a SEARCH. Query text is
-- unchanged, so resolution semantics are identical for every input.
-- NOTE: panel_salesforce_execution_users is owned by tubot-new-panel migration
-- 0001 on the shared agent-dashboard-db; this index-only migration touches no
-- rows (same deploy-order caveat as 0010: the panel table must exist first,
-- which holds on staging/prod).
CREATE INDEX IF NOT EXISTS panel_salesforce_execution_users_channel_prefix_idx
  ON panel_salesforce_execution_users(substr(channel_id, 1, 15));

-- F6: listConnectedOrgs per-org pushdown (src/index.ts):
--   SELECT team_id, org_id, MIN(channel_id) ... WHERE org_id=? GROUP BY team_id, org_id
-- The channels PRIMARY KEY leads with team_id, so a bare org_id predicate
-- cannot use it; this covering index gives a SEARCH on org_id with rows
-- pre-ordered for the GROUP BY (no TEMP B-TREE) and covers all three
-- selected columns. Index-only, touches no rows.
CREATE INDEX IF NOT EXISTS panel_salesforce_channels_org_teams_idx
  ON panel_salesforce_channels(org_id, team_id, channel_id);
