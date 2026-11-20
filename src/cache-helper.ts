import {requireScope, tenantKey, type TenantScope} from "./request-security";
/**
 * Declarative Workers Cache and D1 Caching Helpers for tubot-sf-auth
 */

export const DEFAULT_CACHE_CONTROL = "no-cache, no-store, must-revalidate";

export const FORBIDDEN_VARY_HEADERS = [
  "authorization",
  "x-channel-signature",
  "x-channel-timestamp",
  "x-channel-date",
];

const BUSTING_QUERY_PARAMS = new Set([
  "t",
  "_",
  "_t",
  "ts",
  "timestamp",
  "sig",
  "signature",
  "nonce",
  "cb",
  "cachebuster",
  "cache_buster",
  "x-channel-signature",
  "x-channel-timestamp",
]);

/**
 * Computes a safe deterministic ETag for a given payload (string or object).
 */
export async function computeETag(data: unknown): Promise<string> {
  const content = typeof data === "string" ? data : JSON.stringify(data);
  const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const hashArr = Array.from(new Uint8Array(hashBuf));
  const hex = hashArr.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  return `"${hex}"`;
}

/**
 * Checks if the request's If-None-Match header matches the given ETag (including weak ETags and wildcards).
 */
export function isNotModified(request: Request, etag: string): boolean {
  const ifNoneMatch = request.headers.get("if-none-match");
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;

  const cleanEtag = etag.trim();
  const rawCleanEtag = cleanEtag.startsWith("W/") ? cleanEtag.slice(2).trim() : cleanEtag;

  const matches = ifNoneMatch.split(",").map((s) => s.trim());
  return matches.some((item) => {
    if (item === "*") return true;
    if (item === cleanEtag) return true;
    const rawItem = item.startsWith("W/") ? item.slice(2).trim() : item;
    return rawItem === rawCleanEtag;
  });
}

/**
 * Strips forbidden Vary headers (Authorization, x-channel-signature, x-channel-timestamp)
 * that would break edge cacheability.
 */
export function sanitizeVaryHeader(varyHeader: string | null | undefined): string | null {
  if (!varyHeader) return null;
  const parts = varyHeader.split(",").map((s) => s.trim()).filter(Boolean);
  const filtered = parts.filter(
    (part) => !FORBIDDEN_VARY_HEADERS.includes(part.toLowerCase())
  );
  return filtered.length > 0 ? filtered.join(", ") : null;
}

/**
 * Normalizes a URL by stripping cache-busting nonces and query signatures (?t=..., ?sig=..., ?timestamp=...)
 * and sorting remaining query parameters so that cache keys are clean and canonical.
 */
export function normalizeCanonicalUrl(inputUrl: string | URL): string {
  const url = typeof inputUrl === "string" ? new URL(inputUrl) : new URL(inputUrl.toString());

  const keysToDelete: string[] = [];
  url.searchParams.forEach((_, key) => {
    const lower = key.toLowerCase();
    if (
      BUSTING_QUERY_PARAMS.has(lower) ||
      lower.startsWith("x-channel-") ||
      lower.startsWith("x-sig")
    ) {
      keysToDelete.push(key);
    }
  });

  for (const key of keysToDelete) {
    url.searchParams.delete(key);
  }

  url.searchParams.sort();
  return url.toString();
}

export interface CacheHeaderOptions {
  tags?: string[] | string;
  etag?: string;
  cacheControl?: string;
  maxAge?: number;
  sMaxAge?: number;
  staleWhileRevalidate?: number;
}

/**
 * Generates standard Declarative Workers Cache response headers:
 * - Cache-Control: no-cache, no-store, must-revalidate
 * - Cache-Tag: tags joined by comma (e.g. `sf-user,sf-user-${userId}`)
 * - ETag: safe ETag if supplied
 * Ensures forbidden Vary headers are never present.
 */
export function getDeclarativeCacheHeaders(options?: CacheHeaderOptions): Headers {
  const headers = new Headers();

  const cacheControl =
    options?.cacheControl ??
    (options?.maxAge !== undefined || options?.sMaxAge !== undefined
      ? `public, max-age=${options.maxAge ?? 0}, must-revalidate, s-maxage=${options.sMaxAge ?? 300}`
      : DEFAULT_CACHE_CONTROL);

  headers.set("Cache-Control", cacheControl);

  if (options?.tags) {
    const tagArray = Array.isArray(options.tags)
      ? options.tags
      : options.tags.split(",").map((s) => s.trim()).filter(Boolean);
    if (tagArray.length > 0) {
      headers.set("Cache-Tag", tagArray.join(","));
    }
  }

  if (options?.etag) {
    headers.set("ETag", options.etag);
  }

  return headers;
}

/**
 * Creates a cached JSON Response with Declarative Workers Cache headers,
 * safe ETag validation (304 Not Modified if matched), and guaranteed immunity against cache-ruining Vary headers.
 */
