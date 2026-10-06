import { afterEach, expect, test } from "bun:test";
import { TubotSfAuthEntrypoint } from "./index";

// Equivalence + batching tests for composite folding of POST invocable-action
// invocations (quotaburn Q2). Transport is fully stubbed: the mock records
// every Salesforce HTTP call, so each test asserts both identical verdicts
// and the exact round-trip count.

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const orgId = "00D000000000001AAA";
const userId = "005000000000001AAA";
const enc = new TextEncoder();
const keyBytes = new Uint8Array(32).fill(7);
const encryptionKey = btoa(String.fromCharCode(...keyBytes));
const hash = async (s: string) => btoa(String.fromCharCode(
  ...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function fixture() {
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, cryptoKey, enc.encode("salesforce-secret")));
  const row = {
    team_id: "team", org_id: orgId, channel_id: "channel",
    instance_url: "https://test.my.salesforce.com", client_id: "client",
    client_secret_cipher: btoa(String.fromCharCode(...cipher)),
    client_secret_iv: btoa(String.fromCharCode(...iv)),
    integration_user_id: userId, channel_secret_hash: await hash("a".repeat(48)),
  };
  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async run() { return { success: true }; },
            async first() {
              if (sql.includes("FROM salesforce_auth_credential")) return row;
              if (sql.includes("FROM salesforce_channel_connection")) {
                return { secret_hash: row.channel_secret_hash };
              }
              return null;
            },
          };
        },
      };
    },
  };
  return { DB: db, SF_CREDENTIAL_ENCRYPTION_KEY: encryptionKey, row };
}

type Canned = { status: number; body?: unknown; raw?: string };
type RouteHandler = (opts: { method: string; body?: string }) => Canned;
type Subrequest = { method: string; url: string; richInput?: unknown };

function mockTransport(routes: Record<string, Canned | RouteHandler>, opts?: {
  batchImpl?: "emulate" | "fail500" | "failGarbage";
}) {
  const directCalls: Array<{ path: string; method: string; body?: string }> = [];
  const batchCalls: Array<{ path: string; subrequests: Subrequest[] }> = [];
  const dispatch = (path: string, method: string, body?: string): Canned => {
    const route = routes[path];
    const canned = typeof route === "function" ? route({ method, body }) : route;
    if (!canned) return { status: 404, body: [{ message: "not found" }] };
    return canned;
  };
  const toResponse = (canned: Canned): Response =>
    canned.raw !== undefined
      ? new Response(canned.raw, { status: canned.status, headers: { "Content-Type": "application/json" } })
      : Response.json(canned.body ?? null, { status: canned.status });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/services/oauth2/token") return Response.json({ access_token: "secret-access-token" });
    if (url.pathname === "/services/oauth2/userinfo") {
      return Response.json({ organization_id: orgId, user_id: userId });
    }
    if (init?.method === "POST" && /\/composite\/batch$/.test(url.pathname)) {
      const parsed = JSON.parse(String(init.body)) as { batchRequests: Subrequest[] };
      batchCalls.push({ path: url.pathname, subrequests: parsed.batchRequests });
      if (opts?.batchImpl === "fail500") return new Response("batch exploded", { status: 500 });
      if (opts?.batchImpl === "failGarbage") return Response.json({ nope: true });
      const results = parsed.batchRequests.map((sub) => {
        const canned = dispatch("/services/data/" + sub.url.split("?")[0], sub.method,
          sub.richInput === undefined ? undefined : JSON.stringify(sub.richInput));
        return { statusCode: canned.status,
          result: canned.status === 204 ? null
            : canned.raw !== undefined ? JSON.parse(canned.raw) : (canned.body ?? null) };
      });
      return Response.json({ hasErrors: results.some((r) => r.statusCode >= 400), results });
    }
    directCalls.push({ path: url.pathname + url.search, method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined });
    return toResponse(dispatch(url.pathname + url.search in routes ? url.pathname + url.search : url.pathname,
      init?.method ?? "GET", typeof init?.body === "string" ? init.body : undefined));
  }) as typeof fetch;
  return { directCalls, batchCalls };
}

const ref = { teamId: "team", orgId, channelId: "channel" };
const action = (name: string, version = "v67.0") => `/services/data/${version}/actions/standard/${name}`;
const inputs = (args: Record<string, unknown>) => ({ inputs: [args] });

