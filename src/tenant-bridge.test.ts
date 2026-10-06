import { afterEach, expect, test } from "bun:test";
import worker, { TubotSfAuthEntrypoint, credentialForEntrypoint } from "./index";
import {
  clearBridgeCachesForTests,
  expireBridgeCachesForTests,
  fetchBridgeCredential,
  fetchBridgeTenants,
} from "./tenant-bridge";

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  clearBridgeCachesForTests();
});

const enc = new TextEncoder();
const keyBytes = new Uint8Array(32).fill(9);
const encryptionKey = btoa(String.fromCharCode(...keyBytes));
const BRIDGE_SECRET = "bridge-shared-secret-for-tests-only-0123456789";
const stagingTeam = "staging-team";
const stagingOrg = "00D000000000001AAA";
const stagingChannel = "0Db000000000001AAA";
const stagingUser = "005000000000001AAA";
const stagingInstance = "https://staging.my.salesforce.com";
const bridgeTeam = "bridge-team";
const bridgeOrg = "00D000000000002BBB";
const bridgeChannel = "0Db000000000002BBB";
const bridgeUser = "005000000000002BBB";
const bridgeInstance = "https://bridge.my.salesforce.com";
const channelSecret = "s".repeat(48);

const hash = async (s: string) =>
  btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const triple = (t: { teamId: string; orgId: string; channelId: string }) =>
  [t.teamId, t.orgId, t.channelId].join("\u0000");

async function stagingRow() {
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, enc.encode("staging-salesforce-secret")),
  );
  return {
    team_id: stagingTeam,
    org_id: stagingOrg,
    channel_id: stagingChannel,
    instance_url: stagingInstance,
    client_id: "staging-client",
    client_secret_cipher: btoa(String.fromCharCode(...cipher)),
    client_secret_iv: btoa(String.fromCharCode(...iv)),
    integration_user_id: stagingUser,
    channel_secret_hash: await hash(channelSecret),
  };
}

function dbStub(row: Record<string, unknown>, seenSql: string[], grantValid = true) {
  const stagingInventory = {
    results: [{ teamId: stagingTeam, orgId: stagingOrg, channelId: stagingChannel }],
  };
  return {
    prepare(sql: string) {
      seenSql.push(sql);
      const statement = {
        bind(...args: unknown[]) {
          return {
            async run() {
              return { success: true };
            },
            async first() {
              if (sql.includes("FROM salesforce_auth_credential")) {
                const [teamId, orgId, channelId] = args as string[];
                return teamId === row.team_id && orgId === row.org_id && channelId === row.channel_id
                  ? row
                  : null;
              }
              if (sql.includes("FROM salesforce_channel_connection")) {
                return grantValid ? { secret_hash: row.channel_secret_hash } : null;
              }
              return null;
            },
            async all() {
              return stagingInventory;
            },
          };
        },
        async all() {
          return stagingInventory;
        },
      };
      return statement;
    },
  };
}

type BridgeStubOptions = {
  tenants: unknown[];
  credentials: Record<string, unknown>;
  failTenants?: boolean;
  failCredentialTimes?: number;
  attempts?: { tenants: number; credential: number };
};

function bridgeStub(options: BridgeStubOptions, seen: Array<{ path: string; body: unknown }>) {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      if (request.headers.get("x-bridge-secret") !== BRIDGE_SECRET) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (url.pathname === "/internal/bridge/tenants") {
        if (options.attempts) options.attempts.tenants += 1;
        if (options.failTenants) throw new Error("bridge boom");
        return Response.json({ tenants: options.tenants });
      }
      if (url.pathname === "/internal/bridge/credential") {
        if (options.attempts) options.attempts.credential += 1;
        if (options.failCredentialTimes && options.failCredentialTimes > 0) {
          options.failCredentialTimes -= 1;
          throw new Error("bridge boom");
        }
        const body = (await request.json()) as { teamId: string; orgId: string; channelId: string };
        seen.push({ path: url.pathname, body });
        const found = options.credentials[triple(body)];
        if (!found) return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json(found);
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  };
}

function mockSalesforce() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/services/oauth2/token") {
      return Response.json({ access_token: `tok-for-${url.hostname}` });
    }
    if (url.pathname === "/services/oauth2/userinfo") {
      return url.hostname === "bridge.my.salesforce.com"
        ? Response.json({ organization_id: bridgeOrg, user_id: bridgeUser })
        : Response.json({ organization_id: stagingOrg, user_id: stagingUser });
    }
    if (url.pathname === "/services/data/" || url.pathname === "/services/data") {
      return Response.json([{ version: "65.0" }]);
    }
    return Response.json([{ message: "not found" }], { status: 404 });
  }) as typeof fetch;
}

