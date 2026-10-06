#!/usr/bin/env bun
import { spawnSync } from "child_process";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateRandomState,
  encryptSession,
} from "../../../tubot-new-panel/worker/kinde";

const PANEL_BASE_URL = "https://tubot-new-panel.emalteaproductions.workers.dev";
const SESSION_SECRET = "b7f8e3a2d1c94b5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e";
const TARGET_ORG = "tubot-scratch";

async function main() {
  console.log("=== End-to-End Live Scratch Org OAuth Verification ===");
  console.log(`Panel URL: ${PANEL_BASE_URL}`);
  console.log(`Target Scratch Org: ${TARGET_ORG}`);

  // 1. Generate PKCE params
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = generateRandomState();
  const redirectUri = `${PANEL_BASE_URL}/oauth/callback`;
  const clientId = "pnl_client_salesforce_mcp";

  console.log(`Generated PKCE S256 Challenge: ${challenge}`);
  console.log(`State: ${state}`);

  // 2. Authorize via tubot-new-panel with an authenticated session
  const sessionData = {
    user: {
      id: "usr_sf_admin_live",
      email: "live-admin@tubot.lat",
      given_name: "TuBot",
      family_name: "Admin",
    },
    activeOrg: {
      id: "org_tubot_prod_ws",
      name: "TuBot Enterprise Live Org",
      type: "kinde_org",
    },
    availableOrgs: [
      {
        id: "org_tubot_prod_ws",
        name: "TuBot Enterprise Live Org",
        type: "kinde_org",
      },
    ],
    expiresAt: Date.now() + 86400 * 1000,
  };

  const sessionCookie = await encryptSession(sessionData, SESSION_SECRET);

  console.log("Requesting authorization code from tubot-new-panel /api/oauth/authorize...");
  const authRes = await fetch(`${PANEL_BASE_URL}/api/oauth/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `kinde_session=${sessionCookie}`,
    },
    body: JSON.stringify({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "read write",
      team_id: "org_tubot_prod_ws",
    }),
  });

  if (!authRes.ok) {
    const errText = await authRes.text();
    throw new Error(`Failed to authorize: HTTP ${authRes.status}: ${errText}`);
  }

  const authData = await authRes.json();
  console.log(`✔ Received one-time Authorization Code: ${authData.code}`);
  const authCode = authData.code;

  // 3. Execute Exchange in Scratch Org via Apex Controller
  console.log("Executing tubot.PanelAuthController.exchangeOAuthCode in tubot-scratch...");
  const apexExchangeCode = `
Map<String, String> params = new Map<String, String>{
    'code' => '${authCode}',
    'redirectUri' => '${redirectUri}',
    'codeVerifier' => '${verifier}',
    'panelBaseUrl' => '${PANEL_BASE_URL}'
};
Map<String, Object> result = tubot.PanelAuthController.exchangeOAuthCode(JSON.serialize(params));
System.debug('EXCHANGE_RESULT:' + JSON.serialize(result));
`;

  const apexRes = spawnSync("sf", ["apex", "run", "--target-org", TARGET_ORG], {
    input: apexExchangeCode,
    encoding: "utf-8",
  });

  if (apexRes.status !== 0 || !apexRes.stdout.includes("EXCHANGE_RESULT:")) {
    console.error("Apex exchange execution failed:\n", apexRes.stderr || apexRes.stdout);
    process.exit(1);
  }

  const match = apexRes.stdout.match(/EXCHANGE_RESULT:(.+)/);
  const resultJson = match ? match[1].trim() : "{}";
  console.log("✔ Apex Exchange Result:", resultJson);

  // 4. Query MCP_Config__c custom setting from scratch org to blind-verify saved status
  console.log("\nBlind-verifying saved custom setting in tubot-scratch via SOQL CLI...");
  const soqlRes = spawnSync("sf", [
    "data", "query",
    "--target-org", TARGET_ORG,
    "--query", "SELECT Id, tubot__Panel_Base_URL__c, tubot__Panel_User_Email__c, tubot__Panel_User_Role__c, tubot__Panel_Team_Id__c, tubot__Panel_Team_Name__c, tubot__Panel_Permissions__c FROM tubot__MCP_Config__c LIMIT 1",
    "--json",
  ], { encoding: "utf-8" });

  if (soqlRes.status !== 0) {
    console.error("SOQL query failed:\n", soqlRes.stderr || soqlRes.stdout);
    process.exit(1);
  }

  const soqlData = JSON.parse(soqlRes.stdout);
  const record = soqlData.result?.records?.[0];
  console.log("✔ Ground Truth from tubot-scratch Database:");
  console.log("  Panel Base URL :", record.tubot__Panel_Base_URL__c);
  console.log("  User Email     :", record.tubot__Panel_User_Email__c);
  console.log("  User Role      :", record.tubot__Panel_User_Role__c);
  console.log("  Team ID        :", record.tubot__Panel_Team_Id__c);
  console.log("  Team Name      :", record.tubot__Panel_Team_Name__c);
  console.log("  Permissions    :", record.tubot__Panel_Permissions__c);

  if (
    record.tubot__Panel_User_Email__c === "live-admin@tubot.lat" &&
    record.tubot__Panel_Team_Id__c === "org_tubot_prod_ws" &&
    record.tubot__Panel_Base_URL__c === PANEL_BASE_URL
  ) {
    console.log("\n🎉 ALL LIVE BLIND-VERIFICATION CHECKS PASSED!");
  } else {
    throw new Error("Mismatched data in tubot__MCP_Config__c!");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
