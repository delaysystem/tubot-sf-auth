import { expect, test } from "bun:test";
import {
  RpcAuthError,
  assertOrgBinding,
  callerSigningKeys,
  claimRpcNonce,
  deriveOrgKey,
  rpcArgsDigest,
  stableJson,
  verifyPerOrgEnvelopeSignature,
  verifyRpcEnvelopeSignature,
  verifySignedRpcCall,
  type RpcSigningEnv,
  type SignedRpcEnvelope,
} from "./rpc-signing";
import { MessagingProxyBroker, TubotSfAuthEntrypoint } from "./index";

/** Independent test-side signer, ported from the contract text (not from rpc-signing.ts). */
const enc = new TextEncoder();
function tj(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) as string;
  if (v instanceof Uint8Array) return JSON.stringify(Array.from(v));
  if (Array.isArray(v)) return "[" + v.map(tj).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + tj(o[k])).join(",") + "}";
}
function hex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}
function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function testSign(caller: string, key: string, method: string, args: unknown[], timestamp: string, nonce: string): Promise<SignedRpcEnvelope> {
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(tj(args)))));
  const canonical = [caller, method, timestamp, nonce, digest].join("\n");
  const ck = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", ck, enc.encode(canonical))));
  return { caller, timestamp, nonce, signature };
}
function freshNonce(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(18)));
}
const nowSec = () => String(Math.floor(Date.now() / 1000));

/** Independent per-org test signer: HKDF port + v2 canonical (from contract text). */
async function testKdf(master: string, caller: string, org: string): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey("raw", enc.encode(master), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("tubot-rpc-org-v1"), info: enc.encode(caller + "\n" + org) },
    ikm, 256);
  return new Uint8Array(bits);
}
async function testSignOrg(caller: string, key: string, org: string, method: string, args: unknown[], timestamp: string, nonce: string): Promise<SignedRpcEnvelope> {
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(tj(args)))));
  const canonical = [caller, org, method, timestamp, nonce, digest].join("\n");
  const ck = await crypto.subtle.importKey("raw", await testKdf(key, caller, org), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", ck, enc.encode(canonical))));
  return { caller, org, timestamp, nonce, signature };
}

const SEARCHER_KEY = "test-searcher-key-0123456789abcdef";
const PROXY_KEY = "test-proxy-key-0123456789abcdefzz";
const CONVERSATION_KEY = "test-conversation-key-0123456789ab";
const AGENTCODE_KEY = "test-agentcode-key-0123456789abcdef";
const ORG_A = "00Dxx0000000001EAE";
const ORG_B = "00Dxx0000000002EAE";
const scopeA = { teamId: "team-a", orgId: ORG_A, channelId: "0Mjxx0000000001AAA" };

