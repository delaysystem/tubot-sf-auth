/**
 * Tenant bridge client (auth-worker side of the new-panel bridge contract).
 *
 * Panel contract (exact match with tubot-new-panel/worker/bridge.ts):
 *   POST /internal/bridge/tenants    (header x-bridge-secret, body {})
 *     -> { tenants: [{ teamId, orgId, channelId }] }
 *   POST /internal/bridge/credential (header x-bridge-secret, body { teamId, orgId, channelId })
 *     -> { teamId, orgId, channelId, instanceUrl, clientId, clientSecret, integrationUserId,
 *          integrationUsername, isSandbox } (JWT rows: clientSecret null, username/sandbox set)
 *     or 404 { error: "not_found" }
 *
 * All fetches go through the NEW_PANEL service binding. Fetched secrets are
 * ephemeral: callers must encrypt them into a Credential immediately and never
 * persist or log them. Nothing in this module logs.
 */

export const BRIDGE_TENANTS_PATH = "/internal/bridge/tenants";
export const BRIDGE_CREDENTIAL_PATH = "/internal/bridge/credential";
export const BRIDGE_SECRET_HEADER = "x-bridge-secret";

/** Placeholder origin for binding fetch; the binding routes by path, not host. */
const BRIDGE_ORIGIN = "https://bridge-internal";
/** Defensive cap: bridge payloads are tiny (IDs plus one credential). */
const MAX_BRIDGE_BODY_BYTES = 262_144;
/** Defensive cap on merged tenants; entries are ID-only triples. */
const MAX_BRIDGE_TENANTS = 1000;
/** Retry budget for transient bridge failures (burst load, rolling secret deploys). */
const BRIDGE_MAX_ATTEMPTS = 3;
const BRIDGE_RETRY_DELAYS_MS = [150, 450];
/**
 * Short-TTL caches: a sweep fetches one triple thousands of times. Revocation
 * or new-tenant visibility lags by at most the TTL (60s); acceptable for
 * scanner cadence. Keys are exact triples; entries are cloned on serve so
 * callers can never contaminate each other across requests.
 */
const CREDENTIAL_CACHE_TTL_MS = 60_000;
const CREDENTIAL_CACHE_MAX = 200;
const TENANTS_CACHE_TTL_MS = 60_000;

type CredentialCacheEntry = { payload: BridgeCredentialPayload; expiresAt: number };
const credentialCache = new Map<string, CredentialCacheEntry>();
let tenantsCache: { tenants: BridgeScope[]; expiresAt: number } | null = null;

/** Test-only hooks: module caches persist across tests in one isolate. */
export function clearBridgeCachesForTests(): void {
  credentialCache.clear();
  tenantsCache = null;
}
export function expireBridgeCachesForTests(): void {
  for (const entry of credentialCache.values()) entry.expiresAt = 0;
  if (tenantsCache) tenantsCache.expiresAt = 0;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const credentialCacheKey = (scope: BridgeScope): string =>
  [scope.teamId, scope.orgId, scope.channelId].join("\n");

function isRetriableBridgeError(error: unknown): boolean {
  // Transport failures and 5xx/401 statuses land here. 401 is retried too:
  // secret rotations roll isolates gradually, so a 401 can be transient.
  // 404 (unknown tenant), invalid payloads, and misconfiguration never retry.
  return error instanceof BridgeError && error.code === "bridge_unavailable";
}

async function withBridgeRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetriableBridgeError(error) || attempt >= BRIDGE_MAX_ATTEMPTS - 1) throw error;
      await sleep(BRIDGE_RETRY_DELAYS_MS[Math.min(attempt, BRIDGE_RETRY_DELAYS_MS.length - 1)]);
      attempt += 1;
    }
  }
}

const SF_ID_RE = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
const SALESFORCE_HOST_SUFFIXES = [".my.salesforce.com", ".salesforce.com", ".force.com"];

export interface BridgeScope {
  teamId: string;
  orgId: string;
  channelId: string;
}

