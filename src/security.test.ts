import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import worker, { TubotSfAuthEntrypoint, __resetPanelCredentialCacheForTests } from './index';
import { UserDataCacheStore } from './cache-helper';
import { tenantKey, scopedTags, readJsonBounded, type TenantScope } from './request-security';
import { repairPromptContext } from './prompt-context';
import { retrieveAgentScriptsBatch } from './agent-script';

// Actual SQLite executes all SQL, with independent queries verifying stored state.
const databases: Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	__resetPanelCredentialCacheForTests();
});
const secret = 'audit-channel-secret-'.repeat(3);
const a = { teamId: 'tenant-A', orgId: '00D000000000001AAA', channelId: 'channel-A', channelSecret: secret };
const b = { teamId: 'tenant-B', orgId: '00D000000000002AAA', channelId: 'channel-B', channelSecret: secret };
async function fixture() {
	const sql = new Database(':memory:');
	databases.push(sql);
	sql.exec(`CREATE TABLE panel_salesforce_channels(team_id TEXT,org_id TEXT,channel_id TEXT,
    instance_url TEXT,integration_user_id TEXT,integration_username TEXT,is_sandbox INTEGER,client_id TEXT)`);
	for (const scope of [a, b]) {
		sql
			.query('INSERT INTO panel_salesforce_channels VALUES(?,?,?,?,?,?,?,?)')
			.run(
				scope.teamId,
				scope.orgId,
				scope.channelId,
				'https://audit.my.salesforce.com',
				'005000000000001AAA',
				'audit@tubot.invalid',
				0,
				null,
			);
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
	return { sql, env: { DB: db as any, SF_CREDENTIAL_ENCRYPTION_KEY: '', AUTH_RPC_WARN_MODE: '1' } };
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
	for (const [store, owner] of [
		[ca, 'A'],
		[cb, 'B'],
	] as const) {
		const row = await store.get('same-user');
		expect(JSON.parse(row!.data).owner).toBe(owner);
	}
});
test('security: revoked grants cannot read cached data', async () => {
	const { env, sql } = await fixture();
	await new UserDataCacheStore(env.DB, a).put({ userId: 'victim', data: { private: true } });
	sql.query('DELETE FROM panel_salesforce_channels WHERE team_id=? AND org_id=? AND channel_id=?').run(a.teamId, a.orgId, a.channelId);
	const rpc = new TubotSfAuthEntrypoint({}, env);
	try {
		await rpc.getUserData('victim', a.channelId, a);
		expect.unreachable('revoked channel must not read cached data');
	} catch (err: any) {
		expect(err?.failure?.code).toBe('channel_not_found');
		expect(err?.failure?.status).toBe(404);
	}
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
	const rpc = new TubotSfAuthEntrypoint(ctx, env);
	expect(await rpc.purgeCache(['sf-user-same-user'], a)).toBe(true);
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
	await expect(rpc.getUserData('victim', b.channelId, a)).rejects.toMatchObject({ status: 403 });
	await rpc.saveUserData('victim', a.channelId, { owner: 'A' }, 300, a);
	expect(await rpc.getUserData('victim', a.channelId, a)).toEqual({ owner: 'A' });
	expect(await rpc.getUserData('victim', b.channelId, b)).toBeNull();
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
  const rpc=new TubotSfAuthEntrypoint({},env);
  await expect(rpc.purgeCache(["sf-user-victim"],a)).rejects.toThrow();
  expect(sql.query("SELECT count(*) AS n FROM retained_cache WHERE user_id=?").get(tenantKey(a,"victim"))).toEqual({n:1});
});
