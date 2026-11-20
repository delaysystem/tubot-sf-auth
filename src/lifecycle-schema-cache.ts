type Result = { status: number; ok: boolean; body: any };
type Request = (path: string, method?: string, body?: unknown) => Promise<Result>;
/** Cache only metadata inside one authenticated lifecycle; records stay live. */
export function cacheLifecycleSchema(root: string, transport: Request): Request {
  const cache = new Map<string, Result>();
  const metadata = (path: string) => path.startsWith(root + "/") && /\/(?:sobjects\/[A-Za-z][A-Za-z0-9_]*\/describe|actions\/(?:standard|custom\/apex)\/[A-Za-z][A-Za-z0-9_.]*)$/.test(path);
  return async (path, method = "GET", body) => {
    if (method === "GET" && metadata(path) && cache.has(path)) return cache.get(path)!;
    const result = await transport(path, method, body);
    if (method !== "GET" && /\/sobjects\/(?:PermissionSet|FieldPermissions|ObjectPermissions)(?:\/|$)/.test(path)) cache.clear();
    if (result.ok && method === "GET" && metadata(path)) cache.set(path, result);
    const batch = body as { batchRequests?: Array<{ method?: string; url?: string }> } | undefined;
    if (result.ok && path === root + "/composite/batch" && Array.isArray(batch?.batchRequests) && Array.isArray(result.body?.results)) {
      batch.batchRequests.forEach((entry, index) => {
        const response = result.body.results[index];
        const url = typeof entry.url === "string" ? (entry.url.startsWith("/") ? entry.url : "/services/data/" + entry.url) : "";
        if (entry.method === "GET" && metadata(url) && response?.statusCode === 200) cache.set(url, { status: 200, ok: true, body: response.result });
      });
    }
    return result;
  };
}
