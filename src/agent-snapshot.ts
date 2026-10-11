import { XMLParser, XMLValidator } from "fast-xml-parser";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { requireScope, readBodyBounded, SecurityError, type TenantScope } from "./request-security";
import type { SalesforceConnection } from "./agent-script";

// Metadata only. Flow/Apex references are recorded, never retrieved.
const TYPES = ["Bot", "AiAuthoringBundle", "GenAiPlannerBundle", "GenAiPlugin", "GenAiFunction", "GenAiPromptTemplate", "GenAiPlanner", "AiAgent", "AiAgentDefinition", "AiAgentDefinitionVersion", "BotTemplate", "GenAiPluginInstructionDef", "GenAiPluginInstruction", "GenAiFunctionDefinition"];
const MAX_ARCHIVE = 12_000_000;
const MAX_FILES = 2000;
const MAX_BYTES = 24_000_000;
const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, parseTagValue: false, processEntities: true });
type Member = { type: string; fullName: string; apiVersion?: string };
type Inventory = { apiVersion: string; legacyApiVersion?: string; typesByVersion: Record<string, string[]>; supportedTypes: string[]; members: Member[]; warnings: string[] };
type State = { executionUserId: string; inventory: Inventory; requested: Member[]; pending: Member[]; queued: Member[]; retrieveId: string | null; edges: Array<{ from: string; to: string }>; warnings: string[]; excluded: string[]; versions: string[]; rounds: number };
type Job = { id: string; agent_name: string; status: string; state_json: string; manifest_json: string | null; created_at: number; updated_at: number; lease_until: number };
const arr = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const xml = (value: string) => value.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
const memberKey = (m: Member) => `${m.type}:${m.fullName}`;
const scopeArgs = (scope: TenantScope) => { requireScope(scope); return [scope.teamId, scope.orgId, scope.channelId]; };
export async function sha256(bytes: Uint8Array): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), n => n.toString(16).padStart(2, "0")).join(""); }
function parseXml(text: string): any {
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw new SecurityError(502, "invalid_metadata_xml");
  return parser.parse(text);
}
async function soap(conn: SalesforceConnection, version: string, operation: string, body: string): Promise<any> {
  const response = await fetch(`${conn.instanceUrl}/services/Soap/m/${version}`, {
    method: "POST", headers: { "Content-Type": "text/xml; charset=UTF-8", SOAPAction: operation },
    body: `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://soap.sforce.com/2006/04/metadata"><s:Header><m:SessionHeader><m:sessionId>${xml(conn.accessToken)}</m:sessionId></m:SessionHeader></s:Header><s:Body><m:${operation}>${body}</m:${operation}></s:Body></s:Envelope>`,
    signal: AbortSignal.timeout(60_000),
  });
  const text = new TextDecoder().decode(await readBodyBounded(response, MAX_ARCHIVE * 1.4));
  if (response.status === 429) throw new SecurityError(429, "salesforce_metadata_rate_limited");
  if ([503,504].includes(response.status)) throw new SecurityError(503, "salesforce_metadata_temporarily_unavailable");
  const envelope = parseXml(text)?.Envelope?.Body;
  if (!response.ok || envelope?.Fault) {
    const fault = String(envelope?.Fault?.faultcode ?? "").replace(/[^A-Za-z0-9_:.-]/g, "").slice(0, 100);
    if (/REQUEST_LIMIT_EXCEEDED/.test(fault)) throw new SecurityError(429, "salesforce_metadata_rate_limited");
    if (/INVALID_SESSION_ID/.test(fault)) throw new SecurityError(401, "salesforce_metadata_session_expired");
    if (/INSUFFICIENT_ACCESS/.test(fault)) throw new SecurityError(403, "agent_metadata_permission_required");
    throw new SecurityError(response.status === 401 ? 401 : 502, `salesforce_metadata_request_failed:${operation}:${fault || response.status}`);
  }
  const result = envelope?.[`${operation}Response`]?.result;
  if (result === undefined && operation === "listMetadata" && envelope?.listMetadataResponse !== undefined) return [];
  if (result === undefined) throw new SecurityError(502, "invalid_metadata_response");
  return result;
}
export async function discoverAgents(conn: SalesforceConnection): Promise<Inventory & { agents: Array<{ name: string; type: string; versions: string[] }> }> {
  const response = await fetch(`${conn.instanceUrl}/services/data/`, { headers: { Authorization: `Bearer ${conn.accessToken}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new SecurityError(response.status === 401 ? 401 : 502, "salesforce_versions_failed");
  const versions = JSON.parse(new TextDecoder().decode(await readBodyBounded(response, 100_000))) as Array<{ version: string }>;
  const apiVersion = versions.filter(v => /^\d+\.\d+$/.test(v.version)).sort((a, b) => Number(b.version) - Number(a.version))[0]?.version;
  if (!apiVersion) throw new SecurityError(502, "salesforce_version_unavailable");
  // v68 replaced legacy planner metadata. Keep legacy agents on the highest
  // advertised API at or below v67, while discovering modern roots on latest.
  const legacyApiVersion = versions.filter(v => Number(v.version) <= 67).sort((a, b) => Number(b.version) - Number(a.version))[0]?.version;
  const typesByVersion: Record<string, string[]> = {};
  const membersByKey = new Map<string, Member>();
  const warnings: string[] = [];
  for (const version of [...new Set([apiVersion, ...(legacyApiVersion ? [legacyApiVersion] : [])])]) {
    const described = await soap(conn, version, "describeMetadata", `<m:asOfVersion>${version}</m:asOfVersion>`);
    const available = new Set(arr<any>(described.metadataObjects).map(m => m.xmlName));
    const types = TYPES.filter(type => available.has(type));
    typesByVersion[version] = types;
    // Legacy discovery also supplies legacy dependencies absent from v68.
    const listedTypes = version === apiVersion && legacyApiVersion && version !== legacyApiVersion
      ? types.filter(type => ["AiAgent", "AiAgentDefinition", "AiAgentDefinitionVersion"].includes(type)) : types;
    const baseTypes = listedTypes.filter(type => type !== "GenAiPromptTemplate");
    for (let offset = 0; offset < baseTypes.length; offset += 3) {
      const batch = baseTypes.slice(offset, offset + 3);
      const results = arr<any>(await soap(conn, version, "listMetadata", batch.map(type => `<m:queries><m:type>${type}</m:type></m:queries>`).join("") + `<m:asOfVersion>${version}</m:asOfVersion>`));
      for (const item of results) if (typeof item.fullName === "string" && typeof item.type === "string") {
        const member = { type: item.type, fullName: item.fullName, apiVersion: version }; membersByKey.set(memberKey(member), member);
      }
      if (results.length >= 1000) warnings.push(`Metadata inventory may be truncated for ${batch.join(", ")}.`);
    }
  }
  // Optional prompt inventory must not prevent base agent discovery.
  const promptVersion = legacyApiVersion ?? apiVersion;
  if (typesByVersion[promptVersion]?.includes("GenAiPromptTemplate")) {
    try {
      const results = arr<any>(await soap(conn, promptVersion, "listMetadata", `<m:queries><m:type>GenAiPromptTemplate</m:type></m:queries><m:asOfVersion>${promptVersion}</m:asOfVersion>`));
      for (const item of results) if (typeof item.fullName === "string" && item.type === "GenAiPromptTemplate") membersByKey.set(memberKey(item), { type: item.type, fullName: item.fullName, apiVersion: promptVersion });
      if (results.length >= 1000) warnings.push("Prompt metadata inventory may be truncated.");
    } catch (error) {
      if (!(error instanceof SecurityError) || (error.status !== 403 && !/INVALID_TYPE|INVALID_FIELD/.test(error.code))) throw error;
      warnings.push("Prompt metadata is unavailable to the extraction user; related agent downloads can be incomplete.");
    }
  }
  const members = [...membersByKey.values()], supportedTypes = [...new Set(Object.values(typesByVersion).flat())];
  return { apiVersion, legacyApiVersion, typesByVersion, supportedTypes, members, warnings, agents: members.filter(m => ["Bot", "AiAgent", "AiAgentDefinition"].includes(m.type)).map(m => ({ name: m.fullName, type: m.type, versions: members.filter(v => ["AiAuthoringBundle", "AiAgentDefinitionVersion"].includes(v.type) && v.fullName.startsWith(m.fullName + "_")).map(v => v.fullName) })) };

}
async function beginRetrieve(conn: SalesforceConnection, version: string, members: Member[]): Promise<string> {
  const types = [...new Set(members.map(m => m.type))];
  const result = await soap(conn, version, "retrieve", `<m:retrieveRequest><m:apiVersion>${version}</m:apiVersion><m:singlePackage>true</m:singlePackage><m:unpackaged>${types.map(type => `<m:types>${members.filter(m => m.type === type).map(m => `<m:members>${xml(m.fullName)}</m:members>`).join("")}<m:name>${type}</m:name></m:types>`).join("")}<m:version>${version}</m:version></m:unpackaged></m:retrieveRequest>`);
  if (typeof result.id !== "string") throw new SecurityError(502, "metadata_retrieve_not_started");
  return result.id;
}

type MetadataRetrieveProbe = "ready" | "pending" | "denied" | "failed" | "not_available";

/**
 * Read-only permission check for the Activation UI. It discovers actual
 * metadata in this org, starts a retrieve for one real agent component (or an
 * empty package when the org has no agents), and polls without storing the
 * archive or retrieve ID. The Metadata API permission itself permits writes,
 * but this probe only reads definitions and discards the response.
 */
export async function probeAgentMetadataPermissions(conn: SalesforceConnection) {
  const inventory = await discoverAgents(conn);
  const root = inventory.members.find(m => ["Bot", "AiAgent", "AiAgentDefinition"].includes(m.type));
  const start = async (member: Member | undefined): Promise<MetadataRetrieveProbe> => {
    const version = member?.apiVersion ?? inventory.apiVersion;
    const id = await beginRetrieve(conn, version, member ? [member] : []);
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await soap(conn, version, "checkRetrieveStatus", `<m:asyncProcessId>${xml(id)}</m:asyncProcessId><m:includeZip>false</m:includeZip>`);
      if (result.done === "true") {
        if (result.success !== "true") return "denied";
        if (member && !arr<any>(result.fileProperties).some(p => `${p.type}:${p.fullName}` === memberKey(member))) return "failed";
        return "ready";
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return "pending";
  };

  // listMetadata already proved discovery permission. When the org has no
  // agent definition there is nothing real to retrieve, so report that case
  // explicitly instead of submitting an invalid empty package.
  const agentRetrieve = root ? await start(root) : "not_available";
  const prompt = inventory.members.find(m => m.type === "GenAiPromptTemplate");
  const promptUnavailable = inventory.warnings.some(w => w.startsWith("Prompt metadata is unavailable"));
  const promptRetrieve = prompt
    ? await start(prompt)
    : promptUnavailable ? "denied" : "not_available";
  return {
    apiVersion: inventory.apiVersion,
    agentCount: inventory.agents.length,
    agentRetrieve,
    promptCount: inventory.members.filter(m => m.type === "GenAiPromptTemplate").length,
    promptRetrieve,
  } as const;
}

function references(text: string, inventory: Inventory, from: string): { members: Member[]; edges: State["edges"]; excluded: string[] } {
  let searchable = text;
  // Legacy planner archives encode .agent and graph payloads as Base64.
  if (/^[A-Za-z0-9+/=\s]+$/.test(text.trim()) && text.trim().length > 40) {
    try { searchable += "\n" + new TextDecoder().decode(Uint8Array.from(atob(text.trim()), c => c.charCodeAt(0))); } catch { /* ordinary metadata text */ }
  }
  const members = inventory.members.filter(m => {
    if (["Bot", "AiAgent", "AiAgentDefinition", "BotTemplate"].includes(m.type)) return false;
    const escaped = m.fullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(searchable);
  });
  const excluded: string[] = [];
  if (text.trim().startsWith("<")) {
    const document = parseXml(text);
    const definitions = new Set<string>();
    function visit(node: any, action: (key: string, value: any, parent: any) => void) {
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        action(key, value, node);
        for (const item of arr(value)) visit(item, action);
      }
    }
    visit(document, (key, value) => { if (["fullName", "developerName"].includes(key) && typeof value === "string") definitions.add(value); });
    const typed: Record<string, string> = { genAiPlannerName: "GenAiPlannerBundle", genAiPluginName: "GenAiPlugin", genAiFunctionName: "GenAiFunction", functionName: "GenAiFunction", promptTemplateName: "GenAiPromptTemplate", genAiPromptTemplateName: "GenAiPromptTemplate", agentTemplate: "BotTemplate" };
    visit(document, (key, value, parent) => {
      if (key === "invocationTarget" && typeof value === "string" && /flow|apex/i.test(parent.invocationTargetType ?? "")) excluded.push(`${parent.invocationTargetType}:${value}`);
      const type = typed[key];
      if (type && typeof value === "string" && !definitions.has(value)) members.push({ type, fullName: value });
      if (key === "invocationTarget" && /prompt/i.test(parent.invocationTargetType ?? "") && typeof value === "string") members.push({ type: "GenAiPromptTemplate", fullName: value });
    });
    // Embedded local topics/actions are already preserved inside the planner.
    for (let i = members.length - 1; i >= 0; i--) if (["GenAiPlugin", "GenAiFunction"].includes(members[i].type) && definitions.has(members[i].fullName)) members.splice(i, 1);
  }

  return { members, edges: members.map(m => ({ from, to: memberKey(m) })), excluded };
}
function validatePath(path: string): string {
  const normalized = path.replace(/^unpackaged\//, "");
  if (!normalized || normalized.includes("\\") || normalized.split("/").some(p => p === ".." || p === ".") || normalized.startsWith("/") || /[\u0000-\u001f]/.test(normalized)) throw new SecurityError(502, "invalid_metadata_file_path");
  return normalized;
}
async function saveFile(db: D1Database, scope: TenantScope, jobId: string, path: string, bytes: Uint8Array): Promise<void> {
  const digest = await sha256(bytes);
  const existing = await db.prepare("SELECT sha256 FROM sf_agent_snapshot_file WHERE team_id=? AND org_id=? AND channel_id=? AND job_id=? AND path=?").bind(...scopeArgs(scope), jobId, path).first<{ sha256: string }>();
  if (existing?.sha256 === digest) return;
  if (existing) throw new SecurityError(409, "agent_changed_during_extraction");
  const statements = [db.prepare("INSERT INTO sf_agent_snapshot_file(team_id,org_id,channel_id,job_id,path,sha256,byte_size) VALUES(?,?,?,?,?,?,?)").bind(...scopeArgs(scope), jobId, path, digest, bytes.length)];
  for (let offset = 0, chunk = 0; offset < bytes.length || (offset === 0 && bytes.length === 0); offset += 48_000, chunk++) {
    statements.push(db.prepare("INSERT INTO sf_agent_snapshot_chunk(team_id,org_id,channel_id,job_id,path,chunk_index,content) VALUES(?,?,?,?,?,?,?)").bind(...scopeArgs(scope), jobId, path, chunk, bytes.slice(offset, offset + 48_000).buffer));
  }
  await db.batch(statements);
}
async function filesForJob(db: D1Database, scope: TenantScope, id: string) {
  return (await db.prepare("SELECT path,sha256,byte_size FROM sf_agent_snapshot_file WHERE team_id=? AND org_id=? AND channel_id=? AND job_id=? ORDER BY path").bind(...scopeArgs(scope), id).all<{ path: string; sha256: string; byte_size: number }>()).results;
}
async function getJob(db: D1Database, scope: TenantScope, id: string): Promise<Job> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw new SecurityError(400, "invalid_job_id");
  const job = await db.prepare("SELECT id,agent_name,status,state_json,manifest_json,created_at,updated_at,lease_until FROM sf_agent_snapshot_job WHERE team_id=? AND org_id=? AND channel_id=? AND id=?").bind(...scopeArgs(scope), id).first<Job>();
  if (!job) throw new SecurityError(404, "agent_snapshot_not_found");
  return job;
}
const resultForJob = (job: Job) => ({ jobId: job.id, agentName: job.agent_name, status: job.status, manifest: job.manifest_json ? JSON.parse(job.manifest_json) : null, retryAfterSeconds: job.status === "retrieving" ? 2 : undefined });
export async function startAgentSnapshot(db: D1Database, scope: TenantScope, conn: SalesforceConnection & { integrationUserId: string }, agentName: string, agentType = "Bot") {
  if (typeof agentName !== "string" || agentName.length > 255 || !/^[A-Za-z0-9_.-]+$/.test(agentName)) throw new SecurityError(400, "invalid_agent_name");
  const inventory = await discoverAgents(conn);
  const root = inventory.agents.find(a => a.name === agentName && a.type === agentType);
  if (!root) throw new SecurityError(404, "agent_not_found");
  if (agentType === "Bot" && inventory.legacyApiVersion) inventory.apiVersion = inventory.legacyApiVersion;
  // Only actual inventory members are requested; no guessed suffixes.
  const roots = inventory.members.filter(m => (["Bot", "AiAgent", "AiAgentDefinition"].includes(m.type) && m.fullName === agentName) || (["AiAuthoringBundle", "AiAgentDefinitionVersion"].includes(m.type) && root.versions.includes(m.fullName)));
  const pending = roots.filter(m => m.apiVersion === inventory.apiVersion), queued = roots.filter(m => m.apiVersion !== inventory.apiVersion);
  if (!pending.length) throw new SecurityError(502, "agent_metadata_root_unavailable");
  const state: State = { executionUserId: conn.integrationUserId, inventory, requested: roots, pending, queued, retrieveId: null, edges: [], warnings: [...inventory.warnings], excluded: [], versions: root.versions, rounds: 0 };
  state.retrieveId = await beginRetrieve(conn, inventory.apiVersion, pending);
  const id = crypto.randomUUID(), now = Date.now();
  await db.prepare("INSERT INTO sf_agent_snapshot_job(id,team_id,org_id,channel_id,agent_name,status,state_json,created_at,updated_at) VALUES(?,?,?,?,?,'retrieving',?,?,?)").bind(id, ...scopeArgs(scope), agentName, JSON.stringify(state), now, now).run();
  return { jobId: id, agentName, status: "retrieving", retryAfterSeconds: 2 };
}
export async function advanceAgentSnapshot(db: D1Database, scope: TenantScope, conn: SalesforceConnection & { integrationUserId: string }, id: string) {
  const job = await getJob(db, scope, id);
  if (job.status !== "retrieving") return resultForJob(job);
  const now = Date.now(), lease = now + 300_000;
  const lock = await db.prepare("UPDATE sf_agent_snapshot_job SET lease_until=? WHERE team_id=? AND org_id=? AND channel_id=? AND id=? AND lease_until<? AND status='retrieving'").bind(lease, ...scopeArgs(scope), id, now).run();
  if (!lock.meta.changes) return resultForJob(job);
  const state: State = JSON.parse(job.state_json);
  try {
    if (state.executionUserId !== conn.integrationUserId) throw new SecurityError(409, "agent_extraction_user_changed");
    if (now - job.created_at > 3600_000) throw new SecurityError(408, "agent_extraction_expired");
    const currentVersion = state.pending[0].apiVersion ?? state.inventory.apiVersion;
    const retrieved = await soap(conn, currentVersion, "checkRetrieveStatus", `<m:asyncProcessId>${xml(state.retrieveId!)}</m:asyncProcessId><m:includeZip>true</m:includeZip>`);
    if (retrieved.done !== "true") return resultForJob(job);
    for (const warning of arr<any>(retrieved.messages)) state.warnings.push(`${warning.fileName ?? "metadata"}: ${warning.problem ?? "Salesforce retrieval warning"}`);
    if (retrieved.success !== "true" || typeof retrieved.zipFile !== "string") {
      const deniedEntity = String(retrieved.errorMessage ?? "").match(/INSUFFICIENT_ACCESS:.*entity:\s*([A-Za-z][A-Za-z0-9_]*)/);
      if (deniedEntity) throw new SecurityError(403, `agent_metadata_access_required:${deniedEntity[1]}`);
      throw new SecurityError(502, "agent_metadata_retrieve_failed");
    }
    const zip = Uint8Array.from(atob(retrieved.zipFile), c => c.charCodeAt(0));
    if (zip.length > MAX_ARCHIVE) throw new SecurityError(413, "agent_archive_too_large");
    let expandedBytes = 0, expandedFiles = 0;
    const archive = unzipSync(zip, { filter: file => {
      expandedBytes += file.originalSize; expandedFiles++;
      if (expandedBytes > MAX_BYTES || expandedFiles > MAX_FILES) throw new SecurityError(413, "agent_snapshot_too_large");
      return !file.name.endsWith("/");
    } });
    const next = new Map<string, Member>();
    // FileProperties is the authoritative inventory of components returned.
    const returned = new Set(arr<any>(retrieved.fileProperties).map(p => `${p.type}:${p.fullName}`));
    for (const member of state.pending) if (!returned.has(memberKey(member))) state.warnings.push(`Requested component not returned: ${memberKey(member)}`);
    for (const [rawPath, bytes] of Object.entries(archive)) {
      const path = validatePath(rawPath);
      if (path === "package.xml") continue;
      if (/^(classes|flows)\//.test(path)) throw new SecurityError(502, "excluded_metadata_returned");
      await saveFile(db, scope, id, path, bytes);
      const text = new TextDecoder().decode(bytes);
      if (path === `bots/${job.agent_name}.bot`) {
        state.versions.push(...arr<any>(parseXml(text)?.Bot?.botVersions).map(v => v.fullName).filter((v): v is string => typeof v === "string"));
      }
      const refs = references(text, state.inventory, path);
      state.edges.push(...refs.edges); state.excluded.push(...refs.excluded);
      for (const m of refs.members) {
        const known = state.inventory.members.find(known => memberKey(known) === memberKey(m));
        const member = known ?? { ...m, apiVersion: currentVersion };
        if (!state.inventory.typesByVersion[member.apiVersion ?? currentVersion]?.includes(member.type)) { state.warnings.push(`Referenced metadata type unavailable: ${memberKey(m)}`); continue; }
        if (!state.requested.some(r => memberKey(r) === memberKey(member))) next.set(memberKey(member), member);
      }
    }
    state.rounds++;
    const files = await filesForJob(db, scope, id);
    if (files.length > MAX_FILES || files.reduce((sum, f) => sum + f.byte_size, 0) > MAX_BYTES) throw new SecurityError(413, "agent_snapshot_too_large");
    let status = "retrieving", manifest: string | null = null;
    state.requested.push(...next.values());
    state.queued.push(...next.values());
    if (state.queued.length && state.rounds < 20) {
      const version = state.queued[0].apiVersion ?? state.inventory.apiVersion;
      state.pending = state.queued.filter(m => (m.apiVersion ?? state.inventory.apiVersion) === version);
      state.queued = state.queued.filter(m => (m.apiVersion ?? state.inventory.apiVersion) !== version);
      if (state.requested.length > MAX_FILES) throw new SecurityError(413, "agent_dependencies_too_large");
      state.retrieveId = await beginRetrieve(conn, version, state.pending);
    } else {
      if (state.queued.length) state.warnings.push("Dependency traversal limit reached.");
      if (!files.length) throw new SecurityError(502, "empty_agent_snapshot");
      status = state.warnings.length ? "incomplete" : "complete";
      manifest = JSON.stringify({ schemaVersion: 1, integrationUserId: state.executionUserId, agentName: job.agent_name, orgId: scope.orgId, apiVersion: state.inventory.apiVersion, apiVersions: [...new Set(state.requested.map(m => m.apiVersion))], extractedAt: new Date().toISOString(), status, versions: [...new Set(state.versions)], components: state.requested, dependencies: [...new Map(state.edges.map(e => [JSON.stringify(e), e])).values()], excludedFlowApexReferences: [...new Set(state.excluded)], warnings: [...new Set(state.warnings)], files });
    }
    await db.prepare("UPDATE sf_agent_snapshot_job SET state_json=?,status=?,manifest_json=?,updated_at=? WHERE team_id=? AND org_id=? AND channel_id=? AND id=? AND lease_until=?").bind(JSON.stringify(state), status, manifest, Date.now(), ...scopeArgs(scope), id, lease).run();
    return resultForJob(await getJob(db, scope, id));
  } catch (cause) {
    // Auth/network failures remain resumable. Invalid content and upstream retrieval failures terminate explicitly.
    if (cause instanceof SecurityError && cause.status !== 401 && !cause.code.startsWith("salesforce_metadata_request_failed")) {
      await db.prepare("UPDATE sf_agent_snapshot_job SET status='failed',manifest_json=?,updated_at=? WHERE team_id=? AND org_id=? AND channel_id=? AND id=? AND lease_until=?").bind(JSON.stringify({ error: cause.code, agentName: job.agent_name, warnings: state.warnings }), Date.now(), ...scopeArgs(scope), id, lease).run();
    }
    throw cause;
  } finally {
    await db.prepare("UPDATE sf_agent_snapshot_job SET lease_until=0 WHERE team_id=? AND org_id=? AND channel_id=? AND id=? AND lease_until=?").bind(...scopeArgs(scope), id, lease).run();
  }
}
export async function agentSnapshotStatus(db: D1Database, scope: TenantScope, id: string) { return resultForJob(await getJob(db, scope, id)); }
export async function downloadAgentSnapshot(db: D1Database, scope: TenantScope, id: string): Promise<Response> {
  const job = await getJob(db, scope, id);
  if (!["complete", "incomplete"].includes(job.status)) throw new SecurityError(409, "agent_snapshot_not_ready");
  const archive: Record<string, Uint8Array> = { "manifest.json": strToU8(job.manifest_json!) };
  for (const file of await filesForJob(db, scope, id)) {
    const chunks = (await db.prepare("SELECT content FROM sf_agent_snapshot_chunk WHERE team_id=? AND org_id=? AND channel_id=? AND job_id=? AND path=? ORDER BY chunk_index").bind(...scopeArgs(scope), id, file.path).all<{ content: number[] }>()).results;
    const bytes = new Uint8Array(file.byte_size); let offset = 0;
    for (const chunk of chunks) { const part = new Uint8Array(chunk.content); bytes.set(part, offset); offset += part.length; }
    if (offset !== file.byte_size || await sha256(bytes) !== file.sha256) throw new SecurityError(500, "agent_snapshot_integrity_failed");
    archive[file.path] = bytes;
  }
  return new Response(zipSync(archive) as BodyInit, { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${job.agent_name}-${id}.zip"`, "Cache-Control": "no-store" } });
}