/** Minimal in-memory D1 double (nonce table + stubbed .all() rows). */
function fakeDb(allRows: unknown[] = []) {
  const nonces = new Map<string, number>();
  const db = {
    nonces,
    prepare(sql: string) {
      const bound = (...args: unknown[]) => ({
        async run() {
          if (sql.startsWith("DELETE FROM salesforce_self_oauth_internal_nonce")) {
            const now = args[0] as number;
            for (const [k, exp] of [...nonces]) if (exp <= now) nonces.delete(k);
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
        async all() { return { results: allRows }; },
      });
      return { bind: bound, ...bound() };
    },
  };
  return db;
}
function testEnv(over: Partial<RpcSigningEnv> = {}): RpcSigningEnv {
  return { DB: fakeDb() as unknown as D1Database, AUTH_CALLER_KEY_SEARCHER: SEARCHER_KEY, ...over };
}
async function expectRpcError(p: Promise<unknown>, status: number, code: string) {
  try { await p; }
  catch (err) {
    expect(err).toBeInstanceOf(RpcAuthError);
    expect((err as RpcAuthError).status).toBe(status);
    expect((err as RpcAuthError).code).toBe(code);
    return;
  }
  throw new Error(`expected RpcAuthError ${status}/${code}`);
}

test("stableJson matches the frozen byte-level vectors", () => {
  expect(stableJson([])).toBe("[]");
  expect(stableJson({ b: 1, a: [3, 2], c: null })).toBe('{"a":[3,2],"b":1,"c":null}');
  expect(stableJson(new Uint8Array([1, 2]))).toBe("[1,2]");
  expect(stableJson({ z: { b: 1, a: 0 }, a: "x" })).toBe('{"a":"x","z":{"a":0,"b":1}}');
  expect(stableJson([undefined, 1])).toBe("[,1]");
});

test("openssl known-answer vector verifies (independent oracle)", async () => {
  expect(await rpcArgsDigest([])).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
  const envelope: SignedRpcEnvelope = {
    caller: "searcher",
    timestamp: "1760400000",
    nonce: "abcdefghijklmnopqrstuvwx",
    signature: "wrfEdg349Jpw_cV9T1VRHClNgF_dKJ5tHAejjQcofcI",
  };
  const caller = await verifyRpcEnvelopeSignature(
    ["test-caller-key-0123456789abcdef"], "listConnectedOrgs", [], envelope, 1760400000);
  expect(caller).toBe("searcher");
  await expectRpcError(
    verifyRpcEnvelopeSignature(["test-caller-key-0123456789abcdef"], "listConnectedOrgs", [],
      { ...envelope, signature: "xrfEdg349Jpw_cV9T1VRHClNgF_dKJ5tHAejjQcofcI" }, 1760400000),
    401, "rpc_unauthorized");
});

test("valid per-org envelope verifies end-to-end, returns the org, and claims the nonce", async () => {
  const env = testEnv();
  const envelope = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, "listConnectedOrgs", [], nowSec(), freshNonce());
  const org = await verifySignedRpcCall(env, "listConnectedOrgs", [], envelope);
  expect(org).toBe(ORG_A);
  expect((env.DB as unknown as ReturnType<typeof fakeDb>).nonces.size).toBe(1);
});

test("tampered caller/org/method/args/timestamp/nonce/signature are rejected", async () => {
  const ts = nowSec();
  const base = { method: "inspectSalesforce", args: [scopeA, []] as unknown[] };
  const good = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, base.method, base.args, ts, freshNonce());
  // Tampered caller (known caller, wrong key material).
  await expectRpcError(verifySignedRpcCall(testEnv({ AUTH_CALLER_KEY_PROXY: PROXY_KEY }),
    base.method, base.args, { ...good, caller: "proxy" }), 401, "rpc_unauthorized");
  // Tampered org (well-formed sibling org).
  await expectRpcError(verifySignedRpcCall(testEnv(), base.method, base.args, { ...good, org: ORG_B }), 401, "rpc_unauthorized");
  // Tampered method.
  await expectRpcError(verifySignedRpcCall(testEnv(), "listConnectedOrgs", base.args, good), 401, "rpc_unauthorized");
  // Tampered args.
  await expectRpcError(verifySignedRpcCall(testEnv(), base.method,
    [scopeA, [{ method: "GET", path: "/x" }]], good), 401, "rpc_unauthorized");
  // Tampered timestamp (still well-formed and in-window).
  const ts2 = String(Number(ts) + 1);
  await expectRpcError(verifySignedRpcCall(testEnv(), base.method, base.args, { ...good, timestamp: ts2 }), 401, "rpc_unauthorized");
  // Tampered nonce (still well-formed).
  const nonce2 = good.nonce.slice(0, 23) + (good.nonce[23] === "A" ? "B" : "A");
  await expectRpcError(verifySignedRpcCall(testEnv(), base.method, base.args, { ...good, nonce: nonce2 }), 401, "rpc_unauthorized");
  // Tampered signature.
  const sig2 = (good.signature[0] === "A" ? "B" : "A") + good.signature.slice(1);
  await expectRpcError(verifySignedRpcCall(testEnv(), base.method, base.args, { ...good, signature: sig2 }), 401, "rpc_unauthorized");
});

