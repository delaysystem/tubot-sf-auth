#!/usr/bin/env bun
import { spawn } from "node:child_process";

type SalesforceRecord = Record<string, unknown>;
type ChannelSchema = {
  objectName: string;
  channelIdField: string;
  integrationUserIdField: string;
};

type JwtDiagnosticResult = {
  ok?: boolean;
  orgId?: string;
  integrationUser?: {
    id?: string | null;
    name?: string | null;
    username?: string | null;
    active?: boolean;
  } | null;
  checks?: Array<{
    name?: string;
    status?: number;
    ok?: boolean;
    errorCode?: string;
    summary?: Record<string, unknown>;
  }>;
  error?: string;
  message?: string;
  error_description?: string;
};

class SalesforceQueryError extends Error {
  constructor(readonly safeCode: "schema_unavailable" | "query_failed") {
    super(`Salesforce query ${safeCode}.`);
  }
}

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
let currentStage = "argument validation";
const CHANNEL_SCHEMAS: ChannelSchema[] = [
  {
    objectName: "tubot__Tubot_API_Channel__c",
    channelIdField: "tubot__Channel_Id__c",
    integrationUserIdField: "tubot__Integration_User_Id__c",
  },
  {
    objectName: "Tubot_API_Channel__c",
    channelIdField: "Channel_Id__c",
    integrationUserIdField: "Integration_User_Id__c",
  },
];

function usage(exitCode = 2): never {
  const message = "Usage: bun run jwt-api-smoke --target-org <sf-alias-or-username> [--channel-id <15-or-18-char-id>]";
  if (exitCode === 0) console.log(message);
  else console.error(message);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): { targetOrg: string; channelId?: string } {
  let targetOrg = "";
  let channelId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target-org" || arg === "-o") targetOrg = argv[++index] || "";
    else if (arg.startsWith("--target-org=")) targetOrg = arg.slice("--target-org=".length);
    else if (arg === "--channel-id") channelId = argv[++index];
    else if (arg.startsWith("--channel-id=")) channelId = arg.slice("--channel-id=".length);
    else if (arg === "--help" || arg === "-h") usage(0);
    else usage();
  }
  if (!targetOrg || targetOrg.startsWith("-") || targetOrg.length > 255) usage();
  if (channelId && !SF_ID.test(channelId)) throw new Error("--channel-id must be a 15- or 18-character Salesforce ID.");
  return { targetOrg, channelId };
}

async function run(command: string, args: string[], input?: string): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SF_SKIP_NEW_VERSION_CHECK: "true",
      SF_DISABLE_TELEMETRY: "true",
    },
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) throw new Error("Could not capture Salesforce CLI output safely.");
  const stdoutParts: Buffer[] = [];
  const stderrParts: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutParts.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrParts.push(chunk));
  if (input !== undefined) {
    if (!child.stdin) throw new Error("Could not send the Apex diagnostic request to Salesforce CLI.");
    child.stdin.write(input);
    child.stdin.end();
  }
  const [status] = await onceExit(child);
  return {
    status,
    stdout: Buffer.concat(stdoutParts).toString("utf8"),
    stderr: Buffer.concat(stderrParts).toString("utf8"),
  };
}

function onceExit(child: ReturnType<typeof spawn>): Promise<[number]> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve([code ?? 1]));
  });
}