/** Resumable live retrieval check; its state belongs to the registered extraction identity. */
export async function verifyAgentAccess(db: D1Database, scope: TenantScope, conn: SalesforceConnection & { integrationUserId: string }) {
  const args = scopeArgs(scope);
  const row = await db.prepare("SELECT integration_user_id,verification_json FROM sf_agent_metadata_user WHERE team_id=? AND org_id=? AND channel_id=?")
    .bind(...args).first<{ integration_user_id: string; verification_json: string | null }>();
  if (!row || row.integration_user_id !== conn.integrationUserId) throw new SecurityError(409, "agent_metadata_user_not_registered");
  let state = row.verification_json ? JSON.parse(row.verification_json) as { retrieveId?: string; version: string; startedAt: number; verifiedAt?: number; userId: string; promptReady?: boolean; promptRetrieveId?: string; promptVersion?: string; baseVerified?: boolean; rootKey?: string; promptKey?: string } : null;
  if (state?.userId !== conn.integrationUserId || Date.now() - state.startedAt > 900_000) state = null;
  if (state?.verifiedAt && Date.now() - state.verifiedAt < 60_000) return { ready: true, integrationUserId: conn.integrationUserId, promptReady: state.promptReady === true };
  if (!state || state.verifiedAt) {
    const inventory = await discoverAgents(conn);
    const root = inventory.members.find(m => ["Bot", "AiAgentDefinition", "AiAgent"].includes(m.type));
    const version = root?.apiVersion ?? inventory.apiVersion;
    const prompt = inventory.members.find(m => m.type === "GenAiPromptTemplate");
    // Prompt metadata is gated independently, even when the org has no templates.
    const described = await fetch(`${conn.instanceUrl}/services/data/v${inventory.apiVersion}/sobjects/PermissionSet/describe`, {
      headers: { Authorization: `Bearer ${conn.accessToken}` }, signal: AbortSignal.timeout(30_000),
    });
    if (!described.ok) throw new SecurityError(described.status === 401 ? 401 : 403, "agent_permission_schema_check_failed");
    const permissionSchema = JSON.parse(new TextDecoder().decode(await readBodyBounded(described, 3_000_000))) as { fields?: Array<{ name: string }> };
    const promptPermissionAvailable = permissionSchema.fields?.some(f => f.name === "PermissionsManagePromptTemplates");
    let promptReady = false;
    if (inventory.supportedTypes.includes("GenAiPromptTemplate") && promptPermissionAvailable) {
      const response = await fetch(`${conn.instanceUrl}/services/data/v${inventory.apiVersion}/query?q=${encodeURIComponent("SELECT Id FROM PermissionSetAssignment WHERE AssigneeId='" + conn.integrationUserId + "' AND PermissionSet.PermissionsManagePromptTemplates=true LIMIT 1")}`, {
        headers: { Authorization: `Bearer ${conn.accessToken}` }, signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new SecurityError(response.status === 401 ? 401 : 403, "agent_prompt_permission_check_failed");
      const result = JSON.parse(new TextDecoder().decode(await readBodyBounded(response, 100_000))) as { records?: unknown[] };
      promptReady = !!result.records?.length && !inventory.warnings.some(w => w.startsWith("Prompt metadata is unavailable"));
    }
    const members = [root].filter((m): m is Member => !!m);
    // An empty metadata package is valid for an org with no agent definitions.
    state = { retrieveId: await beginRetrieve(conn, version, members), version, startedAt: Date.now(), userId: conn.integrationUserId, promptReady, rootKey: root ? memberKey(root) : undefined };
    if (promptReady && prompt) {
      try {
        state.promptKey = memberKey(prompt);
        state.promptVersion = prompt.apiVersion ?? version;
        state.promptRetrieveId = await beginRetrieve(conn, state.promptVersion, [prompt]);
      } catch (error) {
        if (!(error instanceof SecurityError) || (error.status !== 403 && !/INVALID_TYPE|INVALID_FIELD/.test(error.code))) throw error;
        state.promptReady = false;
      }
    }
    await db.prepare("UPDATE sf_agent_metadata_user SET verification_json=? WHERE team_id=? AND org_id=? AND channel_id=? AND integration_user_id=?")
      .bind(JSON.stringify(state), ...args, conn.integrationUserId).run();
    return { ready: false, pending: true };
  }
  if (!state.baseVerified) {
    const retrieved = await soap(conn, state.version, "checkRetrieveStatus", `<m:asyncProcessId>${xml(state.retrieveId!)}</m:asyncProcessId><m:includeZip>true</m:includeZip>`);
    if (retrieved.done !== "true") return { ready: false, pending: true };
    if (retrieved.success !== "true" || typeof retrieved.zipFile !== "string" || (state.rootKey && !arr<any>(retrieved.fileProperties).some(p => `${p.type}:${p.fullName}` === state.rootKey))) {
      await db.prepare("UPDATE sf_agent_metadata_user SET verification_json=NULL WHERE team_id=? AND org_id=? AND channel_id=?").bind(...args).run();
      throw new SecurityError(403, "agent_metadata_retrieval_check_failed");
    }
    state.baseVerified = true;
  }
  if (state.promptRetrieveId) {
    try {
      const prompt = await soap(conn, state.promptVersion!, "checkRetrieveStatus", `<m:asyncProcessId>${xml(state.promptRetrieveId)}</m:asyncProcessId><m:includeZip>true</m:includeZip>`);
      if (prompt.done !== "true") return { ready: false, pending: true };
      state.promptReady = prompt.success === "true" && typeof prompt.zipFile === "string" && arr<any>(prompt.fileProperties).some(p => `${p.type}:${p.fullName}` === state.promptKey);
    } catch (error) {
      if (!(error instanceof SecurityError) || error.status !== 403) throw error;
      state.promptReady = false;
    }
    delete state.promptRetrieveId;
  }
  state.verifiedAt = Date.now();
  await db.prepare("UPDATE sf_agent_metadata_user SET verification_json=? WHERE team_id=? AND org_id=? AND channel_id=? AND integration_user_id=?")
    .bind(JSON.stringify(state), ...args, conn.integrationUserId).run();
  return { ready: true, integrationUserId: conn.integrationUserId, promptReady: state.promptReady === true };
}
