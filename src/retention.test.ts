import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  __resetRetentionGuardForTests,
  dryRunRetention,
  maybeRunRetention,
  purgeRetention,
  retentionCutoffs,
  DRY_RUN_JOBS_SQL,
  PURGE_JOBS_SQL,
  PURGE_USER_CACHE_SQL,
  type RetentionDb,
} from "./retention";
import { UserDataCacheStore } from "./cache-helper";

// F15: retention purges for snapshot job/file/chunk + sf_user_data_cache_v2.
// bun:sqlite is the same engine family as D1/workerd (see
// migration-0011.test.ts); schema comes from the REAL migration files.

const MIGRATION_0005_URL = new URL("../migrations/0005_agent_snapshots.sql", import.meta.url);
const MIGRATION_0012_URL = new URL("../migrations/0012_retention_purge_index.sql", import.meta.url);
const MIGRATION_0013_URL = new URL("../migrations/0013_retention_guard.sql", import.meta.url);

const NOW = Date.now();
const DAY_MS = 24 * 3600 * 1000;
const { jobCutoffMs, cacheCutoffSec } = retentionCutoffs(NOW);

function shim(sqlite: Database): RetentionDb {
  const wrap = (sql: string, args: unknown[]) => {
    const exec = () => {
      const res = sqlite.query(sql).run(...(args as any[]));
      return { meta: { changes: Number((res as any).changes ?? 0) } };
    };
    return {
      async first<T>() {
        return (sqlite.query(sql).get(...(args as any[])) as T | null) ?? null;
      },
      async all<T>() {
        return { results: sqlite.query(sql).all(...(args as any[])) as T[] };
      },
      run: async () => exec(),
      __exec: exec,
    };
  };
  return {
    prepare(sql: string) {
      return { bind: (...args: unknown[]) => wrap(sql, args), run: () => wrap(sql, []).run() };
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      const runAll = sqlite.transaction((stmts: Array<{ __exec(): { meta: { changes: number } } }>) =>
        stmts.map((s) => s.__exec()),
      );
      return runAll(statements as any);
    },
  } as unknown as RetentionDb;
}

