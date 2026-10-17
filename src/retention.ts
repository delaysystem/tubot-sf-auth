/** F15 retention purges for tubot-sf-auth (snapshot job/file/chunk +
 * sf_user_data_cache_v2). Zero-retention tables grow forever (chunks are the
 * largest by far: one BLOB row per 48 KiB of every snapshot ever extracted),
 * so maybeRunRetention() runs purgeRetention() at most daily;
 * dryRunRetention() reports the exact backlog first using the same predicates
 * without LIMIT.
 *
 * Trigger choice: hot-path piggyback with a daily-run guard, NOT a cron. A
 * cron was the first design (own budget, off-peak), but the account is at the
 * Workers Free limit of 5 cron triggers, so new crons fail to register and
 * break deploys. The piggyback keeps user calls safe instead: an isolate-local
 * throttle (one D1 guard read per hour max), an atomic cross-isolate daily
 * claim, and the purge itself always in ctx.waitUntil — zero added latency,
 * and the purge is idempotent + batch-capped so a duplicate run is harmless.
 * The scheduled() handler stays in the worker as dormant-ready code: re-adding
 * the 3-line triggers block if cron capacity ever frees up just works.
 *
 * Windows (conservative):
 * - Terminal ('complete','incomplete','failed') snapshot jobs older than 30d
 *   by updated_at (the terminal-transition timestamp), with files+chunks
 *   deleted children-first in the same atomic batch. 'retrieving' jobs are
 *   never matched by construction (IN-list), and in-flight jobs are < 1h old
 *   by the extraction-expiry rule, far from the 30d cutoff.
 * - User-data cache rows expired for over 1d grace (expires_at is SECONDS
 *   here). Expired rows are already invisible to every reader (get() returns
 *   null), so deletion reclaims storage only; the grace covers skew/debug.
 *
 * Boundary semantics (pinned by tests): jobs use strict `updated_at < cutoff`
 * ("older than 30 days"); cache rows use `expires_at <= cutoff` ("expired at
 * least grace ago", matching the readers' own `expires_at <= now` check).
 */

export const SNAPSHOT_JOB_RETENTION_MS = 30 * 24 * 3600 * 1000;
export const USER_CACHE_PURGE_GRACE_SEC = 24 * 3600;
export const RETENTION_BATCH_SIZE = 500;
export const RETENTION_MAX_BATCHES = 50;

/** Minimal D1 surface the purge needs; real D1Database is assignable. */
export interface RetentionDb {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T>(column?: string): Promise<T | null>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
    run(): Promise<{ meta?: { changes?: number } }>;
  };
  batch(statements: Array<{ run(): Promise<unknown> }>): Promise<Array<{ meta?: { changes?: number } }>>;
}

const TERMINAL_JOB_PREDICATE = "status IN ('complete','incomplete','failed') AND updated_at < ?";
const TERMINAL_JOB_KEY_SELECT =
  `SELECT team_id,org_id,channel_id,id FROM sf_agent_snapshot_job WHERE ${TERMINAL_JOB_PREDICATE}`;

/** Defensive index DDL (idempotent no-op once migration 0012 has applied; it
 * guarantees the purge seeks even on a DB whose migrations lag). */
export const SNAPSHOT_RETENTION_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS sf_agent_snapshot_job_retention_idx ON sf_agent_snapshot_job(status, updated_at)";
export const USER_CACHE_EXPIRES_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS sf_user_data_cache_v2_expires_idx ON sf_user_data_cache_v2(expires_at)";

/** Dry-run counts: the exact purge predicates, no LIMIT (full backlog). */
export const DRY_RUN_JOBS_SQL =
  `SELECT COUNT(*) AS n FROM sf_agent_snapshot_job WHERE ${TERMINAL_JOB_PREDICATE}`;
export const DRY_RUN_FILES_SQL =
  `SELECT COUNT(*) AS n FROM sf_agent_snapshot_file WHERE (team_id,org_id,channel_id,job_id) IN (${TERMINAL_JOB_KEY_SELECT})`;
export const DRY_RUN_CHUNKS_SQL =
  `SELECT COUNT(*) AS n FROM sf_agent_snapshot_chunk WHERE (team_id,org_id,channel_id,job_id) IN (${TERMINAL_JOB_KEY_SELECT})`;
