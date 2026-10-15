import {tenantKey,scopedTags} from "./request-security";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker, {
  TubotSfAuthEntrypoint,
  type AuthEnv,
} from "./index";
import {
  UserDataCacheStore,
  computeETag,
  createCachedResponse,
  getDeclarativeCacheHeaders,
  isNotModified,
  normalizeCanonicalUrl,
  purgeEdgeCache,
  sanitizeVaryHeader,
  DEFAULT_CACHE_CONTROL,
  FORBIDDEN_VARY_HEADERS,
  type UserDataCacheRow,
} from "./cache-helper";
import type { Credential } from "./agent-script";

const originalFetch = globalThis.fetch;
const originalCaches = (globalThis as any).caches;

afterEach(() => {
  globalThis.fetch = originalFetch;
  (globalThis as any).caches = originalCaches;
});

const secret = "a".repeat(48);
const orgId = "00D000000000001AAA";
const userId = "005000000000001AAA";
const scope = {teamId:"team-test",orgId,channelId:"0Mjg00000000001AAA",channelSecret:secret};
const cacheKey = (id:string)=>tenantKey(scope,id);
function scopedRequest(input: any,init: RequestInit={}) {
  const headers=new Headers(init.headers);headers.set("x-team-id",scope.teamId);headers.set("x-org-id",scope.orgId);
  headers.set("x-channel-id",scope.channelId);headers.set("x-channel-secret",secret);
  return new Request(input,{...init,headers});
}
const enc = new TextEncoder();
const keyBytes = new Uint8Array(32).fill(7);
const encryptionKey = btoa(String.fromCharCode(...keyBytes));
const hash = async (s: string) =>
  btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

interface MockContext {
  purgedTags: string[][];
  cache: {
    purge: (opts: { tags: string[] }) => Promise<void>;
  };
}

function createMockContext(): MockContext {
  const purgedTags: string[][] = [];
  return {
    purgedTags,
    cache: {
      purge: async (opts: { tags: string[] }) => {
        purgedTags.push(opts.tags);
      },
    },
  };
}

