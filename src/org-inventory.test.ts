import { expect, test } from "bun:test";
import { TubotSfAuthEntrypoint } from "./index";
import type { SignedRpcEnvelope } from "./rpc-signing";

// F6: listConnectedOrgs must push the bound org into SQL (indexed seek)
// instead of scanning every channel, while the legacy scopeless path keeps
// the full inventory scan. Resolution semantics are unchanged either way.

const enc = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const tj = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v) as string;
  if (Array.isArray(v)) return "[" + v.map(tj).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + tj(o[k])).join(",") + "}";
};
const freshNonce = () => b64url(crypto.getRandomValues(new Uint8Array(18)));
const nowSec = () => String(Math.floor(Date.now() / 1000));
const SEARCHER_KEY = "test-searcher-key-0123456789abcdef";
const ORG_A = "00Dxx0000000001EAE";
const ORG_B = "00Dxx0000000002EAE";

async function testSignOrg(caller: string, key: string, org: string, method: string, args: unknown[]): Promise<SignedRpcEnvelope> {
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(tj(args)))));
  const canonical = [caller, org, method, nowSec(), freshNonce(), digest].join("\n");
  const parts = canonical.split("\n");
  const ikm = await crypto.subtle.importKey("raw", enc.encode(key), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("tubot-rpc-org-v1"), info: enc.encode(caller + "\n" + org) },
    ikm, 256);
  const ck = await crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", ck, enc.encode(canonical))));
  return { caller, org, timestamp: parts[3], nonce: parts[4], signature };
}

async function testSignLegacy(caller: string, key: string, method: string, args: unknown[]): Promise<SignedRpcEnvelope> {
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(tj(args)))));
  const timestamp = nowSec(), nonce = freshNonce();
  const canonical = [caller, method, timestamp, nonce, digest].join("\n");
  const ck = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", ck, enc.encode(canonical))));
  return { caller, timestamp, nonce, signature };
}

/** SQL-recording D1 double: nonce table works, channel rows filter like the real query. */
function fakeDb(allRows: Array<{ teamId: string; orgId: string; channelId: string }>) {
  const nonces = new Map<string, number>();
  const seen: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    seen,
    prepare(sql: string) {
      const bound = (...args: unknown[]) => ({
        async run() {
          if (sql.startsWith("DELETE FROM salesforce_self_oauth_internal_nonce")) {
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.startsWith("INSERT OR IGNORE INTO salesforce_self_oauth_internal_nonce")) {
            const [h, exp] = args as [string, number];
            if (nonces.has(h)) return { success: true, meta: { changes: 0 } };
            nonces.set(h, exp);
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
        async first() { return null; },
        async all() {
          seen.push({ sql, args });
          if (sql.includes("FROM panel_salesforce_channels") && sql.includes("WHERE org_id=?")) {
            return { results: allRows.filter((r) => r.orgId === args[0]) };
          }
          return { results: allRows };
        },
      });
      return { bind: bound, ...bound() };
    },
  };
  return db;
}

const ROWS = [
  { teamId: "team-a", orgId: ORG_A, channelId: "0Mjxx0000000001AAA" },
  { teamId: "team-b", orgId: ORG_B, channelId: "0Mjxx0000000002AAA" },
];

test("F6: bound org pushes WHERE org_id into SQL and returns only that org", async () => {
  const db = fakeDb(ROWS);
  const auth = new TubotSfAuthEntrypoint({}, { DB: db, AUTH_CALLER_KEY_SEARCHER: SEARCHER_KEY });
  const envelope = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, "listConnectedOrgs", []);
  expect(await auth.listConnectedOrgs(envelope)).toEqual([ROWS[0]]);
  expect(db.seen).toHaveLength(1);
  expect(db.seen[0].sql.replace(/\s+/g, " ")).toContain("WHERE org_id=?");
  expect(db.seen[0].args).toEqual([ORG_A]);
});

test("F6: legacy scopeless path keeps the full inventory scan", async () => {
  const db = fakeDb(ROWS);
  const auth = new TubotSfAuthEntrypoint({}, {
    DB: db, AUTH_CALLER_KEY_SEARCHER: SEARCHER_KEY, AUTH_RPC_ALLOW_LEGACY: "1",
  });
  const envelope = await testSignLegacy("searcher", SEARCHER_KEY, "listConnectedOrgs", []);
  expect(await auth.listConnectedOrgs(envelope)).toEqual(ROWS);
  expect(db.seen).toHaveLength(1);
  expect(db.seen[0].sql.replace(/\s+/g, " ")).not.toContain("WHERE");
});
