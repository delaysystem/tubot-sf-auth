import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

// F14 (+F6): migration 0011 must apply cleanly (twice: idempotent) and turn
// both the exec-users substr lookup and the per-org channel listing into
// index SEARCHes. bun:sqlite is the same engine family as D1/workerd.

const MIGRATION_URL = new URL("../migrations/0011_exec_users_prefix_org_idx.sql", import.meta.url);

const EXEC_USERS_DDL = `CREATE TABLE panel_salesforce_execution_users (
  team_id TEXT NOT NULL, org_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  integration_user_id TEXT NOT NULL, client_id TEXT, client_secret TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, org_id, channel_id, integration_user_id))`;
const CHANNELS_DDL = `CREATE TABLE panel_salesforce_channels (
  team_id TEXT NOT NULL, org_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  instance_url TEXT, client_id TEXT, client_secret TEXT,
  integration_user_id TEXT, integration_username TEXT, is_sandbox INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, org_id, channel_id))`;

// Exact query text from src/index.ts (activeChannelExecutionUsers).
const EXEC_USERS_SQL = `SELECT team_id AS teamId, org_id AS orgId, channel_id AS channelId,
  integration_user_id AS integrationUserId, is_primary AS isPrimary
  FROM panel_salesforce_execution_users WHERE substr(channel_id, 1, 15)=?
  ORDER BY isPrimary DESC, integrationUserId ASC`;
// Exact bound-org query text from src/index.ts (listConnectedOrgs).
const ORG_CHANNELS_SQL = `SELECT team_id AS teamId, org_id AS orgId,
  MIN(channel_id) AS channelId FROM panel_salesforce_channels WHERE org_id=? GROUP BY team_id, org_id`;

function plan(db: Database, sql: string, ...args: unknown[]): string {
  return (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>)
    .map((r) => r.detail).join(" | ");
}

test("F14/F6: migration 0011 applies idempotently and both queries SEARCH the new indexes", async () => {
  const db = new Database(":memory:");
  db.exec(EXEC_USERS_DDL);
  db.exec(CHANNELS_DDL);
  // Seed two orgs so the plans and row filtering are meaningful.
  const ch = db.prepare("INSERT INTO panel_salesforce_channels VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  ch.run("team-a", "00Dxx0000000001EAE", "0Mjxx0000000001AAA", null, null, null, null, null, null, 1, 1);
  ch.run("team-b", "00Dxx0000000002EAE", "0Mjxx0000000002AAA", null, null, null, null, null, null, 1, 1);
  const eu = db.prepare("INSERT INTO panel_salesforce_execution_users VALUES (?,?,?,?,?,?,?,?)");
  eu.run("team-a", "00Dxx0000000001EAE", "0Mjxx0000000001AAA", "005xx0000000001AAA", null, null, 1, 1);
  eu.run("team-b", "00Dxx0000000002EAE", "0Mjxx0000000002AAA", "005xx0000000002AAA", null, null, 1, 1);

  const before = plan(db, EXEC_USERS_SQL, "0Mjxx0000000001");
  expect(before).toContain("SCAN");

  const migration = await Bun.file(MIGRATION_URL).text();
  db.exec(migration);
  db.exec(migration); // idempotent re-apply

  const execPlan = plan(db, EXEC_USERS_SQL, "0Mjxx0000000001");
  expect(execPlan).toContain("USING INDEX panel_salesforce_execution_users_channel_prefix_idx");
  expect(execPlan).not.toContain("SCAN");
  const orgPlan = plan(db, ORG_CHANNELS_SQL, "00Dxx0000000001EAE");
  expect(orgPlan).toContain("INDEX panel_salesforce_channels_org_teams_idx");
  expect(orgPlan).not.toContain("SCAN");

  // Semantics: the pushed-down queries return exactly the bound rows.
  expect(db.query(EXEC_USERS_SQL).all("0Mjxx0000000001")).toHaveLength(1);
  expect(db.query(ORG_CHANNELS_SQL).all("00Dxx0000000001EAE")).toHaveLength(1);
});
