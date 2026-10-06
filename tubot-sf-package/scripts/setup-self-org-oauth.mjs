import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const API_VERSION = "67.0";
const APP_NAME = "TuBot_Self_Org_API_ECA";
const CALLBACK_PATH = "/api/v1/salesforce/self-oauth/callback";
const CONFIG_OBJECT_NAME = "MCP_Config__c";
const CONFIG_CLIENT_ID_FIELD = "Self_Org_ECA_Client_Id__c";
const CONFIG_PANEL_BASE_URL_FIELD = "Panel_Base_URL__c";

function parseArgs(argv) {
  const options = { targetOrg: "", apiVersion: API_VERSION, contactEmail: "", dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--target-org" || arg === "-o") options.targetOrg = argv[++i] ?? "";
    else if (arg === "--api-version") options.apiVersion = argv[++i] ?? "";
    else if (arg === "--contact-email") options.contactEmail = argv[++i] ?? "";
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.help) return options;
  if (!options.targetOrg) throw new Error("A Salesforce org alias or username is required via --target-org.");
  if (!/^\d+\.\d+$/.test(options.apiVersion)) throw new Error("--api-version must look like 67.0.");
  if (options.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.contactEmail)) {
    throw new Error("--contact-email must be a valid email address.");
  }
  return options;
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function apexLiteral(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function runSf(args, options = {}) {
  const result = spawnSync("sf", [...args, "--json"], {
    encoding: "utf8",
    input: options.input,
    cwd: options.cwd,
    timeout: 10 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") throw new Error("Salesforce CLI (`sf`) is not installed or not on PATH.");
  if (result.error) throw new Error(`Salesforce CLI failed to start: ${result.error.message}`);
  let payload;
  try { payload = JSON.parse(result.stdout || "{}"); } catch {
    // `sf apex run` writes its interactive prompt before the JSON result even
    // when `--json` is present. Parse that result object so debug markers are
    // read from structured log text rather than from escaped JSON output.
    const jsonStart = (result.stdout || "").indexOf("\n{");
    if (jsonStart >= 0) {
      try { payload = JSON.parse(result.stdout.slice(jsonStart + 1)); } catch { payload = null; }
    } else {
      payload = null;
    }
  }
  if (result.status !== 0 || payload?.status === 1) {
    const message = (payload?.message || result.stderr || "Salesforce CLI command failed").replace(/\s+/g, " ").slice(0, 600);
    throw new Error(message);
  }
  return { payload, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function nestedStrings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) for (const item of value) nestedStrings(item, output);
  else if (value && typeof value === "object") for (const item of Object.values(value)) nestedStrings(item, output);
  return output;
}

function extractValue(output, label) {
  // Apex logs include the submitted source before USER_DEBUG lines. Match the
  // marker only after the DEBUG delimiter so the source text cannot be parsed
  // as the value.
  const expression = new RegExp(`DEBUG\\|${label}=([^\\r\\n]*)`);
  for (const candidate of nestedStrings(output)) {
    const match = candidate.match(expression);
    if (match) return match[1].trim();
  }
  throw new Error(`The Salesforce CLI did not return ${label}.`);
}

function discoverConfigSchema(targetOrg) {
  const { payload: objectList } = runSf([
    "sobject", "list", "--sobject", "custom", "--target-org", targetOrg,
  ]);
  const objectNames = Array.isArray(objectList?.result) ? objectList.result : [];
  const matchingObjects = objectNames.filter(name =>
    typeof name === "string" && (name === CONFIG_OBJECT_NAME || name.endsWith(`__${CONFIG_OBJECT_NAME}`)),
  );
  if (matchingObjects.length === 0) {
    throw new Error(`Custom setting ${CONFIG_OBJECT_NAME} was not found in the target org. Install the TuBot package first.`);
  }
  if (matchingObjects.length > 1) {
    throw new Error(`Found multiple ${CONFIG_OBJECT_NAME} objects in the target org; cannot safely select the package setting.`);
  }

  const objectApiName = matchingObjects[0];
  const namespacePrefix = objectApiName === CONFIG_OBJECT_NAME
    ? ""
    : objectApiName.slice(0, -CONFIG_OBJECT_NAME.length);
  if (namespacePrefix && !/^[A-Za-z][A-Za-z0-9]*__$/.test(namespacePrefix)) {
    throw new Error(`Salesforce returned an invalid namespace prefix for ${CONFIG_OBJECT_NAME}.`);
  }

  const clientIdField = `${namespacePrefix}${CONFIG_CLIENT_ID_FIELD}`;
  const panelBaseUrlField = `${namespacePrefix}${CONFIG_PANEL_BASE_URL_FIELD}`;
  const panelTeamIdField = `${namespacePrefix}Panel_Team_Id__c`;
  const { payload: describe } = runSf([
    "sobject", "describe", "--sobject", objectApiName, "--target-org", targetOrg,
  ]);
  const availableFields = new Set((describe?.result?.fields || []).map(field => field.name));
  if (!availableFields.has(clientIdField) || !availableFields.has(panelBaseUrlField)) {
    throw new Error(`The discovered ${objectApiName} schema is missing fields required for self-org OAuth setup.`);
  }
  return {
    objectApiName,
    clientIdField,
    panelBaseUrlField,
    panelTeamIdField: availableFields.has(panelTeamIdField) ? panelTeamIdField : null,
  };
}

function buildMetadata({ panelBaseUrl, contactEmail }) {
  const callbackUrl = `${panelBaseUrl}${CALLBACK_PATH}`;
  const label = "TuBot Self Org API";
  const eca = `<?xml version="1.0" encoding="UTF-8"?>\n<ExternalClientApplication xmlns="http://soap.sforce.com/2006/04/metadata">\n  <contactEmail>${xml(contactEmail)}</contactEmail>\n  <description>Public PKCE-only client for authorizing TuBot self-org Salesforce API access.</description>\n  <distributionState>Local</distributionState>\n  <isProtected>false</isProtected>\n  <label>${label}</label>\n</ExternalClientApplication>\n`;
  const oauth = `<?xml version="1.0" encoding="UTF-8"?>\n<ExtlClntAppOauthSettings xmlns="http://soap.sforce.com/2006/04/metadata">\n  <commaSeparatedOauthScopes>Api, OpenID, RefreshToken</commaSeparatedOauthScopes>\n  <externalClientApplication>${APP_NAME}</externalClientApplication>\n  <label>${label} OAuth</label>\n</ExtlClntAppOauthSettings>\n`;
  const globalOauth = `<?xml version="1.0" encoding="UTF-8"?>\n<ExtlClntAppGlobalOauthSettings xmlns="http://soap.sforce.com/2006/04/metadata">\n  <callbackUrl>${xml(callbackUrl)}</callbackUrl>\n  <externalClientApplication>${APP_NAME}</externalClientApplication>\n  <isClientCredentialsFlowEnabled>false</isClientCredentialsFlowEnabled>\n  <isConsumerSecretOptional>true</isConsumerSecretOptional>\n  <isIntrospectAllTokens>false</isIntrospectAllTokens>\n  <isPkceRequired>true</isPkceRequired>\n  <isSecretRequiredForRefreshToken>false</isSecretRequiredForRefreshToken>\n  <isSecretRequiredForTokenExchange>false</isSecretRequiredForTokenExchange>\n  <label>${label} Global OAuth</label>\n  <shouldRotateConsumerKey>false</shouldRotateConsumerKey>\n  <shouldRotateConsumerSecret>false</shouldRotateConsumerSecret>\n</ExtlClntAppGlobalOauthSettings>\n`;
  const settings = `<?xml version="1.0" encoding="UTF-8"?>\n<ExternalClientAppSettings xmlns="http://soap.sforce.com/2006/04/metadata">\n  <enableClientSecretInRestApiAccess>false</enableClientSecretInRestApiAccess>\n</ExternalClientAppSettings>\n`;
  return new Map([
    [`externalClientApps/${APP_NAME}.eca-meta.xml`, eca],
    [`extlClntAppOauthSettings/${APP_NAME}_OAuth.ecaOauth-meta.xml`, oauth],
    [`extlClntAppGlobalOauthSets/${APP_NAME}_Global.ecaGlblOauth-meta.xml`, globalOauth],
    ["settings/ExternalClientApp.settings-meta.xml", settings],
  ]);
}

async function writeTemporaryProject(tempDir, files, apiVersion) {
  const project = {
    packageDirectories: [{ path: "force-app", default: true }],
    name: "tubot-self-org-oauth-bootstrap",
    namespace: "",
    sfdcLoginUrl: "https://login.salesforce.com",
    sourceApiVersion: apiVersion,
  };
  const projectPath = path.join(tempDir, "sfdx-project.json");
  await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, { mode: 0o600 });
  await chmod(projectPath, 0o600);
  const sourceRoot = path.join(tempDir, "force-app", "main", "default");
  for (const [relativePath, content] of files) {
    const filePath = path.join(sourceRoot, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, content, { mode: 0o600 });
    await chmod(filePath, 0o600);
  }
  return sourceRoot;
}

async function getOrgDetails(targetOrg, apiVersion, contactEmail, configSchema) {
  const apex = `System.debug('SELF_ORG_URL=' + Url.getOrgDomainUrl().toExternalForm());\n` +
    `System.debug('SELF_ORG_ID=' + UserInfo.getOrganizationId());\n` +
    `System.debug('SELF_ORG_EMAIL=' + UserInfo.getUserEmail());\n` +
    `${configSchema.objectApiName} settings = ${configSchema.objectApiName}.getOrgDefaults();\n` +
    `System.debug('PANEL_BASE_URL=' + (settings == null ? '' : settings.${configSchema.panelBaseUrlField}));`;
  const { payload, stdout } = runSf(["apex", "run", "--target-org", targetOrg], { input: apex });
  const all = payload || stdout;
  const orgUrl = extractValue(all, "SELF_ORG_URL");
  const orgId = extractValue(all, "SELF_ORG_ID");
  let panelBase = extractValue(all, "PANEL_BASE_URL");
  let email = contactEmail || extractValue(all, "SELF_ORG_EMAIL");
  let parsedOrgUrl;
  try { parsedOrgUrl = new URL(orgUrl); }
  catch { throw new Error(`The connected org did not return a valid Salesforce My Domain URL (received ${JSON.stringify(orgUrl.slice(0, 120))}).`); }
  if (parsedOrgUrl.protocol !== "https:" || parsedOrgUrl.pathname !== "/" || parsedOrgUrl.search || parsedOrgUrl.hash ||
      (!parsedOrgUrl.hostname.endsWith(".my.salesforce.com") && !parsedOrgUrl.hostname.endsWith(".my.salesforce.mil"))) {
    throw new Error(`The connected org did not return a valid Salesforce My Domain URL (protocol ${parsedOrgUrl.protocol}, host ${parsedOrgUrl.hostname}, path ${parsedOrgUrl.pathname}).`);
  }
  try {
    const url = new URL(panelBase);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw new Error();
    panelBase = url.origin;
  } catch { throw new Error("Panel_Base_URL__c is not configured with an HTTPS origin. Connect Panel first."); }
  if (!/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(orgId)) throw new Error("The connected Salesforce org ID is invalid.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid contact email is required; pass --contact-email to override the Salesforce user email.");
  return { orgUrl, orgId, panelBase, contactEmail: email, apiVersion };
}

async function accessToken(targetOrg) {
  const { payload } = runSf(["org", "auth", "show-access-token", "--target-org", targetOrg]);
  const token = payload?.result?.accessToken;
  if (typeof token !== "string" || token.length < 20) throw new Error("Salesforce CLI did not provide an active org access token.");
  return token;
}

async function salesforceJson(url, token) {
  let response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  } catch { throw new Error("Could not reach the target Salesforce org."); }
  if (!response.ok) throw new Error(`Salesforce returned HTTP ${response.status} for an OAuth metadata request.`);
  try { return await response.json(); } catch { throw new Error("Salesforce returned invalid OAuth metadata."); }
}

async function getConsumerKey({ instanceUrl, apiVersion, token }) {
  const usage = await salesforceJson(`${instanceUrl}/services/data/v${apiVersion}/apps/oauth/usage`, token);
  const app = (usage.apps || []).find(item => item.developerName === APP_NAME);
  if (!app?.identifier) throw new Error(`External Client App ${APP_NAME} was not found after deployment.`);
  // The default credentials response exposes the consumer key. Never request
  // the secret-bearing `part=keyandsecret` representation for this public app.
  const credential = await salesforceJson(
    `${instanceUrl}/services/data/v${apiVersion}/apps/oauth/credentials/${encodeURIComponent(app.identifier)}`, token,
  );
  let clientId = credential.key;
  if (!clientId && Array.isArray(credential.consumers)) clientId = credential.consumers.find(item => item?.key)?.key;
  if (!clientId && Array.isArray(credential.consumers)) {
    const consumer = credential.consumers.find(item => typeof item?.url === "string");
    if (consumer) {
      const consumerUrl = new URL(consumer.url, instanceUrl);
      const expected = new URL(instanceUrl);
      if (consumerUrl.protocol !== "https:" || consumerUrl.origin !== expected.origin ||
          !consumerUrl.pathname.startsWith("/services/data/")) {
        throw new Error("Salesforce returned an unexpected consumer credential URL.");
      }
      const result = await salesforceJson(consumerUrl.toString(), token);
      clientId = result.key;
    }
  }
  if (typeof clientId !== "string" || clientId.length < 8) throw new Error("Salesforce did not return the ECA consumer key.");
  return clientId;
}

function configWriteAnonymousApex(clientId, configSchema) {
  return `${configSchema.objectApiName} settings = ${configSchema.objectApiName}.getOrgDefaults();\n` +
    `Boolean isNew = settings == null || settings.Id == null;\n` +
    `if (isNew) settings = new ${configSchema.objectApiName}(SetupOwnerId = UserInfo.getOrganizationId());\n` +
    `settings.${configSchema.clientIdField} = ${apexLiteral(clientId)};\n` +
    `if (isNew) insert settings; else update settings;\n` +
    `System.debug('SELF_ORG_ECA_CLIENT_ID_SAVED=true');`;
}

function printHelp() {
  console.log(`Provision a PKCE-only Salesforce self-org API client.

Usage:
  bun scripts/setup-self-org-oauth.mjs --target-org <alias>
  bun scripts/setup-self-org-oauth.mjs --target-org <alias> --contact-email admin@example.com
  bun scripts/setup-self-org-oauth.mjs --target-org <alias> --dry-run

This reads Panel_Base_URL__c and the org My Domain from the selected Salesforce org. It never requests,
stores, or prints an ECA client secret. Run it after installing this package.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const configSchema = discoverConfigSchema(options.targetOrg);
  const details = await getOrgDetails(options.targetOrg, options.apiVersion, options.contactEmail, configSchema);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tubot-self-oauth-"));
  try {
    const files = buildMetadata({ panelBaseUrl: details.panelBase, contactEmail: details.contactEmail });
    const sourceRoot = await writeTemporaryProject(tempDir, files, options.apiVersion);
    // This throwaway project has no scratch-org tracking baseline; the payload
    // is limited to this script's dedicated External Client App metadata.
    const deploy = runSf([
      "project", "deploy", "start", "--source-dir", sourceRoot, "--ignore-conflicts",
      "--target-org", options.targetOrg, "--wait", "30", ...(options.dryRun ? ["--dry-run"] : []),
    ], { cwd: tempDir });
    const deployStatus = deploy.payload?.result?.status || deploy.payload?.result?.id || "succeeded";
    console.log(`PKCE External Client App deployment ${options.dryRun ? "validated" : `completed (${deployStatus})`}.`);
    if (options.dryRun) return;

    const token = await accessToken(options.targetOrg);
    const clientId = await getConsumerKey({
      instanceUrl: details.orgUrl,
      apiVersion: options.apiVersion,
      token,
    });
    runSf(["apex", "run", "--target-org", options.targetOrg], {
      input: configWriteAnonymousApex(clientId, configSchema),
    });

    const selectedFields = [configSchema.clientIdField, configSchema.panelTeamIdField].filter(Boolean).join(", ");
    const query = `SELECT ${selectedFields} FROM ${configSchema.objectApiName} WHERE SetupOwnerId = '${details.orgId}' LIMIT 1`;
    const verification = runSf(["data", "query", "--query", query, "--target-org", options.targetOrg]);
    const rows = verification.payload?.result?.records;
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0][configSchema.clientIdField] !== clientId) {
      throw new Error(`Salesforce CLI verification did not find the saved ECA consumer key in ${configSchema.objectApiName}.`);
    }
    console.log(`Verified by Salesforce CLI: the ECA consumer key is saved in ${configSchema.objectApiName}; no client secret was requested.`);
    const panelConnected = configSchema.panelTeamIdField && typeof rows[0][configSchema.panelTeamIdField] === "string" &&
      rows[0][configSchema.panelTeamIdField].trim().length > 0;
    if (panelConnected) {
      console.log("Panel login is already connected. Open Panel Settings and click Connect Salesforce API to authorize this org.");
    } else {
      console.log("Panel login is not connected yet. In Panel Settings, click Connect with Panel and finish login first; then click Connect Salesforce API to authorize this org.");
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

try { await main(); }
catch (error) {
  console.error(`Self-org PKCE setup failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}
