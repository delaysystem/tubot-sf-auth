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
  console.log("=== End-to-End Live Token Exchange & Named Credential Test ===");

  // 1. Authorize on tubot-new-panel
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = generateRandomState();
  const redirectUri = `${PANEL_BASE_URL}/oauth/callback`;
  const clientId = "pnl_client_salesforce_mcp";

  const sessionCookie = await encryptSession({
    user: { id: "usr_sf_tester", email: "salesforce-admin@example.com", given_name: "Salesforce", family_name: "Tester" },
    activeOrg: { id: "org_scratch_ws", name: "Scratch Org Workspace", type: "kinde_org" },
    availableOrgs: [{ id: "org_scratch_ws", name: "Scratch Org Workspace", type: "kinde_org" }],
    expiresAt: Date.now() + 86400 * 1000,
  }, SESSION_SECRET);

  const authRes = await fetch(`${PANEL_BASE_URL}/api/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `kinde_session=${sessionCookie}` },
    body: JSON.stringify({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "read write",
      team_id: "org_scratch_ws",
    }),
  });

  const authData = await authRes.json();
  console.log("✔ Created Authorization Code:", authData.code);

  // 2. Exchange Code for Access Token on tubot-new-panel
  const tokenRes = await fetch(`${PANEL_BASE_URL}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: authData.code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  const tokenData = await tokenRes.json();
  console.log("✔ Token Exchange Success! Token:", tokenData.access_token);
  const accessToken = tokenData.access_token;

  // 3. Store Token in Salesforce External Credential in tubot-scratch
  console.log("Patching token into Salesforce External Credential in tubot-scratch...");
  const patchApex = `
ConnectApi.CredentialInput input = new ConnectApi.CredentialInput();
input.externalCredential = 'Panel_External_Credential';
input.principalName = 'Panel_Principal';
input.principalType = ConnectApi.CredentialPrincipalType.NamedPrincipal;
ConnectApi.CredentialValueInput token = new ConnectApi.CredentialValueInput();
token.value = '${accessToken}';
token.encrypted = true;
input.credentials = new Map<String, ConnectApi.CredentialValueInput>{ 'token' => token };
try {
    ConnectApi.NamedCredentials.patchCredential(input);
} catch (Exception e) {
    ConnectApi.NamedCredentials.createCredential(input);
}
System.debug('PATCH_LIVE_TOKEN_SUCCESS');
`;

  const patchRes = spawnSync("sf", ["apex", "run", "--target-org", TARGET_ORG], {
    input: patchApex,
    encoding: "utf-8",
  });

  if (patchRes.status !== 0 || !patchRes.stdout.includes("PATCH_LIVE_TOKEN_SUCCESS")) {
    console.error("Failed to patch token into scratch org:\n", patchRes.stderr || patchRes.stdout);
    process.exit(1);
  }
  console.log("✔ External Credential successfully patched with live token!");

  // 4. Perform authenticated Named Credential callout to /api/v1/subscription and /api/v1/user
  console.log("Executing callouts to /api/v1/subscription and /api/v1/user from tubot-scratch...");
  const calloutApex = `
HttpRequest reqSub = new HttpRequest();
reqSub.setEndpoint('callout:tubot__Panel_Named_Credential/api/v1/subscription');
reqSub.setMethod('GET');
HttpResponse resSub = new Http().send(reqSub);
System.debug('SUBSCRIPTION_STATUS:' + resSub.getStatusCode());
System.debug('SUBSCRIPTION_BODY:' + resSub.getBody());

HttpRequest reqUser = new HttpRequest();
reqUser.setEndpoint('callout:tubot__Panel_Named_Credential/api/v1/user');
reqUser.setMethod('GET');
HttpResponse resUser = new Http().send(reqUser);
System.debug('USER_STATUS:' + resUser.getStatusCode());
System.debug('USER_BODY:' + resUser.getBody());
`;

  const calloutRes = spawnSync("sf", ["apex", "run", "--target-org", TARGET_ORG], {
    input: calloutApex,
    encoding: "utf-8",
  });

  if (calloutRes.status !== 0) {
    console.error("Callout failed:\n", calloutRes.stderr || calloutRes.stdout);
    process.exit(1);
  }

  const subStatus = calloutRes.stdout.match(/\|USER_DEBUG\|.*\|DEBUG\|SUBSCRIPTION_STATUS:(\d+)/)?.[1] ||
                    calloutRes.stdout.match(/SUBSCRIPTION_STATUS:(\d+)/)?.[1];
  const subBody = calloutRes.stdout.match(/\|USER_DEBUG\|.*\|DEBUG\|SUBSCRIPTION_BODY:(.+)/)?.[1];
  const userStatus = calloutRes.stdout.match(/\|USER_DEBUG\|.*\|DEBUG\|USER_STATUS:(\d+)/)?.[1] ||
                     calloutRes.stdout.match(/USER_STATUS:(\d+)/)?.[1];
  const userBody = calloutRes.stdout.match(/\|USER_DEBUG\|.*\|DEBUG\|USER_BODY:(.+)/)?.[1];

  console.log("✔ /api/v1/subscription HTTP Status:", subStatus);
  console.log("✔ /api/v1/subscription Response   :", subBody);
  console.log("✔ /api/v1/user HTTP Status        :", userStatus);
  console.log("✔ /api/v1/user Response           :", userBody);

  if (subStatus === "200" && userStatus === "200" && subBody.includes('"pro"')) {
    console.log("\n🎯🎯 FULL END-TO-END OAUTH AUTHENTICATION & TARGET VERIFICATION PASSED! 🎯🎯");
  } else {
    throw new Error("Verification failed: unexpected responses from worker");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
