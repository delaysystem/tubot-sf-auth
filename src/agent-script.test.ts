import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve, join } from "path";
import { zipSync, strToU8 } from "fflate";
import worker from "./index";
import {
  resolveAgentFromChannel,
  retrieveAgentScriptsBatch,
  getAgentScripts,
  retrieveAgentScriptForChannel,
  RetrievePendingError,
  SalesforceConnection,
} from "./agent-script";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const secret = "a".repeat(48);
const orgId = "00D000000000001AAA";
const userId = "005000000000001AAA";
const enc = new TextEncoder();
const keyBytes = new Uint8Array(32).fill(7);
const encryptionKey = btoa(String.fromCharCode(...keyBytes));
const hash = async (s: string) =>
  btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function fixture(active = true) {
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, enc.encode("salesforce-secret"))
  );
  const row = {
    team_id: "team",
    org_id: orgId,
    channel_id: "channel",
    instance_url: "https://test.my.salesforce.com",
    client_id: "client",
    client_secret_cipher: btoa(String.fromCharCode(...cipher)),
    client_secret_iv: btoa(String.fromCharCode(...iv)),
    integration_user_id: userId,
    channel_secret_hash: await hash(secret),
  };
  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
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

function createMockZipPayload(agents: Record<string, { script: string; xml?: string }>): string {
  const files: Record<string, Uint8Array> = {};
  for (const [agentName, content] of Object.entries(agents)) {
    files[`unpackaged/aiAuthoringBundles/${agentName}/${agentName}.agent`] = strToU8(content.script);
    if (content.xml) {
      files[`unpackaged/aiAuthoringBundles/${agentName}/${agentName}.bundle-meta.xml`] = strToU8(content.xml);
    }
  }
  const compressed = zipSync(files);
  return btoa(String.fromCharCode(...compressed));
}

test("resolveAgentFromChannel dynamically resolves via MessagingChannel SessionHandlerId", async () => {
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
            Id: "0Mjg00000000001",
            DeveloperName: "WebChat",
            MasterLabel: "WebChat",
            SessionHandlerId: "0Xx000000000001",
          },
        ],
      });
    }
    if (url.includes("FROM BotDefinition")) {
      return Response.json({
        records: [
          {
            Id: "0Xx000000000001",
            DeveloperName: "CoolAgent",
          },
        ],
      });
    }
    return Response.json({ records: [] });
  }) as typeof fetch;

  const agentName = await resolveAgentFromChannel(conn, "WebChat");
  expect(agentName).toBe("CoolAgent");
});

test("resolveAgentFromChannel falls back to Agentforce_Agent_Select__c mapping", async () => {
  const conn: SalesforceConnection = {
    instanceUrl: "https://test.my.salesforce.com",
    accessToken: "mock-token",
  };

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = decodeURIComponent(String(input));
    if (url.includes("FROM MessagingChannel")) {
      return Response.json({ records: [] });
    }
    if (url.includes("FROM BotDefinition")) {
      return Response.json({ records: [] });
    }
    if (url.includes("FROM tubot__Agentforce_Agent_Select__c")) {
      return Response.json({
        records: [
          {
            Id: "a00000000000001",
            Name: "API",
            tubot__Agent_Name__c: "CoolAgent",
          },
        ],
      });
    }
    return Response.json({ records: [] });
  }) as typeof fetch;

  const agentName = await resolveAgentFromChannel(conn, "API");
  expect(agentName).toBe("CoolAgent");
});

