/** Frozen cross-worker RPC-signing contract (auth side: verification).
 *
 * Every public RPC method on MessagingProxyBroker and TubotSfAuthEntrypoint
 * takes a trailing `signed` envelope and calls verifySignedRpcCall FIRST.
 * Callers (proxy/searcher/data360/conversation) append the envelope
 * positionally after ALL business args, passing explicit `undefined` for
 * omitted optional params so the callee reconstructs the identical
 * businessArgsArray.
 *
 * Keys are PER-ORG: the HMAC key is HKDF(masterCallerKey, orgId), so a leaked
 * org key compromises only that org (HKDF is one-way: siblings and the master
 * stay safe). The envelope carries explicit `org`, bound to the method's
 * tenant scope when the method has one.
 */

export type RpcCallerId = "proxy" | "searcher" | "data360" | "conversation" | "agentcode";

export interface SignedRpcEnvelope {
  caller: string;
  timestamp: string;
  nonce: string;
  signature: string;
  /** Salesforce org id (15-18 alphanumerics). Absent only on legacy universal
   * envelopes, accepted solely while AUTH_RPC_ALLOW_LEGACY === "1". */
  org?: string;
}

/** Minimal env surface the verifier needs; AuthEnv satisfies this. */
export interface RpcSigningEnv {
  DB: D1Database;
  AUTH_CALLER_KEY_PROXY?: string;
  AUTH_CALLER_KEY_SEARCHER?: string;
  AUTH_CALLER_KEY_DATA360?: string;
  AUTH_CALLER_KEY_CONVERSATION?: string;
  AUTH_CALLER_KEY_AGENTCODE?: string;
  AUTH_CALLER_KEY_PROXY_NEXT?: string;
  AUTH_CALLER_KEY_SEARCHER_NEXT?: string;
  AUTH_CALLER_KEY_DATA360_NEXT?: string;
  AUTH_CALLER_KEY_CONVERSATION_NEXT?: string;
  AUTH_CALLER_KEY_AGENTCODE_NEXT?: string;
  AUTH_RPC_WARN_MODE?: string;
  /** Transition only: accept legacy universal (org-less) envelopes. Unset = per-org only. */
  AUTH_RPC_ALLOW_LEGACY?: string;
}

export class RpcAuthError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  constructor(status: number, code: string, retryable = false) {
    super(code);
    this.name = "RpcAuthError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const encoder = new TextEncoder();
const TIMESTAMP_RE = /^\d{10}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{24}$/;
const ORG_RE = /^[A-Za-z0-9]{15,18}$/;
const MIN_KEY_LENGTH = 32;
const TIMESTAMP_SKEW_SECONDS = 60;
const NONCE_TTL_SECONDS = 120;
/** HKDF salt; versioned so a future derivation scheme rotates cleanly. */
const ORG_KDF_SALT = "tubot-rpc-org-v1";

/** Methods whose args carry no tenant scope: envelope.org is verified but
 * cannot be bound to args; the method body binds it instead (filter/lookup). */
const SCOPELESS_RPC_METHODS = new Set(["listConnectedOrgs", "listExecutionUsersForChannel", "listSnapshotTeams"]);

/** businessArgsArray index holding the tenant scope ({ orgId }) per method.
 * Default 0 covers scope/ref-first methods (broker plus all invoke and inspect methods). */
const ORG_SCOPE_ARG_INDEX: Record<string, number> = {
  getCallableToolUrlsForChannel: 1,
  getTokenForChannel: 1,
  getTokenForExecutionUser: 2,
  getUserData: 2,
  getUserETag: 1,
  saveUserData: 4,
  getUserData360: 2,
  getMessagingSessionData360: 2,
  purgeCache: 1,
  getUserConversationHistory: 1,
};

/** Timing-safe string comparison (single shared helper; index.ts reuses this). */
export function equalHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** Byte-identical stable JSON port (frozen contract). */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) as string;
  if (v instanceof Uint8Array) return JSON.stringify(Array.from(v));
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + stableJson(o[k])).join(",") + "}";
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += alphabet[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += alphabet[n & 63];
  }
  return out;
}