export const DRY_RUN_USER_CACHE_SQL =
  "SELECT COUNT(*) AS n FROM sf_user_data_cache_v2 WHERE expires_at > 0 AND expires_at <= ?";

/** Batched deletes. Children (chunks, files) select the same terminal-old job
 * batch as the job delete, so one iteration removes whole jobs; D1 has no
 * DELETE..LIMIT, hence the rowid/IN-subselect form. Cutoffs are bound; the
 * LIMIT is baked from our own constant (no injection surface). */
export const PURGE_CHUNKS_SQL =
  `DELETE FROM sf_agent_snapshot_chunk WHERE (team_id,org_id,channel_id,job_id) IN (${TERMINAL_JOB_KEY_SELECT} LIMIT ${RETENTION_BATCH_SIZE})`;
export const PURGE_FILES_SQL =
  `DELETE FROM sf_agent_snapshot_file WHERE (team_id,org_id,channel_id,job_id) IN (${TERMINAL_JOB_KEY_SELECT} LIMIT ${RETENTION_BATCH_SIZE})`;
export const PURGE_JOBS_SQL =
  `DELETE FROM sf_agent_snapshot_job WHERE rowid IN (SELECT rowid FROM sf_agent_snapshot_job WHERE ${TERMINAL_JOB_PREDICATE} LIMIT ${RETENTION_BATCH_SIZE})`;
export const PURGE_USER_CACHE_SQL =
  `DELETE FROM sf_user_data_cache_v2 WHERE rowid IN (SELECT rowid FROM sf_user_data_cache_v2 WHERE expires_at > 0 AND expires_at <= ? LIMIT ${RETENTION_BATCH_SIZE})`;

export interface RetentionCounts {
  jobs: number;
  files: number;
  chunks: number;
  userCache: number;
}

export interface PurgeSummary extends RetentionCounts {
  batches: number;
  capped: boolean;
}

const isMissingTable = (error: unknown): boolean =>
  error instanceof Error && /no such table/i.test(error.message);

async function count(db: RetentionDb, sql: string, cutoff: number): Promise<number> {
  try {
    const row = await db.prepare(sql).bind(cutoff).first<{ n: number }>();
    return row?.n ?? 0;
  } catch (error) {
    // Fresh DB where the table was never created: nothing to purge.
    if (isMissingTable(error)) return 0;
    throw error;
  }
}