test("retrieveAgentScriptsBatch initiates SOAP retrieve and extracts agent scripts", async () => {
  const conn: SalesforceConnection = {
    instanceUrl: "https://test.my.salesforce.com",
    accessToken: "mock-token",
  };

  const mockZip = createMockZipPayload({
    CoolAgent: {
      script: 'system:\n  instructions: "You are CoolAgent"',
      xml: "<AiAuthoringBundle><bundleType>AGENT</bundleType></AiAuthoringBundle>",
    },
    DATA360TEST: {
      script: 'system:\n  instructions: "You are DATA360TEST"',
    },
  });

  let pollCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body || "");
    if (body.includes("<m:retrieve>")) {
      expect(body).toContain("<m:members>CoolAgent</m:members>");
      expect(body).toContain("<m:members>DATA360TEST</m:members>");
      return new Response(
        `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Body><met:retrieveResponse><met:result><met:id>09S000000000001</met:id></met:result></met:retrieveResponse></soapenv:Body>
</soapenv:Envelope>`
      );
    }
    if (body.includes("<m:checkRetrieveStatus>")) {
      pollCount++;
      const done = pollCount >= 2;
      return new Response(
        `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Body><met:checkRetrieveStatusResponse><met:result>
    <met:done>${done}</met:done>
    <met:success>${done}</met:success>
    <met:status>${done ? "Succeeded" : "InProgress"}</met:status>
    ${done ? `<met:zipFile>${mockZip}</met:zipFile>` : ""}
  </met:result></met:checkRetrieveStatusResponse></soapenv:Body>
</soapenv:Envelope>`
      );
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  const result = await retrieveAgentScriptsBatch(conn, ["CoolAgent", "DATA360TEST"], {
    pollIntervalMs: 1,
  });

  expect(result.size).toBe(2);
  expect(result.get("CoolAgent")?.script).toContain("You are CoolAgent");
  expect(result.get("CoolAgent")?.bundleMetaXml).toContain("<bundleType>AGENT</bundleType>");
  expect(result.get("DATA360TEST")?.script).toContain("You are DATA360TEST");
});

test("retrieveAgentScriptForChannel retrieves single script by channel name", async () => {
  const conn: SalesforceConnection = {
    instanceUrl: "https://test.my.salesforce.com",
    accessToken: "mock-token",
  };

  const mockZip = createMockZipPayload({
    CoolAgent: { script: 'system:\n  instructions: "You are CoolAgent"' },
  });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = decodeURIComponent(String(input));
    const body = String(init?.body || "");

    if (url.includes("FROM MessagingChannel")) {
      return Response.json({
        records: [
          {
            Id: "0Mj001",
            DeveloperName: "SupportChat",
            MasterLabel: "Support Chat",
            SessionHandlerId: "0Xx001",
          },
        ],
      });
    }
    if (url.includes("FROM BotDefinition")) {
      return Response.json({
        records: [{ Id: "0Xx001", DeveloperName: "CoolAgent" }],
      });
    }
    if (body.includes("<m:retrieve>")) {
      return new Response(
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata">
  <soap:Body><m:retrieveResponse><m:result><m:id>09S001</m:id></m:result></m:retrieveResponse></soap:Body>
</soap:Envelope>`
      );
    }
    if (body.includes("<m:checkRetrieveStatus>")) {
      return new Response(
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata">
  <soap:Body><m:checkRetrieveStatusResponse><m:result><m:done>true</m:done><m:success>true</m:success><m:status>Succeeded</m:status><m:zipFile>${mockZip}</m:zipFile></m:result></m:checkRetrieveStatusResponse></soap:Body>
</soap:Envelope>`
      );
    }
    return Response.json({ records: [] });
  }) as typeof fetch;

  const res = await retrieveAgentScriptForChannel(conn, "SupportChat", { pollIntervalMs: 1 });
  expect(res).not.toBeNull();
  expect(res?.agentName).toBe("CoolAgent");
  expect(res?.channelName).toBe("SupportChat");
  expect(res?.script).toContain("You are CoolAgent");
});

