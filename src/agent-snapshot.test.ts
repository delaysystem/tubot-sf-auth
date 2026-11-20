import { afterEach, expect, test } from "bun:test";
import { strToU8, unzipSync, zipSync } from "fflate";
import worker, { type AuthEnv } from "./index";
import {
  advanceAgentSnapshot,
  agentSnapshotStatus,
  discoverAgents,
  downloadAgentSnapshot,
  planAgentSnapshotPoll,
  readAgentSnapshotForScope,
  reconcileExtractionJobs,
  startAgentSnapshot,
  SNAPSHOT_POLL_FRESH_MS,
  SNAPSHOT_SF_FAIL_COOLDOWN_MS,
} from "./agent-snapshot";
import type { TenantScope } from "./request-security";

// Poll-to-advance suite: a retrieving job must progress to a terminal,
// downloadable D1 snapshot through status polls alone, concurrent polls must
// stay lease-safe, and terminal/failed jobs must pass through untouched.

const ORG = "00D" + "O".repeat(12);
const USER = "005" + "U".repeat(12);
const INSTANCE = "https://test.my.salesforce.com";
const HMAC_KEY = "test-panel-hmac-key-0123456789abcdef";
const STATUS_URL = "https://auth.test/internal/agents/status";
const CONN = { instanceUrl: INSTANCE, accessToken: "test-access-token", integrationUserId: USER };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type JobRow = {
  id: string; team_id: string; org_id: string; channel_id: string;
  agent_name: string; status: string; state_json: string;
  manifest_json: string | null; created_at: number; updated_at: number; lease_until: number;
};
type FileRow = {
  team_id: string; org_id: string; channel_id: string; job_id: string;
  path: string; sha256: string; byte_size: number;
};
type ChunkRow = {
  team_id: string; org_id: string; channel_id: string; job_id: string;
  path: string; chunk_index: number; content: ArrayBuffer;
};
type SnapshotFakeDb = D1Database & {
  jobs: Map<string, JobRow>;
  seedJob(row: JobRow): void;
  seedFile(row: FileRow): void;
  seedChunk(row: ChunkRow): void;
  fileInserts: number;
  chunkInserts: number;
  chunkSelects: number;
};

const jobKey = (team: string, org: string, channel: string, id: string) =>
  `${team}\u0000${org}\u0000${channel}\u0000${id}`;

