import { afterEach, expect, test } from "bun:test";
import worker, { TubotSfAuthEntrypoint, MessagingProxyBroker, assertProxyDeployment, __resetPanelCredentialCacheForTests } from "./index";
import { injectSoapSession, SOAP_SESSION_PLACEHOLDER } from "./soap-session";
import { browserConfig, verifyBrowserTurn } from "./browser-echo";
import { echoParameters, validGuestId, qualifyDefinitionName, flipDefinitionTwin, isDefinitionInvalidInput } from "./echo-params";
import { turnScopeMatches } from "../../tubot-sf-proxy/src/contracts";

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  __resetPanelCredentialCacheForTests();
});

const orgId = "00D000000000001AAA";
const userId = "005000000000001AAA";
const keyBytes = new Uint8Array(32).fill(7);
const encryptionKey = btoa(String.fromCharCode(...keyBytes));

async function fixture(active = true) {
  const row = {
    team_id: "team", org_id: orgId, channel_id: "channel",
    instance_url: "https://test.my.salesforce.com",
    integration_user_id: userId, integration_username: "integration@example.com",
    is_sandbox: 1,
  };
  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async run() { return { success: true }; },
            async first() {
              if (sql.includes("FROM panel_salesforce_channels") ||
                  sql.includes("panel_salesforce_execution_users")) {
                return active ? row : null;
              }
              return null;
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };
  const PANEL_JWT_SIGNER = {
    async signAssertion(_input: unknown) { return "test-assertion"; },
  };
  // Business-logic suite: RPC envelope enforcement is covered in rpc-signing.test.ts,
  // so this fixture runs in warn mode and exercises method bodies without envelopes.
  return { DB: db, SF_CREDENTIAL_ENCRYPTION_KEY: encryptionKey, PANEL_JWT_SIGNER, row, AUTH_RPC_WARN_MODE: "1" };
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
  const overLimit = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName LIKE '%x%' LIMIT 500");
  await expect(entrypoint.inspectSalesforce(
    { teamId: "team", orgId, channelId: "channel" },
    [{ method: "GET", path: evil }],
  )).rejects.toThrow("invalid_api_path");
  await expect(entrypoint.inspectSalesforce(
    { teamId: "team", orgId, channelId: "channel" },
    [{ method: "GET", path: overLimit }],
  )).rejects.toThrow("invalid_api_path");
  // Bounded-SELECT contract: a broad OR filter with LIMIT <= 50 is still a
  // capped read (no stacking, no DML), so the native QueryRecords shape
  // allows it; only unbounded/destructive shapes reject.
  const broadOr = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName LIKE '%x%' OR 1=1 LIMIT 50");
  const broadResult = await entrypoint.inspectSalesforce(
    { teamId: "team", orgId, channelId: "channel" },
    [{ method: "GET", path: broadOr }],
  );
  expect(broadResult[0].status).toBe(200);
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
  // Bounded-SELECT contract: two capped fields are a bounded read now.
  const wide = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT Id, TimeZoneSidKey FROM Organization LIMIT 1");
  await expect(entrypoint.inspectSalesforce(ref,
    [{ method: "GET", path: over }])).rejects.toThrow("invalid_api_path");
  expect((await entrypoint.inspectSalesforce(ref,
    [{ method: "GET", path: wide }]))[0].status).toBe(200);
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
  // Bounded-SELECT contract: LIMIT 9 is a capped read now; the LIMIT 200
  // shapes still reject unless they match the exact Swarm carve-out.
  const wide = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT Id FROM Account LIMIT 9");
  expect((await entrypoint.inspectSalesforce(ref,
    [{ method: "GET", path: wide }]))[0].status).toBe(200);
  const otherObject = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT RelatedRecordId FROM Case WHERE Status != 'Closed' LIMIT 200");
  const otherFilter = "/services/data/v67.0/query?q=" + encodeURIComponent(
    "SELECT RelatedRecordId FROM Swarm LIMIT 200");
  for (const path of [otherObject, otherFilter]) {
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
  await expect(entrypoint.inspectSalesforce(ref,
    [{ method: "GET", path: noLimit }])).rejects.toThrow("invalid_api_path");
  // Bounded-SELECT contract: capped reads with broader filters/fields are
  // allowed now; only unbounded shapes reject.
  for (const query of ["SELECT Id FROM Conversation WHERE ConversationIdentifier = 'x' OR Name LIKE '%25' LIMIT 1",
    "SELECT Id, Body FROM MessagingSession WHERE ConversationId = '0dwg5000000xMcPAAU' LIMIT 1"]) {
    const allowed = await entrypoint.inspectSalesforce(ref, [{ method: "GET",
      path: "/services/data/v67.0/query?q=" + encodeURIComponent(query) }]);
    expect(allowed[0].status).toBe(200);
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

test('scoped inspection permits read-only single-row fetch by record ID', async () => {
  const path = '/services/data/v67.0/sobjects/Contact/003000000000001AAA';
  mockSalesforce({ [path]: { Id: '003000000000001AAA', Name: 'Ada' } });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const ref = { teamId: 'team', orgId, channelId: 'channel' };
  expect((await entrypoint.inspectSalesforce(ref, [{ method: 'GET', path }]))[0].status).toBe(200);
  await expect(entrypoint.inspectSalesforce(ref, [{ method: 'POST', path }])).rejects.toThrow('invalid_api_path');
  await expect(entrypoint.inspectSalesforce(ref, [{ method: 'GET', path: '/services/data/v67.0/sobjects/Contact/short' }])).rejects.toThrow('invalid_api_path');
  await expect(entrypoint.inspectSalesforce(ref, [{ method: 'GET', path: '/services/data/v67.0/sobjects/Contact' }])).rejects.toThrow('invalid_api_path');
});

test('scoped inspection permits read-only child relationship reads', async () => {
  const path = '/services/data/v67.0/sobjects/Contact/003000000000001AAA/Credits__r';
  mockSalesforce({ [path]: { totalSize: 1, records: [{ Id: 'a06000000000001AAA' }] } });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const ref = { teamId: 'team', orgId, channelId: 'channel' };
  expect((await entrypoint.inspectSalesforce(ref, [{ method: 'GET', path }]))[0].status).toBe(200);
  await expect(entrypoint.inspectSalesforce(ref, [{ method: 'POST', path }])).rejects.toThrow('invalid_api_path');
  await expect(entrypoint.inspectSalesforce(ref, [{ method: 'GET', path: '/services/data/v67.0/sobjects/Contact/003000000000001AAA/Credits__r/extra' }])).rejects.toThrow('invalid_api_path');
});

test('scoped inspection permits tightly-shaped SOSL only', async () => {
  const good = '/services/data/v67.0/search?q=' + encodeURIComponent('FIND {E2E40722345} IN ALL FIELDS RETURNING Contact(Id, Name)');
  mockSalesforce({ ['/services/data/v67.0/search']: { searchRecords: [] } });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const ref = { teamId: 'team', orgId, channelId: 'channel' };
  expect((await entrypoint.inspectSalesforce(ref, [{ method: 'GET', path: good }]))[0].status).toBe(200);
  const bare = '/services/data/v67.0/search?q=' + encodeURIComponent('FIND {Rose} IN ALL FIELDS RETURNING Contact');
  expect((await entrypoint.inspectSalesforce(ref, [{ method: 'GET', path: bare }]))[0].status).toBe(200);
  const bad = [
    '/services/data/v67.0/search?q=' + encodeURIComponent('FIND {a OR b} IN ALL FIELDS RETURNING Contact(Id)'),
    '/services/data/v67.0/search?q=' + encodeURIComponent('FIND {y} IN ALL FIELDS RETURNING Contact(Id) LIMIT 5'),
    '/services/data/v67.0/search?q=' + encodeURIComponent('FIND {z"); DELETE} IN ALL FIELDS RETURNING Contact(Id)'),
    '/services/data/v67.0/search?q=' + encodeURIComponent('FIND NOTHING'),
  ];
  for (const path of bad) {
    await expect(entrypoint.inspectSalesforce(ref, [{ method: 'GET', path }])).rejects.toThrow('invalid_api_path');
  }
  await expect(entrypoint.inspectSalesforce(ref, [{ method: 'POST', path: good }])).rejects.toThrow('invalid_api_path');
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

test("scoped Skill inspection permits one metadata record and rejects unbounded queries", async () => {
  mockSalesforce({ "/services/data/v67.0/query": { records: [] } });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const ref = { teamId: "team", orgId, channelId: "channel" };
  const result = await entrypoint.inspectSalesforce(ref, [{ method: "GET", path: `/services/data/v67.0/query?q=${encodeURIComponent("SELECT Id, DeveloperName, MasterLabel FROM Skill LIMIT 1")}` }]);
  expect(result[0].status).toBe(200);
  // Bounded-SELECT contract: capped field/LIMIT/object variants are bounded
  // reads now; only unbounded/destructive shapes reject.
  for (const query of ["SELECT Id, DeveloperName, MasterLabel FROM Skill LIMIT 2", "SELECT Id, DeveloperName, MasterLabel, CreatedById FROM Skill LIMIT 1", "SELECT Id, DeveloperName, MasterLabel FROM User LIMIT 1"]) {
    const allowed = await entrypoint.inspectSalesforce(ref, [{ method: "GET", path: `/services/data/v67.0/query?q=${encodeURIComponent(query)}` }]);
    expect(allowed[0].status).toBe(200);
  }
  for (const query of ["SELECT Id, DeveloperName, MasterLabel FROM Skill LIMIT 99", "SELECT Id, DeveloperName, MasterLabel FROM Skill", "SELECT Id, (SELECT Id FROM Skills) FROM User LIMIT 1"])
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
  // Bounded-SELECT contract: capped variants are bounded reads now.
  for (const query of ["SELECT Id FROM MarketSegment WHERE SegmentStatus='ACTIVE' LIMIT 6",
    "SELECT Id FROM MarketSegment WHERE SegmentStatus='INACTIVE' LIMIT 1",
    "SELECT Id,Name FROM MarketSegment WHERE SegmentStatus='ACTIVE' LIMIT 1"]) {
    const allowed = await entrypoint.inspectSalesforce(ref, [{ method: "GET",
      path: `/services/data/v67.0/query?q=${encodeURIComponent(query)}` }]);
    expect(allowed[0].status).toBe(200);
  }
  for (const query of ["SELECT DurableId,ApiName,Label FROM FlowDefinitionView WHERE ApiName IN ('a','b','c')",
    "SELECT DurableId,ApiName,Label FROM FlowDefinitionView",
    "SELECT Id FROM MarketSegment WHERE SegmentStatus='ACTIVE' LIMIT 500"])
    await expect(entrypoint.inspectSalesforce(ref, [{ method: "GET",
      path: `/services/data/v67.0/query?q=${encodeURIComponent(query)}` }])).rejects.toThrow();
});
test("scoped inspection permits native standard-action shapes, rejects unbounded SELECTs", async () => {
  mockSalesforce({ "/services/data/v67.0/query": { records: [] },
    "/services/data/v67.0/sobjects/Contact/describe/": { fields: [] } });
  const entrypoint = new TubotSfAuthEntrypoint(null, await fixture());
  const ref = { teamId: "team", orgId, channelId: "channel" };
  for (const query of ["SELECT QualifiedApiName FROM EntityDefinition WHERE KeyPrefix='003' LIMIT 5",
    "SELECT QualifiedApiName FROM EntityDefinition WHERE KeyPrefix='0034' LIMIT 5",
    "SELECT Id, Name FROM Contact WHERE Email = 'a@example.invalid' LIMIT 50",
    "SELECT Id FROM Contact WHERE Name LIKE '%Rose%' ORDER BY Name DESC LIMIT 10",
    "SELECT Id, Membership__c FROM Contact WHERE Membership__c IN ('E2E40722345') LIMIT 5",
    "SELECT Id FROM Contact LIMIT 50"]) {
    const result = await entrypoint.inspectSalesforce(ref, [{ method: "GET",
      path: `/services/data/v67.0/query?q=${encodeURIComponent(query)}` }]);
    expect(result[0].status).toBe(200);
  }
  const slash = await entrypoint.inspectSalesforce(ref, [{ method: "GET",
    path: "/services/data/v67.0/sobjects/Contact/describe/" }]);
  expect(slash[0].status).toBe(200);
  for (const query of ["SELECT Id FROM Contact WHERE Name='x' LIMIT 51",
    "SELECT Id FROM Contact WHERE Name='x' LIMIT 200",
    "SELECT Id, (SELECT Id FROM Cases) FROM Contact LIMIT 5",
    "SELECT Id FROM Contact WHERE Name='x'; DELETE FROM Contact",
    "SELECT Id FROM Contact WHERE Name='a FOR UPDATE b' LIMIT 5",
    "SELECT * FROM Contact LIMIT 5",
    "SELECT Id FROM Contact WHERE Name='x' LIMIT 5 FOR UPDATE"])
    await expect(entrypoint.inspectSalesforce(ref, [{ method: "GET",
      path: `/services/data/v67.0/query?q=${encodeURIComponent(query)}` }])).rejects.toThrow("invalid_api_path");
  await expect(entrypoint.inspectSalesforce(ref, [{ method: "POST",
    path: `/services/data/v67.0/query?q=${encodeURIComponent("SELECT Id FROM Contact LIMIT 1")}` }])).rejects.toThrow("invalid_api_path");
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
  }, {
    // Bounded-SELECT contract: capped field/filter variants are bounded
    // reads now, folded into the same batch.
    method: "GET",
    path: "/services/data/v67.0/query?q=SELECT%20Name%20FROM%20Contact%20LIMIT%201",
  }, {
    method: "GET",
    path: "/services/data/v67.0/query?q=SELECT%20Id%20FROM%20MessagingSession%20WHERE%20ConversationId%20!%3D%20null%20OR%20Id%20!%3D%20null%20LIMIT%201",
  }]);
  expect(result).toEqual([
    { status: 200, body: { records: [{ Id: "500000000000001AAA" }] } },
    { status: 200, body: { records: [{ Id: "500000000000001AAA" }] } },
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
      path: "/services/data/v67.0/query?q=SELECT%20Name%20FROM%20Contact%20LIMIT%2099",
    }]);
  } catch { rejected = true; }
  expect(rejected).toBe(true);
  rejected = false;
  try {
    await entrypoint.inspectSalesforce(ref, [{
      method: "GET",
      path: "/services/data/v67.0/query?q=SELECT%20Id%2C%20(SELECT%20Id%20FROM%20Cases)%20FROM%20Contact%20LIMIT%201",
    }]);
  } catch { rejected = true; }
  expect(rejected).toBe(true);
  expect(seen.filter((s) => s.url.pathname === "/services/data/v67.0/composite/batch")).toHaveLength(1);
  expect(seen).toHaveLength(10);
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
    { teamId: "team", orgId, channelId: "channel" }, input)).rejects.toThrow("channel_not_found");
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
  })).rejects.toThrow("channel_not_found");
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
  // Timer acceleration scoped to this test's readiness polls: only multi-second
  // sleeps collapse to instant; every other timer keeps real timing (and extra
  // args). Origin: the data-graph readiness poll sleeps 5000ms per attempt;
  // the threshold sits below it and above any incidental timer on this path.
  // Bun runs a file's tests sequentially, so the try/finally restore below
  // never leaks into another test.
  const READINESS_POLL_ACCELERATION_THRESHOLD_MS = 1000;
  const timer = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    timer(callback, typeof ms === "number" && ms >= READINESS_POLL_ACCELERATION_THRESHOLD_MS ? 0 : ms, ...args)) as never;
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
  __resetPanelCredentialCacheForTests(); // fresh isolate: revocation visible past the credential TTL
  await expect(new TubotSfAuthEntrypoint(null, await fixture(false)).invokeQuickActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route })).rejects.toThrow("channel_not_found");
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
  __resetPanelCredentialCacheForTests(); // fresh isolate: revocation visible past the credential TTL
  await expect(new TubotSfAuthEntrypoint(null, await fixture(false)).invokeRecordActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route, objectApiName: target })).rejects.toThrow("channel_not_found");
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
  __resetPanelCredentialCacheForTests(); // fresh isolate: revocation visible past the credential TTL
  await expect(new TubotSfAuthEntrypoint(null, await fixture(false)).invokeRecordActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route, objectApiName: target })).rejects.toThrow("channel_not_found");
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
  __resetPanelCredentialCacheForTests(); // fresh isolate: revocation visible past the credential TTL
  await expect(new TubotSfAuthEntrypoint(null, await fixture(false)).invokeRecordActionWithContext(
    { teamId: "team", orgId, channelId: "channel" }, { route, objectApiName: target })).rejects.toThrow("channel_not_found");
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

