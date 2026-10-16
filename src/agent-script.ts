import { unzipSync, strFromU8 } from "fflate";
import { retrieveMembers, type SoapMember } from "./soap-retrieve";
import type { AuthEnv } from "./index";

/** Poll budget expired with the retrieve still running: resume via `asyncId`. */
export class RetrievePendingError extends Error {
  constructor(readonly asyncId: string, readonly attempts: number) {
    super(`metadata_retrieve_pending:${asyncId}`);
  }
}

export interface Credential {
  team_id: string;
  org_id: string;
  channel_id: string;
  instance_url: string;
  integration_user_id: string;
  integration_username: string;
  is_sandbox: number;
  client_id?: string | null;
}

export interface CallableToolsOptions {
  env?: AuthEnv;
  conn?: SalesforceConnection;
  orgId?: string;
  teamId?: string;
  apiVersion?: string;
  maxPollAttempts?: number;
  pollIntervalMs?: number;
  rpcBinding?: any;
  retrieve64Url?: string;
  /** Skip the agent retrieve when the caller already has the definition. */
  prefetched?: { script: string; promptTemplates?: Record<string, string> };
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
  /** Maps each rawFiles key to its full snapshot-style path (`bots/…`, `genAiPlannerBundles/…/…`). */
  rawPaths?: Record<string, string>;
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
  /** Maps each rawFiles key to its full snapshot-style path (`bots/…`, `genAiPlannerBundles/…/…`). */
  rawPaths?: Record<string, string>;
}

