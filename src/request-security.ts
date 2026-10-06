/** Shared HTTP boundaries. No credential or identity data is logged. */
export class SecurityError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
	) {
		super(code);
	}
}
export type TenantScope = { teamId: string; orgId: string; channelId: string };
export function requireScope(value: any): TenantScope {
	if (
		!value ||
		!['teamId', 'orgId', 'channelId'].every(
			(k) => typeof value[k] === 'string' && value[k].length > 0 && value[k].length <= 128 && !/[\u0000-\u001f]/.test(value[k]),
		)
	) {
		throw new SecurityError(401, 'tenant_scope_required');
	}
	return { teamId: value.teamId, orgId: value.orgId, channelId: value.channelId };
}
export function tenantKey(scope: TenantScope, id: string): string {
	const valid = requireScope(scope);
	if (typeof id !== 'string' || !id.length || id.length > 512) throw new SecurityError(400, 'invalid_object_id');
	return JSON.stringify([valid.teamId, valid.orgId, valid.channelId, id]);
}
export async function readBodyBounded(request: Pick<Request | Response, 'body' | 'headers'>, maxBytes = 64_000): Promise<Uint8Array> {
	if (!request.body) return new Uint8Array();
	if (Number(request.headers.get('content-length') || 0) > maxBytes) throw new SecurityError(413, 'body_too_large');
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				void reader.cancel().catch(() => {});
				throw new SecurityError(413, 'body_too_large');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
export async function readJsonBounded(request: Request, maxBytes = 64_000): Promise<Record<string, any>> {
	if (!request.body) return {};
	if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
		throw new SecurityError(415, 'json_required');
	}
	const bytes = await readBodyBounded(request, maxBytes);
	try {
		const data = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
		if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
		return data;
	} catch {
		throw new SecurityError(400, 'invalid_json');
	}
}
export function requestScope(request: Request, body: any = {}): TenantScope & { channelSecret: string } {
	const q = new URL(request.url).searchParams;
	const result = {
		teamId: request.headers.get('x-team-id') || body.teamId || q.get('teamId'),
		orgId: request.headers.get('x-org-id') || body.orgId || q.get('orgId'),
		channelId: request.headers.get('x-channel-id') || body.channelId || q.get('channelId'),
		channelSecret: request.headers.get('x-channel-secret') || body.channelSecret,
	};
	requireScope(result);
	if (typeof result.channelSecret !== 'string' || result.channelSecret.length < 32 || result.channelSecret.length > 512)
		throw new SecurityError(401, 'channel_credential_required');
	// Multiple representations must agree; avoid authenticating one tenant and using another.
	for (const key of ['teamId', 'orgId', 'channelId', 'channelSecret'] as const) {
		for (const supplied of [body[key], q.get(key)])
			if (supplied && supplied !== result[key]) throw new SecurityError(403, 'conflicting_tenant_scope');
	}
	return result as TenantScope & { channelSecret: string };
}
export function scopedTags(scope: TenantScope, tags: string[]): string[] {
	requireScope(scope);
	if (
		!Array.isArray(tags) ||
		!tags.length ||
		tags.length > 32 ||
		tags.some((t) => typeof t !== 'string' || !t.length || t.length > 128 || /[\r\n,]/.test(t))
	)
		throw new SecurityError(400, 'invalid_cache_tags');
	return tags.map((t) => 'tenant-' + encodeURIComponent(JSON.stringify([scope.teamId, scope.orgId, scope.channelId])) + '-' + t);
}