test("retrieveAgentScriptsBatch supports legacy GenAiPlannerBundle agents", async () => {
  const conn: SalesforceConnection = {
    instanceUrl: "https://test.my.salesforce.com",
    accessToken: "mock-token",
  };

  const plannerXml = `<GenAiPlannerBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Helps Coral Cloud employees to work on customers enquiries.</description>
    <masterLabel>Coral Cloud Employee Agent</masterLabel>
</GenAiPlannerBundle>`;

  const botXml = `<Bot xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Coral Cloud Employee Agent</label>
</Bot>`;

  const files: Record<string, Uint8Array> = {
    "unpackaged/genAiPlannerBundles/Coral_Cloud_Employee_Agent/Coral_Cloud_Employee_Agent.genAiPlannerBundle": strToU8(plannerXml),
    "unpackaged/bots/Coral_Cloud_Employee_Agent.bot": strToU8(botXml),
  };
  const mockZip = btoa(String.fromCharCode(...zipSync(files)));

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body || "");
    if (body.includes("<m:retrieve>")) {
      expect(body).toContain("<m:name>GenAiPlannerBundle</m:name>");
      expect(body).toContain("<m:name>Bot</m:name>");
      return new Response(
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata">
  <soap:Body><m:retrieveResponse><m:result><m:id>async-proc-legacy-123</m:id></m:result></m:retrieveResponse></soap:Body>
</soap:Envelope>`
      );
    }
    if (body.includes("<m:checkRetrieveStatus>")) {
      return new Response(
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata">
  <soap:Body><m:checkRetrieveStatusResponse><m:result><m:done>true</m:done><m:success>true</m:success><m:status>Succeeded</m:status><m:zipFile>${mockZip}</m:zipFile></m:result></m:checkRetrieveStatusResponse></soap:Body>
</soap:Envelope>`
      );
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  const result = await getAgentScripts(conn, {
    agentNames: ["Coral_Cloud_Employee_Agent"],
    pollIntervalMs: 5,
  });

  expect(result.ok).toBe(true);
  const agent = result.scripts.Coral_Cloud_Employee_Agent;
  expect(agent).toBeDefined();
  expect(agent.format).toBe("gen_ai_planner");
  expect(agent.script).toContain("Coral Cloud Employee Agent");
  expect(agent.botXml).toContain("<Bot");
  expect(agent.rawFiles).toBeDefined();
  expect(agent.rawFiles?.["Coral_Cloud_Employee_Agent.genAiPlannerBundle"]).toContain("<GenAiPlannerBundle");
});

test("retrieveAgentScriptsBatch extracts GenAiPromptTemplate for legacy and modern agents", async () => {
  const conn: SalesforceConnection = {
    instanceUrl: "https://test.my.salesforce.com",
    accessToken: "mock-token",
  };

  const plannerXml = `<GenAiPlannerBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Helps Coral Cloud employees.</description>
    <localActions>
        <invocationTarget>Generate_Personalized_Schedule</invocationTarget>
        <invocationTargetType>generatePromptResponse</invocationTargetType>
    </localActions>
</GenAiPlannerBundle>`;

  const modernScript = `system:
    instructions: "You are an agent."
actions:
    generate_schedule:
        target: "generatePromptResponse://Generate_Personalized_Schedule"
`;

  const promptTemplateXml = `<GenAiPromptTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
    <developerName>Generate_Personalized_Schedule</developerName>
    <masterLabel>Generate Personalized Schedule</masterLabel>
    <templateVersions>
        <content>Your name is {!$User.FirstName}. Present the list of activities.</content>
    </templateVersions>
</GenAiPromptTemplate>`;

  const files: Record<string, Uint8Array> = {
    "unpackaged/genAiPlannerBundles/Coral_Cloud_Employee_Agent/Coral_Cloud_Employee_Agent.genAiPlannerBundle": strToU8(plannerXml),
    "unpackaged/aiAuthoringBundles/ModernAgent/ModernAgent.agent": strToU8(modernScript),
    "unpackaged/genAiPromptTemplates/Generate_Personalized_Schedule.genAiPromptTemplate": strToU8(promptTemplateXml),
  };
  const mockZip = btoa(String.fromCharCode(...zipSync(files)));

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body || "");
    if (body.includes("<m:retrieve>")) {
      expect(body).toContain("<m:name>GenAiPromptTemplate</m:name>");
      return new Response(
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata">
  <soap:Body><m:retrieveResponse><m:result><m:id>async-proc-prompt-123</m:id></m:result></m:retrieveResponse></soap:Body>
</soap:Envelope>`
      );
    }
    if (body.includes("<m:checkRetrieveStatus>")) {
      return new Response(
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata">
  <soap:Body><m:checkRetrieveStatusResponse><m:result><m:done>true</m:done><m:success>true</m:success><m:status>Succeeded</m:status><m:zipFile>${mockZip}</m:zipFile></m:result></m:checkRetrieveStatusResponse></soap:Body>
</soap:Envelope>`
      );
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  const result = await getAgentScripts(conn, {
    agentNames: ["Coral_Cloud_Employee_Agent", "ModernAgent"],
    pollIntervalMs: 5,
  });

  expect(result.ok).toBe(true);

  // Legacy agent prompt template check
  const legacyAgent = result.scripts.Coral_Cloud_Employee_Agent;
  expect(legacyAgent).toBeDefined();
  expect(legacyAgent.promptTemplates).toBeDefined();
  expect(legacyAgent.promptTemplates?.Generate_Personalized_Schedule).toContain("Generate Personalized Schedule");
  expect(legacyAgent.rawFiles?.["genAiPromptTemplates/Generate_Personalized_Schedule.genAiPromptTemplate"]).toContain("Generate Personalized Schedule");

  // Modern agent prompt template check
  const modernAgent = result.scripts.ModernAgent;
  expect(modernAgent).toBeDefined();
  expect(modernAgent.promptTemplates).toBeDefined();
  expect(modernAgent.promptTemplates?.Generate_Personalized_Schedule).toContain("Generate Personalized Schedule");
});