/** Records content under its legacy relative key plus its full snapshot-style path. */
function putRawFile(entry: RetrievedAgentPayload, key: string, fullPath: string, content: string): void {
  entry.rawFiles = entry.rawFiles || {};
  entry.rawPaths = entry.rawPaths || {};
  entry.rawFiles[key] = content;
  entry.rawPaths[key] = fullPath;
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
  /** Resume a budget-exhausted retrieve instead of starting a new one. */
  resumeAsyncId?: string;
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

function isSalesforceId(value: string): boolean {
  return /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(value);
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
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${conn.accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") throw new Error("Salesforce SOQL query timed out");
    throw new Error("Salesforce SOQL query failed: unreachable");
  }
  if (Number(res.headers.get("content-length") || 0) > 1_000_000) {
    await res.body?.cancel().catch(() => {});
    throw new Error("Salesforce SOQL query failed: response too large");
  }

  if (!res.ok) {
    let errMessage = `HTTP ${res.status}`;
    try {
      const errJson = (await res.json()) as Array<{ message?: string }>;
      if (Array.isArray(errJson) && errJson[0]?.message) {
        errMessage = errJson[0].message;
      }
    } catch {
      // Fall through with the HTTP status; the failure itself is never swallowed.
    }
    throw new Error(`Salesforce SOQL query failed: ${errMessage}`);
  }

  const data = (await res.json()) as { records?: T[] };
  return data.records || [];
}

/** True when a SOQL failure means the queried object does not exist in the org. */
function isMissingObjectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /INVALID_TYPE|sObject type .* is not supported|No such column|INVALID_FIELD/i.test(message);
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
/**
 * Looks up the agent mapped to a channel/name in the Agent Select custom
 * setting, trying the namespaced table then the unnamespaced one. Only a
 * missing custom object falls through to the alternate namespace; every other
 * failure (auth, timeout, network) throws audibly.
 */
async function customSettingAgent(
  conn: SalesforceConnection,
  where: { namespaced: string; unnamespaced: string },
  restApiVersion: string
): Promise<string | null> {
  const tables = [
    { name: "tubot__Agentforce_Agent_Select__c", field: "tubot__Agent_Name__c", where: where.namespaced },
    { name: "Agentforce_Agent_Select__c", field: "Agent_Name__c", where: where.unnamespaced },
  ] as const;
  for (const table of tables) {
    let selects: Array<{ tubot__Agent_Name__c?: string; Agent_Name__c?: string }>;
    try {
      selects = await soqlQuery<{ tubot__Agent_Name__c?: string; Agent_Name__c?: string }>(
        conn,
        `SELECT Id, Name, ${table.field} FROM ${table.name} WHERE ${table.where} LIMIT 1`,
        restApiVersion
      );
    } catch (error) {
      if (!isMissingObjectError(error)) throw error;
      continue;
    }
    const agent = selects.length > 0
      ? (selects[0]?.tubot__Agent_Name__c || selects[0]?.Agent_Name__c || null)
      : null;
    if (agent) return agent;
    // Empty or agentless rows fall through to the alternate namespace.
  }
  return null;
}

export async function resolveAgentFromChannel(
  conn: SalesforceConnection,
  channelOrName: string,
  restApiVersion = "v65.0"
): Promise<string | null> {
  const cleanName = channelOrName.trim();
  if (!cleanName) return null;
  const esc = escapeSoql(cleanName);
  // Empty results fall through to the next stage; query failures throw.
  // Callers record the failure and decide whether direct retrieval applies.

  // 1. Check MessagingChannel
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

    // Check the Agent Select custom setting for the channel name with fallback
    const channelWhere = `Name = '${escapeSoql(ch.DeveloperName)}' OR Name = '${escapeSoql(ch.MasterLabel)}' OR Name = '${esc}'`;
    const channelAgent = await customSettingAgent(conn,
      { namespaced: channelWhere, unnamespaced: channelWhere },
      restApiVersion);

    if (channelAgent) {
      return channelAgent;
    }
  }

  // 2. Check if the name directly matches a BotDefinition
  {
    const idClause = isSalesforceId(cleanName) ? ` OR Id = '${esc}'` : "";
    const bots = await soqlQuery<{ DeveloperName: string }>(
      conn,
      `SELECT Id, DeveloperName, MasterLabel FROM BotDefinition WHERE DeveloperName = '${esc}' OR MasterLabel = '${esc}'${idClause} LIMIT 1`,
      restApiVersion
    );
    if (bots.length > 0 && bots[0].DeveloperName) {
      return bots[0].DeveloperName;
    }
  }

  // 3. Check the Agent Select custom setting directly by Name or Deployment Label with fallback
  const directAgent = await customSettingAgent(conn,
    {
      namespaced: `Name = '${esc}' OR tubot__Deployment_Label__c = '${esc}'`,
      unnamespaced: `Name = '${esc}' OR Deployment_Label__c = '${esc}'`,
    },
    restApiVersion);

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
    resumeAsyncId?: string;
  }
): Promise<Map<string, RetrievedAgentPayload>> {
  const results = new Map<string, RetrievedAgentPayload>();
  if (agentNames.length === 0) return results;

  const apiVersion = options?.apiVersion || "65.0";
  if (!/^\d{1,3}\.\d{1,2}$/.test(apiVersion)) throw new Error("Invalid Salesforce API version");

  // Deduplicate member names
  const uniqueAgents = Array.from(new Set(agentNames.filter(Boolean)));

  const seen = new Set<string>();
  const members: SoapMember[] = [];
  const add = (type: string, fullName: string) => {
    const key = `${type}:${fullName}`;
    if (!seen.has(key)) { seen.add(key); members.push({ type, fullName }); }
  };
  for (const name of uniqueAgents) {
    add("AiAuthoringBundle", name);
    if (!name.endsWith("_1")) add("AiAuthoringBundle", `${name}_1`);
    add("GenAiPlannerBundle", name);
    if (!name.endsWith("_v1")) add("GenAiPlannerBundle", `${name}_v1`);
    add("Bot", name);
  }
  add("GenAiPromptTemplate", "*");

  // Shared transport: bounded waits, validated SOAP, jittered polling.
  // Budget exhaustion throws RetrievePendingError carrying a resumable asyncId.
  const outcome = await retrieveMembers(conn, apiVersion, members, {
    maxPollAttempts: options?.maxPollAttempts ?? 30,
    pollIntervalMs: options?.pollIntervalMs ?? 1500,
    resumeAsyncId: options?.resumeAsyncId,
  });
  if (outcome.status === "pending") throw new RetrievePendingError(outcome.asyncId, outcome.attempts);

  // Decompress ZIP using fflate
  const unzipped = unzipSync(outcome.zipBytes);

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
        putRawFile(entry, relativePath, `aiAuthoringBundles/${bundleName}/${relativePath}`, text);

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
        const fullPath = `genAiPlannerBundles/${bundleName}/${relativePath}`;

        // 2a. GenAiPlannerBundle XML metadata: <PlannerName>.genAiPlannerBundle
        if (relativePath.endsWith(".genAiPlannerBundle")) {
          entry.bundleMetaXml = text;
          putRawFile(entry, relativePath, fullPath, text);
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
          putRawFile(entry, relativePath, fullPath, decodedScript);
        }
        // 2c. Agent Graph state machine: agentGraph/<PlannerName>_graph.json
        else if (relativePath.match(/^agentGraph\/[^/]+\.json$/i)) {
          const decodedGraph = decodeBase64Utf8(text);
          try {
            entry.agentGraph = JSON.parse(decodedGraph);
          } catch {
            // Keep unparsed if not valid JSON
          }
          putRawFile(entry, relativePath, fullPath, decodedGraph);
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
          putRawFile(entry, relativePath, fullPath, text);
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
        putRawFile(entry, `${botName}.bot`, `bots/${botName}.bot`, text);

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
          const promptPath = `genAiPromptTemplates/${templateName}.genAiPromptTemplate`;
          putRawFile(entry, promptPath, promptPath, templateXml);
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
    resumeAsyncId: options.resumeAsyncId,
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
      rawPaths: data.rawPaths,
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
        rawPaths: scripts[agent].rawPaths,
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
  options?: { apiVersion?: string; maxPollAttempts?: number; pollIntervalMs?: number; resumeAsyncId?: string }
): Promise<AgentScriptResult | null> {
  const result = await getAgentScripts(conn, {
    channelNames: [channelName],
    apiVersion: options?.apiVersion,
    maxPollAttempts: options?.maxPollAttempts,
    pollIntervalMs: options?.pollIntervalMs,
    resumeAsyncId: options?.resumeAsyncId,
  });

  return result.scripts[channelName] || null;
}

/**
 * Retrieves callable tool URLs for an Agentforce channel from a pre-authorized,
 * explicitly scoped Salesforce connection.
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
  const conn = opts.conn;
  let orgId = opts.orgId;
  let teamId = opts.teamId;

  if (!conn || !env?.DB || !teamId || !orgId) {
    throw new Error("A verified Salesforce connection and explicit tenant scope are required.");
  }

  // Retrieve Agent Script and prompt templates (skipped when prefetched).
  const agentResult = opts.prefetched ?? await retrieveAgentScriptForChannel(conn, channelId, {
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
    let response: Response;
    try {
      response = await binding.fetch("https://retrieve64.internal/definitions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-salesforce-access-token": conn.accessToken,
          "x-salesforce-instance-url": conn.instanceUrl,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if ((error as Error)?.name === "TimeoutError") throw new Error("retrieve64 service binding request timed out");
      throw error;
    }

    if (!response.ok) {
      let errText = `HTTP ${response.status}`;
      try {
        errText = await response.text();
      } catch {
        // Fall through with the HTTP status; the failure itself is never swallowed.
      }
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
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-salesforce-access-token": conn.accessToken,
        "x-salesforce-instance-url": conn.instanceUrl,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") throw new Error("retrieve64 HTTP request timed out");
    throw error;
  }

  if (!response.ok) {
    let errText = `HTTP ${response.status}`;
    try {
      errText = await response.text();
    } catch {
      // Fall through with the HTTP status; the failure itself is never swallowed.
    }
    throw new Error(`retrieve64 HTTP request failed: ${errText}`);
  }

  const data = (await response.json()) as any;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.urls)) return data.urls;
  if (Array.isArray(data?.callableToolUrls)) return data.callableToolUrls;
  return [];
}
