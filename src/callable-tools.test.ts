import { afterEach, expect, test } from "bun:test";
import { zipSync, strToU8 } from "fflate";
import worker, {
  TubotSfAuthEntrypoint,
  findCredentialByChannelId,
  findCredentialByScope,
  getCallableToolUrlsForChannel,
  resolveAgentFromChannel,
  type AuthEnv,
  type Credential,
  type SalesforceConnection,
} from "./index";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const secret = "a".repeat(48);
const orgId = "00D000000000001AAA";
const userId = "005000000000001AAA";
function scopedRequest(input:any,init:RequestInit={}) {
 const headers=new Headers(init.headers);headers.set("x-team-id","team-test");headers.set("x-org-id",orgId);
 headers.set("x-channel-id","0Mjg00000000001AAA");headers.set("x-channel-secret",secret);
 if(typeof init.body==="string") {const body=JSON.parse(init.body);if(body.channelId)headers.set("x-channel-id",body.channelId);}
 return new Request(input,{...init,headers});
}
const enc = new TextEncoder();
const keyBytes = new Uint8Array(32).fill(7);
const encryptionKey = btoa(String.fromCharCode(...keyBytes));
const hash = async (s: string) =>
  btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function createFixture(channelId = "0Mjg00000000001AAA") {
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, enc.encode("salesforce-secret"))
  );
  const row: Credential = {
    team_id: "team-test",
    org_id: orgId,
    channel_id: channelId,
    instance_url: "https://test.my.salesforce.com",
    client_id: "client-id",
    client_secret_cipher: btoa(String.fromCharCode(...cipher)),
    client_secret_iv: btoa(String.fromCharCode(...iv)),
    integration_user_id: userId,
    channel_secret_hash: await hash(secret),
  };

  const rows = [row];

  const db = {
    prepare(sql: string) {
      let bound: any[] = [];
      return {
        bind(...args: any[]) {
          bound = args;
          return this;
        },
        async first() {
          if (sql.includes("salesforce_auth_credential")) {
            if(sql.includes("team_id=? AND org_id=? AND channel_id=?")) return rows.find(r=>r.team_id===bound[0] && r.org_id===bound[1] && r.channel_id===bound[2]) || null;
            if (sql.includes("substr(channel_id, 1, 15) = ? OR channel_id LIKE ?")) {
              const prefix = bound[0];
              const match = rows.find(
                (r) => r.channel_id.slice(0, 15) === prefix || r.channel_id.startsWith(prefix)
              );
              return match || null;
            }
            if (sql.includes("channel_id = ?")) {
              const target = bound[0];
              const match = rows.find((r) => r.channel_id === target);
              return match || null;
            }
            return rows[0] || null;
          }
          if(sql.includes("salesforce_channel_connection")) return {secret_hash:row.channel_secret_hash};
          return null;
        },
      };
    },
  };

  return {
    DB: db as any,
    SF_CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
    row,
  };
}

function createMockZipPayload(
  agents: Record<string, { script: string; xml?: string; promptTemplates?: Record<string, string> }>
): string {
  const files: Record<string, Uint8Array> = {};
  for (const [agentName, content] of Object.entries(agents)) {
    files[`unpackaged/aiAuthoringBundles/${agentName}/${agentName}.agent`] = strToU8(content.script);
    if (content.xml) {
      files[`unpackaged/aiAuthoringBundles/${agentName}/${agentName}.bundle-meta.xml`] = strToU8(content.xml);
    }
    if (content.promptTemplates) {
      for (const [tplName, tplXml] of Object.entries(content.promptTemplates)) {
        files[`unpackaged/genAiPromptTemplates/${tplName}.genAiPromptTemplate`] = strToU8(tplXml);
      }
    }
  }
  const compressed = zipSync(files);
  return btoa(String.fromCharCode(...compressed));
}