function parseCliJson(output: string): Record<string, unknown> {
  const start = output.search(/[\[{]/);
  if (start < 0) throw new Error("Salesforce CLI did not return JSON.");
  try {
    const parsed: unknown = JSON.parse(output.slice(start));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Salesforce CLI returned an unreadable result.");
  }
}

async function queryRecords(targetOrg: string, soql: string): Promise<SalesforceRecord[]> {
  const result = await run("sf", [
    "data", "query", "--target-org", targetOrg, "--query", soql, "--json",
  ]);
  if (result.status !== 0) {
    let schemaUnavailable = false;
    try {
      const payload = parseCliJson(result.stdout);
      const code = typeof payload.name === "string" ? payload.name : "";
      const message = typeof payload.message === "string" ? payload.message : "";
      schemaUnavailable = code === "INVALID_TYPE" || code === "INVALID_FIELD" ||
        /sObject type .* is not supported|No such column/i.test(message);
    } catch { /* report the safe query failure category below */ }
    throw new SalesforceQueryError(schemaUnavailable ? "schema_unavailable" : "query_failed");
  }
  const payload = parseCliJson(result.stdout);
  const queryResult = payload.result as Record<string, unknown> | undefined;
  const records = queryResult?.records;
  if (!Array.isArray(records) || records.some((record) => !record || typeof record !== "object" || Array.isArray(record))) {
    throw new Error("Salesforce query returned an unexpected result shape.");
  }
  return records as SalesforceRecord[];
}

async function queryChannelRecords(
  targetOrg: string,
  requestedChannelId?: string,
): Promise<{ schema: ChannelSchema; records: SalesforceRecord[] }> {
  for (const schema of CHANNEL_SCHEMAS) {
    const channelFilter = requestedChannelId ? ` AND ${schema.channelIdField} = '${requestedChannelId}'` : "";
    try {
      const records = await queryRecords(targetOrg,
        `SELECT Id, ${schema.channelIdField}, ${schema.integrationUserIdField} ` +
        `FROM ${schema.objectName} ` +
        `WHERE ${schema.channelIdField} != null AND ${schema.integrationUserIdField} != null` +
        channelFilter + " ORDER BY CreatedDate DESC LIMIT 100");
      return { schema, records };
    } catch (cause) {
      if (cause instanceof SalesforceQueryError && cause.safeCode === "schema_unavailable") continue;
      throw cause;
    }
  }
  throw new Error("The TuBot API channel object could not be resolved in this org.");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && SF_ID.test(value);
}

function buildPanelSessionPreflight(forceRefresh = false): string {
  return [
    `PanelAuthController.ensurePanelSession(${forceRefresh ? "true" : "false"});`,
    "System.debug('JWT_PANEL_SESSION_READY=true');",
  ].join("\n");
}

function buildApexRequest(payload: Record<string, unknown>, channelId: string): string {
  const bodyBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return [
    "String panelNamedCredential = PanelAuthSupportService.getNamedCredentialName();",
    "HttpRequest jwtDiagnosticRequest = new HttpRequest();",
    `jwtDiagnosticRequest.setEndpoint('callout:' + panelNamedCredential + '/api/v1/salesforce/channels/${channelId}/jwt-api-diagnostics');`,
    "jwtDiagnosticRequest.setMethod('POST');",
    "jwtDiagnosticRequest.setHeader('Content-Type', 'application/json');",
    "jwtDiagnosticRequest.setTimeout(120000);",
    `jwtDiagnosticRequest.setBody(EncodingUtil.base64Decode('${bodyBase64}').toString());`,
    "HttpResponse jwtDiagnosticResponse = new Http().send(jwtDiagnosticRequest);",
    "System.debug('JWT_API_DIAGNOSTICS_STATUS=' + jwtDiagnosticResponse.getStatusCode());",
    "System.debug('JWT_API_DIAGNOSTICS_BODY=' + jwtDiagnosticResponse.getBody());",
  ].join("\n");
}

function debugValue(output: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`USER_DEBUG\\|\\[\\d+\\]\\|DEBUG\\|${escaped}([^\\r\\n]*)`));
  return match?.[1]?.trim() || null;
}

