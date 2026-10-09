import { afterEach, expect, test } from "bun:test";
import worker, { TubotSfAuthEntrypoint } from "./index";

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

const secret = "a".repeat(48);
const orgId = "00D000000000001AAA";
const userId = "005000000000001AAA";
const enc = new TextEncoder();
const keyBytes = new Uint8Array(32).fill(7);
const encryptionKey = btoa(String.fromCharCode(...keyBytes));
const hash = async (s: string) => btoa(String.fromCharCode(
  ...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function fixture(active = true) {
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, cryptoKey, enc.encode("salesforce-secret")));
  const row = {
    team_id: "team", org_id: orgId, channel_id: "channel",
    instance_url: "https://test.my.salesforce.com", client_id: "client",
    client_secret_cipher: btoa(String.fromCharCode(...cipher)),
    client_secret_iv: btoa(String.fromCharCode(...iv)),
    integration_user_id: userId, channel_secret_hash: await hash(secret),
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
                return active ? { secret_hash: row.channel_secret_hash } : null;
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

function request(path: string, payload: Record<string, unknown>, requestId?: string) {
  return new Request("https://private.invalid" + path, {
    method: "POST", headers: {
      "Content-Type": "application/json",
      ...(requestId ? { "X-Request-Id": requestId } : {}),
    },
    body: JSON.stringify({ teamId: "team", orgId, channelId: "channel", channelSecret: secret, ...payload }),
  });
}

const internalHmacKey = "k".repeat(48);

async function signedRequest(path: string, payload: Record<string, unknown>, method = "POST") {
  const bodyText = JSON.stringify({ teamId: "team", orgId, channelId: "channel", channelSecret: secret, ...payload });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
  const nonce = btoa(String.fromCharCode(...nonceBytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const digest = await hash(bodyText);
  const canonical = `${timestamp}\n${nonce}\n${path}\n${digest}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(internalHmacKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(canonical)))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return new Request("https://private.invalid" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-tubot-sf-auth-timestamp": timestamp,
      "x-tubot-sf-auth-nonce": nonce,
      "x-tubot-sf-auth-signature": signature,
    },
    body: bodyText,
  });
}

function toolRequest(path: string, target: Record<string, unknown>, args?: Record<string, unknown>) {
  return request(path, { target, ...(args === undefined ? {} : { arguments: args }) });
}

function mockSalesforce(routes: Record<string, unknown | ((init: RequestInit | undefined, url: URL) => Response)>) {
  const seen: Array<{ url: URL; method: string; body?: string; authorization?: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/services/oauth2/token") return Response.json({ access_token: "secret-access-token" });
    if (url.pathname === "/services/oauth2/userinfo") {
      return Response.json({ organization_id: orgId, user_id: userId });
    }
    seen.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      authorization: new Headers(init?.headers).get("Authorization") ?? undefined,
    });
    const route = routes[url.pathname];
    if (typeof route === "function") return route(init, url);
    if (route === undefined && /\/composite\/batch$/.test(url.pathname) && init?.method === 'POST') {
      const results = [];
      for (const item of JSON.parse(String(init.body)).batchRequests) {
        const response = await globalThis.fetch(new URL('/services/data/' + item.url, url.origin), { method: item.method, ...(item.richInput === undefined ? {} : { body: JSON.stringify(item.richInput) }) });
        results.push({ statusCode: response.status, result: response.status === 204 ? null : await response.json() });
      }
      return Response.json({ results });
    }
    if (route === undefined) return Response.json([{ message: "not found" }], { status: 404 });
    return Response.json(route);
  }) as typeof fetch;
  return seen;
}

async function expectStructuredError(response: Response, expected: {
  status: number;
  error: string;
  retryable: boolean;
}) {
  expect(response.status).toBe(expected.status);
  const body = await response.json() as {
    error: string; message: string; retryable: boolean; requestId: string;
  };
  expect(body).toMatchObject({
    error: expected.error,
    retryable: expected.retryable,
  });
  expect(body.message.length).toBeGreaterThan(0);
  expect(body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(response.headers.get("X-Request-Id")).toBe(body.requestId);
  return body;
}

test("denies wrong channel secret and expired or revoked Panel grant", async () => {
  const env = await fixture();
  const wrong = await worker.fetch(request("/internal/channels/query", {
    channelSecret: "b".repeat(48), soql: "SELECT Id FROM Account",
  }), env as never);
  expect(wrong.status).toBe(403);
  const revoked = await worker.fetch(request("/internal/channels/query", {
    soql: "SELECT Id FROM Account",
  }), await fixture(false) as never);
  expect(revoked.status).toBe(403);
});

test("only Salesforce read API calls are forwarded", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("/services/oauth2/token")) {
      expect(init?.method).toBe("POST");
      return Response.json({ access_token: "token" });
    }
    if (url.endsWith("/services/oauth2/userinfo")) {
      return Response.json({ organization_id: orgId, user_id: userId });
    }
    expect(init?.headers).toEqual({ Authorization: "Bearer token", Accept: "application/json" });
    return Response.json({ records: [{ Id: "001000000000000AAA" }] });
  }) as typeof fetch;
  const env = await fixture();
  const write = await worker.fetch(request("/internal/channels/query", {
    soql: "DELETE FROM Account",
  }), env as never);
  expect(write.status).toBe(400);
  expect(seen).toHaveLength(0);
  const read = await worker.fetch(request("/internal/channels/query", {
    soql: "SELECT Id FROM Account",
  }), env as never);
  expect(read.status).toBe(200);
  expect(read.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/i);
  expect(await read.json()).toEqual({ records: [{ Id: "001000000000000AAA" }] });
  expect(seen[2]).toContain("/services/data/v65.0/query?q=SELECT%20Id%20FROM%20Account");
});

test("scoped action inspection forwards a schema-derived JSON POST body", async () => {
  const actionPath = "/services/data/v67.0/actions/custom/apex/tubot__CheckWeather";
  const args = { dateToCheck: "2026-10-01" };
  const seen = mockSalesforce({
    [actionPath]: (init) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ inputs: [args] });
      return Response.json([{ actionName: "tubot__CheckWeather", isSuccess: true }]);
    },
  });
  const env = await fixture();
  const entrypoint = new TubotSfAuthEntrypoint(null, env);
  const result = await entrypoint.inspectSalesforce(
    { teamId: "team", orgId, channelId: "channel" },
    [{ method: "POST", path: actionPath, jsonBody: { inputs: [args] } }],
  );

  expect(result).toEqual([{ status: 200, body: [{ actionName: "tubot__CheckWeather", isSuccess: true }] }]);
  expect(seen.at(-1)?.authorization).toBe("Bearer secret-access-token");
});

test("scoped action inspection keeps the leading envelope and preserves trailing error documents", async () => {
  // Live Salesforce appends a serialization-error document after a complete
  // action envelope (observed on tubot__ListExperienceTypes). The complete
  // leading envelope is the outcome; the trailing error is preserved as
  // evidence and never upgrades a rejection. A corrupt leading document is
  // still rejected (see salesforce-response-json tests).
  const actionPath = "/services/data/v67.0/actions/custom/apex/tubot__ListExperienceTypes";
  const seen = mockSalesforce({
    [actionPath]: () => new Response(
      '[{"actionName":"tubot__ListExperienceTypes","isSuccess":true,"outputValues":{"experienceTypes":[]}}]' +
      '[{"message":"Type cannot be serialized","errorCode":"JSON_PARSER_ERROR"}]',
      { headers: { "Content-Type": "application/json" } },
    ),
  });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const result = await entrypoint.inspectSalesforce(
    { teamId: "team", orgId, channelId: "channel" },
    [{ method: "POST", path: actionPath, jsonBody: { inputs: [{}] } }],
  );

  expect(result).toEqual([{
    status: 200,
    body: [{ actionName: "tubot__ListExperienceTypes", isSuccess: true, outputValues: { experienceTypes: [] } }],
    trailingDocuments: [[{ message: "Type cannot be serialized", errorCode: "JSON_PARSER_ERROR" }]],
  }]);
  expect(seen).toHaveLength(1);
});

test("scoped action inspection keeps the first of concatenated success-only JSON documents", async () => {
  // Two complete identical success envelopes: the first is the outcome.
  const actionPath = '/services/data/v67.0/actions/standard/getRecord';
  mockSalesforce({ [actionPath]: () => new Response('[{"isSuccess":true}][{"isSuccess":true}]',
    { headers: { 'Content-Type': 'application/json' } }) });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const result = await entrypoint.inspectSalesforce({ teamId: 'team', orgId, channelId: 'channel' },
    [{ method: 'POST', path: actionPath, jsonBody: { inputs: [{}] } }]);
  expect(result).toEqual([{ status: 200, body: [{ isSuccess: true }],
    trailingDocuments: [[{ isSuccess: true }]] }]);
});

test("oversized Salesforce inspection results are isolated to their request", async () => {
  const oversizedPath = "/services/data/v67.0/actions/standard/getRecord";
  const nextPath = "/services/data/v67.0/actions/standard/getRelatedList";
  const seen = mockSalesforce({
    [oversizedPath]: () => new Response("x".repeat(1_800_001)),
    [nextPath]: { name: "getRelatedList", inputs: [] },
  });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());

  const result = await entrypoint.inspectSalesforce(
    { teamId: "team", orgId, channelId: "channel" },
    [{ method: "GET", path: oversizedPath }, { method: "GET", path: nextPath }],
  );

  expect(result).toHaveLength(2);
  expect(result[0]).toEqual({
    status: 502,
    body: {
      errorCode: "RESPONSE_TOO_LARGE",
      message: `Salesforce inspection response exceeds the size limit for GET ${oversizedPath}.`,
    },
  });
  expect(result[1]).toEqual({ status: 200, body: { name: "getRelatedList", inputs: [] } });
  // The oversized member fails the batch envelope, so both items fall back direct.
  expect(seen.filter((s) => s.url.pathname === "/services/data/v67.0/composite/batch")).toHaveLength(1);
  expect(seen.some((s) => s.url.pathname === oversizedPath && s.method === "GET")).toBe(true);
  expect(seen.some((s) => s.url.pathname === nextPath && s.method === "GET")).toBe(true);
});

test("scoped inspection allows only Salesforce sObject catalog and describe GETs", async () => {
  const catalogPath = "/services/data/v67.0/sobjects/";
  const describePath = "/services/data/v67.0/sobjects/Account/describe";
  const relatedListPath = "/services/data/v67.0/ui-api/related-list-info/Account";
  const seen = mockSalesforce({
    [catalogPath]: { sobjects: [{ name: "Account", queryable: true }] },
    [describePath]: { name: "Account", fields: [] },
    [relatedListPath]: { relatedLists: { Contacts: { relatedListId: "Contacts" } } },
  });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const result = await entrypoint.inspectSalesforce(
    { teamId: "team", orgId, channelId: "channel" },
    [{ method: "GET", path: catalogPath }, { method: "GET", path: describePath },
      { method: "GET", path: relatedListPath }],
  );
  expect(result.map(item => item.status)).toEqual([200, 200, 200]);
  expect(seen.map(item => item.url.pathname)).toEqual(["/services/data/v67.0/composite/batch", catalogPath, describePath, relatedListPath]);

  await expect(entrypoint.inspectSalesforce(
    { teamId: "team", orgId, channelId: "channel" },
    [{ method: "POST", path: relatedListPath }],
  )).rejects.toThrow("invalid_api_path");
});

test("scoped inspection permits bounded EntityDefinition discovery queries", async () => {
  const kav = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName LIKE '%__kav' LIMIT 10");
  const inl = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT QualifiedApiName, KeyPrefix, Label FROM EntityDefinition WHERE QualifiedApiName IN ('Contact','Account')");
  const stem = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName LIKE '%conversation%' LIMIT 50");
  const seen = mockSalesforce({
    ["/services/data/v67.0/query"]: ((_init: unknown, url: URL) => {
      const q = url.searchParams.get("q") ?? "";
      return Response.json(q.includes("LIKE")
        ? { records: [{ QualifiedApiName: "Knowledge__kav" }] }
        : { records: [{ QualifiedApiName: "Contact", KeyPrefix: "003", Label: "Contact" }] });
    }) as never,
  });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const result = await entrypoint.inspectSalesforce(
    { teamId: "team", orgId, channelId: "channel" },
    [{ method: "GET", path: kav }, { method: "GET", path: inl }, { method: "GET", path: stem }],
  );
  expect(result.map(item => item.status)).toEqual([200, 200, 200]);
  expect(seen.filter((s) => s.url.pathname === "/services/data/v67.0/composite/batch")).toHaveLength(1);
  expect(seen).toHaveLength(4);
  const evil = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName LIKE '%__kav' LIMIT 10; DELETE FROM Account");
  const evilStem = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName LIKE '%x%' OR 1=1 LIMIT 50");
  await expect(entrypoint.inspectSalesforce(
    { teamId: "team", orgId, channelId: "channel" },
    [{ method: "GET", path: evil }],
  )).rejects.toThrow("invalid_api_path");
  await expect(entrypoint.inspectSalesforce(
    { teamId: "team", orgId, channelId: "channel" },
    [{ method: "GET", path: evilStem }],
  )).rejects.toThrow("invalid_api_path");
});

test("scoped inspection permits Organization timezone and NamedCredential discovery reads", async () => {
  const tz = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT TimeZoneSidKey FROM Organization LIMIT 1");
  const nc = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT DeveloperName, Endpoint FROM NamedCredential LIMIT 50");
  mockSalesforce({
    ["/services/data/v67.0/query"]: ((_init: unknown, url: URL) => {
      const q = url.searchParams.get("q") ?? "";
      return Response.json(q.includes("TimeZoneSidKey")
        ? { records: [{ TimeZoneSidKey: "America/Los_Angeles" }] }
        : { records: [{ DeveloperName: "PardotProd", Endpoint: "https://pi.pardot.com/api" }] });
    }) as never,
  });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const ref = { teamId: "team", orgId, channelId: "channel" };
  const result = await entrypoint.inspectSalesforce(ref,
    [{ method: "GET", path: tz }, { method: "GET", path: nc }]);
  expect(result.map(item => item.status)).toEqual([200, 200]);
  const over = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT DeveloperName, Endpoint FROM NamedCredential LIMIT 51");
  const wide = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT Id, TimeZoneSidKey FROM Organization LIMIT 1");
  await expect(entrypoint.inspectSalesforce(ref,
    [{ method: "GET", path: over }])).rejects.toThrow("invalid_api_path");
  await expect(entrypoint.inspectSalesforce(ref,
    [{ method: "GET", path: wide }])).rejects.toThrow("invalid_api_path");
  await expect(entrypoint.inspectSalesforce(ref,
    [{ method: "POST", path: tz }])).rejects.toThrow("invalid_api_path");
});

test("scoped inspection permits swarm candidate and open-swarm exclusion reads", async () => {
  const candidates = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT Id FROM Account LIMIT 8");
  const active = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT RelatedRecordId FROM Swarm WHERE Status != 'Closed' LIMIT 200");
  mockSalesforce({
    ["/services/data/v67.0/query"]: ((_init: unknown, url: URL) => {
      const q = url.searchParams.get("q") ?? "";
      return Response.json(q.includes("RelatedRecordId")
        ? { records: [{ RelatedRecordId: "001xx0000000001AAA" }] }
        : { records: [{ Id: "001xx0000000002AAA" }] });
    }) as never,
  });
  const orgId = "00D" + "0".repeat(12);
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const ref = { teamId: "team", orgId, channelId: "channel" };
  const result = await entrypoint.inspectSalesforce(ref,
    [{ method: "GET", path: candidates }, { method: "GET", path: active }]);
  expect(result.map(item => item.status)).toEqual([200, 200]);
  const wide = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT Id FROM Account LIMIT 9");
  const otherObject = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT RelatedRecordId FROM Case WHERE Status != 'Closed' LIMIT 200");
  const otherFilter = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT RelatedRecordId FROM Swarm LIMIT 200");
  for (const path of [wide, otherObject, otherFilter]) {
    await expect(entrypoint.inspectSalesforce(ref,
      [{ method: "GET", path }])).rejects.toThrow("invalid_api_path");
  }
});

test("scoped inspection permits operator conversation resolution reads", async () => {
  const convo = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT Id FROM Conversation WHERE ConversationIdentifier = '34702549-48b7-4069-bfb0-220ef3997664' LIMIT 1");
  const session = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT Id, SessionKey FROM MessagingSession WHERE ConversationId = '0dwg5000000xMcPAAU' LIMIT 1");
  mockSalesforce({
    ["/services/data/v67.0/query"]: ((_init: unknown, url: URL) => {
      const q = url.searchParams.get("q") ?? "";
      return Response.json(q.includes("ConversationIdentifier")
        ? { records: [{ Id: "0dwg5000000xMcPAAU" }] }
        : { records: [{ Id: "0Mwg50000028FDdCAM", SessionKey: "k" }] });
    }) as never,
  });
  const orgId = "00D" + "0".repeat(12);
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const ref = { teamId: "team", orgId, channelId: "channel" };
  const result = await entrypoint.inspectSalesforce(ref,
    [{ method: "GET", path: convo }, { method: "GET", path: session }]);
  expect(result.map(item => item.status)).toEqual([200, 200]);
  const noLimit = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT Id FROM Conversation WHERE ConversationIdentifier = '34702549-48b7-4069-bfb0-220ef3997664'");
  const injected = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT Id FROM Conversation WHERE ConversationIdentifier = 'x' OR Name LIKE '%25' LIMIT 1");
  const otherField = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT Id, Body FROM MessagingSession WHERE ConversationId = '0dwg5000000xMcPAAU' LIMIT 1");
  for (const path of [noLimit, injected, otherField]) {
    await expect(entrypoint.inspectSalesforce(ref,
      [{ method: "GET", path }])).rejects.toThrow("invalid_api_path");
  }
});

test("scoped inspection permits exact read-only Quick Action definitions", async () => {
  const path="/services/data/v67.0/sobjects/Case/quickActions/NewChildCase/describe";
  mockSalesforce({[path]:{type:"Create",targetParentField:"ParentId"}});
  const entrypoint=new TubotSfAuthEntrypoint(null,await fixture()),ref={teamId:"team",orgId,channelId:"channel"};
  expect((await entrypoint.inspectSalesforce(ref,[{method:"GET",path}]))[0].status).toBe(200);
  await expect(entrypoint.inspectSalesforce(ref,[{method:"POST",path}])).rejects.toThrow("invalid_api_path");
  await expect(entrypoint.inspectSalesforce(ref,[{method:"GET",path:path.replace("/describe","/defaultValues/500000000000001")}])).rejects.toThrow("invalid_api_path");
});

test('scoped inspection permits only read-only CustomField type discovery', async () => {
  const path = '/services/data/v67.0/tooling/sobjects/CustomField/describe';
  mockSalesforce({ [path]: { name: 'CustomField', fields: [] } });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const ref = { teamId: 'team', orgId, channelId: 'channel' };
  expect((await entrypoint.inspectSalesforce(ref, [{ method: 'GET', path }]))[0].status).toBe(200);
  await expect(entrypoint.inspectSalesforce(ref, [{ method: 'POST', path }])).rejects.toThrow('invalid_api_path');
  await expect(entrypoint.inspectSalesforce(ref, [{ method: 'GET', path: '/services/data/v67.0/tooling/sobjects/CustomField/00N000000000001AAA' }])).rejects.toThrow('invalid_api_path');
});

test('scoped inspection permits only the read-only retriever catalog', async () => {
  const path = '/services/data/v67.0/ssot/machine-learning/retrievers';
  mockSalesforce({ [path]: { retrievers: [{ name: 'File_X', activeConfiguration: { isActive: true } }] } });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const ref = { teamId: 'team', orgId, channelId: 'channel' };
  expect((await entrypoint.inspectSalesforce(ref, [{ method: 'GET', path }]))[0].status).toBe(200);
  await expect(entrypoint.inspectSalesforce(ref, [{ method: 'POST', path }])).rejects.toThrow('invalid_api_path');
  await expect(entrypoint.inspectSalesforce(ref, [{ method: 'GET', path: '/services/data/v67.0/ssot/machine-learning/retrievers/123' }])).rejects.toThrow('invalid_api_path');
});

test('scoped inspection permits only the read-only call-identity route', async () => {
  const path = '/services/data/v67.0/chatter/users/me';
  mockSalesforce({ [path]: { id: '005000000000001AAA' } });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const ref = { teamId: 'team', orgId, channelId: 'channel' };
  expect((await entrypoint.inspectSalesforce(ref, [{ method: 'GET', path }]))[0].status).toBe(200);
  await expect(entrypoint.inspectSalesforce(ref, [{ method: 'POST', path }])).rejects.toThrow('invalid_api_path');
  await expect(entrypoint.inspectSalesforce(ref, [{ method: 'GET', path: '/services/data/v67.0/chatter/users/005000000000001AAA' }])).rejects.toThrow('invalid_api_path');
});

test("scoped action inspection allows the read-only REST API version root", async () => {
  const versions = [{ version: "67.0", url: "/services/data/v67.0" }];
  const seen = mockSalesforce({ "/services/data/": versions });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const ref = { teamId: "team", orgId, channelId: "channel" };

  const result = await entrypoint.inspectSalesforce(ref, [{ method: "GET", path: "/services/data/" }]);

  expect(result).toEqual([{ status: 200, body: versions }]);
  expect(seen.at(-1)?.url.pathname).toBe("/services/data/");
  let rejected = false;
  try {
    await entrypoint.inspectSalesforce(ref, [{ method: "POST", path: "/services/data/" }]);
  } catch { rejected = true; }
  expect(rejected).toBe(true);
  expect(seen).toHaveLength(1);
});

test("scoped Skill inspection permits one metadata record and rejects broader queries", async () => {
  mockSalesforce({ "/services/data/v67.0/query": { records: [] } });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const ref = { teamId: "team", orgId, channelId: "channel" };
  const result = await entrypoint.inspectSalesforce(ref, [{ method: "GET", path: `/services/data/v67.0/query?q=${encodeURIComponent("SELECT Id, DeveloperName, MasterLabel FROM Skill LIMIT 1")}` }]);
  expect(result[0].status).toBe(200);
  for (const query of ["SELECT Id, DeveloperName, MasterLabel FROM Skill LIMIT 2", "SELECT Id, DeveloperName, MasterLabel, CreatedById FROM Skill LIMIT 1", "SELECT Id, DeveloperName, MasterLabel FROM User LIMIT 1"])
    await expect(entrypoint.inspectSalesforce(ref, [{ method: "GET", path: `/services/data/v67.0/query?q=${encodeURIComponent(query)}` }])).rejects.toThrow();
});
test("scoped inspection permits FlowDefinitionView and ACTIVE-status samples, rejects broader shapes", async () => {
  mockSalesforce({ "/services/data/v67.0/query": { records: [] } });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const ref = { teamId: "team", orgId, channelId: "channel" };
  for (const query of ["SELECT DurableId,ApiName,Label FROM FlowDefinitionView WHERE ApiName IN ('segmentation__validateSegmentMember')",
    "SELECT DurableId,ApiName,Label FROM FlowDefinitionView WHERE ApiName IN ('a__b','b')",
    "SELECT Id FROM MarketSegment WHERE SegmentStatus='ACTIVE' LIMIT 5",
    "SELECT Id FROM MarketSegment WHERE SegmentStatus='ACTIVE' LIMIT 1"]) {
    const result = await entrypoint.inspectSalesforce(ref, [{ method: "GET",
      path: `/services/data/v67.0/query?q=${encodeURIComponent(query)}` }]);
    expect(result[0].status).toBe(200);
  }
  for (const query of ["SELECT DurableId,ApiName,Label FROM FlowDefinitionView WHERE ApiName IN ('a','b','c')",
    "SELECT DurableId,ApiName,Label FROM FlowDefinitionView",
    "SELECT Id FROM MarketSegment WHERE SegmentStatus='ACTIVE' LIMIT 6",
    "SELECT Id FROM MarketSegment WHERE SegmentStatus='INACTIVE' LIMIT 1",
    "SELECT Id,Name FROM MarketSegment WHERE SegmentStatus='ACTIVE' LIMIT 1"])
    await expect(entrypoint.inspectSalesforce(ref, [{ method: "GET",
      path: `/services/data/v67.0/query?q=${encodeURIComponent(query)}` }])).rejects.toThrow();
});
test("scoped action inspection permits only read-only single-record sample queries", async () => {
  const seen = mockSalesforce({
    "/services/data/v67.0/query": { records: [{ Id: "500000000000001AAA" }] },
  });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const ref = { teamId: "team", orgId, channelId: "channel" };
  const result = await entrypoint.inspectSalesforce(ref, [{
    method: "GET",
    path: "/services/data/v67.0/query?q=SELECT%20Id%20FROM%20Case%20LIMIT%201",
  }, {
    method: "GET",
    path: "/services/data/v67.0/query?q=SELECT%20Id%20FROM%20MessagingSession%20WHERE%20ConversationId%20!%3D%20null%20LIMIT%201",
  }, {
    method: "GET",
    path: "/services/data/v67.0/query?q=SELECT%20Id%20FROM%20MessagingSession%20WHERE%20ConversationId%20!%3D%20null%20AND%20Status%20%3D%20'Ended'%20LIMIT%201",
  }, {
    method: "GET",
    path: "/services/data/v67.0/query?q=SELECT%20Id%20FROM%20ContentDocument%20WHERE%20FileType%20IN%20('AMR','AU','FLAC','M4A','MP3','MP4','MPEG','MPGA','OGG','OGA','WAV','WAVE','WEBM')%20LIMIT%201",
  }, {
    method: "GET",
    path: "/services/data/v67.0/query?q=SELECT%20Id%2C%20Subject%20FROM%20Case%20LIMIT%203",
  }, {
    method: "GET",
    path: "/services/data/v67.0/query?q=SELECT%20Id%2C%20Quantity%20FROM%20OrderItemSummary%20WHERE%20OrderSummaryId%20%3D%20'0qW000000000001AAA'%20LIMIT%205",
  }, {
    method: "GET",
    path: "/services/data/v67.0/query?q=SELECT%20Reason%20FROM%20OrderItemSummaryChangeReason%20LIMIT%205",
  }]);
  expect(result).toEqual([
    { status: 200, body: { records: [{ Id: "500000000000001AAA" }] } },
    { status: 200, body: { records: [{ Id: "500000000000001AAA" }] } },
    { status: 200, body: { records: [{ Id: "500000000000001AAA" }] } },
    { status: 200, body: { records: [{ Id: "500000000000001AAA" }] } },
    { status: 200, body: { records: [{ Id: "500000000000001AAA" }] } },
    { status: 200, body: { records: [{ Id: "500000000000001AAA" }] } },
    { status: 200, body: { records: [{ Id: "500000000000001AAA" }] } },
  ]);

  let rejected = false;
  try {
    await entrypoint.inspectSalesforce(ref, [{
      method: "GET",
      path: "/services/data/v67.0/query?q=SELECT%20Name%20FROM%20Contact%20LIMIT%201",
    }]);
  } catch { rejected = true; }
  expect(rejected).toBe(true);
  rejected = false;
  try {
    await entrypoint.inspectSalesforce(ref, [{
      method: "GET",
      path: "/services/data/v67.0/query?q=SELECT%20Id%20FROM%20MessagingSession%20WHERE%20ConversationId%20!%3D%20null%20OR%20Id%20!%3D%20null%20LIMIT%201",
    }]);
  } catch { rejected = true; }
  expect(rejected).toBe(true);
  expect(seen.filter((s) => s.url.pathname === "/services/data/v67.0/composite/batch")).toHaveLength(1);
  expect(seen).toHaveLength(8);
});

test("registration returns safe diagnostics for rejected ECA credentials", async () => {
  let writes = 0;
  const logs: string[] = [];
  console.error = ((...args: unknown[]) => { logs.push(args.join(" ")); }) as typeof console.error;
  const fixtureEnv = await fixture();
  fixtureEnv.DB.prepare = ((sql: string) => ({
    bind: (..._args: unknown[]) => ({
      first: async () => null,
      run: async () => {
        if (!sql.includes("internal_nonce")) writes++;
        return { success: true, meta: { changes: 1 } };
      },
    }),
  })) as typeof fixtureEnv.DB.prepare;
  const exposedSecret = "do-not-return-this-error-description";
  globalThis.fetch = (async () => Response.json({
    error: "invalid_client", error_description: exposedSecret,
  }, { status: 401 })) as typeof fetch;

  const response = await worker.fetch(await signedRequest("/internal/channels/register", {
    instanceUrl: "https://test.my.salesforce.com",
    clientId: "new-client", clientSecret: "new-client-secret", integrationUserId: userId,
  }), { ...fixtureEnv, SELF_OAUTH_INTERNAL_HMAC_KEY: internalHmacKey } as never);

  const body = await expectStructuredError(response, {
    status: 422,
    error: "salesforce_invalid_client_credentials",
    retryable: false,
  });
  expect(body.message).toContain("consumer key or secret");
  expect(JSON.stringify(body)).not.toContain(exposedSecret);
  expect(JSON.stringify(body)).not.toContain("new-client-secret");
  expect(logs.join("\n")).not.toContain(exposedSecret);
  expect(logs.join("\n")).not.toContain("new-client-secret");
  expect(writes).toBe(0);
});

test("registration rejects a valid token issued for another org with safe diagnostics", async () => {
  let writes = 0;
  const logs: string[] = [];
  console.error = ((...args: unknown[]) => { logs.push(args.join(" ")); }) as typeof console.error;
  const fixtureEnv = await fixture();
  fixtureEnv.DB.prepare = ((sql: string) => ({
    bind: (..._args: unknown[]) => ({
      first: async () => null,
      run: async () => {
        if (!sql.includes("internal_nonce")) writes++;
        return { success: true, meta: { changes: 1 } };
      },
    }),
  })) as typeof fixtureEnv.DB.prepare;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/services/oauth2/token")) return Response.json({ access_token: "token" });
    return Response.json({ organization_id: "00D000000000999AAA", user_id: userId });
  }) as typeof fetch;
  const response = await worker.fetch(await signedRequest("/internal/channels/register", {
    instanceUrl: "https://test.my.salesforce.com",
    clientId: "new-client", clientSecret: "new-secret", integrationUserId: userId,
  }), { ...fixtureEnv, SELF_OAUTH_INTERNAL_HMAC_KEY: internalHmacKey } as never);
  const body = await expectStructuredError(response, {
    status: 422,
    error: "salesforce_identity_mismatch",
    retryable: false,
  });
  expect(body.message).toContain("different Salesforce org or Run As user");
  expect(JSON.stringify(body)).not.toContain("00D000000000999AAA");
  expect(logs.join("\n")).not.toContain("00D000000000999AAA");
  expect(writes).toBe(0);
});

test("JWT registration stores no secret and verifies via mint", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const seenBinds: unknown[][] = [];
  let postedGrant = "";
  const fixtureEnv = await fixture();
  fixtureEnv.DB.prepare = ((sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async () => null,
      run: async () => {
        if (sql.includes("INSERT INTO salesforce_auth_credential")) seenBinds.push(args);
        return { success: true, meta: { changes: 1 } };
      },
    }),
  })) as typeof fixtureEnv.DB.prepare;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/services/oauth2/token")) {
      postedGrant = String(new URLSearchParams(String(init?.body)).get("grant_type"));
      return Response.json({ access_token: "jwt-token", instance_url: "https://test.my.salesforce.com" });
    }
    return Response.json({ organization_id: orgId, user_id: userId });
  }) as typeof fetch;
  const response = await worker.fetch(await signedRequest("/internal/channels/register", {
    instanceUrl: "https://test.my.salesforce.com",
    integrationUserId: userId, integrationUsername: "integration@example.com", isSandbox: true,
  }), { ...fixtureEnv, SELF_OAUTH_INTERNAL_HMAC_KEY: internalHmacKey, TUBOT_JWT_PRIVATE_KEY: privatePem } as never);
  expect(response.status).toBe(201);
  expect(postedGrant).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
  expect(seenBinds.length).toBe(1);
  // Bind order: team, org, channel, instance, clientId, cipher, iv, userId, username, sandbox, hash, created, updated.
  expect(seenBinds[0][4]).toBe("3MVG97L7PWbPq6UwRxF9421lWKCBakiXaBrDfwFXOfEtvWSbrve3xGWTV18Ae_4tEtY92su8zyYWo9Fq3aczM");
  expect(seenBinds[0][5]).toBeNull();
  expect(seenBinds[0][6]).toBeNull();
  expect(seenBinds[0][8]).toBe("integration@example.com");
  expect(seenBinds[0][9]).toBe(1);
});

test("JWT registration rejects missing username or environment", async () => {
  let writes = 0;
  let fetches = 0;
  const fixtureEnv = await fixture();
  fixtureEnv.DB.prepare = ((sql: string) => ({
    bind: (..._args: unknown[]) => ({
      first: async () => null,
      run: async () => {
        if (!sql.includes("internal_nonce")) writes++;
        return { success: true, meta: { changes: 1 } };
      },
    }),
  })) as typeof fixtureEnv.DB.prepare;
  globalThis.fetch = (async () => {
    fetches++;
    return Response.json({ access_token: "token" });
  }) as typeof fetch;
  const response = await worker.fetch(await signedRequest("/internal/channels/register", {
    instanceUrl: "https://test.my.salesforce.com",
    integrationUserId: userId,
  }), { ...fixtureEnv, SELF_OAUTH_INTERNAL_HMAC_KEY: internalHmacKey } as never);
  await expectStructuredError(response, { status: 400, error: "invalid_connection", retryable: false });
  expect(writes).toBe(0);
  expect(fetches).toBe(0);
});

test("channel registration requires an internal service signature", async () => {
  const fixtureEnv = await fixture();
  const response = await worker.fetch(request("/internal/channels/register", {
    instanceUrl: "https://test.my.salesforce.com",
    clientId: "new-client", clientSecret: "new-secret", integrationUserId: userId,
  }), { ...fixtureEnv, SELF_OAUTH_INTERNAL_HMAC_KEY: internalHmacKey } as never);
  await expectStructuredError(response, {
    status: 401,
    error: "invalid_internal_signature",
    retryable: false,
  });
});

test("channel deletion requires an internal service signature", async () => {
  const fixtureEnv = await fixture();
  const unsigned = new Request("https://private.invalid/internal/channels", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teamId: "team", orgId, channelId: "channel" }),
  });
  const response = await worker.fetch(unsigned, { ...fixtureEnv, SELF_OAUTH_INTERNAL_HMAC_KEY: internalHmacKey } as never);
  await expectStructuredError(response, {
    status: 401,
    error: "invalid_internal_signature",
    retryable: false,
  });
});

test("generic internal failures return a request ID and log no exception detail", async () => {
  const logs: string[] = [];
  console.error = ((...args: unknown[]) => { logs.push(args.join(" ")); }) as typeof console.error;
  const env = await fixture();
  env.DB.prepare = (() => { throw new Error("database connection detail must stay private"); }) as typeof env.DB.prepare;
  const requestId = "123e4567-e89b-42d3-a456-426614174000";

  const response = await worker.fetch(request("/internal/channels/query", {
    soql: "SELECT Id FROM Account",
  }, requestId), env as never);

  const body = await expectStructuredError(response, {
    status: 500,
    error: "internal_error",
    retryable: true,
  });
  expect(body.requestId).toBe(requestId);
  expect(JSON.stringify(body)).not.toContain("database connection detail");
  expect(logs).toHaveLength(1);
  expect(logs.join("\n")).not.toContain("SELECT Id FROM Account");
  expect(logs[0]).toBe(JSON.stringify({ requestId, error: "internal_error", status: 500 }));
});

test("rotating credentials for the same channel does not reuse its cached token", async () => {
  const env = await fixture();
  const issued: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/services/oauth2/token")) {
      const clientId = new URLSearchParams(init?.body as string).get("client_id")!;
      issued.push(clientId);
      return Response.json({ access_token: "token-for-" + clientId });
    }
    if (url.endsWith("/services/oauth2/userinfo")) {
      return Response.json({ organization_id: orgId, user_id: userId });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  const path = "/internal/channels/query";
  const payload = { soql: "SELECT Id FROM Account" };
  expect((await worker.fetch(request(path, payload), env as never)).status).toBe(200);
  env.row.client_id = "rotated-client";
  expect((await worker.fetch(request(path, payload), env as never)).status).toBe(200);
  expect(issued).toEqual(["client", "rotated-client"]);
});

test("describes a listed flow using the live version, catalog route, and descriptor schema", async () => {
  const flowName = "SvcCopilotTmpl__AddCaseComment";
  const seen = mockSalesforce({
    "/services/data/": [
      { version: "66.0", url: "/services/data/v66.0" },
      { version: "67.0", url: "/services/data/v67.0" },
    ],
    "/services/data/v67.0/actions/custom": { flow: "/services/data/v67.0/actions/custom/flow" },
    "/services/data/v67.0/actions/custom/flow": {
      actions: [{ name: flowName, url: `/services/data/v67.0/actions/custom/flow/${flowName}` }],
    },
    [`/services/data/v67.0/actions/custom/flow/${flowName}`]: {
      name: flowName,
      inputs: [{ name: "caseRecord", type: "SOBJECT", sObjectType: "Case", required: true, defaultValue: "private" }],
      outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST", label: "Flow Interview Status" }],
    },
  });

  const response = await worker.fetch(toolRequest("/internal/channels/tools/describe", {
    type: "flow", name: flowName,
  }), await fixture() as never);

  expect(response.status).toBe(200);
  const descriptor = await response.json();
  expect(descriptor).toEqual({
    available: true,
    route: `/services/data/v67.0/actions/custom/flow/${flowName}`,
    inputs: [{ name: "caseRecord", type: "SOBJECT", sObjectType: "Case", required: true }],
    outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST", label: "Flow Interview Status" }],
  });
  expect(seen.map(item => item.url.pathname)).toEqual([
    "/services/data/",
    "/services/data/v67.0/actions/custom",
    "/services/data/v67.0/actions/custom/flow",
    `/services/data/v67.0/actions/custom/flow/${flowName}`,
  ]);
  expect(seen.every(item => item.authorization === "Bearer secret-access-token")).toBe(true);
  expect(JSON.stringify(descriptor)).not.toContain("secret-access-token");
});

test("resolves an unqualified Apex target to its unique namespaced Salesforce action", async () => {
  const catalogName = "tubot__CheckWeather";
  const actionRoute = `/services/data/v67.0/actions/custom/apex/${catalogName}`;
  const seen = mockSalesforce({
    "/services/data/": [{ version: "67.0", url: "/services/data/v67.0" }],
    "/services/data/v67.0/actions/custom": { apex: "/services/data/v67.0/actions/custom/apex" },
    "/services/data/v67.0/actions/custom/apex": {
      actions: [{ name: catalogName, url: actionRoute }],
    },
    [actionRoute]: (init) => init?.method === "POST"
      ? Response.json([{ actionName: catalogName, isSuccess: true }])
      : Response.json({
          name: catalogName,
          inputs: [{ name: "dateToCheck", type: "DATE", required: true }],
          outputs: [{ name: "temperatureDescription", type: "STRING" }],
        }),
  });
  const env = await fixture();
  const target = { type: "apex", name: "CheckWeather" };

  const describe = await worker.fetch(toolRequest("/internal/channels/tools/describe", target), env as never);
  expect(await describe.json()).toEqual({
    available: true,
    route: actionRoute,
    inputs: [{ name: "dateToCheck", type: "DATE", required: true }],
    outputs: [{ name: "temperatureDescription", type: "STRING" }],
  });

  const dateToCheck = "2026-09-25";
  const invoke = await worker.fetch(toolRequest("/internal/channels/tools/invoke", target, { dateToCheck }), env as never);
  expect(invoke.status).toBe(200);
  expect(await invoke.json()).toEqual([{ actionName: catalogName, isSuccess: true }]);
  expect(seen.filter(item => item.url.pathname === actionRoute).map(item => item.method)).toEqual(["GET", "GET", "POST"]);
  expect(JSON.parse(seen.at(-1)!.body!)).toEqual({ inputs: [{ dateToCheck }] });
});

test("does not describe or invoke an action missing from Salesforce's live catalog", async () => {
  const seen = mockSalesforce({
    "/services/data/": [{ version: "67.0", url: "/services/data/v67.0" }],
    "/services/data/v67.0/actions/custom": { apex: "/services/data/v67.0/actions/custom/apex" },
    "/services/data/v67.0/actions/custom/apex": { actions: [] },
  });
  const env = await fixture();

  const describe = await worker.fetch(toolRequest("/internal/channels/tools/describe", {
    type: "apex", name: "MissingAction",
  }), env as never);
  const invoke = await worker.fetch(toolRequest("/internal/channels/tools/invoke", {
    type: "apex", name: "MissingAction",
  }, { value: "unused" }), env as never);

  expect(await describe.json()).toMatchObject({ available: false, diagnostic: { code: "action_not_found" } });
  expect(invoke.status).toBe(404);
  expect(await invoke.json()).toMatchObject({ available: false, diagnostic: { code: "action_not_found" } });
  expect(seen.some(item => item.method === "POST")).toBe(false);
  expect(seen.some(item => item.url.pathname.endsWith("/MissingAction"))).toBe(false);
});

test("invokes standard invocable actions with the Salesforce inputs wrapper", async () => {
  const actionName = "archiveKnowledgeArticles";
  const seen = mockSalesforce({
    "/services/data/": [{ version: "67.0", url: "/services/data/v67.0" }],
    "/services/data/v67.0/actions/standard": {
      actions: [{ name: actionName, url: `/services/data/v67.0/actions/standard/${actionName}` }],
    },
    [`/services/data/v67.0/actions/standard/${actionName}`]: (init) => init?.method === "POST"
      ? Response.json({ actionName, isSuccess: true })
      : Response.json({ name: actionName, inputs: [{ name: "articleVersionIdList", type: "STRING" }], outputs: [] }),
  });
  const body = { articleVersionIdList: "ka0000000000001" };
  const response = await worker.fetch(toolRequest("/internal/channels/tools/invoke", {
    type: "standardInvocableAction", name: actionName,
  }, body), await fixture() as never);

  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toEqual({ actionName, isSuccess: true });
  const invocation = seen.at(-1)!;
  expect(invocation.method).toBe("POST");
  expect(invocation.url.pathname).toBe(`/services/data/v67.0/actions/standard/${actionName}`);
  expect(JSON.parse(invocation.body!)).toEqual({ inputs: [body] });
  expect(JSON.stringify(result)).not.toContain("secret-access-token");
});

test("preserves Salesforce action response status, body, and headers", async () => {
  const actionName = "nativeResponseAction";
  const actionPath = `/services/data/v67.0/actions/custom/apex/${actionName}`;
  const nativeBody = '[{"actionName":"nativeResponseAction","isSuccess":false,"errors":["native error"]}]';
  const seen = mockSalesforce({
    "/services/data/": [{ version: "67.0", url: "/services/data/v67.0" }],
    "/services/data/v67.0/actions/custom": { apex: "/services/data/v67.0/actions/custom/apex" },
    "/services/data/v67.0/actions/custom/apex": {
      actions: [{ name: actionName, url: actionPath }],
    },
    [actionPath]: (init) => init?.method === "POST"
      ? new Response(nativeBody, {
          status: 207,
          statusText: "Multi-Status",
          headers: {
            "Content-Type": "application/vnd.salesforce.action+json",
            "Cache-Control": "private, max-age=17",
            "X-Salesforce-Request-Id": "sf-request-123",
          },
        })
      : Response.json({ name: actionName, inputs: [], outputs: [] }),
  });

  const response = await worker.fetch(toolRequest("/internal/channels/tools/invoke", {
    type: "apex", name: actionName,
  }, { input: "value" }), await fixture() as never);

  expect(response.status).toBe(207);
  expect(response.statusText).toBe("Multi-Status");
  expect(await response.text()).toBe(nativeBody);
  expect(response.headers.get("Content-Type")).toBe("application/vnd.salesforce.action+json");
  expect(response.headers.get("Cache-Control")).toBe("private, max-age=17");
  expect(response.headers.get("X-Salesforce-Request-Id")).toBe("sf-request-123");
  expect(response.headers.get("X-Request-Id")).toBeNull();
  expect(seen.at(-1)?.method).toBe("POST");
});

test("maps prompt and predictive model targets to the correct live action catalogs", async () => {
  const promptName = "ServiceSummary";
  const modelName = "Sentiment_Model";
  const seen = mockSalesforce({
    "/services/data/": [{ version: "67.0", url: "/services/data/v67.0" }],
    "/services/data/v67.0/actions/custom": {
      generatePromptResponse: "/services/data/v67.0/actions/custom/generatePromptResponse",
      cdpMlPrediction: "/services/data/v67.0/actions/custom/cdpMlPrediction",
    },
    "/services/data/v67.0/actions/custom/generatePromptResponse": {
      actions: [{ name: promptName, url: `/services/data/v67.0/actions/custom/generatePromptResponse/${promptName}` }],
    },
    [`/services/data/v67.0/actions/custom/generatePromptResponse/${promptName}`]: {
      name: promptName, inputs: [], outputs: [],
    },
    "/services/data/v67.0/actions/custom/cdpMlPrediction": {
      actions: [{ name: modelName, url: `/services/data/v67.0/actions/custom/cdpMlPrediction/${modelName}` }],
    },
    [`/services/data/v67.0/actions/custom/cdpMlPrediction/${modelName}`]: {
      name: modelName, inputs: [], outputs: [],
    },
  });
  const env = await fixture();

  const prompt = await worker.fetch(toolRequest("/internal/channels/tools/describe", {
    type: "prompt", name: promptName,
  }), env as never);
  const model = await worker.fetch(toolRequest("/internal/channels/tools/describe", {
    type: "predictiveModel", name: modelName,
  }), env as never);

  expect((await prompt.json() as { route: string }).route).toBe(`/services/data/v67.0/actions/custom/generatePromptResponse/${promptName}`);
  expect((await model.json() as { route: string }).route).toBe(`/services/data/v67.0/actions/custom/cdpMlPrediction/${modelName}`);
  expect(seen.some(item => item.url.pathname.includes("/generatePromptResponse/"))).toBe(true);
  expect(seen.some(item => item.url.pathname.includes("/cdpMlPrediction/"))).toBe(true);
});

test("API invocation pins a live API version and encodes query values", async () => {
  const seen = mockSalesforce({
    "/services/data/": [
      { version: "65.0", url: "/services/data/v65.0" },
      { version: "67.0", url: "/services/data/v67.0" },
    ],
    "/services/data/v67.0/": {
      sobjects: "/services/data/v67.0/sobjects",
    },
    "/services/data/v67.0/sobjects/Account": (init, url) => {
      expect(init?.method).toBe("GET");
      expect(url.searchParams.get("q")).toBe("Name = 'A&B'");
      expect(url.searchParams.get("limit")).toBe("5");
      return Response.json({ ok: true });
    },
  });
  const response = await worker.fetch(toolRequest("/internal/channels/tools/invoke", {
    type: "api",
    name: "accountSearch",
    method: "GET",
    path: "/services/data/sobjects/{objectName}",
    queryParams: { q: "{soql}", limit: 5 },
  }, { objectName: "Account", soql: "Name = 'A&B'" }), await fixture() as never);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen.map(item => item.url.pathname)).toContain("/services/data/v67.0/");
  expect(seen.at(-1)?.url.search).toContain("A%26B");
});

test("API write verbs forward arguments as the raw JSON body", async () => {
  const seen = mockSalesforce({
    "/services/data/": [{ version: "67.0", url: "/services/data/v67.0" }],
    "/services/data/v67.0/": { sobjects: "/services/data/v67.0/sobjects" },
    "/services/data/v67.0/sobjects/Account": (init) => Response.json({
      method: init?.method,
      body: init?.body,
    }),
  });
  const env = await fixture();
  const args = { Name: "Acme" };

  for (const method of ["POST", "PATCH", "DELETE"]) {
    const response = await worker.fetch(toolRequest("/internal/channels/tools/invoke", {
      type: "api", name: "accountWrite", method, path: "/services/data/sobjects/Account",
    }, args), env as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ method, body: JSON.stringify(args) });
  }
  expect(seen.filter(item => item.url.pathname.endsWith("/sobjects/Account")).map(item => item.method)).toEqual([
    "POST", "PATCH", "DELETE",
  ]);
});

test("API targets reject external hosts, unsafe methods, and paths outside REST resources", async () => {
  const seen = mockSalesforce({});
  const env = await fixture();
  const attempts = [
    { type: "api", name: "badHost", method: "GET", path: "https://evil.invalid/services/data/v67.0/query" },
    { type: "api", name: "badMethod", method: "PUT", path: "/services/data/query" },
    { type: "api", name: "badPath", method: "POST", path: "/services/oauth2/token" },
    { type: "toString", name: "prototypeLookup" },
  ];

  for (const target of attempts) {
    const response = await worker.fetch(toolRequest("/internal/channels/tools/invoke", target, { q: "SELECT Id" }), env as never);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ available: false });
  }
  expect(seen.map(item => item.url.pathname)).toEqual([]);
});

test("tool endpoints require an active channel grant before any Salesforce request", async () => {
  const seen = mockSalesforce({});
  const response = await worker.fetch(toolRequest("/internal/channels/tools/describe", {
    type: "flow", name: "ExistingFlow",
  }), await fixture(false) as never);

  expect(response.status).toBe(403);
  expect(seen).toHaveLength(0);
});

test("temporary speech test creates, invokes, and deletes only its tenant-scoped WAV fixture", async () => {
  const versionPath = "/services/data/v67.0/sobjects/ContentVersion";
  const queryPath = "/services/data/v67.0/query";
  const actionPath = "/services/data/v67.0/actions/standard/speechToText";
  const deletePath = "/services/data/v67.0/sobjects/ContentDocument/069000000000001AAA";
  const seen = mockSalesforce({
    [versionPath]: (init) => {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.PathOnClient).toBe("action-searcher-probe.wav");
      expect(atob(body.VersionData).slice(0, 4)).toBe("RIFF");
      return Response.json({ id: "068000000000001AAA", success: true, errors: [] }, { status: 201 });
    },
    [queryPath]: (_init, url) => {
      expect(decodeURIComponent(url.searchParams.get("q") ?? "")).toContain("FROM ContentVersion");
      return Response.json({ records: [{ ContentDocumentId: "069000000000001AAA" }] });
    },
    [actionPath]: (init) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ inputs: [{ contentDocumentId: "069000000000001AAA" }] });
      return Response.json([{ isSuccess: true, errors: [] }]);
    },
    [deletePath]: (init) => {
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    },
  });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const audioBase64 = btoa(`RIFF${"\0".repeat(4)}WAVE${"\0".repeat(32)}`);

  const result = await entrypoint.invokeSpeechToTextWithSyntheticAudio(
    { teamId: "team", orgId, channelId: "channel" },
    { apiVersion: "67.0", route: actionPath, arguments: {}, audioBase64 },
  );

  expect(result).toEqual({ status: 200, body: [{ isSuccess: true, errors: [] }] });
  expect(seen.map(item => [item.url.pathname, item.method])).toContainEqual([versionPath, "POST"]);
  expect(seen.map(item => [item.url.pathname, item.method])).toContainEqual([queryPath, "GET"]);
  expect(seen.map(item => [item.url.pathname, item.method])).toContainEqual([actionPath, "POST"]);
  expect(seen.map(item => [item.url.pathname, item.method])).toContainEqual([deletePath, "DELETE"]);
  expect(seen.filter(item => !item.url.pathname.startsWith("/services/oauth2/")).every(item =>
    item.authorization === "Bearer secret-access-token")).toBe(true);
});

test("temporary speech test rejects every Salesforce route except the discovered standard action", async () => {
  const seen = mockSalesforce({});
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const audioBase64 = btoa(`RIFF${"\0".repeat(4)}WAVE${"\0".repeat(32)}`);

  await expect(entrypoint.invokeSpeechToTextWithSyntheticAudio(
    { teamId: "team", orgId, channelId: "channel" },
    { apiVersion: "67.0", route: "/services/data/v67.0/sobjects/Account", arguments: {}, audioBase64 },
  )).rejects.toThrow("invalid_synthetic_audio_test");
  expect(seen).toHaveLength(0);
});

test("temporary cart test builds a live WebStore and Commerce cart, invokes the read action, and deletes both", async () => {
  const storeDescribePath = "/services/data/v67.0/sobjects/WebStore/describe";
  const cartDescribePath = "/services/data/v67.0/sobjects/WebCart/describe";
  const storePath = "/services/data/v67.0/sobjects/WebStore";
  const storeId = "0ZE000000000001AAA";
  const accountId = "001000000000001AAA";
  const cartPath = `/services/data/v67.0/commerce/webstores/${storeId}/carts`;
  const cartId = "0a6000000000001AAA";
  const queryPath = "/services/data/v67.0/query";
  const actionPath = "/services/data/v67.0/actions/standard/getCartItems";
  const promotionsPath = "/services/data/v67.0/actions/standard/getCartPromotions";
  const deleteStorePath = `${storePath}/${storeId}`;
  const deleteCartPath = `${cartPath}/${cartId}`;
  let storeCreates = 0;
  let cartDeleted = false;
  const seen = mockSalesforce({
    [storeDescribePath]: {
      fields: [
        { name: "Name", type: "string", nillable: false, createable: true },
        { name: "DefaultTaxLocaleType", type: "picklist", nillable: false, createable: false, permissionable: false },
        { name: "Type", type: "picklist", nillable: false, createable: true, defaultedOnCreate: true,
          picklistValues: [{ active: true, value: "B2B" }, { active: true, value: "B2C" }] },
        { name: "DeveloperName", type: "string", nillable: false, createable: false, autoNumber: true },
      ],
    },
    [storePath]: (init) => {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.Name).toContain("Action Searcher temporary store probe");
      storeCreates++;
      if (body.Type === "B2B") return Response.json([{ errorCode: "LICENSE_REQUIRED" }], { status: 400 });
      expect(body.Type).toBe("B2C");
      return Response.json({ id: storeId, success: true, errors: [] }, { status: 201 });
    },
    [cartDescribePath]: {
      fields: [
        { name: "Name", type: "string", nillable: false, createable: true },
        { name: "WebStoreId", type: "reference", referenceTo: ["WebStore"], nillable: false, createable: true },
        { name: "AccountId", type: "reference", referenceTo: ["Account", "User"], nillable: true, createable: true },
        { name: "Status", type: "picklist", nillable: true, createable: true, defaultedOnCreate: true,
          picklistValues: [{ active: true, value: "Active" }, { active: true, value: "Closed" }] },
        { name: "Type", type: "picklist", nillable: true, createable: true, defaultedOnCreate: true,
          picklistValues: [{ active: true, value: "Cart" }, { active: true, value: "Template" }] },
      ],
    },
    [queryPath]: (_init, url) => {
      expect(decodeURIComponent(url.searchParams.get("q") ?? "")).toContain("FROM Account");
      return Response.json({ records: [{ Id: accountId }] });
    },
    [cartPath]: (init, url) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        name: expect.stringContaining("Action Searcher temporary cart probe"),
        type: "Cart", effectiveAccountId: accountId,
      });
      expect(url.searchParams.get("effectiveAccountId")).toBe(accountId);
      cartDeleted = false;
      return Response.json({ cartId }, { status: 200 });
    },
    [`/services/data/v67.0/sobjects/WebCart/${cartId}`]: init => {
      if (init?.method === "DELETE") { cartDeleted = true; return new Response(null,{status:204}); }
      return cartDeleted ? Response.json([{errorCode:"NOT_FOUND"}],{status:404})
        : Response.json({ Id: cartId, OwnerId: userId, WebStoreId: storeId, AccountId: accountId, Status: "Active" });
    },
    [actionPath]: (init) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ inputs: [{
        cartStateOrId: cartId, webStoreId: storeId, effectiveAccountId: accountId, userId,
      }] });
      return Response.json([{ isSuccess: true, errors: [] }]);
    },
    [promotionsPath]: (init) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ inputs: [{
        cartStateOrId: cartId, webStoreId: storeId, effectiveAccountId: accountId, userId,
      }] });
      return Response.json([{ isSuccess: true, errors: [] }]);
    },
    [deleteStorePath]: (init) => {
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    },
    [deleteCartPath]: (init, url) => {
      if (init?.method === "PUT") {
        expect(url.searchParams.get("effectiveAccountId")).toBe(accountId);
        return new Response(null, { status: 204 });
      }
      expect(init?.method).toBe("DELETE");
      cartDeleted = true;
      return new Response(null, { status: 204 });
    },
  });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());

  const result = await entrypoint.invokeCartReadWithSyntheticWebStore(
    { teamId: "team", orgId, channelId: "channel" },
    { apiVersion: "67.0", route: actionPath, arguments: { cartStateOrId: "current" } },
  );
  const promotionsResult = await entrypoint.invokeCartReadWithSyntheticWebStore(
    { teamId: "team", orgId, channelId: "channel" },
    { apiVersion: "67.0", route: promotionsPath, arguments: { cartStateOrId: "current" } },
  );

  expect(result).toEqual({ status: 200, body: [{ isSuccess: true, errors: [] }] });
  expect(promotionsResult).toEqual({ status: 200, body: [{ isSuccess: true, errors: [] }] });
  expect(seen.map(item => [item.url.pathname, item.method])).toContainEqual([storeDescribePath, "GET"]);
  expect(seen.map(item => [item.url.pathname, item.method])).toContainEqual([cartDescribePath, "GET"]);
  expect(seen.map(item => [item.url.pathname, item.method])).toContainEqual([storePath, "POST"]);
  expect(seen.map(item => [item.url.pathname, item.method])).toContainEqual([cartPath, "POST"]);
  expect(seen.map(item => [item.url.pathname, item.method])).not.toContainEqual([deleteCartPath, "PUT"]);
  expect(seen.map(item => [item.url.pathname, item.method])).toContainEqual([actionPath, "POST"]);
  expect(seen.map(item => [item.url.pathname, item.method])).toContainEqual([`/services/data/v67.0/sobjects/WebCart/${cartId}`, "DELETE"]);
  expect(seen.map(item => [item.url.pathname, item.method])).toContainEqual([deleteStorePath, "DELETE"]);
  expect(storeCreates).toBe(4);
});

test("scoped inspection forwards bounded Connect generations and rejects malformed payloads", async () => {
  const path = "/services/data/v67.0/einstein/prompt-templates/TenantTemplate/generations";
  const payload = { isPreview: false, inputParams: { valueMap: { "Input:Document": { value: { entries: [] } } } },
    additionalConfig: { applicationName: "PromptBuilderPreview" } };
  const seen = mockSalesforce({ [path]: (init) => {
    expect(JSON.parse(String(init?.body))).toEqual(payload);
    return Response.json({ generations: [{ text: "Upstream result" }] }, { status: 201 });
  } });
  const entry = new TubotSfAuthEntrypoint(null, await fixture());
  const ref = { teamId: "team", orgId, channelId: "channel" };
  const result = await entry.inspectSalesforce(ref, [{ method: "POST", path, jsonBody: payload }]);
  expect(result[0]).toEqual({ status: 201, body: { generations: [{ text: "Upstream result" }] } });
  await expect(entry.inspectSalesforce(ref, [{ method: "POST", path, jsonBody: { inputs: [{}] } }]))
    .rejects.toThrow("invalid_api_path");
  await expect(entry.inspectSalesforce(ref, [{ method: "POST", path: path.replace("generations", "delete"), jsonBody: payload }]))
    .rejects.toThrow("invalid_api_path");
  expect(seen).toHaveLength(1);
});

test("typed prompt context uses live definitions and validation, without faking an execution result", async () => {
  const root = "/services/data/v67.0";
  const template = `${root}/einstein/prompt-templates/TenantTemplate`;
  let attempt = 0;
  const seen = mockSalesforce({
    [template]: { childRelationships: { GenAiPromptTemplateVersions: [{
      fields: { Status: { value: "Published" } }, childRelationships: { GenAiPromptTemplateInputs: [
        { fields: { ReferenceName: { value: "Input:Runtime" }, Definition: { value: "lightningtype://propertyType/TenantType" } } },
        { fields: { ReferenceName: { value: "Input:Text" }, Definition: { value: "primitive://String" } } },
      ] },
    }] } },
    [`${template}/generations`]: (init) => {
      const input = JSON.parse(String(init?.body));
      expect(input.isPreview).toBe(true);
      expect(input.inputParams.valueMap["Input:Text"]).toEqual({ value: "synthetic text" });
      attempt++;
      if (attempt === 1) return Response.json([{ errorCode: "INVALID_INPUT",
        message: "$.events: is missing but it is required" }], { status: 400 });
      if (attempt === 2) return Response.json([{ errorCode: "INVALID_INPUT",
        message: "$.events: object found, array expected" }], { status: 400 });
      expect(input.inputParams.valueMap["Input:Runtime"]).toEqual({ value: { events: [] } });
      return Response.json({ prompt: "Resolved live template", generations: [] }, { status: 201 });
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).prepareTypedPromptContext(
    { teamId: "team", orgId, channelId: "channel" }, { apiVersion: "67.0",
      route: `${root}/actions/custom/generatePromptResponse/TenantTemplate`,
      arguments: { "Input:Text": { value: "synthetic text" } } });
  expect(result.status).toBe(201);
  expect(result.body).toBeNull();
  expect(result.schemas).toMatchObject({ "Input:Runtime": { source: "salesforce_live_validation",
    schema: { properties: { events: { type: "array" } } } } });
  expect(result.executionRoute).toBe(`${template}/generations`);
  expect(seen).toHaveLength(4);
});

test("summary probe skips objects without UI layouts and reuses a live tenant record", async () => {
  const root = "/services/data/v67.0";
  const route = `${root}/actions/standard/summarizeRecord`;
  const seen = mockSalesforce({
    [`${root}/sobjects/`]: { sobjects: [
      { name: "NoLayout__c", queryable: true, searchable: true, layoutable: true },
      { name: "TenantRecord__c", queryable: true, searchable: true, layoutable: true },
      { name: "Hidden__c", queryable: true, searchable: false, layoutable: true },
    ] },
    [`${root}/ui-api/layout/NoLayout__c`]: () => Response.json([], { status: 400 }),
    [`${root}/ui-api/layout/TenantRecord__c`]: { id: "live-layout" },
    [`${root}/query`]: (_init, url) => {
      expect(url.searchParams.get("q")).toBe("SELECT Id FROM TenantRecord__c LIMIT 1");
      return Response.json({ records: [{ Id: "a01000000000001AAA" }] });
    },
    [route]: (init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ inputs: [{ recordId: "a01000000000001AAA" }] });
      return Response.json([{ isSuccess: true, errors: [] }]);
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeRecordSummaryWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { apiVersion: "67.0", route });
  expect(result.status).toBe(200);
  expect(seen.filter(item => item.method !== "GET").map(item => item.url.pathname)).toEqual([route]);
});

test("summary probe creates a schema-derived record and cleans it after an HTTP 200 rejection", async () => {
  const root = "/services/data/v67.0";
  const route = `${root}/actions/standard/summarizeRecord`;
  const recordPath = `${root}/sobjects/TenantRecord__c`;
  const seen = mockSalesforce({
    [`${root}/sobjects/`]: { sobjects: [{ name: "TenantRecord__c", queryable: true,
      searchable: true, layoutable: true, createable: true }] },
    [`${root}/ui-api/layout/TenantRecord__c`]: { id: "live-layout" },
    [`${root}/query`]: { records: [] },
    [`${recordPath}/describe`]: { fields: [{ name: "Name", type: "string", nillable: false, createable: true }] },
    [recordPath]: (init) => {
      expect(JSON.parse(String(init?.body)).Name).toStartWith("Action Searcher temporary summary probe");
      return Response.json({ id: "a01000000000001AAA", success: true }, { status: 201 });
    },
    [route]: [{ isSuccess: false, errors: [{ message: "Upstream provider missing" }] }],
    [`${recordPath}/a01000000000001AAA`]: (init) => {
      expect(init?.method).toBe("DELETE"); return new Response(null, { status: 204 });
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeRecordSummaryWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { apiVersion: "67.0", route });
  expect(result.body).toEqual([{ isSuccess: false, errors: [{ message: "Upstream provider missing" }] }]);
  expect(result.cleanupError).toBeUndefined();
  expect(seen.at(-1)?.method).toBe("DELETE");
});

test("summary probe rejects revoked grants and other routes before upstream access", async () => {
  let called = false;
  globalThis.fetch = (async () => { called = true; return Response.json({}); }) as typeof fetch;
  const input = { apiVersion: "67.0", route: "/services/data/v67.0/actions/standard/summarizeRecord" };
  await expect(new TubotSfAuthEntrypoint(null, await fixture(false)).invokeRecordSummaryWithContext(
    { teamId: "team", orgId, channelId: "channel" }, input)).rejects.toThrow("channel_not_authorized");
  await expect(new TubotSfAuthEntrypoint(null, await fixture()).invokeRecordSummaryWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { ...input, route: input.route.replace("summarizeRecord", "createRecord") }
  )).rejects.toThrow("invalid_summary_probe");
  expect(called).toBe(false);
});

test("data graph probe uses live DMO keys and removes its draft after Salesforce rejects the action", async () => {
  const root = "/services/data/v67.0";
  const route = `${root}/actions/standard/cdpGetDataGraphMetadata`;
  const graphs = `${root}/ssot/data-graphs`;
  let temporaryName = "";
  const routes: Record<string, unknown | ((init: RequestInit | undefined, url: URL) => Response)> = {
    [`${graphs}/metadata`]: { dataGraphMetadata: [] },
    [`${root}/ssot/data-model-objects`]: { dataModelObject: [
      { name: "Disabled__dlm", isEnabled: false, fields: [{ name: "Id__c", isPrimaryKey: true }] },
      { name: "LiveProfile__dlm", dataSpaceName: "TenantSpace", category: "Profile", isEnabled: true,
        creationType: "Custom", fields: [
          { name: "PrimaryKey__c", type: "Text", isPrimaryKey: true },
          { name: "KQ_Id__c", type: "Text" },
          { name: "PrivateValue__c", type: "Text" },
        ] },
    ] },
    [graphs]: (init) => {
      const input = JSON.parse(String(init?.body));
      temporaryName = input.name;
      expect(input).toMatchObject({ creationMode: "draft", dataspaceName: "TenantSpace",
        primaryObjectName: "LiveProfile__dlm", sourceObject: { type: "custom" } });
      expect(input.sourceObject.fields.map((field: { sourceFieldName: string }) => field.sourceFieldName))
        .toEqual(["PrimaryKey__c", "KQ_Id__c"]);
      routes[`${graphs}/${temporaryName}`] = (cleanup) => {
        expect(cleanup?.method).toBe("DELETE");
        return new Response(null, { status: 204 });
      };
      return Response.json({ name: temporaryName, status: "draft" }, { status: 201 });
    },
    [route]: (init) => {
      if (init?.method === "GET") return Response.json({ inputs: [{name:"dataGraphApiName",required:true},{name:"dataspaceApiName",required:true}] });
      expect(JSON.parse(String(init?.body))).toEqual({ inputs: [{
        dataGraphApiName: temporaryName, dataspaceApiName: "TenantSpace",
      }] });
      return Response.json([{ isSuccess: false, errors: [{ statusCode: "INVALID_INPUT",
        message: "Salesforce rejected the graph action." }] }], { status: 400 });
    },
  };
  const seen = mockSalesforce(routes);
  const result = await new TubotSfAuthEntrypoint(null, await fixture())
    .invokeDataGraphMetadataWithSyntheticGraph({ teamId: "team", orgId, channelId: "channel" }, {
      apiVersion: "67.0", route,
    });
  expect(result.status).toBe(400);
  expect(result.cleanupError).toBeUndefined();
  expect(seen.at(-1)?.method).toBe("DELETE");
  expect(seen.at(-1)?.url.pathname).toBe(`${graphs}/${temporaryName}`);
  expect(seen.some(item => item.url.pathname.includes("activate"))).toBe(false);
});

test("data graph probe reuses accessible metadata without mutating the org", async () => {
  const route = "/services/data/v67.0/actions/standard/cdpGetDataGraphMetadata";
  const seen = mockSalesforce({
    "/services/data/v67.0/ssot/data-graphs/metadata": {
      dataGraphMetadata: [{ developerName: "ExistingGraph", dataspaceName: "ExistingSpace" }],
    },
    [route]: (init) => {
      if (init?.method === "GET") return Response.json({ inputs: [{name:"dataGraphApiName",required:true},{name:"dataspaceApiName",required:true}] });
      expect(JSON.parse(String(init?.body))).toEqual({ inputs: [{
        dataGraphApiName: "ExistingGraph", dataspaceApiName: "ExistingSpace",
      }] });
      return Response.json([{ isSuccess: true, errors: [] }]);
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture())
    .invokeDataGraphMetadataWithSyntheticGraph({ teamId: "team", orgId, channelId: "channel" }, {
      apiVersion: "67.0", route,
    });
  expect(result.status).toBe(200);
  expect(seen).toHaveLength(3);
});

test("optional graph metadata schema invokes native catalog mode without creating resources", async () => {
  const route="/services/data/v67.0/actions/standard/cdpGetDataGraphMetadata";
  const seen=mockSalesforce({[route]:(init)=>{
    if(init?.method==="GET")return Response.json({inputs:[{name:"dataGraphApiName",required:false},{name:"dataspaceApiName",required:false}]});
    expect(JSON.parse(String(init?.body))).toEqual({inputs:[{}]});
    return Response.json([{isSuccess:true,errors:[],outputValues:{dataGraphMetadata:"[]"}}]);
  }});
  const result=await new TubotSfAuthEntrypoint(null,await fixture()).invokeDataGraphMetadataWithSyntheticGraph({teamId:"team",orgId,channelId:"channel"},{apiVersion:"67.0",route});
  expect(result.status).toBe(200);expect(seen).toHaveLength(2);expect(seen.every(item=>item.url.pathname===route)).toBe(true);
});

test("data graph probe refuses revoked grants and mismatched routes before Salesforce access", async () => {
  const seen = mockSalesforce({});
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture(false));
  const ref = { teamId: "team", orgId, channelId: "channel" };
  await expect(entrypoint.invokeDataGraphMetadataWithSyntheticGraph(ref, {
    apiVersion: "67.0", route: "/services/data/v67.0/actions/standard/cdpGetDataGraphMetadata",
  })).rejects.toThrow("channel_not_authorized");
  await expect(entrypoint.invokeDataGraphMetadataWithSyntheticGraph(ref, {
    apiVersion: "67.0", route: "/services/data/v67.0/actions/standard/createRecord",
  })).rejects.toThrow("invalid_synthetic_graph_test");
  expect(seen).toHaveLength(0);
});

test("Data Graph read endpoints activate with a schedule and use discovered primary keys", async () => {
  for (const [action, useAlternative] of [["cdpGetDataGraph", false], ["cdpGetDataGraphByLookup", false], ["cdpGetDataGraph", true]] as const) {
    const root = "/services/data/v67.0";
    let temporaryName = "";
    const routes: Parameters<typeof mockSalesforce>[0] = {
      [`${root}/query`]: { records: [{ LastRunStatus: "SUCCESS", RecordCount: 1 }] },
      [`${root}/ssot/data-graphs/metadata`]: { dataGraphMetadata: [] },
      [`${root}/ssot/data-model-objects`]: { dataModelObject: [{ name: "Live__dlm", dataSpaceName: "Space",
        creationType: "Custom", category: "Other", isEnabled: true,
        fields: [{ name: "LiveKey__c", isPrimaryKey: true, type: "Text" }] }] },
      [`${root}/ssot/query-sql`]: init => {
        const sql = JSON.parse(String(init?.body)).sql;
        return Response.json(sql.endsWith("LIMIT 0") ? { metadata: [{ name: "LiveKey__c" }], returnedRows: 0 }
          : { metadata: [{ name: "LiveKey__c" }], data: [["source-key"]], returnedRows: 1 });
      },
      [`${root}/ssot/data-graphs`]: init => {
        temporaryName = JSON.parse(String(init?.body)).name;
        routes[`${root}/ssot/data-graphs/${temporaryName}/actions/activate`] = activation => {
          expect(JSON.parse(String(activation?.body))).toEqual({
            fullRefreshConfig: { schedule: { frequency: 1, timeGranularity: "Day" } },
          });
          return Response.json({ success: true, errors: [] });
        };
        routes[`${root}/ssot/data-graphs/${temporaryName}`] = cleanup => {
          expect(cleanup?.method).toBe("DELETE"); return new Response(null, { status: 204 });
        };
        routes[`${root}/ssot/data-graphs/data/${temporaryName}/source-key`] = (_init, url) => {
          expect(url.searchParams.get("live")).toBe("true");
          return Response.json({ ProbeField0: "source-key" });
        };
        return Response.json({ name: temporaryName }, { status: 201 });
      },
      [`${root}/actions/standard/${action}`]: init => {
        expect(JSON.parse(String(init?.body)).inputs[0]).toEqual({
          dataGraphApiName: temporaryName, dataspaceApiName: "Space",
          ...(action.endsWith("ByLookup") ? { lookupKey: "[Live__dlm.LiveKey__c=source-key]" } : { recordId: "source-key" }),
        });
        return useAlternative ? Response.json([{ isSuccess: false, errors: [{ message: "unknown column json_blob__c" }] }], { status: 400 })
          : Response.json([{ isSuccess: true, errors: [] }]);
      },
    };
    const seen = mockSalesforce(routes);
    const entry = new TubotSfAuthEntrypoint(null, await fixture());
    const result = action.endsWith("ByLookup")
      ? await entry.invokeDataGraphByLookupWithContext({ teamId: "team", orgId, channelId: "channel" }, { apiVersion: "67.0" })
      : await entry.invokeDataGraphWithContext({ teamId: "team", orgId, channelId: "channel" }, { apiVersion: "67.0" });
    expect(result.status).toBe(useAlternative ? 400 : 200);
    if (useAlternative) expect(result.alternative).toMatchObject({ status: 200, success: true });
    expect(result.cleanupError).toBeUndefined();
    expect(seen.at(-1)?.method).toBe("DELETE");
  }
});

test("pending Data Graph context is reused and retained without reporting success", async () => {
  const root = "/services/data/v67.0";
  const ref = { teamId: "team", orgId, channelId: "channel" };
  const env = await fixture();
  const basePrepare = env.DB.prepare;
  const writes: string[] = [];
  const savedRoot = { name: "Mapped__dlm", dataSpaceName: "Space", isEnabled: true, creationType: "Custom",
    fields: [{ name: "MappedKey__c", type: "Text", isPrimaryKey: true }] };
  env.DB.prepare = (sql: string) => {
    if (!sql.includes("action_graph_context")) return basePrepare(sql);
    return { bind: () => ({
      first: async () => ({ graph_name: "ActionProbeExisting", root_schema_json: JSON.stringify(savedRoot),
        owned_model_name: null, created_at: Date.now() }),
      run: async () => { writes.push(sql); return { success: true }; },
    }) } as never;
  };
  const seen = mockSalesforce({
    [`${root}/query`]: { records: [{ LastRunStatus: "PROCESSING", RecordCount: 0 }] },
    [`${root}/ssot/data-graphs/metadata`]: { dataGraphMetadata: [] },
    [`${root}/ssot/data-model-objects`]: { dataModelObject: [] },
    [`${root}/ssot/query-sql`]: init => Response.json(JSON.parse(String(init?.body)).sql.endsWith("LIMIT 0")
      ? { metadata: [{ name: "MappedKey__c" }] } : { data: [["real-key"]], returnedRows: 1 }),
    [`${root}/actions/standard/cdpGetDataGraph`]: () => Response.json([{ isSuccess: false,
      errors: [{ message: "DaoEntity with daoId = ActionProbeExisting is not found" }] }], { status: 400 }),
  });
  const timer = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => timer(callback, 0)) as never;
  try {
    const result = await new TubotSfAuthEntrypoint(null, env).invokeDataGraphWithContext(ref, { apiVersion: "67.0" });
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ errorCode: "DATA_GRAPH_BUILD_PENDING" });
    expect(seen.some(item => item.method === "DELETE" || item.url.pathname.endsWith("/activate"))).toBe(false);
    expect(writes).toHaveLength(0);
    expect(seen.some(item => item.url.pathname.includes("/actions/standard/"))).toBe(false);
  } finally { globalThis.setTimeout = timer; }
});

test("Data Graph read preparation fails explicitly when both DMO and DLO context are absent", async () => {
  mockSalesforce({
    "/services/data/v67.0/ssot/data-graphs/metadata": { dataGraphMetadata: [] },
    "/services/data/v67.0/ssot/data-model-objects": { dataModelObject: [] },
    "/services/data/v67.0/ssot/data-lake-objects": { dataLakeObjects: [] },
  });
  const entry = new TubotSfAuthEntrypoint(null, await fixture());
  const result = await entry.invokeDataGraphWithContext({ teamId: "team", orgId, channelId: "channel" }, { apiVersion: "67.0" });
  expect(result.status).toBe(422);
  expect(result.body).toMatchObject({ errorCode: "DATA_GRAPH_SOURCE_DATA_REQUIRED" });
});

test("temporary cart test rejects non-cart routes before making Salesforce requests", async () => {
  const seen = mockSalesforce({});
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());

  await expect(entrypoint.invokeCartReadWithSyntheticWebStore(
    { teamId: "team", orgId, channelId: "channel" },
    { apiVersion: "67.0", route: "/services/data/v67.0/sobjects/Account", arguments: { cartStateOrId: "current" } },
  )).rejects.toThrow("invalid_synthetic_cart_test");
  expect(seen).toHaveLength(0);
});

test("temporary cart failure preserves the Salesforce cause and deletes its WebStore", async () => {
  const storeDescribePath = "/services/data/v67.0/sobjects/WebStore/describe";
  const storePath = "/services/data/v67.0/sobjects/WebStore";
  const storeId = "0ZE000000000001AAA";
  const accountId = "001000000000001AAA";
  const accountDescribePath = "/services/data/v67.0/sobjects/Account/describe";
  const accountPath = "/services/data/v67.0/sobjects/Account";
  const deleteAccountPath = `${accountPath}/${accountId}`;
  const cartDescribePath = "/services/data/v67.0/sobjects/WebCart/describe";
  const cartPath = `/services/data/v67.0/commerce/webstores/${storeId}/carts`;
  const deleteStorePath = `${storePath}/${storeId}`;
  const queryPath = "/services/data/v67.0/query";
  const seen = mockSalesforce({
    [storeDescribePath]: {
      fields: [
        { name: "Name", type: "string", nillable: false, createable: true },
        { name: "Type", type: "picklist", nillable: false, createable: true, defaultedOnCreate: true,
          picklistValues: [{ active: true, value: "B2B" }] },
      ],
    },
    [storePath]: (init) => {
      expect(init?.method).toBe("POST");
      return Response.json({ id: storeId, success: true, errors: [] }, { status: 201 });
    },
    [cartDescribePath]: {
      fields: [
        { name: "Name", type: "string", nillable: false, createable: true },
        { name: "WebStoreId", type: "reference", referenceTo: ["WebStore"], nillable: false, createable: true },
        { name: "AccountId", type: "reference", referenceTo: ["Account", "User"], nillable: true, createable: true },
      ],
    },
    [queryPath]: () => Response.json({ records: [] }),
    [accountDescribePath]: {
      fields: [{ name: "Name", type: "string", nillable: false, createable: true }],
    },
    [accountPath]: (init) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body)).Name).toContain("Action Searcher temporary account probe");
      return Response.json({ id: accountId, success: true, errors: [] }, { status: 201 });
    },
    [cartPath]: () => Response.json([{
      errorCode: "REQUIRED_FIELD_MISSING", message: "A required commerce field is missing.",
    }], { status: 400 }),
    [deleteStorePath]: (init) => {
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    },
    [deleteAccountPath]: (init) => {
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    },
  });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());

  const result = await entrypoint.invokeCartReadWithSyntheticWebStore(
    { teamId: "team", orgId, channelId: "channel" },
    { apiVersion: "67.0", route: "/services/data/v67.0/actions/standard/getCartItems",
      arguments: { cartStateOrId: "current" } },
  );

  expect(result).toEqual({
    status: 400,
    body: {
      errorCode: "REQUIRED_FIELD_MISSING",
      message: "Temporary Commerce cart creation failed (HTTP 400): A required commerce field is missing.",
    },
  });
  expect(seen.map(item => [item.url.pathname, item.method])).toContainEqual([deleteStorePath, "DELETE"]);
  expect(seen.map(item => [item.url.pathname, item.method])).toContainEqual([accountDescribePath, "GET"]);
  expect(seen.map(item => [item.url.pathname, item.method])).toContainEqual([accountPath, "POST"]);
  expect(seen.map(item => [item.url.pathname, item.method])).toContainEqual([deleteAccountPath, "DELETE"]);
});

test("temporary fixtures synthesize time, base64, combobox, and encrypted-string wire formats", async () => {
  const storeDescribePath = "/services/data/v67.0/sobjects/WebStore/describe";
  const storePath = "/services/data/v67.0/sobjects/WebStore";
  const storeId = "0ZE000000000001AAA";
  const accountId = "001000000000001AAA";
  const accountDescribePath = "/services/data/v67.0/sobjects/Account/describe";
  const accountPath = "/services/data/v67.0/sobjects/Account";
  const cartDescribePath = "/services/data/v67.0/sobjects/WebCart/describe";
  const cartPath = `/services/data/v67.0/commerce/webstores/${storeId}/carts`;
  const queryPath = "/services/data/v67.0/query";
  const extra = (comboValues?: unknown) => [
    { name: "CloseTime", type: "time", nillable: false, createable: true },
    { name: "SetupBlob", type: "base64", nillable: false, createable: true },
    { name: "Channel", type: "combobox", nillable: false, createable: true, ...(comboValues === undefined ? {} : { picklistValues: comboValues }) },
    { name: "TaxId", type: "encryptedstring", nillable: false, createable: true },
  ];
  let storePayload: Record<string, unknown> = {};
  let accountPayload: Record<string, unknown> = {};
  mockSalesforce({
    [storeDescribePath]: {
      fields: [
        { name: "Name", type: "string", nillable: false, createable: true },
        { name: "Type", type: "picklist", nillable: false, createable: true, defaultedOnCreate: true,
          picklistValues: [{ active: true, value: "B2B" }] },
        ...extra([{ active: true, value: "Online" }]),
      ],
    },
    [storePath]: (init) => {
      storePayload = JSON.parse(String(init?.body));
      return Response.json({ id: storeId, success: true, errors: [] }, { status: 201 });
    },
    [cartDescribePath]: {
      fields: [
        { name: "Name", type: "string", nillable: false, createable: true },
        { name: "WebStoreId", type: "reference", referenceTo: ["WebStore"], nillable: false, createable: true },
        { name: "AccountId", type: "reference", referenceTo: ["Account", "User"], nillable: true, createable: true },
        ...extra([]),
      ],
    },
    [queryPath]: () => Response.json({ records: [] }),
    [accountDescribePath]: {
      fields: [
        { name: "Name", type: "string", nillable: false, createable: true },
        ...extra(),
      ],
    },
    [accountPath]: (init) => {
      accountPayload = JSON.parse(String(init?.body));
      return Response.json({ id: accountId, success: true, errors: [] }, { status: 201 });
    },
    [cartPath]: () => Response.json([{
      errorCode: "REQUIRED_FIELD_MISSING", message: "A required commerce field is missing.",
    }], { status: 400 }),
    [`${storePath}/${storeId}`]: () => new Response(null, { status: 204 }),
    [`${accountPath}/${accountId}`]: () => new Response(null, { status: 204 }),
  });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());

  const result = await entrypoint.invokeCartReadWithSyntheticWebStore(
    { teamId: "team", orgId, channelId: "channel" },
    { apiVersion: "67.0", route: "/services/data/v67.0/actions/standard/getCartItems",
      arguments: { cartStateOrId: "current" } },
  );

  // The flow reaches cart creation: no *_REQUIRED_FIELD_UNSUPPORTED refusal.
  expect(result).toMatchObject({ status: 400, body: { errorCode: "REQUIRED_FIELD_MISSING" } });
  for (const payload of [storePayload, accountPayload]) {
    expect(payload.CloseTime).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(payload.SetupBlob).toBe("QWN0aW9uUHJvYmU=");
    expect(payload.TaxId).toBe("Action Searcher temporary validation");
  }
  expect(storePayload.Channel).toBe("Online");
  expect(accountPayload.Channel).toBe("Action Searcher temporary validation");
});

test("Flow context derives lookup inputs from active metadata, verifies fixture and cleans it", async () => {
  const root = "/services/data/v67.0";
  const route = `${root}/actions/custom/flow/TenantLookup`;
  const id = "003000000000001AAA";
  let email = "";
  const seen = mockSalesforce({
    [route]: init => init?.method === "POST"
      ? Response.json([{isSuccess:true,errors:[],outputValues:{recordId:id}}])
      : Response.json({inputs:[{name:"lookupInput",type:"STRING"}]}),
    [`${root}/tooling/query`]: (_init,url) => Response.json(url.searchParams.get("q")?.includes("FlowDefinition")
      ? {records:[{DeveloperName:"TenantLookup",NamespacePrefix:null,ActiveVersionId:"301000000000001AAA"}]}
      : {records:[{Metadata:{variables:[{name:"lookupInput",isInput:true}],recordLookups:[{object:"Contact",filters:[
        {field:"Email",operator:"EqualTo",value:{elementReference:"lookupInput"}}]}]}}]}),
    [`${root}/sobjects/Contact/describe`]: {createable:true,queryable:true,deletable:true,fields:[{name:"Email",type:"email",createable:true,nillable:true},
      {name:"LastName",type:"string",createable:true,nillable:false,compoundFieldName:"Name"},
      {name:"Name",type:"string",createable:false,nillable:false,permissionable:false}]},
    [`${root}/sobjects/Contact`]: init => {email=JSON.parse(String(init?.body)).Email;return Response.json({id,success:true},{status:201});},
    [`${root}/sobjects/Contact/${id}`]: init => init?.method === "DELETE" ? new Response(null,{status:204}) : Response.json({Id:id,Email:email}),
  });
  const result = await new TubotSfAuthEntrypoint(null,await fixture()).invokeFlowWithContext(
    {teamId:"team",orgId,channelId:"channel"},{apiVersion:"67.0",route,arguments:{}});
  expect(result.status).toBe(200);
  expect(result.contextSchema).toMatchObject({lookupBindings:[{objectName:"Contact",fieldName:"Email",inputName:"lookupInput"}]});
  expect(seen.at(-1)?.method).toBe("DELETE");
  const invoked = seen.find(item=>item.url.pathname===route && item.method==="POST");
  expect(JSON.parse(String(invoked?.body)).inputs[0].lookupInput).toBe(email);
});

test("Flow record enrichment retries with minted parents when one candidate is unmintable", async () => {
  const root = "/services/data/v67.0";
  const route = `${root}/actions/custom/flow/TenantAppt`;
  const SA_ID = "08p000000000001AAA";
  const ACCOUNT_ID = "001000000000001AAA";
  const saPosted: Record<string, unknown>[] = [];
  let accountName = "";
  let saDeleted = false;
  let accountDeleted = false;
  const NPE = [{ message: "FSL.TR001_Service_BeforeInsert: execution of BeforeInsert\n\ncaused by: System.NullPointerException: Attempt to de-reference a null object\n\n(System Code)", errorCode: "CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY", fields: [] }];
  const seen = mockSalesforce({
    [route]: init => init?.method === "POST"
      ? Response.json([{ isSuccess: true, errors: [], outputValues: { Flow__InterviewStatus: "Finished" } }])
      : Response.json({ description: "Updates the appointment.",
        inputs: [{ name: "objSA", type: "SOBJECT", required: false, maxOccurs: 1, sObjectType: "ServiceAppointment" }],
        outputs: [{ name: "Flow__InterviewStatus", type: "PICKLIST" }] }),
    [`${root}/query`]: () => Response.json({ records: [{ QualifiedApiName: "ServiceAppointment" }] }),
    [`${root}/sobjects/ServiceAppointment/describe`]: { createable: true, queryable: true, deletable: true, fields: [
      { name: "EarliestStartTime", type: "datetime", createable: true, nillable: false },
      { name: "DueDate", type: "datetime", createable: true, nillable: false },
      { name: "ParentRecordId", type: "reference", createable: true, updateable: true, nillable: true, referenceTo: ["Account"] },
      { name: "WorkTypeId", type: "reference", createable: true, nillable: true, referenceTo: ["WorkType"] },
    ] },
    [`${root}/sobjects/ServiceAppointment`]: init => {
      const payload = JSON.parse(String(init?.body));
      saPosted.push(payload);
      return typeof payload.ParentRecordId === "string"
        ? Response.json({ id: SA_ID, success: true }, { status: 201 })
        : Response.json(NPE, { status: 400 });
    },
    [`${root}/sobjects/ServiceAppointment/${SA_ID}`]: init => {
      if (init?.method === "DELETE") { saDeleted = true; return new Response(null, { status: 204 }); }
      return saDeleted ? Response.json([{ message: "x", errorCode: "ENTITY_IS_DELETED" }], { status: 404 })
        : Response.json({ Id: SA_ID, ...saPosted[saPosted.length - 1] });
    },
    [`${root}/sobjects/Account/describe`]: { createable: true, queryable: true, deletable: true, fields: [
      { name: "Name", type: "string", createable: true, nillable: false, length: 255 },
    ] },
    [`${root}/sobjects/Account`]: init => { accountName = JSON.parse(String(init?.body)).Name; return Response.json({ id: ACCOUNT_ID, success: true }, { status: 201 }); },
    [`${root}/sobjects/Account/${ACCOUNT_ID}`]: init => {
      if (init?.method === "DELETE") { accountDeleted = true; return new Response(null, { status: 204 }); }
      return accountDeleted ? Response.json([{ message: "x", errorCode: "ENTITY_IS_DELETED" }], { status: 404 })
        : Response.json({ Id: ACCOUNT_ID, Name: accountName });
    },
    [`${root}/sobjects/WorkType/describe`]: { createable: true, queryable: true, deletable: true, fields: [
      { name: "Name", type: "string", createable: true, nillable: false, length: 255 },
    ] },
    [`${root}/sobjects/WorkType`]: () => Response.json([{ message: "insufficient access", errorCode: "INSUFFICIENT_ACCESS" }], { status: 403 }),
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeFlowWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { apiVersion: "67.0", route, arguments: {} });
  expect(result.status).toBe(200);
  expect(result.cleanupError).toBeUndefined();
  expect(saPosted).toHaveLength(2);
  expect(saPosted[1].ParentRecordId).toBe(ACCOUNT_ID);
  expect(saPosted[1].WorkTypeId).toBeUndefined();
  const invoked = seen.find(item => item.url.pathname === route && item.method === "POST");
  expect(JSON.parse(String(invoked?.body)).inputs[0].objSA.ParentRecordId).toBe(ACCOUNT_ID);
  expect(saDeleted).toBe(true);
  expect(accountDeleted).toBe(true);
});

test("verification context uses a discovered real producer and the delivered inbox code", async () => {
  const root = "/services/data/v67.0";
  const route = `${root}/actions/custom/flow/Pkg__VerifyCode`;
  const producer = `${root}/actions/custom/flow/Pkg__SendVerificationCode`;
  const id = "003000000000001AAA";
  let email = "";
  const seen = mockSalesforce({
    [route]: init => init?.method === "POST" ? Response.json([{isSuccess:true,errors:[],outputValues:{isVerified:true,
      messageAfterVerification:"Your verification was successful!",Flow__InterviewStatus:"Finished",Flow__InterviewGuid:"g"}}])
      : Response.json({inputs:["customerCode","customerId","customerType","authenticationKey"].map(name=>({name,type:"STRING"})),
        outputs:[{name:"isVerified",type:"BOOLEAN"},{name:"messageAfterVerification",type:"STRING"}]}),
    [`${root}/actions/custom/flow`]: {actions:[{name:"Pkg__SendVerificationCode",url:producer}]},
    [producer]: init => init?.method === "POST" ? Response.json([{isSuccess:true,errors:[],outputValues:{verificationCode:"xxxxxx",
      authenticationKey:"secret-challenge",customerId:id,customerType:"Contact"}}])
      : Response.json({inputs:[{name:"customerToVerify",type:"STRING"}],outputs:["verificationCode","authenticationKey","customerId","customerType"].map(name=>({name}))}),
    [`${root}/sobjects/Contact/describe`]: {fields:[{name:"Email",type:"email",createable:true,nillable:true},
      {name:"LastName",type:"string",createable:true,nillable:false}]},
    [`${root}/sobjects/Contact`]: init=>{email=JSON.parse(String(init?.body)).Email;return Response.json({id,success:true},{status:201});},
    [`${root}/sobjects/Contact/${id}`]: init=>init?.method === "DELETE"?new Response(null,{status:204}):Response.json({Id:id,Email:email}),
    ["/ajax.php"]: (_init,url) => url.searchParams.get("f") === "get_email_address"
      ? Response.json({email_addr:"probe@guerrillamailblock.com",sid_token:"tokentokentoken"})
      : Response.json({list:[{mail_id:"1",mail_subject:"Your code is 482516",mail_excerpt:"",mail_read:"1"}]}),
  });
  const result=await new TubotSfAuthEntrypoint(null,await fixture()).invokeFlowWithContext({teamId:"team",orgId,channelId:"channel"},
    {apiVersion:"67.0",route,arguments:{}});
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject([{outputValues:{isVerified:true}}]);
  expect(JSON.stringify(result.contextSchema)).not.toContain("secret-challenge");
  expect(JSON.stringify(result.contextSchema)).not.toContain("482516");
  const invoked = seen.find(item=>item.url.pathname===route && item.method==="POST");
  expect(JSON.parse(String(invoked?.body)).inputs[0]).toMatchObject({customerCode:"482516",customerId:id});
  expect(seen.some(item=>item.url.pathname===`${root}/sobjects/Contact/${id}` && item.method==="DELETE")).toBe(true);
});

test("verification context rejects an unverified consumer outcome and still cleans up", async () => {
  const root = "/services/data/v67.0";
  const route = `${root}/actions/custom/flow/Pkg__VerifyCode`;
  const producer = `${root}/actions/custom/flow/Pkg__SendVerificationCode`;
  const id = "003000000000001AAA";
  let email = "";
  const seen = mockSalesforce({
    [route]: init => init?.method === "POST" ? Response.json([{isSuccess:true,errors:[],outputValues:{isVerified:false,
      messageAfterVerification:"done",Flow__InterviewStatus:"Finished",Flow__InterviewGuid:"g"}}])
      : Response.json({inputs:["customerCode","customerId","customerType","authenticationKey"].map(name=>({name,type:"STRING"})),
        outputs:[{name:"isVerified",type:"BOOLEAN"},{name:"messageAfterVerification",type:"STRING"}]}),
    [`${root}/actions/custom/flow`]: {actions:[{name:"Pkg__SendVerificationCode",url:producer}]},
    [producer]: init => init?.method === "POST" ? Response.json([{isSuccess:true,errors:[],outputValues:{verificationCode:"xxxxxx",
      authenticationKey:"key",customerId:id,customerType:"Contact"}}])
      : Response.json({inputs:[{name:"customerToVerify",type:"STRING"}],outputs:["verificationCode","authenticationKey","customerId","customerType"].map(name=>({name}))}),
    [`${root}/sobjects/Contact/describe`]: {fields:[{name:"Email",type:"email",createable:true,nillable:true},
      {name:"LastName",type:"string",createable:true,nillable:false}]},
    [`${root}/sobjects/Contact`]: init=>{email=JSON.parse(String(init?.body)).Email;return Response.json({id,success:true},{status:201});},
    [`${root}/sobjects/Contact/${id}`]: init=>init?.method === "DELETE"?new Response(null,{status:204}):Response.json({Id:id,Email:email}),
    ["/ajax.php"]: (_init,url) => url.searchParams.get("f") === "get_email_address"
      ? Response.json({email_addr:"probe@guerrillamailblock.com",sid_token:"tokentokentoken"})
      : Response.json({list:[{mail_id:"1",mail_subject:"Your code is 482516",mail_excerpt:"",mail_read:"1"}]}),
  });
  const result=await new TubotSfAuthEntrypoint(null,await fixture()).invokeFlowWithContext({teamId:"team",orgId,channelId:"channel"},
    {apiVersion:"67.0",route,arguments:{}});
  expect(result.status).toBe(422);
  expect(JSON.stringify(result.body)).toContain("FLOW_VERIFY_CHAIN_CONSUMER_UNVERIFIED");
  expect(seen.some(item=>item.url.pathname===`${root}/sobjects/Contact/${id}` && item.method==="DELETE")).toBe(true);
});

test("global Quick Actions verify and clean only the unique created tenant record", async () => {
  const root = "/services/data/v67.0", route = `${root}/actions/custom/quickAction/Global/TenantAction`;
  const id = "a01000000000001AAA"; let marker = ""; let deleted = false;
  const seen = mockSalesforce({
    [`${root}/quickActions/TenantAction/describe`]: { type: "Create", targetSobjectType: "Tenant_Record__c" },
    [route]: init => {
      if (init?.method !== "POST") return Response.json({ targetEntityName: "Tenant_Record__c", inputs: [{ name: "Name", type: "STRING" }] });
      marker = JSON.parse(String(init.body)).inputs[0].Name;
      return Response.json([{ isSuccess: true, errors: [], outputValues: {} }]);
    },
    [`${root}/sobjects/Tenant_Record__c/describe`]: { queryable: true, deletable: true,
      fields: [{ name: "Name", nameField: true, type: "string", nillable: false, createable: true, filterable: true, length: 80 }] },
    [`${root}/query`]: (_init, url) => {
      expect(url.searchParams.get("q")).toContain(marker);
      return Response.json({ records: [{ Id: id }] });
    },
    [`${root}/sobjects/Tenant_Record__c/${id}`]: init => {
      if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      return deleted ? Response.json([{ errorCode: "NOT_FOUND" }], { status: 404 }) : Response.json({ Id: id, Name: marker });
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeQuickActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route });
  expect(result.status).toBe(200);
  expect(result.cleanupError).toBeUndefined();
  expect(result.contextSchema).toMatchObject({ targetObject: "Tenant_Record__c", verified: true, verificationRecordIds: [id] });
  expect(seen.at(-1)?.method).toBe("GET");
  await expect(new TubotSfAuthEntrypoint(null, await fixture(false)).invokeQuickActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route })).rejects.toThrow("channel_not_authorized");
});

test("object Quick Actions update only a freshly created tenant context", async () => {
  const root = "/services/data/v67.0", route = `${root}/actions/custom/quickAction/Tenant_Record__c/TenantUpdate`;
  const id = "a01000000000001AAA"; let marker = "", changed = "", deleted = false;
  mockSalesforce({
    [`${root}/sobjects/Tenant_Record__c/quickActions/TenantUpdate/describe`]: { type: "Update", targetSobjectType: "Tenant_Record__c" },
    [route]: init => {
      if (init?.method !== "POST") return Response.json({ targetEntityName: "Tenant_Record__c", inputs: [{ name: "contextId", required: true }, { name: "TenantField__c" }] });
      const args = JSON.parse(String(init.body)).inputs[0];
      expect(args.contextId).toBe(id); changed = args.TenantField__c;
      return Response.json([{ isSuccess: true, errors: [] }]);
    },
    [`${root}/sobjects/Tenant_Record__c/describe`]: { queryable: true, deletable: true, fields: [
      { name: "Name", nameField: true, type: "string", nillable: false, createable: true, filterable: true, length: 80 },
      { name: "TenantField__c", type: "string", nillable: true, createable: true, updateable: true, length: 80 }] },
    [`${root}/sobjects/Tenant_Record__c`]: init => { marker = JSON.parse(String(init?.body)).Name; return Response.json({ id }, { status: 201 }); },
    [`${root}/query`]: { records: [{ Id: id }] },
    [`${root}/sobjects/Tenant_Record__c/${id}`]: init => {
      if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      return deleted ? Response.json([], { status: 404 }) : Response.json({ Id: id, Name: marker, TenantField__c: changed });
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeQuickActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route });
  expect(result.status).toBe(200);
  expect(result.contextSchema).toMatchObject({ verified: true, mutationKind: "update", changedFields: ["TenantField__c"] });
  expect(result.cleanupError).toBeUndefined();
  expect(deleted).toBe(true);
});

test("context-fixture Quick Actions post to an owned parent and address the owned context record", async () => {
  const root = "/services/data/v67.0", route = `${root}/actions/custom/quickAction/FeedItem/TenantTaskFromFeed`;
  const accountId = "001000000000001AAA", feedId = "0D5000000000001AAA", taskId = "00T000000000001AAA";
  let accountMarker = "", taskMarker = "", contextId = "";
  const gone = new Set<string>();
  mockSalesforce({
    [`${root}/sobjects/FeedItem/quickActions/TenantTaskFromFeed/describe`]: { type: "Create", targetSobjectType: "Task", contextSobjectType: "FeedItem" },
    [route]: init => {
      if (init?.method !== "POST") return Response.json({ targetEntityName: "Task", inputs: [{ name: "contextId", required: true }, { name: "Subject" }] });
      const args = JSON.parse(String(init.body)).inputs[0];
      contextId = args.contextId;
      taskMarker = args.Subject;
      return Response.json([{ isSuccess: true, errors: [] }]);
    },
    [`${root}/sobjects/Task/describe`]: { queryable: true, deletable: true, fields: [
      { name: "Subject", type: "combobox", nillable: true, createable: true, filterable: true, length: 255 }] },
    [`${root}/sobjects/FeedItem/describe`]: { createable: true, queryable: true, deletable: true, fields: [
      { name: "ParentId", type: "reference", createable: true, nillable: false, referenceTo: ["Account", "Contact"] },
      { name: "Body", type: "textarea", createable: true, nillable: true }] },
    [`${root}/sobjects/Account/describe`]: { createable: true, queryable: true, deletable: true, fields: [
      { name: "Name", nameField: true, type: "string", nillable: false, createable: true, filterable: true, length: 255 }] },
    [`${root}/sobjects/Account`]: init => { accountMarker = JSON.parse(String(init?.body)).Name; return Response.json({ id: accountId }, { status: 201 }); },
    [`${root}/sobjects/FeedItem`]: init => {
      expect(JSON.parse(String(init?.body)).ParentId).toBe(accountId);
      return Response.json({ id: feedId }, { status: 201 });
    },
    [`${root}/query`]: (_init, url) => {
      const q = url.searchParams.get("q") ?? "";
      const rows: Array<{ Id: string }> = [];
      if (q.includes("FROM Account") && q.includes(accountMarker) && accountMarker && !gone.has(accountId)) rows.push({ Id: accountId });
      if (q.includes("FROM FeedItem") && q.includes(accountId) && !gone.has(feedId)) rows.push({ Id: feedId });
      if (q.includes("FROM Task") && taskMarker && q.includes(taskMarker) && !gone.has(taskId)) rows.push({ Id: taskId });
      return Response.json({ done: true, records: rows });
    },
    [`${root}/sobjects/Account/${accountId}`]: init => {
      if (init?.method === "DELETE") { gone.add(accountId); return new Response(null, { status: 204 }); }
      return gone.has(accountId) ? Response.json([], { status: 404 }) : Response.json({ Id: accountId, Name: accountMarker });
    },
    [`${root}/sobjects/FeedItem/${feedId}`]: init => {
      if (init?.method === "DELETE") { gone.add(feedId); return new Response(null, { status: 204 }); }
      return gone.has(feedId) ? Response.json([], { status: 404 }) : Response.json({ Id: feedId, ParentId: accountId });
    },
    [`${root}/sobjects/Task/${taskId}`]: init => {
      if (init?.method === "DELETE") { gone.add(taskId); return new Response(null, { status: 204 }); }
      return gone.has(taskId) ? Response.json([], { status: 404 }) : Response.json({ Id: taskId, Subject: taskMarker });
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeQuickActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route });
  expect(contextId).toBe(feedId);
  expect(result.status).toBe(200);
  expect(result.contextSchema).toMatchObject({ verified: true, mutationKind: "create", contextFixtureRecordId: feedId, verificationRecordIds: [taskId] });
  expect(result.cleanupError).toBeUndefined();
  expect(taskMarker.length).toBeGreaterThan(10);
});

test("required target references seed live foreign keys for owned update contexts", async () => {
  const root = "/services/data/v67.0", route = `${root}/actions/custom/quickAction/MessagingSession/TenantEscalate`;
  const sessionId = "0Mw000000000001AAA", channelId = "0Mj000000000001AAA", endUserId = "0Mu000000000001AAA";
  let marker = "", changed: unknown = "", deleted = false;
  mockSalesforce({
    [`${root}/sobjects/MessagingSession/quickActions/TenantEscalate/describe`]: { type: "Update", targetSobjectType: "MessagingSession", contextSobjectType: "MessagingSession" },
    [route]: init => {
      if (init?.method !== "POST") return Response.json({ targetEntityName: "MessagingSession",
        inputs: [{ name: "contextId", required: true }, { name: "TenantFlag__c", type: "BOOLEAN" }] });
      const args = JSON.parse(String(init.body)).inputs[0];
      expect(args.contextId).toBe(sessionId);
      expect(args.MessagingChannelId).toBeUndefined();
      changed = args.TenantFlag__c;
      return Response.json([{ isSuccess: true, errors: [] }]);
    },
    [`${root}/sobjects/MessagingSession/describe`]: { queryable: true, deletable: true, fields: [
      { name: "MessagingChannelId", type: "reference", createable: true, nillable: false, referenceTo: ["MessagingChannel"] },
      { name: "MessagingEndUserId", type: "reference", createable: true, nillable: false, referenceTo: ["MessagingEndUser"] },
      { name: "Subject", type: "string", nillable: true, createable: true, filterable: true, length: 80 },
      { name: "TenantFlag__c", type: "boolean", nillable: true, createable: true, updateable: true }] },
    [`${root}/sobjects/MessagingSession`]: init => {
      const values = JSON.parse(String(init?.body));
      expect(values.MessagingChannelId).toBe(channelId);
      expect(values.MessagingEndUserId).toBe(endUserId);
      expect(values.Status).toBe("Ended");
      marker = values.Subject;
      return Response.json({ id: sessionId }, { status: 201 });
    },
    [`${root}/query`]: (_init, url) => {
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("FROM MessagingChannel")) return Response.json({ records: [{ Id: channelId }] });
      if (q.includes("FROM MessagingEndUser")) return Response.json({ records: [{ Id: endUserId }] });
      if (q.includes("FROM MessagingSession")) return Response.json({ done: true, records: deleted || !marker ? [] : [{ Id: sessionId }] });
      return Response.json({ records: [] });
    },
    [`${root}/sobjects/MessagingSession/${sessionId}`]: init => {
      if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      return deleted ? Response.json([], { status: 404 }) : Response.json({ Id: sessionId, Subject: marker, TenantFlag__c: changed });
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeQuickActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route });
  expect(result.status).toBe(200);
  expect(result.contextSchema).toMatchObject({ verified: true, mutationKind: "update" });
  expect(result.cleanupError).toBeUndefined();
  expect(deleted).toBe(true);
});

test("Flow record input fixtures come from the live catalog and are deleted after a rejection", async () => {
  const root = "/services/data/v67.0";
  const route = `${root}/actions/custom/flow/TenantBrief`;
  const id = "a01000000000001AAA";
  let name = ""; let deleted = false;
  const seen = mockSalesforce({
    [route]: init => init?.method === "POST" ? Response.json([{ isSuccess: false, errors: [{ message: "Upstream Flow fault" }] }], { status: 400 })
      : Response.json({ inputs: [{ name: "subjectRecord", type: "SOBJECT", sObjectType: "Tenant_Record__c", maxOccurs: 1 }] }),
    [`${root}/query`]: (_init, url) => {
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("FROM EntityDefinition") && q.includes("Tenant_Record__c")) {
        return Response.json({ records: [{ QualifiedApiName: "Tenant_Record__c" }] });
      }
      return Response.json({ records: [] });
    },
    [`${root}/sobjects/Tenant_Record__c/describe`]: { createable: true, queryable: true, deletable: true, fields: [{ name: "Name", type: "string", nillable: false, createable: true, updateable: true }] },
    [`${root}/sobjects/Tenant_Record__c`]: init => { name = JSON.parse(String(init?.body)).Name; return Response.json({ id, success: true }, { status: 201 }); },
    [`${root}/sobjects/Tenant_Record__c/${id}`]: init => {
      if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      return deleted ? Response.json([{ errorCode: "NOT_FOUND" }], { status: 404 }) : Response.json({ Id: id, Name: name,
        CreatedDate: "2026-10-07T00:00:00.000+0000", CreatedById: "005000000000000AAA", SystemModstamp: "2026-10-07T00:00:00.000+0000" });
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeFlowWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { apiVersion: "67.0", route, arguments: {} });
  expect(result.status).toBe(400);
  expect(result.cleanupError).toBeUndefined();
  expect(result.contextSchema).toMatchObject({ source: "salesforce_live_flow_record_inputs",
    mappings: [{ inputName: "subjectRecord", objectName: "Tenant_Record__c" }] });
  const invocation = seen.find(item => item.url.pathname === route && item.method === "POST");
  expect(JSON.parse(String(invocation?.body)).inputs[0].subjectRecord).toEqual({ attributes: { type: "Tenant_Record__c" }, Id: id, Name: name });
  expect(seen.some(item => item.url.pathname === `${root}/query` &&
    (item.url.searchParams.get("q") ?? "").includes("FROM EntityDefinition"))).toBe(true);
  expect(seen.some(item => item.url.pathname === `${root}/sobjects/`)).toBe(false);
  expect(seen.at(-1)?.method).toBe("GET");
});

test("Flow recordId scalar binds the owned fixture instead of passing caller identity", async () => {
  const root = "/services/data/v67.0";
  const route = `${root}/actions/custom/flow/TenantBrief`;
  const id = "a01000000000001AAA";
  let name = ""; let deleted = false;
  const seen = mockSalesforce({
    [route]: init => init?.method === "POST" ? Response.json([{ isSuccess: true, errors: null, outputValues: {} }])
      : Response.json({ inputs: [{ name: "subjectRecord", type: "SOBJECT", sObjectType: "Tenant_Record__c", maxOccurs: 1 },
        { name: "recordId", type: "STRING", maxOccurs: 1 }] }),
    [`${root}/query`]: (_init, url) => {
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("FROM EntityDefinition") && q.includes("Tenant_Record__c")) {
        return Response.json({ records: [{ QualifiedApiName: "Tenant_Record__c" }] });
      }
      return Response.json({ records: [] });
    },
    [`${root}/sobjects/Tenant_Record__c/describe`]: { createable: true, queryable: true, deletable: true, fields: [{ name: "Name", type: "string", nillable: false, createable: true, updateable: true }] },
    [`${root}/sobjects/Tenant_Record__c`]: init => { name = JSON.parse(String(init?.body)).Name; return Response.json({ id, success: true }, { status: 201 }); },
    [`${root}/sobjects/Tenant_Record__c/${id}`]: init => {
      if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      return deleted ? Response.json([{ errorCode: "NOT_FOUND" }], { status: 404 }) : Response.json({ Id: id, Name: name });
    },
  });
  // A caller-supplied foreign identity in recordId must neither refuse the
  // probe nor reach the interview: it rebinds to the owned fixture id.
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeFlowWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { apiVersion: "67.0", route, arguments: { recordId: "a01000000000099AAA" } });
  expect(result.status).toBe(200);
  expect(result.cleanupError).toBeUndefined();
  const invocation = seen.find(item => item.url.pathname === route && item.method === "POST");
  expect(JSON.parse(String(invocation?.body)).inputs[0].recordId).toBe(id);
  expect(deleted).toBe(true);
});

test("Flow attested synthesis skips the foreign-identity scan; unattested does not", async () => {
  const root = "/services/data/v67.0";
  const route = `${root}/actions/custom/flow/TenantUpdateBrief`;
  const id = "a01000000000001AAA";
  let name = "";
  const seen = mockSalesforce({
    [route]: init => init?.method === "POST" ? Response.json([{ isSuccess: true, errors: null, outputValues: {} }])
      : Response.json({ inputs: [{ name: "subjectRecord", type: "SOBJECT", sObjectType: "Tenant_Record__c", maxOccurs: 1 },
        { name: "noteId", type: "STRING", maxOccurs: 1 }] }),
    [`${root}/query`]: (_init, url) => {
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("FROM EntityDefinition") && q.includes("Tenant_Record__c")) {
        return Response.json({ records: [{ QualifiedApiName: "Tenant_Record__c" }] });
      }
      return Response.json({ records: [] });
    },
    [`${root}/sobjects/Tenant_Record__c/describe`]: { createable: true, queryable: true, deletable: true, fields: [{ name: "Name", type: "string", nillable: false, createable: true, updateable: true }] },
    [`${root}/sobjects/Tenant_Record__c`]: init => { name = JSON.parse(String(init?.body)).Name; return Response.json({ id, success: true }, { status: 201 }); },
    [`${root}/sobjects/Tenant_Record__c/${id}`]: init =>
      init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ Id: id, Name: name }),
  });
  const entry = async () => new TubotSfAuthEntrypoint(null, await fixture());
  const attested = await (await entry()).invokeFlowWithContext(
    { teamId: "team", orgId, channelId: "channel" },
    { apiVersion: "67.0", route, arguments: { noteId: "a02000000000001AAA" }, argumentsSynthetic: true });
  expect(attested.status).toBe(200);
  const invocation = seen.find(item => item.url.pathname === route && item.method === "POST");
  expect(JSON.parse(String(invocation?.body)).inputs[0].noteId).toBe("a02000000000001AAA");
  const refused = await (await entry()).invokeFlowWithContext(
    { teamId: "team", orgId, channelId: "channel" },
    { apiVersion: "67.0", route, arguments: { noteId: "a02000000000001AAA" } });
  expect(refused.status).toBe(422);
  expect((refused.body as any).errorCode).toBe("FLOW_RECORD_LIVE_INPUT_REFUSED");
});

test("Flow record fixtures refuse undeletable targets before minting anything", async () => {
  // ITSM record types (Incident/ChangeRequest) are createable but not
  // deletable: minting one manufactures orphan residue plus a guaranteed
  // cleanup failure. The preflight refuses on live describe truth with no
  // POST, no fixture, and no cleanup error.
  const root = "/services/data/v67.0";
  const route = `${root}/actions/custom/flow/TenantSummarize`;
  const seen = mockSalesforce({
    [route]: () => Response.json({ inputs: [{ name: "objectToSummarize", type: "SOBJECT", sObjectType: "Incident", maxOccurs: 1 }] }),
    [`${root}/query`]: (_init, url) => {
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("FROM EntityDefinition")) return Response.json({ records: [{ QualifiedApiName: "Incident" }] });
      return Response.json({ records: [] });
    },
    [`${root}/sobjects/Incident/describe`]: { createable: true, queryable: true, deletable: false,
      fields: [{ name: "Subject", type: "string", nillable: false, createable: true }] },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeFlowWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { apiVersion: "67.0", route, arguments: {} });
  expect(result.status).toBe(422);
  expect(result.body).toMatchObject({ errorCode: "FLOW_RECORD_FIXTURE_PERMISSIONS_REQUIRED" });
  expect(result.cleanupError).toBeUndefined();
  expect(seen.some(item => item.method === "POST")).toBe(false);
});

test("Flow record fixtures borrow required references from live lookups", async () => {
  const root = "/services/data/v67.0";
  const route = `${root}/actions/custom/flow/TenantTriage`;
  const id = "a01000000000011AAA", hoursId = "01m000000000001AAA", accountId = "001000000000001AAA";
  let name = ""; let deleted = false; let posted: any = null;
  const seen = mockSalesforce({
    [route]: init => init?.method === "POST" ? Response.json([{ isSuccess: true, errors: [] }])
      : Response.json({ inputs: [{ name: "caseRecord", type: "SOBJECT", sObjectType: "Tenant_Case__c", maxOccurs: 1 }] }),
    [`${root}/query`]: (_init, url) => {
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("FROM EntityDefinition")) return Response.json({ records: [{ QualifiedApiName: "Tenant_Case__c" }] });
      if (q.includes("FROM Tenant_Hours__c")) return Response.json({ records: [{ Id: hoursId }] });
      if (q.includes("FROM Tenant_A__c")) return Response.json({ records: [] });
      if (q.includes("FROM Tenant_B__c")) return Response.json({ records: [{ Id: accountId }] });
      return Response.json({ records: [] });
    },
    [`${root}/sobjects/Tenant_Case__c/describe`]: { createable: true, queryable: true, deletable: true, fields: [
      { name: "Name", type: "string", nillable: false, createable: true },
      { name: "HoursId", type: "reference", nillable: false, defaultedOnCreate: false, createable: true, referenceTo: ["Tenant_Hours__c"] },
      { name: "RelatedId", type: "reference", nillable: false, defaultedOnCreate: false, createable: true, referenceTo: ["Tenant_A__c", "Tenant_B__c"] },
    ] },
    [`${root}/sobjects/Tenant_Case__c`]: init => { posted = JSON.parse(String(init?.body)); name = posted.Name; return Response.json({ id }, { status: 201 }); },
    [`${root}/sobjects/Tenant_Case__c/${id}`]: init => {
      if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      return deleted ? Response.json([{ errorCode: "NOT_FOUND" }], { status: 404 }) : Response.json({ Id: id, Name: name });
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeFlowWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { apiVersion: "67.0", route, arguments: {} });
  expect(result.status).toBe(200);
  expect(result.cleanupError).toBeUndefined();
  expect(result.contextSchema).toMatchObject({ source: "salesforce_live_flow_record_inputs" });
  // Single-target borrow plus polymorphic first-live pick (Tenant_A rowless, Tenant_B live).
  expect(posted.HoursId).toBe(hoursId);
  expect(posted.RelatedId).toBe(accountId);
  expect(deleted).toBe(true);
  expect(seen.some(item => item.method === "POST" && item.url.pathname === `${root}/sobjects/Tenant_Hours__c`)).toBe(false);
});

test("Flow record fixtures mint owned parents for rowless single-target references", async () => {
  const root = "/services/data/v67.0";
  const route = `${root}/actions/custom/flow/TenantPayout`;
  const parentId = "a02000000000001AAA", childId = "a03000000000001AAA";
  let parentName = "", childName = "";
  const deleted: string[] = [];
  let childPosted: any = null;
  mockSalesforce({
    [route]: init => init?.method === "POST" ? Response.json([{ isSuccess: true, errors: [] }])
      : Response.json({ inputs: [{ name: "payout", type: "SOBJECT", sObjectType: "Tenant_Payout__c", maxOccurs: 1 }] }),
    [`${root}/query`]: (_init, url) => {
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("FROM EntityDefinition")) return Response.json({ records: [{ QualifiedApiName: "Tenant_Payout__c" }] });
      return Response.json({ records: [] });
    },
    [`${root}/sobjects/Tenant_Payout__c/describe`]: { createable: true, queryable: true, deletable: true, fields: [
      { name: "Name", type: "string", nillable: false, createable: true },
      { name: "ProgramId", type: "reference", nillable: false, defaultedOnCreate: false, createable: true, referenceTo: ["Tenant_Program__c"] },
    ] },
    [`${root}/sobjects/Tenant_Program__c/describe`]: { createable: true, queryable: true, deletable: true, fields: [
      { name: "Name", type: "string", nillable: false, createable: true },
    ] },
    [`${root}/sobjects/Tenant_Program__c`]: init => { parentName = JSON.parse(String(init?.body)).Name; return Response.json({ id: parentId }, { status: 201 }); },
    [`${root}/sobjects/Tenant_Payout__c`]: init => { childPosted = JSON.parse(String(init?.body)); childName = childPosted.Name; return Response.json({ id: childId }, { status: 201 }); },
    [`${root}/sobjects/Tenant_Program__c/${parentId}`]: init => {
      if (init?.method === "DELETE") { deleted.push("parent"); return new Response(null, { status: 204 }); }
      return deleted.includes("parent") ? Response.json([], { status: 404 }) : Response.json({ Id: parentId, Name: parentName });
    },
    [`${root}/sobjects/Tenant_Payout__c/${childId}`]: init => {
      if (init?.method === "DELETE") { deleted.push("child"); return new Response(null, { status: 204 }); }
      return deleted.includes("child") ? Response.json([], { status: 404 }) : Response.json({ Id: childId, Name: childName });
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeFlowWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { apiVersion: "67.0", route, arguments: {} });
  expect(result.status).toBe(200);
  expect(result.cleanupError).toBeUndefined();
  expect(childPosted.ProgramId).toBe(parentId);
  expect(parentName).toContain("Action Searcher temporary flow parent");
  // Ordered cleanup deletes the child before its owned parent.
  expect(deleted).toEqual(["child", "parent"]);
});

test("Mutating flow fixtures mint owned parents and never borrow live rows", async () => {
  const root = "/services/data/v67.0";
  const route = `${root}/actions/custom/flow/Tenant_Update_Record`;
  const parentId = "a02000000000011AAA", childId = "a03000000000011AAA", liveHoursId = "01m000000000011AAA";
  let parentName = "", childName = "";
  const deleted: string[] = [];
  let childPosted: any = null;
  const seen = mockSalesforce({
    [route]: init => init?.method === "POST" ? Response.json([{ isSuccess: true, errors: [] }])
      : Response.json({ inputs: [{ name: "caseRecord", type: "SOBJECT", sObjectType: "Tenant_Case__c", maxOccurs: 1 }], outputs: [] }),
    [`${root}/query`]: (_init, url) => {
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("FROM EntityDefinition")) return Response.json({ records: [{ QualifiedApiName: "Tenant_Case__c" }] });
      // Tenant_Hours__c has no IsDefault column, so setup-default lookups
      // match nothing; a live row exists, but the mutating flow must never
      // bind it.
      if (q.includes("FROM Tenant_Hours__c")) {
        return Response.json({ records: q.includes("IsDefault") ? [] : [{ Id: liveHoursId }] });
      }
      return Response.json({ records: [] });
    },
    [`${root}/sobjects/Tenant_Case__c/describe`]: { createable: true, queryable: true, deletable: true, fields: [
      { name: "Name", type: "string", nillable: false, createable: true },
      { name: "HoursId", type: "reference", nillable: false, defaultedOnCreate: false, createable: true, referenceTo: ["Tenant_Hours__c"] },
    ] },
    [`${root}/sobjects/Tenant_Hours__c/describe`]: { createable: true, queryable: true, deletable: true, fields: [
      { name: "Name", type: "string", nillable: false, createable: true },
    ] },
    [`${root}/sobjects/Tenant_Hours__c`]: init => { parentName = JSON.parse(String(init?.body)).Name; return Response.json({ id: parentId }, { status: 201 }); },
    [`${root}/sobjects/Tenant_Case__c`]: init => { childPosted = JSON.parse(String(init?.body)); childName = childPosted.Name; return Response.json({ id: childId }, { status: 201 }); },
    [`${root}/sobjects/Tenant_Hours__c/${parentId}`]: init => {
      if (init?.method === "DELETE") { deleted.push("parent"); return new Response(null, { status: 204 }); }
      return deleted.includes("parent") ? Response.json([], { status: 404 }) : Response.json({ Id: parentId, Name: parentName });
    },
    [`${root}/sobjects/Tenant_Case__c/${childId}`]: init => {
      if (init?.method === "DELETE") { deleted.push("child"); return new Response(null, { status: 204 }); }
      return deleted.includes("child") ? Response.json([], { status: 404 }) : Response.json({ Id: childId, Name: childName });
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeFlowWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { apiVersion: "67.0", route, arguments: {} });
  expect(result.status).toBe(200);
  expect(result.cleanupError).toBeUndefined();
  // Owned mint, not the live row.
  expect(childPosted.HoursId).toBe(parentId);
  expect(childPosted.HoursId).not.toBe(liveHoursId);
  // No customer row was ever read for binding: only IsDefault-filtered
  // setup lookups (which matched nothing) plus the schema catalog ran.
  expect(seen.some(item => item.url.pathname === `${root}/query` &&
    (item.url.searchParams.get("q") ?? "").includes("FROM Tenant_Hours__c") &&
    !(item.url.searchParams.get("q") ?? "").includes("IsDefault"))).toBe(false);
  expect(result.contextSchema).toMatchObject({ source: "salesforce_live_flow_record_inputs", ownedReferencesOnly: true });
  expect(deleted).toEqual(["child", "parent"]);
});

test("Mutating flow with unmintable references refuses without borrowing or posting", async () => {
  const root = "/services/data/v67.0";
  const route = `${root}/actions/custom/flow/Tenant_Update_Record`;
  const seen = mockSalesforce({
    [route]: init => init?.method === "POST" ? Response.json([{ isSuccess: true, errors: [] }])
      : Response.json({ inputs: [{ name: "caseRecord", type: "SOBJECT", sObjectType: "Tenant_Case__c", maxOccurs: 1 }], outputs: [] }),
    [`${root}/query`]: (_init, url) => {
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("FROM EntityDefinition")) return Response.json({ records: [{ QualifiedApiName: "Tenant_Case__c" }] });
      // Live rows exist on both polymorphic targets; neither may be read.
      // Neither target has an IsDefault column, so setup-default lookups
      // match nothing.
      if (q.includes("FROM Tenant_A__c")) return Response.json({ records: q.includes("IsDefault") ? [] : [{ Id: "001000000000011AAA" }] });
      if (q.includes("FROM Tenant_B__c")) return Response.json({ records: q.includes("IsDefault") ? [] : [{ Id: "001000000000012AAA" }] });
      return Response.json({ records: [] });
    },
    [`${root}/sobjects/Tenant_Case__c/describe`]: { createable: true, queryable: true, deletable: true, fields: [
      { name: "Name", type: "string", nillable: false, createable: true },
      { name: "RelatedId", type: "reference", nillable: false, defaultedOnCreate: false, createable: true, referenceTo: ["Tenant_A__c", "Tenant_B__c"] },
    ] },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeFlowWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { apiVersion: "67.0", route, arguments: {} });
  expect(result.status).toBe(422);
  expect(result.body).toMatchObject({ errorCode: "OWNED_CONTEXT_REQUIRED_REFERENCE_UNRESOLVED" });
  // Honest refusal: no fixture created, no flow invoked, no live row read.
  expect(seen.every(item => item.method !== "POST")).toBe(true);
  expect(seen.some(item => item.url.pathname === `${root}/query` &&
    /(FROM Tenant_A__c|FROM Tenant_B__c)/.test(item.url.searchParams.get("q") ?? "") &&
    !(item.url.searchParams.get("q") ?? "").includes("IsDefault"))).toBe(false);
  expect(result.contextSchema).toMatchObject({ source: "salesforce_live_flow_record_inputs", ownedReferencesOnly: true });
});

test("Mutating flow refuses identity-shaped caller scalars before anything is created", async () => {
  const root = "/services/data/v67.0";
  const route = `${root}/actions/custom/flow/Tenant_Update_Record`;
  const seen = mockSalesforce({
    [route]: init => init?.method === "POST" ? Response.json([{ isSuccess: true, errors: [] }])
      : Response.json({ inputs: [
        { name: "caseRecord", type: "SOBJECT", sObjectType: "Tenant_Case__c", maxOccurs: 1 },
        { name: "contactId", type: "STRING" },
      ], outputs: [] }),
    [`${root}/query`]: (_init, url) => {
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("FROM EntityDefinition")) return Response.json({ records: [{ QualifiedApiName: "Tenant_Case__c" }] });
      return Response.json({ records: [] });
    },
    [`${root}/sobjects/Tenant_Case__c/describe`]: { createable: true, queryable: true, deletable: true, fields: [
      { name: "Name", type: "string", nillable: false, createable: true },
    ] },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeFlowWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { apiVersion: "67.0", route, arguments: { contactId: "003000000000001AAA" } });
  expect(result.status).toBe(422);
  expect(result.body).toMatchObject({ errorCode: "FLOW_RECORD_LIVE_INPUT_REFUSED" });
  expect(JSON.stringify(result.body)).not.toContain("003000000000001AAA");
  expect(seen.every(item => item.method !== "POST")).toBe(true);
  expect(result.contextSchema).toMatchObject({ source: "salesforce_live_flow_record_inputs", ownedReferencesOnly: true });
});

test("Read-only flow keeps borrowing required references from live lookups", async () => {
  const root = "/services/data/v67.0";
  const route = `${root}/actions/custom/flow/Tenant_Get_Summary`;
  const id = "a01000000000021AAA", hoursId = "01m000000000021AAA";
  let name = ""; let deleted = false; let posted: any = null;
  const seen = mockSalesforce({
    [route]: init => init?.method === "POST" ? Response.json([{ isSuccess: true, errors: [] }])
      : Response.json({ description: "Gets a case summary.",
        inputs: [{ name: "caseRecord", type: "SOBJECT", sObjectType: "Tenant_Case__c", maxOccurs: 1 }], outputs: [] }),
    [`${root}/query`]: (_init, url) => {
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("FROM EntityDefinition")) return Response.json({ records: [{ QualifiedApiName: "Tenant_Case__c" }] });
      if (q.includes("FROM Tenant_Hours__c")) return Response.json({ records: [{ Id: hoursId }] });
      return Response.json({ records: [] });
    },
    [`${root}/sobjects/Tenant_Case__c/describe`]: { createable: true, queryable: true, deletable: true, fields: [
      { name: "Name", type: "string", nillable: false, createable: true },
      { name: "HoursId", type: "reference", nillable: false, defaultedOnCreate: false, createable: true, referenceTo: ["Tenant_Hours__c"] },
    ] },
    [`${root}/sobjects/Tenant_Case__c`]: init => { posted = JSON.parse(String(init?.body)); name = posted.Name; return Response.json({ id }, { status: 201 }); },
    [`${root}/sobjects/Tenant_Case__c/${id}`]: init => {
      if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      return deleted ? Response.json([{ errorCode: "NOT_FOUND" }], { status: 404 }) : Response.json({ Id: id, Name: name });
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeFlowWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { apiVersion: "67.0", route, arguments: {} });
  expect(result.status).toBe(200);
  expect(result.cleanupError).toBeUndefined();
  expect(posted.HoursId).toBe(hoursId);
  expect(seen.some(item => item.url.pathname === `${root}/query` &&
    (item.url.searchParams.get("q") ?? "").includes("FROM Tenant_Hours__c"))).toBe(true);
  expect(result.contextSchema).toMatchObject({ source: "salesforce_live_flow_record_inputs" });
  expect("ownedReferencesOnly" in (result.contextSchema as Record<string, unknown>)).toBe(false);
  expect(deleted).toBe(true);
});

test("polymorphic required references bind the first live target in describe order", async () => {
  const root = "/services/data/v67.0", route = `${root}/actions/custom/quickAction/Tenant_Widget__c/TenantFix`;
  const widgetId = "a04000000000001AAA", firstId = "a05000000000001AAA";
  let marker = ""; let changed: unknown = ""; let deleted = false;
  mockSalesforce({
    [`${root}/sobjects/Tenant_Widget__c/quickActions/TenantFix/describe`]: { type: "Update", targetSobjectType: "Tenant_Widget__c", contextSobjectType: "Tenant_Widget__c" },
    [route]: init => {
      if (init?.method !== "POST") return Response.json({ targetEntityName: "Tenant_Widget__c",
        inputs: [{ name: "contextId", required: true }, { name: "TenantFlag__c", type: "BOOLEAN" }] });
      changed = JSON.parse(String(init.body)).inputs[0].TenantFlag__c;
      return Response.json([{ isSuccess: true, errors: [] }]);
    },
    [`${root}/sobjects/Tenant_Widget__c/describe`]: { queryable: true, deletable: true, fields: [
      { name: "AnchorId", type: "reference", createable: true, nillable: false, referenceTo: ["Tenant_First__c", "Tenant_Second__c"] },
      { name: "Subject", type: "string", nillable: true, createable: true, filterable: true, length: 80 },
      { name: "TenantFlag__c", type: "boolean", nillable: true, createable: true, updateable: true },
    ] },
    [`${root}/sobjects/Tenant_Widget__c`]: init => {
      const values = JSON.parse(String(init?.body));
      expect(values.AnchorId).toBe(firstId);
      marker = values.Subject;
      return Response.json({ id: widgetId }, { status: 201 });
    },
    [`${root}/query`]: (_init, url) => {
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("FROM Tenant_First__c")) return Response.json({ records: [{ Id: firstId }] });
      if (q.includes("FROM Tenant_Second__c")) return Response.json({ records: [{ Id: "a06000000000001AAA" }] });
      if (q.includes("FROM Tenant_Widget__c")) return Response.json({ done: true, records: deleted || !marker ? [] : [{ Id: widgetId }] });
      return Response.json({ records: [] });
    },
    [`${root}/sobjects/Tenant_Widget__c/${widgetId}`]: init => {
      if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      return deleted ? Response.json([], { status: 404 }) : Response.json({ Id: widgetId, Subject: marker, TenantFlag__c: changed });
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeQuickActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route });
  expect(result.status).toBe(200);
  expect(result.contextSchema).toMatchObject({ verified: true });
  expect(result.cleanupError).toBeUndefined();
  expect(deleted).toBe(true);
});


test("child Quick Action grounds its parent from live metadata and cleans both owned records", async () => {
  const root = "/services/data/v67.0", target = "Tenant_Record__c";
  const route = `${root}/actions/custom/quickAction/${target}/TenantChild`;
  const parentId = "a01000000000001AAA", childId = "a01000000000002AAA";
  let parentMarker = "", childMarker = "";
  const deleted = new Set<string>();
  mockSalesforce({
    [`${root}/sobjects/${target}/quickActions/TenantChild/describe`]: {
      type: "Create", contextSobjectType: target, targetSobjectType: target, targetParentField: "Parent__c" },
    [route]: init => {
      if (init?.method !== "POST") return Response.json({ targetEntityName: target,
        inputs: [{ name: "Name" }, { name: "contextId", required: true }, { name: "Parent__c" }] });
      const args = JSON.parse(String(init.body)).inputs[0];
      expect(args.contextId).toBe(parentId); expect(args.Parent__c).toBe(parentId);
      childMarker = args.Name;
      return Response.json([{ isSuccess: true, errors: [] }]);
    },
    [`${root}/sobjects/${target}/describe`]: { queryable: true, deletable: true, fields: [
      { name: "Name", nameField: true, type: "string", nillable: false, createable: true, filterable: true, length: 80 },
      { name: "Parent__c", type: "reference", referenceTo: [target], nillable: true, createable: true }] },
    [`${root}/sobjects/${target}`]: init => { parentMarker = JSON.parse(String(init?.body)).Name; return Response.json({ id: parentId }, { status: 201 }); },
    [`${root}/query`]: (_init, url) => Response.json({ records: url.searchParams.get("q")?.includes(parentMarker) ? [{ Id: parentId }] : childMarker ? [{ Id: childId }] : [] }),
    ...Object.fromEntries([parentId, childId].map(id => [`${root}/sobjects/${target}/${id}`, (init: RequestInit) => {
      if (init?.method === "DELETE") { deleted.add(id); return new Response(null, { status: 204 }); }
      return deleted.has(id) ? Response.json([], { status: 404 }) : Response.json({ Id: id,
        Name: id === parentId ? parentMarker : childMarker, ...(id === childId ? { Parent__c: parentId } : {}) });
    }])),
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeQuickActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route });
  expect(result.status).toBe(200);
  expect(result.contextSchema).toMatchObject({ verified: true, mutationKind: "create", parentField: "Parent__c", parentContextRecordId: parentId });
  expect(deleted.size).toBe(2);
  expect(result.cleanupError).toBeUndefined();
});

test("owned Quick Action context deletion is withheld when fresh ownership readback fails", async () => {
  const root = "/services/data/v67.0", route = `${root}/actions/custom/quickAction/Tenant_Record__c/TenantUpdate`;
  const id = "a01000000000001AAA"; let marker = "", changed = "", deleted = false;
  mockSalesforce({
    [`${root}/sobjects/Tenant_Record__c/quickActions/TenantUpdate/describe`]: { type: "Update", targetSobjectType: "Tenant_Record__c" },
    [route]: init => {
      if (init?.method !== "POST") return Response.json({ targetEntityName: "Tenant_Record__c", inputs: [{ name: "contextId", required: true }, { name: "TenantField__c" }] });
      const args = JSON.parse(String(init.body)).inputs[0];
      expect(args.contextId).toBe(id); changed = args.TenantField__c;
      return Response.json([{ isSuccess: true, errors: [] }]);
    },
    [`${root}/sobjects/Tenant_Record__c/describe`]: { queryable: true, deletable: true, fields: [
      { name: "Name", nameField: true, type: "string", nillable: false, createable: true, filterable: true, length: 80 },
      { name: "TenantField__c", type: "string", nillable: true, createable: true, updateable: true, length: 80 }] },
    [`${root}/sobjects/Tenant_Record__c`]: init => { marker = JSON.parse(String(init?.body)).Name; return Response.json({ id }, { status: 201 }); },
    [`${root}/query`]: { records: [{ Id: id }] },
    [`${root}/sobjects/Tenant_Record__c/${id}`]: init => {
      if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      if (changed && !deleted) return Response.json({ errorCode: "SERVER_UNAVAILABLE" }, { status: 503 });
      return deleted ? Response.json([], { status: 404 }) : Response.json({ Id: id, Name: marker, TenantField__c: changed });
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeQuickActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route });
  expect(result.status).toBe(422);
  expect(result.contextSchema).toMatchObject({ verified: false, mutationKind: "update", changedFields: ["TenantField__c"] });
  expect(result.cleanupError).toContain("ownership readback failed");
  expect(deleted).toBe(false);
});

test("cross-object Quick Action creates and cleans its discovered parent context", async () => {
  const root = "/services/data/v67.0", target = "Tenant_Record__c";
  const context = "Tenant_Context__c";
  const route = `${root}/actions/custom/quickAction/${context}/TenantChild`;
  const parentId = "a01000000000001AAA", childId = "a01000000000002AAA";
  let parentMarker = "", childMarker = "";
  const deleted = new Set<string>();
  mockSalesforce({
    [`${root}/sobjects/${context}/quickActions/TenantChild/describe`]: {
      type: "Create", contextSobjectType: context, targetSobjectType: target, targetParentField: "Parent__c" },
    [route]: init => {
      if (init?.method !== "POST") return Response.json({ targetEntityName: target,
        inputs: [{ name: "Name" }, { name: "contextId", required: true }, { name: "Parent__c" }] });
      const args = JSON.parse(String(init.body)).inputs[0];
      expect(args.contextId).toBe(parentId); expect(args.Parent__c).toBe(parentId);
      childMarker = args.Name;
      return Response.json([{ isSuccess: true, errors: [] }]);
    },
    [`${root}/sobjects/${target}/describe`]: { queryable: true, deletable: true, fields: [
      { name: "Name", nameField: true, type: "string", nillable: false, createable: true, filterable: true, length: 80 },
      { name: "Parent__c", type: "reference", referenceTo: [context], nillable: false, createable: true }] },
    [`${root}/sobjects/${context}/describe`]: { queryable: true, deletable: true, fields: [{ name: "Name", nameField: true, type: "string", nillable: false, createable: true, filterable: true, length: 80 }] },
    [`${root}/sobjects/${context}`]: init => { parentMarker = JSON.parse(String(init?.body)).Name; return Response.json({ id: parentId }, { status: 201 }); },
    [`${root}/query`]: (_init, url) => Response.json({ records: url.searchParams.get("q")?.includes(parentMarker) ? [{ Id: parentId }] : childMarker ? [{ Id: childId }] : [] }),
    ...Object.fromEntries([parentId, childId].map(id => [`${root}/sobjects/${id === parentId ? context : target}/${id}`, (init: RequestInit) => {
      if (init?.method === "DELETE") { deleted.add(id); return new Response(null, { status: 204 }); }
      return deleted.has(id) ? Response.json([], { status: 404 }) : Response.json({ Id: id,
        Name: id === parentId ? parentMarker : childMarker, ...(id === childId ? { Parent__c: parentId } : {}) });
    }])),
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeQuickActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route });
  expect(result.status).toBe(200);
  expect(result.contextSchema).toMatchObject({ verified: true, mutationKind: "create", parentField: "Parent__c", parentContextRecordId: parentId });
  expect(deleted.size).toBe(2);
  expect(result.cleanupError).toBeUndefined();
});

test("cross-object Quick Action parents seed required references from live lookups", async () => {
  const root = "/services/data/v67.0", target = "Tenant_Record__c";
  const context = "Tenant_Context__c";
  const route = `${root}/actions/custom/quickAction/${context}/TenantChild`;
  const parentId = "a01000000000001AAA", childId = "a01000000000002AAA", liveHoursId = "a03000000000001AAA";
  let parentMarker = "", childMarker = "", parentHours = "";
  const deleted = new Set<string>();
  mockSalesforce({
    [`${root}/sobjects/${context}/quickActions/TenantChild/describe`]: {
      type: "Create", contextSobjectType: context, targetSobjectType: target, targetParentField: "Parent__c" },
    [route]: init => {
      if (init?.method !== "POST") return Response.json({ targetEntityName: target,
        inputs: [{ name: "Name" }, { name: "contextId", required: true }, { name: "Parent__c" }] });
      const args = JSON.parse(String(init.body)).inputs[0];
      expect(args.contextId).toBe(parentId); expect(args.Parent__c).toBe(parentId);
      childMarker = args.Name;
      return Response.json([{ isSuccess: true, errors: [] }]);
    },
    [`${root}/sobjects/${target}/describe`]: { queryable: true, deletable: true, fields: [
      { name: "Name", nameField: true, type: "string", nillable: false, createable: true, filterable: true, length: 80 },
      { name: "Parent__c", type: "reference", referenceTo: [context], nillable: false, createable: true }] },
    [`${root}/sobjects/${context}/describe`]: { queryable: true, deletable: true, fields: [
      { name: "Name", nameField: true, type: "string", nillable: false, createable: true, filterable: true, length: 80 },
      { name: "HoursId", type: "reference", referenceTo: ["Tenant_Hours__c"], nillable: false, defaultedOnCreate: false, createable: true }] },
    [`${root}/sobjects/${context}`]: init => { const values = JSON.parse(String(init?.body));
      parentMarker = values.Name; parentHours = values.HoursId; return Response.json({ id: parentId }, { status: 201 }); },
    [`${root}/query`]: (_init, url) => {
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("FROM Tenant_Hours__c")) return Response.json({ records: [{ Id: liveHoursId }] });
      return Response.json({ records: q.includes(parentMarker) && parentMarker ? [{ Id: parentId }] : childMarker ? [{ Id: childId }] : [] });
    },
    ...Object.fromEntries([parentId, childId].map(id => [`${root}/sobjects/${id === parentId ? context : target}/${id}`, (init: RequestInit) => {
      if (init?.method === "DELETE") { deleted.add(id); return new Response(null, { status: 204 }); }
      return deleted.has(id) ? Response.json([], { status: 404 }) : Response.json({ Id: id,
        Name: id === parentId ? parentMarker : childMarker, ...(id === childId ? { Parent__c: parentId } : {}) });
    }])),
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeQuickActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route });
  expect(parentHours).toBe(liveHoursId);
  expect(result.status).toBe(200);
  expect(result.contextSchema).toMatchObject({ verified: true, mutationKind: "create", parentContextRecordId: parentId });
  expect(deleted.size).toBe(2);
  expect(result.cleanupError).toBeUndefined();
});

test('required fixture references cannot borrow the first existing tenant record', async () => {
  const root = '/services/data/v67.0', target = 'Discovered_Child__c', route = root + '/actions/standard/createRecord';
  let lookedUpExisting = false, wroteFixture = false, invokedAction = false;
  mockSalesforce({
    [route]: init => {
      if (init?.method === 'POST') invokedAction = true;
      return Response.json({ inputs: ['objectApiName', 'recordData'].map(name => ({ name })) });
    },
    [root + '/sobjects/' + target + '/describe']: { createable: true, deletable: true, queryable: true, fields: [
      { name: 'Name', nameField: true, type: 'string', nillable: false, createable: true, filterable: true, length: 80 },
      { name: 'Parent__c', type: 'reference', nillable: false, defaultedOnCreate: false, createable: true, referenceTo: ['Discovered_Parent__c'] },
    ] },
    [root + '/query']: () => { lookedUpExisting = true; return Response.json({ records: [{ Id: 'a01000000000001AAA' }] }); },
    [root + '/sobjects/' + target]: () => { wroteFixture = true; return Response.json({ id: 'a01000000000002AAA' }, { status: 201 }); },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeRecordActionWithContext(
    { teamId: 'team', orgId, channelId: 'channel' }, { route, objectApiName: target });
  expect(result.status).toBe(422);
  expect(result.body).toMatchObject({ errorCode: 'OWNED_CONTEXT_REQUIRED_REFERENCE_UNRESOLVED' });
  expect(lookedUpExisting).toBe(false);
  expect(wroteFixture).toBe(false);
  expect(invokedAction).toBe(false);
});

for (const action of ["createRecord", "updateRecord"]) test(`standard ${action} verifies and deletes only its owned fixture`, async () => {
  const root = "/services/data/v67.0", target = "Tenant_Record__c", route = `${root}/actions/standard/${action}`;
  const id = "a01000000000001AAA"; let name = "", deleted = false;
  mockSalesforce({
    [route]: init => {
      if (init?.method !== "POST") return Response.json({ inputs: ["objectApiName", "recordData", "recordId"].map(name => ({ name })) });
      const args = JSON.parse(String(init.body)).inputs[0];
      expect(args.objectApiName).toBe(target);
      if (action === "updateRecord") expect(args.recordId).toBe(id);
      name = args.recordData.Name;
      return Response.json([{ isSuccess: true, errors: [] }]);
    },
    [`${root}/sobjects/${target}/describe`]: { createable: true, deletable: true, queryable: true, fields: [
      { name: "Name", nameField: true, type: "string", nillable: false, createable: true, updateable: true, filterable: true, length: 80 }] },
    [`${root}/sobjects/${target}`]: init => { name = JSON.parse(String(init?.body)).Name; return Response.json({ id }, { status: 201 }); },
    [`${root}/query`]: { records: [{ Id: id }] },
    [`${root}/sobjects/${target}/${id}`]: init => {
      if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      return deleted ? Response.json([], { status: 404 }) : Response.json({ Id: id, Name: name });
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeRecordActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route, objectApiName: target });
  expect(result.status).toBe(200);
  expect(result.contextSchema).toMatchObject({ verified: true, source: "salesforce_live_record_action", verificationRecordIds: [id] });
  expect(result.cleanupError).toBeUndefined(); expect(deleted).toBe(true);
  await expect(new TubotSfAuthEntrypoint(null, await fixture(false)).invokeRecordActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route, objectApiName: target })).rejects.toThrow("channel_not_authorized");
});

for (const action of ["updateRecord"]) test(`rejected standard ${action} cleans its owned fixture`, async () => {
  const root = "/services/data/v67.0", target = "Tenant_Record__c", route = `${root}/actions/standard/${action}`;
  const id = "a01000000000001AAA"; let name = "", deleted = false;
  mockSalesforce({
    [route]: init => {
      if (init?.method !== "POST") return Response.json({ inputs: ["objectApiName", "recordData", "recordId"].map(name => ({ name })) });
      const args = JSON.parse(String(init.body)).inputs[0];
      expect(args.objectApiName).toBe(target);
      if (action === "updateRecord") expect(args.recordId).toBe(id);

      return Response.json([{ isSuccess: false, errors: [{ message: "Tenant validation rejected the action" }] }]);
    },
    [`${root}/sobjects/${target}/describe`]: { createable: true, deletable: true, queryable: true, fields: [
      { name: "Name", nameField: true, type: "string", nillable: false, createable: true, updateable: true, filterable: true, length: 80 }] },
    [`${root}/sobjects/${target}`]: init => { name = JSON.parse(String(init?.body)).Name; return Response.json({ id }, { status: 201 }); },
    [`${root}/query`]: { records: [{ Id: id }] },
    [`${root}/sobjects/${target}/${id}`]: init => {
      if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      return deleted ? Response.json([], { status: 404 }) : Response.json({ Id: id, Name: name });
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeRecordActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route, objectApiName: target });
  expect(result.status).toBe(200);
  expect(result.contextSchema).toMatchObject({ verified: false, source: "salesforce_live_record_action", verificationRecordIds: [] });
  expect(result.cleanupError).toBeUndefined(); expect(deleted).toBe(true);
  await expect(new TubotSfAuthEntrypoint(null, await fixture(false)).invokeRecordActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route, objectApiName: target })).rejects.toThrow("channel_not_authorized");
});

for (const action of ["createRecord"]) test(`unverified standard ${action} rejects a success response without a real record`, async () => {
  const root = "/services/data/v67.0", target = "Tenant_Record__c", route = `${root}/actions/standard/${action}`;
  const id = "a01000000000001AAA"; let name = "", deleted = false;
  mockSalesforce({
    [route]: init => {
      if (init?.method !== "POST") return Response.json({ inputs: ["objectApiName", "recordData", "recordId"].map(name => ({ name })) });
      const args = JSON.parse(String(init.body)).inputs[0];
      expect(args.objectApiName).toBe(target);
      if (action === "updateRecord") expect(args.recordId).toBe(id);
      name = args.recordData.Name;
      return Response.json([{ isSuccess: true, errors: [] }]);
    },
    [`${root}/sobjects/${target}/describe`]: { createable: true, deletable: true, queryable: true, fields: [
      { name: "Name", nameField: true, type: "string", nillable: false, createable: true, updateable: true, filterable: true, length: 80 }] },
    [`${root}/sobjects/${target}`]: init => { name = JSON.parse(String(init?.body)).Name; return Response.json({ id }, { status: 201 }); },
    [`${root}/query`]: { records: [] },
    [`${root}/sobjects/${target}/${id}`]: init => {
      if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      return deleted ? Response.json([], { status: 404 }) : Response.json({ Id: id, Name: name });
    },
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeRecordActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route, objectApiName: target });
  expect(result.status).toBe(422);
  expect(result.contextSchema).toMatchObject({ verified: false, source: "salesforce_live_record_action", verificationRecordIds: [] });
  expect(result.cleanupError).toBeUndefined(); expect(deleted).toBe(false);
  await expect(new TubotSfAuthEntrypoint(null, await fixture(false)).invokeRecordActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route, objectApiName: target })).rejects.toThrow("channel_not_authorized");
});

test("Flow creation prepares live parent inputs and verifies and cleans actual children", async () => {
  const root = "/services/data/v67.0", route = `${root}/actions/custom/flow/TenantCreate`;
  const parentId = "a01000000000001AAA", childId = "a02000000000001AAA";
  let marker = "", invoked = false; const deleted = new Set<string>();
  mockSalesforce({
    [route]: init => {
      if (init?.method !== "POST") return Response.json({ inputs: [{ name: "parentId", type: "STRING" }, { name: "amount", type: "DOUBLE" }] });
      const args = JSON.parse(String(init.body)).inputs[0]; expect(args.parentId).toBe(parentId); expect(args.amount).toBe(1); invoked = true;
      return Response.json([{ isSuccess: true, errors: [] }]);
    },
    [`${root}/tooling/query`]: (_init, url) => url.searchParams.get("q")?.includes("SELECT Metadata") ? Response.json({ records: [{ Metadata: {
      variables: [{ name: "parentId", isInput: true, dataType: "String" }, { name: "amount", isInput: true, dataType: "Number" }],
      recordCreates: [{ object: "Tenant_Child__c", inputAssignments: [{ field: "Parent__c", value: { elementReference: "parentId" } },
        { field: "Value__c", value: { elementReference: "amount" } }] }],
    } }] }) : Response.json({ records: [{ DeveloperName: "TenantCreate", ActiveVersionId: "301000000000001AAA" }] }),
    [`${root}/sobjects/Tenant_Child__c/describe`]: { deletable: true, queryable: true, fields: [
      { name: "Parent__c", type: "reference", referenceTo: ["Tenant_Parent__c"] }, { name: "Value__c", type: "currency" }] },
    [`${root}/sobjects/Tenant_Parent__c/describe`]: { name: "Tenant_Parent__c", createable: true, deletable: true, queryable: true, fields: [
      { name: "Name", type: "string", createable: false, filterable: true, nameField: true, nillable: false, length: 121 },
      { name: "FirstName", type: "string", createable: true, filterable: true, compoundFieldName: "Name", nillable: true, length: 80 },
      { name: "LastName", type: "string", createable: true, filterable: true, compoundFieldName: "Name", nillable: false, length: 80 }] },
    [`${root}/sobjects/Tenant_Parent__c`]: init => { marker = JSON.parse(String(init?.body)).LastName; return Response.json({ id: parentId }, { status: 201 }); },
    [`${root}/query`]: (_init, url) => Response.json({ records: url.searchParams.get("q")?.includes("FROM Tenant_Parent__c") ? marker && !deleted.has(parentId) ? [{ Id: parentId }] : [] : invoked && !deleted.has(childId) ? [{ Id: childId }] : [] }),
    [`${root}/composite/batch`]: init => Response.json({ results: JSON.parse(String(init?.body)).batchRequests.map((operation: any) => {
      const id = operation.url.split("/").at(-1);
      if (operation.method === "DELETE") { deleted.add(id); return { statusCode: 204 }; }
      const exists = id === parentId ? !!marker : id === childId && invoked;
      return deleted.has(id) || !exists ? { statusCode: 404 } : { statusCode: 200, result: id === parentId ? { Id: id, LastName: marker } : { Id: id, Parent__c: parentId, Value__c: 1 } };
    }) }),
    ...Object.fromEntries([["Tenant_Parent__c", parentId], ["Tenant_Child__c", childId]].map(([type, id]) => [`${root}/sobjects/${type}/${id}`, (init: RequestInit) => {
      if (init?.method === "DELETE") { deleted.add(id); return new Response(null, { status: 204 }); }
      return deleted.has(id) ? Response.json([], { status: 404 }) : Response.json(id === parentId ? { Id: id, LastName: marker } : { Id: id, Parent__c: parentId, Value__c: 1 });
    }])),
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeFlowCreationWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route });
  expect(result.status).toBe(200); expect(invoked).toBe(true); expect(deleted.size).toBe(2);
  expect(result.contextSchema).toMatchObject({ source: "salesforce_live_flow_creation", verified: true,
    verificationRecordIds: [childId], expectedChanges: { Parent__c: parentId, Value__c: 1 } });
  expect(result.cleanupError).toBeUndefined();
});

test("Flow creation creates required references in an empty org and cleans the entire chain", async () => {
  const root = "/services/data/v67.0", route = `${root}/actions/custom/flow/TenantCreate`;
  const parentId = "a01000000000001AAA", childId = "a02000000000001AAA";
  const dependencyId = "a03000000000001AAA";
  let marker = "", dependencyName = "", invoked = false; const deleted = new Set<string>();
  mockSalesforce({
    [route]: init => {
      if (init?.method !== "POST") return Response.json({ inputs: [{ name: "parentId", type: "STRING" }, { name: "amount", type: "DOUBLE" }] });
      const args = JSON.parse(String(init.body)).inputs[0]; expect(args.parentId).toBe(parentId); expect(args.amount).toBe(1); invoked = true;
      return Response.json([{ isSuccess: true, errors: [] }]);
    },
    [`${root}/tooling/query`]: (_init, url) => url.searchParams.get("q")?.includes("SELECT Metadata") ? Response.json({ records: [{ Metadata: {
      variables: [{ name: "parentId", isInput: true, dataType: "String" }, { name: "amount", isInput: true, dataType: "Number" }],
      recordCreates: [{ object: "Tenant_Child__c", inputAssignments: [{ field: "Parent__c", value: { elementReference: "parentId" } },
        { field: "Value__c", value: { elementReference: "amount" } }] }],
    } }] }) : Response.json({ records: [{ DeveloperName: "TenantCreate", ActiveVersionId: "301000000000001AAA" }] }),
    [`${root}/sobjects/Tenant_Child__c/describe`]: { deletable: true, queryable: true, fields: [
      { name: "Parent__c", type: "reference", referenceTo: ["Tenant_Parent__c"] }, { name: "Value__c", type: "currency" }] },
    [`${root}/sobjects/Tenant_Parent__c/describe`]: { name: "Tenant_Parent__c", createable: true, deletable: true, queryable: true, fields: [
      { name: "Name", type: "string", createable: true, filterable: true, nameField: true, nillable: false, length: 80 },
      { name: "Dependency__c", type: "reference", createable: true, nillable: false, referenceTo: ["Tenant_Dependency__c"] }] },
    [`${root}/sobjects/Tenant_Dependency__c/describe`]: { name: "Tenant_Dependency__c", createable: true, deletable: true, queryable: true, fields: [{ name: "Name", type: "string", createable: true, filterable: true, nillable: false, nameField: true, length: 80 }] },
    [`${root}/sobjects/Tenant_Dependency__c`]: init => { dependencyName = JSON.parse(String(init?.body)).Name; return Response.json({ id: dependencyId }, { status: 201 }); },
    [`${root}/sobjects/Tenant_Parent__c`]: init => { expect(JSON.parse(String(init?.body)).Dependency__c).toBe(dependencyId); marker = JSON.parse(String(init?.body)).Name; return Response.json({ id: parentId }, { status: 201 }); },
    [`${root}/query`]: (_init, url) => {
      const query = url.searchParams.get("q") ?? "";
      const candidate = query.includes("FROM Tenant_Dependency__c") ? dependencyName ? dependencyId : undefined : query.includes("FROM Tenant_Parent__c") ? marker ? parentId : undefined : invoked ? childId : undefined;
      return Response.json({ records: candidate && !deleted.has(candidate) ? [{ Id: candidate }] : [] });
    },
    [`${root}/composite/batch`]: init => Response.json({ results: JSON.parse(String(init?.body)).batchRequests.map((operation: any) => {
      const id = operation.url.split("/").at(-1);
      if (operation.method === "DELETE") { deleted.add(id); return { statusCode: 204 }; }
      const exists = id === parentId ? !!marker : id === dependencyId ? !!dependencyName : id === childId && invoked;
      return deleted.has(id) || !exists ? { statusCode: 404 } : { statusCode: 200, result: id === parentId ? { Id: id, Name: marker, Dependency__c: dependencyId } : id === dependencyId ? { Id: id, Name: dependencyName } : { Id: id, Parent__c: parentId, Value__c: 1 } };
    }) }),
    ...Object.fromEntries([["Tenant_Parent__c", parentId], ["Tenant_Child__c", childId], ["Tenant_Dependency__c", dependencyId]].map(([type, id]) => [`${root}/sobjects/${type}/${id}`, (init: RequestInit) => {
      if (init?.method === "DELETE") { deleted.add(id); return new Response(null, { status: 204 }); }
      return deleted.has(id) ? Response.json([], { status: 404 }) : Response.json(id === parentId ? { Id: id, Name: marker, Dependency__c: dependencyId } : id === dependencyId ? { Id: id, Name: dependencyName } : { Id: id, Parent__c: parentId, Value__c: 1 });
    }])),
  });
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeFlowCreationWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route });
  expect(result.status).toBe(200); expect(invoked).toBe(true); expect(deleted.size).toBe(3);
  expect(result.contextSchema).toMatchObject({ source: "salesforce_live_flow_creation", verified: true,
    verificationRecordIds: [childId], expectedChanges: { Parent__c: parentId, Value__c: 1 } });
  expect(result.cleanupError).toBeUndefined();
});

for (const action of ["createInvRsvForCart", "deleteInvRsvForCart"]) test(`inventory ${action} dispatches to the owned lifecycle without any Salesforce mutation`, async () => {
  const seen = mockSalesforce({});
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeRecordActionWithContext(
    { teamId: "team", orgId, channelId: "channel" },
    { route: `/services/data/v67.0/actions/standard/${action}`, objectApiName: "WebCart" });
  expect(result.status).toBe(404);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen[0].url.pathname).toContain("/composite/batch");
  expect(seen.every(item => item.method === "GET" || item.url.pathname.includes("/composite/batch"))).toBe(true);
  expect(seen.some(item => item.method === "POST" && item.url.pathname.includes("/sobjects/"))).toBe(false);
  expect(result.cleanupError).toBeUndefined();
});

for (const action of ["createInvRsvForCart", "deleteInvRsvForCart"]) test(`inventory ${action} requires WebCart context`, async () => {
  mockSalesforce({});
  await expect(new TubotSfAuthEntrypoint(null, await fixture()).invokeRecordActionWithContext(
    { teamId: "team", orgId, channelId: "channel" },
    { route: `/services/data/v67.0/actions/standard/${action}`, objectApiName: "Account" })).rejects.toThrow("invalid_inventory_context");
});

test("guest-buyer registerGuestBuyer dispatches to the owned lifecycle", async () => {
  const seen = mockSalesforce({});
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeRecordActionWithContext(
    { teamId: "team", orgId, channelId: "channel" },
    { route: "/services/data/v67.0/actions/standard/registerGuestBuyer", objectApiName: "WebStore" });
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every(item => item.method === "GET")).toBe(true);
  expect(result.cleanupError).toBeUndefined();
  await expect(new TubotSfAuthEntrypoint(null, await fixture()).invokeRecordActionWithContext(
    { teamId: "team", orgId, channelId: "channel" },
    { route: "/services/data/v67.0/actions/standard/registerGuestBuyer", objectApiName: "WebCart" })).rejects.toThrow("invalid_guest_buyer_context");
});

test("search-rule createSearchBoostBuryRule dispatches to the owned lifecycle", async () => {
  const seen = mockSalesforce({});
  const result = await new TubotSfAuthEntrypoint(null, await fixture()).invokeRecordActionWithContext(
    { teamId: "team", orgId, channelId: "channel" },
    { route: "/services/data/v67.0/actions/standard/createSearchBoostBuryRule", objectApiName: "WebStore" });
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every(item => item.method === "GET")).toBe(true);
  expect(result.cleanupError).toBeUndefined();
  await expect(new TubotSfAuthEntrypoint(null, await fixture()).invokeRecordActionWithContext(
    { teamId: "team", orgId, channelId: "channel" },
    { route: "/services/data/v67.0/actions/standard/createSearchBoostBuryRule", objectApiName: "WebCart" })).rejects.toThrow("invalid_search_rule_context");
});

for (const action of ["addCartItem", "updateCartItem"]) test(`cart item ${action} requires WebCart context`, async () => {
  mockSalesforce({});
  await expect(new TubotSfAuthEntrypoint(null, await fixture()).invokeRecordActionWithContext(
    { teamId: "team", orgId, channelId: "channel" },
    { route: `/services/data/v67.0/actions/standard/${action}`, objectApiName: "Account" })).rejects.toThrow("invalid_cart_context");
});

test("inspectSalesforce folds eligible GETs into one composite batch per version", async () => {
  const batchPath = "/services/data/v67.0/composite/batch";
  const seen = mockSalesforce({
    [batchPath]: (init) => {
      expect(init?.method).toBe("POST");
      const sent = JSON.parse(String(init?.body)).batchRequests;
      expect(sent).toHaveLength(23);
      expect(sent.every((r: any) => r.method === "GET" && r.url.startsWith("v67.0/"))).toBe(true);
      return Response.json({ hasErrors: false,
        results: sent.map((r: any, i: number) => ({ statusCode: 200, result: { echo: r.url, slot: i } })) });
    },
    "/services/data/v67.0/tooling/query": () => Response.json({ records: [] }),
  });
  const gets = Array.from({ length: 23 }, (_, i) => ({
    method: "GET" as const, path: `/services/data/v67.0/actions/standard/probe${i}`,
  }));
  const tooling = [0, 1].map(() => ({
    method: "GET" as const, path: "/services/data/v67.0/tooling/query?q=SELECT+Id+FROM+FlowDefinitionView+LIMIT+1",
  }));
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const result = await entrypoint.inspectSalesforce({ teamId: "team", orgId, channelId: "channel" }, [...gets, ...tooling]);
  expect(result).toHaveLength(25);
  result.slice(0, 23).forEach((row, i) => {
    expect(row.status).toBe(200);
    expect(row.body).toEqual({ echo: `v67.0/actions/standard/probe${i}`, slot: i });
  });
  // One batch transport + two direct Tooling transports (Tooling never folds).
  expect(seen.filter((s) => s.url.pathname === batchPath)).toHaveLength(1);
  expect(seen).toHaveLength(3);
});

test("inspectSalesforce encodes quotes in batch subrequest urls", async () => {
  const batchPath = "/services/data/v67.0/composite/batch";
  const seen = mockSalesforce({
    [batchPath]: (init) => {
      const sent = JSON.parse(String(init?.body)).batchRequests;
      expect(sent[0].url).not.toContain("'");
      expect(sent[0].url).toContain("%27");
      return Response.json({ results: [
        { statusCode: 200, result: { records: [] } },
        { statusCode: 200, result: { name: "getRecord", inputs: [] } },
      ] });
    },
  });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  // Singles keep the direct path (no round-trip saved by a one-item batch),
  // so the encoding check needs a two-item batch to reach the subrequest URL.
  const path = "/services/data/v67.0/query?q=SELECT%20Id%20FROM%20Account%20WHERE%20Name='ACTIVE'%20LIMIT%201";
  const result = await entrypoint.inspectSalesforce({ teamId: "team", orgId, channelId: "channel" }, [
    { method: "GET", path },
    { method: "GET", path: "/services/data/v67.0/actions/standard/getRecord" },
  ]);
  expect(result).toEqual([
    { status: 200, body: { records: [] } },
    { status: 200, body: { name: "getRecord", inputs: [] } },
  ]);
  expect(seen).toHaveLength(1);
});

test("inspectSalesforce falls back to direct fetches when the batch envelope fails", async () => {
  const batchPath = "/services/data/v67.0/composite/batch";
  const seen = mockSalesforce({
    [batchPath]: () => new Response("batch exploded", { status: 500 }),
    "/services/data/v67.0/actions/standard/getRecord": { name: "getRecord", inputs: [] },
    "/services/data/v67.0/actions/standard/getRelatedList": { name: "getRelatedList", inputs: [] },
  });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const result = await entrypoint.inspectSalesforce({ teamId: "team", orgId, channelId: "channel" }, [
    { method: "GET", path: "/services/data/v67.0/actions/standard/getRecord" },
    { method: "GET", path: "/services/data/v67.0/actions/standard/getRelatedList" },
  ]);
  expect(result).toEqual([
    { status: 200, body: { name: "getRecord", inputs: [] } },
    { status: 200, body: { name: "getRelatedList", inputs: [] } },
  ]);
  expect(seen.filter((s) => s.url.pathname === batchPath)).toHaveLength(1);
  expect(seen).toHaveLength(3);
});