function createSnapshotDb(opts: {
  channel?: Record<string, unknown> | null;
  metadataUser?: Record<string, unknown> | null;
} = {}): SnapshotFakeDb {
  const jobs = new Map<string, JobRow>();
  const files = new Map<string, FileRow>();
  const chunks: ChunkRow[] = [];
  const nonces = new Set<string>();
  const counts = { fileInserts: 0, chunkInserts: 0, chunkSelects: 0 };
  const channel = opts.channel === undefined ? null : opts.channel;
  const metadataUser = opts.metadataUser === undefined ? null : opts.metadataUser;
  const db = {
    jobs,
    seedJob(row: JobRow) {
      jobs.set(jobKey(row.team_id, row.org_id, row.channel_id, row.id), row);
    },
    seedFile(row: FileRow) {
      files.set(`${row.job_id}\u0000${row.path}`, row);
    },
    seedChunk(row: ChunkRow) {
      chunks.push(row);
    },
    get fileInserts() {
      return counts.fileInserts;
    },
    get chunkInserts() {
      return counts.chunkInserts;
    },
    get chunkSelects() {
      return counts.chunkSelects;
    },
    prepare(sql: string) {
      const q = sql.replace(/\s+/g, " ");
      let args: any[] = [];
      const stmt = {
        bind(...values: any[]) {
          args = values;
          return stmt;
        },
        async first() {
          if (q.includes("FROM panel_salesforce_channels")) return channel;
          if (q.includes("FROM sf_agent_metadata_user")) return metadataUser;
          if (q.includes("FROM sf_agent_snapshot_job")) {
            if (q.includes("agent_name=?")) {
              const cands = [...jobs.values()]
                .filter((j) => j.team_id === args[0] && j.org_id === args[1] && j.agent_name === args[2] &&
                  ["complete", "incomplete"].includes(j.status))
                .sort((a, b) => b.created_at - a.created_at);
              const j = cands[0];
              return j ? { id: j.id, agent_name: j.agent_name, status: j.status, manifest_json: j.manifest_json, channel_id: j.channel_id } : null;
            }
            return jobs.get(jobKey(args[0], args[1], args[2], args[3])) ?? null;
          }
          if (q.startsWith("SELECT sha256 FROM sf_agent_snapshot_file")) {
            return files.get(`${args[3]}\u0000${args[4]}`) ?? null;
          }
          return null;
        },
        async all() {
          if (q.includes("FROM sf_agent_snapshot_job")) {
            const rows = [...jobs.values()]
              .filter((j) => j.team_id === args[0] && j.org_id === args[1] && j.channel_id === args[2] &&
                (!q.includes("status='retrieving'") || j.status === "retrieving"))
              .map((j) => ({ id: j.id, state_json: j.state_json }));
            return { results: rows };
          }
          if (q.includes("FROM sf_agent_snapshot_chunk")) {
            counts.chunkSelects++;
            const rows = chunks
              .filter(
                (c) =>
                  c.team_id === args[0] && c.org_id === args[1] &&
                  c.channel_id === args[2] && c.job_id === args[3] &&
                  (args.length < 5 || c.path === args[4]),
              )
              .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.chunk_index - b.chunk_index))
              .map((c) => ({ path: c.path, content: c.content }));
            return { results: rows };
          }
          if (q.includes("FROM sf_agent_snapshot_file")) {
            const rows = [...files.values()]
              .filter(
                (f) =>
                  f.team_id === args[0] && f.org_id === args[1] &&
                  f.channel_id === args[2] && f.job_id === args[3],
              )
              .sort((a, b) => (a.path < b.path ? -1 : 1));
            return { results: rows };
          }
          return { results: [] };
        },
        async run() {
          if (q.startsWith("INSERT INTO sf_agent_snapshot_job")) {
            const [id, team_id, org_id, channel_id, agent_name, state_json, created_at, updated_at] = args;
            jobs.set(jobKey(team_id, org_id, channel_id, id), {
              id, team_id, org_id, channel_id, agent_name, status: "retrieving",
              state_json, manifest_json: null, created_at, updated_at, lease_until: 0,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (q.includes("UPDATE sf_agent_snapshot_job SET lease_until=?")) {
            const [lease, team_id, org_id, channel_id, id, now] = args;
            const job = jobs.get(jobKey(team_id, org_id, channel_id, id));
            if (job && job.status === "retrieving" && job.lease_until < now) {
              job.lease_until = lease;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (q.includes("UPDATE sf_agent_snapshot_job SET state_json=?,updated_at=?")) {
            const [state_json, updated_at, team_id, org_id, channel_id, id, lease] = args;
            const job = jobs.get(jobKey(team_id, org_id, channel_id, id));
            if (job && job.lease_until === lease) {
              Object.assign(job, { state_json, updated_at });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (q.includes("UPDATE sf_agent_snapshot_job SET state_json=?")) {
            const [state_json, status, manifest_json, updated_at, team_id, org_id, channel_id, id, lease] = args;
            const job = jobs.get(jobKey(team_id, org_id, channel_id, id));
            if (job && job.lease_until === lease) {
              Object.assign(job, { state_json, status, manifest_json, updated_at });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (q.includes("UPDATE sf_agent_snapshot_job SET status='failed'")) {
            const [manifest_json, updated_at, team_id, org_id, channel_id, id, lease] = args;
            const job = jobs.get(jobKey(team_id, org_id, channel_id, id));
            if (job && job.lease_until === lease) {
              Object.assign(job, { status: "failed", manifest_json, updated_at });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (q.includes("UPDATE sf_agent_snapshot_job SET lease_until=0")) {
            const [team_id, org_id, channel_id, id, lease] = args;
            const job = jobs.get(jobKey(team_id, org_id, channel_id, id));
            if (job && job.lease_until === lease) {
              job.lease_until = 0;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (q.startsWith("INSERT INTO sf_agent_snapshot_file")) {
            const [team_id, org_id, channel_id, job_id, path, sha256, byte_size] = args;
            files.set(`${job_id}\u0000${path}`, { team_id, org_id, channel_id, job_id, path, sha256, byte_size });
            counts.fileInserts++;
            return { success: true, meta: { changes: 1 } };
          }
          if (q.startsWith("INSERT INTO sf_agent_snapshot_chunk")) {
            const [team_id, org_id, channel_id, job_id, path, chunk_index, content] = args;
            chunks.push({ team_id, org_id, channel_id, job_id, path, chunk_index, content });
            counts.chunkInserts++;
            return { success: true, meta: { changes: 1 } };
          }
          if (q.startsWith("DELETE FROM sf_agent_snapshot_chunk")) {
            const [team_id, org_id, channel_id, job_id] = args;
            let changes = 0;
            for (let i = chunks.length - 1; i >= 0; i--) {
              const c = chunks[i];
              if (c.team_id === team_id && c.org_id === org_id && c.channel_id === channel_id && c.job_id === job_id) {
                chunks.splice(i, 1);
                changes++;
              }
            }
            return { success: true, meta: { changes } };
          }
          if (q.startsWith("DELETE FROM sf_agent_snapshot_file")) {
            const [team_id, org_id, channel_id, job_id] = args;
            let changes = 0;
            for (const [k, f] of files) {
              if (f.team_id === team_id && f.org_id === org_id && f.channel_id === channel_id && f.job_id === job_id) {
                files.delete(k);
                changes++;
              }
            }
            return { success: true, meta: { changes } };
          }
          if (q.startsWith("DELETE FROM sf_agent_snapshot_job")) {
            const [team_id, org_id, channel_id, id] = args;
            const deleted = jobs.delete(jobKey(team_id, org_id, channel_id, id));
            return { success: true, meta: { changes: deleted ? 1 : 0 } };
          }
          if (q.includes("salesforce_self_oauth_internal_nonce")) {
            if (q.startsWith("DELETE")) return { success: true, meta: { changes: 0 } };
            if (nonces.has(args[0])) return { success: true, meta: { changes: 0 } };
            nonces.add(args[0]);
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      const out: unknown[] = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  };
  return db as unknown as SnapshotFakeDb;
}

const ZIP_B64 = Buffer.from(
  zipSync({
    "unpackaged/bots/TestAgent.bot": strToU8("<Bot/>"),
    "unpackaged/aiAuthoringBundles/TestAgent_v1.bin": strToU8("plain payload"),
  }),
).toString("base64");

const soapResult = (operation: string, inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Envelope><Body><${operation}Response>${inner}</${operation}Response></Body></Envelope>`;
const DESCRIBE_XML = soapResult(
  "describeMetadata",
  "<result><metadataObjects><xmlName>Bot</xmlName></metadataObjects><metadataObjects><xmlName>AiAuthoringBundle</xmlName></metadataObjects></result>",
);
const LIST_XML = soapResult(
  "listMetadata",
  "<result><fullName>TestAgent</fullName><type>Bot</type></result><result><fullName>TestAgent_v1</fullName><type>AiAuthoringBundle</type></result>",
);
const RETRIEVE_XML = soapResult("retrieve", "<result><id>ASYNC-1</id></result>");
const PENDING_XML = soapResult("checkRetrieveStatus", "<result><done>false</done></result>");
const doneXml = (zipB64: string) =>
  soapResult(
    "checkRetrieveStatus",
    `<result><done>true</done><success>true</success><zipFile>${zipB64}</zipFile>` +
      "<fileProperties><type>Bot</type><fullName>TestAgent</fullName></fileProperties>" +
      "<fileProperties><type>AiAuthoringBundle</type><fullName>TestAgent_v1</fullName></fileProperties></result>",
  );
const xmlResponse = (body: string) => new Response(body, { headers: { "Content-Type": "text/xml" } });

function mockSalesforce(script: { checkRetrieve: Array<"pending" | "done"> }, org: string, user: string) {
  const calls = { soap: [] as string[], checkRetrieve: 0, token: 0, userinfo: 0, versions: 0 };
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = new URL(String(input));
    if (url.pathname === "/services/oauth2/token") {
      calls.token++;
      return Response.json({ access_token: "test-access-token", instance_url: INSTANCE, expires_in: 120 });
    }
    if (url.pathname === "/services/oauth2/userinfo") {
      calls.userinfo++;
      return Response.json({ organization_id: org, user_id: user });
    }
    if (url.pathname === "/services/data/") {
      calls.versions++;
      return Response.json([{ version: "59.0" }]);
    }
    if (url.pathname.startsWith("/services/Soap/m/")) {
      const body = String(init?.body ?? "");
      const op =
        ["describeMetadata", "listMetadata", "retrieve", "checkRetrieveStatus"].find((o) =>
          body.includes(`<m:${o}>`),
        ) ?? "unknown";
      calls.soap.push(op);
      if (op === "describeMetadata") return xmlResponse(DESCRIBE_XML);
      if (op === "listMetadata") return xmlResponse(LIST_XML);
      if (op === "retrieve") return xmlResponse(RETRIEVE_XML);
      if (op === "checkRetrieveStatus") {
        calls.checkRetrieve++;
        const next = script.checkRetrieve.length ? script.checkRetrieve.shift()! : "done";
        return xmlResponse(next === "pending" ? PENDING_XML : doneXml(ZIP_B64));
      }
      return new Response("unknown SOAP operation", { status: 500 });
    }
    return Response.json([{ message: "not found" }], { status: 404 });
  }) as typeof fetch;
  return calls;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signedStatusRequest(url: string, secret: string, body: Record<string, unknown>): Promise<Request> {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const bodyDigest = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))));
  const target = new URL(url);
  const canonical = `POST\n${target.pathname}${target.search}\n${timestamp}\n${nonce}\n${bodyDigest}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical))));
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tubot-sf-auth-timestamp": timestamp,
      "x-tubot-sf-auth-nonce": nonce,
      "x-tubot-sf-auth-signature": signature,
    },
    body: raw,
  });
}

function channelRow(scope: TenantScope) {
  return {
    team_id: scope.teamId, org_id: scope.orgId, channel_id: scope.channelId,
    instance_url: INSTANCE, integration_user_id: USER,
    integration_username: "integration@example.com", is_sandbox: 0, client_id: null,
  };
}

function routeEnv(db: D1Database): AuthEnv {
  return {
    DB: db,
    SF_CREDENTIAL_ENCRYPTION_KEY: "unused-for-agent-status",
    SELF_OAUTH_NEW_PANEL_HMAC_KEY: HMAC_KEY,
    PANEL_JWT_SIGNER: {
      async signAssertion(_input: unknown) {
        return "test-assertion";
      },
    },
  } as unknown as AuthEnv;
}

test("start→poll-to-done progresses a retrieving job to a downloadable complete snapshot", async () => {
  const db = createSnapshotDb();
  const scope: TenantScope = { teamId: "team-snap", orgId: ORG, channelId: "chan-snap" };
  const calls = mockSalesforce({ checkRetrieve: ["pending", "done"] }, ORG, USER);
  const started = await startAgentSnapshot(db, scope, CONN, "TestAgent", "Bot");
  expect(started.status).toBe("retrieving");
  expect(started.retryAfterSeconds).toBe(2);
  const stillGoing = await advanceAgentSnapshot(db, scope, CONN, started.jobId);
  expect(stillGoing.status).toBe("retrieving");
  const done = await advanceAgentSnapshot(db, scope, CONN, started.jobId);
  expect(done.status).toBe("complete");
  expect(done.manifest.agentName).toBe("TestAgent");
  expect(done.manifest.files).toHaveLength(2);
  expect(calls.checkRetrieve).toBe(2);
  // A terminal job passes through untouched: no further Salesforce retrieve polls.
  const terminal = await advanceAgentSnapshot(db, scope, CONN, started.jobId);
  expect(terminal.status).toBe("complete");
  expect(calls.checkRetrieve).toBe(2);
  // The completed D1 snapshot downloads with integrity.
  const download = await downloadAgentSnapshot(db, scope, started.jobId);
  expect(download.status).toBe(200);
  expect(download.headers.get("Content-Type")).toBe("application/zip");
  const archive = unzipSync(new Uint8Array(await download.arrayBuffer()));
  expect(Object.keys(archive).sort()).toEqual([
    "aiAuthoringBundles/TestAgent_v1.bin",
    "bots/TestAgent.bot",
    "manifest.json",
  ]);
});

test("concurrent polls are lease-safe: one SOAP poll advances, no duplicate files", async () => {
  const db = createSnapshotDb();
  const scope: TenantScope = { teamId: "team-snap-race", orgId: ORG, channelId: "chan-snap-race" };
  const calls = mockSalesforce({ checkRetrieve: ["done"] }, ORG, USER);
  const started = await startAgentSnapshot(db, scope, CONN, "TestAgent", "Bot");
  const [a, b] = await Promise.all([
    advanceAgentSnapshot(db, scope, CONN, started.jobId),
    advanceAgentSnapshot(db, scope, CONN, started.jobId),
  ]);
  expect(calls.checkRetrieve).toBe(1);
  expect([a.status, b.status]).toContain("complete");
  const final = await agentSnapshotStatus(db, scope, started.jobId);
  expect(final.status).toBe("complete");
  expect(db.fileInserts).toBe(2);
});

test("POST /internal/agents/status advances a retrieving job inline (poll-to-advance)", async () => {
  const scope: TenantScope = { teamId: "team-snap-route", orgId: ORG, channelId: "chan-snap-route" };
  const db = createSnapshotDb({ channel: channelRow(scope) });
  const calls = mockSalesforce({ checkRetrieve: ["done"] }, ORG, USER);
  const started = await startAgentSnapshot(db, scope, CONN, "TestAgent", "Bot");
  expect(started.status).toBe("retrieving");
  const env = routeEnv(db);
  const first = await worker.fetch(
    await signedStatusRequest(STATUS_URL, HMAC_KEY, { ...scope, jobId: started.jobId }),
    env,
  );
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as any;
  expect(firstBody.status).toBe("complete");
  expect(firstBody.manifest.agentName).toBe("TestAgent");
  expect(calls.checkRetrieve).toBe(1);
  // A second poll hits the terminal job and issues no further Salesforce retrieve polls.
  const second = await worker.fetch(
    await signedStatusRequest(STATUS_URL, HMAC_KEY, { ...scope, jobId: started.jobId }),
    env,
  );
  expect(second.status).toBe(200);
  expect(((await second.json()) as any).status).toBe("complete");
  expect(calls.checkRetrieve).toBe(1);
});

test("inventory-absent namespaced references are excluded, never requested (coral EmployeeCopilot case)", async () => {
  const db = createSnapshotDb();
  const scope: TenantScope = { teamId: "team-snap-std", orgId: ORG, channelId: "chan-snap-std" };
  const PLUGIN_XML =
    `<GenAiPlugin><developerName>Customer_Service_Assistant</developerName>` +
    `<pluginFunctions><functionName>Check_Weather</functionName></pluginFunctions>` +
    `<pluginFunctions><functionName>EmployeeCopilot__QueryRecords</functionName></pluginFunctions></GenAiPlugin>`;
  const FUNCTION_XML =
    `<GenAiFunction><developerName>Check_Weather</developerName>` +
    `<invocationTarget>SomeFlow</invocationTarget><invocationTargetType>flow</invocationTargetType></GenAiFunction>`;
  const rounds = [
    {
      zip: Buffer.from(zipSync({
        "unpackaged/bots/TestAgent.bot": strToU8("<Bot><genAiPluginName>Customer_Service_Assistant</genAiPluginName></Bot>"),
        "unpackaged/aiAuthoringBundles/TestAgent_v1.bin": strToU8("plain payload"),
      })).toString("base64"),
      props: "<fileProperties><type>Bot</type><fullName>TestAgent</fullName></fileProperties>" +
        "<fileProperties><type>AiAuthoringBundle</type><fullName>TestAgent_v1</fullName></fileProperties>",
    },
    {
      zip: Buffer.from(zipSync({
        "unpackaged/genAiPlugins/Customer_Service_Assistant.genAiPlugin": strToU8(PLUGIN_XML),
      })).toString("base64"),
      props: "<fileProperties><type>GenAiPlugin</type><fullName>Customer_Service_Assistant</fullName></fileProperties>",
    },
    {
      zip: Buffer.from(zipSync({
        "unpackaged/genAiFunctions/Check_Weather/Check_Weather.genAiFunction-meta.xml": strToU8(FUNCTION_XML),
        "unpackaged/genAiFunctions/Check_Weather/input/schema.json": strToU8("{}"),
        "unpackaged/genAiFunctions/Check_Weather/output/schema.json": strToU8("{}"),
      })).toString("base64"),
      props: "<fileProperties><type>GenAiFunction</type><fullName>Check_Weather</fullName></fileProperties>",
    },
  ];
  const retrieveBodies: string[] = [];
  let round = 0;
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = new URL(String(input));
    if (url.pathname === "/services/data/") return Response.json([{ version: "59.0" }]);
    if (url.pathname.startsWith("/services/Soap/m/")) {
      const body = String(init?.body ?? "");
      const op =
        ["describeMetadata", "listMetadata", "retrieve", "checkRetrieveStatus"].find((o) =>
          body.includes(`<m:${o}>`),
        ) ?? "unknown";
      if (op === "describeMetadata") {
        return xmlResponse(soapResult("describeMetadata",
          "<result><metadataObjects><xmlName>Bot</xmlName></metadataObjects>" +
          "<metadataObjects><xmlName>AiAuthoringBundle</xmlName></metadataObjects>" +
          "<metadataObjects><xmlName>GenAiPlugin</xmlName></metadataObjects>" +
          "<metadataObjects><xmlName>GenAiFunction</xmlName></metadataObjects></result>"));
      }
      if (op === "listMetadata") {
        return xmlResponse(soapResult("listMetadata",
          "<result><fullName>TestAgent</fullName><type>Bot</type></result>" +
          "<result><fullName>TestAgent_v1</fullName><type>AiAuthoringBundle</type></result>" +
          "<result><fullName>Customer_Service_Assistant</fullName><type>GenAiPlugin</type></result>" +
          "<result><fullName>Check_Weather</fullName><type>GenAiFunction</type></result>"));
      }
      if (op === "retrieve") {
        retrieveBodies.push(body);
        return xmlResponse(RETRIEVE_XML);
      }
      if (op === "checkRetrieveStatus") {
        const current = rounds[Math.min(round++, rounds.length - 1)];
        return xmlResponse(soapResult("checkRetrieveStatus",
          `<result><done>true</done><success>true</success><zipFile>${current.zip}</zipFile>${current.props}</result>`));
      }
      return new Response("unknown SOAP operation", { status: 500 });
    }
    return Response.json([{ message: "not found" }], { status: 404 });
  }) as typeof fetch;
  const started = await startAgentSnapshot(db, scope, CONN, "TestAgent", "Bot");
  expect(started.status).toBe("retrieving");
  expect((await advanceAgentSnapshot(db, scope, CONN, started.jobId)).status).toBe("retrieving");
  expect((await advanceAgentSnapshot(db, scope, CONN, started.jobId)).status).toBe("retrieving");
  const done = await advanceAgentSnapshot(db, scope, CONN, started.jobId);
  expect(done.status).toBe("complete");
  expect(done.manifest.warnings).toEqual([]);
  expect(done.manifest.excludedStandardReferences).toEqual(["GenAiFunction:EmployeeCopilot__QueryRecords"]);
  expect(done.manifest.excludedFlowApexReferences).toEqual(["flow:SomeFlow"]);
  expect(done.manifest.components.map((c: any) => `${c.type}:${c.fullName}`)).not.toContain(
    "GenAiFunction:EmployeeCopilot__QueryRecords");
  expect(done.manifest.files).toHaveLength(6);
  // The unresolvable standard reference was never sent to Salesforce.
  expect(retrieveBodies.join("\n")).not.toContain("EmployeeCopilot");
  expect(retrieveBodies).toHaveLength(3);
});

test("status polls pass terminal and failed jobs through with zero Salesforce calls", async () => {
  const scope: TenantScope = { teamId: "team-snap-term", orgId: ORG, channelId: "chan-snap-term" };
  const db = createSnapshotDb({ channel: channelRow(scope) });
  const failedId = "aaaaaaaa-1111-2222-3333-444444444444";
  const completeId = "bbbbbbbb-1111-2222-3333-444444444444";
  const now = Date.now();
  db.seedJob({
    id: failedId, team_id: scope.teamId, org_id: scope.orgId, channel_id: scope.channelId,
    agent_name: "Dead", status: "failed", state_json: "{}",
    manifest_json: JSON.stringify({ error: "agent_metadata_retrieve_failed" }),
    created_at: now, updated_at: now, lease_until: 0,
  });
  db.seedJob({
    id: completeId, team_id: scope.teamId, org_id: scope.orgId, channel_id: scope.channelId,
    agent_name: "Done", status: "complete", state_json: "{}",
    manifest_json: JSON.stringify({ agentName: "Done", status: "complete", files: [] }),
    created_at: now, updated_at: now, lease_until: 0,
  });
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return Response.json({});
  }) as typeof fetch;
  const env = routeEnv(db);
  for (const [jobId, expected] of [
    [failedId, "failed"],
    [completeId, "complete"],
  ] as const) {
    const res = await worker.fetch(await signedStatusRequest(STATUS_URL, HMAC_KEY, { ...scope, jobId }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).status).toBe(expected);
  }
  expect(fetchCalls).toBe(0);
});

// F8: one chunk fetch per job, grouped in JS — integrity, ordering, and
// subrequest-count guarantees for both readers.
async function hexOf(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

function seedMultiChunkJob() {
  const id = "cccccccc-1111-2222-3333-444444444444";
  const now = Date.now();
  const payloads: Record<string, Uint8Array> = {
    "bots/B.bot": new TextEncoder().encode("b".repeat(100_000)),
    "a-meta.xml": new TextEncoder().encode("<root/>"),
    "empty.txt": new Uint8Array(0),
  };
  const fileList = async () => {
    const files: Array<{ path: string; sha256: string; byte_size: number }> = [];
    for (const [path, bytes] of Object.entries(payloads)) {
      files.push({ path, sha256: await hexOf(bytes), byte_size: bytes.length });
    }
    return files;
  };
  return { id, now, payloads, fileList };
}

test("F8: download reassembles multi-file multi-chunk snapshots with one chunk query", async () => {
  const db = createSnapshotDb();
  const scope: TenantScope = { teamId: "team-f8", orgId: ORG, channelId: "chan-f8" };
  const { id, now, payloads, fileList } = seedMultiChunkJob();
  const files = await fileList();
  db.seedJob({
    id, team_id: scope.teamId, org_id: scope.orgId, channel_id: scope.channelId,
    agent_name: "Chunky", status: "complete", state_json: JSON.stringify({ rounds: 1 }),
    manifest_json: JSON.stringify({ agentName: "Chunky", status: "complete", files }),
    created_at: now - 1000, updated_at: now - 1000, lease_until: 0,
  });
  for (const file of files) {
    db.seedFile({ team_id: scope.teamId, org_id: scope.orgId, channel_id: scope.channelId, job_id: id, ...file });
    const bytes = payloads[file.path];
    // Deliberately seed chunks out of order: SQL ordering must win.
    const parts: ArrayBuffer[] = [];
    for (let offset = 0; offset < bytes.length || (offset === 0 && bytes.length === 0); offset += 48_000) {
      parts.push(bytes.slice(offset, offset + 48_000).buffer as ArrayBuffer);
    }
    parts.forEach((_content, chunk_index) => db.seedChunk({
      team_id: scope.teamId, org_id: scope.orgId, channel_id: scope.channelId,
      job_id: id, path: file.path, chunk_index: parts.length - 1 - chunk_index,
      content: parts[parts.length - 1 - chunk_index],
    }));
  }
  const before = db.chunkSelects;
  const download = await downloadAgentSnapshot(db, scope, id);
  expect(download.status).toBe(200);
  expect(db.chunkSelects - before).toBe(1);
  const archive = unzipSync(new Uint8Array(await download.arrayBuffer()));
  expect(Object.keys(archive).sort()).toEqual(["a-meta.xml", "bots/B.bot", "empty.txt", "manifest.json"]);
  for (const [path, bytes] of Object.entries(payloads)) {
    expect(Buffer.from(archive[path])).toEqual(Buffer.from(bytes));
  }
});

test("F8: scope reader decodes content with one chunk query and still enforces integrity", async () => {
  const db = createSnapshotDb();
  const scope: TenantScope = { teamId: "team-f8b", orgId: ORG, channelId: "chan-f8b" };
  const { id, now, payloads, fileList } = seedMultiChunkJob();
  const files = await fileList();
  db.seedJob({
    id, team_id: scope.teamId, org_id: scope.orgId, channel_id: scope.channelId,
    agent_name: "Chunky", status: "complete", state_json: JSON.stringify({ rounds: 1 }),
    manifest_json: JSON.stringify({ agentName: "Chunky" }),
    created_at: now - 1000, updated_at: now - 1000, lease_until: 0,
  });
  for (const file of files) {
    db.seedFile({ team_id: scope.teamId, org_id: scope.orgId, channel_id: scope.channelId, job_id: id, ...file });
    const bytes = payloads[file.path];
    for (let offset = 0, chunk = 0; offset < bytes.length || (offset === 0 && bytes.length === 0); offset += 48_000, chunk++) {
      db.seedChunk({
        team_id: scope.teamId, org_id: scope.orgId, channel_id: scope.channelId,
        job_id: id, path: file.path, chunk_index: chunk,
        content: bytes.slice(offset, offset + 48_000).buffer as ArrayBuffer,
      });
    }
  }
  const before = db.chunkSelects;
  const snap = await readAgentSnapshotForScope(db, { teamId: scope.teamId, orgId: scope.orgId }, "Chunky");
  expect(db.chunkSelects - before).toBe(1);
  expect(snap.jobId).toBe(id);
  expect(snap.files.map((f) => f.path).sort()).toEqual(["a-meta.xml", "bots/B.bot", "empty.txt"]);
  expect(snap.files.find((f) => f.path === "a-meta.xml")!.content).toBe("<root/>");
  // Tamper one chunk within bounds: the grouped reader must fail exactly
  // like the old per-file loop (offset/sha integrity check).
  const lie = new TextEncoder().encode("<tampered>");
  db.seedFile({
    team_id: scope.teamId, org_id: scope.orgId, channel_id: scope.channelId, job_id: id,
    path: "z-lie.xml", sha256: await hexOf(new TextEncoder().encode("<root/>")), byte_size: lie.length,
  });
  db.seedChunk({
    team_id: scope.teamId, org_id: scope.orgId, channel_id: scope.channelId,
    job_id: id, path: "z-lie.xml", chunk_index: 0, content: lie.buffer as ArrayBuffer,
  });
  await expect(readAgentSnapshotForScope(db, { teamId: scope.teamId, orgId: scope.orgId }, "Chunky"))
    .rejects.toThrow("agent_snapshot_integrity_failed");
});

// F11: backoff hint, status-only plan, resumable-failure cooldown, convergence.
test("F11: retryAfterSeconds stays 2 early then backs off exponentially to the cap", async () => {
  const db = createSnapshotDb();
  const scope: TenantScope = { teamId: "team-f11", orgId: ORG, channelId: "chan-f11" };
  const now = Date.now();
  const expected = [2, 2, 2, 4, 8, 16, 32, 60, 60, 60];
  for (let rounds = 0; rounds < expected.length; rounds++) {
    const id = `dddddddd-1111-2222-3333-4444444444${rounds.toString().padStart(2, "0").slice(-2)}`.slice(0, 36);
    db.seedJob({
      id, team_id: scope.teamId, org_id: scope.orgId, channel_id: scope.channelId,
      agent_name: "Backoff", status: "retrieving", state_json: JSON.stringify({ rounds }),
      manifest_json: null, created_at: now - 60_000, updated_at: now - 60_000, lease_until: 0,
    });
    expect((await agentSnapshotStatus(db, scope, id)).retryAfterSeconds).toBe(expected[rounds]);
  }
});

test("F11: poll plan goes status-only while leased, fresh, or cooling — and only then", async () => {
  const db = createSnapshotDb();
  const scope: TenantScope = { teamId: "team-f11p", orgId: ORG, channelId: "chan-f11p" };
  const now = Date.now();
  const mk = (n: number, over: Partial<JobRow>) => {
    const id = `eeeeeeee-1111-2222-3333-4444444444${String(n).padStart(2, "0")}`.slice(0, 36);
    db.seedJob({
      id, team_id: scope.teamId, org_id: scope.orgId, channel_id: scope.channelId,
      agent_name: "Plan", status: "retrieving", state_json: JSON.stringify({ rounds: 0 }),
      manifest_json: null, created_at: now - 120_000, updated_at: now - 120_000, lease_until: 0, ...over,
    });
    return id;
  };
  // Baseline stale job advances.
  expect((await planAgentSnapshotPoll(db, scope, mk(1, {}))).advance).toBe(true);
  // Another poll holds the lease: status-only.
  expect((await planAgentSnapshotPoll(db, scope, mk(2, { lease_until: now + 60_000 }))).advance).toBe(false);
  // Lease expired long ago: advances again.
  expect((await planAgentSnapshotPoll(db, scope, mk(3, { lease_until: now - 1000 }))).advance).toBe(true);
  // Fresh completed round: status-only once, then advances.
  const fresh = mk(4, { state_json: JSON.stringify({ rounds: 2 }), updated_at: now });
  expect((await planAgentSnapshotPoll(db, scope, fresh)).advance).toBe(false);
  expect((await planAgentSnapshotPoll(db, scope, fresh, now + SNAPSHOT_POLL_FRESH_MS + 1)).advance).toBe(true);
  // Fresh timestamp with zero completed rounds (e.g. just started): advances.
  expect((await planAgentSnapshotPoll(db, scope, mk(5, { updated_at: now }))).advance).toBe(true);
  // Recent SF failure: status-only with a cooldown-sized hint, then advances.
  const cooled = mk(6, { state_json: JSON.stringify({ rounds: 0, lastSfFailureAt: now }) });
  const plan = await planAgentSnapshotPoll(db, scope, cooled);
  expect(plan.advance).toBe(false);
  expect(plan.status.retryAfterSeconds).toBe(Math.ceil(SNAPSHOT_SF_FAIL_COOLDOWN_MS / 1000));
  expect((await planAgentSnapshotPoll(db, scope, cooled, now + SNAPSHOT_SF_FAIL_COOLDOWN_MS + 1)).advance).toBe(true);
  // Terminal jobs still pass through.
  expect((await planAgentSnapshotPoll(db, scope, mk(7, { status: "complete", manifest_json: "{}" }))).advance).toBe(false);
});

test("F11: resumable SF failure arms the cooldown but the job stays resumable", async () => {
  const db = createSnapshotDb();
  const scope: TenantScope = { teamId: "team-f11r", orgId: ORG, channelId: "chan-f11r" };
  mockSalesforce({ checkRetrieve: ["done"] }, ORG, USER);
  const started = await startAgentSnapshot(db, scope, CONN, "TestAgent", "Bot");
  // Outage: the transport throws, advance rethrows, the job stays retrieving.
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await expect(advanceAgentSnapshot(db, scope, CONN, started.jobId)).rejects.toThrow("salesforce_metadata_unreachable");
  expect((await agentSnapshotStatus(db, scope, started.jobId)).status).toBe("retrieving");
  const plan = await planAgentSnapshotPoll(db, scope, started.jobId);
  expect(plan.advance).toBe(false);
  expect(plan.status.retryAfterSeconds).toBeGreaterThan(2);
  // Recovery: past the cooldown the same job converges to complete.
  mockSalesforce({ checkRetrieve: ["done"] }, ORG, USER);
  const done = await advanceAgentSnapshot(db, scope, CONN, started.jobId);
  expect(done.status).toBe("complete");
});

test("F11: status route serves a fresh retrieving job with zero Salesforce calls", async () => {
  const scope: TenantScope = { teamId: "team-f11s", orgId: ORG, channelId: "chan-f11s" };
  const db = createSnapshotDb({ channel: channelRow(scope) });
  const now = Date.now();
  const jobId = "ffffffff-1111-2222-3333-444444444444";
  db.seedJob({
    id: jobId, team_id: scope.teamId, org_id: scope.orgId, channel_id: scope.channelId,
    agent_name: "Fresh", status: "retrieving", state_json: JSON.stringify({ rounds: 1 }),
    manifest_json: null, created_at: now - 120_000, updated_at: now, lease_until: 0,
  });
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return Response.json({});
  }) as typeof fetch;
  const res = await worker.fetch(await signedStatusRequest(STATUS_URL, HMAC_KEY, { ...scope, jobId }), routeEnv(db));
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).status).toBe("retrieving");
  expect(fetchCalls).toBe(0);
});

test("POST /internal/agents/verify 409s without a registered metadata user (no channel fallback)", async () => {
  const scope: TenantScope = { teamId: "team-verify-norow", orgId: ORG, channelId: "chan-verify-norow" };
  // token() runs before the metadata-user guard: stub the JWT grant so the
  // test reaches the guard deterministically instead of hitting real network
  // (unstubbed, the result depends on DNS/proxy: 422/503, never the 409).
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname === "/services/oauth2/token") {
      return Response.json({ access_token: "test-access-token", instance_url: INSTANCE, expires_in: 120 });
    }
    if (url.pathname === "/services/oauth2/userinfo") {
      return Response.json({ organization_id: ORG, user_id: USER });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  }) as typeof fetch;
  const db = createSnapshotDb({ channel: channelRow(scope), metadataUser: null });
  const res = await worker.fetch(
    await signedStatusRequest("https://auth.test/internal/agents/verify", HMAC_KEY, { ...scope }),
    routeEnv(db),
  );
  expect(res.status).toBe(409);
  expect(((await res.json()) as any).error).toBe("agent_metadata_user_not_registered");
});

