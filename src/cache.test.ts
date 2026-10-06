import {tenantKey,scopedTags} from "./request-security";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker, {
  TubotSfAuthEntrypoint,
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
  type AuthEnv,
  type Credential,
  type UserDataCacheRow,
} from "./index";

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
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, enc.encode("salesforce-secret"))
  );
  const row: Credential = {
    team_id: "team-test",
    org_id: orgId,
    channel_id: channelId,
    instance_url: "https://test.my.salesforce.com",
    client_id: "client-id",
    client_secret_cipher: btoa(String.fromCharCode(...cipher)),
    client_secret_iv: btoa(String.fromCharCode(...iv)),
    integration_user_id: userId,
    channel_secret_hash: await hash(secret),
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
          if (sql.includes("salesforce_auth_credential")) {
            if (sql.includes("channel_id = ?")) {
              return bound[0] === row.channel_id ? row : null;
            }
            return row;
          }
          if (sql.includes("salesforce_channel_connection")) {
            return { secret_hash: row.channel_secret_hash };
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

describe("Salesforce User Data & Data360 HTTP Endpoints", () => {
  beforeEach(() => {
    setupMockSalesforceFetch();
  });

  test("POST /v1/salesforce/user/data and /internal/channels/user/data saves to D1 and purges edge cache", async () => {
    const { env, userCacheMap } = await createTestEnv();
    const ctx = createMockContext();

    const payload = {
      userId: "usr-456",
      channelId: "0Mjg00000000001AAA",
      data: { sessionToken: "token-abc", preferences: { theme: "dark" } },
    };

    // 1. POST /v1/salesforce/user/data
    const req1 = scopedRequest("https://auth.internal/v1/salesforce/user/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const res1 = await worker.fetch(req1, env, ctx);
    expect(res1.status).toBe(201);
    const body1 = (await res1.json()) as any;
    expect(body1.ok).toBe(true);
    expect(body1.userId).toBe("usr-456");
    expect(userCacheMap.has(cacheKey("usr-456"))).toBe(true);
    expect(ctx.purgedTags).toContainEqual(scopedTags(scope,["sf-user-usr-456"]));

    // 2. POST /internal/channels/user/data
    const req2 = scopedRequest("https://auth.internal/internal/channels/user/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: "usr-789",
        sessionContext: { step: "checkout" },
      }),
    });

    const res2 = await worker.fetch(req2, env, ctx);
    expect(res2.status).toBe(201);
    expect(userCacheMap.has(cacheKey("usr-789"))).toBe(true);
  });

  test("GET /v1/salesforce/user/data/:userId returns Declarative Cache headers and safe ETag", async () => {
    const { env } = await createTestEnv();
    const store = new UserDataCacheStore(env.DB, scope);
    await store.put({
      userId: "usr-cached-1",
      data: { email: "user@example.com" },
    });

    const req = scopedRequest("https://auth.internal/v1/salesforce/user/data/usr-cached-1");
    const res = await worker.fetch(req, env);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
    expect(res.headers.get("Cache-Tag")).toBe("sf-user,sf-user-usr-cached-1");
    expect(res.headers.get("ETag")).toBeTruthy();
    expect(res.headers.get("Vary")).toBeNull(); // No forbidden Vary headers!

    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.userId).toBe("usr-cached-1");
    expect(body.data).toEqual({ email: "user@example.com" });

    // Conditional 304 check
    const etag = res.headers.get("ETag")!;
    const req304 = scopedRequest("https://auth.internal/v1/salesforce/user/data/usr-cached-1", {
      headers: { "If-None-Match": etag },
    });
    const res304 = await worker.fetch(req304, env);
    expect(res304.status).toBe(304);
    expect(res304.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
  });

  test("GET /v1/salesforce/user/data/:userId returns 404 for unknown user", async () => {
    const { env } = await createTestEnv();
    const req = scopedRequest("https://auth.internal/v1/salesforce/user/data/unknown-user-999");
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
  });

  test("GET /v1/salesforce/data360/user/:userId queries Salesforce, caches in D1, and returns Declarative Cache headers", async () => {
    const { env, userCacheMap } = await createTestEnv();

    const req = scopedRequest(`https://auth.internal/v1/salesforce/data360/user/${userId}`);
    const res = await worker.fetch(req, env);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
    expect(res.headers.get("Cache-Tag")).toBe(`sf-user,sf-user-${userId}`);
    expect(res.headers.get("Vary")).toBeNull();

    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.userId).toBe(userId);
    expect(body.data?.Username).toBe("testuser@salesforce.com");

    // Verify it was cached in D1
    expect(userCacheMap.has(cacheKey(userId))).toBe(true);

    // Second call should return cached: true
    const resCached = await worker.fetch(req, env);
    expect(resCached.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
    const bodyCached = (await resCached.json()) as any;
    expect(bodyCached.cached).toBe(true);
  });

  test("GET /v1/salesforce/data360/messagingsession/:sessionId queries MessagingSession SOQL, caches in D1, and returns Declarative Cache headers", async () => {
    const { env, userCacheMap } = await createTestEnv();
    const sessionId = "0Mw000000000001AAA";

    const req = scopedRequest(
      `https://auth.internal/v1/salesforce/data360/messagingsession/${sessionId}?t=123456&sig=fake_sig`
    );
    const res = await worker.fetch(req, env);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
    expect(res.headers.get("Cache-Tag")).toBe(`sf-session,sf-session-${sessionId}`);
    expect(res.headers.get("Link")).toContain("rel=\"canonical\"");
    expect(res.headers.get("Vary")).toBeNull();

    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBe(sessionId);
    expect(body.data?.ChannelName).toBe("WebChat");
    expect(body.data?.Status).toBe("Active");

    // Verify cached in D1
    expect(userCacheMap.has(cacheKey(sessionId))).toBe(true);

    // Second call returns cached: true
    const resCached = await worker.fetch(req, env);
    expect(resCached.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
    const bodyCached = (await resCached.json()) as any;
    expect(bodyCached.cached).toBe(true);
  });

  test("POST /v1/salesforce/cache/purge purges cache by tags and removes from D1", async () => {
    const { env, userCacheMap } = await createTestEnv();
    const ctx = createMockContext();
    const store = new UserDataCacheStore(env.DB, scope);

    await store.put({ userId: "user-to-purge", data: { foo: "bar" } });
    await store.put({ userId: "session-to-purge", data: { active: true } });

    expect(userCacheMap.has(cacheKey("user-to-purge"))).toBe(true);
    expect(userCacheMap.has(cacheKey("session-to-purge"))).toBe(true);

    const purgeReq = scopedRequest("https://auth.internal/v1/salesforce/cache/purge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tags: ["sf-user-user-to-purge", "sf-session-session-to-purge"],
      }),
    });

    const res = await worker.fetch(purgeReq, env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.purged).toBe(true);

    // Verify removed from D1
    expect(userCacheMap.has(cacheKey("user-to-purge"))).toBe(false);
    expect(userCacheMap.has(cacheKey("session-to-purge"))).toBe(false);
    expect(ctx.purgedTags).toContainEqual(scopedTags(scope,[
      "sf-user-user-to-purge",
      "sf-session-session-to-purge",
    ]));
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

describe("Fresh Delivery Headers (Live Salesforce & Token Endpoints)", () => {
  beforeEach(() => {
    setupMockSalesforceFetch();
  });

  test("Token endpoint POST /internal/channels/token serves fresh delivery headers", async () => {
    const { env } = await createTestEnv();
    const req = scopedRequest("https://auth.internal/internal/channels/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: "0Mjg00000000001AAA",
      }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
    expect(res.headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);
  });

  test("Live Salesforce query endpoint POST /internal/channels/query serves fresh delivery headers", async () => {
    const { env } = await createTestEnv();
    const req = scopedRequest("https://auth.internal/internal/channels/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: "team-test",
        orgId,
        channelId: "0Mjg00000000001AAA",
        channelSecret: secret,
        soql: "SELECT Id, Name FROM Account LIMIT 1",
      }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
    expect(res.headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);
  });

  test("Live Salesforce read endpoint POST /internal/channels/read serves fresh delivery headers", async () => {
    const { env } = await createTestEnv();
    const req = scopedRequest("https://auth.internal/internal/channels/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: "team-test",
        orgId,
        channelId: "0Mjg00000000001AAA",
        channelSecret: secret,
        objectApiName: "Account",
        recordId: "001000000000001AAA",
      }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
    expect(res.headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);
  });

  test("Error and 404 responses serve fresh delivery headers", async () => {
    const { env } = await createTestEnv();
    const req = scopedRequest("https://auth.internal/v1/salesforce/user/data/unknown-user-999");
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
    expect(res.headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);
  });
});