const bridgeCredential = {
  teamId: bridgeTeam,
  orgId: bridgeOrg,
  channelId: bridgeChannel,
  instanceUrl: bridgeInstance,
  clientId: "bridge-client",
  clientSecret: "bridge-plaintext-secret",
  integrationUserId: bridgeUser,
};

async function envWithBridge(options: BridgeStubOptions, seen: Array<{ path: string; body: unknown }>) {
  const seenSql: string[] = [];
  const row = await stagingRow();
  return {
    env: {
      DB: dbStub(row, seenSql),
      SF_CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
      BRIDGE_SHARED_SECRET: BRIDGE_SECRET,
      NEW_PANEL: bridgeStub(options, seen),
    },
    seenSql,
  };
}

function silenceConsoleError() {
  const lines: string[] = [];
  console.error = ((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  }) as typeof console.error;
  return lines;
}

test("listConnectedOrgs unions staging and bridge tenants, deduping exact triples", async () => {
  const seen: Array<{ path: string; body: unknown }> = [];
  const { env } = await envWithBridge(
    {
      tenants: [
        { teamId: stagingTeam, orgId: stagingOrg, channelId: stagingChannel },
        { teamId: bridgeTeam, orgId: bridgeOrg, channelId: bridgeChannel },
        { teamId: "", orgId: "bogus", channelId: "bogus" },
      ],
      credentials: {},
    },
    seen,
  );
  const entrypoint = new TubotSfAuthEntrypoint(null, env);
  expect(await entrypoint.listConnectedOrgs()).toEqual([
    { teamId: stagingTeam, orgId: stagingOrg, channelId: stagingChannel },
    { teamId: bridgeTeam, orgId: bridgeOrg, channelId: bridgeChannel },
  ]);
});

test("listConnectedOrgs degrades to staging-only without a bridge secret and never throws", async () => {
  const lines = silenceConsoleError();
  const seenSql: string[] = [];
  const row = await stagingRow();
  const env = { DB: dbStub(row, seenSql), SF_CREDENTIAL_ENCRYPTION_KEY: encryptionKey };
  const entrypoint = new TubotSfAuthEntrypoint(null, env);
  expect(await entrypoint.listConnectedOrgs()).toEqual([
    { teamId: stagingTeam, orgId: stagingOrg, channelId: stagingChannel },
  ]);
  expect(lines.join("\n")).toContain("bridge_tenants_unavailable");
  expect(lines.join("\n")).not.toContain(BRIDGE_SECRET);
});

test("listConnectedOrgs degrades to staging-only when the bridge fetch fails", async () => {
  silenceConsoleError();
  const seen: Array<{ path: string; body: unknown }> = [];
  const { env } = await envWithBridge({ tenants: [], credentials: {}, failTenants: true }, seen);
  const entrypoint = new TubotSfAuthEntrypoint(null, env);
  expect(await entrypoint.listConnectedOrgs()).toEqual([
    { teamId: stagingTeam, orgId: stagingOrg, channelId: stagingChannel },
  ]);
});

test("authorized serves bridge tenants over HTTP without persisting or logging secrets", async () => {
  mockSalesforce();
  const lines = silenceConsoleError();
  const seen: Array<{ path: string; body: unknown }> = [];
  const { env, seenSql } = await envWithBridge(
    { tenants: [], credentials: { [triple(bridgeCredential)]: bridgeCredential } },
    seen,
  );
  const response = await worker.fetch(
    new Request("https://private.invalid/internal/channels/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: bridgeTeam,
        orgId: bridgeOrg,
        channelId: bridgeChannel,
        channelSecret: "b".repeat(48),
      }),
    }),
    env as never,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.accessToken).toBe("tok-for-bridge.my.salesforce.com");
  expect(JSON.stringify(body)).not.toContain("bridge-plaintext-secret");
  expect(seen).toEqual([
    {
      path: "/internal/bridge/credential",
      body: { teamId: bridgeTeam, orgId: bridgeOrg, channelId: bridgeChannel },
    },
  ]);
  expect(seenSql.some((sql) => /INSERT|UPDATE|DELETE/i.test(sql))).toBe(false);
  expect(lines.join("\n")).not.toContain("bridge-plaintext-secret");
});