/** Lowercase hex sha256 of stableJson(businessArgsArray). */
export async function rpcArgsDigest(businessArgs: unknown[]): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(stableJson(businessArgs)))));
}

/** canonical = caller + "\n" + method + "\n" + timestamp + "\n" + nonce + "\n" + argsDigest */
export function rpcCanonical(caller: string, method: string, timestamp: string, nonce: string, argsDigest: string): string {
  return caller + "\n" + method + "\n" + timestamp + "\n" + nonce + "\n" + argsDigest;
}

async function hmacSignature(key: string, canonical: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(canonical))));
}

async function hmacSignatureBytes(keyBytes: Uint8Array, canonical: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes.buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(canonical))));
}

/**
 * Per-org HMAC key: HKDF-SHA256(masterCallerKey, salt, caller + "\n" + orgId).
 * One-way: an org key reveals nothing about siblings or the master. Callers
 * run the identical derivation; both sides must byte-match (cross-checked).
 */
export async function deriveOrgKey(masterKey: string, caller: RpcCallerId, orgId: string): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey("raw", encoder.encode(masterKey), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(ORG_KDF_SALT), info: encoder.encode(caller + "\n" + orgId) },
    ikm, 256,
  );
  return new Uint8Array(bits);
}

/** canonical-v2 = caller + "\n" + org + "\n" + method + "\n" + timestamp + "\n" + nonce + "\n" + argsDigest */
export function rpcCanonicalV2(caller: string, org: string, method: string, timestamp: string, nonce: string, argsDigest: string): string {
  return caller + "\n" + org + "\n" + method + "\n" + timestamp + "\n" + nonce + "\n" + argsDigest;
}

export function isOrgId(v: unknown): v is string {
  return typeof v === "string" && ORG_RE.test(v);
}

/**
 * Binds envelope.org to the method's tenant scope. Scopeless methods are
 * skipped (their body binds instead); every other method MUST carry an
 * object scope with orgId equal to the envelope org. Throws 401 otherwise.
 */
export function assertOrgBinding(method: string, businessArgs: unknown[], org: string): void {
  if (SCOPELESS_RPC_METHODS.has(method)) return;
  const idx = ORG_SCOPE_ARG_INDEX[method] ?? 0;
  const scope = businessArgs[idx] as Record<string, unknown> | undefined;
  if (typeof scope !== "object" || scope === null || scope.orgId !== org) {
    throw new RpcAuthError(401, "rpc_unauthorized");
  }
}

function isCallerId(v: unknown): v is RpcCallerId {
  return v === "proxy" || v === "searcher" || v === "data360" || v === "conversation" || v === "agentcode";
}

/** Rejects malformed or out-of-window timestamps. The 60s bound is load-bearing
 * (it caps the replay window) and stays; rejections are logged with the
 * observed skew so wall-clock flakes surface as diagnosable events instead of
 * silent 401s. No secrets: caller id, method name, and skew seconds only. */
function assertTimestampSkew(caller: string, method: string, timestamp: unknown, nowSec: number): void {
  const seconds = typeof timestamp === "string" && TIMESTAMP_RE.test(timestamp) ? Number(timestamp) : NaN;
  const skewSec = Number.isFinite(seconds) ? Math.abs(nowSec - seconds) : null;
  if (skewSec === null || skewSec > TIMESTAMP_SKEW_SECONDS) {
    console.warn(JSON.stringify({ event: "rpc_timestamp_skew_rejected", caller, method, skewSec, boundSec: TIMESTAMP_SKEW_SECONDS }));
    throw new RpcAuthError(401, "rpc_unauthorized");
  }
}

