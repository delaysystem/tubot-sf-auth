import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import worker, { TubotSfAuthEntrypoint, UserDataCacheStore } from './index';
import { tenantKey, scopedTags, readJsonBounded, type TenantScope } from './request-security';
import { repairPromptContext } from './prompt-context';
import { retrieveAgentScriptsBatch } from './agent-script';

// Actual SQLite executes all SQL, with independent queries verifying stored state.
const databases: Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
const secret = 'audit-channel-secret-'.repeat(3);
const a = { teamId: 'tenant-A', orgId: '00D000000000001AAA', channelId: 'channel-A', channelSecret: secret };
const b = { teamId: 'tenant-B', orgId: '00D000000000002AAA', channelId: 'channel-B', channelSecret: secret };
async function fixture() {
	const sql = new Database(':memory:');
	databases.push(sql);
	sql.exec(`CREATE TABLE salesforce_auth_credential(team_id TEXT,org_id TEXT,channel_id TEXT,
    channel_secret_hash TEXT,instance_url TEXT,client_id TEXT,client_secret_cipher TEXT,
    client_secret_iv TEXT,integration_user_id TEXT);
    CREATE TABLE oauth_token(id TEXT,teamId TEXT,expiresAt INTEGER);
    CREATE TABLE salesforce_channel_connection(teamId TEXT,orgId TEXT,channelId TEXT,channelSecretHash TEXT,oauthTokenId TEXT);`);
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
	const hash = btoa(String.fromCharCode(...digest))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
	for (const scope of [a, b]) {
		sql
			.query('INSERT INTO salesforce_auth_credential VALUES(?,?,?,?,?,?,?,?,?)')
			.run(
				scope.teamId,
				scope.orgId,
				scope.channelId,
				hash,
				'https://audit.my.salesforce.com',
				'audit-client',
				'encrypted',
				'iv',
				'005000000000001AAA',
			);
		sql.query('INSERT INTO oauth_token VALUES(?,?,?)').run(scope.teamId, scope.teamId, Math.floor(Date.now() / 1000) + 3600);
		sql
			.query('INSERT INTO salesforce_channel_connection VALUES(?,?,?,?,?)')
			.run(scope.teamId, scope.orgId, scope.channelId, hash, scope.teamId);
	}
	const db = {
		prepare(query: string) {
			let args: any[] = [];
			return {
				bind(...values: any[]) {
					args = values;
					return this;
				},
				async first() {
					return sql.query(query).get(...args);
				},
				async all() {
					return { results: sql.query(query).all(...args) };
				},
				async run() {
					const result = sql.query(query).run(...args);
					return { success: true, meta: { changes: result.changes } };
				},
			};
		},
	};
	return { sql, env: { DB: db as any, SF_CREDENTIAL_ENCRYPTION_KEY: '' } };
}
function request(path: string, scope?: typeof a, body?: any, headers: Record<string, string> = {}) {
	if (scope)
		headers = {
			...headers,
			'x-team-id': scope.teamId,
			'x-org-id': scope.orgId,
			'x-channel-id': scope.channelId,
			'x-channel-secret': scope.channelSecret,
		};
	return new Request('https://audit.invalid' + path, {
		method: body === undefined ? 'GET' : 'POST',
		headers: {
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
			...headers,
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}
const dataPath = '/v1/salesforce/user/data';

test('security: anonymous cache reads, writes, ETags and token requests fail before mutation', async () => {
	const { env, sql } = await fixture();
	for (const req of [
		request(dataPath + '/victim'),
		request(dataPath + '/victim', undefined, undefined, { 'if-none-match': '*' }),
		request(dataPath, undefined, { userId: 'victim', data: { poison: true } }),
		request('/internal/channels/token', undefined, { channelId: a.channelId }),
	]) {
		expect((await worker.fetch(req, env)).status).toBe(401);
	}
	expect(sql.query("SELECT count(*) AS n FROM sqlite_master WHERE name='sf_user_data_cache_v2'").get()).toEqual({ n: 0 });
});
test('security: cache keys isolate identical object IDs across teams, orgs and channels', async () => {
	const { env, sql } = await fixture();
	const ca = new UserDataCacheStore(env.DB, a),
		cb = new UserDataCacheStore(env.DB, b);
	await ca.put({ userId: 'same-user', data: { owner: 'A' } });
	await cb.put({ userId: 'same-user', data: { owner: 'B' } });
	expect(sql.query('SELECT count(*) AS n FROM sf_user_data_cache_v2').get()).toEqual({ n: 2 });
	expect(sql.query('SELECT data FROM sf_user_data_cache_v2 WHERE user_id=?').get(tenantKey(a, 'same-user'))).toEqual({
		data: '{"owner":"A"}',
	});
	for (const [scope, owner] of [
		[a, 'A'],
		[b, 'B'],
	] as const) {
		const response = await worker.fetch(request(dataPath + '/same-user', scope), env);
		expect(response.status).toBe(200);
		expect(((await response.json()) as any).data.owner).toBe(owner);
		expect(response.headers.get('cache-control')).toContain('no-store');
	}
});
test('security: revoked grants cannot read cached data or obtain a 304 response', async () => {
	const { env, sql } = await fixture();
	const store = new UserDataCacheStore(env.DB, a);
	await store.put({ userId: 'victim', data: { private: true } });
	sql.query('DELETE FROM oauth_token WHERE id=?').run(a.teamId);
	expect(sql.query('SELECT count(*) AS n FROM oauth_token WHERE id=?').get(a.teamId)).toEqual({ n: 0 });
	expect((await worker.fetch(request(dataPath + '/victim', a, undefined, { 'if-none-match': '*' }), env)).status).toBe(403);
});
test('security: wrong channel secrets and conflicting tenant representations are rejected', async () => {
	const { env } = await fixture();
	expect((await worker.fetch(request(dataPath + '/victim', { ...a, channelSecret: 'wrong-secret'.repeat(4) }), env)).status).toBe(403);
	expect((await worker.fetch(request(dataPath, a, { teamId: b.teamId, userId: 'victim', data: { poison: true } }), env)).status).toBe(403);
});
test('security: legacy unscoped cache rows are retained and never returned', async () => {
	const { env, sql } = await fixture();
	sql.exec('CREATE TABLE sf_user_data_cache(user_id TEXT,data TEXT)');
	sql.query('INSERT INTO sf_user_data_cache VALUES(?,?)').run('victim', '{"legacyPrivate":true}');
	expect((await worker.fetch(request(dataPath + '/victim', a), env)).status).toBe(404);
	expect(sql.query('SELECT count(*) AS n FROM sf_user_data_cache').get()).toEqual({ n: 1 });
});
test('security: oversized JSON is bounded by bytes even without or with a false Content-Length', async () => {
	const { env, sql } = await fixture();
	for (const headers of [{}, { 'content-length': '1' }]) {
		expect((await worker.fetch(request(dataPath, a, { userId: 'victim', data: 'x'.repeat(65000) }, headers), env)).status).toBe(413);
	}
	expect(sql.query("SELECT count(*) AS n FROM sqlite_master WHERE name='sf_user_data_cache_v2'").get()).toEqual({ n: 0 });
});
test('security: stream limits count encoded UTF-8 bytes, not character count', async () => {
	const input = new Request('https://audit.invalid', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ text: 'é'.repeat(10) }),
	});
	await expect(readJsonBounded(input, 25)).rejects.toMatchObject({ status: 413 });
});
test('security: authorized cache purge deletes only the verified tenant row and scopes tags', async () => {
	const { env, sql } = await fixture();
	await new UserDataCacheStore(env.DB, a).put({ userId: 'same-user', data: { owner: 'A' } });
	await new UserDataCacheStore(env.DB, b).put({ userId: 'same-user', data: { owner: 'B' } });
	const calls: any[] = [];
	const ctx = {
		cache: {
			async purge(value: any) {
				calls.push(value);
				return true;
			},
		},
	};
	expect((await worker.fetch(request('/v1/salesforce/cache/purge', a, { tags: ['sf-user-same-user'] }), env, ctx)).status).toBe(200);
	expect(sql.query('SELECT data FROM sf_user_data_cache_v2 WHERE user_id=?').get(tenantKey(a, 'same-user'))).toBeNull();
	expect(sql.query('SELECT data FROM sf_user_data_cache_v2 WHERE user_id=?').get(tenantKey(b, 'same-user'))).toEqual({
		data: '{"owner":"B"}',
	});
	expect(calls).toEqual([{ tags: scopedTags(a, ['sf-user-same-user']) }]);
});
test('security: cache RPC requires current channel authorization and tenant scope', async () => {
	const { env } = await fixture();
	const rpc = new TubotSfAuthEntrypoint({}, env);
	await expect(rpc.getUserData('victim')).rejects.toMatchObject({ status: 401 });
	await expect(rpc.getUserData('victim', a.channelId, { ...a, channelSecret: 'wrong'.repeat(10) })).rejects.toMatchObject({ status: 403 });
	await rpc.saveUserData('victim', a.channelId, { owner: 'A' }, 300, a);
	expect(await rpc.getUserData('victim', a.channelId, a)).toEqual({ owner: 'A' });
	expect(await rpc.getUserData('victim', b.channelId, b)).toBeNull();
});
test('security: authorization credentials are excluded from implicit user-data payloads', async () => {
	const { env, sql } = await fixture();
	const result = await worker.fetch(request(dataPath, a, { ...a, userId: 'victim', value: 7 }), env);
	expect(result.status).toBe(201);
	const row = sql.query('SELECT data FROM sf_user_data_cache_v2 WHERE user_id=?').get(tenantKey(a, 'victim')) as any;
	expect(row.data).not.toContain(secret);
	expect(JSON.parse(row.data)).toEqual({ value: 7 });
});
test('security: prompt repair rejects prototype paths and never mutates inherited objects', () => {
	for (const path of ['__proto__.polluted', 'constructor.prototype.polluted', 'prototype.polluted']) {
		const value: Record<string, unknown> = {};
		expect(repairPromptContext(value, `$.${path}: is missing but it is required`)).toBe(false);
		expect(({} as any).polluted).toBeUndefined();
	}
	const inherited = { config: {} };
	const value = Object.create(inherited);
	expect(repairPromptContext(value, '$.config.newValue: is missing but it is required')).toBe(true);
	expect(inherited.config).toEqual({});
	expect(Object.hasOwn(value, 'config')).toBe(true);
});
test('security: metadata API version cannot inject SOAP XML or change request paths', async () => {
	await expect(
		retrieveAgentScriptsBatch({ instanceUrl: 'https://audit.my.salesforce.com', accessToken: 'audit-token' }, ['AuditAgent'], {
			apiVersion: '65.0</met:apiVersion><attack/>',
		}),
	).rejects.toThrow('Invalid Salesforce API version');
});

test("security: a failed cache deletion never returns dummy success", async () => {
  const {env,sql}=await fixture();
  await new UserDataCacheStore(env.DB,a).put({userId:"victim",data:{retained:true}});
  sql.exec("ALTER TABLE sf_user_data_cache_v2 RENAME TO retained_cache");
  const response=await worker.fetch(request("/v1/salesforce/cache/purge",a,{tags:["sf-user-victim"]}),env);
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("retained_cache");
  expect(sql.query("SELECT count(*) AS n FROM retained_cache WHERE user_id=?").get(tenantKey(a,"victim"))).toEqual({n:1});
});