export interface BridgeEnv {
  NEW_PANEL?: Fetcher;
  BRIDGE_SHARED_SECRET?: string;
}

export interface BridgeCredentialPayload extends BridgeScope {
  instanceUrl: string;
  clientId: string;
  // Null on JWT rows: the packaged execution client holds no per-row secret.
  clientSecret: string | null;
  integrationUserId: string;
  // JWT rows only: the asserted username and environment bit for minting.
  integrationUsername?: string | null;
  isSandbox?: boolean | null;
}

export class BridgeError extends Error {
  constructor(
    readonly code: "bridge_unconfigured" | "bridge_unavailable" | "bridge_invalid_response",
    readonly status?: number,
  ) {
    super(code);
  }
}

/** Salesforce org/channel ID: 15 or 18 alphanumerics (mirrors panel side). */
export function isValidBridgeSalesforceId(value: unknown): value is string {
  return typeof value === "string" && SF_ID_RE.test(value);
}

/** Team ID: 1..255 chars, no control characters (mirrors panel side). */
export function isValidBridgeTeamId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 255 &&
    !CONTROL_CHARS_RE.test(value)
  );
}

function isValidScope(value: unknown): value is BridgeScope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isValidBridgeTeamId(v.teamId) &&
    isValidBridgeSalesforceId(v.orgId) &&
    isValidBridgeSalesforceId(v.channelId)
  );
}

function isValidInstanceUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      SALESFORCE_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))
    );
  } catch {
    return false;
  }
}

function bridgeRequest(path: string, secret: string, payload: unknown): Request {
  return new Request(BRIDGE_ORIGIN + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", [BRIDGE_SECRET_HEADER]: secret },
    body: JSON.stringify(payload),
  });
}

async function readBridgeJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BRIDGE_BODY_BYTES) {
    throw new BridgeError("bridge_invalid_response", response.status);
  }
  const text = await response.text();
  if (text.length > MAX_BRIDGE_BODY_BYTES) {
    throw new BridgeError("bridge_invalid_response", response.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BridgeError("bridge_invalid_response", response.status);
  }
}

function bridgeBinding(env: BridgeEnv): { binding: Fetcher; secret: string } {
  if (!env.NEW_PANEL || typeof env.NEW_PANEL.fetch !== "function" || !env.BRIDGE_SHARED_SECRET) {
    throw new BridgeError("bridge_unconfigured");
  }
  return { binding: env.NEW_PANEL, secret: env.BRIDGE_SHARED_SECRET };
}

/**
 * List tenant triples enrolled in new-panel. Invalid entries are dropped.
 * Throws BridgeError when unconfigured, unreachable, or malformed; callers
 * serving staging tenants must catch and degrade to staging-only.
 */
export async function fetchBridgeTenants(env: BridgeEnv): Promise<BridgeScope[]> {
  const now = Date.now();
  if (tenantsCache && tenantsCache.expiresAt > now) {
    return tenantsCache.tenants.map((tenant) => ({ ...tenant }));
  }
  const tenants = await withBridgeRetry(() => fetchBridgeTenantsUncached(env));
  tenantsCache = {
    tenants: tenants.map((tenant) => ({ ...tenant })),
    expiresAt: Date.now() + TENANTS_CACHE_TTL_MS,
  };
  return tenants;
}

async function fetchBridgeTenantsUncached(env: BridgeEnv): Promise<BridgeScope[]> {
  const { binding, secret } = bridgeBinding(env);
  let response: Response;
  try {
    response = await binding.fetch(bridgeRequest(BRIDGE_TENANTS_PATH, secret, {}));
  } catch {
    throw new BridgeError("bridge_unavailable");
  }
  const data = await readBridgeJson(response);
  if (!response.ok) {
    throw new BridgeError("bridge_unavailable", response.status);
  }
  if (typeof data !== "object" || data === null || !Array.isArray((data as { tenants?: unknown }).tenants)) {
    throw new BridgeError("bridge_invalid_response", response.status);
  }
  const tenants: BridgeScope[] = [];
  const seen = new Set<string>();
  for (const entry of (data as { tenants: unknown[] }).tenants) {
    if (!isValidScope(entry) || tenants.length >= MAX_BRIDGE_TENANTS) continue;
    const triple = `${entry.teamId}\u0000${entry.orgId}\u0000${entry.channelId}`;
    if (seen.has(triple)) continue;
    seen.add(triple);
    tenants.push({ teamId: entry.teamId, orgId: entry.orgId, channelId: entry.channelId });
  }
  return tenants;
}