test("replayed nonce is rejected", async () => {
  const env = testEnv();
  const envelope = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, "listConnectedOrgs", [], nowSec(), freshNonce());
  await verifySignedRpcCall(env, "listConnectedOrgs", [], envelope);
  await expectRpcError(verifySignedRpcCall(env, "listConnectedOrgs", [], envelope), 401, "rpc_unauthorized");
});

test("expired nonces are pruned and reusable names do not collide across time", async () => {
  const db = fakeDb() as unknown as D1Database;
  const store = (db as unknown as ReturnType<typeof fakeDb>).nonces;
  await claimRpcNonce(db, "abcdefghijklmnopqrstuvwx", 1000);
  expect(store.size).toBe(1);
  await claimRpcNonce(db, "abcdefghijklmnopqrstuvwx", 1000 + 121);
  expect(store.size).toBe(1);
});

test("stale and future timestamps rejected; +-60s boundary accepted", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const ts of [now - 61, now + 61]) {
    const envelope = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, "listConnectedOrgs", [], String(ts), freshNonce());
    await expectRpcError(verifySignedRpcCall(testEnv(), "listConnectedOrgs", [], envelope), 401, "rpc_unauthorized");
  }
  for (const ts of [now - 60, now + 60]) {
    const envelope = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, "listConnectedOrgs", [], String(ts), freshNonce());
    await verifySignedRpcCall(testEnv(), "listConnectedOrgs", [], envelope);
  }
  // Malformed timestamps.
  for (const ts of ["123456789", "12345678901", "abcdefghij", "176040000a"]) {
    await expectRpcError(verifyPerOrgEnvelopeSignature([SEARCHER_KEY], "listConnectedOrgs", [],
      { caller: "searcher", org: ORG_A, timestamp: ts, nonce: freshNonce(), signature: "x" }, now), 401, "rpc_unauthorized");
  }
});

test("unknown caller and malformed envelopes rejected without touching D1", async () => {
  const db = fakeDb();
  const env = { DB: db as unknown as D1Database, AUTH_CALLER_KEY_SEARCHER: SEARCHER_KEY };
  await expectRpcError(verifySignedRpcCall(env, "listConnectedOrgs", [],
    { caller: "intruder", org: ORG_A, timestamp: nowSec(), nonce: freshNonce(), signature: "x" }), 401, "rpc_unauthorized");
  await expectRpcError(verifySignedRpcCall(env, "listConnectedOrgs", [], undefined), 401, "rpc_unauthorized");
  await expectRpcError(verifySignedRpcCall(env, "listConnectedOrgs", [],
    { caller: "searcher", org: ORG_A, timestamp: nowSec(), nonce: "short", signature: "x" }), 401, "rpc_unauthorized");
  for (const org of ["00Dshort", "00Dxx0000000001EAE!", "", "00D xx0000000001EAE", 12345]) {
    await expectRpcError(verifySignedRpcCall(env, "listConnectedOrgs", [],
      { caller: "searcher", org, timestamp: nowSec(), nonce: freshNonce(), signature: "x" }), 401, "rpc_unauthorized");
  }
  expect(db.nonces.size).toBe(0);
});

test("per-caller missing/short key fails closed for that caller only", async () => {
  const searcherOnly = testEnv();
  expect(callerSigningKeys(searcherOnly, "proxy")).toEqual([]);
  const proxyEnvelope = await testSignOrg("proxy", PROXY_KEY, ORG_A, "authorize", [scopeA], nowSec(), freshNonce());
  await expectRpcError(verifySignedRpcCall(searcherOnly, "authorize",
    [scopeA], proxyEnvelope), 503, "rpc_caller_key_unconfigured");
  const shortKey = testEnv({ AUTH_CALLER_KEY_PROXY: "too-short" });
  await expectRpcError(verifySignedRpcCall(shortKey, "authorize",
    [scopeA], proxyEnvelope), 503, "rpc_caller_key_unconfigured");
  // The configured caller is unaffected.
  const searcherEnvelope = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, "listConnectedOrgs", [], nowSec(), freshNonce());
  await verifySignedRpcCall(searcherOnly, "listConnectedOrgs", [], searcherEnvelope);
});

