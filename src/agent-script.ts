import { unzipSync, strFromU8 } from "fflate";
import { token, type AuthEnv } from "./index";

export interface Credential {
  team_id: string;
  org_id: string;
  channel_id: string;
  instance_url: string;
  client_id: string;
  client_secret_cipher: string;
  client_secret_iv: string;
  integration_user_id: string;
  channel_secret_hash: string;
}

export interface CallableToolsOptions {
  env?: AuthEnv;
  conn?: SalesforceConnection;
  orgId?: string;
  teamId?: string;
  channelSecret?: string;
  apiVersion?: string;
  maxPollAttempts?: number;
  pollIntervalMs?: number;
  rpcBinding?: any;
  retrieve64Url?: string;
}

export interface SalesforceConnection {
  instanceUrl: string;
  accessToken: string;
}

export interface LocalActionSchema {
  topicId: string;
  actionId: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface AgentScriptResult {
  agentName: string;
  channelName?: string;
  script: string;
  bundleMetaXml?: string;
  format?: "agent_script" | "gen_ai_planner" | "bot";
  botXml?: string;
  promptTemplates?: Record<string, string>;
  agentGraph?: Record<string, unknown>;
  localActions?: Record<string, LocalActionSchema>;
  rawFiles?: Record<string, string>;
}

export interface RetrievedAgentPayload {
  script: string;
  bundleMetaXml?: string;
  format?: "agent_script" | "gen_ai_planner" | "bot";
  botXml?: string;
  promptTemplates?: Record<string, string>;
  agentGraph?: Record<string, unknown>;
  localActions?: Record<string, LocalActionSchema>;
  rawFiles?: Record<string, string>;
}

export interface BatchRetrieveOptions {
  /** Explicit Agentforce agent developer names (e.g. ['CoolAgent']) */
  agentNames?: string | string[];
  /** Messaging channel names or IDs (e.g. ['Data360_Channel', 'WebChat']) */
  channelNames?: string | string[];
  /** Convenience single identifier (channel name, channel ID, or agent name) */
  name?: string;
  /** Salesforce Metadata API version (default: '65.0') */
  apiVersion?: string;
  /** Maximum polling attempts (default: 30) */
  maxPollAttempts?: number;
  /** Polling interval in ms (default: 1500) */
  pollIntervalMs?: number;
}

export interface BatchRetrieveResult {
  ok: boolean;
  scripts: Record<string, AgentScriptResult>;
  channelMappings: Record<string, string>;
  errors?: Array<{ target: string; message: string }>;
}

function escapeSoql(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isSalesforceId(value: string): boolean {
  return /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(value);
}

function extractXmlTag(xml: string, tag: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tag)) throw new Error("Invalid XML tag name");
  const match = xml.match(
    new RegExp(`<(?:[a-zA-Z0-9_]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_]+:)?${tag}>`, "i")
  );
  return match ? match[1].trim() : null;
}

function decodeBase64Utf8(base64Str: string): string {
  try {
    const trimmed = base64Str.trim();
    if (trimmed.startsWith("system:") || trimmed.startsWith("{") || trimmed.startsWith("<")) {
      return base64Str;
    }
    let clean = trimmed.replace(/\s+/g, "");
    while (clean.length % 4 !== 0) clean += "=";
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return base64Str;
  }
}