test("inspectSalesforce folds multiple POST action invocations into one composite call", async () => {
  const seenBodies: string[] = [];
  const transport = mockTransport({
    [action("createRecord")]: ({ method, body }) => {
      expect(method).toBe("POST");
      seenBodies.push(String(body));
      return { status: 200, body: [{ actionName: "createRecord", isSuccess: true }] };
    },
    [action("updateRecord")]: { status: 400,
      body: [{ actionName: "updateRecord", isSuccess: false, errors: [{ message: "Required fields are missing" }] }] },
    "/services/data/v67.0/actions/custom/flow/VerifyCode": { status: 200,
      body: [{ actionName: "VerifyCode", isSuccess: true, outputValues: { ok: true } }] },
  });
  const bodies = [inputs({ a: 1 }), inputs({ b: 2 }), inputs({ c: 3 })];
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const result = await entrypoint.inspectSalesforce(ref, [
    { method: "POST", path: action("createRecord"), jsonBody: bodies[0] },
    { method: "POST", path: action("updateRecord"), jsonBody: bodies[1] },
    { method: "POST", path: "/services/data/v67.0/actions/custom/flow/VerifyCode", jsonBody: bodies[2] },
  ]);
  expect(transport.batchCalls).toHaveLength(1);
  expect(transport.directCalls).toHaveLength(0);
  const sent = transport.batchCalls[0]!.subrequests;
  expect(sent.map((s) => s.method)).toEqual(["POST", "POST", "POST"]);
  expect(sent.map((s) => s.url)).toEqual([
    "v67.0/actions/standard/createRecord",
    "v67.0/actions/standard/updateRecord",
    "v67.0/actions/custom/flow/VerifyCode",
  ]);
  expect(sent.map((s) => s.richInput)).toEqual(bodies);
  // Per-subrequest verdicts map back to their slots, failures included.
  expect(result).toEqual([
    { status: 200, body: [{ actionName: "createRecord", isSuccess: true }] },
    { status: 400, body: [{ actionName: "updateRecord", isSuccess: false, errors: [{ message: "Required fields are missing" }] }] },
    { status: 200, body: [{ actionName: "VerifyCode", isSuccess: true, outputValues: { ok: true } }] },
  ]);
  expect(seenBodies).toEqual([JSON.stringify(bodies[0])]);
});

test("folded POST verdicts equal sequential single-POST verdicts with fewer round-trips", async () => {
  const routes: Record<string, Canned> = {
    [action("alpha")]: { status: 200, body: [{ actionName: "alpha", isSuccess: true }] },
    [action("beta")]: { status: 400, body: [{ actionName: "beta", isSuccess: false }] },
    [action("gamma")]: { status: 200, body: [{ actionName: "gamma", isSuccess: true }] },
  };
  const requests = (["alpha", "beta", "gamma"] as const).map((name) => ({
    method: "POST" as const, path: action(name), jsonBody: inputs({ name }),
  }));
  const folded = mockTransport(routes);
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const foldedResults = await entrypoint.inspectSalesforce(ref, requests);
  expect(folded.batchCalls).toHaveLength(1);
  expect(folded.directCalls).toHaveLength(0);
  const singled = mockTransport(routes);
  const singleResults: Array<{ status: number; body: unknown }> = [];
  for (const request of requests) singleResults.push(...(await entrypoint.inspectSalesforce(ref, [request])));
  expect(singled.batchCalls).toHaveLength(0);
  expect(singled.directCalls).toHaveLength(3);
  expect(foldedResults).toEqual(singleResults);
});

test("a single POST keeps the direct path with trailing-document evidence", async () => {
  const path = action("getRecord");
  const transport = mockTransport({
    [path]: { status: 200, raw: '[{"isSuccess":true}][{"isSuccess":true}]' },
  });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const result = await entrypoint.inspectSalesforce(ref, [{ method: "POST", path, jsonBody: inputs({}) }]);
  expect(transport.batchCalls).toHaveLength(0);
  expect(transport.directCalls).toHaveLength(1);
  expect(result).toEqual([{ status: 200, body: [{ isSuccess: true }],
    trailingDocuments: [[{ isSuccess: true }]] }]);
});

test("folded POSTs fall back to direct fetches when the batch envelope fails", async () => {
  const routes: Record<string, Canned> = {
    [action("createRecord")]: { status: 200, body: [{ actionName: "createRecord", isSuccess: true }] },
    [action("getRelatedList")]: { status: 200, body: [{ actionName: "getRelatedList", isSuccess: true }] },
  };
  for (const batchImpl of ["fail500", "failGarbage"] as const) {
    const transport = mockTransport(routes, { batchImpl });
    const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
    const result = await entrypoint.inspectSalesforce(ref, [
      { method: "POST", path: action("createRecord"), jsonBody: inputs({ x: 1 }) },
      { method: "POST", path: action("getRelatedList"), jsonBody: inputs({ y: 2 }) },
    ]);
    expect(transport.batchCalls).toHaveLength(1);
    expect(transport.directCalls.map((c) => c.path)).toEqual([action("createRecord"), action("getRelatedList")]);
    expect(result).toEqual([
      { status: 200, body: [{ actionName: "createRecord", isSuccess: true }] },
      { status: 200, body: [{ actionName: "getRelatedList", isSuccess: true }] },
    ]);
  }
});