function setupMockSalesforceFetch(zipB64: string) {
  let soapPollCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const url = decodeURIComponent(urlStr);

    if (url.includes("/services/oauth2/token")) {
      return Response.json({ access_token: "mock-access-token", instance_url: "https://test.my.salesforce.com" });
    }
    if (url.includes("/services/oauth2/userinfo")) {
      return Response.json({ organization_id: orgId, user_id: userId });
    }

    if (url.includes("FROM MessagingChannel")) {
      return Response.json({
        records: [
          {
            Id: "0Mjg00000000001AAA",
            DeveloperName: "SupportChat",
            MasterLabel: "Support Chat",
            SessionHandlerId: "0Xx000000000001AAA",
          },
        ],
      });
    }

    if (url.includes("FROM BotDefinition")) {
      return Response.json({
        records: [{ Id: "0Xx000000000001AAA", DeveloperName: "SupportAgent" }],
      });
    }

    if (url.includes("/services/Soap/m/")) {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("<met:retrieve>")) {
        return new Response(
          `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
             <soapenv:Body><id>async-test-id</id></soapenv:Body>
           </soapenv:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } }
        );
      }
      if (body.includes("<met:checkRetrieveStatus>")) {
        soapPollCount++;
        return new Response(
          `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
             <soapenv:Body>
               <done>true</done>
               <zipFile>${zipB64}</zipFile>
             </soapenv:Body>
           </soapenv:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } }
        );
      }
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;
}

test("findCredentialByChannelId finds credential by exact and 15-char prefix", async () => {
  const env = await createFixture("0Mjg00000000001AAA");

  // Exact match
  const exact = await findCredentialByChannelId(env.DB, "0Mjg00000000001AAA");
  expect(exact).not.toBeNull();
  expect(exact?.channel_id).toBe("0Mjg00000000001AAA");
  expect(exact?.org_id).toBe(orgId);

  // 15-char prefix match (18-char channelId matching 15-char prefix)
  const prefixMatch = await findCredentialByChannelId(env.DB, "0Mjg00000000001BBB");
  expect(prefixMatch).not.toBeNull();
  expect(prefixMatch?.channel_id).toBe("0Mjg00000000001AAA");

  // Non-matching channelId
  const nonMatch = await findCredentialByChannelId(env.DB, "0Mjg99999999999ZZZ");
  expect(nonMatch).toBeNull();

  // Empty string
  const emptyMatch = await findCredentialByChannelId(env.DB, "   ");
  expect(emptyMatch).toBeNull();
});

test("getCallableToolUrlsForChannel with mock RPC binding getCallableToolUrls", async () => {
  const sampleScript = `system_prompt: 'Support agent'
tools:
  - action: OrderStatus
    template: OrderStatusTemplate`;

  const zipB64 = createMockZipPayload({
    SupportAgent: {
      script: sampleScript,
      promptTemplates: {
        OrderStatusTemplate: "<GenAiPromptTemplate>Prompt XML</GenAiPromptTemplate>",
      },
    },
  });

  setupMockSalesforceFetch(zipB64);
  const env = await createFixture();

  let capturedRpcParams: any = null;
  const mockRpcBinding = {
    async getCallableToolUrls(params: any) {
      capturedRpcParams = params;
      return [
        "https://retrieve64.example.com/tools/lookup_order",
        "https://retrieve64.example.com/tools/cancel_order",
      ];
    },
  };

  const urls = await getCallableToolUrlsForChannel("0Mjg00000000001AAA", {
    env,
    rpcBinding: mockRpcBinding,
    pollIntervalMs: 10,
    maxPollAttempts: 5,
    teamId: "team-test",
  });

  expect(urls).toEqual([
    "https://retrieve64.example.com/tools/lookup_order",
    "https://retrieve64.example.com/tools/cancel_order",
  ]);

  expect(capturedRpcParams).not.toBeNull();
  expect(capturedRpcParams.orgId).toBe(orgId);
  expect(capturedRpcParams.channelId).toBe("0Mjg00000000001AAA");
  expect(capturedRpcParams.teamId).toBe("team-test");
  expect(capturedRpcParams.definition).toBe(sampleScript);
  expect(capturedRpcParams.promptTemplates).toHaveProperty("OrderStatusTemplate");
  expect(capturedRpcParams.accessToken).toBe("mock-access-token");
  expect(capturedRpcParams.instanceUrl).toBe("https://test.my.salesforce.com");
});