/** Usable (>=32-char) keys for one caller: current plus _NEXT rotation fallback. */
export function callerSigningKeys(env: RpcSigningEnv, caller: RpcCallerId): string[] {
  const suffix = caller.toUpperCase() as "PROXY" | "SEARCHER" | "DATA360" | "CONVERSATION" | "AGENTCODE";
  const out: string[] = [];
  const names = [`AUTH_CALLER_KEY_${suffix}`, `AUTH_CALLER_KEY_${suffix}_NEXT`] as const;
  for (const name of names) {
    const value: unknown = env[name];
    if (typeof value === "string" && value.length >= MIN_KEY_LENGTH) out.push(value);
  }
  return out;
}

/** Pure crypto verification (no D1, no env): shape, caller, timestamp, nonce format, signature. */
export async function verifyRpcEnvelopeSignature(
  keys: string[],
  method: string,
  businessArgs: unknown[],
  envelope: SignedRpcEnvelope,
  nowSec: number,
): Promise<RpcCallerId> {
  if (!isCallerId(envelope.caller)) throw new RpcAuthError(401, "rpc_unauthorized");
  assertTimestampSkew(envelope.caller, method, envelope.timestamp, nowSec);
  if (typeof envelope.nonce !== "string" || !NONCE_RE.test(envelope.nonce)) {
    throw new RpcAuthError(401, "rpc_unauthorized");
  }
  if (typeof envelope.signature !== "string" || envelope.signature.length === 0) {
    throw new RpcAuthError(401, "rpc_unauthorized");
  }
  const canonical = rpcCanonical(envelope.caller, method, envelope.timestamp, envelope.nonce, await rpcArgsDigest(businessArgs));
  for (const key of keys) {
    if (equalHash(await hmacSignature(key, canonical), envelope.signature)) return envelope.caller;
  }
  throw new RpcAuthError(401, "rpc_unauthorized");
}

/**
 * Per-org verification: HKDF-derives an HMAC key per master key, checks the
 * v2 canonical signature, then binds envelope.org to the method scope.
 * Returns the verified org id.
 */
export async function verifyPerOrgEnvelopeSignature(
  masterKeys: string[],
  method: string,
  businessArgs: unknown[],
  envelope: SignedRpcEnvelope,
  nowSec: number,
): Promise<{ caller: RpcCallerId; org: string }> {
  if (!isCallerId(envelope.caller)) throw new RpcAuthError(401, "rpc_unauthorized");
  if (!isOrgId(envelope.org)) throw new RpcAuthError(401, "rpc_unauthorized");
  assertTimestampSkew(envelope.caller, method, envelope.timestamp, nowSec);
  if (typeof envelope.nonce !== "string" || !NONCE_RE.test(envelope.nonce)) {
    throw new RpcAuthError(401, "rpc_unauthorized");
  }
  if (typeof envelope.signature !== "string" || envelope.signature.length === 0) {
    throw new RpcAuthError(401, "rpc_unauthorized");
  }
  const canonical = rpcCanonicalV2(envelope.caller, envelope.org, method, envelope.timestamp, envelope.nonce, await rpcArgsDigest(businessArgs));
  for (const master of masterKeys) {
    const orgKey = await deriveOrgKey(master, envelope.caller, envelope.org);
    if (equalHash(await hmacSignatureBytes(orgKey, canonical), envelope.signature)) {
      assertOrgBinding(method, businessArgs, envelope.org);
      return { caller: envelope.caller, org: envelope.org };
    }
  }
  throw new RpcAuthError(401, "rpc_unauthorized");
}

/** Minimum request-time advance between expired-nonce purges. The purge is
 * pure garbage collection (single-use is enforced by INSERT OR IGNORE), so
 * every RPC claim runs it at most once per interval instead of once per
 * call: 2 D1 writes per RPC become 1 plus an amortized purge. A backwards
 * clock still purges (monotonic clocks never go backwards in production). */
