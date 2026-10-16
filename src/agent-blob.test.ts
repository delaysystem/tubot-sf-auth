import { describe, expect, test, beforeEach } from "bun:test";
import { blobFilesToSnapshot, hydrateAgentFromData360, listCachedAgents, listIndexedAgents, upsertBlobIndex } from "./agent-blob";
import type { Data360AgentClient } from "./data360-client";
import type { AgentSnapshotSummary } from "./agent-snapshot";

const SCOPE = { teamId: "team-test", orgId: "00Dtest000000001" };

function createMockDb(owned = true) {
  const index = new Map<string, { agent_name: string; blob_sha: string; updated_at: number }>();
  const db = {
    index,
    prepare(sql: string) {
      let bound: any[] = [];
      const stmt = {
        bind(...args: any[]) { bound = args; return stmt; },
        async first() {
          if (sql.includes("panel_salesforce_execution_users")) return owned ? { ok: 1 } : null;
          return null;
        },
        async all() {
          if (sql.includes("FROM sf_agent_blob_index")) {
            const [teamId, orgId] = bound;
            return { results: [...index.values()].filter(r => (r as any).team_id === teamId && (r as any).org_id === orgId) };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO sf_agent_blob_index")) {
            const [teamId, orgId, agent, sha, snapshotId, fileCount] = bound;
            index.set(`${teamId}/${orgId}/${agent}`, {
              agent_name: agent, blob_sha: sha, updated_at: Date.now(),
              team_id: teamId, org_id: orgId,
            } as any);
            void snapshotId; void fileCount;
            return { success: true };
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return db as unknown as D1Database & { index: Map<string, any> };
}

function stubClient(doc: Record<string, string> | null, agents: string[] = []): Data360AgentClient {
  return {
    async listAgents() { return agents; },
    async getAgent(_org: string, agent: string) {
      if (!doc) return null;
      return { agent, orgId: SCOPE.orgId, sha: "a".repeat(64), files: doc, snapshotId: "snap-1", updatedAt: new Date().toISOString() };
    },
  } as unknown as Data360AgentClient;
}

describe("blobFilesToSnapshot", () => {
  test("builds integrity-verified payload with combined sha", async () => {
    const payload = await blobFilesToSnapshot("CoolAgent", "b".repeat(64), {
      "bots/CoolAgent.bot": "<Bot/>",
      "genAiPlannerBundles/CoolAgent/CoolAgent.genAiPlannerBundle": "<Planner/>",
    }, "snap-1");
    expect(payload.agentName).toBe("CoolAgent");
    expect(payload.jobId).toBe("blob-bbbbbbbbbbbb");
    expect(payload.files.map(f => f.path)).toEqual([
      "bots/CoolAgent.bot",
      "genAiPlannerBundles/CoolAgent/CoolAgent.genAiPlannerBundle",
    ]);
    expect(payload.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.sha).toMatch(/^[0-9a-f]{64}$/);
    expect((payload.manifest as any).hydratedFrom).toBe("data360");
  });

  test("rejects hostile paths", async () => {
    await expect(blobFilesToSnapshot("A", "c".repeat(64), { "../evil": "x" }, null)).rejects.toThrow("data360_invalid_response");
    await expect(blobFilesToSnapshot("A", "c".repeat(64), { "/abs": "x" }, null)).rejects.toThrow("data360_invalid_response");
    await expect(blobFilesToSnapshot("A", "c".repeat(64), { "a\\b": "x" }, null)).rejects.toThrow("data360_invalid_response");
    await expect(blobFilesToSnapshot("A", "c".repeat(64), {}, null)).rejects.toThrow("data360_invalid_response");
  });

  test("enforces the 512KB RPC cap", async () => {
    await expect(blobFilesToSnapshot("A", "c".repeat(64), { "big": "x".repeat(600_000) }, null)).rejects.toThrow("agent_snapshot_too_large");
  });
});

describe("hydrateAgentFromData360", () => {
  test("returns null without an org credential (ownership)", async () => {
    const db = createMockDb(false);
    const out = await hydrateAgentFromData360(db, stubClient({ "bots/A.bot": "<b/>" }), SCOPE, "A");
    expect(out).toBeNull();
  });

  test("returns null on uncached blob", async () => {
    const db = createMockDb(true);
    const out = await hydrateAgentFromData360(db, stubClient(null), SCOPE, "A");
    expect(out).toBeNull();
  });

  test("hydrates and upserts the team-scoped index", async () => {
    const db = createMockDb(true);
    const out = await hydrateAgentFromData360(db, stubClient({ "bots/A.bot": "<b/>" }), SCOPE, "A");
    expect(out?.agentName).toBe("A");
    expect(out?.files).toHaveLength(1);
    const indexed = await listIndexedAgents(db, SCOPE);
    expect(indexed.map(r => r.agentName)).toEqual(["A"]);
    expect(db.index.size).toBe(1);
  });
});

describe("listCachedAgents", () => {
  const d1: AgentSnapshotSummary[] = [{ agentName: "Seeded", jobId: "j1", status: "complete", updatedAt: 1 }];

  test("D1 rows win; index and remote names union in", async () => {
    const db = createMockDb(true);
    await upsertBlobIndex(db, SCOPE, "Indexed", "d".repeat(64), null, 2);
    const out = await listCachedAgents(db, stubClient({}, ["Seeded", "Remote"]), SCOPE, d1);
    expect(out.map(r => r.agentName)).toEqual(["Indexed", "Remote", "Seeded"]);
    expect(out.find(r => r.agentName === "Seeded")?.jobId).toBe("j1");
  });

  test("null client or no ownership degrades to D1-only", async () => {
    const db = createMockDb(true);
    expect(await listCachedAgents(db, null, SCOPE, d1)).toEqual(d1);
    const unowned = createMockDb(false);
    expect(await listCachedAgents(unowned, stubClient({}, ["Remote"]), SCOPE, d1)).toEqual(d1);
  });
});

describe("data360 service signature interop", () => {
  test("sf-auth signer output verifies with data360 verifier", async () => {
    const { signServiceRequest } = await import("../../tubot-new-panel/worker/service-signer");
    const { verifyServiceSignature } = await import("../../tubot-sf-data360/src/service-verify");
    const key = "k".repeat(40);
    const headers = await signServiceRequest(key, "GET", "/api/cache/agent", "");
    const sig = {
      timestamp: headers["x-tubot-sig-timestamp"],
      nonce: headers["x-tubot-sig-nonce"],
      signature: headers["x-tubot-sig-signature"],
    };
    expect(await verifyServiceSignature([key], "GET", "/api/cache/agent", "", sig, Math.floor(Date.now() / 1000))).toBe(true);
    expect(await verifyServiceSignature([key], "GET", "/api/cache/agents", "", sig, Math.floor(Date.now() / 1000))).toBe(false);
  });
});