test("getCallableToolUrlsForChannel with service binding fetch fallback", async () => {
  const sampleScript = `system_prompt: 'Billing agent'`;
  const zipB64 = createMockZipPayload({
    SupportAgent: { script: sampleScript },
  });

  setupMockSalesforceFetch(zipB64);
  const env = await createFixture();

  let fetchCalledUrl = "";
  let fetchHeaders: Headers | null = null;
  let fetchBody: any = null;

  const mockServiceBinding = {
    async fetch(input: any, init?: any) {
      fetchCalledUrl = String(input);
      fetchHeaders = new Headers(init?.headers);
      fetchBody = JSON.parse(init?.body);
      return Response.json({
        ok: true,
        urls: ["https://retrieve64.example.com/tools/invoice_lookup"],
      });
    },
  };

  const urls = await getCallableToolUrlsForChannel("0Mjg00000000001AAA", {
    env,
    rpcBinding: mockServiceBinding,
    pollIntervalMs: 10,
    maxPollAttempts: 5,
  });

  expect(urls).toEqual(["https://retrieve64.example.com/tools/invoice_lookup"]);
  expect(fetchCalledUrl).toBe("https://retrieve64.internal/definitions");
  expect(fetchHeaders?.get("x-salesforce-access-token")).toBe("mock-access-token");
  expect(fetchHeaders?.get("x-salesforce-instance-url")).toBe("https://test.my.salesforce.com");
  expect(fetchBody.channelId).toBe("0Mjg00000000001AAA");
  expect(fetchBody.definition).toBe(sampleScript);
});

test("getCallableToolUrlsForChannel with D1 database fixture and HTTP fetch fallback", async () => {
  const sampleScript = `system_prompt: 'Helpdesk agent'`;
  const zipB64 = createMockZipPayload({
    SupportAgent: { script: sampleScript },
  });

  let httpDefinitionsCalled = false;
  let httpPayload: any = null;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;

    if (urlStr.includes("retrieve64.emalteaproductions.workers.dev/definitions")) {
      httpDefinitionsCalled = true;
      httpPayload = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      return Response.json({
        callableToolUrls: ["https://retrieve64.example.com/tools/create_ticket"],
      });
    }

    if (urlStr.includes("/services/oauth2/token")) {
      return Response.json({ access_token: "mock-access-token", instance_url: "https://test.my.salesforce.com" });
    }
    if (urlStr.includes("/services/oauth2/userinfo")) {
      return Response.json({ organization_id: orgId, user_id: userId });
    }
    if (decodeURIComponent(urlStr).includes("FROM MessagingChannel")) {
      return Response.json({
        records: [
          {
            Id: "0Mjg00000000001AAA",
            DeveloperName: "SupportChat",
            MasterLabel: "Support Chat",
            SessionHandlerId: "0Xx000000000001AAA",
          },
        ],
      });
    }
    if (decodeURIComponent(urlStr).includes("FROM BotDefinition")) {
      return Response.json({
        records: [{ Id: "0Xx000000000001AAA", DeveloperName: "SupportAgent" }],
      });
    }
    if (urlStr.includes("/services/Soap/m/")) {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("<met:retrieve>")) {
        return new Response(
          `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
             <soapenv:Body><id>async-test-id</id></soapenv:Body>
           </soapenv:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } }
        );
      }
      if (body.includes("<met:checkRetrieveStatus>")) {
        return new Response(
          `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
             <soapenv:Body>
               <done>true</done>
               <zipFile>${zipB64}</zipFile>
             </soapenv:Body>
           </soapenv:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } }
        );
      }
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;

  const env = await createFixture("0Mjg00000000001AAA");

  // Call with AuthEnv directly (conn resolved from D1 database)
  const urls = await getCallableToolUrlsForChannel("0Mjg00000000001AAA", {
    env,
    pollIntervalMs: 10,
    maxPollAttempts: 5,
  });

  expect(httpDefinitionsCalled).toBe(true);
  expect(httpPayload.channelId).toBe("0Mjg00000000001AAA");
  expect(httpPayload.orgId).toBe(orgId);
  expect(urls).toEqual(["https://retrieve64.example.com/tools/create_ticket"]);
});

test("TubotSfAuthEntrypoint delegates getCallableToolUrlsForChannel to implementation", async () => {
  const sampleScript = `system_prompt: 'Entrypoint agent'`;
  const zipB64 = createMockZipPayload({
    SupportAgent: { script: sampleScript },
  });

  setupMockSalesforceFetch(zipB64);
  const env = await createFixture();
  (env as any).RETRIEVE64 = {
    async getCallableToolUrls() {
      return ["https://retrieve64.example.com/tools/rpc_entrypoint_tool"];
    },
  };

  const entrypoint = new TubotSfAuthEntrypoint(null, env);
  const urls = await entrypoint.getCallableToolUrlsForChannel("0Mjg00000000001AAA", {
    pollIntervalMs: 10,
    maxPollAttempts: 5,
  });

  expect(urls).toEqual(["https://retrieve64.example.com/tools/rpc_entrypoint_tool"]);
});