const NONCE_PURGE_INTERVAL_SECONDS = 60;
let lastNoncePurgeSec = Number.NEGATIVE_INFINITY;

// FLK-32 diagnosis: the check-then-set below is synchronous (no await between
// the guard and the stamp), so within one isolate it is atomic under the JS
// event loop — concurrent claims cannot interleave it and there is no race to
// fix here. Across isolates each keeps its own guard, so duplicate purges are
// possible, but the purge is an idempotent DELETE of expired rows (single-use
// is enforced separately by INSERT OR IGNORE), making duplicates benign.

/** Purges expired nonces at most once per interval; safe to call per claim. */
export async function maybePurgeRpcNonces(db: D1Database, nowSec: number): Promise<void> {
  if (nowSec >= lastNoncePurgeSec && nowSec - lastNoncePurgeSec < NONCE_PURGE_INTERVAL_SECONDS) return;
  lastNoncePurgeSec = nowSec;
  await db.prepare("DELETE FROM salesforce_self_oauth_internal_nonce WHERE expires_at <= ?").bind(nowSec).run();
}

/** D1 single-use nonce claim; throws 401 when the nonce was already used. */
export async function claimRpcNonce(db: D1Database, nonce: string, nowSec: number): Promise<void> {
  await maybePurgeRpcNonces(db, nowSec);
  const nonceHash = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(nonce))));
  const inserted = await db.prepare(`INSERT OR IGNORE INTO salesforce_self_oauth_internal_nonce
    (nonce_hash, expires_at) VALUES (?, ?)`)
    .bind(nonceHash, nowSec + NONCE_TTL_SECONDS).run();
  if (inserted.meta.changes !== 1) throw new RpcAuthError(401, "rpc_unauthorized");
}

/**
 * Guard entrypoint: runs FIRST in every RPC method. Returns the verified org
 * id on the per-org path ("" for legacy envelopes and warn-mode pass-through;
 * scopeless-method bodies bind/filter on it). In enforce mode a missing or
 * invalid envelope throws 401 rpc_unauthorized; a missing/short key for the
 * calling caller throws a 503-style config error for that caller only.
 * Legacy universal (org-less) envelopes are accepted only while
 * AUTH_RPC_ALLOW_LEGACY === "1" (dual-accept transition). In warn mode
 * (AUTH_RPC_WARN_MODE === "1") any failure is logged and execution proceeds.
 */
export async function verifySignedRpcCall(
  env: RpcSigningEnv,
  method: string,
  businessArgs: unknown[],
  envelope: unknown,
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    if (typeof envelope !== "object" || envelope === null) throw new RpcAuthError(401, "rpc_unauthorized");
    const typed = envelope as SignedRpcEnvelope;
    if (!isCallerId(typed.caller)) throw new RpcAuthError(401, "rpc_unauthorized");
    const keys = callerSigningKeys(env, typed.caller);
    if (keys.length === 0) throw new RpcAuthError(503, "rpc_caller_key_unconfigured");
    if (typeof typed.org === "string") {
      const verified = await verifyPerOrgEnvelopeSignature(keys, method, businessArgs, typed, nowSec);
      await claimRpcNonce(env.DB, typed.nonce, nowSec);
      return verified.org;
    }
    if (env.AUTH_RPC_ALLOW_LEGACY !== "1") throw new RpcAuthError(401, "rpc_unauthorized");
    await verifyRpcEnvelopeSignature(keys, method, businessArgs, typed, nowSec);
    await claimRpcNonce(env.DB, typed.nonce, nowSec);
    return "";
  } catch (err) {
    if (env.AUTH_RPC_WARN_MODE === "1") {
      const caller = typeof envelope === "object" && envelope !== null
        ? (envelope as Record<string, unknown>).caller as string | undefined
        : undefined;
      console.warn(method, caller, err instanceof RpcAuthError ? err.code : "rpc_verify_error");
      return "";
    }
    throw err;
  }
}