async function soqlQuery<T = Record<string, unknown>>(
  conn: SalesforceConnection,
  soql: string,
  restApiVersion = "v65.0"
): Promise<T[]> {
  const url = `${conn.instanceUrl}/services/data/${restApiVersion}/query?q=${encodeURIComponent(soql)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${conn.accessToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    let errMessage = `HTTP ${res.status}`;
    try {
      const errJson = (await res.json()) as Array<{ message?: string }>;
      if (Array.isArray(errJson) && errJson[0]?.message) {
        errMessage = errJson[0].message;
      }
    } catch {}
    throw new Error(`Salesforce SOQL query failed: ${errMessage}`);
  }

  const data = (await res.json()) as { records?: T[] };
  return data.records || [];
}

/**
 * Dynamically resolves the agent developer name associated with a messaging channel or agent name.
 * 
 * Resolution order:
 * 1. Checks `MessagingChannel` by DeveloperName, MasterLabel, or Id.
 *    - If `SessionHandlerId` is a `BotDefinition` (prefix `0Xx`), resolves `BotDefinition.DeveloperName`.
 *    - Checks custom setting `tubot__Agentforce_Agent_Select__c` for matched deployment.
 * 2. Checks `BotDefinition` directly by DeveloperName, MasterLabel, or Id.
 * 3. Checks custom setting `tubot__Agentforce_Agent_Select__c` by Name or Deployment_Label__c.
 */
export async function resolveAgentFromChannel(
  conn: SalesforceConnection,
  channelOrName: string,
  restApiVersion = "v65.0"
): Promise<string | null> {
  const cleanName = channelOrName.trim();
  if (!cleanName) return null;
  const esc = escapeSoql(cleanName);

  // 1. Check MessagingChannel
  try {
    interface MessagingChannelRecord {
      Id: string;
      DeveloperName: string;
      MasterLabel: string;
      SessionHandlerId?: string | null;
    }
    const idClause = isSalesforceId(cleanName) ? ` OR Id = '${esc}'` : "";
    const channels = await soqlQuery<MessagingChannelRecord>(
      conn,
      `SELECT Id, DeveloperName, MasterLabel, SessionHandlerId FROM MessagingChannel WHERE DeveloperName = '${esc}' OR MasterLabel = '${esc}'${idClause} LIMIT 1`,
      restApiVersion
    );

    if (channels.length > 0) {
      const ch = channels[0];
      // Direct BotDefinition session handler
      if (ch.SessionHandlerId && isSalesforceId(ch.SessionHandlerId)) {
        const botEsc = escapeSoql(ch.SessionHandlerId);
        const bots = await soqlQuery<{ DeveloperName: string }>(
          conn,
          `SELECT Id, DeveloperName FROM BotDefinition WHERE Id = '${botEsc}' LIMIT 1`,
          restApiVersion
        );
        if (bots.length > 0 && bots[0].DeveloperName) {
          return bots[0].DeveloperName;
        }
      }

      // Check tubot__Agentforce_Agent_Select__c for channel name with fallback
      let channelAgent: string | null = null;
      try {
        const selects = await soqlQuery<{ tubot__Agent_Name__c?: string; Agent_Name__c?: string }>(
          conn,
          `SELECT Id, Name, tubot__Agent_Name__c FROM tubot__Agentforce_Agent_Select__c WHERE Name = '${escapeSoql(ch.DeveloperName)}' OR Name = '${escapeSoql(ch.MasterLabel)}' OR Name = '${esc}' LIMIT 1`,
          restApiVersion
        );
        if (selects.length > 0 && (selects[0].tubot__Agent_Name__c || selects[0].Agent_Name__c)) {
          channelAgent = selects[0].tubot__Agent_Name__c || selects[0].Agent_Name__c!;
        }
      } catch {}

      if (!channelAgent) {
        try {
          const selects = await soqlQuery<{ Agent_Name__c?: string; tubot__Agent_Name__c?: string }>(
            conn,
            `SELECT Id, Name, Agent_Name__c FROM Agentforce_Agent_Select__c WHERE Name = '${escapeSoql(ch.DeveloperName)}' OR Name = '${escapeSoql(ch.MasterLabel)}' OR Name = '${esc}' LIMIT 1`,
            restApiVersion
          );
          if (selects.length > 0 && (selects[0].Agent_Name__c || selects[0].tubot__Agent_Name__c)) {
            channelAgent = selects[0].Agent_Name__c || selects[0].tubot__Agent_Name__c!;
          }
        } catch {}
      }

      if (channelAgent) {
        return channelAgent;
      }
    }
  } catch {}

  // 2. Check if the name directly matches a BotDefinition
  try {
    const idClause = isSalesforceId(cleanName) ? ` OR Id = '${esc}'` : "";
    const bots = await soqlQuery<{ DeveloperName: string }>(
      conn,
      `SELECT Id, DeveloperName, MasterLabel FROM BotDefinition WHERE DeveloperName = '${esc}' OR MasterLabel = '${esc}'${idClause} LIMIT 1`,
      restApiVersion
    );
    if (bots.length > 0 && bots[0].DeveloperName) {
      return bots[0].DeveloperName;
    }
  } catch {}

  // 3. Check tubot__Agentforce_Agent_Select__c directly by Name or Deployment Label with fallback
  let directAgent: string | null = null;
  try {
    const selects = await soqlQuery<{ tubot__Agent_Name__c?: string; Agent_Name__c?: string }>(
      conn,
      `SELECT Id, Name, tubot__Agent_Name__c FROM tubot__Agentforce_Agent_Select__c WHERE Name = '${esc}' OR tubot__Deployment_Label__c = '${esc}' LIMIT 1`,
      restApiVersion
    );
    if (selects.length > 0 && (selects[0].tubot__Agent_Name__c || selects[0].Agent_Name__c)) {
      directAgent = selects[0].tubot__Agent_Name__c || selects[0].Agent_Name__c!;
    }
  } catch {}

  if (!directAgent) {
    try {
      const selects = await soqlQuery<{ Agent_Name__c?: string; tubot__Agent_Name__c?: string }>(
        conn,
        `SELECT Id, Name, Agent_Name__c FROM Agentforce_Agent_Select__c WHERE Name = '${esc}' OR Deployment_Label__c = '${esc}' LIMIT 1`,
        restApiVersion
      );
      if (selects.length > 0 && (selects[0].Agent_Name__c || selects[0].tubot__Agent_Name__c)) {
        directAgent = selects[0].Agent_Name__c || selects[0].tubot__Agent_Name__c!;
      }
    } catch {}
  }

  if (directAgent) {
    return directAgent;
  }

  return null;
}

function matchRequestedAgentName(foundName: string, requestedNames: string[]): string {
  if (requestedNames.includes(foundName)) return foundName;
  const normalized = foundName.replace(/_(?:v?\d+)$/i, "");
  if (requestedNames.includes(normalized)) return normalized;
  const lower = foundName.toLowerCase();
  const lowerNorm = normalized.toLowerCase();
  for (const req of requestedNames) {
    if (req.toLowerCase() === lower || req.toLowerCase() === lowerNorm) return req;
  }
  return foundName;
}

/**
 * Performs a batched Metadata API SOAP retrieve for one or more agent components.
 * Supports modern Agentforce agents (AiAuthoringBundle / Agent Script) as well as
 * legacy agents (GenAiPlannerBundle and Bot definition metadata).
 */
export async function retrieveAgentScriptsBatch(
  conn: SalesforceConnection,
  agentNames: string[],
  options?: {
    apiVersion?: string;
    maxPollAttempts?: number;
    pollIntervalMs?: number;
  }
): Promise<Map<string, RetrievedAgentPayload>> {
  const results = new Map<string, RetrievedAgentPayload>();
  if (agentNames.length === 0) return results;

  const apiVersion = options?.apiVersion || "65.0";
  if (!/^\d{1,3}\.\d{1,2}$/.test(apiVersion)) throw new Error("Invalid Salesforce API version");
  const maxAttempts = options?.maxPollAttempts ?? 30;
  const pollInterval = options?.pollIntervalMs ?? 1500;
  const metadataUrl = `${conn.instanceUrl}/services/Soap/m/${apiVersion}`;

  // Deduplicate and escape member names
  const uniqueAgents = Array.from(new Set(agentNames.filter(Boolean)));

  const aiAuthoringMembers = new Set<string>();
  const genAiPlannerMembers = new Set<string>();
  const botMembers = new Set<string>();

  for (const name of uniqueAgents) {
    aiAuthoringMembers.add(name);
    if (!name.endsWith("_1")) aiAuthoringMembers.add(`${name}_1`);
    genAiPlannerMembers.add(name);
    if (!name.endsWith("_v1")) genAiPlannerMembers.add(`${name}_v1`);
    botMembers.add(name);
  }

  const aiAuthoringXml = Array.from(aiAuthoringMembers)
    .map((name) => `            <met:members>${escapeXml(name)}</met:members>`)
    .join("\n");
  const genAiPlannerXml = Array.from(genAiPlannerMembers)
    .map((name) => `            <met:members>${escapeXml(name)}</met:members>`)
    .join("\n");
  const botXmlMembers = Array.from(botMembers)
    .map((name) => `            <met:members>${escapeXml(name)}</met:members>`)
    .join("\n");

  const retrieveEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:SessionHeader><met:sessionId>${escapeXml(conn.accessToken)}</met:sessionId></met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <met:retrieve>
      <met:retrieveRequest>
        <met:apiVersion>${apiVersion}</met:apiVersion>
        <met:unpackaged>
          <met:types>
${aiAuthoringXml}
            <met:name>AiAuthoringBundle</met:name>
          </met:types>
          <met:types>
${genAiPlannerXml}
            <met:name>GenAiPlannerBundle</met:name>
          </met:types>
          <met:types>
${botXmlMembers}
            <met:name>Bot</met:name>
          </met:types>
          <met:types>
            <met:members>*</met:members>
            <met:name>GenAiPromptTemplate</met:name>
          </met:types>
          <met:version>${apiVersion}</met:version>
        </met:unpackaged>
      </met:retrieveRequest>
    </met:retrieve>
  </soapenv:Body>
</soapenv:Envelope>`;

  const initResponse = await fetch(metadataUrl, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=UTF-8",
      SOAPAction: '""',
    },
    body: retrieveEnvelope,
  });

  const initText = await initResponse.text();
  if (!initResponse.ok) {
    const fault = extractXmlTag(initText, "faultstring") || "SOAP request failed";
    throw new Error(`Metadata retrieve initialization failed: ${fault}`);
  }

  const asyncId = extractXmlTag(initText, "id");
  if (!asyncId) {
    throw new Error(`No async process ID received in retrieve response: ${initText}`);
  }

  const checkEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:SessionHeader><met:sessionId>${escapeXml(conn.accessToken)}</met:sessionId></met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <met:checkRetrieveStatus>
      <met:asyncProcessId>${escapeXml(asyncId)}</met:asyncProcessId>
      <met:includeZip>true</met:includeZip>
    </met:checkRetrieveStatus>
  </soapenv:Body>