test("POST folds split by API version and skip pre-35 action routes", async () => {
  const transport = mockTransport({
    [action("createRecord", "v67.0")]: { status: 200, body: [{ ok: "v67" }] },
    [action("createRecord", "v66.0")]: { status: 200, body: [{ ok: "v66" }] },
    [action("legacy", "v34.0")]: { status: 200, body: [{ ok: "v34" }] },
    [action("legacyTwo", "v34.0")]: { status: 200, body: [{ ok: "v34b" }] },
  });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const v67a = action("createRecord", "v67.0");
  const v66a = action("createRecord", "v66.0");
  const v34a = action("legacy", "v34.0");
  const v34b = action("legacyTwo", "v34.0");
  // Two versions with two POSTs each would need 4 requests; use GET pairs to
  // keep the shape small: version grouping is shared across methods.
  const result = await entrypoint.inspectSalesforce(ref, [
    { method: "POST", path: v67a, jsonBody: inputs({}) },
    { method: "GET", path: v67a },
    { method: "POST", path: v66a, jsonBody: inputs({}) },
    { method: "GET", path: v66a },
    { method: "POST", path: v34a, jsonBody: inputs({}) },
    { method: "POST", path: v34b, jsonBody: inputs({}) },
  ]);
  expect(transport.batchCalls.map((c) => c.path).sort()).toEqual([
    "/services/data/v66.0/composite/batch",
    "/services/data/v67.0/composite/batch",
  ]);
  // Pre-35 action POSTs stay direct even as a pair (batch Actions need v35+).
  expect(transport.directCalls.map((c) => c.path).sort()).toEqual([v34a, v34b].sort());
  expect(result.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
});

test("bodiless POSTs, einstein generations, HEAD, and tooling GETs stay direct", async () => {
  const bodiless = action("createRecord");
  const generation = "/services/data/v67.0/einstein/prompt-templates/Summary/generations";
  const headPath = action("getRecord");
  const tooling = "/services/data/v67.0/tooling/query?q=SELECT%20Id%20FROM%20ApexClass%20LIMIT%201";
  const transport = mockTransport({
    [bodiless]: ({ body }) => {
      expect(body).toBe("{");
      return { status: 400, body: [{ message: "bad" }] };
    },
    [generation]: { status: 200, body: { generations: [] } },
    [headPath]: { status: 200, body: { ignored: true } },
    [tooling]: { status: 200, body: { records: [] } },
  });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const result = await entrypoint.inspectSalesforce(ref, [
    { method: "POST", path: bodiless },
    { method: "POST", path: generation,
      jsonBody: { isPreview: false, inputParams: { valueMap: { "Input:Record": { value: "x" } } } } },
    { method: "HEAD", path: headPath },
    { method: "GET", path: tooling },
  ]);
  expect(transport.batchCalls).toHaveLength(0);
  expect(transport.directCalls).toHaveLength(4);
  expect(result[0]).toEqual({ status: 400, body: [{ message: "bad" }] });
  expect(result[1]).toEqual({ status: 200, body: { generations: [] } });
  expect(result[2]).toEqual({ status: 200, body: null });
  expect(result[3]).toEqual({ status: 200, body: { records: [] } });
});

test("mixed GET and POST share one composite call in request order", async () => {
  const describe = "/services/data/v67.0/sobjects/Account/describe";
  const invoke = action("createRecord");
  const transport = mockTransport({
    [describe]: { status: 200, body: { name: "Account" } },
    [invoke]: { status: 200, body: [{ actionName: "createRecord", isSuccess: true }] },
  });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const result = await entrypoint.inspectSalesforce(ref, [
    { method: "GET", path: describe },
    { method: "POST", path: invoke, jsonBody: inputs({ z: 9 }) },
  ]);
  expect(transport.batchCalls).toHaveLength(1);
  expect(transport.directCalls).toHaveLength(0);
  expect(transport.batchCalls[0]!.subrequests).toEqual([
    { method: "GET", url: "v67.0/sobjects/Account/describe" },
    { method: "POST", url: "v67.0/actions/standard/createRecord", richInput: inputs({ z: 9 }) },
  ]);
  expect(result).toEqual([
    { status: 200, body: { name: "Account" } },
    { status: 200, body: [{ actionName: "createRecord", isSuccess: true }] },
  ]);
});

test("a full probe batch of ten POSTs costs one Salesforce round-trip", async () => {
  const names = Array.from({ length: 10 }, (_, i) => `probe${i}`);
  const routes: Record<string, Canned> = {};
  for (const name of names) routes[action(name)] = { status: 200, body: [{ actionName: name, isSuccess: true }] };
  const transport = mockTransport(routes);
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const result = await entrypoint.inspectSalesforce(ref,
    names.map((name) => ({ method: "POST" as const, path: action(name), jsonBody: inputs({ name }) })));
  expect(transport.batchCalls).toHaveLength(1);
  expect(transport.batchCalls[0]!.subrequests).toHaveLength(10);
  expect(transport.directCalls).toHaveLength(0);
  expect(result).toHaveLength(10);
  expect(result.map((r, i) => (r.body as Array<{ actionName: string }>)[0]!.actionName))
    .toEqual(names);
});