test("conversation caller resolves its own key and verifies end to end", async () => {
  const env = testEnv({ AUTH_CALLER_KEY_CONVERSATION: CONVERSATION_KEY });
  expect(callerSigningKeys(env, "conversation")).toEqual([CONVERSATION_KEY]);
  expect(callerSigningKeys(env, "data360")).toEqual([]);
  const envelope = await testSignOrg("conversation", CONVERSATION_KEY, ORG_A, "getTokenForChannel",
    ["0Mjxx0000000001AAA", scopeA], nowSec(), freshNonce());
  await verifySignedRpcCall(env, "getTokenForChannel",
    ["0Mjxx0000000001AAA", scopeA], envelope);
  // Cross-caller key does not verify as conversation.
  const forged = await testSignOrg("conversation", SEARCHER_KEY, ORG_A, "getTokenForChannel",
    ["0Mjxx0000000001AAA", scopeA], nowSec(), freshNonce());
  await expectRpcError(verifySignedRpcCall(env, "getTokenForChannel",
    ["0Mjxx0000000001AAA", scopeA], forged), 401, "rpc_unauthorized");
});

test("agentcode caller resolves its own key and verifies end to end", async () => {
  const env = testEnv({ AUTH_CALLER_KEY_AGENTCODE: AGENTCODE_KEY });
  expect(callerSigningKeys(env, "agentcode")).toEqual([AGENTCODE_KEY]);
  expect(callerSigningKeys(env, "data360")).toEqual([]);
  const scope = { teamId: "team-agentcode", orgId: ORG_A };
  const envelope = await testSignOrg("agentcode", AGENTCODE_KEY, ORG_A, "listAgentSnapshots", [scope], nowSec(), freshNonce());
  await verifySignedRpcCall(env, "listAgentSnapshots", [scope], envelope);
  // Cross-caller key does not verify as agentcode.
  const forged = await testSignOrg("agentcode", SEARCHER_KEY, ORG_A, "listAgentSnapshots", [scope], nowSec(), freshNonce());
  await expectRpcError(verifySignedRpcCall(env, "listAgentSnapshots", [scope], forged), 401, "rpc_unauthorized");
  // Envelope org must equal scope orgId via the default arg-0 binding.
  const scopeB = { teamId: "team-agentcode", orgId: ORG_B };
  const crossed = await testSignOrg("agentcode", AGENTCODE_KEY, ORG_A, "listAgentSnapshots", [scopeB], nowSec(), freshNonce());
  await expectRpcError(verifySignedRpcCall(env, "listAgentSnapshots", [scopeB], crossed), 401, "rpc_unauthorized");
});

test("_NEXT rotation key verifies as fallback", async () => {
  const nextKey = "test-searcher-next-0123456789abcdef";
  const env = testEnv({ AUTH_CALLER_KEY_SEARCHER: undefined, AUTH_CALLER_KEY_SEARCHER_NEXT: nextKey });
  const envelope = await testSignOrg("searcher", nextKey, ORG_A, "listConnectedOrgs", [], nowSec(), freshNonce());
  await verifySignedRpcCall(env, "listConnectedOrgs", [], envelope);
  const wrong = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, "listConnectedOrgs", [], nowSec(), freshNonce());
  await expectRpcError(verifySignedRpcCall(env, "listConnectedOrgs", [], wrong), 401, "rpc_unauthorized");
});

test("enforce-mode happy path: valid envelope reaches the method body", async () => {
  const env = testEnv();
  const auth = new TubotSfAuthEntrypoint({}, env);
  const envelope = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, "listConnectedOrgs", [], nowSec(), freshNonce());
  await auth.listConnectedOrgs(envelope);
});

