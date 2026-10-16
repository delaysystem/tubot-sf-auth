import { afterEach, expect, test } from "bun:test";
import { zipSync, strToU8 } from "fflate";
import worker, {
  TubotSfAuthEntrypoint,
  type AuthEnv,
} from "./index";
import {
  getCallableToolUrlsForChannel,
  resolveAgentFromChannel,
  type Credential,
  type SalesforceConnection,
} from "./agent-script";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const orgId = "00D000000000001AAA";
const userId = "005000000000001AAA";
const keyBytes = new Uint8Array(32).fill(7);
const encryptionKey = btoa(String.fromCharCode(...keyBytes));

async function createFixture(channelId = "0Mjg00000000001AAA") {
  const row: Credential = {
    team_id: "team-test",
    org_id: orgId,
    channel_id: channelId,
    instance_url: "https://test.my.salesforce.com",
    integration_user_id: userId,
    integration_username: "integration@example.com",
    is_sandbox: 1,
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
          if (sql.includes("FROM panel_salesforce_channels") ||
              sql.includes("panel_salesforce_execution_users")) {
            if (sql.includes("team_id = ? AND org_id = ? AND channel_id = ?")) {
              return rows.find(r => r.team_id === bound[0] && r.org_id === bound[1] && r.channel_id === bound[2]) || null;
            }
            if (sql.includes("channel_id = ?")) {
              const target = bound[0];
              const match = rows.find((r) => r.channel_id === target);
              return match || null;
            }
            return rows[0] || null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM panel_salesforce_channels")) {
            const target = String(bound[0] ?? "");
            const prefix = String(bound[1] ?? target.slice(0, 15));
            const matches = rows.filter((r) => r.channel_id === target || r.channel_id.slice(0, 15) === prefix);
            return { results: matches.map((r) => ({ teamId: r.team_id, orgId: r.org_id, channelId: r.channel_id })) };
          }
          return { results: [] };
        },
      };
    },
  };

  return {
    DB: db as any,
    SF_CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
    PANEL_JWT_SIGNER: {
      async signAssertion(_input: unknown) { return "test-assertion"; },
    },
    row,
    AUTH_RPC_WARN_MODE: "1",
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
      if (body.includes("<m:retrieve>")) {
        return new Response(
          `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata">
             <soapenv:Body><m:retrieveResponse><m:result><m:id>async-test-id</m:id></m:result></m:retrieveResponse></soapenv:Body>
           </soapenv:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } }
        );
      }
      if (body.includes("<m:checkRetrieveStatus>")) {
        soapPollCount++;
        return new Response(
          `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata">
             <soapenv:Body><m:checkRetrieveStatusResponse><m:result><m:done>true</m:done><m:success>true</m:success><m:status>Succeeded</m:status><m:zipFile>${zipB64}</m:zipFile></m:result></m:checkRetrieveStatusResponse></soapenv:Body>
           </soapenv:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } }
        );
      }
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;
}

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
    conn: { instanceUrl: "https://test.my.salesforce.com", accessToken: "mock-access-token" },
    maxPollAttempts: 5,
    teamId: "team-test",
    orgId,
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
    conn: { instanceUrl: "https://test.my.salesforce.com", accessToken: "mock-access-token" },
    maxPollAttempts: 5,
    teamId: "team-test",
    orgId,
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
      if (body.includes("<m:retrieve>")) {
        return new Response(
          `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata">
             <soapenv:Body><m:retrieveResponse><m:result><m:id>async-test-id</m:id></m:result></m:retrieveResponse></soapenv:Body>
           </soapenv:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } }
        );
      }
      if (body.includes("<m:checkRetrieveStatus>")) {
        return new Response(
          `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata">
             <soapenv:Body><m:checkRetrieveStatusResponse><m:result><m:done>true</m:done><m:success>true</m:success><m:status>Succeeded</m:status><m:zipFile>${zipB64}</m:zipFile></m:result></m:checkRetrieveStatusResponse></soapenv:Body>
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
    conn: { instanceUrl: "https://test.my.salesforce.com", accessToken: "mock-access-token" },
    maxPollAttempts: 5,
    teamId: "team-test",
    orgId,
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
    conn: { instanceUrl: "https://test.my.salesforce.com", accessToken: "mock-access-token" },
    maxPollAttempts: 5,
  });

  expect(urls).toEqual(["https://retrieve64.example.com/tools/rpc_entrypoint_tool"]);
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

test("TubotSfAuthEntrypoint.getTokenForChannel returns token via RPC", async () => {
  const env = await createFixture();
  // Distinct identity: the module token cache is keyed by tenant+username.
  (env as { row: Credential }).row.integration_username = "rpc-token-user@example.com";
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
    integration_username: "foreign-collision@example.com",
  };
  const scoped: Credential = {
    ...base.row,
    team_id: "team-test",
    instance_url: "https://scoped.my.salesforce.com",
    integration_username: "scoped-collision@example.com",
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
          if (sql.includes("FROM panel_salesforce_channels") ||
              sql.includes("panel_salesforce_execution_users")) {
            if (sql.includes("team_id = ? AND org_id = ? AND channel_id = ?")) {
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
          return null;
        },
        async all() {
          if (sql.includes("FROM panel_salesforce_channels")) {
            return { results: rows.map((r) => ({ teamId: r.team_id, orgId: r.org_id, channelId: r.channel_id })) };
          }
          return { results: [] };
        },
      };
    },
  };
  const env = {
    DB: db as any,
    AUTH_RPC_WARN_MODE: "1",
    SF_CREDENTIAL_ENCRYPTION_KEY: base.SF_CREDENTIAL_ENCRYPTION_KEY,
    PANEL_JWT_SIGNER: {
      async signAssertion(_input: unknown) { return "test-assertion"; },
    },
    RETRIEVE64: {
      async getCallableToolUrls(params: any) {
        captured = params;
        return ["https://retrieve64.example.com/tools/scoped"];
      },
    },
  };

  // Record which Salesforce host receives the token request: that proves
  // which enrollment row was selected.
  const innerFetch = globalThis.fetch;
  const tokenHosts: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input?.url;
    if (String(urlStr).includes("/services/oauth2/token")) tokenHosts.push(new URL(String(urlStr)).origin);
    return innerFetch(input, init);
  }) as typeof fetch;

  let captured: any = null;
  const entrypoint = new TubotSfAuthEntrypoint(null, env);
  const urls = await entrypoint.getCallableToolUrlsForChannel("0Mjg00000000001AAA", {
    teamId: "team-test",
    orgId,
  });

  expect(urls).toEqual(["https://retrieve64.example.com/tools/scoped"]);
  expect(captured).not.toBeNull();
  expect(captured.teamId).toBe("team-test");
  // The token must be minted from the scoped row, not the first channel match.
  expect(tokenHosts).toEqual(["https://scoped.my.salesforce.com"]);
});