test("POST /internal/channels/callable-tools HTTP route returns tool URLs", async () => {
  const sampleScript = `system_prompt: 'HTTP endpoint agent'`;
  const zipB64 = createMockZipPayload({
    SupportAgent: { script: sampleScript },
  });

  setupMockSalesforceFetch(zipB64);
  const env = await createFixture();
  (env as any).RETRIEVE64 = {
    async getCallableToolUrls() {
      return ["https://retrieve64.example.com/tools/http_test_tool"];
    },
  };

  // 1. Successful request
  const req = scopedRequest("https://auth.internal/internal/channels/callable-tools", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channelId: "0Mjg00000000001AAA",
      teamId: "team-test",
    }),
  });

  const res = await worker.fetch(req, env as any);
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect(data.ok).toBe(true);
  expect(data.channelId).toBe("0Mjg00000000001AAA");
  expect(data.urls).toEqual(["https://retrieve64.example.com/tools/http_test_tool"]);

  // 2. Missing channelId returns 400
  const badReq = scopedRequest("https://auth.internal/internal/channels/callable-tools", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teamId: "team-test" }),
  });

  const badRes = await worker.fetch(badReq, env as any);
  expect(badRes.status).toBe(400);
  const badData = (await badRes.json()) as any;
  expect(badData.error).toBe("invalid_request");
});

test("resolveAgentFromChannel falls back to unnamespaced Agentforce_Agent_Select__c", async () => {
  const conn: SalesforceConnection = {
    instanceUrl: "https://test.my.salesforce.com",
    accessToken: "mock-token",
  };

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = decodeURIComponent(String(input));

    if (url.includes("FROM MessagingChannel")) {
      return Response.json({
        records: [
          {
            Id: "0Mjg00000000001AAA",
            DeveloperName: "CustomChannel",
            MasterLabel: "CustomChannel",
          },
        ],
      });
    }

    // Fail the namespaced tubot__ query to simulate an org like test2 without package prefix
    if (url.includes("FROM tubot__Agentforce_Agent_Select__c")) {
      return Response.json(
        [{ message: "sObject type 'tubot__Agentforce_Agent_Select__c' is not supported" }],
        { status: 400 }
      );
    }

    // Fallback unnamespaced table succeeds
    if (url.includes("FROM Agentforce_Agent_Select__c")) {
      return Response.json({
        records: [{ Id: "a00000000000001AAA", Name: "CustomChannel", Agent_Name__c: "Test2Agent" }],
      });
    }

    return Response.json({ records: [] });
  }) as typeof fetch;

  const agent = await resolveAgentFromChannel(conn, "CustomChannel");
  expect(agent).toBe("Test2Agent");
});