test("warn mode logs and proceeds on a read-only method with a bad envelope", async () => {
  const warned: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args); };
  try {
    const env = { DB: fakeDb(), AUTH_CALLER_KEY_SEARCHER: SEARCHER_KEY, AUTH_RPC_WARN_MODE: "1" };
    const auth = new TubotSfAuthEntrypoint({}, env);
    const rows = await auth.listConnectedOrgs({ caller: "searcher", timestamp: nowSec(), nonce: freshNonce(), signature: "bogus" });
    expect(rows).toEqual([]);
    expect(warned).toEqual([["listConnectedOrgs", "searcher", "rpc_unauthorized"]]);
    const rows2 = await auth.listConnectedOrgs(undefined);
    expect(rows2).toEqual([]);
    expect(warned[1]).toEqual(["listConnectedOrgs", undefined, "rpc_unauthorized"]);
  } finally {
    console.warn = originalWarn;
  }
});

const EXPECTED_BROKER_METHODS = [
  "authorize", "browserSync", "browserTurn", "confirmInbound", "echo", "resolveFlowRoute", "sessionState", "status", "validate",
];
const EXPECTED_AUTH_METHODS = [
  "listConnectedOrgs", "listAgentSnapshots", "getAgentSnapshot", "inspectSalesforce", "invokeSpeechToTextWithSyntheticAudio",
  "invokeCartReadWithSyntheticWebStore", "invokeDataGraphMetadataWithSyntheticGraph",
  "invokeDataGraphWithContext", "invokeDataGraphByLookupWithContext", "prepareTypedPromptContext",
  "describeFlowCreationContext", "invokeFlowCreationWithContext", "invokeRemainderBookingFlow",
  "invokeFlowLiveSObjectWithContext", "selfProvisionFixtureGrants", "invokeRecordActionWithContext",
  "invokeApprovalActionWithContext", "invokeProcSimpleApprovalWithContext", "invokeNotificationWithContext",
  "invokeNotificationFlowWithContext", "invokeEmailAlertWithContext", "invokeApexRelayWithContext",
  "invokeApexExecWithContext", "invokeApexSObjectRecordWithContext", "invokeAssetReplaceWithContext",
  "invokeDecisionTableWithContext", "invokeApexCsvWithContext", "invokeApexOverlapWithContext",
  "invokeResearchWithContext", "invokeSkippedStandardWithContext", "invokeAgentCustomerWithContext",
  "invokeCommerceLifecycleWithContext", "invokeQuickActionWithContext", "invokeFlowWithContext",
  "invokeFlowContactChain", "invokeFlowVerificationCodeChain", "invokeFlowVerifyLinkedChain",
  "invokeFlowOwnedSubstrateChain", "invokeFlowFaultRepair", "invokeCdpPublishWithContext",
  "invokeCdpRefreshWithContext", "invokeRecordSummaryWithContext", "getCallableToolUrlsForChannel",
  "getTokenForChannel", "listExecutionUsersForChannel", "getTokenForExecutionUser", "getUserData",
  "getUserETag", "saveUserData", "getUserData360", "getMessagingSessionData360", "purgeCache",
  "getUserConversationHistory",
];

function publicMethods(instance: object): string[] {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(instance))
    .filter(name => name !== "constructor" && typeof (instance as Record<string, unknown>)[name] === "function")
    .sort();
}

test("reflective: both entrypoints expose exactly the guarded method set", () => {
  const sabotaged = { DB: { prepare() { throw new Error("D1 must not be touched before the guard"); } } };
  const broker = new MessagingProxyBroker({}, sabotaged);
  const auth = new TubotSfAuthEntrypoint({}, sabotaged);
  expect(publicMethods(broker)).toEqual([...EXPECTED_BROKER_METHODS].sort());
  expect(publicMethods(auth)).toEqual([...EXPECTED_AUTH_METHODS].sort());
});

test("reflective: every public method rejects envelope-less calls with 401 before any side effect", async () => {
  const sabotaged = { DB: { prepare() { throw new Error("D1 must not be touched before the guard"); } } };
  const broker = new MessagingProxyBroker({}, sabotaged) as unknown as Record<string, (...a: never[]) => Promise<unknown>>;
  const auth = new TubotSfAuthEntrypoint({}, sabotaged) as unknown as Record<string, (...a: never[]) => Promise<unknown>>;
  for (const name of EXPECTED_BROKER_METHODS) {
    await expectRpcError(broker[name](), 401, "rpc_unauthorized");
  }
  for (const name of EXPECTED_AUTH_METHODS) {
    await expectRpcError(auth[name](), 401, "rpc_unauthorized");
  }
});