async function main(): Promise<void> {
  const { targetOrg, channelId: requestedChannelId } = parseArgs(process.argv.slice(2));
  currentStage = "organization lookup";
  const organizationRows = await queryRecords(targetOrg, "SELECT Id, IsSandbox FROM Organization LIMIT 1");
  const organization = organizationRows[0];
  if (organizationRows.length !== 1 || !validId(organization?.Id) || typeof organization.IsSandbox !== "boolean") {
    throw new Error("Could not resolve exactly one Salesforce org and environment.");
  }
  const orgId = organization.Id;

  currentStage = "channel lookup";
  const { schema: channelSchema, records: channelRows } = await queryChannelRecords(targetOrg, requestedChannelId);
  if (channelRows.length === 0) throw new Error("No registered TuBot API channel with an integration user was found in this org.");
  if (!requestedChannelId && channelRows.length > 1) {
    throw new Error("This org has multiple registered channels. Choose one with --channel-id.");
  }
  const channel = channelRows[0];
  const channelId = channel[channelSchema.channelIdField];
  const integrationUserId = channel[channelSchema.integrationUserIdField];
  if (!validId(channelId) || !validId(integrationUserId)) {
    throw new Error("The selected TuBot channel record has an invalid channel or integration user ID.");
  }

  currentStage = "integration user lookup";
  const users = await queryRecords(targetOrg,
    `SELECT Id, Name, Username, IsActive FROM User WHERE Id = '${integrationUserId}' LIMIT 1`);
  const user = users[0];
  if (users.length !== 1 || user?.Id !== integrationUserId || typeof user.Name !== "string" ||
      typeof user.Username !== "string" || user.IsActive !== true) {
    throw new Error("The registered integration user could not be resolved as one active Salesforce user.");
  }

  console.log(`Target org environment: ${organization.IsSandbox ? "sandbox" : "production"}.`);
  console.log("Registered channel and active integration user resolved.");
  console.log("Running JWT-backed Salesforce REST checks through tubot-sf-auth...");

  currentStage = "Panel session preflight";
  const preflight = await run("sf", ["apex", "run", "--target-org", targetOrg], buildPanelSessionPreflight());
  const preflightOutput = `${preflight.stdout}\n${preflight.stderr}`;
  if (preflight.status !== 0 || !preflightOutput.includes("Compiled successfully") ||
      !preflightOutput.includes("JWT_PANEL_SESSION_READY=true")) {
    throw new Error("Could not renew the Panel session. Connect Panel again and retry the live SOQL check.");
  }

  currentStage = "JWT API diagnostics callout";
  const apexCode = buildApexRequest({
    orgId,
    integrationUserId,
    integrationUsername: user.Username,
    isSandbox: organization.IsSandbox,
  }, channelId);
  const apex = await run("sf", ["apex", "run", "--target-org", targetOrg], apexCode);
  const output = `${apex.stdout}\n${apex.stderr}`;
  if (apex.status !== 0 || !output.includes("Compiled successfully")) {
    throw new Error("Salesforce Apex callout failed. Confirm the Panel Named Credential is connected and try again.");
  }
  const status = debugValue(output, "JWT_API_DIAGNOSTICS_STATUS=");
  const body = debugValue(output, "JWT_API_DIAGNOSTICS_BODY=");
  if (!body) {
    throw new Error(`JWT API diagnostic endpoint returned HTTP ${status || "unknown"}. Check the Panel connection and channel setup.`);
  }

  let diagnostic: JwtDiagnosticResult;
  try { diagnostic = JSON.parse(body) as JwtDiagnosticResult; }
  catch { throw new Error("The JWT API diagnostic endpoint returned invalid JSON."); }
  currentStage = "JWT identity verification";
  for (const check of diagnostic.checks || []) {
    const detail = check.errorCode ? `, ${check.errorCode}` : "";
    console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name || "Salesforce API request"} (HTTP ${check.status ?? "unknown"}${detail})`);
  }
  if (diagnostic.orgId !== orgId || diagnostic.integrationUser?.id !== integrationUserId ||
      diagnostic.integrationUser?.username !== user.Username) {
    throw new Error("The JWT identity returned by Salesforce does not match the selected org and integration user.");
  }
  if (status !== "200" || !diagnostic.ok) {
    currentStage = "JWT REST checks";
    throw new Error("One or more JWT-backed Salesforce REST checks failed.");
  }
  console.log("JWT identity matches the selected org and active integration user.");
}

main().catch((cause: unknown) => {
  void cause;
  console.error(`JWT API smoke check failed during ${currentStage}. Check org authorization, Panel setup, and channel registration.`);
  process.exitCode = 1;
});
