#!/usr/bin/env bun
/** Real-org verification only: no mocks, customer records, or setup mutations. */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { run, queryRecords, queryChannelRecords, buildPanelSessionPreflight, debugValue } from "./jwt-api-smoke";

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const target = option("--target-org"), agent = option("--agent"), environment = args.includes("--env") ? option("--env") : "production";
if (!args.includes("--target-org") || !args.includes("--agent") || !["production", "staging"].includes(environment)) throw new Error("Usage: bun scripts/agent-snapshot-live.ts --target-org <alias> --agent <developer-name> [--env production|staging]");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const outDir = `/tmp/tubot-agent-verification-${target.replace(/[^A-Za-z0-9_-]/g, "_")}`;
let stage = "organization lookup";
async function main() {
  const org = (await queryRecords(target, "SELECT Id FROM Organization LIMIT 1"))[0];
  const { schema, records } = await queryChannelRecords(target);
  if (records.length !== 1 || typeof org?.Id !== "string") throw new Error("Select exactly one registered channel.");
  const channelId = records[0][schema.channelIdField];
  if (typeof channelId !== "string" || !/^[A-Za-z0-9]{15,18}$/.test(channelId)) throw new Error("Invalid channel identity.");
  const preflight = await run("sf", ["apex", "run", "--target-org", target], buildPanelSessionPreflight());
  if (preflight.status || !debugValue(preflight.stdout, "JWT_PANEL_SESSION_READY=")) throw new Error("Panel session preflight failed.");
  async function request(operation: string, input: Record<string, unknown> = {}, download = false) {
    const payload = Buffer.from(JSON.stringify({ orgId: org.Id, ...input })).toString("base64");
    const apex = [
      "HttpRequest r = new HttpRequest();",
      `r.setEndpoint('callout:' + PanelAuthSupportService.getNamedCredentialName() + '/api/v1/salesforce/channels/${channelId}/agents/${operation}');`,
      "r.setMethod('POST'); r.setHeader('Content-Type','application/json'); r.setTimeout(120000);",
      `r.setBody(EncodingUtil.base64Decode('${payload}').toString());`,
      "HttpResponse response = new Http().send(r);",
      "System.debug('AGENT_STATUS=' + response.getStatusCode());",
      download ? "System.debug('AGENT_DOWNLOAD_BYTES=' + response.getBodyAsBlob().size());" : "System.debug('AGENT_RESULT=' + response.getBody());",
    ].join("\n");
    const executed = await run("sf", ["apex", "run", "--target-org", target], apex);
    const status = Number(debugValue(executed.stdout, "AGENT_STATUS="));
    const value = download ? { bytes: Number(debugValue(executed.stdout, "AGENT_DOWNLOAD_BYTES=")) } : JSON.parse(debugValue(executed.stdout, "AGENT_RESULT=") || "{}");
    return { status, value, cliExit: executed.status };
  }
  stage = "agent discovery";
  const listed = await request("list");
  if (listed.status !== 200 || !Array.isArray(listed.value.agents)) throw new Error(`Agent listing failed: HTTP ${listed.status}, ${listed.value.error?.code ?? listed.value.error ?? "unknown"}`);
  console.log(JSON.stringify({ target, agents: listed.value.agents.map((a: any) => a.name), apiVersion: listed.value.apiVersion }));
  if (!listed.value.agents.some((a: any) => a.name === agent)) throw new Error("Selected agent is absent from this org.");
  if (!args.includes("--job-id")) {
    const invalid = await request("extract", { agentName: "__NoSuchAgent__" });
    if (invalid.status !== 400 && invalid.status !== 404) throw new Error("Unknown agent was not rejected.");
  }
  stage = "extraction start";
  const started = args.includes("--job-id") ? { status: 202, value: { jobId: option("--job-id") } } : await request("extract", { agentName: agent });
  if (started.status !== 202 || typeof started.value.jobId !== "string") throw new Error(`Extraction failed: HTTP ${started.status}, ${JSON.stringify(started.value.error ?? {})}`);
  const jobId = started.value.jobId;
  let state: any;
  for (let attempt = 0; attempt < 50; attempt++) {
    stage = `extraction polling ${attempt + 1}`;
    await sleep(2000);
    const wave = attempt === 0 ? await Promise.all([request("advance", { jobId }), request("advance", { jobId })]) : [await request("advance", { jobId })];
    if (wave.some(r => r.status !== 200)) { const failed = wave.find(r => r.status !== 200)!; throw new Error(`Job advance failed: HTTP ${failed.status}, ${JSON.stringify(failed.value.error ?? {})}`); }
    const advanced = wave.find(r => r.value.status !== "retrieving") ?? wave[0];
    if (advanced.status !== 200) throw new Error(`Extraction poll failed: HTTP ${advanced.status}, ${JSON.stringify(advanced.value.error ?? {})}`);
    state = advanced.value;
    if (state.status !== "retrieving") break;
  }
  if (!["complete", "incomplete"].includes(state?.status)) throw new Error(`Extraction did not finish: ${state?.status}`);
  const manifest = state.manifest;
  if (typeof manifest.integrationUserId !== "string" || !/^[A-Za-z0-9]{15,18}$/.test(manifest.integrationUserId)) throw new Error("Extraction user identity missing.");
  const extractionUser = (await queryRecords(target, `SELECT Profile.UserLicense.Name FROM User WHERE Id='${manifest.integrationUserId}' LIMIT 1`))[0];
  const profile = extractionUser?.Profile as { UserLicense?: { Name?: string } } | undefined;
  if (profile?.UserLicense?.Name !== "Salesforce Integration") throw new Error("Extraction did not use the dedicated API-only integration user.");
  if (manifest.agentName !== agent || manifest.orgId !== org.Id || !manifest.files?.length) throw new Error("Extracted agent identity mismatch.");
  await mkdir(outDir, { recursive: true });
  await writeFile(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2));
  await writeFile(`${outDir}/identity.json`, JSON.stringify({ orgId: org.Id, channelId, jobId, agentName: agent, environment }));
  console.log(JSON.stringify({ target, jobId, agentName: agent, status: state.status, files: manifest.files.length, warnings: manifest.warnings }));
  stage = "snapshot download";
  const downloaded = await request("download", { jobId }, true);
  if (downloaded.status !== 200 || downloaded.value.bytes < 100) throw new Error("Snapshot download failed.");
  stage = "independent CLI retrieval";
  await mkdir(`${outDir}/source`, { recursive: true });
  await writeFile(`${outDir}/sfdx-project.json`, JSON.stringify({ packageDirectories: [{ path: "source", default: true }], sourceApiVersion: manifest.apiVersion }));
  const actualFiles: Record<string, Uint8Array> = {};
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  for (const version of manifest.apiVersions ?? [manifest.apiVersion]) {
    const components = manifest.components.filter((m: any) => (m.apiVersion ?? manifest.apiVersion) === version);
    const types = [...new Set<string>(components.map((m: any) => m.type))];
    const packageXml = `<?xml version="1.0" encoding="UTF-8"?><Package xmlns="http://soap.sforce.com/2006/04/metadata">${types.map(type => `<types>${components.filter((m: any) => m.type === type).map((m: any) => `<members>${escape(m.fullName)}</members>`).join("")}<name>${type}</name></types>`).join("")}<version>${version}</version></Package>`;
    await writeFile(`${outDir}/package-${version}.xml`, packageXml);
    const retrieved = await run("sf", ["project", "retrieve", "start", "--target-org", target, "--manifest", `${outDir}/package-${version}.xml`, "--api-version", version, "--target-metadata-dir", `${outDir}/cli-${version}`, "--wait", "3", "--json"], undefined, outDir);
    const cli = JSON.parse(retrieved.stdout);
    if (retrieved.status || cli.result?.success !== true) throw new Error("Independent CLI metadata retrieval failed.");
    const zipped = await readFile(cli.result.zipFilePath);
    for (const [p, bytes] of Object.entries(unzipSync(zipped))) if (!p.endsWith("/")) {
      const path = p.replace(/^unpackaged\//, "");
      if (path === "package.xml") continue;
      if (actualFiles[path] && hash(actualFiles[path]) !== hash(bytes)) throw new Error("Metadata differs between API versions for the same file.");
      actualFiles[path] = bytes;
    }
  }
  const mismatched: string[] = [];
  for (const file of manifest.files) if (!actualFiles[file.path] || hash(actualFiles[file.path]) !== file.sha256) mismatched.push(file.path);
  if (mismatched.length) throw new Error(`CLI comparison failed for ${mismatched.length} files: ${mismatched.slice(0, 3).join(", ")}`);
  const extras = Object.keys(actualFiles).filter(p => p !== "package.xml" && !manifest.files.some((f: any) => f.path === p));
  if (extras.length) throw new Error(`CLI returned ${extras.length} files missing from the snapshot.`);
  stage = "independent remote D1 verification";
  const d1 = await run("bun", ["x", "wrangler", "d1", "execute", "DB", "--env", environment, "--remote", "--command", `SELECT j.org_id,j.agent_name,j.status,f.path,f.sha256,f.byte_size,c.chunk_index,hex(c.content) AS content_hex FROM sf_agent_snapshot_job j JOIN sf_agent_snapshot_file f ON f.team_id=j.team_id AND f.org_id=j.org_id AND f.channel_id=j.channel_id AND f.job_id=j.id JOIN sf_agent_snapshot_chunk c ON c.team_id=f.team_id AND c.org_id=f.org_id AND c.channel_id=f.channel_id AND c.job_id=f.job_id AND c.path=f.path WHERE j.id='${jobId}' ORDER BY f.path,c.chunk_index`, "--json"]);
  if (d1.status) throw new Error("Remote D1 query failed.");
  const rows = JSON.parse(d1.stdout)[0]?.results;
  if (!Array.isArray(rows) || !rows.length || rows.some((r: any) => r.org_id !== org.Id || r.agent_name !== agent || r.status !== state.status)) throw new Error("D1 tenant/agent mismatch.");
  for (const file of manifest.files) {
    const persisted = rows.filter((r: any) => r.path === file.path);
    const bytes = Buffer.concat(persisted.map((r: any) => Buffer.from(r.content_hex, "hex")));
    if (bytes.length !== file.byte_size || hash(bytes) !== file.sha256) throw new Error(`D1 content mismatch: ${file.path}`);
  }
  console.log(JSON.stringify({ target, selectedAgent: agent, cliFilesMatched: manifest.files.length, d1FilesMatched: manifest.files.length, downloadBytes: downloaded.value.bytes, status: "verified" }));
}
main().catch(cause => { console.error(`Agent verification failed during ${stage}: ${cause instanceof Error ? cause.message : "unknown"}`); process.exitCode = 1; });
