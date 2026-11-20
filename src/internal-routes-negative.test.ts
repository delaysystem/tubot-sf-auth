import { expect, test } from "bun:test";
import worker from "./index";

// S3: negative tests for every /internal/* route. All routes share one guard
// (POST-only + HMAC signature + single-use nonce in verifySignedSelfOAuthRequest),
// so each route proves: missing signature -> 401, bad signature -> 401,
// replayed nonce -> 401, wrong method -> 405. Requests run against the local
// worker fetch handler with a stateful mock D1 (single-use nonces honored).

const HMAC_KEY = "0123456789abcdef0123456789abcdef";

function b64urlBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let nonceCounter = 0;
function freshNonce(): string {
  // 24 chars, [A-Za-z0-9_-]: "n" + zero-padded counter + fixed tail.
  nonceCounter += 1;
  return `n${String(nonceCounter).padStart(10, "0")}abcdefghijklm`;
}

async function sign(method: string, path: string, body: string, nonce: string, timestamp: string, key = HMAC_KEY): Promise<string> {
  const bodyDigest = b64urlBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))));
  const canonical = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyDigest}`;
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64urlBytes(new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(canonical))));
}

async function signedRequest(path: string, body: unknown, overrides: { nonce?: string; timestamp?: string; signature?: string; method?: string } = {}): Promise<Request> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const method = overrides.method ?? "POST";
  const nonce = overrides.nonce ?? freshNonce();
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = overrides.signature ?? await sign(method, path, raw, nonce, timestamp);
  return new Request(`http://auth${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-tubot-sf-auth-timestamp": timestamp,
      "x-tubot-sf-auth-nonce": nonce,
      "x-tubot-sf-auth-signature": signature,
    },
    body: method === "GET" || method === "HEAD" ? undefined : raw,
  });
}

// Stateful mock D1: single-use nonces (INSERT OR IGNORE returns changes=1
// once per hash, 0 on replay), everything else inert.
function internalDb() {
  const nonces = new Set<string>();
  return {
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
          return { success: true, meta: { changes: 0 } };
        },
        async first() {
          if (sql.includes("COUNT(*)")) return { count: 0 };
          return null;
        },
        async all() { return { results: [] }; },
      });
      return { bind: (...bindings: unknown[]) => bound(bindings), ...bound([]) };
    },
    async batch(statements: Array<{ sql: string; bindings: unknown[] }>) {
      return statements.map(() => ({ success: true, meta: { changes: 0 } }));
    },
  };
}

const env = { DB: internalDb(), SELF_OAUTH_NEW_PANEL_HMAC_KEY: HMAC_KEY } as never;

// Every guarded route. The `{}` body passes the signature guard but fails
// handler validation (400/401-by-handler/404), proving the guard passed when
// the error is anything other than invalid_internal_signature.
const ROUTES = [
  "/internal/self-oauth/start",
  "/internal/self-oauth/status",
  "/internal/self-oauth/request",
  "/internal/self-oauth/batch",
  "/internal/self-oauth/disconnect",
  "/internal/self-oauth/complete",
  "/internal/self-oauth/no-such-operation",
  "/internal/agents/connect",
  "/internal/agents/download",
  "/internal/agents/status",
  "/internal/agents/verify",
  "/internal/agents/list",
  "/internal/agents/extract",
  "/internal/agents/advance",
  "/internal/agents/no-such-operation",
  "/internal/channels/cleanup",
  "/internal/orgs/cleanup",
  "/internal/jwt-api-diagnostics",
  "/internal/jwt-api-permission-diagnostics",
];

for (const path of ROUTES) {
  test(`S3 ${path}: missing signature returns 401`, async () => {
    const response = await worker.fetch(new Request(`http://auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }), env);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_internal_signature");
  });

  test(`S3 ${path}: bad signature returns 401`, async () => {
    const request = await signedRequest(path, {}, { signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_internal_signature");
  });

  test(`S3 ${path}: replayed request is rejected`, async () => {
    const nonce = freshNonce();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const first = await signedRequest(path, {}, { nonce, timestamp });
    const firstResponse = await worker.fetch(first, env);
    const firstBody = (await firstResponse.json()) as { error: string };
    // Anything but the guard error proves the guard passed on first use.
    expect(firstBody.error).not.toBe("invalid_internal_signature");
    const replay = await signedRequest(path, {}, { nonce, timestamp });
    const replayResponse = await worker.fetch(replay, env);
    expect(replayResponse.status).toBe(401);
    expect(((await replayResponse.json()) as { error: string }).error).toBe("invalid_internal_signature");
  });

  test(`S3 ${path}: wrong method returns 405`, async () => {
    const response = await worker.fetch(new Request(`http://auth${path}`, { method: "GET" }), env);
    expect(response.status).toBe(405);
    expect(((await response.json()) as { error: string }).error).toBe("method_not_allowed");
  });
}

test("S3 guard depth: stale timestamp is rejected", async () => {
  const stale = String(Math.floor(Date.now() / 1000) - 3600);
  const request = await signedRequest("/internal/channels/cleanup", {}, { timestamp: stale });
  const response = await worker.fetch(request, env);
  expect(response.status).toBe(401);
});

test("S3 guard depth: tampered body is rejected", async () => {
  const nonce = freshNonce();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await sign("POST", "/internal/channels/cleanup", JSON.stringify({}), nonce, timestamp);
  const tampered = new Request("http://auth/internal/channels/cleanup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tubot-sf-auth-timestamp": timestamp,
      "x-tubot-sf-auth-nonce": nonce,
      "x-tubot-sf-auth-signature": signature,
    },
    body: JSON.stringify({ teamId: "mallory" }),
  });
  const response = await worker.fetch(tampered, env);
  expect(response.status).toBe(401);
});

test("S3 guard depth: signature for another path is rejected", async () => {
  const nonce = freshNonce();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify({});
  const signature = await sign("POST", "/internal/orgs/cleanup", raw, nonce, timestamp);
  const request = new Request("http://auth/internal/channels/cleanup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tubot-sf-auth-timestamp": timestamp,
      "x-tubot-sf-auth-nonce": nonce,
      "x-tubot-sf-auth-signature": signature,
    },
    body: raw,
  });
  const response = await worker.fetch(request, env);
  expect(response.status).toBe(401);
});
