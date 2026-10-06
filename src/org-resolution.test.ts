import { expect, test } from "bun:test";
import worker, { type AuthEnv, type Credential } from "./index";

const secret = "channel-secret-for-org-resolution-test";
const channelId = "0Mjg00000000001AAA";
const teamId = "team-org-resolution-test";
const orgId = "00D000000000001AAA";
const encoder = new TextEncoder();

async function secretHash(value: string): Promise<string> {
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fixture(hash: string) {
  const row: Credential = {
    team_id: teamId,
    org_id: orgId,
    channel_id: channelId,
    instance_url: "https://tenant.my.salesforce.com",
    client_id: "client",
    client_secret_cipher: "cipher",
    client_secret_iv: "iv",
    integration_user_id: "005000000000001AAA",
    channel_secret_hash: hash,
  };
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const matchesCandidateQuery = () => args[0] === teamId && args[1] === channelId &&
        (!sql.includes("channel_id=? AND org_id=?") || args[2] === orgId);
      const matchesScopedQuery = () => args[0] === teamId && args[1] === orgId && args[2] === channelId;
      const statement = {
        bind(...values: unknown[]) { args = values; return statement; },
        async all() { return { results: matchesCandidateQuery() ? [row] : [] }; },
        async first() {
          if (sql.includes("salesforce_auth_credential")) return matchesScopedQuery() ? row : null;
          if (sql.includes("salesforce_channel_connection")) return matchesScopedQuery() ? { secret_hash: hash } : null;
          return null;
        },
      };
      return statement;
    },
  };
  return { DB: db } as unknown as AuthEnv;
}

test("POST /internal/channels/resolve derives the org from its authorized channel credential", async () => {
  const env = fixture(await secretHash(secret));
  const response = await worker.fetch(new Request("https://auth.internal/internal/channels/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ teamId, channelId, channelSecret: secret }),
  }), env);

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ teamId, orgId, channelId });
});

test("org resolution accepts a 15-character org ID when the stored ID has its 18-character form", async () => {
  const env = fixture(await secretHash(secret));
  const response = await worker.fetch(new Request("https://auth.internal/internal/channels/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ teamId, orgId: orgId.slice(0, 15), channelId, channelSecret: secret }),
  }), env);

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ teamId, orgId, channelId });
});

test("org resolution rejects mismatched orgs and channel secrets", async () => {
  const env = fixture(await secretHash(secret));
  const mismatchedOrg = await worker.fetch(new Request("https://auth.internal/internal/channels/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ teamId, orgId: "00D000000000002AAA", channelId, channelSecret: secret }),
  }), env);
  expect(mismatchedOrg.status).toBe(403);

  const wrongSecret = await worker.fetch(new Request("https://auth.internal/internal/channels/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ teamId, channelId, channelSecret: `${secret}-wrong` }),
  }), env);
  expect(wrongSecret.status).toBe(403);
});