// Live sdolite1 shape (2026-11-05): describe@68 advertises AiAgent but
// listMetadata rejects it (INVALID_TYPE), poisoning the whole batch of 3
// and 502ing discovery. Discovery must skip the faulting type with a
// warning and keep the listable members.
test("discoverAgents skips describe-advertised but list-rejected types", async () => {
  const faultXml =
    '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>sf:INVALID_TYPE</faultcode><faultstring>INVALID_TYPE</faultstring></s:Fault></s:Body></s:Envelope>';
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = new URL(String(input));
    if (url.pathname === "/services/data/") return Response.json([{ version: "68.0" }, { version: "67.0" }]);
    const body = String(init?.body ?? "");
    const version = url.pathname.split("/").pop() ?? "";
    if (body.includes("<m:describeMetadata>")) {
      const names =
        version === "68.0"
          ? ["Bot", "AiAgent", "AiAgentDefinition", "AiAgentDefinitionVersion"]
          : ["Bot"];
      return xmlResponse(
        soapResult("describeMetadata", `<result>${names.map((n) => `<metadataObjects><xmlName>${n}</xmlName></metadataObjects>`).join("")}</result>`),
      );
    }
    if (body.includes("<m:listMetadata>")) {
      const types = [...body.matchAll(/<m:type>([^<]+)<\/m:type>/g)].map((m) => m[1]);
      if (types.includes("AiAgent"))
        return new Response(faultXml, { status: 500, headers: { "Content-Type": "text/xml" } });
      const items = types.includes("AiAgentDefinition")
        ? "<result><fullName>Coral_Cloud_Agent</fullName><type>AiAgentDefinition</type></result>"
        : "<result><fullName>LegacyBot</fullName><type>Bot</type></result>";
      return xmlResponse(soapResult("listMetadata", items));
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  }) as typeof fetch;
  const inv = await discoverAgents(CONN);
  expect(inv.members.some((m) => m.type === "AiAgentDefinition" && m.fullName === "Coral_Cloud_Agent")).toBe(true);
  expect(inv.members.some((m) => m.type === "Bot")).toBe(true);
  expect(inv.warnings.some((w) => w.includes("AiAgent"))).toBe(true);
  expect(inv.agents.some((a) => a.name === "Coral_Cloud_Agent")).toBe(true);
});