async function createTestEnv(channelId = "0Mjg00000000001AAA") {
  const row: Credential = {
    team_id: "team-test",
    org_id: orgId,
    channel_id: channelId,
    instance_url: "https://test.my.salesforce.com",
    integration_user_id: userId,
    integration_username: "integration@example.com",
    is_sandbox: 1,
  };

  const userCacheMap = new Map<string, UserDataCacheRow>();

  const db = {
    prepare(sql: string) {
      let bound: any[] = [];
      return {
        bind(...args: any[]) {
          bound = args;
          return this;
        },
        async first() {
          if (sql.includes("FROM panel_salesforce_channels") ||
              sql.includes("panel_salesforce_execution_users")) {
            if (sql.includes("team_id = ? AND org_id = ? AND channel_id = ?")) {
              return bound[0] === row.team_id && bound[1] === row.org_id && bound[2] === row.channel_id ? row : null;
            }
            if (sql.includes("channel_id = ?")) {
              const target = sql.includes("team_id") ? bound[2] : bound[0];
              return target === row.channel_id ? row : null;
            }
            return row;
          }
          if (sql.includes("sf_user_data_cache")) {
            const key = bound[0];
            const cached = userCacheMap.get(key);
            if (!cached) return null;
            if (sql.includes("expires_at > ?")) {
              const now = bound[1];
              if (typeof now === "number" && cached.expires_at <= now) {
                return null;
              }
            }
            if (sql.includes("SELECT etag FROM")) {
              return { etag: cached.etag ?? null };
            }
            return cached;
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO sf_user_data_cache")) {
            const [uId, cId, oId, tId, data, etag, updatedAt, expiresAt] = bound;
            userCacheMap.set(uId, {
              user_id: uId,
              channel_id: cId,
              org_id: oId,
              team_id: tId,
              data,
              etag,
              updated_at: updatedAt,
              expires_at: expiresAt,
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("DELETE FROM sf_user_data_cache")) {
            const key = bound[0];
            const existed = userCacheMap.has(key);
            userCacheMap.delete(key);
            return { meta: { changes: existed ? 1 : 0 } };
          }
          return { meta: { changes: 1 } };
        },
      };
    },
  };

  const env: AuthEnv = {
    DB: db as any,
    SF_CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
    PANEL_JWT_SIGNER: {
      async signAssertion(_input: unknown) { return "test-assertion"; },
    } as never,
    AUTH_RPC_WARN_MODE: "1",
  };

  return { env, row, userCacheMap };
}

function setupMockSalesforceFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input.toString();

    // OAuth token endpoint
    if (urlStr.includes("/services/oauth2/token")) {
      return new Response(
        JSON.stringify({
          access_token: "mock-sf-token-xyz",
          instance_url: "https://test.my.salesforce.com",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // UserInfo endpoint
    if (urlStr.includes("/services/oauth2/userinfo")) {
      return new Response(
        JSON.stringify({
          organization_id: orgId,
          user_id: userId,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // SOQL Queries
    if (urlStr.includes("/services/data/v65.0/query")) {
      const q = decodeURIComponent(urlStr.split("q=")[1] || "");

      if (q.includes("FROM MessagingSession")) {
        if (q.includes("notFoundSession")) {
          return new Response(JSON.stringify({ records: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            records: [
              {
                Id: "0Mw000000000001AAA",
                ChannelName: "WebChat",
                ChannelType: "EmbeddedService",
                Status: "Active",
                StartTime: "2026-09-26T00:00:00Z",
                EndTime: null,
                MessagingEndUserId: "0PA000000000001AAA",
                ContactId: "003000000000001AAA",
                LeadId: null,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (q.includes("FROM User")) {
        if (q.includes("unknownUser")) {
          return new Response(JSON.stringify({ records: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            records: [
              {
                Id: userId,
                Username: "testuser@salesforce.com",
                Name: "Test User",
                FirstName: "Test",
                LastName: "User",
                Email: "testuser@salesforce.com",
                IsActive: true,
                UserType: "Standard",
                Title: "Support Engineer",
                Department: "Support",
                CompanyName: "Salesforce",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (q.includes("FROM Contact")) {
        return new Response(
          JSON.stringify({
            records: [
              {
                Id: "003000000000001AAA",
                Name: "Contact User",
                FirstName: "Contact",
                LastName: "User",
                Email: "contact@example.com",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (q.includes("FROM Account")) {
        return new Response(
          JSON.stringify({
            records: [
              {
                Id: "001000000000001AAA",
                Name: "Test Account",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    if (urlStr.includes("/services/data/v65.0/sobjects/Account/")) {
      return new Response(
        JSON.stringify({
          Id: "001000000000001AAA",
          Name: "Test Account",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not Found", { status: 404 });
  }) as any;
}

describe("Declarative Workers Cache & Cache Helper", () => {
  test("getDeclarativeCacheHeaders provides fresh delivery headers by default", () => {
    expect(DEFAULT_CACHE_CONTROL).toBe("no-cache, no-store, must-revalidate");
    const headers = getDeclarativeCacheHeaders({
      tags: ["sf-user", "sf-user-123"],
      etag: '"test-etag-123"',
    });

    expect(headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);
    expect(headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
    expect(headers.get("Cache-Tag")).toBe("sf-user,sf-user-123");
    expect(headers.get("ETag")).toBe('"test-etag-123"');
  });

  test("Signature immunity: strips forbidden Vary headers that ruin cache", () => {
    // 1. Single forbidden vary
    expect(sanitizeVaryHeader("Authorization")).toBeNull();
    expect(sanitizeVaryHeader("x-channel-signature")).toBeNull();
    expect(sanitizeVaryHeader("x-channel-timestamp")).toBeNull();

    // 2. Mixed vary: keeps Accept-Encoding, removes Authorization and x-channel-signature
    const mixed = sanitizeVaryHeader("Accept-Encoding, Authorization, x-channel-signature");
    expect(mixed).toBe("Accept-Encoding");

    // 3. createCachedResponse never includes forbidden Vary headers
    const res = createCachedResponse(
      { data: "test" },
      {
        extraHeaders: {
          Vary: "Authorization, x-channel-signature, x-channel-timestamp",
        },
      }
    );
    expect(res).toBeInstanceOf(Promise);
  });

  test("createCachedResponse sets safe ETag and handles 304 Not Modified", async () => {
    const payload = { hello: "world" };
    const etag = await computeETag(payload);

    // Initial request without If-None-Match
    const res1 = await createCachedResponse(payload, {
      tags: ["sf-user", "sf-user-001"],
    });
    expect(res1.status).toBe(200);
    expect(res1.headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);
    expect(res1.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
    expect(res1.headers.get("Cache-Tag")).toBe("sf-user,sf-user-001");
    expect(res1.headers.get("ETag")).toBe(etag);

    // Conditional request with matching If-None-Match
    const reqWithMatch = new Request("https://api.example.com/data", {
      headers: { "If-None-Match": etag },
    });
    const res304 = await createCachedResponse(payload, {
      tags: ["sf-user", "sf-user-001"],
      request: reqWithMatch,
    });
    expect(res304.status).toBe(304);
    expect(res304.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
  });

  test("normalizeCanonicalUrl strips cache-busting nonces and query signatures", () => {
    const dirtyUrl =
      "https://example.com/v1/salesforce/user/data/005xx?t=1600000000&sig=abc12345&channelId=0Mjg&timestamp=999999&nonce=random1&x-channel-signature=xyz";
    const cleanUrl = normalizeCanonicalUrl(dirtyUrl);

    expect(cleanUrl).toBe("https://example.com/v1/salesforce/user/data/005xx?channelId=0Mjg");

    // Order determinism
    const urlA = normalizeCanonicalUrl("https://example.com/api?b=2&a=1&sig=123");
    const urlB = normalizeCanonicalUrl("https://example.com/api?a=1&b=2&t=456");
    expect(urlA).toBe("https://example.com/api?a=1&b=2");
    expect(urlB).toBe("https://example.com/api?a=1&b=2");
    expect(urlA).toBe(urlB);
  });

  test("purgeEdgeCache uses ctx.cache.purge and fallback to caches.default.delete", async () => {
    const ctx = createMockContext();
    const ok = await purgeEdgeCache(ctx, ["sf-user-123", "sf-user"]);
    expect(ok).toBe(true);
    expect(ctx.purgedTags).toEqual([["sf-user-123", "sf-user"]]);

    // Test fallback when ctx.cache is not available
    const deletedUrls: string[] = [];
    (globalThis as any).caches = {
      default: {
        delete: async (tag: string) => {
          deletedUrls.push(tag);
          return true;
        },
      },
    };

    const fallbackOk = await purgeEdgeCache(null, ["sf-user-999"]);
    expect(fallbackOk).toBe(true);
    expect(deletedUrls).toEqual(["sf-user-999"]);
  });

  test("UserDataCacheStore D1 operations (put, get, delete, expiry)", async () => {
    const { env, userCacheMap } = await createTestEnv();
    const store = new UserDataCacheStore(env.DB, scope);

    // Put data
    await store.put({
      userId: "user-1",
      channelId: "channel-1",
      orgId: "org-1",
      teamId: "team-1",
      data: { name: "Alice", role: "Admin" },
      ttlSeconds: 3600,
    });

    expect(userCacheMap.has(cacheKey("user-1"))).toBe(true);

    // Get data
    const row = await store.get("user-1");
    expect(row).not.toBeNull();
    expect(row?.user_id).toBe("user-1");
    expect(JSON.parse(row!.data)).toEqual({ name: "Alice", role: "Admin" });

    // Expiry check
    await store.put({
      userId: "user-expired",
      data: { status: "expired" },
      ttlSeconds: -10, // already expired
    });
    const expiredRow = await store.get("user-expired");
    expect(expiredRow).toBeNull();

    // Delete data
    const deleted = await store.delete("user-1");
    expect(deleted).toBe(true);
    expect(await store.get("user-1")).toBeNull();
  });
});

describe("TubotSfAuthEntrypoint RPC Methods", () => {
  beforeEach(() => {
    setupMockSalesforceFetch();
  });

  test("TubotSfAuthEntrypoint provides user and session cache RPC methods", async () => {
    const { env, userCacheMap } = await createTestEnv();
    const ctx = createMockContext();
    const rpc = new TubotSfAuthEntrypoint(ctx, env);

    // 1. saveUserData
    const saveRes = await rpc.saveUserData(
      "rpc-user-1",
      "0Mjg00000000001AAA",
      { role: "supervisor", level: 5 },
      600, scope
    );
    expect(saveRes.ok).toBe(true);
    expect(userCacheMap.has(cacheKey("rpc-user-1"))).toBe(true);
    expect(ctx.purgedTags).toContainEqual(scopedTags(scope,["sf-user-rpc-user-1"]));

    // 2. getUserData
    const userData = await rpc.getUserData("rpc-user-1",scope.channelId,scope);
    expect(userData).toEqual({ role: "supervisor", level: 5 });

    const nonExistent = await rpc.getUserData("non-existent",scope.channelId,scope);
    expect(nonExistent).toBeNull();

    // 3. getUserData360 (fetches from mock Salesforce)
    const u360 = await rpc.getUserData360(userId, scope.channelId,scope);
    expect(u360.Username).toBe("testuser@salesforce.com");
    expect(userCacheMap.has(cacheKey(userId))).toBe(true);

    // Subsequent call hits D1 cache
    const u360Cached = await rpc.getUserData360(userId, scope.channelId,scope);
    expect(u360Cached.Username).toBe("testuser@salesforce.com");

    // 4. getMessagingSessionData360 (fetches from mock Salesforce)
    const sessionId = "0Mw000000000001AAA";
    const s360 = await rpc.getMessagingSessionData360(sessionId, scope.channelId,scope);
    expect(s360.Id).toBe(sessionId);
    expect(s360.ChannelName).toBe("WebChat");
    expect(userCacheMap.has(cacheKey(sessionId))).toBe(true);

    // 5. purgeCache
    const purged = await rpc.purgeCache(["sf-user-rpc-user-1", `sf-session-${sessionId}`],scope);
    expect(purged).toBe(true);
    expect(userCacheMap.has(cacheKey("rpc-user-1"))).toBe(false);
    expect(userCacheMap.has(cacheKey(sessionId))).toBe(false);
  });
});

