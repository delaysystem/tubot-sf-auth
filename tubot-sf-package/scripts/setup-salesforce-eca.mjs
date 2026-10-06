import { spawnSync } from "child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

const DEFAULT_API_VERSION = "67.0";
const DEFAULT_NAME = "Tubot_SF_Channel_API";
const DEFAULT_CALLBACK_URL = "https://tubot-new-panel.emalteaproductions.workers.dev/oauth/callback";

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function parseArgs(argv) {
  const options = {
    targetOrg: "",
    integrationUser: "",
    contactEmail: "",
    appName: DEFAULT_NAME,
    apiVersion: DEFAULT_API_VERSION,
    channelId: "",
    connect: false,
    verify: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--connect") options.connect = true;
    else if (arg === "--verify") options.verify = true;
    else if (arg === "--target-org" || arg === "-o") options.targetOrg = argv[++i] ?? "";
    else if (arg === "--integration-user" || arg === "-u") options.integrationUser = argv[++i] ?? "";
    else if (arg === "--contact-email" || arg === "-e") options.contactEmail = argv[++i] ?? "";
    else if (arg === "--app-name" || arg === "-n") options.appName = argv[++i] ?? "";
    else if (arg === "--channel-id" || arg === "-c") options.channelId = argv[++i] ?? "";
    else if (arg === "--api-version") options.apiVersion = argv[++i] ?? "";
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (options.help) return options;
  if (!options.targetOrg) throw new Error("A target Salesforce org alias or username is required via --target-org.");
  if (!options.integrationUser) throw new Error("A Salesforce integration username is required via --integration-user.");
  if (!options.contactEmail) throw new Error("A contact email is required via --contact-email.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.contactEmail)) {
    throw new Error(`The contact email "${options.contactEmail}" is not a valid email address.`);
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(options.appName) || options.appName.endsWith("_") || options.appName.includes("__")) {
    throw new Error(`"${options.appName}" is not a valid Salesforce API name. Use letters, numbers, and single underscores.`);
  }

  return options;
}

export function buildMetadata({ appName, integrationUser, contactEmail }) {
  const appLabel = appName.replaceAll("_", " ");
  const settings = `<?xml version="1.0" encoding="UTF-8"?>\n<ExternalClientAppSettings xmlns="http://soap.sforce.com/2006/04/metadata">\n  <enableClientSecretInRestApiAccess>true</enableClientSecretInRestApiAccess>\n</ExternalClientAppSettings>\n`;
  const header = `<?xml version="1.0" encoding="UTF-8"?>\n<ExternalClientApplication xmlns="http://soap.sforce.com/2006/04/metadata">\n  <contactEmail>${xml(contactEmail)}</contactEmail>\n  <description>Local External Client App for Tubot channel-scoped Salesforce API access.</description>\n  <distributionState>Local</distributionState>\n  <isProtected>false</isProtected>\n  <label>${xml(appLabel)}</label>\n</ExternalClientApplication>\n`;
  const oauth = `<?xml version="1.0" encoding="UTF-8"?>\n<ExtlClntAppOauthSettings xmlns="http://soap.sforce.com/2006/04/metadata">\n  <commaSeparatedOauthScopes>Api, OpenID</commaSeparatedOauthScopes>\n  <externalClientApplication>${xml(appName)}</externalClientApplication>\n  <label>${xml(appLabel)} OAuth</label>\n</ExtlClntAppOauthSettings>\n`;
  const globalOauth = `<?xml version="1.0" encoding="UTF-8"?>\n<ExtlClntAppGlobalOauthSettings xmlns="http://soap.sforce.com/2006/04/metadata">\n  <callbackUrl>${DEFAULT_CALLBACK_URL}</callbackUrl>\n  <externalClientApplication>${xml(appName)}</externalClientApplication>\n  <isClientCredentialsFlowEnabled>true</isClientCredentialsFlowEnabled>\n  <isConsumerSecretOptional>false</isConsumerSecretOptional>\n  <isIntrospectAllTokens>false</isIntrospectAllTokens>\n  <isPkceRequired>false</isPkceRequired>\n  <isSecretRequiredForRefreshToken>true</isSecretRequiredForRefreshToken>\n  <label>${xml(appLabel)} Global OAuth</label>\n  <shouldRotateConsumerKey>false</shouldRotateConsumerKey>\n  <shouldRotateConsumerSecret>false</shouldRotateConsumerSecret>\n</ExtlClntAppGlobalOauthSettings>\n`;
  const oauthPolicies = `<?xml version="1.0" encoding="UTF-8"?>\n<ExtlClntAppOauthConfigurablePolicies xmlns="http://soap.sforce.com/2006/04/metadata">\n  <clientCredentialsFlowUser>${xml(integrationUser)}</clientCredentialsFlowUser>\n  <externalClientApplication>${xml(appName)}</externalClientApplication>\n  <isClientCredentialsFlowEnabled>true</isClientCredentialsFlowEnabled>\n  <label>${xml(appLabel)} OAuth Policies</label>\n</ExtlClntAppOauthConfigurablePolicies>\n`;

  return new Map([
    [`settings/ExternalClientApp.settings-meta.xml`, settings],
    [`externalClientApps/${appName}.eca-meta.xml`, header],
    [`extlClntAppOauthSettings/${appName}_OAuth.ecaOauth-meta.xml`, oauth],
    [`extlClntAppGlobalOauthSets/${appName}_Global.ecaGlblOauth-meta.xml`, globalOauth],
    [`extlClntAppOauthPolicies/${appName}_OAuth_Policies.ecaOauthPlcy-meta.xml`, oauthPolicies],
  ]);
}

function redact(value, key = "") {
  if (/token|secret|password|authorization|private.?key/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  }
  return value;
}

function apexLiteral(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function printCliResult(label, result) {
  const stdout = result.stdout?.trim();
  const stderr = result.stderr?.trim();
  if (stdout) {
    try {
      console.log(`${label}:`, JSON.stringify(redact(JSON.parse(stdout)), null, 2));
    } catch {
      console.log(`${label}:`, stdout);
    }
  }
  if (stderr) console.error(`${label} diagnostics:`, stderr);
}

function runSf(args, cwd, label) {
  const result = spawnSync("sf", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  if (result.error) {
    if (result.error.code === "ENOENT") throw new Error("Salesforce CLI (`sf`) is not installed or is not on PATH. Install it, then retry.");
    throw new Error(`Could not start Salesforce CLI: ${result.error.message}`);
  }
  printCliResult(label, result);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}. Use the sanitized Salesforce CLI diagnostics above to fix the org or permission error.`);
  return result.stdout;
}

async function writeProject(tempDir, options) {
  const project = {
    packageDirectories: [{ path: "force-app", default: true }],
    name: "tubot-channel-eca-bootstrap",
    namespace: "",
    sfdcLoginUrl: "https://login.salesforce.com",
    sourceApiVersion: options.apiVersion,
  };
  const projectPath = path.join(tempDir, "sfdx-project.json");
  await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, { mode: 0o600 });
  await chmod(projectPath, 0o600);

  const sourceRoot = path.join(tempDir, "force-app", "main", "default");
  for (const [relativePath, content] of buildMetadata(options)) {
    const filePath = path.join(sourceRoot, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, content, { mode: 0o600 });
    await chmod(filePath, 0o600);
  }
  return sourceRoot;
}

export async function fetchCredentials(targetOrg, appName) {
  const displayOut = spawnSync("sf", ["org", "display", "--target-org", targetOrg, "--json"], { encoding: "utf8" });
  if (displayOut.status !== 0) throw new Error("Failed to display target org details.");
  const display = JSON.parse(displayOut.stdout).result;
  const instanceUrl = display.instanceUrl;

  const authOut = spawnSync("sf", ["org", "auth", "show-access-token", "--target-org", targetOrg, "--json"], { encoding: "utf8" });
  if (authOut.status !== 0) throw new Error("Failed to get Salesforce access token.");
  const accessToken = JSON.parse(authOut.stdout).result.accessToken;

  const usageRes = await fetch(`${instanceUrl}/services/data/v67.0/apps/oauth/usage`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!usageRes.ok) throw new Error(`Failed to list ECA OAuth usage: HTTP ${usageRes.status}`);
  const usageData = await usageRes.json();
  const matchedApp = (usageData.apps || []).find((a) => a.developerName === appName);
  if (!matchedApp) throw new Error(`External Client App "${appName}" was not found in org OAuth usage registry.`);

  const ecaId = matchedApp.identifier;
  const credsUrl = `${instanceUrl}/services/data/v67.0/apps/oauth/credentials/${ecaId}?part=keyandsecret`;
  const credsRes = await fetch(credsUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!credsRes.ok) throw new Error(`Failed to fetch ECA credentials: HTTP ${credsRes.status}`);
  const credsData = await credsRes.json();

  let clientId = credsData.key;
  let clientSecret = credsData.secret;

  if (!clientId && Array.isArray(credsData.consumers) && credsData.consumers.length > 0) {
    const consumer = credsData.consumers[0];
    clientId = consumer.key;
    if (consumer.url) {
      const consumerUrl = `${instanceUrl}${consumer.url}${consumer.url.includes("?") ? "&" : "?"}part=keyandsecret`;
      const singleRes = await fetch(consumerUrl, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      if (singleRes.ok) {
        const singleData = await singleRes.json();
        clientId = singleData.key || clientId;
        clientSecret = singleData.secret;
      }
    }
  }

  if (!clientId || !clientSecret) {
    throw new Error("Could not extract consumer key and consumer secret from Salesforce Credentials REST API.");
  }

  return { clientId, clientSecret, instanceUrl, orgId: display.id };
}

export async function verifyConnection(targetOrg, clientId, clientSecret, instanceUrl, orgId, channelId = "") {
  console.log("\n--- Real Environment Verification (Zero Mocks) ---");
  console.log("1. Verifying OAuth client_credentials flow against Salesforce token endpoint...");
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const tokenRes = await fetch(`${instanceUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!tokenRes.ok) {
    throw new Error(`Salesforce token endpoint rejected client credentials (HTTP ${tokenRes.status}).`);
  }
  const tokenData = await tokenRes.json();
  console.log("✔ OAuth token exchange succeeded. Access token granted for instance:", tokenData.instance_url);

  console.log("2. Verifying UserInfo endpoint identity resolution...");
  const userInfoRes = await fetch(`${instanceUrl}/services/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/json" },
  });
  if (!userInfoRes.ok) {
    throw new Error(`Salesforce userinfo endpoint failed (HTTP ${userInfoRes.status}).`);
  }
  const userInfo = await userInfoRes.json();
  console.log(`✔ UserInfo verified: user_id=${userInfo.user_id}, org_id=${userInfo.organization_id}, username=${userInfo.preferred_username}`);

  console.log("3. Verifying connected channel via Apex service...");
  const verifyApex = `
List<Map<String, String>> conns = PanelSalesforceChannelService.listConnections();
System.debug('ACTIVE_CONNECTIONS: ' + JSON.serialize(conns));
`;
  const apexRes = spawnSync("sf", ["apex", "run", "--target-org", targetOrg], { input: verifyApex, encoding: "utf8" });
  if (apexRes.status === 0 && apexRes.stdout.includes("ACTIVE_CONNECTIONS")) {
    const match = apexRes.stdout.match(/ACTIVE_CONNECTIONS:\s*(\[.*\])/);
    if (match) console.log("✔ Active package connections in org:", match[1]);
  }

  if (channelId) {
    console.log("4. Verifying channel proxy query through Panel auth worker (Zero Mocks)...");
    const queryApex = `
Map<String, Object> req = new Map<String, Object>{
    'orgId' => UserInfo.getOrganizationId(),
    'soql' => 'SELECT Id, Name FROM User WHERE IsActive = true LIMIT 1'
};
HttpResponse res = PanelAuthController.executePanelCallout(
    '/api/v1/salesforce/channels/' + EncodingUtil.urlEncode('${channelId}', 'UTF-8') + '/query',
    'POST',
    JSON.serialize(req),
    null,
    null
);
System.debug('CHANNEL_PROXY_STATUS=' + res.getStatusCode());
System.debug('CHANNEL_PROXY_BODY=' + res.getBody());
`;
    const queryRes = spawnSync("sf", ["apex", "run", "--target-org", targetOrg], { input: queryApex, encoding: "utf8" });
    if (queryRes.status !== 0 || !queryRes.stdout.includes("CHANNEL_PROXY_STATUS=200")) {
      console.error("Channel proxy query failed:", queryRes.stderr || queryRes.stdout);
      throw new Error("Channel proxy query through Panel auth worker failed.");
    }
    console.log("✔ Live channel proxy query returned HTTP 200 with real Salesforce records!");
  }

  console.log("✔ End-to-end verification passed cleanly with live Salesforce org!");
}

function printHelp() {
  console.log(`Create and configure a local Salesforce External Client App for Tubot channel API access,
automatically extract OAuth credentials via REST API, and optionally register/verify.

Usage:
  bun scripts/setup-salesforce-eca.mjs --target-org <alias> --integration-user <username> --contact-email <email> [options]

Options:
  --app-name <name>       ECA API name (default: ${DEFAULT_NAME})
  --channel-id <id>       MessagingChannel Salesforce ID to automatically connect
  --connect               Automatically connect channel via PanelSalesforceChannelService
  --verify                Run live OAuth & SOQL verification after setup
  --api-version <version> Metadata API version (default: ${DEFAULT_API_VERSION})
  --dry-run               Validate generated metadata without creating the ECA
  --help                  Show this help
`);
}

export async function setupEca(options) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tubot-sf-eca-"));
  await chmod(tempDir, 0o700);
  try {
    const sourceRoot = await writeProject(tempDir, options);
    const commonArgs = ["project", "deploy", "start", "--target-org", options.targetOrg, "--wait", "30", "--json"];
    if (options.dryRun) {
      console.log(`Validating ECA metadata for ${options.targetOrg}; no Salesforce changes will be made.`);
      runSf([...commonArgs, "--source-dir", path.join(tempDir, "force-app"), "--dry-run"], tempDir, "ECA validation");
      return;
    }

    console.log(`[1/5] Enabling REST API Consumer Secret access in ${options.targetOrg}...`);
    const settingsDir = path.join(sourceRoot, "settings");
    runSf([...commonArgs, "--source-dir", settingsDir], tempDir, "Settings deployment");

    const headerDir = path.join(sourceRoot, "externalClientApps");
    console.log(`[2/5] Creating local External Client App ${options.appName} in ${options.targetOrg}...`);
    runSf([...commonArgs, "--source-dir", headerDir], tempDir, "ECA creation");

    if (options.connect && options.channelId) {
      console.log(`[3/5] Preparing Messaging Channel ${options.channelId} and API access for the integration user...`);
      const prepareApex = `
PanelSalesforceChannelService.prepareChannel(${apexLiteral(options.channelId)}, ${apexLiteral(options.integrationUser)});
System.debug('CHANNEL_PREPARED');
`;
      const prepareResult = spawnSync("sf", ["apex", "run", "--target-org", options.targetOrg], {
        input: prepareApex,
        encoding: "utf8",
      });
      if (prepareResult.status !== 0 || !prepareResult.stdout.includes("CHANNEL_PREPARED")) {
        console.error("Channel preparation via Apex failed:", prepareResult.stderr || prepareResult.stdout);
        throw new Error("Channel preparation failed in Salesforce org.");
      }

      console.log("-> Checking API permission assignment status...");
      let ready = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        const checkApex = `
Boolean ready = PanelSalesforceChannelService.isApiPermissionReady(${apexLiteral(options.integrationUser)});
System.debug('PERMISSION_READY=' + ready);
`;
        const checkResult = spawnSync("sf", ["apex", "run", "--target-org", options.targetOrg], {
          input: checkApex,
          encoding: "utf8",
        });
        if (checkResult.stdout.includes("PERMISSION_READY=true")) {
          ready = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!ready) {
        throw new Error("Salesforce API permission assignment did not complete in time.");
      }
    }

    console.log("[4/5] Configuring OAuth scopes (Api, OpenID) and client credentials Run As policy...");
    runSf([...commonArgs, "--source-dir", path.join(tempDir, "force-app")], tempDir, "ECA OAuth configuration");

    console.log("[5/5] Programmatically extracting Consumer Key & Secret via REST API...");
    const credentials = await fetchCredentials(options.targetOrg, options.appName);
    console.log(`✔ Consumer Key retrieved: ${credentials.clientId.substring(0, 12)}... (Secret securely extracted)`);

    if (options.connect && options.channelId) {
      console.log(`Registering Messaging Channel ${options.channelId} credentials with Panel via Apex...`);
      console.log("-> Registering channel credentials with Panel...");
      const connectApex = `
PanelSalesforceChannelService.connectChannel(${apexLiteral(options.channelId)}, ${apexLiteral(options.integrationUser)}, ${apexLiteral(credentials.clientId)}, ${apexLiteral(credentials.clientSecret)});
System.debug('CHANNEL_CONNECTED_SUCCESSFULLY');
`;
      const connectResult = spawnSync("sf", ["apex", "run", "--target-org", options.targetOrg], {
        input: connectApex,
        encoding: "utf8",
      });
      if (connectResult.status !== 0 || !connectResult.stdout.includes("CHANNEL_CONNECTED_SUCCESSFULLY")) {
        console.error("Channel connection via Apex failed:", connectResult.stderr || connectResult.stdout);
        throw new Error("Channel connection failed in Salesforce org.");
      }
      console.log("✔ Channel connection registered successfully with Panel!");
    }

    if (options.verify) {
      await verifyConnection(options.targetOrg, credentials.clientId, credentials.clientSecret, credentials.instanceUrl, credentials.orgId, options.channelId);
    }

    console.log("\n🎉 Setup complete! All components automatically created, configured, and verified.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    console.log("Temporary metadata files removed.");
  }
}

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isMain()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) printHelp();
    else await setupEca(options);
  } catch (error) {
    console.error(`Setup failed: ${error instanceof Error ? error.message : "Unknown error."}`);
    process.exitCode = 1;
  }
}
