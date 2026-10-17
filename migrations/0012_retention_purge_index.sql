-- F15: retention purge SEEK for terminal snapshot jobs (src/retention.ts):
--   WHERE status IN ('complete','incomplete','failed') AND updated_at < ?
-- The latest-job index (0005) leads with team/org/channel/agent and cannot
-- serve this cross-tenant predicate; without this index the daily purge
-- COUNT + batched deletes would SCAN the whole jobs table every run.
-- Index-only, touches no rows. (The sf_user_data_cache_v2 expires_at index
-- lives in ensureTable in src/cache-helper.ts instead: that table is
-- inline-owned by design (U-C1), and a migration cannot index a table that a
-- fresh DB has not created yet.)
CREATE INDEX IF NOT EXISTS sf_agent_snapshot_job_retention_idx
  ON sf_agent_snapshot_job(status, updated_at);