async function changes(promise: Promise<{ meta?: { changes?: number } }>): Promise<number> {
  try {
    return (await promise).meta?.changes ?? 0;
  } catch (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
}

export function retentionCutoffs(nowMs: number = Date.now()): { jobCutoffMs: number; cacheCutoffSec: number } {
  return {
    jobCutoffMs: nowMs - SNAPSHOT_JOB_RETENTION_MS,
    cacheCutoffSec: Math.floor(nowMs / 1000) - USER_CACHE_PURGE_GRACE_SEC,
  };
}

export async function dryRunRetention(db: RetentionDb, nowMs: number = Date.now()): Promise<RetentionCounts> {
  const { jobCutoffMs, cacheCutoffSec } = retentionCutoffs(nowMs);
  const [jobs, files, chunks, userCache] = await Promise.all([
    count(db, DRY_RUN_JOBS_SQL, jobCutoffMs),
    count(db, DRY_RUN_FILES_SQL, jobCutoffMs),
    count(db, DRY_RUN_CHUNKS_SQL, jobCutoffMs),
    count(db, DRY_RUN_USER_CACHE_SQL, cacheCutoffSec),
  ]);
  return { jobs, files, chunks, userCache };
}

/** Batched purge: one atomic (chunks, files, jobs) batch plus one user-cache
 * delete per iteration until an iteration deletes nothing or the batch cap is
 * hit. Idempotent: a re-run deletes zero rows. */
export async function purgeRetention(db: RetentionDb, nowMs: number = Date.now()): Promise<PurgeSummary> {
  const { jobCutoffMs, cacheCutoffSec } = retentionCutoffs(nowMs);
  for (const ddl of [SNAPSHOT_RETENTION_INDEX_SQL, USER_CACHE_EXPIRES_INDEX_SQL]) {
    try {
      await db.prepare(ddl).run();
    } catch (error) {
      if (!isMissingTable(error)) throw error;
    }
  }
  const total: RetentionCounts = { jobs: 0, files: 0, chunks: 0, userCache: 0 };
  let batches = 0;
  let capped = false;
  for (;;) {
    batches++;
    let jobs = 0, files = 0, chunks = 0;
    try {
      const [c, f, j] = await db.batch([
        db.prepare(PURGE_CHUNKS_SQL).bind(jobCutoffMs),
        db.prepare(PURGE_FILES_SQL).bind(jobCutoffMs),
        db.prepare(PURGE_JOBS_SQL).bind(jobCutoffMs),
      ]);
      chunks = c.meta?.changes ?? 0;
      files = f.meta?.changes ?? 0;
      jobs = j.meta?.changes ?? 0;
    } catch (error) {
      if (!isMissingTable(error)) throw error;
    }
    const cache = await changes(db.prepare(PURGE_USER_CACHE_SQL).bind(cacheCutoffSec).run());
    total.jobs += jobs;
    total.files += files;
    total.chunks += chunks;
    total.userCache += cache;
    if (jobs + files + chunks + cache === 0) break;
    if (batches >= RETENTION_MAX_BATCHES) {
      capped = true;
      break;
    }
  }
  return { ...total, batches, capped };
}

// ---------- daily-run guard (piggyback trigger) ----------

/** Guard-table key for THIS worker. sf-auth and data360 share the same D1
 * databases (staging and prod), so each worker claims its own key. */
export const RETENTION_GUARD_KEY = "sf_auth_daily_v1";
export const RETENTION_GUARD_INTERVAL_MS = 24 * 3600 * 1000;
/** Per-isolate D1 check throttle: hot calls past this return false with zero I/O. */
export const RETENTION_GUARD_CHECK_THROTTLE_MS = 3600 * 1000;
export const RETENTION_GUARD_DDL =
  "CREATE TABLE IF NOT EXISTS f15_retention_guard (key TEXT PRIMARY KEY, last_run_at INTEGER NOT NULL)";
const RETENTION_GUARD_READ_SQL = "SELECT last_run_at FROM f15_retention_guard WHERE key = ?";
const RETENTION_GUARD_CLAIM_SQL = `INSERT INTO f15_retention_guard(key,last_run_at) VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET last_run_at=? WHERE f15_retention_guard.last_run_at <= ?`;

let lastGuardCheckMs = 0;
const guardDdlDone = new WeakSet<object>();
/** Test-only reset for the isolate-local throttle. */
export function __resetRetentionGuardForTests(): void {
  lastGuardCheckMs = 0;
}

/** Hot-path entry: at most one D1 guard read per isolate per hour; the purge
 * itself runs in ctx.waitUntil only after winning the atomic daily claim.
 * Never throws, never blocks the caller. Returns true when a purge started. */
export async function maybeRunRetention(
  db: RetentionDb | undefined,
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    if (!db || !ctx || typeof ctx.waitUntil !== "function") return false;
    if (nowMs - lastGuardCheckMs < RETENTION_GUARD_CHECK_THROTTLE_MS) return false;
    lastGuardCheckMs = nowMs;
    if (!guardDdlDone.has(db)) {
      await db.prepare(RETENTION_GUARD_DDL).run();
      guardDdlDone.add(db);
    }
    const row = await db.prepare(RETENTION_GUARD_READ_SQL).bind(RETENTION_GUARD_KEY).first<{ last_run_at: number }>();
    if (row && row.last_run_at > nowMs - RETENTION_GUARD_INTERVAL_MS) return false;
    const claim = await db
      .prepare(RETENTION_GUARD_CLAIM_SQL)
      .bind(RETENTION_GUARD_KEY, nowMs, nowMs, nowMs - RETENTION_GUARD_INTERVAL_MS)
      .run();
    if ((claim.meta?.changes ?? 0) !== 1) return false;
    ctx.waitUntil(
      purgeRetention(db, nowMs).then(
        (summary) => console.log(JSON.stringify({ msg: "f15_retention_purge", ...summary })),
        (error) => console.error(JSON.stringify({ msg: "f15_retention_purge_error", error: String(error) })),
      ),
    );
    return true;
  } catch {
    return false;
  }
}
