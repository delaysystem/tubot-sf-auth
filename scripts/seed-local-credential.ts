/**
 * Seed the LOCAL auth D1 (wrangler dev -c wrangler.dev.jsonc) with one
 * staging-style channel credential so `listConnectedOrgs()` finds the org.
 *
 * LOCAL-ONLY. The seeded cipher/secret/token values are inert dummies that
 * are NEVER decrypted or sent: Salesforce calls in local dev go through the
 * LOCAL_STATIC_SF_TOKEN bypass (see token() in src/index.ts). Without that
 * bypass set, any decrypt attempt on the dummy fails loudly (AES-GCM).
 *
 * Usage (from tubot-sf-auth/):
 *   bun scripts/seed-local-credential.ts --org sdostainless --team-id d1_kpa2f77be0f5 [--channel-id local-probe]
 *
 * The sf CLI alias resolves instanceUrl + user id live; nothing is hardcoded.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
const args = process.argv.slice(2);
function flag(name: string): string | null {
  const i = args.findIndex((a) => a === name || a.startsWith(name + "="));
  if (i < 0) return null;
  const a = args[i];
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  return args[i + 1] ?? null;
}
const orgAlias = flag("--org");
const teamId = flag("--team-id");
const channelId = flag("--channel-id") ?? "local-probe";
if (!orgAlias || !teamId) {
  console.error("usage: bun scripts/seed-local-credential.ts --org <sf-alias> --team-id <team> [--channel-id <ch>]");
  process.exit(1);
}
async function sh(cmd: string[]): Promise<string> {
  const p = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8",
    env: { ...process.env, SF_TEMP_SHOW_SECRETS: "true" } });
  const out = p.stdout?.toString() ?? "";
  if (p.status !== 0) throw new Error(`${cmd.join(" ")} failed: ${(p.stderr?.toString() ?? "").slice(0, 300)}`);
  return out;
}
// Static-token bypass must be armed or the dummy cipher would meet decrypt().
const devVars = await readFile(".dev.vars", "utf8").catch(() => "");
if (!/^LOCAL_STATIC_SF_TOKEN=.+/m.test(devVars)) {
  console.error("refusing: .dev.vars lacks LOCAL_STATIC_SF_TOKEN (arm the local bypass first)");
  process.exit(1);
}
const dispRaw = await sh(["sf", "org", "display", "--target-org", orgAlias, "--json"]);
const disp = JSON.parse(dispRaw.slice(dispRaw.indexOf("{")));
const orgId: string = disp.result.id;
const instanceUrl: string = new URL(disp.result.instanceUrl).origin;
process.env.SF_TEMP_SHOW_SECRETS = "true";
const disp2Raw = await sh(["sf", "org", "display", "--target-org", orgAlias, "--json"]);
const token: string = JSON.parse(disp2Raw.slice(disp2Raw.indexOf("{"))).result.accessToken;
const meRes = await fetch(`${instanceUrl}/services/oauth2/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
if (!meRes.ok) throw new Error(`userinfo failed: ${meRes.status}`);
const me = (await meRes.json()) as { user_id: string; organization_id: string };
if (me.organization_id !== orgId) throw new Error(`alias ${orgAlias} points at ${me.organization_id}, expected ${orgId}`);
const nowSec = Math.floor(Date.now() / 1000);
const farFuture = nowSec + 10 * 365 * 24 * 3600;
const DUMMY = "LOCAL-DEV-DUMMY-NEVER-DECRYPT";
const stmts = [
  `CREATE TABLE IF NOT EXISTS \`team\` (\`id\` text PRIMARY KEY NOT NULL, \`name\` text(255) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS \`user\` (\`id\` text PRIMARY KEY NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS \`salesforce_auth_credential\` (\`team_id\` text NOT NULL, \`org_id\` text NOT NULL, \`channel_id\` text NOT NULL, \`instance_url\` text NOT NULL, \`client_id\` text NOT NULL, \`client_secret_cipher\` text NOT NULL, \`client_secret_iv\` text NOT NULL, \`integration_user_id\` text NOT NULL, \`channel_secret_hash\` text NOT NULL, \`created_at\` integer NOT NULL, \`updated_at\` integer NOT NULL, PRIMARY KEY (\`team_id\`, \`org_id\`, \`channel_id\`))`,
  `CREATE TABLE IF NOT EXISTS \`salesforce_auth_execution_user\` (\`team_id\` text NOT NULL, \`org_id\` text NOT NULL, \`channel_id\` text NOT NULL, \`instance_url\` text NOT NULL, \`client_id\` text NOT NULL, \`client_secret_cipher\` text NOT NULL, \`client_secret_iv\` text NOT NULL, \`integration_user_id\` text NOT NULL, \`created_at\` integer NOT NULL, \`updated_at\` integer NOT NULL, PRIMARY KEY (\`team_id\`, \`org_id\`, \`channel_id\`, \`integration_user_id\`))`,
  `CREATE TABLE IF NOT EXISTS \`oauth_token\` (\`id\` text PRIMARY KEY NOT NULL, \`accessToken\` text(255) NOT NULL UNIQUE, \`refreshToken\` text(255), \`clientId\` text(120) NOT NULL, \`userId\` text NOT NULL, \`teamId\` text NOT NULL, \`scope\` text(255) NOT NULL DEFAULT 'read write', \`expiresAt\` integer NOT NULL, \`createdAt\` integer NOT NULL, \`updatedAt\` integer NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS \`salesforce_channel_connection\` (\`createdAt\` integer NOT NULL, \`updatedAt\` integer NOT NULL, \`teamId\` text NOT NULL, \`orgId\` text NOT NULL, \`channelId\` text NOT NULL, \`oauthTokenId\` text NOT NULL, \`channelSecretHash\` text NOT NULL, \`channelSecretCipher\` text NOT NULL, \`channelSecretIv\` text NOT NULL, PRIMARY KEY (\`teamId\`, \`orgId\`, \`channelId\`))`,
  `INSERT INTO \`team\` (\`id\`, \`name\`) VALUES ('${teamId}', 'local-probe') ON CONFLICT(\`id\`) DO NOTHING`,
  `INSERT INTO \`user\` (\`id\`) VALUES ('local-probe-user') ON CONFLICT(\`id\`) DO NOTHING`,
  `DELETE FROM \`salesforce_channel_connection\` WHERE \`teamId\`='${teamId}' AND \`orgId\`='${orgId}' AND \`channelId\`='${channelId}'`,
  `DELETE FROM \`oauth_token\` WHERE \`id\`='local-probe-token'`,
  `DELETE FROM \`salesforce_auth_execution_user\` WHERE \`team_id\`='${teamId}' AND \`org_id\`='${orgId}' AND \`channel_id\`='${channelId}'`,
  `DELETE FROM \`salesforce_auth_credential\` WHERE \`team_id\`='${teamId}' AND \`org_id\`='${orgId}' AND \`channel_id\`='${channelId}'`,
  `INSERT INTO \`salesforce_auth_credential\` (\`team_id\`,\`org_id\`,\`channel_id\`,\`instance_url\`,\`client_id\`,\`client_secret_cipher\`,\`client_secret_iv\`,\`integration_user_id\`,\`channel_secret_hash\`,\`created_at\`,\`updated_at\`) VALUES ('${teamId}','${orgId}','${channelId}','${instanceUrl}','${DUMMY}','${DUMMY}','${DUMMY}','${me.user_id}','${DUMMY}-hash',${nowSec},${nowSec})`,
  `INSERT INTO \`salesforce_auth_execution_user\` (\`team_id\`,\`org_id\`,\`channel_id\`,\`instance_url\`,\`client_id\`,\`client_secret_cipher\`,\`client_secret_iv\`,\`integration_user_id\`,\`created_at\`,\`updated_at\`) VALUES ('${teamId}','${orgId}','${channelId}','${instanceUrl}','${DUMMY}','${DUMMY}','${DUMMY}','${me.user_id}',${nowSec},${nowSec})`,
  `INSERT INTO \`oauth_token\` (\`id\`,\`accessToken\`,\`clientId\`,\`userId\`,\`teamId\`,\`expiresAt\`,\`createdAt\`,\`updatedAt\`) VALUES ('local-probe-token','${DUMMY}-token','${DUMMY}','local-probe-user','${teamId}',${farFuture},${nowSec},${nowSec})`,
  `INSERT INTO \`salesforce_channel_connection\` (\`createdAt\`,\`updatedAt\`,\`teamId\`,\`orgId\`,\`channelId\`,\`oauthTokenId\`,\`channelSecretHash\`,\`channelSecretCipher\`,\`channelSecretIv\`) VALUES (${nowSec},${nowSec},'${teamId}','${orgId}','${channelId}','local-probe-token','${DUMMY}-hash','${DUMMY}','${DUMMY}')`,
];
for (const s of stmts) {
  await sh(["bun", "x", "wrangler", "d1", "execute", "agent-dashboard-db-staging",
    "-c", "wrangler.dev.jsonc", "--local", "--command", s]);
}
// Verify with the same join listConnectedOrgs uses (IDs only, never secrets).
const verify = await sh(["bun", "x", "wrangler", "d1", "execute", "agent-dashboard-db-staging",
  "-c", "wrangler.dev.jsonc", "--local", "--command",
  `SELECT c.teamId AS teamId, c.orgId AS orgId, MIN(c.channelId) AS channelId FROM salesforce_channel_connection c JOIN oauth_token t ON t.id = c.oauthTokenId AND t.teamId = c.teamId JOIN salesforce_auth_credential a ON a.team_id = c.teamId AND a.org_id = c.orgId AND a.channel_id = c.channelId AND a.channel_secret_hash = c.channelSecretHash WHERE t.expiresAt > unixepoch() GROUP BY c.teamId, c.orgId`]);
console.log("connected-orgs:", verify.slice(verify.indexOf("["), verify.indexOf("]") + 1));
console.log(`seeded local credential: team=${teamId} org=${orgId} channel=${channelId} sfUser=${me.user_id}`);