</soapenv:Envelope>`;

  let zipB64: string | null = null;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;
    await new Promise((r) => setTimeout(r, pollInterval));

    const pollResponse = await fetch(metadataUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=UTF-8",
        SOAPAction: '""',
      },
      body: checkEnvelope,
    });

    const pollText = await pollResponse.text();
    if (!pollResponse.ok) {
      const fault = extractXmlTag(pollText, "faultstring") || "SOAP poll failed";
      throw new Error(`Metadata checkRetrieveStatus failed: ${fault}`);
    }

    const done = extractXmlTag(pollText, "done");
    if (done && done.toLowerCase() === "true") {
      zipB64 = extractXmlTag(pollText, "zipFile");
      break;
    }
  }

  if (!zipB64) {
    throw new Error(`Metadata retrieve timed out or did not return zip payload after ${attempts} attempts`);
  }

  // Decode Base64 to Uint8Array
  const binaryString = atob(zipB64);
  const zipBytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    zipBytes[i] = binaryString.charCodeAt(i);
  }

  // Decompress ZIP using fflate
  const unzipped = unzipSync(zipBytes);

  function getOrCreate(name: string): RetrievedAgentPayload {
    let entry = results.get(name);
    if (!entry) {
      entry = { script: "", rawFiles: {} };
      results.set(name, entry);
    }
    return entry;
  }

  const allPromptTemplates = new Map<string, string>();

  // Group retrieved files by bundle / agent name
  for (const [filePath, content] of Object.entries(unzipped)) {
    if (filePath.endsWith("/")) continue;

    // 1. Modern Agent Script: aiAuthoringBundles/{AgentName}/...
    const aiMatch = filePath.match(/(?:^|\/)aiAuthoringBundles\/([^/]+)\/(.+)$/i);
    if (aiMatch) {
      const bundleName = aiMatch[1];
      const relativePath = aiMatch[2];
      const canonicalName = matchRequestedAgentName(bundleName, uniqueAgents);
      const text = strFromU8(content);

      for (const key of new Set([bundleName, canonicalName])) {
        const entry = getOrCreate(key);
        entry.rawFiles = entry.rawFiles || {};
        entry.rawFiles[relativePath] = text;

        if (relativePath.endsWith(".agent")) {
          entry.script = text;
          entry.format = "agent_script";
        } else if (relativePath.endsWith(".bundle-meta.xml")) {
          entry.bundleMetaXml = text;
        }
      }
      continue;
    }

    // 2. Legacy GenAiPlannerBundle: genAiPlannerBundles/{AgentName}/...
    const plannerMatch = filePath.match(/(?:^|\/)genAiPlannerBundles\/([^/]+)\/(.+)$/i);
    if (plannerMatch) {
      const bundleName = plannerMatch[1];
      const relativePath = plannerMatch[2];
      const canonicalName = matchRequestedAgentName(bundleName, uniqueAgents);
      const text = strFromU8(content);

      for (const key of new Set([bundleName, canonicalName])) {
        const entry = getOrCreate(key);
        entry.rawFiles = entry.rawFiles || {};

        // 2a. GenAiPlannerBundle XML metadata: <PlannerName>.genAiPlannerBundle
        if (relativePath.endsWith(".genAiPlannerBundle")) {
          entry.bundleMetaXml = text;
          entry.rawFiles[relativePath] = text;
          // If modern script or decoded agentScript has not already been set, use XML as fallback script
          if (entry.format !== "agent_script" && !entry.script) {
            entry.script = text;
            entry.format = "gen_ai_planner";
          }
        }
        // 2b. Agent Script DSL: agentScript/<PlannerName>_definition.agent
        else if (relativePath.match(/^agentScript\/[^/]+\.agent$/i)) {
          const decodedScript = decodeBase64Utf8(text);
          entry.script = decodedScript;
          entry.format = "agent_script";
          entry.rawFiles[relativePath] = decodedScript;
        }
        // 2c. Agent Graph state machine: agentGraph/<PlannerName>_graph.json
        else if (relativePath.match(/^agentGraph\/[^/]+\.json$/i)) {
          const decodedGraph = decodeBase64Utf8(text);
          try {
            entry.agentGraph = JSON.parse(decodedGraph);
          } catch {
            // Keep unparsed if not valid JSON
          }
          entry.rawFiles[relativePath] = decodedGraph;
        }
        // 2d. Local Actions schemas: localActions/<TopicId>/<ActionId>/(input|output)/schema.json
        else {
          const actionMatch = relativePath.match(/^localActions\/([^/]+)\/([^/]+)\/(input|output)\/schema\.json$/i);
          if (actionMatch) {
            const topicId = actionMatch[1];
            const actionId = actionMatch[2];
            const schemaType = actionMatch[3].toLowerCase();

            try {
              const schemaObj = JSON.parse(text);
              entry.localActions = entry.localActions || {};
              const actionKey = `${topicId}/${actionId}`;
              const actionRecord = entry.localActions[actionKey] || { topicId, actionId };
              if (schemaType === "input") {
                actionRecord.inputSchema = schemaObj;
              } else if (schemaType === "output") {
                actionRecord.outputSchema = schemaObj;
              }
              entry.localActions[actionKey] = actionRecord;
              if (!entry.localActions[actionId]) {
                entry.localActions[actionId] = actionRecord;
              }
            } catch {}
          }
          entry.rawFiles[relativePath] = text;
        }
      }
      continue;
    }

    // 3. Bot definition: bots/{BotName}.bot
    const botMatch = filePath.match(/(?:^|\/)bots\/([^/]+)\.bot$/i);
    if (botMatch) {
      const botName = botMatch[1];
      const canonicalName = matchRequestedAgentName(botName, uniqueAgents);
      const text = strFromU8(content);

      for (const key of new Set([botName, canonicalName])) {
        const entry = getOrCreate(key);
        entry.botXml = text;
        entry.rawFiles = entry.rawFiles || {};
        entry.rawFiles[`${botName}.bot`] = text;

        // If neither modern agent script nor genAiPlanner script was set
        if (!entry.script) {
          entry.script = text;
          entry.format = "bot";
        }
      }
      continue;
    }

    // 4. Prompt Template: genAiPromptTemplates/{TemplateName}.genAiPromptTemplate
    const ptMatch = filePath.match(/(?:^|\/)genAiPromptTemplates\/([^/]+)\.genAiPromptTemplate$/i);
    if (ptMatch) {
      const templateName = ptMatch[1];
      const text = strFromU8(content);
      allPromptTemplates.set(templateName, text);
      continue;
    }
  }

  // Associate referenced prompt templates with agents
  if (allPromptTemplates.size > 0) {
    for (const [, entry] of results.entries()) {
      for (const [templateName, templateXml] of allPromptTemplates.entries()) {
        let isReferenced = false;

        // Check if script directly references template
        if (entry.script && entry.script.includes(templateName)) {
          isReferenced = true;
        }

        // Check raw files for references
        if (!isReferenced && entry.rawFiles) {
          for (const rawContent of Object.values(entry.rawFiles)) {
            if (rawContent.includes(templateName)) {
              isReferenced = true;
              break;
            }
          }
        }

        if (isReferenced) {
          entry.promptTemplates = entry.promptTemplates || {};
          entry.promptTemplates[templateName] = templateXml;
          entry.rawFiles = entry.rawFiles || {};
          entry.rawFiles[`genAiPromptTemplates/${templateName}.genAiPromptTemplate`] = templateXml;
        }
      }
    }
  }

  return results;
}

/**
 * Batched retriever for Agentforce Agent Scripts.
 * 
 * Supports both direct agent names and messaging channel names/IDs.
 * If channel names are provided, it dynamically resolves the agent linked to each channel,
 * batches all agent retrieves into a single Metadata API SOAP call, and maps each channel/agent
 * back to its script.
 */
export async function getAgentScripts(
  conn: SalesforceConnection,
  options: BatchRetrieveOptions
): Promise<BatchRetrieveResult> {
  const channelMappings: Record<string, string> = {};
  const agentNamesToRetrieve = new Set<string>();
  const errors: Array<{ target: string; message: string }> = [];

  // Normalize single name option
  const rawChannels: string[] = [];
  if (options.channelNames) {
    if (Array.isArray(options.channelNames)) rawChannels.push(...options.channelNames);
    else rawChannels.push(options.channelNames);
  }

  const rawAgents: string[] = [];
  if (options.agentNames) {
    if (Array.isArray(options.agentNames)) rawAgents.push(...options.agentNames);
    else rawAgents.push(options.agentNames);
  }

  if (options.name) {
    rawChannels.push(options.name);
  }

  // Resolve channels dynamically
  for (const channelName of rawChannels) {
    try {
      const resolved = await resolveAgentFromChannel(conn, channelName);
      if (resolved) {
        channelMappings[channelName] = resolved;
        agentNamesToRetrieve.add(resolved);
      } else {
        // If resolution as a channel did not find an agent, attempt direct retrieval under that name
        channelMappings[channelName] = channelName;
        agentNamesToRetrieve.add(channelName);
      }
    } catch (err: unknown) {
      errors.push({
        target: channelName,
        message: err instanceof Error ? err.message : String(err),
      });
      // Fallback: still attempt to retrieve directly under that name
      agentNamesToRetrieve.add(channelName);
    }
  }

  for (const agent of rawAgents) {
    agentNamesToRetrieve.add(agent);
  }

  if (agentNamesToRetrieve.size === 0) {
    return { ok: true, scripts: {}, channelMappings, errors };
  }

  const retrieved = await retrieveAgentScriptsBatch(conn, Array.from(agentNamesToRetrieve), {
    apiVersion: options.apiVersion,
    maxPollAttempts: options.maxPollAttempts,
    pollIntervalMs: options.pollIntervalMs,
  });

  const scripts: Record<string, AgentScriptResult> = {};

  for (const [agentName, data] of retrieved.entries()) {
    scripts[agentName] = {
      agentName,
      script: data.script,
      bundleMetaXml: data.bundleMetaXml,
      format: data.format,
      botXml: data.botXml,
      promptTemplates: data.promptTemplates,
      agentGraph: data.agentGraph,
      localActions: data.localActions,
      rawFiles: data.rawFiles,
    };
  }

  // Also index by channel name if resolved
  for (const [channel, agent] of Object.entries(channelMappings)) {
    if (scripts[agent]) {
      scripts[channel] = {
        agentName: agent,
        channelName: channel,
        script: scripts[agent].script,
        bundleMetaXml: scripts[agent].bundleMetaXml,
        format: scripts[agent].format,
        botXml: scripts[agent].botXml,
        promptTemplates: scripts[agent].promptTemplates,
        agentGraph: scripts[agent].agentGraph,
        localActions: scripts[agent].localActions,
        rawFiles: scripts[agent].rawFiles,
      };
    }
  }

  return {
    ok: Object.keys(scripts).length > 0,
    scripts,
    channelMappings,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Convenience function to retrieve the agent script used in a specific messaging channel.
 * 
 * @param conn Salesforce instance URL and access token.
 * @param channelName Name, MasterLabel, or Salesforce ID of the MessagingChannel.
 * @returns The agent script and metadata, or null if no agent could be found.
 */
export async function retrieveAgentScriptForChannel(
  conn: SalesforceConnection,
  channelName: string,
  options?: { apiVersion?: string; maxPollAttempts?: number; pollIntervalMs?: number }
): Promise<AgentScriptResult | null> {
  const result = await getAgentScripts(conn, {
    channelNames: [channelName],
    apiVersion: options?.apiVersion,
    maxPollAttempts: options?.maxPollAttempts,
    pollIntervalMs: options?.pollIntervalMs,
  });

  return result.scripts[channelName] || null;
}

/**
 * Finds a Salesforce credential in D1 by exact tenant triple. Preferred
 * whenever the caller already authenticated the tenant: unlike channel-only
 * discovery it cannot select another team's enrollment of the same channel.
 */
export async function findCredentialByScope(
  db: D1Database,
  teamId: string,
  orgId: string,
  channelId: string
): Promise<Credential | null> {
  if (!teamId || !orgId || !channelId?.trim()) return null;
  return db
    .prepare("SELECT * FROM salesforce_auth_credential WHERE team_id=? AND org_id=? AND channel_id=? LIMIT 1")
    .bind(teamId, orgId, channelId.trim())
    .first<Credential>();
}

/**
 * Finds a Salesforce credential in D1 by exact channel_id, or by 15-character prefix.
 */
export async function findCredentialByChannelId(
  db: D1Database,
  channelId: string
): Promise<Credential | null> {
  const cleanId = channelId.trim();
  if (!cleanId) return null;

  const exact = await db
    .prepare("SELECT * FROM salesforce_auth_credential WHERE channel_id = ? LIMIT 1")
    .bind(cleanId)
    .first<Credential>();
  if (exact) return exact;

  if (cleanId.length >= 15) {
    const prefix = cleanId.slice(0, 15);
    const prefixMatch = await db
      .prepare(
        "SELECT * FROM salesforce_auth_credential WHERE substr(channel_id, 1, 15) = ? OR channel_id LIKE ? LIMIT 1"
      )
      .bind(prefix, `${prefix}%`)
      .first<Credential>();
    if (prefixMatch) return prefixMatch;
  }

  return null;
}

/**
 * Retrieves callable tool URLs for an Agentforce channel by resolving credentials,
 * retrieving the agent script and prompt templates, and submitting to retrieve64.
 */
export async function getCallableToolUrlsForChannel(
  channelId: string,
  options?: CallableToolsOptions | AuthEnv
): Promise<string[]> {
  const opts: CallableToolsOptions =
    options && "DB" in options && "SF_CREDENTIAL_ENCRYPTION_KEY" in options
      ? { env: options as AuthEnv }
      : (options as CallableToolsOptions) || {};

  const env = opts.env;
  let conn = opts.conn;
  let orgId = opts.orgId;
  let teamId = opts.teamId;

  // Resolve credentials & SalesforceConnection
  if (!conn) {
    if (!env?.DB) {
      throw new Error(
        `Unable to resolve Salesforce credentials for channel '${channelId}': neither conn nor env.DB was provided.`
      );
    }
    let cred: Credential | null;
    if (teamId && orgId) {
      // Authenticated scope is known (HTTP path): exact-triple lookup so a
      // channel_id enrolled under another team can never be selected.
      cred = await findCredentialByScope(env.DB, teamId, orgId, channelId);
    } else {
      cred = await findCredentialByChannelId(env.DB, channelId);
      // Partial scope: never mint a token for a row outside the known half.
      if (cred && ((teamId && cred.team_id !== teamId) || (orgId && cred.org_id !== orgId))) {
        cred = null;
      }
    }
    if (!cred) {
      throw new Error(`No Salesforce credentials found for channel '${channelId}'.`);
    }
    if (!orgId) orgId = cred.org_id;
    if (!teamId) teamId = cred.team_id;

    const auth = await token(env, cred);
    conn = {
      instanceUrl: auth.instanceUrl,
      accessToken: auth.accessToken,
    };
  } else if (!orgId || !teamId) {
    if (env?.DB) {
      try {
        const cred = await findCredentialByChannelId(env.DB, channelId);
        // Only fill labels from a row that agrees with any known half; a
        // colliding channel_id under another team must not misattribute.
        if (cred && (!orgId || cred.org_id === orgId) && (!teamId || cred.team_id === teamId)) {
          if (!orgId) orgId = cred.org_id;
          if (!teamId) teamId = cred.team_id;
        }
      } catch {}
    }
  }

  orgId = orgId || "";
  teamId = teamId || "";

  // Retrieve Agent Script and prompt templates
  const agentResult = await retrieveAgentScriptForChannel(conn, channelId, {
    apiVersion: opts.apiVersion,
    maxPollAttempts: opts.maxPollAttempts,
    pollIntervalMs: opts.pollIntervalMs,
  });

  const script = agentResult?.script || "";
  const promptTemplates = agentResult?.promptTemplates;

  const binding = opts.rpcBinding || env?.RETRIEVE64;

  // 1. First checks rpcBinding?.getCallableToolUrls or env.RETRIEVE64?.getCallableToolUrls
  if (binding && typeof binding.getCallableToolUrls === "function") {
    const res = await binding.getCallableToolUrls({
      orgId,
      channelId,
      definition: script,
      promptTemplates,
      accessToken: conn.accessToken,
      instanceUrl: conn.instanceUrl,
      teamId,
    });
    if (Array.isArray(res)) return res;
    if (Array.isArray(res?.urls)) return res.urls;
    if (Array.isArray(res?.callableToolUrls)) return res.callableToolUrls;
    return [];
  }

  const payload = {
    orgId,
    channelId,
    definition: script,
    promptTemplates,
    accessToken: conn.accessToken,
    instanceUrl: conn.instanceUrl,
    teamId,
  };

  // 2. If only binding.fetch is available
  if (binding && typeof binding.fetch === "function") {
    const response = await binding.fetch("https://retrieve64.internal/definitions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-salesforce-access-token": conn.accessToken,
        "x-salesforce-instance-url": conn.instanceUrl,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let errText = `HTTP ${response.status}`;
      try {
        errText = await response.text();
      } catch {}
      throw new Error(`retrieve64 service binding request failed: ${errText}`);
    }

    const data = (await response.json()) as any;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.urls)) return data.urls;
    if (Array.isArray(data?.callableToolUrls)) return data.callableToolUrls;
    return [];
  }

  // 3. If no binding -> HTTP fetch
  const url = opts.retrieve64Url || "https://retrieve64.emalteaproductions.workers.dev/definitions";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-salesforce-access-token": conn.accessToken,
      "x-salesforce-instance-url": conn.instanceUrl,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let errText = `HTTP ${response.status}`;
    try {
      errText = await response.text();
    } catch {}
    throw new Error(`retrieve64 HTTP request failed: ${errText}`);
  }

  const data = (await response.json()) as any;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.urls)) return data.urls;
  if (Array.isArray(data?.callableToolUrls)) return data.callableToolUrls;
  return [];
}