test("retrieveAgentScriptsBatch extracts, decodes, and structures complete GenAiPlannerBundle (agentScript, agentGraph, localActions, bundleMetaXml)", async () => {
  const conn: SalesforceConnection = {
    instanceUrl: "https://test.my.salesforce.com",
    accessToken: "mock-token",
  };

  const plannerXml = `<GenAiPlannerBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Test planner bundle.</description>
    <localTopics>
        <developerName>ReservationManagement_16jg5000000sgqH</developerName>
        <localActions>
            <developerName>IdentifyCustomerByEmail_179g5000001K3ve</developerName>
            <invocationTarget>streamKnowledgeSearch</invocationTarget>
            <invocationTargetType>standardInvocableAction</invocationTargetType>
        </localActions>
    </localTopics>
</GenAiPlannerBundle>`;

  const rawScriptYaml = `system:
    instructions: "You are an AI Agent."
    messages:
        welcome: "Hi, I'm an AI assistant."
`;
  const base64Script = btoa(rawScriptYaml);

  const rawGraphJson = JSON.stringify({
    schemaVersion: "2.0",
    globalConfiguration: { developerName: "Test" },
    initialNode: "agent_router",
  });
  const base64Graph = btoa(rawGraphJson);

  const inputSchema = JSON.stringify({
    required: ["emailAddress"],
    properties: {
      emailAddress: {
        title: "Email Address",
        type: "string",
      },
    },
  });

  const outputSchema = JSON.stringify({
    properties: {
      contactRecord: {
        title: "Contact Record",
        type: "object",
      },
    },
  });

  const files: Record<string, Uint8Array> = {
    "unpackaged/genAiPlannerBundles/Test_v1/Test_v1.genAiPlannerBundle": strToU8(plannerXml),
    "unpackaged/genAiPlannerBundles/Test_v1/agentScript/Test_v1_definition.agent": strToU8(base64Script),
    "unpackaged/genAiPlannerBundles/Test_v1/agentGraph/Test_v1_graph.json": strToU8(base64Graph),
    "unpackaged/genAiPlannerBundles/Test_v1/localActions/ReservationManagement_16jg5000000sgqH/IdentifyCustomerByEmail_179g5000001K3ve/input/schema.json": strToU8(inputSchema),
    "unpackaged/genAiPlannerBundles/Test_v1/localActions/ReservationManagement_16jg5000000sgqH/IdentifyCustomerByEmail_179g5000001K3ve/output/schema.json": strToU8(outputSchema),
  };
  const mockZip = btoa(String.fromCharCode(...zipSync(files)));

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body || "");
    if (body.includes("<m:retrieve>")) {
      return new Response(
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata">
  <soap:Body><m:retrieveResponse><m:result><m:id>async-proc-planner-complete-123</m:id></m:result></m:retrieveResponse></soap:Body>
</soap:Envelope>`
      );
    }
    if (body.includes("<m:checkRetrieveStatus>")) {
      return new Response(
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata">
  <soap:Body><m:checkRetrieveStatusResponse><m:result><m:done>true</m:done><m:success>true</m:success><m:status>Succeeded</m:status><m:zipFile>${mockZip}</m:zipFile></m:result></m:checkRetrieveStatusResponse></soap:Body>
</soap:Envelope>`
      );
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  const result = await getAgentScripts(conn, {
    agentNames: ["Test"],
    pollIntervalMs: 5,
  });

  expect(result.ok).toBe(true);
  const agent = result.scripts.Test;
  expect(agent).toBeDefined();

  // 1. Decoded script DSL
  expect(agent.format).toBe("agent_script");
  expect(agent.script).toBe(rawScriptYaml);
  expect(agent.script).toContain('instructions: "You are an AI Agent."');

  // 2. XML metadata preserved in bundleMetaXml
  expect(agent.bundleMetaXml).toBeDefined();
  expect(agent.bundleMetaXml).toContain("<GenAiPlannerBundle");
  expect(agent.bundleMetaXml).toContain("Test planner bundle.");

  // 3. Decoded and parsed agentGraph
  expect(agent.agentGraph).toBeDefined();
  expect(agent.agentGraph?.schemaVersion).toBe("2.0");
  expect((agent.agentGraph?.globalConfiguration as any)?.developerName).toBe("Test");
  expect(agent.agentGraph?.initialNode).toBe("agent_router");

  // 4. Structured localActions schemas
  expect(agent.localActions).toBeDefined();
  const byCompoundKey = agent.localActions?.["ReservationManagement_16jg5000000sgqH/IdentifyCustomerByEmail_179g5000001K3ve"];
  expect(byCompoundKey).toBeDefined();
  expect(byCompoundKey?.topicId).toBe("ReservationManagement_16jg5000000sgqH");
  expect(byCompoundKey?.actionId).toBe("IdentifyCustomerByEmail_179g5000001K3ve");
  expect(byCompoundKey?.inputSchema).toBeDefined();
  expect((byCompoundKey?.inputSchema as any).required).toContain("emailAddress");
  expect(byCompoundKey?.outputSchema).toBeDefined();
  expect((byCompoundKey?.outputSchema as any).properties?.contactRecord).toBeDefined();

  // Direct actionId lookup in localActions
  const byActionId = agent.localActions?.["IdentifyCustomerByEmail_179g5000001K3ve"];
  expect(byActionId).toBeDefined();
  expect(byActionId?.inputSchema).toBeDefined();

  // 5. Raw files should have decoded content for agentScript and agentGraph
  expect(agent.rawFiles?.["agentScript/Test_v1_definition.agent"]).toBe(rawScriptYaml);
  expect(agent.rawFiles?.["agentGraph/Test_v1_graph.json"]).toBe(rawGraphJson);
});