/**
 * Fetch one tenant credential by exact triple. Returns null on 404 (unknown
 * tenant). Throws BridgeError on transport failure, non-404 error status, or
 * a payload that fails strict validation. The echoed triple must equal the
 * requested scope exactly; anything else fails closed.
 */
export async function fetchBridgeCredential(
  env: BridgeEnv,
  scope: BridgeScope,
): Promise<BridgeCredentialPayload | null> {
  if (!isValidScope(scope)) return null;
  const key = credentialCacheKey(scope);
  const now = Date.now();
  const hit = credentialCache.get(key);
  if (hit && hit.expiresAt > now) return { ...hit.payload };
  const payload = await withBridgeRetry(() => fetchBridgeCredentialUncached(env, scope));
  if (payload) {
    if (credentialCache.size >= CREDENTIAL_CACHE_MAX) {
      const oldest = credentialCache.keys().next();
      if (!oldest.done) credentialCache.delete(oldest.value);
    }
    credentialCache.set(key, { payload: { ...payload }, expiresAt: Date.now() + CREDENTIAL_CACHE_TTL_MS });
  }
  return payload;
}

async function fetchBridgeCredentialUncached(
  env: BridgeEnv,
  scope: BridgeScope,
): Promise<BridgeCredentialPayload | null> {
  if (!isValidScope(scope)) return null;
  const { binding, secret } = bridgeBinding(env);
  let response: Response;
  try {
    response = await binding.fetch(
      bridgeRequest(BRIDGE_CREDENTIAL_PATH, secret, {
        teamId: scope.teamId,
        orgId: scope.orgId,
        channelId: scope.channelId,
      }),
    );
  } catch {
    throw new BridgeError("bridge_unavailable");
  }
  if (response.status === 404) return null;
  const data = await readBridgeJson(response);
  if (!response.ok) {
    throw new BridgeError("bridge_unavailable", response.status);
  }
  if (
    typeof data !== "object" ||
    data === null ||
    (data as Record<string, unknown>).teamId !== scope.teamId ||
    (data as Record<string, unknown>).orgId !== scope.orgId ||
    (data as Record<string, unknown>).channelId !== scope.channelId
  ) {
    throw new BridgeError("bridge_invalid_response", response.status);
  }
  const row = data as Record<string, unknown>;
  const rowSecret = typeof row.clientSecret === "string" ? row.clientSecret : null;
  const rowUsername = typeof row.integrationUsername === "string" ? row.integrationUsername : null;
  const rowSandbox = typeof row.isSandbox === "boolean" ? row.isSandbox : null;
  if (
    !isValidInstanceUrl(row.instanceUrl) ||
    typeof row.clientId !== "string" ||
    row.clientId.length < 1 ||
    row.clientId.length > 255 ||
    (row.clientSecret != null && rowSecret === null) ||
    (rowSecret !== null && (rowSecret.length < 1 || rowSecret.length > 4096)) ||
    !isValidBridgeSalesforceId(row.integrationUserId) ||
    (rowSecret === null && (rowUsername === null || rowUsername.length < 1 || rowUsername.length > 254)) ||
    (rowSecret === null && rowSandbox === null)
  ) {
    throw new BridgeError("bridge_invalid_response", response.status);
  }
  return {
    teamId: scope.teamId,
    orgId: scope.orgId,
    channelId: scope.channelId,
    instanceUrl: new URL(row.instanceUrl).origin,
    clientId: row.clientId,
    clientSecret: rowSecret,
    integrationUserId: row.integrationUserId,
    integrationUsername: rowUsername,
    isSandbox: rowSandbox,
  };
}