test("fixed per-org vector pins the HKDF derivation and v2 signature", async () => {
  const key = await deriveOrgKey(SEARCHER_KEY, "searcher", ORG_A);
  expect([...key].map(b => b.toString(16).padStart(2, "0")).join(""))
    .toBe("852b02d4f6c0ed397d3171c5af2d6a2cacf5562d741c2fbe132f7fb5002c9e4c");
  const envelope: SignedRpcEnvelope = {
    caller: "searcher",
    org: ORG_A,
    timestamp: "1760400000",
    nonce: "abcdefghijklmnopqrstuvwx",
    signature: "Wt61H1eBOup_SslrTyQPoBbbTpNja1s419xwxE6IhXQ",
  };
  const verified = await verifyPerOrgEnvelopeSignature([SEARCHER_KEY], "listConnectedOrgs", [], envelope, 1760400000);
  expect(verified).toEqual({ caller: "searcher", org: ORG_A });
});

test("KDF is deterministic and sensitive to org, caller, and master", async () => {
  const hexOf = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  const base = hexOf(await deriveOrgKey(SEARCHER_KEY, "searcher", ORG_A));
  expect(hexOf(await deriveOrgKey(SEARCHER_KEY, "searcher", ORG_A))).toBe(base);
  expect(hexOf(await deriveOrgKey(SEARCHER_KEY, "searcher", ORG_B))).not.toBe(base);
  expect(hexOf(await deriveOrgKey(SEARCHER_KEY, "proxy", ORG_A))).not.toBe(base);
  expect(hexOf(await deriveOrgKey(PROXY_KEY, "searcher", ORG_A))).not.toBe(base);
});

test("legacy universal envelopes: rejected by default, dual-accepted with the flag", async () => {
  const legacy = await testSign("searcher", SEARCHER_KEY, "listConnectedOrgs", [], nowSec(), freshNonce());
  await expectRpcError(verifySignedRpcCall(testEnv(), "listConnectedOrgs", [], legacy), 401, "rpc_unauthorized");
  const flagged = testEnv({ AUTH_RPC_ALLOW_LEGACY: "1" });
  const org = await verifySignedRpcCall(flagged, "listConnectedOrgs", [], legacy);
  expect(org).toBe("");
  // Per-org envelopes verify alongside legacy while the flag is set.
  const modern = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, "listConnectedOrgs", [], nowSec(), freshNonce());
  expect(await verifySignedRpcCall(flagged, "listConnectedOrgs", [], modern)).toBe(ORG_A);
});

test("org/scope mismatch and missing scope fail closed on every binding pattern", async () => {
  const scopeB = { ...scopeA, orgId: ORG_B };
  // scope-first (broker) and ref-first (entrypoint) with a sibling org scope.
  for (const [method, args] of [["authorize", [scopeB]], ["inspectSalesforce", [scopeB, []]]] as Array<[string, unknown[]]>) {
    const envelope = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, method, args, nowSec(), freshNonce());
    await expectRpcError(verifySignedRpcCall(testEnv(), method, args, envelope), 401, "rpc_unauthorized");
  }
  // options-index methods with a sibling org scope.
  const channelArgs = ["0Mjxx0000000001AAA", scopeB] as unknown[];
  const channelEnvelope = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, "getTokenForChannel", channelArgs, nowSec(), freshNonce());
  await expectRpcError(verifySignedRpcCall(testEnv(), "getTokenForChannel", channelArgs, channelEnvelope), 401, "rpc_unauthorized");
  const userArgs = ["user-1", "0Mjxx0000000001AAA", scopeB, 60, scopeB] as unknown[];
  const userEnvelope = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, "saveUserData", userArgs, nowSec(), freshNonce());
  await expectRpcError(verifySignedRpcCall(testEnv(), "saveUserData", userArgs, userEnvelope), 401, "rpc_unauthorized");
  // Missing or non-object scope.
  const missingArgs = ["0Mjxx0000000001AAA", undefined] as unknown[];
  const missing = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, "getTokenForChannel", missingArgs, nowSec(), freshNonce());
  await expectRpcError(verifySignedRpcCall(testEnv(), "getTokenForChannel", missingArgs, missing), 401, "rpc_unauthorized");
  // assertOrgBinding unit level: scopeless methods skip, everything else binds.
  assertOrgBinding("listConnectedOrgs", [], ORG_A);
  assertOrgBinding("listExecutionUsersForChannel", ["0Mjxx0000000001AAA"], ORG_A);
  assertOrgBinding("authorize", [scopeA], ORG_A);
  assertOrgBinding("getTokenForChannel", ["0Mjxx0000000001AAA", scopeA], ORG_A);
  await expectRpcError((async () => { assertOrgBinding("authorize", [scopeB], ORG_A); })(), 401, "rpc_unauthorized");
});