test("staging enrollment stays authoritative when a bridge credential also exists", async () => {
  mockSalesforce();
  silenceConsoleError();
  const seen: Array<{ path: string; body: unknown }> = [];
  const hijack = {
    teamId: stagingTeam,
    orgId: stagingOrg,
    channelId: stagingChannel,
    instanceUrl: bridgeInstance,
    clientId: "hijack-client",
    clientSecret: "hijack-secret",
    integrationUserId: bridgeUser,
  };
  const { env } = await envWithBridge(
    { tenants: [], credentials: { [triple(hijack)]: hijack } },
    seen,
  );
  const requestFor = (secret: string) =>
    new Request("https://private.invalid/internal/channels/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: stagingTeam,
        orgId: stagingOrg,
        channelId: stagingChannel,
        channelSecret: secret,
      }),
    });
  const wrong = await worker.fetch(requestFor("w".repeat(48)), env as never);
  expect(wrong.status).toBe(403);
  const right = await worker.fetch(requestFor(channelSecret), env as never);
  expect(right.status).toBe(200);
  expect(((await right.json()) as Record<string, unknown>).accessToken).toBe(
    "tok-for-staging.my.salesforce.com",
  );
  expect(seen).toEqual([]);
});

test("inspectSalesforce serves bridge tenants and fails closed on unknown or invalid ones", async () => {
  mockSalesforce();
  silenceConsoleError();
  const seen: Array<{ path: string; body: unknown }> = [];
  const badCredential = {
    ...bridgeCredential,
    teamId: "bad-team",
    instanceUrl: "http://not-salesforce.example/",
  };
  const { env } = await envWithBridge(
    {
      tenants: [],
      credentials: {
        [triple(bridgeCredential)]: bridgeCredential,
        [triple(badCredential as typeof bridgeCredential)]: badCredential,
      },
    },
    seen,
  );
  const entrypoint = new TubotSfAuthEntrypoint(null, env);
  const result = await entrypoint.inspectSalesforce(
    { teamId: bridgeTeam, orgId: bridgeOrg, channelId: bridgeChannel },
    [{ method: "GET", path: "/services/data/" }],
  );
  expect(result).toEqual([{ status: 200, body: [{ version: "65.0" }] }]);

  const unknown: Array<{ status: number; code: string }> = [];
  for (const ref of [
    { teamId: bridgeTeam, orgId: bridgeOrg, channelId: "0Db000000000009ZZZ" },
    { teamId: "bad-team", orgId: bridgeOrg, channelId: bridgeChannel },
  ]) {
    try {
      await entrypoint.inspectSalesforce(ref, [{ method: "GET", path: "/services/data/" }]);
      unknown.push({ status: 0, code: "no-throw" });
    } catch (error) {
      const failure = (error as { failure?: { status: number; code: string } }).failure;
      unknown.push({ status: failure?.status ?? -1, code: failure?.code ?? "unknown" });
    }
  }
  expect(unknown).toEqual([
    { status: 404, code: "channel_not_found" },
    { status: 404, code: "channel_not_found" },
  ]);
});

test("credential fetch retries transient failures then succeeds", async () => {
  const attempts = { tenants: 0, credential: 0 };
  const seen: Array<{ path: string; body: unknown }> = [];
  const { env } = await envWithBridge(
    {
      tenants: [],
      credentials: { [triple(bridgeCredential)]: bridgeCredential },
      failCredentialTimes: 2,
      attempts,
    },
    seen,
  );
  const payload = await fetchBridgeCredential(env as never, {
    teamId: bridgeTeam, orgId: bridgeOrg, channelId: bridgeChannel,
  });
  expect(payload?.clientSecret).toBe("bridge-plaintext-secret");
  expect(attempts.credential).toBe(3);
});

test("credential fetch gives up after three attempts", async () => {
  const attempts = { tenants: 0, credential: 0 };
  const seen: Array<{ path: string; body: unknown }> = [];
  const { env } = await envWithBridge(
    {
      tenants: [],
      credentials: { [triple(bridgeCredential)]: bridgeCredential },
      failCredentialTimes: 9,
      attempts,
    },
    seen,
  );
  await expect(fetchBridgeCredential(env as never, {
    teamId: bridgeTeam, orgId: bridgeOrg, channelId: bridgeChannel,
  })).rejects.toThrow("bridge_unavailable");
  expect(attempts.credential).toBe(3);
});

test("credential 404 returns null without retrying", async () => {
  const attempts = { tenants: 0, credential: 0 };
  const seen: Array<{ path: string; body: unknown }> = [];
  const { env } = await envWithBridge({ tenants: [], credentials: {}, attempts }, seen);
  const payload = await fetchBridgeCredential(env as never, {
    teamId: bridgeTeam, orgId: bridgeOrg, channelId: bridgeChannel,
  });
  expect(payload).toBeNull();
  expect(attempts.credential).toBe(1);
});