test("POST /internal/channels/token returns valid token for channel", async () => {
  const env = await createFixture();
  const worker = (await import("./index")).default;

  // Mock Salesforce OAuth token endpoint
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/services/oauth2/token")) {
      return Response.json({
        access_token: "mock-oauth-token-123",
        instance_url: "https://test.my.salesforce.com",
        expires_in: 300,
      });
    }
    if (url.includes("/services/oauth2/userinfo")) {
      return Response.json({
        organization_id: "00D000000000001AAA",
        user_id: "005000000000001AAA",
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const req = scopedRequest("https://auth.internal/internal/channels/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId: "0Mjg00000000001AAA" }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.accessToken).toBe("mock-oauth-token-123");
    expect(body.instanceUrl).toBe("https://test.my.salesforce.com");
    expect(body.orgId).toBe("00D000000000001AAA");

    // Test with non-existent channel
    const notFoundReq = scopedRequest("https://auth.internal/internal/channels/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId: "nonexistent-channel" }),
    });
    const notFoundRes = await worker.fetch(notFoundReq, env);
    expect(notFoundRes.status).toBe(403);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TubotSfAuthEntrypoint.getTokenForChannel returns token via RPC", async () => {
  const env = await createFixture();
  const { TubotSfAuthEntrypoint } = await import("./index");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/services/oauth2/token")) {
      return Response.json({
        access_token: "mock-rpc-oauth-token",
        instance_url: "https://test.my.salesforce.com",
        expires_in: 300,
      });
    }
    if (url.includes("/services/oauth2/userinfo")) {
      return Response.json({
        organization_id: "00D000000000001AAA",
        user_id: "005000000000001AAA",
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const entrypoint = new TubotSfAuthEntrypoint(null, env);
    const tokenResult = await entrypoint.getTokenForChannel("0Mjg00000000001AAA");
    expect(tokenResult.accessToken).toBe("mock-rpc-oauth-token");
    expect(tokenResult.instanceUrl).toBe("https://test.my.salesforce.com");
    expect(tokenResult.orgId).toBe("00D000000000001AAA");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("findCredentialByScope resolves the exact tenant triple", async () => {
  const env = await createFixture("0Mjg00000000001AAA");

  const row = await findCredentialByScope(env.DB, "team-test", orgId, "0Mjg00000000001AAA");
  expect(row).not.toBeNull();
  expect(row?.team_id).toBe("team-test");
  expect(row?.org_id).toBe(orgId);

  expect(await findCredentialByScope(env.DB, "team-other", orgId, "0Mjg00000000001AAA")).toBeNull();
  expect(await findCredentialByScope(env.DB, "team-test", "00D000000000002AAA", "0Mjg00000000001AAA")).toBeNull();
  expect(await findCredentialByScope(env.DB, "", orgId, "0Mjg00000000001AAA")).toBeNull();
});

test("getCallableToolUrlsForChannel uses the scoped tenant on channel_id collision", async () => {
  const sampleScript = `system_prompt: 'Scoped agent'`;
  const zipB64 = createMockZipPayload({ SupportAgent: { script: sampleScript } });
  setupMockSalesforceFetch(zipB64);

  // Same channel enrolled under two teams; the foreign row sorts first so a
  // channel-only LIMIT 1 lookup would select (and mint for) the wrong tenant.
  const base = await createFixture("0Mjg00000000001AAA");
  const foreign: Credential = {
    ...base.row,
    team_id: "team-foreign",
    instance_url: "https://foreign.my.salesforce.com",
    client_id: "foreign-client",
  };
  const scoped: Credential = {
    ...base.row,
    team_id: "team-test",
    instance_url: "https://scoped.my.salesforce.com",
    client_id: "scoped-client",
  };
  const rows = [foreign, scoped];
  const db = {
    prepare(sql: string) {
      let bound: any[] = [];
      return {
        bind(...args: any[]) {
          bound = args;
          return this;
        },
        async first() {
          if (sql.includes("salesforce_auth_credential")) {
            if (sql.includes("team_id=? AND org_id=? AND channel_id=?")) {
              return (
                rows.find((r) => r.team_id === bound[0] && r.org_id === bound[1] && r.channel_id === bound[2]) ||
                null
              );
            }
            if (sql.includes("channel_id = ?")) {
              return rows.find((r) => r.channel_id === bound[0]) || null;
            }
            return rows[0] || null;
          }
          if (sql.includes("salesforce_channel_connection")) return { secret_hash: scoped.channel_secret_hash };
          return null;
        },
      };
    },
  };
  const env = { DB: db as any, SF_CREDENTIAL_ENCRYPTION_KEY: base.SF_CREDENTIAL_ENCRYPTION_KEY };

  // Record which Salesforce host receives the client-credentials token
  // request: that proves which enrollment row was selected.
  const innerFetch = globalThis.fetch;
  const tokenHosts: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input?.url;
    if (String(urlStr).includes("/services/oauth2/token")) tokenHosts.push(new URL(String(urlStr)).origin);
    return innerFetch(input, init);
  }) as typeof fetch;

  let captured: any = null;
  const mockRpcBinding = {
    async getCallableToolUrls(params: any) {
      captured = params;
      return ["https://retrieve64.example.com/tools/scoped"];
    },
  };

  const urls = await getCallableToolUrlsForChannel("0Mjg00000000001AAA", {
    env: env as any,
    rpcBinding: mockRpcBinding,
    pollIntervalMs: 10,
    maxPollAttempts: 5,
    teamId: "team-test",
    orgId,
  });

  expect(urls).toEqual(["https://retrieve64.example.com/tools/scoped"]);
  expect(captured).not.toBeNull();
  expect(captured.teamId).toBe("team-test");
  // The token must be minted from the scoped row, not the first channel match.
  expect(tokenHosts).toEqual(["https://scoped.my.salesforce.com"]);
});

test("getCallableToolUrlsForChannel rejects a scope with no matching enrollment", async () => {
  const env = await createFixture("0Mjg00000000001AAA");
  await expect(
    getCallableToolUrlsForChannel("0Mjg00000000001AAA", {
      env: env as any,
      teamId: "team-test",
      orgId: "00D000000000002AAA",
    })
  ).rejects.toThrow("No Salesforce credentials found");
});