test("listConnectedOrgs filters rows to the calling org", async () => {
  const rows = [
    { teamId: "team-a", orgId: ORG_A, channelId: "0Mjxx0000000001AAA" },
    { teamId: "team-b", orgId: ORG_B, channelId: "0Mjxx0000000002AAA" },
  ];
  const env = testEnv({ DB: fakeDb(rows) as unknown as D1Database });
  const auth = new TubotSfAuthEntrypoint({}, env);
  const envelope = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, "listConnectedOrgs", [], nowSec(), freshNonce());
  expect(await auth.listConnectedOrgs(envelope)).toEqual([rows[0]]);
});

test("listExecutionUsersForChannel rejects channels outside the calling org", async () => {
  const channelId = "0Mjxx0000000001AAA";
  const sameOrg = [{ teamId: "team-a", orgId: ORG_A, channelId, integrationUserId: "005xx0000000001AAA", isPrimary: 1 }];
  const auth = new TubotSfAuthEntrypoint({}, testEnv({ DB: fakeDb(sameOrg) as unknown as D1Database }));
  const good = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, "listExecutionUsersForChannel", [channelId], nowSec(), freshNonce());
  const refs = await auth.listExecutionUsersForChannel(channelId, good);
  expect(refs).toHaveLength(1);
  const foreign = [{ teamId: "team-b", orgId: ORG_B, channelId, integrationUserId: "005xx0000000002AAA", isPrimary: 1 }];
  const auth2 = new TubotSfAuthEntrypoint({}, testEnv({ DB: fakeDb(foreign) as unknown as D1Database }));
  const bad = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, "listExecutionUsersForChannel", [channelId], nowSec(), freshNonce());
  try {
    await auth2.listExecutionUsersForChannel(channelId, bad);
  } catch (err) {
    const failure = (err as { failure: { status: number; code: string } }).failure;
    expect(failure.status).toBe(401);
    expect(failure.code).toBe("rpc_unauthorized");
    return;
  }
  throw new Error("expected cross-org channel lookup to fail");
});

test("cross-org matrix: sibling org key material never verifies", async () => {
  // Sign for ORG_A, verify under ORG_B: both the signature and the binding fail.
  const envelope = await testSignOrg("searcher", SEARCHER_KEY, ORG_A, "authorize", [scopeA], nowSec(), freshNonce());
  await expectRpcError(verifySignedRpcCall(testEnv(), "authorize", [scopeA], { ...envelope, org: ORG_B }), 401, "rpc_unauthorized");
  // Sign for ORG_B with a different master: fails even with matching scope.
  const scopeB = { ...scopeA, orgId: ORG_B };
  const foreign = await testSignOrg("searcher", PROXY_KEY, ORG_B, "authorize", [scopeB], nowSec(), freshNonce());
  await expectRpcError(verifySignedRpcCall(testEnv(), "authorize", [scopeB], foreign), 401, "rpc_unauthorized");
});