export async function createCachedResponse(
  body: unknown,
  options?: CacheHeaderOptions & {
    status?: number;
    requestId?: string;
    request?: Request;
    extraHeaders?: HeadersInit;
  }
): Promise<Response> {
  const content = typeof body === "string" ? body : JSON.stringify(body);
  const etag = options?.etag ?? (await computeETag(content));
  const status = options?.status ?? 200;

  const headers = getDeclarativeCacheHeaders({
    ...options,
    etag,
  });

  headers.set("Content-Type", "application/json");
  if (options?.requestId) {
    headers.set("X-Request-Id", options.requestId);
  }

  if (options?.extraHeaders) {
    const extras = new Headers(options.extraHeaders);
    extras.forEach((val, key) => {
      if (key.toLowerCase() === "vary") {
        const sanitized = sanitizeVaryHeader(val);
        if (sanitized) headers.set("Vary", sanitized);
        else headers.delete("Vary");
      } else if (!headers.has(key)) {
        headers.set(key, val);
      }
    });
  }

  // Double-check no forbidden Vary header exists
  if (headers.has("Vary")) {
    const sanitized = sanitizeVaryHeader(headers.get("Vary"));
    if (sanitized) headers.set("Vary", sanitized);
    else headers.delete("Vary");
  }

  // Safe ETag conditional check (If-None-Match) & Canonical URL Link header
  if (options?.request) {
    try {
      const canonical = normalizeCanonicalUrl(options.request.url);
      headers.set("Link", `<${canonical}>; rel="canonical"`);
    } catch {}

    if (isNotModified(options.request, etag)) {
      return new Response(null, {
        status: 304,
        statusText: "Not Modified",
        headers,
      });
    }
  }

  return new Response(content, {
    status,
    headers,
  });
}

/**
 * Programmatic edge cache purge helper:
 * Uses ctx?.cache?.purge?.({ tags }) with fallback to caches.default.delete()
 */
export async function purgeEdgeCache(ctx: any, tags: string[]): Promise<boolean> {
  if (!tags || tags.length === 0) return true;

  // 1. Try Declarative Workers Cache purge via execution context
  try {
    if (ctx?.cache?.purge && typeof ctx.cache.purge === "function") {
      await ctx.cache.purge({ tags });
      return true;
    }
  } catch (err) {
    console.warn("ctx.cache.purge failed:", err);
  }

  // 2. Fallback to caches.default
  try {
    const defaultCache = (globalThis as any).caches?.default;
    if (defaultCache) {
      if (typeof defaultCache.purge === "function") {
        await defaultCache.purge({ tags });
        return true;
      }
      if (typeof defaultCache.delete === "function") {
        for (const tag of tags) {
          try {
            await defaultCache.delete(tag);
          } catch {}
        }
        return true;
      }
    }
  } catch (err) {
    console.warn("caches.default.delete fallback failed:", err);
  }

  return false;
}

export interface UserDataCacheRow {
  user_id: string;
  channel_id: string | null;
  org_id: string | null;
  team_id: string | null;
  data: string;
  etag?: string | null;
  updated_at: number;
  expires_at: number;
}

export interface PutUserDataInput {
  userId: string;
  channelId?: string | null;
  orgId?: string | null;
  teamId?: string | null;
  data: unknown;
  etag?: string | null;
  ttlSeconds?: number;
}

/**
 * D1 database cache helper for sf_user_data_cache
 */
export class UserDataCacheStore {
  private static ensured = new WeakSet<object>();

  constructor(private db: D1Database, private scope?: TenantScope) {}

  private cacheKey(id: string): string { return tenantKey(requireScope(this.scope), id); }

  async ensureTable(): Promise<void> {
    requireScope(this.scope);
    if (UserDataCacheStore.ensured.has(this.db)) return;
    await this.db.prepare(`CREATE TABLE IF NOT EXISTS sf_user_data_cache_v2 (
      user_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, org_id TEXT NOT NULL, team_id TEXT NOT NULL,
      data TEXT NOT NULL, etag TEXT, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    )`).run();
    // F15: the retention purge predicate (expires_at range) must SEEK.
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS sf_user_data_cache_v2_expires_idx
      ON sf_user_data_cache_v2(expires_at)`).run();
    UserDataCacheStore.ensured.add(this.db);
  }

  async get(userId: string): Promise<UserDataCacheRow | null> {
    await this.ensureTable();
    const now = Math.floor(Date.now() / 1000);
    const row = await this.db
      .prepare("SELECT * FROM sf_user_data_cache_v2 WHERE user_id = ?")
      .bind(this.cacheKey(userId))
      .first<UserDataCacheRow>();

    if (!row) return null;
    if (row.expires_at > 0 && row.expires_at <= now) {
      return null;
    }
    if (row.team_id !== this.scope!.teamId || row.org_id !== this.scope!.orgId || row.channel_id !== this.scope!.channelId) return null;
    return {...row, user_id:userId};
  }

  async getUserETag(userId: string): Promise<string | null> {
    await this.ensureTable();
    const now = Math.floor(Date.now() / 1000);
    try {
      const row = await this.db
        .prepare("SELECT etag FROM sf_user_data_cache_v2 WHERE user_id = ? AND expires_at > ?")
        .bind(this.cacheKey(userId), now)
        .first<{ etag: string | null }>();
      return row?.etag ?? null;
    } catch {
      return null;
    }
  }

  async put(input: PutUserDataInput): Promise<void> {
    await this.ensureTable();
    const now = Math.floor(Date.now() / 1000);
    const ttl = typeof input.ttlSeconds === "number" ? input.ttlSeconds : 86400;
    const expiresAt = now + ttl;
    const rawData = typeof input.data === "string" ? input.data : JSON.stringify(input.data);
    const etag = input.etag ?? (await computeETag(rawData));

    await this.db.prepare(`
      INSERT INTO sf_user_data_cache_v2 (user_id, channel_id, org_id, team_id, data, etag, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        org_id = excluded.org_id,
        team_id = excluded.team_id,
        data = excluded.data,
        etag = excluded.etag,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `).bind(
      this.cacheKey(input.userId),
      this.scope!.channelId,
      this.scope!.orgId,
      this.scope!.teamId,
      rawData,
      etag,
      now,
      expiresAt
    ).run();
  }

  async delete(userId: string): Promise<boolean> {
    await this.ensureTable();
    const res = await this.db
      .prepare("DELETE FROM sf_user_data_cache_v2 WHERE user_id = ?")
      .bind(this.cacheKey(userId))
      .run();
    return (res?.meta?.changes ?? 0) > 0;
  }
}