test("retrieveAgentScriptsBatch processes real Test_v1 planner bundle from disk if available", async () => {
  const conn: SalesforceConnection = {
    instanceUrl: "https://test.my.salesforce.com",
    accessToken: "mock-token",
  };

  const fixtureDir = resolve(__dirname, "../../backup/.tmp-retrieve/genAiPlannerBundles/Test_v1");
  if (!existsSync(fixtureDir)) return;

  // Build zip from disk fixture
  const files: Record<string, Uint8Array> = {};
  function readDirRecursive(currentDir: string, relativeBase: string) {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relPath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        readDirRecursive(fullPath, relPath);
      } else {
        files[`unpackaged/genAiPlannerBundles/Test_v1/${relPath}`] = new Uint8Array(readFileSync(fullPath));
      }
    }
  }
  readDirRecursive(fixtureDir, "");
  expect(Object.keys(files).length).toBeGreaterThan(5);

  const mockZip = btoa(String.fromCharCode(...zipSync(files)));

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body || "");
    if (body.includes("<m:retrieve>")) {
      return new Response(
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata">
  <soap:Body><m:retrieveResponse><m:result><m:id>async-proc-real-test-123</m:id></m:result></m:retrieveResponse></soap:Body>
</soap:Envelope>`
      );
    }
    if (body.includes("<m:checkRetrieveStatus>")) {
      return new Response(
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata">
  <soap:Body><m:checkRetrieveStatusResponse><m:result><m:done>true</m:done><m:success>true</m:success><m:status>Succeeded</m:status><m:zipFile>${mockZip}</m:zipFile></m:result></m:checkRetrieveStatusResponse></soap:Body>
</soap:Envelope>`
      );
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  const result = await getAgentScripts(conn, {
    agentNames: ["Test"],
    pollIntervalMs: 5,
  });

  expect(result.ok).toBe(true);
  const agent = result.scripts.Test;
  expect(agent).toBeDefined();
  expect(agent.format).toBe("agent_script");
  expect(agent.script).toContain("system:");
  expect(agent.script).toContain("Agent Router");
  expect(agent.bundleMetaXml).toContain("<GenAiPlannerBundle");
  expect(agent.agentGraph).toBeDefined();
  expect(agent.agentGraph?.schemaVersion).toBe("2.0");
  expect(agent.localActions).toBeDefined();
  expect(Object.keys(agent.localActions || {}).length).toBeGreaterThan(10);
});