async function seedDb(): Promise<{ sqlite: Database; db: RetentionDb }> {
  const sqlite = new Database(":memory:");
  sqlite.exec(await Bun.file(MIGRATION_0005_URL).text());
  sqlite.exec(await Bun.file(MIGRATION_0012_URL).text());
  const db = shim(sqlite);
  // Real ensureTable path (dummy tenant scope): creates the cache table AND
  // the F15 expires_at index.
  await new UserDataCacheStore(db as unknown as D1Database, {
    teamId: "team",
    orgId: "00D000000000001AAA",
    channelId: "channel",
  }).ensureTable();

  const job = sqlite.prepare(
    "INSERT INTO sf_agent_snapshot_job(id,team_id,org_id,channel_id,agent_name,status,state_json,manifest_json,created_at,updated_at,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  );
  const file = sqlite.prepare(
    "INSERT INTO sf_agent_snapshot_file(team_id,org_id,channel_id,job_id,path,sha256,byte_size) VALUES(?,?,?,?,?,?,?)",
  );
  const chunk = sqlite.prepare(
    "INSERT INTO sf_agent_snapshot_chunk(team_id,org_id,channel_id,job_id,path,chunk_index,content) VALUES(?,?,?,?,?,?,?)",
  );
  const T = { team: "team", org: "00D000000000001AAA", ch: "channel" };
  const addJob = (id: string, status: string, updatedAt: number, tenant = T) => {
    job.run(id, tenant.team, tenant.org, tenant.ch, "agent", status, "{}", null, updatedAt - 1000, updatedAt, 0);
    return id;
  };
  const addFile = (jobId: string, path: string, parts: string[], tenant = T) => {
    const bytes = Buffer.concat(parts.map((p) => Buffer.from(p)));
    file.run(tenant.team, tenant.org, tenant.ch, jobId, path, `sha-${path}`, bytes.length);
    parts.forEach((p, i) => chunk.run(tenant.team, tenant.org, tenant.ch, jobId, path, i, Buffer.from(p)));
  };

  // Purge candidates: terminal + older than 30d.
  const a = addJob("aaaaaaaa-0000-4000-8000-000000000001", "complete", NOW - 31 * DAY_MS);
  addFile(a, "bots/a.bot", ["aa0", "aa1"]);
  addFile(a, "planners/a.plan", ["ap0", "ap1"]);
  const b = addJob("aaaaaaaa-0000-4000-8000-000000000002", "incomplete", NOW - 40 * DAY_MS);
  addFile(b, "bots/b.bot", ["b0"]);
  addJob("aaaaaaaa-0000-4000-8000-000000000003", "failed", NOW - 35 * DAY_MS); // file-less
  // Second tenant, also purged (composite-key cascade across tenants).
  const T2 = { team: "team-2", org: "00D000000000002AAA", ch: "channel-2" };
  const a2 = addJob("aaaaaaaa-0000-4000-8000-000000000004", "complete", NOW - 60 * DAY_MS, T2);
  addFile(a2, "bots/a2.bot", ["a20"], T2);

  // Keepers.
  const d = addJob("dddddddd-0000-4000-8000-000000000001", "complete", NOW - 1 * DAY_MS);
  addFile(d, "bots/d.bot", ["d0", "d1", "d2"]);
  const e = addJob("eeeeeeee-0000-4000-8000-000000000001", "retrieving", NOW - 31 * DAY_MS);
  addFile(e, "bots/e.bot", ["e0"]); // stuck retrieving: still never purged
  const f = addJob("ffffffff-0000-4000-8000-000000000001", "retrieving", NOW - 3600 * 1000);
  addFile(f, "bots/f.bot", ["f0"]); // in-flight
  const g = addJob("gggggggg-0000-4000-8000-000000000001", "complete", jobCutoffMs);
  addFile(g, "bots/g.bot", ["g0"]); // boundary: updated_at == cutoff is kept

  const cache = sqlite.prepare(
    "INSERT INTO sf_user_data_cache_v2(user_id,channel_id,org_id,team_id,data,etag,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
  );
  const put = (userId: string, expiresAt: number) =>
    cache.run(userId, "channel", "00D000000000001AAA", "team", `{"u":"${userId}"}`, `etag-${userId}`, 1, expiresAt);
  put("u1-stale", cacheCutoffSec - 86400); // expired 2d ago: purged
  put("u2-grace", cacheCutoffSec + 43200); // expired 12h ago: within grace, kept
  put("u3-live", Math.floor(NOW / 1000) + 3600); // live: kept
  put("u4-edge", cacheCutoffSec); // boundary: expires_at == cutoff is purged
  put("u5-never", 0); // sentinel: kept

  return { sqlite, db };
}

test("F15: dry-run reports the exact purge backlog", async () => {
  const { db } = await seedDb();
  expect(await dryRunRetention(db, NOW)).toEqual({ jobs: 4, files: 4, chunks: 6, userCache: 2 });
});

test("F15: purge deletes terminal-old jobs with files+chunks and stale cache, keeps the rest", async () => {
  const { sqlite, db } = await seedDb();
  const summary = await purgeRetention(db, NOW);
  expect(summary).toEqual({ jobs: 4, files: 4, chunks: 6, userCache: 2, batches: 2, capped: false });

  const jobs = (sqlite.query("SELECT id,status FROM sf_agent_snapshot_job ORDER BY id").all() as Array<{ id: string; status: string }>).map((r) => r.id);
  expect(jobs).toEqual([
    "dddddddd-0000-4000-8000-000000000001",
    "eeeeeeee-0000-4000-8000-000000000001",
    "ffffffff-0000-4000-8000-000000000001",
    "gggggggg-0000-4000-8000-000000000001",
  ]);
  // Kept files/chunks byte-identical (snapshot reads/downloads unaffected).
  const kept = sqlite.query("SELECT path,chunk_index,content FROM sf_agent_snapshot_chunk ORDER BY path,chunk_index").all() as Array<{ path: string; chunk_index: number; content: Uint8Array }>;
  expect(kept.map((r) => `${r.path}#${r.chunk_index}:${Buffer.from(r.content).toString()}`)).toEqual([
    "bots/d.bot#0:d0",
    "bots/d.bot#1:d1",
    "bots/d.bot#2:d2",
    "bots/e.bot#0:e0",
    "bots/f.bot#0:f0",
    "bots/g.bot#0:g0",
  ]);
  const users = (sqlite.query("SELECT user_id FROM sf_user_data_cache_v2 ORDER BY user_id").all() as Array<{ user_id: string }>).map((r) => r.user_id);
  expect(users).toEqual(["u2-grace", "u3-live", "u5-never"]);
  // Kept cache payload intact (hit path unaffected).
  expect((sqlite.query("SELECT data FROM sf_user_data_cache_v2 WHERE user_id='u3-live'").get() as { data: string }).data).toBe('{"u":"u3-live"}');
});

test("F15: purge is idempotent — re-run deletes zero rows", async () => {
  const { db } = await seedDb();
  await purgeRetention(db, NOW);
  expect(await purgeRetention(db, NOW)).toEqual({ jobs: 0, files: 0, chunks: 0, userCache: 0, batches: 1, capped: false });
  expect(await dryRunRetention(db, NOW)).toEqual({ jobs: 0, files: 0, chunks: 0, userCache: 0 });
});

test("F15: no orphan files/chunks before or after the purge", async () => {
  const { sqlite, db } = await seedDb();
  const orphans = () =>
    (sqlite.query(`SELECT COUNT(*) AS n FROM sf_agent_snapshot_file f
      LEFT JOIN sf_agent_snapshot_job j ON j.team_id=f.team_id AND j.org_id=f.org_id AND j.channel_id=f.channel_id AND j.id=f.job_id
      WHERE j.id IS NULL`).get() as { n: number }).n +
    (sqlite.query(`SELECT COUNT(*) AS n FROM sf_agent_snapshot_chunk c
      LEFT JOIN sf_agent_snapshot_file f ON f.team_id=c.team_id AND f.org_id=c.org_id AND f.channel_id=c.channel_id AND f.job_id=c.job_id AND f.path=c.path
      WHERE f.path IS NULL`).get() as { n: number }).n;
  expect(orphans()).toBe(0);
  await purgeRetention(db, NOW);
  expect(orphans()).toBe(0);
});

test("F15: migration 0012 applies idempotently and the job purge seeks (no SCAN)", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(await Bun.file(MIGRATION_0005_URL).text());
  const migration = await Bun.file(MIGRATION_0012_URL).text();
  const plan = (sql: string) =>
    (sqlite.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
  expect(plan(DRY_RUN_JOBS_SQL)).toContain("SCAN");
  sqlite.exec(migration);
  sqlite.exec(migration); // idempotent re-apply
  for (const sql of [DRY_RUN_JOBS_SQL, PURGE_JOBS_SQL]) {
    const after = plan(sql);
    expect(after).toContain("sf_agent_snapshot_job_retention_idx");
    expect(after).not.toContain("SCAN");
  }
});

test("F15: ensureTable creates the cache expires index and the cache purge seeks", async () => {
  const sqlite = new Database(":memory:");
  const db = shim(sqlite);
  await new UserDataCacheStore(db as unknown as D1Database, { teamId: "t", orgId: "o", channelId: "c" }).ensureTable();
  expect(sqlite.query("SELECT name FROM sqlite_master WHERE type='index' AND name='sf_user_data_cache_v2_expires_idx'").get()).not.toBeNull();
  const after = (sqlite.query(`EXPLAIN QUERY PLAN ${PURGE_USER_CACHE_SQL}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
  expect(after).toContain("sf_user_data_cache_v2_expires_idx");
  expect(after).not.toContain("SCAN");
});

test("F15: dry-run and purge on a fresh DB (no tables) report zeros without throwing", async () => {
  const db = shim(new Database(":memory:"));
  expect(await dryRunRetention(db, NOW)).toEqual({ jobs: 0, files: 0, chunks: 0, userCache: 0 });
  expect(await purgeRetention(db, NOW)).toEqual({ jobs: 0, files: 0, chunks: 0, userCache: 0, batches: 1, capped: false });
});

test("F15: guard skips without DB/ctx/waitUntil and never throws", async () => {
  __resetRetentionGuardForTests();
  const { db } = await seedDb();
  expect(await maybeRunRetention(undefined, { waitUntil() {} }, NOW)).toBe(false);
  expect(await maybeRunRetention(db, undefined, NOW)).toBe(false);
  expect(await maybeRunRetention(db, {} as any, NOW)).toBe(false);
  expect(await maybeRunRetention("nope" as any, { waitUntil() {} }, NOW)).toBe(false);
});

test("F15: guard runs the purge in waitUntil on a stale claim and updates the guard", async () => {
  __resetRetentionGuardForTests();
  const { sqlite, db } = await seedDb();
  const seen: Array<Promise<unknown>> = [];
  const ctx = { waitUntil(p: Promise<unknown>) { seen.push(p); } };
  expect(await maybeRunRetention(db, ctx, NOW)).toBe(true);
  expect(seen).toHaveLength(1);
  await seen[0];
  expect(await dryRunRetention(db, NOW)).toEqual({ jobs: 0, files: 0, chunks: 0, userCache: 0 });
  expect((sqlite.query("SELECT last_run_at FROM f15_retention_guard WHERE key='sf_auth_daily_v1'").get() as { last_run_at: number }).last_run_at).toBe(NOW);
});

test("F15: guard skips when the daily run is fresh (claim race lost)", async () => {
  __resetRetentionGuardForTests();
  const { sqlite, db } = await seedDb();
  sqlite.exec("CREATE TABLE IF NOT EXISTS f15_retention_guard (key TEXT PRIMARY KEY, last_run_at INTEGER NOT NULL)");
  sqlite.query("INSERT INTO f15_retention_guard VALUES (?, ?)").run("sf_auth_daily_v1", NOW);
  const seen: Array<Promise<unknown>> = [];
  expect(await maybeRunRetention(db, { waitUntil(p: Promise<unknown>) { seen.push(p); } }, NOW)).toBe(false);
  expect(seen).toHaveLength(0);
  // Nothing purged.
  expect(await dryRunRetention(db, NOW)).toEqual({ jobs: 4, files: 4, chunks: 6, userCache: 2 });
});

test("F15: guard throttles D1 checks per isolate (second call is zero-I/O)", async () => {
  __resetRetentionGuardForTests();
  const { db } = await seedDb();
  let prepares = 0;
  const counting = { prepare(sql: string) { prepares++; return (db as any).prepare(sql); }, batch: (db as any).batch.bind(db) };
  let bg: Promise<unknown> | null = null;
  const ctx = { waitUntil(p: Promise<unknown>) { bg = p; } };
  expect(await maybeRunRetention(counting as any, ctx, NOW)).toBe(true);
  await bg; // settle the background purge before counting
  const afterFirst = prepares;
  expect(afterFirst).toBeGreaterThan(0);
  expect(await maybeRunRetention(counting as any, ctx, NOW + 1000)).toBe(false);
  expect(prepares).toBe(afterFirst);
});

test("F15: migration 0013 applies idempotently and creates the guard table", async () => {
  const sqlite = new Database(":memory:");
  const migration = await Bun.file(MIGRATION_0013_URL).text();
  sqlite.exec(migration);
  sqlite.exec(migration); // idempotent re-apply
  expect(sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='f15_retention_guard'").get()).not.toBeNull();
});

test("F15: guard on a fresh DB creates the guard table and runs a zero purge", async () => {
  __resetRetentionGuardForTests();
  const sqlite = new Database(":memory:");
  const db = shim(sqlite);
  const seen: Array<Promise<unknown>> = [];
  expect(await maybeRunRetention(db, { waitUntil(p: Promise<unknown>) { seen.push(p); } }, NOW)).toBe(true);
  await seen[0];
  expect(sqlite.query("SELECT last_run_at FROM f15_retention_guard WHERE key='sf_auth_daily_v1'").get()).not.toBeNull();
});
