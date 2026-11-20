import { expect, test } from "bun:test";
import worker from "./index";

// F3: single-channel disconnects keep snapshot jobs/files/chunks while still
// purging channel-bound rows; full org teardown still purges everything.

const HMAC_KEY = "0123456789abcdef0123456789abcdef";
const ORG_ID = "00D000000000001AAA";
const CHANNEL_ID = "005000000000001AAA";

function b64urlBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let nonceCounter = 1000;
function freshNonce(): string {
  nonceCounter += 1;
  return `f${String(nonceCounter).padStart(10, "0")}abcdefghijklm`;
}

async function signedRequest(path: string, body: unknown): Promise<Request> {
  const raw = JSON.stringify(body);
  const nonce = freshNonce();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyDigest = b64urlBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))));
  const canonical = `POST\n${path}\n${timestamp}\n${nonce}\n${bodyDigest}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(HMAC_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = b64urlBytes(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical))));
  return new Request(`http://auth${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tubot-sf-auth-timestamp": timestamp,
      "x-tubot-sf-auth-nonce": nonce,
      "x-tubot-sf-auth-signature": signature,
    },
    body: raw,
  });
}

// Recording mock D1: honors single-use nonces, records every DELETE with its
// bindings, reports the shared-DB tables as present for org teardown.
function recordingDb() {
  const nonces = new Set<string>();
  const deletes: Array<{ sql: string; bindings: unknown[] }> = [];
  const present = new Set([
    "panel_salesforce_channels", "panel_salesforce_execution_users", "panel_salesforce_setup_oauth_pending",
    "salesforce_self_oauth_credential", "salesforce_self_oauth_pending", "sf_agent_snapshot_chunk",
    "sf_agent_snapshot_file", "sf_agent_snapshot_job", "sf_agent_metadata_user", "action_graph_context",
    "sf_user_data_cache_v2", "panel_messaging_proxies",
    "panel_org_oauth_clients", "panel_routing_backups", "panel_activate_tokens",
  ]);
  return {
    deletes,
    prepare(sql: string) {
      const bound = (bindings: unknown[]) => ({
        sql,
        bindings,
        async run() {
          if (sql.includes("salesforce_self_oauth_internal_nonce") && sql.includes("INSERT")) {
            const hash = String(bindings[0]);
            if (nonces.has(hash)) return { success: true, meta: { changes: 0 } };
            nonces.add(hash);
            return { success: true, meta: { changes: 1 } };
          }
          // Nonce-housekeeping DELETEs are guard internals, not tenant cleanup.
          if (sql.startsWith("DELETE FROM") && !sql.includes("salesforce_self_oauth_internal_nonce")) {
            deletes.push({ sql, bindings });
          }
          return { success: true, meta: { changes: 0 } };
        },
        async first() {
          if (sql.includes("FROM sqlite_master")) {
            const table = bindings[0];
            if (typeof table === "string") return present.has(table) ? { present: 1 } : null;
            return null;
          }
          if (sql.includes("COUNT(*)")) return { count: 0 };
          return null;
        },
        async all() { return { results: [] }; },
      });
      return { bind: (...bindings: unknown[]) => bound(bindings), ...bound([]) };
    },
    async batch(statements: Array<{ sql: string; bindings: unknown[] }>) {
      for (const s of statements) {
        if (s.sql.startsWith("DELETE FROM")) deletes.push({ sql: s.sql, bindings: s.bindings });
      }
      return statements.map(() => ({ success: true, meta: { changes: 0 } }));
    },
  };
}

test("F3 channel disconnect keeps snapshots and drops channel-bound rows", async () => {
  const db = recordingDb();
  const env = { DB: db, SELF_OAUTH_NEW_PANEL_HMAC_KEY: HMAC_KEY } as never;
  const response = await worker.fetch(
    await signedRequest("/internal/channels/cleanup", { teamId: "team", orgId: ORG_ID, channelId: CHANNEL_ID }),
    env,
  );
  expect(response.status).toBe(200);
  expect(((await response.json()) as { ok: boolean }).ok).toBe(true);

  // Snapshots survive: no snapshot-table DELETE of any kind.
  expect(db.deletes.filter((d) => d.sql.includes("sf_agent_snapshot_"))).toHaveLength(0);

  // Ephemeral channel-bound rows are still purged, scoped to the exact
  // channel — but the metadata-user row survives so a reconnect finds its
  // extraction identity (it holds no secrets; tokens are cleared above).
  const tables = db.deletes.map((d) => d.sql);
  expect(tables.filter((s) => s.startsWith("DELETE FROM sf_agent_metadata_user"))).toHaveLength(0);
  expect(tables.filter((s) => s.startsWith("DELETE FROM action_graph_context"))).toHaveLength(1);
  for (const d of db.deletes) {
    expect(d.bindings).toEqual(["team", ORG_ID, CHANNEL_ID]);
  }
});

test("F3 channel disconnect is scoped: sibling channel rows untouched", async () => {
  const db = recordingDb();
  const env = { DB: db, SELF_OAUTH_NEW_PANEL_HMAC_KEY: HMAC_KEY } as never;
  const otherChannel = "005000000000002AAA";
  const response = await worker.fetch(
    await signedRequest("/internal/channels/cleanup", { teamId: "team", orgId: ORG_ID, channelId: otherChannel }),
    env,
  );
  expect(response.status).toBe(200);
  expect(db.deletes.length).toBeGreaterThan(0);
  for (const d of db.deletes) {
    expect(d.sql).toContain("channel_id=?");
    expect(d.bindings).toEqual(["team", ORG_ID, otherChannel]);
  }
});

test("F3 full org teardown still purges snapshots and channel-bound rows", async () => {
  const db = recordingDb();
  const env = { DB: db, SELF_OAUTH_NEW_PANEL_HMAC_KEY: HMAC_KEY } as never;
  const response = await worker.fetch(
    await signedRequest("/internal/orgs/cleanup", { teamId: "team", orgId: ORG_ID }),
    env,
  );
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { ok: boolean; remaining: Record<string, number> };
  expect(payload.ok).toBe(true);

  const tables = db.deletes.map((d) => d.sql);
  // Snapshots fully purged on org teardown.
  for (const table of ["sf_agent_snapshot_chunk", "sf_agent_snapshot_file", "sf_agent_snapshot_job"]) {
    expect(tables.filter((s) => s.startsWith(`DELETE FROM ${table}`))).toHaveLength(1);
  }
  // Channel-bound rows purged org-wide.
  for (const table of ["sf_agent_metadata_user", "action_graph_context", "panel_salesforce_execution_users", "panel_salesforce_channels"]) {
    expect(tables.filter((s) => s.startsWith(`DELETE FROM ${table}`))).toHaveLength(1);
  }
  for (const d of db.deletes) {
    expect(d.bindings).toEqual(["team", ORG_ID]);
  }
});
