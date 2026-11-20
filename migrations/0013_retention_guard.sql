-- F15: daily-run guard for the retention piggyback (src/retention.ts
-- maybeRunRetention). One row per worker key ('sf_auth_daily_v1' here;
-- data360 claims its own key in the same table — both workers share this DB).
-- The claim is a single atomic UPSERT; losers see changes=0 and skip.
-- Data-less DDL, touches no existing rows.
CREATE TABLE IF NOT EXISTS f15_retention_guard (
  key TEXT PRIMARY KEY,
  last_run_at INTEGER NOT NULL
);
