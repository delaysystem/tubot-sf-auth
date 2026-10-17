-- Fix resolve-channel full-table SCAN (resolveCredentialForChannel in src/index.ts):
--   WHERE channel_id = ? OR substr(channel_id, 1, 15) = ?
-- channel_id is the 3rd column of the PRIMARY KEY (team_id, org_id, channel_id),
-- so neither OR branch can seek and every resolve scans the whole table.
-- These two indexes let SQLite answer both branches via MULTI-INDEX OR
-- (SEARCH on each branch). Query text is unchanged, so resolution semantics
-- are identical for every input.
-- NOTE: panel_salesforce_channels is owned by tubot-new-panel migration 0001
-- on the shared agent-dashboard-db; this index-only migration touches no rows.
CREATE INDEX IF NOT EXISTS panel_salesforce_channels_channel_id_idx
  ON panel_salesforce_channels(channel_id);
CREATE INDEX IF NOT EXISTS panel_salesforce_channels_channel_prefix_idx
  ON panel_salesforce_channels(substr(channel_id, 1, 15));