test("resolveAgentFromChannel throws audibly on query failure instead of returning null", async () => {
  const conn: SalesforceConnection = {
    instanceUrl: "https://test.my.salesforce.com",
    accessToken: "expired-token",
  };
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify([{ message: "Session expired or invalid" }]), { status: 401 });
  }) as typeof fetch;
  await expect(resolveAgentFromChannel(conn, "WebChat")).rejects.toThrow("Session expired or invalid");
});

test("resolveAgentFromChannel falls through to the unnamespaced custom setting only on missing object", async () => {
  const conn: SalesforceConnection = {
    instanceUrl: "https://test.my.salesforce.com",
    accessToken: "mock-token",
  };
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = decodeURIComponent(String(input));
    seen.push(url);
    if (url.includes("FROM MessagingChannel") || url.includes("FROM BotDefinition")) {
      return Response.json({ records: [] });
    }
    if (url.includes("FROM tubot__Agentforce_Agent_Select__c")) {
      return new Response(
        JSON.stringify([{ message: "sObject type 'tubot__Agentforce_Agent_Select__c' is not supported." }]),
        { status: 400 }
      );
    }
    if (url.includes("FROM Agentforce_Agent_Select__c")) {
      return Response.json({ records: [{ Id: "a02", Name: "API", Agent_Name__c: "CoolAgent" }] });
    }
    return Response.json({ records: [] });
  }) as typeof fetch;
  expect(await resolveAgentFromChannel(conn, "API")).toBe("CoolAgent");
  expect(seen.some(u => u.includes("FROM Agentforce_Agent_Select__c"))).toBe(true);
});

test("resolveAgentFromChannel rethrows non-missing-object custom setting failures", async () => {
  const conn: SalesforceConnection = {
    instanceUrl: "https://test.my.salesforce.com",
    accessToken: "mock-token",
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = decodeURIComponent(String(input));
    if (url.includes("FROM MessagingChannel") || url.includes("FROM BotDefinition")) {
      return Response.json({ records: [] });
    }
    return new Response(JSON.stringify([{ message: "REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded." }]), {
      status: 403,
    });
  }) as typeof fetch;
  await expect(resolveAgentFromChannel(conn, "API")).rejects.toThrow("REQUEST_LIMIT_EXCEEDED");
});