function b64urlBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const cleanupHmacKey = "0123456789abcdef0123456789abcdef";

async function signedCleanupRequest(teamId: string, orgId: string): Promise<Request> {
  const body = JSON.stringify({ teamId, orgId });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "abcdefghijklmnopqrstuvwx";
  const bodyDigest = b64urlBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))));
  const canonical = `POST\n/internal/orgs/cleanup\n${timestamp}\n${nonce}\n${bodyDigest}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(cleanupHmacKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = b64urlBytes(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical))));
  return new Request("http://auth/internal/orgs/cleanup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tubot-sf-auth-timestamp": timestamp,
      "x-tubot-sf-auth-nonce": nonce,
      "x-tubot-sf-auth-signature": signature,
    },
    body,
  });
}

function cleanupDb(opts: { conflictTable?: string } = {}) {
  const seen: Array<{ sql: string; bindings: unknown[] }> = [];
  const present = new Set([
    "panel_salesforce_channels", "panel_salesforce_execution_users", "panel_salesforce_setup_oauth_pending",
    "salesforce_self_oauth_credential", "salesforce_self_oauth_pending", "sf_agent_snapshot_chunk",
    "sf_agent_snapshot_file", "sf_agent_snapshot_job", "sf_agent_metadata_user", "action_graph_context",
    "sf_user_data_cache_v2", "panel_messaging_proxies",
    "panel_org_oauth_clients", "panel_routing_backups", "panel_activate_tokens",
  ]);
  return {
    seen,
    prepare(sql: string) {
      const bound = (bindings: unknown[]) => {
        const entry = { sql, bindings };
        return {
          sql,
          bindings,
          async run() {
            seen.push(entry);
            return { success: true, meta: { changes: sql.includes("nonce") ? 1 : 0 } };
          },
          async first() {
            if (sql.includes("FROM sqlite_master")) {
              const table = bindings[0];
              if (typeof table === "string") return present.has(table) ? { present: 1 } : null;
              return null;
            }
            if (sql.includes("team_id<>?")) {
              if (opts.conflictTable && sql.includes(opts.conflictTable)) return { present: 1 };
              return null;
            }
            if (sql.includes("COUNT(*)")) return { count: 0 };
            return null;
          },
          async all() { return { results: [] }; },
        };
      };
      return { bind: (...bindings: unknown[]) => bound(bindings), ...bound([]) };
    },
    async batch(statements: Array<{ sql: string; bindings: unknown[] }>) {
      for (const s of statements) seen.push({ sql: s.sql, bindings: s.bindings });
      return statements.map(() => ({ success: true, meta: { changes: 0 } }));
    },
  };
}

test("org cleanup deletes and verifies the per-org oauth, routing-backup, and activate-token tables", async () => {
  const db = cleanupDb();
  const env = { DB: db, SELF_OAUTH_NEW_PANEL_HMAC_KEY: cleanupHmacKey };
  const response = await worker.fetch(await signedCleanupRequest("team", orgId), env as never);
  expect(response.status).toBe(200);
  const payload = await response.json() as Record<string, unknown>;
  expect(payload.ok).toBe(true);
  const remaining = payload.remaining as Record<string, number>;
  expect(remaining.org_oauth_clients).toBe(0);
  expect(remaining.routing_backups).toBe(0);
  expect(remaining.activate_tokens).toBe(0);
  const deletes = db.seen.filter((s) => s.sql.startsWith("DELETE FROM panel_"));
  for (const table of ["panel_org_oauth_clients", "panel_routing_backups", "panel_activate_tokens"]) {
    const match = deletes.filter((s) => s.sql.includes(`DELETE FROM ${table} `));
    expect(match).toHaveLength(1);
    expect(match[0].sql).toContain("team_id=? AND org_id=?");
    expect(match[0].bindings).toEqual(["team", orgId]);
  }
});

test("org cleanup refuses when another team owns rows in the newly covered tables", async () => {
  const db = cleanupDb({ conflictTable: "panel_routing_backups" });
  const env = { DB: db, SELF_OAUTH_NEW_PANEL_HMAC_KEY: cleanupHmacKey };
  const response = await worker.fetch(await signedCleanupRequest("team", orgId), env as never);
  expect(response.status).toBe(409);
  const payload = await response.json() as Record<string, unknown>;
  expect(payload.error).toBe("org_cleanup_conflict");
  const tenantDeletes = db.seen.filter((s) => s.sql.startsWith("DELETE FROM") && !s.sql.includes("nonce"));
  expect(tenantDeletes).toHaveLength(0);
});

test("org cleanup rejects a forged internal signature", async () => {
  const db = cleanupDb();
  const env = { DB: db, SELF_OAUTH_NEW_PANEL_HMAC_KEY: cleanupHmacKey };
  const request = await signedCleanupRequest("team", orgId);
  const tampered = new Request(request, {
    headers: {
      "Content-Type": "application/json",
      "x-tubot-sf-auth-timestamp": request.headers.get("x-tubot-sf-auth-timestamp") ?? "",
      "x-tubot-sf-auth-nonce": request.headers.get("x-tubot-sf-auth-nonce") ?? "",
      "x-tubot-sf-auth-signature": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  });
  const response = await worker.fetch(tampered, env as never);
  expect(response.status).toBe(401);
});

// Mobile deployments: live SCRT serves them when published, but the iamessage
// token endpoint rejects them ("Supported deployment types: API"), so the
// broker must fail closed with an explicit code instead of misrouting.
const mobileChannelId = "0Mj000000000001AAA";
const mobileScope = { teamId: "team", orgId, channelId: mobileChannelId };
const echoFlowAction = {
  name: "Echo_Flow",
  definitionName: "Tubot_Proxy_Echo",
  inputMapping: { definition: "definition", recipients: "recipients", parameters: "parameters" },
  outputMapping: { requestId: "requestId" },
};
const mobileScrtPayload = {
  embeddedServiceConfig: {
    deploymentType: "Mobile",
    embeddedServiceMessagingChannel: { channelAddressIdentifier: "chan-addr-1" },
  },
};
const apiScrtPayload = {
  embeddedServiceConfig: {
    deploymentType: "API",
    embeddedServiceMessagingChannel: { channelAddressIdentifier: "chan-addr-1" },
  },
};
const webScrtPayload = {
  embeddedServiceConfig: {
    deploymentType: "Web",
    embeddedServiceMessagingChannel: { channelAddressIdentifier: "chan-addr-1" },
  },
};

function mockBrokerSalesforce(scrt: (url: URL) => unknown) {
  return mockSalesforce({
    "/services/data/": [{ version: "65.0", url: "/services/data/v65.0" }],
    "/services/data/v65.0/actions/custom": { flow: "/services/data/v65.0/actions/custom/flow" },
    "/services/data/v65.0/actions/custom/flow": {
      actions: [{ name: "Echo_Flow", url: "/services/data/v65.0/actions/custom/flow/Echo_Flow" }],
    },
    "/services/data/v65.0/actions/custom/flow/Echo_Flow": {
      name: "Echo_Flow",
      inputs: [
        { name: "definition", required: true },
        { name: "recipients", required: true },
        { name: "parameters", required: true },
      ],
      outputs: [{ name: "requestId" }],
    },
    [`/services/data/v65.0/sobjects/MessagingChannel/${mobileChannelId}`]: {
      IsActive: true, ChannelAddressIdentifier: "chan-addr-1",
    },
    "/embeddedservice/v1/embedded-service-config": (_init, url) => Response.json(scrt(url)),
  });
}

test("broker validate rejects a Mobile deployment with an explicit unsupported-type error", async () => {
  mockBrokerSalesforce(() => mobileScrtPayload);
  const broker = new MessagingProxyBroker(null, await fixture());
  const failure = await broker.validate(mobileScope, { deploymentName: "Mobile_Deployment", action: echoFlowAction })
    .then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("proxy_broker_proxy_deployment_type_unsupported");
  expect((failure as Error).message).not.toContain("mismatch");
});

test("broker validate accepts a matching API deployment", async () => {
  mockBrokerSalesforce(() => apiScrtPayload);
  const broker = new MessagingProxyBroker(null, await fixture());
  await expect(broker.validate(mobileScope, { deploymentName: "Api_Deployment", action: echoFlowAction }))
    .resolves.toEqual({ scrtOrigin: "https://test.my.salesforce-scrt.com" });
});

test("broker validate accepts a matching Web deployment (web-only orgs)", async () => {
  mockBrokerSalesforce(() => webScrtPayload);
  const broker = new MessagingProxyBroker(null, await fixture());
  await expect(broker.validate(mobileScope, { deploymentName: "Web_Deployment", action: echoFlowAction }))
    .resolves.toEqual({ scrtOrigin: "https://test.my.salesforce-scrt.com" });
});

test("broker validate rejects a Mobile browser deployment with an explicit error", async () => {
  mockBrokerSalesforce((url) => url.searchParams.get("esConfigName") === "Mobile_Deployment" ? mobileScrtPayload : apiScrtPayload);
  const broker = new MessagingProxyBroker(null, await fixture());
  const failure = await broker.validate(mobileScope, {
    deploymentName: "Api_Deployment", browserDeploymentName: "Mobile_Deployment", action: echoFlowAction,
  }).then(() => null, (error: unknown) => error);
  expect((failure as Error).message).toBe("proxy_broker_browser_deployment_type_unsupported");
});

test("assertProxyDeployment accepts API and Web, rejects Mobile, mismatched, and empty payloads", () => {
  expect(() => assertProxyDeployment(apiScrtPayload, "chan-addr-1")).not.toThrow();
  expect(() => assertProxyDeployment(webScrtPayload, "chan-addr-1")).not.toThrow();
  const codes = (payload: unknown) => {
    try { assertProxyDeployment(payload, "chan-addr-1"); } catch (error) {
      return (error as { failure?: { code?: string } }).failure?.code;
    }
    return "accepted";
  };
  expect(codes(mobileScrtPayload)).toBe("proxy_deployment_type_unsupported");
  expect(codes({
    embeddedServiceConfig: {
      deploymentType: "API",
      embeddedServiceMessagingChannel: { channelAddressIdentifier: "other-channel" },
    },
  })).toBe("proxy_deployment_mismatch");
  expect(codes({
    embeddedServiceConfig: {
      deploymentType: "Web",
      embeddedServiceMessagingChannel: { channelAddressIdentifier: "other-channel" },
    },
  })).toBe("proxy_deployment_mismatch");
  expect(codes({
    embeddedServiceConfig: {
      deploymentType: "WhatsApp",
      embeddedServiceMessagingChannel: { channelAddressIdentifier: "chan-addr-1" },
    },
  })).toBe("proxy_deployment_mismatch");
  expect(codes(null)).toBe("proxy_deployment_mismatch");
});

test("browserConfig rejects a Mobile deployment before any Salesforce read", async () => {
  globalThis.fetch = (async () => Response.json(mobileScrtPayload)) as typeof fetch;
  const read = async (_path: string): Promise<Response> => { throw new Error("salesforce read must not run"); };
  await expect(browserConfig(read, "v65.0", "https://test.my.salesforce-scrt.com",
    mobileScope, "Mobile_Deployment", "chan-addr-1")).rejects.toThrow("browser_deployment_type_unsupported");
});

test("browserConfig accepts a matching Web deployment", async () => {
  globalThis.fetch = (async () => Response.json({
    embeddedServiceConfig: {
      deploymentType: "Web",
      siteUrl: "https://example.com/chat",
      embeddedServiceMessagingChannel: { channelAddressIdentifier: "chan-addr-1" },
    },
  })) as typeof fetch;
  const read = async (_path: string) => Response.json({ fields: [{ name: "Proxy_Echo_Visitor_Ref__c" }] });
  await expect(browserConfig(read, "v65.0", "https://test.my.salesforce-scrt.com",
    mobileScope, "Web_Deployment", "chan-addr-1")).resolves.toEqual({
    origin: "https://example.com", origins: ["https://example.com"], apiVersion: "v65.0", visitorField: "Proxy_Echo_Visitor_Ref__c",
    visitorFields: ["Proxy_Echo_Visitor_Ref__c"],
  });
});

test("browserConfig prefers the unpackaged field when both packaged and unpackaged exist", async () => {
  globalThis.fetch = (async () => Response.json({
    embeddedServiceConfig: {
      deploymentType: "Web",
      siteUrl: "https://example.com/chat",
      embeddedServiceMessagingChannel: { channelAddressIdentifier: "chan-addr-1" },
    },
  })) as typeof fetch;
  const read = async (_path: string) => Response.json({ fields: [{ name: "tubot__Proxy_Echo_Visitor_Ref__c" }, { name: "Proxy_Echo_Visitor_Ref__c" }] });
  await expect(browserConfig(read, "v65.0", "https://test.my.salesforce-scrt.com",
    mobileScope, "Web_Deployment", "chan-addr-1")).resolves.toEqual({
    origin: "https://example.com", origins: ["https://example.com"], apiVersion: "v65.0", visitorField: "Proxy_Echo_Visitor_Ref__c",
    visitorFields: ["Proxy_Echo_Visitor_Ref__c", "tubot__Proxy_Echo_Visitor_Ref__c"],
  });
});

test("browserConfig accepts lone namespaced fields, orders multiples, rejects missing", async () => {
  globalThis.fetch = (async () => Response.json({
    embeddedServiceConfig: {
      deploymentType: "Web",
      siteUrl: "https://example.com/chat",
      embeddedServiceMessagingChannel: { channelAddressIdentifier: "chan-addr-1" },
    },
  })) as typeof fetch;
  const lone = async (_path: string) => Response.json({ fields: [{ name: "tubot__Proxy_Echo_Visitor_Ref__c" }] });
  await expect(browserConfig(lone, "v65.0", "https://test.my.salesforce-scrt.com",
    mobileScope, "Web_Deployment", "chan-addr-1")).resolves.toMatchObject({
    visitorField: "tubot__Proxy_Echo_Visitor_Ref__c", visitorFields: ["tubot__Proxy_Echo_Visitor_Ref__c"],
  });
  const multi = async (_path: string) => Response.json({ fields: [{ name: "b__Proxy_Echo_Visitor_Ref__c" }, { name: "a__Proxy_Echo_Visitor_Ref__c" }] });
  await expect(browserConfig(multi, "v65.0", "https://test.my.salesforce-scrt.com",
    mobileScope, "Web_Deployment", "chan-addr-1")).resolves.toMatchObject({
    visitorFields: ["a__Proxy_Echo_Visitor_Ref__c", "b__Proxy_Echo_Visitor_Ref__c"],
  });
  const none = async (_path: string) => Response.json({ fields: [{ name: "Subject" }] });
  await expect(browserConfig(none, "v65.0", "https://test.my.salesforce-scrt.com",
    mobileScope, "Web_Deployment", "chan-addr-1")).rejects.toThrow("browser_binding_field_unavailable");
});

test("browserConfig derives origins with the VF test-page origin from the ESW page namespace", async () => {
  globalThis.fetch = (async () => Response.json({
    embeddedServiceConfig: {
      deploymentType: "Web",
      siteUrl: "https://example.com/chat",
      embeddedServiceMessagingChannel: { channelAddressIdentifier: "chan-addr-1" },
    },
  })) as typeof fetch;
  const seen: string[] = [];
  const read = async (path: string) => {
    seen.push(path);
    if (path.includes("/tooling/query")) return Response.json({ records: [{ Name: "ESWWeb_Deployment1759000000000", NamespacePrefix: "tubot" }] });
    return Response.json({ fields: [{ name: "Proxy_Echo_Visitor_Ref__c" }] });
  };
  const config = await browserConfig(read, "v65.0", "https://test.my.salesforce-scrt.com",
    mobileScope, "Web_Deployment", "chan-addr-1");
  expect(config.origin).toBe("https://example.com");
  expect(config.origins).toEqual(["https://example.com", "https://test--tubot.vf.force.com"]);
  // Tooling census of ESW<deployment><ts>, newest first — both LIKE variants
  // for the underscore in the deployment name (LIKE '_' is a wildcard).
  const tooling = seen.find((p) => p.includes("/tooling/query"))!;
  expect(tooling).toContain("/services/data/v65.0/tooling/query?q=");
  const soql = decodeURIComponent(tooling.split("q=")[1]);
  expect(soql).toContain("Name LIKE 'ESWWeb\\_Deployment%'");
  expect(soql).toContain("Name LIKE 'ESWWebDeployment%'");
  expect(soql).toContain("ORDER BY CreatedDate DESC LIMIT 1");
});

test("browserConfig maps a null page namespace to --c and preserves the pod", async () => {
  globalThis.fetch = (async () => Response.json({
    embeddedServiceConfig: {
      deploymentType: "Web",
      siteUrl: "https://example.com/chat",
      embeddedServiceMessagingChannel: { channelAddressIdentifier: "chan-addr-1" },
    },
  })) as typeof fetch;
  const read = async (path: string) => {
    if (path.includes("/tooling/query")) return Response.json({ records: [{ Name: "ESWWebDeployment1759000000000", NamespacePrefix: null }] });
    return Response.json({ fields: [{ name: "Proxy_Echo_Visitor_Ref__c" }] });
  };
  const config = await browserConfig(read, "v65.0", "https://acme.cs99.my.salesforce-scrt.com",
    mobileScope, "WebDeployment", "chan-addr-1");
  expect(config.origins).toEqual(["https://example.com", "https://acme--c.cs99.vf.force.com"]);
});

test("browserConfig falls back to [site.origin] when the VF page is missing, without throwing", async () => {
  globalThis.fetch = (async () => Response.json({
    embeddedServiceConfig: {
      deploymentType: "Web",
      siteUrl: "https://example.com/chat",
      embeddedServiceMessagingChannel: { channelAddressIdentifier: "chan-addr-1" },
    },
  })) as typeof fetch;
  const describe = async (path: string) => Response.json({ fields: [{ name: "Proxy_Echo_Visitor_Ref__c" }] });
  const noPage = async (path: string) => path.includes("/tooling/query")
    ? Response.json({ records: [] }) : describe(path);
  await expect(browserConfig(noPage, "v65.0", "https://test.my.salesforce-scrt.com",
    mobileScope, "Web_Deployment", "chan-addr-1")).resolves.toMatchObject({
    origin: "https://example.com", origins: ["https://example.com"],
  });
  const down = async (path: string) => path.includes("/tooling/query")
    ? new Response("bad gateway", { status: 502 }) : describe(path);
  await expect(browserConfig(down, "v65.0", "https://test.my.salesforce-scrt.com",
    mobileScope, "Web_Deployment", "chan-addr-1")).resolves.toMatchObject({
    origins: ["https://example.com"],
  });
  const throwing = async (path: string): Promise<Response> => {
    if (path.includes("/tooling/query")) throw new Error("transport_down");
    return describe(path);
  };
  await expect(browserConfig(throwing, "v65.0", "https://test.my.salesforce-scrt.com",
    mobileScope, "Web_Deployment", "chan-addr-1")).resolves.toMatchObject({
    origins: ["https://example.com"],
  });
  // An unscrt-shaped origin cannot reverse to an instance host: same fallback.
  await expect(browserConfig(noPage, "v65.0", "https://odd.example.com",
    mobileScope, "Web_Deployment", "chan-addr-1")).resolves.toMatchObject({
    origins: ["https://example.com"],
  });
});

test("verifyBrowserTurn distinguishes binding, transcript, and verified outcomes", async () => {
  const config = { origin: "https://example.com", apiVersion: "v65.0", visitorField: "Proxy_Echo_Visitor_Ref__c" };
  const turn = { reference: "a".repeat(64), conversationId: "11111111-1111-4111-8111-111111111111", messageId: "22222222-2222-4222-8222-222222222222", text: "hi" };
  const session = { records: [{ Id: "0Mw000000000001AAA" }] };
  const transcript = { conversationEntries: [{ identifier: turn.messageId, sender: { role: "EndUser" }, messageText: "hi" }] };
  const empty = async (path: string) => Response.json(path.includes("/query?") ? { records: [] } : { conversationEntries: [] });
  await expect(verifyBrowserTurn(empty, mobileScope, config, turn)).resolves.toEqual({ ok: false, code: "session_pending" });
  const boundElsewhere = async (path: string) => Response.json(!path.includes("/query?") ? { conversationEntries: [] }
    : !path.includes(turn.reference) ? { records: [{ Id: "0Mw000000000001AAA" }] } : { records: [] });
  await expect(verifyBrowserTurn(boundElsewhere, mobileScope, config, turn)).resolves.toEqual({ ok: false, code: "binding_absent" });
  const noEntry = async (path: string) => Response.json(path.includes("/query?") ? session : { conversationEntries: [] });
  await expect(verifyBrowserTurn(noEntry, mobileScope, config, turn)).resolves.toEqual({ ok: false, code: "transcript_mismatch" });
  const good = async (path: string) => Response.json(path.includes("/query?") ? session : transcript);
  await expect(verifyBrowserTurn(good, mobileScope, config, turn)).resolves.toEqual({ ok: true, code: "verified" });
  await expect(verifyBrowserTurn(good, mobileScope, config, { ...turn, reference: "short" })).resolves.toEqual({ ok: false, code: "invalid_turn" });
});

test("verifyBrowserTurn self-binds an unbound session after transcript proof", async () => {
  const config = { origin: "https://example.com", apiVersion: "v65.0", visitorField: "Proxy_Echo_Visitor_Ref__c" };
  const turn = { reference: "a".repeat(64), conversationId: "11111111-1111-4111-8111-111111111111", messageId: "22222222-2222-4222-8222-222222222222", text: "hi" };
  const transcript = { conversationEntries: [{ identifier: turn.messageId, sender: { role: "EndUser" }, messageText: "hi" }] };
  const unbound = { Id: "0Mw000000000001AAA", MessagingEndUserId: "0PAxx0000000001AAA", Proxy_Echo_Visitor_Ref__c: null };
  let bindingCalls = 0;
  const read = async (path: string) => {
    if (!path.includes("/query?")) return Response.json(transcript);
    if (path.includes("LIMIT%2010")) return Response.json({ records: [unbound] });
    bindingCalls += 1;
    return Response.json(bindingCalls === 1 ? { records: [] } : { records: [{ ...unbound, Proxy_Echo_Visitor_Ref__c: turn.reference }] });
  };
  const writes: Array<{ path: string; body: string }> = [];
  const write = async (path: string, body: string) => {
    writes.push({ path, body });
    return new Response(null, { status: 204 });
  };
  await expect(verifyBrowserTurn(read, mobileScope, config, turn, write)).resolves.toEqual(
    { ok: true, code: "verified", recipient: "0PAxx0000000001AAA" });
  expect(writes).toEqual([{
    path: "/services/data/v65.0/sobjects/MessagingSession/0Mw000000000001AAA",
    body: JSON.stringify({ Proxy_Echo_Visitor_Ref__c: turn.reference }),
  }]);
});

test("verifyBrowserTurn self-bind refuses to overwrite, mismatch, or fail loudly", async () => {
  const config = { origin: "https://example.com", apiVersion: "v65.0", visitorField: "Proxy_Echo_Visitor_Ref__c" };
  const turn = { reference: "a".repeat(64), conversationId: "11111111-1111-4111-8111-111111111111", messageId: "22222222-2222-4222-8222-222222222222", text: "hi" };
  const transcript = { conversationEntries: [{ identifier: turn.messageId, sender: { role: "EndUser" }, messageText: "hi" }] };
  const readFor = (lookupRecords: unknown[], entries: unknown = transcript) => async (path: string) =>
    Response.json(!path.includes("/query?") ? entries : path.includes("LIMIT%2010") ? { records: lookupRecords }
      : !path.includes(turn.reference) ? { records: [{ Id: "0Mw000000000001AAA" }] } : { records: [] });
  let writes = 0;
  const write = async () => { writes += 1; return new Response(null, { status: 204 }); };
  // Existing binding (different ref): never overwrite.
  await expect(verifyBrowserTurn(
    readFor([{ Id: "0Mw000000000001AAA", Proxy_Echo_Visitor_Ref__c: "b".repeat(64) }]),
    mobileScope, config, turn, write)).resolves.toEqual({ ok: false, code: "binding_absent" });
  expect(writes).toBe(0);
  // Transcript mismatch: no proof, no write.
  await expect(verifyBrowserTurn(
    readFor([{ Id: "0Mw000000000001AAA", Proxy_Echo_Visitor_Ref__c: null }], { conversationEntries: [] }),
    mobileScope, config, turn, write)).resolves.toEqual({ ok: false, code: "binding_absent" });
  expect(writes).toBe(0);
  // Ambiguous sessions: never touch.
  await expect(verifyBrowserTurn(
    readFor([{ Id: "0Mw000000000001AAA" }, { Id: "0Mw000000000002AAA" }]),
    mobileScope, config, turn, write)).resolves.toEqual({ ok: false, code: "binding_absent" });
  expect(writes).toBe(0);
  // PATCH rejected: graceful absent.
  const failingWrite = async () => Response.json({ message: "forbidden" }, { status: 403 });
  await expect(verifyBrowserTurn(
    readFor([{ Id: "0Mw000000000001AAA", Proxy_Echo_Visitor_Ref__c: null }]),
    mobileScope, config, turn, failingWrite)).resolves.toEqual({ ok: false, code: "binding_absent" });
});

test("echo parameters carry text plus channel, org, and resolved guest ids", () => {
  const scope = { teamId: "team_1", orgId: "00Dxx0000000001AAA", channelId: "0Mjxx0000000001AAA" };
  expect(echoParameters(scope, "0PAxx0000000001AAA", "  hi  ")).toEqual([
    { name: "text", textValue: "  hi  " },
    { name: "channelId", textValue: "0Mjxx0000000001AAA" },
    { name: "orgId", textValue: "00Dxx0000000001AAA" },
    { name: "guestId", textValue: "0PAxx0000000001AAA" },
  ]);
});

test("definition names qualify to the resolved flow namespace", () => {
  expect(qualifyDefinitionName("Tubot_Proxy_Echo", "tubot")).toBe("tubot__Tubot_Proxy_Echo");
  expect(qualifyDefinitionName("tubot__Tubot_Proxy_Echo", "tubot")).toBe("tubot__Tubot_Proxy_Echo");
  expect(qualifyDefinitionName("acme__Tubot_Proxy_Echo", "tubot")).toBe("tubot__Tubot_Proxy_Echo");
  expect(qualifyDefinitionName("Tubot_Proxy_Echo", null)).toBe("Tubot_Proxy_Echo");
  expect(qualifyDefinitionName("tubot__Tubot_Proxy_Echo", null)).toBe("Tubot_Proxy_Echo");
  expect(qualifyDefinitionName("not a name!", "tubot")).toBe("not a name!");
  expect(flipDefinitionTwin("tubot__Tubot_Proxy_Echo")).toBe("Tubot_Proxy_Echo");
  expect(flipDefinitionTwin("Tubot_Proxy_Echo")).toBe(null);
  expect(flipDefinitionTwin("not a name!")).toBe(null);
  const invalid = [{ isSuccess: false, errors: [{ statusCode: "INVALID_INPUT", message: 'The value "X" for the messageDefinitionName parameter is invalid.' }] }];
  expect(isDefinitionInvalidInput(invalid)).toBe(true);
  expect(isDefinitionInvalidInput([{ isSuccess: false, errors: [{ statusCode: "INVALID_INPUT", message: "other param bad" }] }])).toBe(false);
  expect(isDefinitionInvalidInput([{ isSuccess: true, outputValues: {} }])).toBe(false);
  expect(isDefinitionInvalidInput(null)).toBe(false);
});

test("guest ids accept only MessagingEndUser records", () => {
  expect(validGuestId("0PAxx0000000001AAA")).toBe(true);
  expect(validGuestId("0PAxx0000000001")).toBe(true);
  expect(validGuestId("0Mw000000000001AAA")).toBe(false);
  expect(validGuestId("a".repeat(64))).toBe(false);
  expect(validGuestId(undefined)).toBe(false);
});

test("echoed turn scope must be absent or match the RPC scope", () => {
  const scope = { teamId: "team_1", orgId: "00Dxx0000000001AAA", channelId: "0Mjxx0000000001AAA" };
  expect(turnScopeMatches(scope, { conversationId: "c", text: "t", requestKey: "k" })).toBe(true);
  expect(turnScopeMatches(scope, { channelId: scope.channelId, orgId: scope.orgId })).toBe(true);
  expect(turnScopeMatches(scope, { channelId: "0Mjxx0000000002AAA" })).toBe(false);
  expect(turnScopeMatches(scope, { orgId: "00Dxx0000000002AAA" })).toBe(false);
});

test("verifyBrowserTurn returns the session recipient for echo passthrough", async () => {
  const config = { origin: "https://example.com", apiVersion: "v65.0", visitorField: "Proxy_Echo_Visitor_Ref__c" };
  const turn = { reference: "a".repeat(64), conversationId: "11111111-1111-4111-8111-111111111111", messageId: "22222222-2222-4222-8222-222222222222", text: "hi" };
  const transcript = { conversationEntries: [{ identifier: turn.messageId, sender: { role: "EndUser" }, messageText: "hi" }] };
  const seen: string[] = [];
  const withRecipient = async (path: string) => {
    seen.push(path);
    return Response.json(path.includes("/query?")
      ? { records: [{ Id: "0Mw000000000001AAA", MessagingEndUserId: "0PAxx0000000001AAA" }] }
      : transcript);
  };
  await expect(verifyBrowserTurn(withRecipient, mobileScope, config, turn)).resolves.toEqual(
    { ok: true, code: "verified", recipient: "0PAxx0000000001AAA" });
  expect(seen.find((p) => p.includes("/query?"))).toContain("MessagingEndUserId");
  // A row without a guest id stays verified; echo falls back to its own query.
  const withoutRecipient = async (path: string) => Response.json(path.includes("/query?")
    ? { records: [{ Id: "0Mw000000000001AAA" }] }
    : transcript);
  await expect(verifyBrowserTurn(withoutRecipient, mobileScope, config, turn)).resolves.toEqual({ ok: true, code: "verified" });
});

test("broker browserTurn returns the verify code plus the session recipient", async () => {
  const conversationId = "11111111-1111-4111-8111-111111111111";
  const messageId = "22222222-2222-4222-8222-222222222222";
  mockSalesforce({
    "/services/data/v65.0/query": { records: [{ Id: "0Mw000000000001AAA", MessagingEndUserId: "0PAxx0000000001AAA" }] },
    [`/services/data/v65.0/connect/conversation/${conversationId}/entries`]: {
      conversationEntries: [{ identifier: messageId, sender: { role: "EndUser" }, messageText: "hi" }],
    },
  });
  const broker = new MessagingProxyBroker(null, await fixture());
  await expect(broker.browserTurn(mobileScope,
    { origin: "https://example.com", apiVersion: "v65.0", visitorField: "Proxy_Echo_Visitor_Ref__c" },
    { reference: "a".repeat(64), conversationId, messageId, text: "hi" })).resolves.toEqual(
    { code: "verified", recipient: "0PAxx0000000001AAA" });
});

const echoSubmitRoutes = () => ({
  "/services/data/": [{ version: "65.0", url: "/services/data/v65.0" }],
  "/services/data/v65.0/actions/custom": { flow: "/services/data/v65.0/actions/custom/flow" },
  "/services/data/v65.0/actions/custom/flow": {
    actions: [{ name: "Echo_Flow", url: "/services/data/v65.0/actions/custom/flow/Echo_Flow" }],
  },
  "/services/data/v65.0/actions/standard/sendConversationMessages": (init: RequestInit | undefined) => init?.method === "POST"
    ? Response.json([{ isSuccess: true, outputValues: { requestId: "1sr000000000001AAA" } }])
    : Response.json([{ message: "not found" }], { status: 404 }),
  "/services/data/v65.0/actions/custom/flow/Echo_Flow": (init: RequestInit | undefined) => init?.method === "POST"
    ? Response.json([{ isSuccess: true, outputValues: { requestId: "1sr000000000001AAA" } }])
    : Response.json({
      name: "Echo_Flow",
      inputs: [
        { name: "definition", required: true },
        { name: "recipients", required: true },
        { name: "parameters", required: true },
      ],
      outputs: [{ name: "requestId" }],
    }),
  "/services/data/v65.0/query": { records: [{ Id: "0Mw000000000001AAA", MessagingEndUserId: "0PAxx0000000001AAA" }] },
});

test("broker echo skips the session query when verify supplies the recipient", async () => {
  const seen = mockSalesforce(echoSubmitRoutes());
  const broker = new MessagingProxyBroker(null, await fixture());
  await expect(broker.echo(mobileScope, echoFlowAction, {
    conversationId: "33333333-3333-4333-8333-333333333333", text: "hi", requestKey: "b".repeat(64),
    channelId: mobileScope.channelId, orgId: mobileScope.orgId,
    recipient: "0PAxx0000000001AAA",
  })).resolves.toEqual({ requestId: "1sr000000000001AAA" });
  expect(seen.filter((s) => s.method === "GET" && s.url.pathname.endsWith("/query"))).toHaveLength(0);
  const submit = seen.find((s) => s.method === "POST" && s.url.pathname.endsWith("/actions/standard/sendConversationMessages"));
  expect(JSON.parse(submit?.body ?? "{}").inputs[0].messagingEndUserIds).toEqual(["0PAxx0000000001AAA"]);
  expect(seen.filter((s) => s.method === "POST" && s.url.pathname.endsWith("/actions/custom/flow/Echo_Flow"))).toHaveLength(0);
});

test("broker echo falls back to the session query without a passthrough recipient", async () => {
  const seen = mockSalesforce(echoSubmitRoutes());
  const broker = new MessagingProxyBroker(null, await fixture());
  await expect(broker.echo(mobileScope, echoFlowAction, {
    conversationId: "44444444-4444-4444-8444-444444444444", text: "hi", requestKey: "c".repeat(64),
    channelId: mobileScope.channelId, orgId: mobileScope.orgId,
  })).resolves.toEqual({ requestId: "1sr000000000001AAA" });
  const sessionQueries = seen.filter((s) => s.method === "GET" && s.url.pathname.endsWith("/query")
    && (s.url.searchParams.get("q") ?? "").includes("FROM MessagingSession"));
  expect(sessionQueries).toHaveLength(1);
  const submit = seen.find((s) => s.method === "POST" && s.url.pathname.endsWith("/actions/standard/sendConversationMessages"));
  expect(JSON.parse(submit?.body ?? "{}").inputs[0].messagingEndUserIds).toEqual(["0PAxx0000000001AAA"]);
});

// Duplicate-submit guard: the 25s inline race orphan + alarm redelivery (or
// an adopted echo_inline retry) invoke echo() twice for one visitor message.
// Same requestKey must POST to Salesforce exactly once; the second call
// returns the first call's requestId without posting.
test("broker echo submits once per requestKey across duplicate invocations", async () => {
  const seen = mockSalesforce(echoSubmitRoutes());
  const env: any = await fixture();
  // Stateful echo_submit_claims over the fixture stub: same SQL contract as D1
  // (INSERT OR IGNORE + SELECT read-back + conditional UPDATE/DELETE).
  const claims = new Map<string, { claimant: string; request_id: string | null }>();
  const basePrepare = env.DB.prepare.bind(env.DB);
  env.DB = {
    prepare(sql: string) {
      if (!sql.includes("echo_submit_claims")) return basePrepare(sql);
      return { bind(...args: unknown[]) { return {
        async run() {
          if (sql.startsWith("INSERT")) {
            const [key, claimant] = args as string[];
            if (claims.has(key)) return { success: true, meta: { changes: 0 } };
            claims.set(key, { claimant, request_id: null });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith("DELETE")) {
            const [key, claimant] = args as string[];
            if (claims.get(key)?.claimant === claimant) claims.delete(key);
            return { success: true };
          }
          if (sql.includes("SET request_id")) {
            const [rid, , key, claimant] = args as string[];
            const row = claims.get(key);
            if (row && row.claimant === claimant) row.request_id = rid;
            return { success: true };
          }
          if (sql.includes("SET claimant")) {
            const [me, , key, other] = args as string[];
            const row = claims.get(key);
            if (row && row.request_id === null && row.claimant === other) {
              row.claimant = me;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true };
        },
        async first() {
          const key = args[0] as string;
          const row = claims.get(key);
          return row ? { claimant: row.claimant, request_id: row.request_id } : null;
        },
      }; } };
    },
  };
  const broker = new MessagingProxyBroker(null, env);
  const turn = {
    conversationId: "55555555-5555-4555-8555-555555555555", text: "hi", requestKey: "d".repeat(64),
    channelId: mobileScope.channelId, orgId: mobileScope.orgId, recipient: "0PAxx0000000001AAA",
  };
  await expect(broker.echo(mobileScope, echoFlowAction, turn)).resolves.toEqual({ requestId: "1sr000000000001AAA" });
  await expect(broker.echo(mobileScope, echoFlowAction, turn)).resolves.toEqual({ requestId: "1sr000000000001AAA" });
  const posts = seen.filter((s) => s.method === "POST" && s.url.pathname.endsWith("/actions/standard/sendConversationMessages"));
  expect(posts).toHaveLength(1);
});

// Stored-first definition twin order (sdo2 2026-10-30: every submit burned
// one doomed bare-twin interview -> Flow error email per turn, then
// succeeded on the packaged fallback). The route's stored definitionName
// is live-picked from the org at provisioning, so it MUST go first; the
// namespace-derived twin is only the INVALID_INPUT fallback.
test("broker echo submits the stored definition name first", async () => {
  const routes = echoSubmitRoutes() as Record<string, unknown>;
  // Direct fast path rejects (stale mirror) so the Flow twin order engages.
  routes["/services/data/v65.0/actions/standard/sendConversationMessages"] = () =>
    Response.json([{ isSuccess: false, errors: [{ statusCode: "INVALID_INPUT", message: "bad" }] }]);
  const defs: string[] = [];
  routes["/services/data/v65.0/actions/custom/flow/Echo_Flow"] = (init: RequestInit | undefined) => {
    if (init?.method === "POST") {
      defs.push(JSON.parse(String(init.body)).inputs[0].definition);
      return Response.json([{ isSuccess: true, outputValues: { requestId: "1sr000000000001AAA" } }]);
    }
    return Response.json({
      name: "Echo_Flow",
      inputs: [
        { name: "definition", required: true },
        { name: "recipients", required: true },
        { name: "parameters", required: true },
      ],
      outputs: [{ name: "requestId" }],
    });
  };
  const seen = mockSalesforce(routes);
  const broker = new MessagingProxyBroker(null, await fixture());
  // Route stores the packaged twin; the resolved flow route is unpackaged
  // (no /flow/<ns>__ segment -> flowNs null), exactly the sdo2 shape.
  const action = { ...echoFlowAction, definitionName: "tubot__Tubot_Proxy_Echo" };
  await expect(broker.echo(mobileScope, action, {
    conversationId: "66666666-6666-4666-8666-666666666666", text: "hi", requestKey: "e".repeat(64),
    channelId: mobileScope.channelId, orgId: mobileScope.orgId, recipient: "0PAxx0000000001AAA",
  })).resolves.toEqual({ requestId: "1sr000000000001AAA" });
  const posts = seen.filter((s) => s.method === "POST" && s.url.pathname.endsWith("/actions/custom/flow/Echo_Flow"));
  expect(posts).toHaveLength(1);
  expect(defs).toEqual(["tubot__Tubot_Proxy_Echo"]);
});

test("broker echo flips to the derived twin once on definition INVALID_INPUT", async () => {
  const routes = echoSubmitRoutes() as Record<string, unknown>;
  routes["/services/data/v65.0/actions/standard/sendConversationMessages"] = () =>
    Response.json([{ isSuccess: false, errors: [{ statusCode: "INVALID_INPUT", message: "bad" }] }]);
  const defs: string[] = [];
  routes["/services/data/v65.0/actions/custom/flow/Echo_Flow"] = (init: RequestInit | undefined) => {
    if (init?.method !== "POST") {
      return Response.json({
        name: "Echo_Flow",
        inputs: [
          { name: "definition", required: true },
          { name: "recipients", required: true },
          { name: "parameters", required: true },
        ],
        outputs: [{ name: "requestId" }],
      });
    }
    const def = JSON.parse(String(init.body)).inputs[0].definition;
    defs.push(def);
    if (defs.length === 1) {
      return Response.json([{ isSuccess: false,
        errors: [{ statusCode: "INVALID_INPUT", message: `The value "${def}" for the messageDefinitionName parameter is invalid.` }] }]);
    }
    return Response.json([{ isSuccess: true, outputValues: { requestId: "1sr000000000001AAA" } }]);
  };
  mockSalesforce(routes);
  const broker = new MessagingProxyBroker(null, await fixture());
  const action = { ...echoFlowAction, definitionName: "tubot__Tubot_Proxy_Echo" };
  await expect(broker.echo(mobileScope, action, {
    conversationId: "77777777-7777-4777-8777-777777777777", text: "hi", requestKey: "f".repeat(64),
    channelId: mobileScope.channelId, orgId: mobileScope.orgId, recipient: "0PAxx0000000001AAA",
  })).resolves.toEqual({ requestId: "1sr000000000001AAA" });
  // Stored packaged name first, bare twin only as the single fallback.
  expect(defs).toEqual(["tubot__Tubot_Proxy_Echo", "Tubot_Proxy_Echo"]);
});

test("broker echo falls back to the Flow once on direct INVALID_INPUT", async () => {
  const routes = echoSubmitRoutes() as Record<string, unknown>;
  routes["/services/data/v65.0/actions/standard/sendConversationMessages"] = () =>
    Response.json([{ isSuccess: false, errors: [{ statusCode: "INVALID_INPUT", message: "unknown param" }] }]);
  const seen = mockSalesforce(routes);
  const broker = new MessagingProxyBroker(null, await fixture());
  await expect(broker.echo(mobileScope, echoFlowAction, {
    conversationId: "88888888-8888-4888-8888-888888888888", text: "hi", requestKey: "0".repeat(64),
    channelId: mobileScope.channelId, orgId: mobileScope.orgId, recipient: "0PAxx0000000001AAA",
  })).resolves.toEqual({ requestId: "1sr000000000001AAA" });
  expect(seen.filter((s) => s.method === "POST" && s.url.pathname.endsWith("/actions/standard/sendConversationMessages"))).toHaveLength(1);
  expect(seen.filter((s) => s.method === "POST" && s.url.pathname.endsWith("/actions/custom/flow/Echo_Flow"))).toHaveLength(1);
});

test("broker echo fails closed without Flow retry on ambiguous direct failure", async () => {
  const routes = echoSubmitRoutes() as Record<string, unknown>;
  routes["/services/data/v65.0/actions/standard/sendConversationMessages"] = () =>
    Response.json([{ message: "boom" }], { status: 500 });
  const seen = mockSalesforce(routes);
  const broker = new MessagingProxyBroker(null, await fixture());
  await expect(broker.echo(mobileScope, echoFlowAction, {
    conversationId: "99999999-9999-4999-8999-999999999999", text: "hi", requestKey: "1".repeat(64),
    channelId: mobileScope.channelId, orgId: mobileScope.orgId, recipient: "0PAxx0000000001AAA",
  })).rejects.toThrow("proxy_echo_rejected");
  // No Flow retry: an ambiguous direct failure may already have sent.
  expect(seen.filter((s) => s.method === "POST" && s.url.pathname.endsWith("/actions/custom/flow/Echo_Flow"))).toHaveLength(0);
});

// resolve-channel semantics: getTokenForChannel without tenant scope resolves via
// `channel_id = ? OR substr(channel_id, 1, 15) = ?` (Salesforce 15/18-char ids).
// These tests lock the resolution outcome; index effectiveness is proven by replay.
type ResolveChannel = { teamId: string; orgId: string; channelId: string };

function resolveFixture(channels: ResolveChannel[]) {
  const creds = new Map(channels.map(c => [`${c.teamId}\u0000${c.orgId}\u0000${c.channelId}`, {
    team_id: c.teamId, org_id: c.orgId, channel_id: c.channelId,
    instance_url: "https://test.my.salesforce.com",
    integration_user_id: userId, integration_username: "integration@example.com",
    is_sandbox: 1, client_id: null,
  }]));
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() { return { success: true }; },
            async first() {
              const [teamId, orgId, channelId] = args as string[];
              return creds.get(`${teamId}\u0000${orgId}\u0000${channelId}`) ?? null;
            },
            async all() {
              if (sql.includes("OR substr(channel_id, 1, 15)")) {
                const [full, prefix] = args as string[];
                const results = channels
                  .filter(c => c.channelId === full || c.channelId.slice(0, 15) === prefix)
                  .slice(0, 3)
                  .map(c => creds.get(`${c.teamId}\u0000${c.orgId}\u0000${c.channelId}`));
                return { results };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };
  const PANEL_JWT_SIGNER = {
    async signAssertion(_input: unknown) { return "test-assertion"; },
  };
  return { DB: db, SF_CREDENTIAL_ENCRYPTION_KEY: encryptionKey, PANEL_JWT_SIGNER, AUTH_RPC_WARN_MODE: "1" };
}

const CH18 = "0Mjxx0000000001AAA";
const CH15 = CH18.slice(0, 15);

test("resolve-channel matches an exact 18-char channel id", async () => {
  mockSalesforce({});
  const entrypoint = new TubotSfAuthEntrypoint(null, resolveFixture([{ teamId: "team", orgId, channelId: CH18 }]));
  const result = await entrypoint.getTokenForChannel(CH18);
  expect(result.teamId).toBe("team");
  expect(result.orgId).toBe(orgId);
  expect(result.accessToken).toBe("secret-access-token");
});

test("resolve-channel matches a 15-char input to a stored 18-char channel", async () => {
  mockSalesforce({});
  const entrypoint = new TubotSfAuthEntrypoint(null, resolveFixture([{ teamId: "team", orgId, channelId: CH18 }]));
  const result = await entrypoint.getTokenForChannel(CH15);
  expect(result.teamId).toBe("team");
  expect(result.orgId).toBe(orgId);
});

test("resolve-channel matches an 18-char input to a stored 15-char channel", async () => {
  mockSalesforce({});
  const entrypoint = new TubotSfAuthEntrypoint(null, resolveFixture([{ teamId: "team", orgId, channelId: CH15 }]));
  const result = await entrypoint.getTokenForChannel(CH18);
  expect(result.teamId).toBe("team");
  expect(result.orgId).toBe(orgId);
});

test("resolve-channel returns 404 for an unknown channel", async () => {
  mockSalesforce({});
  const entrypoint = new TubotSfAuthEntrypoint(null, resolveFixture([{ teamId: "team", orgId, channelId: CH18 }]));
  await expect(entrypoint.getTokenForChannel("0Mjxx0000000002AAA")).rejects.toThrow("channel_not_found");
});

test("resolve-channel returns 409 when a prefix matches two orgs", async () => {
  mockSalesforce({});
  const entrypoint = new TubotSfAuthEntrypoint(null, resolveFixture([
    { teamId: "team", orgId, channelId: CH18 },
    { teamId: "team", orgId: "00D000000000002AAA", channelId: CH18 },
  ]));
  await expect(entrypoint.getTokenForChannel(CH15)).rejects.toThrow("channel_org_ambiguous");
});

test("resolve-channel rejects an invalid channel id", async () => {
  mockSalesforce({});
  const entrypoint = new TubotSfAuthEntrypoint(null, resolveFixture([]));
  await expect(entrypoint.getTokenForChannel("bogus")).rejects.toThrow("invalid_request");
});

// sessionState RPC: live handoff state for the proxy guard, resolved from live
// MessagingSession escalation fields plus PendingServiceRouting queue truth.
// Auth failures throw explicitly (401); only unknown sessions return null.
const handoffScope = { teamId: "team", orgId, channelId: "0Mj000000000001AAA" };
const handoffConversation = "c7052169-d5cd-4369-8514-ef7cf1bc1234";
const handoffSessionId = "0Mw000000000001AAA";
const handoffQueueId = "00G000000000001AAA";

function mockHandoffSalesforce(opts: {
  fields?: string[];
  flagged?: Record<string, unknown> | null;
  flaggedStatus?: number;
  recent?: Record<string, unknown>[];
  recentStatus?: number;
  psrs?: Record<string, unknown>[];
  psrStatus?: number;
  group?: Record<string, unknown> | null;
  groupStatus?: number;
} = {}) {
  const fields = opts.fields ?? ["Id", "tubot__Escalate_To_Human__c", "Escalate_To_Human__c"];
  return mockSalesforce({
    "/services/data/v65.0/sobjects/MessagingSession/describe": { fields: fields.map((name) => ({ name })) },
    "/services/data/v65.0/query": (_init: RequestInit | undefined, url: URL) => {
      const q = url.searchParams.get("q") ?? "";
      if (q.includes("FROM MessagingSession") && q.includes("=true")) {
        if (opts.flaggedStatus) return Response.json([{ message: "boom" }], { status: opts.flaggedStatus });
        return Response.json({ records: opts.flagged ? [opts.flagged] : [] });
      }
      if (q.includes("FROM MessagingSession")) {
        if (opts.recentStatus) return Response.json([{ message: "boom" }], { status: opts.recentStatus });
        return Response.json({ records: opts.recent ?? [] });
      }
      if (q.includes("FROM PendingServiceRouting")) {
        if (opts.psrStatus) return Response.json([{ message: "boom" }], { status: opts.psrStatus });
        return Response.json({ records: opts.psrs ?? [] });
      }
      if (q.includes("FROM Group")) {
        if (opts.groupStatus) return Response.json([{ message: "boom" }], { status: opts.groupStatus });
        return Response.json({ records: opts.group ? [opts.group] : [] });
      }
      return Response.json([{ message: "unexpected query" }], { status: 400 });
    },
  });
}

test("broker sessionState flags an older escalated row among duplicate conversation rows", async () => {
  const seen = mockHandoffSalesforce({
    flagged: { Id: handoffSessionId },
    recent: [{ Id: "0Mw000000000003AAA" }, { Id: "0Mw000000000002AAA" }, { Id: handoffSessionId }],
    psrs: [{ WorkItemId: handoffSessionId, QueueId: handoffQueueId }],
    group: { DeveloperName: "Chat_Queue" },
  });
  const broker = new MessagingProxyBroker(null, await fixture());
  await expect(broker.sessionState(handoffScope, handoffConversation)).resolves.toEqual({
    escalated: true, queueName: "Chat_Queue", queueId: handoffQueueId,
  });
  const sessionQueries = seen.filter((s) => (s.url.searchParams.get("q") ?? "").includes("FROM MessagingSession"));
  expect(sessionQueries.length).toBe(2);
  for (const s of sessionQueries) {
    expect(s.url.searchParams.get("q")).toContain(`MessagingChannelId='${handoffScope.channelId}'`);
    expect(s.url.searchParams.get("q")).toContain(`ConversationIdentifier='${handoffConversation}'`);
  }
  expect(sessionQueries[0].url.searchParams.get("q")).toContain("tubot__Escalate_To_Human__c=true");
});

test("broker sessionState returns a negative live state for a non-escalated session", async () => {
  mockHandoffSalesforce({
    recent: [{ Id: handoffSessionId }],
    psrs: [{ WorkItemId: handoffSessionId, QueueId: handoffQueueId }],
    group: { DeveloperName: "AI_Bot_Holding_Queue_100" },
  });
  const broker = new MessagingProxyBroker(null, await fixture());
  await expect(broker.sessionState(handoffScope, handoffConversation)).resolves.toEqual({
    escalated: false, queueName: "AI_Bot_Holding_Queue_100", queueId: handoffQueueId,
  });
});

test("broker sessionState reads the newest routed row when the newest row is unrouted", async () => {
  mockHandoffSalesforce({
    recent: [{ Id: "0Mw000000000003AAA" }, { Id: handoffSessionId }],
    psrs: [{ WorkItemId: handoffSessionId, QueueId: handoffQueueId }],
    group: { DeveloperName: "Chat_Queue" },
  });
  const broker = new MessagingProxyBroker(null, await fixture());
  await expect(broker.sessionState(handoffScope, handoffConversation)).resolves.toEqual({
    escalated: false, queueName: "Chat_Queue", queueId: handoffQueueId,
  });
});

test("broker sessionState returns null only for an unknown session", async () => {
  mockHandoffSalesforce({});
  const broker = new MessagingProxyBroker(null, await fixture());
  await expect(broker.sessionState(handoffScope, handoffConversation)).resolves.toBeNull();
});

test("broker sessionState keeps the flag when routing carries no queue (skills-based)", async () => {
  mockHandoffSalesforce({
    flagged: { Id: handoffSessionId },
    recent: [{ Id: handoffSessionId }],
    psrs: [{ WorkItemId: handoffSessionId, QueueId: null }],
  });
  const broker = new MessagingProxyBroker(null, await fixture());
  await expect(broker.sessionState(handoffScope, handoffConversation)).resolves.toEqual({
    escalated: true, queueName: null, queueId: null,
  });
});

test("broker sessionState reads the unnamespaced flag on orgs without packaged fields", async () => {
  const seen = mockHandoffSalesforce({
    fields: ["Id", "Escalate_To_Human__c"],
    flagged: { Id: handoffSessionId },
    recent: [{ Id: handoffSessionId }],
    psrs: [{ WorkItemId: handoffSessionId, QueueId: handoffQueueId }],
    group: { DeveloperName: "Chat_Queue" },
  });
  const broker = new MessagingProxyBroker(null, await fixture());
  await expect(broker.sessionState(handoffScope, handoffConversation)).resolves.toEqual({
    escalated: true, queueName: "Chat_Queue", queueId: handoffQueueId,
  });
  const flaggedQuery = seen.find((s) => (s.url.searchParams.get("q") ?? "").includes("=true"));
  expect(flaggedQuery?.url.searchParams.get("q")).toContain("Escalate_To_Human__c=true");
  expect(flaggedQuery?.url.searchParams.get("q")).not.toContain("tubot__");
});

test("broker sessionState reports un-escalated when no org field carries the flag", async () => {
  mockHandoffSalesforce({
    fields: ["Id", "Status"],
    recent: [{ Id: handoffSessionId }],
    psrs: [{ WorkItemId: handoffSessionId, QueueId: handoffQueueId }],
    group: { DeveloperName: "Chat_Queue" },
  });
  const broker = new MessagingProxyBroker(null, await fixture());
  await expect(broker.sessionState(handoffScope, handoffConversation)).resolves.toEqual({
    escalated: false, queueName: "Chat_Queue", queueId: handoffQueueId,
  });
});

test("broker sessionState throws explicitly when a session read fails, never null", async () => {
  mockHandoffSalesforce({ flaggedStatus: 500, recent: [{ Id: handoffSessionId }] });
  const broker = new MessagingProxyBroker(null, await fixture());
  await expect(broker.sessionState(handoffScope, handoffConversation)).rejects.toThrow("session_state_unavailable");
  mockHandoffSalesforce({ recentStatus: 500 });
  const retry = new MessagingProxyBroker(null, await fixture());
  await expect(retry.sessionState(handoffScope, handoffConversation)).rejects.toThrow("session_state_unavailable");
});

test("broker sessionState degrades routing names but keeps the flag and queue id", async () => {
  mockHandoffSalesforce({
    flagged: { Id: handoffSessionId },
    recent: [{ Id: handoffSessionId }],
    psrs: [{ WorkItemId: handoffSessionId, QueueId: handoffQueueId }],
    groupStatus: 403,
  });
  const broker = new MessagingProxyBroker(null, await fixture());
  await expect(broker.sessionState(handoffScope, handoffConversation)).resolves.toEqual({
    escalated: true, queueName: null, queueId: handoffQueueId,
  });
  mockHandoffSalesforce({
    flagged: { Id: handoffSessionId },
    recent: [{ Id: handoffSessionId }],
    psrStatus: 500,
  });
  const retry = new MessagingProxyBroker(null, await fixture());
  await expect(retry.sessionState(handoffScope, handoffConversation)).resolves.toEqual({
    escalated: true, queueName: null, queueId: null, routingError: "session_state_routing_unavailable",
  });
});

test("broker sessionState rejects an unsigned call explicitly in enforce mode", async () => {
  mockHandoffSalesforce({
    flagged: { Id: handoffSessionId },
    recent: [{ Id: handoffSessionId }],
    psrs: [{ WorkItemId: handoffSessionId, QueueId: handoffQueueId }],
    group: { DeveloperName: "Chat_Queue" },
  });
  const env = await fixture();
  delete (env as Record<string, unknown>).AUTH_RPC_WARN_MODE;
  const broker = new MessagingProxyBroker(null, env);
  await expect(broker.sessionState(handoffScope, handoffConversation)).rejects.toThrow("rpc_unauthorized");
});

test("broker sessionState rejects a malformed conversation id", async () => {
  mockHandoffSalesforce({});
  const broker = new MessagingProxyBroker(null, await fixture());
  await expect(broker.sessionState(handoffScope, "not-a-uuid")).rejects.toThrow("invalid_proxy_entry");
});

test("injectSoapSession substitutes the placeholder only on SOAP paths", () => {
  const envelope = `<SessionHeader><sessionId>${SOAP_SESSION_PLACEHOLDER}</sessionId></SessionHeader>`;
  expect(injectSoapSession("/services/Soap/m/68.0", envelope, "tok123")).toBe(
    "<SessionHeader><sessionId>tok123</sessionId></SessionHeader>",
  );
  expect(injectSoapSession("/services/Soap/m/68.0", "<no-marker/>", "tok123")).toBe("<no-marker/>");
  expect(injectSoapSession("/services/data/v68.0/tooling/query", envelope, "tok123")).toBe(envelope);
  expect(injectSoapSession("/services/Soap/m/68.0", undefined, "tok123")).toBeUndefined();
});