test("credential fetch serves repeat triples from cache until expiry", async () => {
  const attempts = { tenants: 0, credential: 0 };
  const seen: Array<{ path: string; body: unknown }> = [];
  const { env } = await envWithBridge(
    {
      tenants: [],
      credentials: { [triple(bridgeCredential)]: bridgeCredential },
      attempts,
    },
    seen,
  );
  const scope = { teamId: bridgeTeam, orgId: bridgeOrg, channelId: bridgeChannel };
  const first = await fetchBridgeCredential(env as never, scope);
  const second = await fetchBridgeCredential(env as never, scope);
  expect(first?.clientSecret).toBe("bridge-plaintext-secret");
  expect(second?.clientSecret).toBe("bridge-plaintext-secret");
  expect(second).not.toBe(first);
  expect(attempts.credential).toBe(1);
  expireBridgeCachesForTests();
  await fetchBridgeCredential(env as never, scope);
  expect(attempts.credential).toBe(2);
});

test("credentialForEntrypoint serves staging rows without touching the bridge", async () => {
  const attempts = { tenants: 0, credential: 0 };
  const seen: Array<{ path: string; body: unknown }> = [];
  const { env } = await envWithBridge(
    { tenants: [], credentials: {}, attempts },
    seen,
  );
  const row = await credentialForEntrypoint(env as never, {
    teamId: stagingTeam, orgId: stagingOrg, channelId: stagingChannel,
  });
  expect(row.team_id).toBe(stagingTeam);
  expect(attempts.credential).toBe(0);
});

test("credentialForEntrypoint rejects staging rows without a grant and never falls back", async () => {
  const seenSql: string[] = [];
  const row = await stagingRow();
  const seen: Array<{ path: string; body: unknown }> = [];
  const attempts = { tenants: 0, credential: 0 };
  const env = {
    DB: dbStub(row, seenSql, false),
    SF_CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
    BRIDGE_SHARED_SECRET: BRIDGE_SECRET,
    NEW_PANEL: bridgeStub(
      { tenants: [], credentials: { [triple(bridgeCredential)]: bridgeCredential }, attempts },
      seen,
    ),
  };
  await expect(credentialForEntrypoint(env as never, {
    teamId: stagingTeam, orgId: stagingOrg, channelId: stagingChannel,
  })).rejects.toThrow("channel_not_authorized");
  expect(attempts.credential).toBe(0);
});

test("credentialForEntrypoint falls back to bridge credentials", async () => {
  const attempts = { tenants: 0, credential: 0 };
  const seen: Array<{ path: string; body: unknown }> = [];
  const { env } = await envWithBridge(
    {
      tenants: [],
      credentials: { [triple(bridgeCredential)]: bridgeCredential },
      attempts,
    },
    seen,
  );
  const row = await credentialForEntrypoint(env as never, {
    teamId: bridgeTeam, orgId: bridgeOrg, channelId: bridgeChannel,
  });
  expect(row.team_id).toBe(bridgeTeam);
  expect(row.org_id).toBe(bridgeOrg);
  expect(attempts.credential).toBe(1);
});

test("credentialForEntrypoint throws 404 when neither enrollment exists", async () => {
  const attempts = { tenants: 0, credential: 0 };
  const seen: Array<{ path: string; body: unknown }> = [];
  const { env } = await envWithBridge({ tenants: [], credentials: {}, attempts }, seen);
  await expect(credentialForEntrypoint(env as never, {
    teamId: bridgeTeam, orgId: bridgeOrg, channelId: bridgeChannel,
  })).rejects.toThrow("channel_not_found");
  expect(attempts.credential).toBe(1);
});

test("tenants list is cached across calls until expiry", async () => {
  const attempts = { tenants: 0, credential: 0 };
  const seen: Array<{ path: string; body: unknown }> = [];
  const { env } = await envWithBridge(
    {
      tenants: [{ teamId: bridgeTeam, orgId: bridgeOrg, channelId: bridgeChannel }],
      credentials: {},
      attempts,
    },
    seen,
  );
  const first = await fetchBridgeTenants(env as never);
  const second = await fetchBridgeTenants(env as never);
  expect(first).toEqual([{ teamId: bridgeTeam, orgId: bridgeOrg, channelId: bridgeChannel }]);
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  expect(attempts.tenants).toBe(1);
  expireBridgeCachesForTests();
  await fetchBridgeTenants(env as never);
  expect(attempts.tenants).toBe(2);
});