test("retrieveAgentScriptsBatch throws resumable pending error on poll budget exhaustion", async () => {
  const conn: SalesforceConnection = {
    instanceUrl: "https://test.my.salesforce.com",
    accessToken: "mock-token",
  };
  const mockZip = createMockZipPayload({ CoolAgent: { script: "system:\n  instructions: x" } });
  let polls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body || "");
    if (body.includes("<m:retrieve>")) {
      return new Response(
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata"><s:Body><m:retrieveResponse><m:result><m:id>async-pending-1</m:id></m:result></m:retrieveResponse></s:Body></s:Envelope>`
      );
    }
    polls++;
    const done = polls > 1;
    return new Response(
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata"><s:Body><m:checkRetrieveStatusResponse><m:result><m:done>${done}</m:done><m:success>${done}</m:success><m:status>${done ? "Succeeded" : "InProgress"}</m:status>${done ? `<m:zipFile>${mockZip}</m:zipFile>` : ""}</m:result></m:checkRetrieveStatusResponse></s:Body></s:Envelope>`
    );
  }) as typeof fetch;

  const pending = await retrieveAgentScriptsBatch(conn, ["CoolAgent"], {
    maxPollAttempts: 1,
    pollIntervalMs: 1,
  }).then(
    () => null,
    (e: unknown) => e
  );
  expect(pending).toBeInstanceOf(RetrievePendingError);
  expect((pending as RetrievePendingError).asyncId).toBe("async-pending-1");

  // Resume with the carried async id: no new retrieve begins, the poll completes.
  const resumed = await retrieveAgentScriptsBatch(conn, ["CoolAgent"], {
    maxPollAttempts: 5,
    pollIntervalMs: 1,
    resumeAsyncId: (pending as RetrievePendingError).asyncId,
  });
  expect(resumed.get("CoolAgent")?.script).toContain("instructions: x");
});

test("retrieveAgentScriptsBatch records full snapshot-style rawPaths", async () => {
  const conn: SalesforceConnection = {
    instanceUrl: "https://test.my.salesforce.com",
    accessToken: "mock-token",
  };
  const zipU8 = zipSync({
    "unpackaged/genAiPlannerBundles/CoolAgent/CoolAgent.genAiPlannerBundle": strToU8("<GenAiPlannerBundle>uses T1</GenAiPlannerBundle>"),
    "unpackaged/bots/CoolAgent.bot": strToU8("<Bot/>"),
    "unpackaged/genAiPromptTemplates/T1.genAiPromptTemplate": strToU8("<GenAiPromptTemplate/>"),
  });
  let binary = "";
  for (let i = 0; i < zipU8.length; i++) binary += String.fromCharCode(zipU8[i]);
  const mockZip = btoa(binary);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body || "");
    const wrap = (op: string, inner: string) =>
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata"><s:Body><m:${op}Response><m:result>${inner}</m:result></m:${op}Response></s:Body></s:Envelope>`;
    if (body.includes("<m:retrieve>")) {
      return new Response(wrap("retrieve", "<m:id>async-paths-1</m:id>"));
    }
    return new Response(wrap("checkRetrieveStatus", `<m:done>true</m:done><m:success>true</m:success><m:status>Succeeded</m:status><m:zipFile>${mockZip}</m:zipFile>`));
  }) as typeof fetch;
  const result = await retrieveAgentScriptsBatch(conn, ["CoolAgent"], { pollIntervalMs: 1 });
  const entry = result.get("CoolAgent");
  expect(entry?.rawPaths?.["CoolAgent.genAiPlannerBundle"]).toBe(
    "genAiPlannerBundles/CoolAgent/CoolAgent.genAiPlannerBundle"
  );
  expect(entry?.rawPaths?.["CoolAgent.bot"]).toBe("bots/CoolAgent.bot");
  expect(entry?.rawPaths?.["genAiPromptTemplates/T1.genAiPromptTemplate"]).toBe(
    "genAiPromptTemplates/T1.genAiPromptTemplate"
  );
  // Legacy relative keys unchanged.
  expect(entry?.rawFiles?.["CoolAgent.genAiPlannerBundle"]).toContain("GenAiPlannerBundle");
});

test("retrieveAgentScriptsBatch maps SOAP session faults to typed errors", async () => {
  const conn: SalesforceConnection = {
    instanceUrl: "https://test.my.salesforce.com",
    accessToken: "expired-token",
  };
  globalThis.fetch = (async () => {
    return new Response(
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>sf:INVALID_SESSION_ID</faultcode><faultstring>Invalid Session ID</faultstring></s:Fault></s:Body></s:Envelope>`,
      { status: 500 }
    );
  }) as typeof fetch;
  await expect(retrieveAgentScriptsBatch(conn, ["CoolAgent"], { pollIntervalMs: 1 })).rejects.toThrow(
    "salesforce_metadata_session_expired"
  );
});
