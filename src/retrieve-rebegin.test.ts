// Dud-async-id recovery: INVALID_LOCATOR means the persisted retrieve id is
// unknown server-side (job never queued). Resume is futile; every resume
// site must discard the id and begin fresh (bounded), instead of 502ing
// every poll until the state expires. Proven live (howto-2 2026-11-18):
// dud ids failed all of 05's verify polls + wedged extraction jobs.
// Run: bun test tubot-sf-auth/src/retrieve-rebegin.test.ts
import { afterEach, expect, test } from "bun:test";
import { isUnknownRetrieveId, retrieveMembers } from "./soap-retrieve";
import { SecurityError } from "./request-security";
import { advanceAgentSnapshot, verifyAgentAccess } from "./agent-snapshot";
import type { TenantScope } from "./request-security";

const ORG = "00D" + "O".repeat(12);
const USER = "005" + "U".repeat(12);
const INSTANCE = "https://test.my.salesforce.com";
const CONN = { instanceUrl: INSTANCE, accessToken: "test-access-token", integrationUserId: USER };
const SCOPE: TenantScope = { teamId: "team", orgId: ORG, channelId: "0Mj" + "C".repeat(12) };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const soapResult = (operation: string, inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Envelope><Body><${operation}Response>${inner}</${operation}Response></Body></Envelope>`;
const FAULT_XML =
  `<?xml version="1.0" encoding="UTF-8"?><Envelope><Body><Fault><faultcode>sf:INVALID_LOCATOR</faultcode><faultstring>INVALID_LOCATOR: invalid async id</faultstring></Fault></Body></Envelope>`;
const xmlResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/xml" } });

// Scripted SOAP endpoint: retrieve mints sequential ids, checkRetrieveStatus
// plays a script ("dud" = INVALID_LOCATOR fault, "pending" = not done).
function mockSoap(script: { checks: Array<"dud" | "pending"> }) {
  const calls = { begins: [] as string[], polls: 0 };
  let n = 0;
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const body = String((init as any)?.body ?? "");
    if (body.includes("<m:retrieve>")) {
      n++;
      const id = `ASYNC-NEW-${n}`;
      calls.begins.push(id);
      return xmlResponse(soapResult("retrieve", `<result><id>${id}</id></result>`));
    }
    if (body.includes("<m:checkRetrieveStatus>")) {
      calls.polls++;
      const next = script.checks.length ? script.checks.shift()! : "pending";
      if (next === "dud") return xmlResponse(FAULT_XML, 500);
      return xmlResponse(soapResult("checkRetrieveStatus", "<result><done>false</done></result>"));
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return calls;
}

test("isUnknownRetrieveId matches only INVALID_LOCATOR faults", () => {
  expect(isUnknownRetrieveId(new SecurityError(502, "salesforce_metadata_request_failed:checkRetrieveStatus:sf:INVALID_LOCATOR"))).toBe(true);
  expect(isUnknownRetrieveId(new SecurityError(502, "salesforce_metadata_request_failed:checkRetrieveStatus:sf:UNKNOWN_EXCEPTION"))).toBe(false);
  expect(isUnknownRetrieveId(new SecurityError(403, "agent_metadata_access_required:Foo"))).toBe(false);
  expect(isUnknownRetrieveId(new Error("INVALID_LOCATOR"))).toBe(false);
});

test("retrieveMembers re-begins on a dud resume id", async () => {
  const calls = mockSoap({ checks: ["dud", "pending"] });
  const out = await retrieveMembers(CONN, "68.0", [{ type: "Bot", fullName: "B" }],
    { resumeAsyncId: "ASYNC-DUD", pollIntervalMs: 1, maxPollAttempts: 2 });
  expect(out.status).toBe("pending");
  if (out.status !== "pending") throw new Error("unreachable");
  expect(out.asyncId).toBe("ASYNC-NEW-1");
  expect(calls.begins).toEqual(["ASYNC-NEW-1"]);
  expect(calls.polls).toBe(2);
});

test("retrieveMembers fails honestly after bounded rebegins", async () => {
  mockSoap({ checks: ["dud", "dud", "dud", "dud", "dud", "dud"] });
  const err = await retrieveMembers(CONN, "68.0", [{ type: "Bot", fullName: "B" }],
    { resumeAsyncId: "ASYNC-DUD", pollIntervalMs: 1, maxPollAttempts: 6 }).then(
    () => null, (e) => e as SecurityError);
  expect(err).toBeInstanceOf(SecurityError);
  expect(String((err as SecurityError).code)).toContain("INVALID_LOCATOR");
});

// Minimal fake D1 for advance: one retrieving job + lease-gated updates.
const JOB_ID = "11111111-2222-4333-8444-555555555555";

function advanceDb(jobState: Record<string, unknown>) {
  const job: Record<string, unknown> = {
    id: JOB_ID, team_id: SCOPE.teamId, org_id: SCOPE.orgId, channel_id: SCOPE.channelId,
    agent_name: "B", status: "retrieving", state_json: JSON.stringify(jobState),
    manifest_json: null, created_at: Date.now(), updated_at: Date.now(), lease_until: 0,
  };
  return {
    job,
    prepare(sql: string) {
      const q = sql.replace(/\s+/g, " ");
      let args: any[] = [];
      const stmt: any = {
        bind(...v: any[]) { args = v; return stmt; },
        async first() {
          if (q.includes("FROM sf_agent_snapshot_job")) return { ...job };
          return null;
        },
        async run() {
          if (q.includes("SET lease_until=? WHERE") && q.includes("lease_until<?")) {
            if (job["status"] === "retrieving" && (job["lease_until"] as number) < args[5]) {
              job["lease_until"] = args[0];
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (q.includes("SET state_json=?,updated_at=?")) {
            if (job["lease_until"] === args[6]) {
              job["state_json"] = args[0];
              job["updated_at"] = args[1];
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (q.includes("SET lease_until=0")) {
            if (job["lease_until"] === args[4]) job["lease_until"] = 0;
            return { success: true, meta: { changes: 1 } };
          }
          if (q.includes("SET status='failed'")) {
            job["status"] = "failed";
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database & { job: Record<string, unknown> };
}

const TEST_STATE = () => ({
  executionUserId: USER,
  inventory: { apiVersion: "68.0", members: [{ type: "Bot", fullName: "B", apiVersion: "68.0" }] },
  requested: [{ type: "Bot", fullName: "B", apiVersion: "68.0" }],
  pending: [{ type: "Bot", fullName: "B", apiVersion: "68.0" }],
  queued: [], retrieveId: "ASYNC-DUD", edges: [], warnings: [], excluded: [],
  excludedStandard: [], versions: [], rounds: 0,
});

test("advance re-begins a dud job id and persists the new one", async () => {
  mockSoap({ checks: ["dud"] });
  const db = advanceDb(TEST_STATE());
  const res = await advanceAgentSnapshot(db, SCOPE, CONN, JOB_ID) as { status: string };
  expect(res.status).toBe("retrieving");
  const saved = JSON.parse(db.job["state_json"] as string);
  expect(saved.retrieveId).toBe("ASYNC-NEW-1");
  expect(saved.rebegins).toBe(1);
});

test("advance throws honestly once the rebegin budget is spent", async () => {
  mockSoap({ checks: ["dud"] });
  const db = advanceDb({ ...TEST_STATE(), rebegins: 3 });
  const err = await advanceAgentSnapshot(db, SCOPE, CONN, JOB_ID).then(
    () => null, (e) => e as SecurityError);
  expect(err).toBeInstanceOf(SecurityError);
  expect(String((err as SecurityError).code)).toContain("INVALID_LOCATOR");
  const saved = JSON.parse(db.job["state_json"] as string);
  expect(saved.retrieveId).toBe("ASYNC-DUD");
});

// Minimal fake D1 for verify: one metadata-user row with mutable JSON.
function verifyDb(verificationJson: string | null) {
  const row: Record<string, unknown> = {
    integration_user_id: USER, verification_json: verificationJson,
  };
  return {
    row,
    prepare(sql: string) {
      const q = sql.replace(/\s+/g, " ");
      let args: any[] = [];
      const stmt: any = {
        bind(...v: any[]) { args = v; return stmt; },
        async first() {
          if (q.includes("FROM sf_agent_metadata_user")) return { ...row };
          return null;
        },
        async run() {
          if (q.includes("UPDATE sf_agent_metadata_user SET verification_json=?")) {
            row["verification_json"] = args[0];
            return { success: true, meta: { changes: 1 } };
          }
          if (q.includes("UPDATE sf_agent_metadata_user SET verification_json=NULL")) {
            row["verification_json"] = null;
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database & { row: Record<string, unknown> };
}

// Full-stack stub for verify's begin path: versions, describe/list,
// PermissionSet describe, retrieve, scripted checkRetrieveStatus.
function mockVerify(checks: Array<"dud" | "pending">) {
  const calls = { begins: [] as string[] };
  let n = 0;
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = new URL(String(input));
    if (url.pathname === "/services/data/") return Response.json([{ version: "68.0" }]);
    if (url.pathname.includes("/sobjects/PermissionSet/describe")) {
      return Response.json({ fields: [{ name: "PermissionsModifyMetadata" }] });
    }
    const body = String((init as any)?.body ?? "");
    if (body.includes("<m:describeMetadata>")) {
      return xmlResponse(soapResult("describeMetadata",
        "<result><metadataObjects><xmlName>Bot</xmlName></metadataObjects></result>"));
    }
    if (body.includes("<m:listMetadata>")) {
      return xmlResponse(soapResult("listMetadata",
        "<result><fullName>TestAgent</fullName><type>Bot</type></result>"));
    }
    if (body.includes("<m:retrieve>")) {
      n++;
      const id = `ASYNC-V-${n}`;
      calls.begins.push(id);
      return xmlResponse(soapResult("retrieve", `<result><id>${id}</id></result>`));
    }
    if (body.includes("<m:checkRetrieveStatus>")) {
      const next = checks.length ? checks.shift()! : "pending";
      if (next === "dud") return xmlResponse(FAULT_XML, 500);
      return xmlResponse(soapResult("checkRetrieveStatus", "<result><done>false</done></result>"));
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return calls;
}

const DUD_STATE = (rebegins?: number) => JSON.stringify({
  retrieveId: "ASYNC-DUD", version: "68.0", startedAt: Date.now(),
  userId: USER, promptReady: false, rootKey: "Bot:TestAgent",
  ...(rebegins === undefined ? {} : { rebegins }),
});

test("verify discards a dud id and begins fresh", async () => {
  const calls = mockVerify(["dud"]);
  const db = verifyDb(DUD_STATE());
  const res = await verifyAgentAccess(db, SCOPE, CONN) as { ready: boolean; pending?: boolean };
  expect(res.ready).toBe(false);
  expect(res.pending).toBe(true);
  expect(calls.begins).toEqual(["ASYNC-V-1"]);
  const saved = JSON.parse(db.row["verification_json"] as string);
  expect(saved.retrieveId).toBe("ASYNC-V-1");
  expect(saved.rebegins).toBe(1);
});

test("verify fails honestly once the rebegin budget is spent", async () => {
  mockVerify(["dud"]);
  const db = verifyDb(DUD_STATE(3));
  const err = await verifyAgentAccess(db, SCOPE, CONN).then(
    () => null, (e) => e as SecurityError);
  expect(err).toBeInstanceOf(SecurityError);
  expect(String((err as SecurityError).code)).toContain("INVALID_LOCATOR");
  expect(db.row["verification_json"]).toBeNull();
});