test("reconcileExtractionJobs drops retrieving jobs owned by a previous user, keeps the rest", async () => {
  const db = createSnapshotDb();
  const scope: TenantScope = { teamId: "team-recon", orgId: ORG, channelId: "chan-recon" };
  const OLD = "005" + "O".repeat(12);
  const stateFor = (user: string) => JSON.stringify({ executionUserId: user, inventory: null, requested: [], pending: [], queued: [], retrieveId: null, edges: [], warnings: [], excluded: [], excludedStandard: [], versions: [], rounds: 0 });
  db.seedJob({ id: "job-stale", team_id: scope.teamId, org_id: ORG, channel_id: scope.channelId, agent_name: "A", status: "retrieving", state_json: stateFor(OLD), manifest_json: null, created_at: 1, updated_at: 1, lease_until: 0 });
  db.seedJob({ id: "job-mine", team_id: scope.teamId, org_id: ORG, channel_id: scope.channelId, agent_name: "A", status: "retrieving", state_json: stateFor(USER), manifest_json: null, created_at: 1, updated_at: 1, lease_until: 0 });
  db.seedJob({ id: "job-done", team_id: scope.teamId, org_id: ORG, channel_id: scope.channelId, agent_name: "A", status: "complete", state_json: stateFor(OLD), manifest_json: "{}", created_at: 1, updated_at: 1, lease_until: 0 });
  db.seedFile({ team_id: scope.teamId, org_id: ORG, channel_id: scope.channelId, job_id: "job-stale", path: "bots/A.bot", sha256: "x", byte_size: 1 });
  db.seedChunk({ team_id: scope.teamId, org_id: ORG, channel_id: scope.channelId, job_id: "job-stale", path: "bots/A.bot", chunk_index: 0, content: new ArrayBuffer(0) });
  const dropped = await reconcileExtractionJobs(db as unknown as D1Database, scope, USER);
  expect(dropped).toBe(1);
  expect(db.jobs.has(`${scope.teamId}\0${ORG}\0${scope.channelId}\0job-stale`)).toBe(false);
  expect(db.jobs.has(`${scope.teamId}\0${ORG}\0${scope.channelId}\0job-mine`)).toBe(true);
  expect(db.jobs.has(`${scope.teamId}\0${ORG}\0${scope.channelId}\0job-done`)).toBe(true);
  const files = await (db as unknown as D1Database).prepare("SELECT path FROM sf_agent_snapshot_file WHERE team_id=? AND org_id=? AND channel_id=? AND job_id=?").bind(scope.teamId, ORG, scope.channelId, "job-stale").all();
  expect(files.results).toHaveLength(0);
  // Same-user reconnect reconciles nothing.
  expect(await reconcileExtractionJobs(db as unknown as D1Database, scope, USER)).toBe(0);
  expect(db.jobs.has(`${scope.teamId}\0${ORG}\0${scope.channelId}\0job-mine`)).toBe(true);
});
