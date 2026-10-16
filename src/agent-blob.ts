import { SecurityError } from "./request-security";
import { requireAgentScope, sha256, type AgentScope, type AgentSnapshotFile, type AgentSnapshotPayload, type AgentSnapshotSummary } from "./agent-snapshot";
import type { Data360AgentClient } from "./data360-client";

/**
 * Team-scoped index over data360's content-addressed agent blobs. B2 objects
 * are immutable and named by sha; this index is what makes them tenant-safe:
 * every read/list filters by (team, org), and hydration additionally requires
 * a registered credential for the org.
 */

async function ownsOrg(db: D1Database, teamId: string, orgId: string): Promise<boolean> {
  // Production registry first; local dev shims the legacy credential table.
  for (const table of ["panel_salesforce_execution_users", "salesforce_auth_credential"]) {
    try {
      const row = await db.prepare(`SELECT 1 AS ok FROM ${table} WHERE team_id=? AND org_id=? LIMIT 1`)
        .bind(teamId, orgId).first<{ ok: number }>();
      if (row) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export async function listIndexedAgents(db: D1Database, scope: AgentScope): Promise<AgentSnapshotSummary[]> {
  const { teamId, orgId } = requireAgentScope(scope);
  const rows = (await db.prepare(`SELECT agent_name, blob_sha, updated_at FROM sf_agent_blob_index
    WHERE team_id=? AND org_id=? ORDER BY agent_name`)
    .bind(teamId, orgId).all<{ agent_name: string; blob_sha: string; updated_at: number }>()).results;
  return rows.map(r => ({ agentName: r.agent_name, jobId: `blob-${r.blob_sha.slice(0, 12)}`, status: "complete", updatedAt: r.updated_at }));
}

export async function upsertBlobIndex(
  db: D1Database, scope: AgentScope, agent: string, sha: string, snapshotId: string | null, fileCount: number,
): Promise<void> {
  const { teamId, orgId } = requireAgentScope(scope);
  const now = Date.now();
  await db.prepare(`INSERT INTO sf_agent_blob_index(team_id,org_id,agent_name,blob_sha,b2_snapshot_id,file_count,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(team_id,org_id,agent_name)
    DO UPDATE SET blob_sha=excluded.blob_sha, b2_snapshot_id=excluded.b2_snapshot_id, file_count=excluded.file_count, updated_at=excluded.updated_at`)
    .bind(teamId, orgId, agent, sha, snapshotId, fileCount, now).run();
}

/** Normalizes blob files into snapshot payload files (integrity-verified, size-capped). */
export async function blobFilesToSnapshot(
  agent: string, sha: string, files: Record<string, string>, snapshotId: string | null,
): Promise<AgentSnapshotPayload> {
  const entries = Object.entries(files);
  if (entries.length === 0 || entries.length > 2000) throw new SecurityError(502, "data360_invalid_response");
  const encoder = new TextEncoder();
  const out: AgentSnapshotFile[] = [];
  let total = 0;
  for (const [path, content] of entries.sort(([a], [b]) => a < b ? -1 : 1)) {
    if (typeof path !== "string" || typeof content !== "string" || path.length === 0 || path.length > 1024 ||
      path.includes("..") || path.startsWith("/") || /[\\]/.test(path)) {
      throw new SecurityError(502, "data360_invalid_response");
    }
    const bytes = encoder.encode(content);
    total += bytes.length;
    if (total > 512_000) throw new SecurityError(413, "agent_snapshot_too_large");
    out.push({ path, sha256: await sha256(bytes), byteSize: bytes.length, content });
  }
  const combined = await sha256(encoder.encode(out.map(f => f.path + ":" + f.sha256).join("\n")));
  return {
    agentName: agent, jobId: `blob-${sha.slice(0, 12)}`, sha: combined,
    manifest: { hydratedFrom: "data360", blobSha: sha, b2SnapshotId: snapshotId },
    files: out,
  };
}

/**
 * Hydrates one agent from the data360 blob cache. Returns null when the team
 * has no credential for the org or no blob is cached (caller falls through
 * to 404); throws typed errors for transport/corruption failures.
 */
export async function hydrateAgentFromData360(
  db: D1Database, client: Data360AgentClient, scope: AgentScope, agentName: string,
): Promise<AgentSnapshotPayload | null> {
  const { teamId, orgId } = requireAgentScope(scope);
  if (!await ownsOrg(db, teamId, orgId)) return null;
  const doc = await client.getAgent(orgId, agentName);
  if (!doc) return null;
  const payload = await blobFilesToSnapshot(doc.agent || agentName, doc.sha, doc.files, doc.snapshotId ?? null);
  await upsertBlobIndex(db, scope, agentName, doc.sha, doc.snapshotId ?? null, payload.files.length);
  return payload;
}

/**
 * Union of D1 snapshot jobs and data360-cached agents. D1 rows always win;
 * data360 enumeration failures degrade to D1-only (logged by the caller).
 */
export async function listCachedAgents(
  db: D1Database, client: Data360AgentClient | null, scope: AgentScope, d1: AgentSnapshotSummary[],
): Promise<AgentSnapshotSummary[]> {
  const known = new Set(d1.map(s => s.agentName));
  const out = [...d1];
  if (!client) return out;
  const { teamId, orgId } = requireAgentScope(scope);
  if (!await ownsOrg(db, teamId, orgId)) return out;
  // Remote failures propagate: the RPC layer logs and degrades to D1-only.
  // Never swallow here — silent misses are indistinguishable from empty.
  const [indexed, remote] = await Promise.all([
    listIndexedAgents(db, scope),
    client.listAgents(orgId),
  ]);
  for (const row of indexed) {
    if (!known.has(row.agentName)) { known.add(row.agentName); out.push(row); }
  }
  const now = Date.now();
  for (const agent of remote ?? []) {
    if (typeof agent !== "string") continue;
    if (!known.has(agent)) {
      known.add(agent);
      out.push({ agentName: agent, jobId: `blob-pending`, status: "complete", updatedAt: now });
    }
  }
  return out.sort((a, b) => a.agentName < b.agentName ? -1 : 1);
}
