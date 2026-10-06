/** Non-destructive OWASP API checks against actual sf-auth Worker handler.
 * Run from tubot-sf-auth: bun security-review/owasp-endpoints.ts
 * Storage fixtures record every call; network access is forbidden.
 * An exit code of 1 means at least one expected security boundary failed.
 */
import auth from '../src/index';
const results: any[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('Audit forbids external network access'); }) as any;
const calls: any[] = [];
const victim = { user_id: 'victim', team_id: 'other-team', org_id: 'other-org',
  channel_id: 'other-channel', data: JSON.stringify({ privateMarker: 'tenant-B-only' }),
  etag: '"private-etag"', updated_at: 1, expires_at: Math.floor(Date.now()/1000)+3600 };
const db = { prepare(sql: string) { let args: any[] = []; return {
  bind(...values: any[]) { args = values; return this; },
  async first() { calls.push({sql,args}); return sql.includes('sf_user_data_cache') ? victim : null; },
  async run() { calls.push({sql,args}); return {success:true,meta:{changes:1}}; },
  async all() { calls.push({sql,args}); return {results:[]}; },
}; }};
async function probe(service: string, name: string, invoke: () => Promise<Response>, extra?: (r: Response, text: string) => boolean) {
  calls.length = 0;
  try { const response = await invoke(); const body = await response.text();
    results.push({service,name,status:response.status,pass:extra ? extra(response,body) :
      [401,403].includes(response.status),storageCalls:structuredClone(calls),
      response:body.slice(0,500)});
  } catch (e) { results.push({service,name,pass:null,error:String(e)}); }
}
function req(path: string, body?: any, headers: any = {}) { return new Request('https://audit.invalid'+path,
  {method:body===undefined?'GET':'POST',headers:body===undefined?headers:{'content-type':'application/json',...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})}); }
const env = {DB:db,SF_CREDENTIAL_ENCRYPTION_KEY:'',SELF_OAUTH_INTERNAL_HMAC_KEY:'audit-only-key'.repeat(4)} as any;
await probe('tubot-sf-auth','anonymous tenant cache read',()=>auth.fetch(req('/v1/salesforce/user/data/victim'),env));
await probe('tubot-sf-auth','anonymous Data360 cached read',()=>auth.fetch(req('/v1/salesforce/data360/user/victim'),env));
await probe('tubot-sf-auth','anonymous cache overwrite',()=>auth.fetch(req('/v1/salesforce/user/data',
  {userId:'victim',teamId:'attacker',data:{poisoned:true}}),env));
await probe('tubot-sf-auth','oversize body without Content-Length',()=>auth.fetch(req('/v1/salesforce/user/data',
  {userId:'victim',data:'x'.repeat(65000)}),env),r=>[400,413,401,403].includes(r.status));
await probe('tubot-sf-auth','missing OAuth service signature',()=>auth.fetch(req('/internal/self-oauth/start',{}),env));
await probe('tubot-sf-auth','forged OAuth service signature',()=>auth.fetch(req('/internal/self-oauth/start',{},
  {'x-tubot-sf-auth-timestamp':String(Math.floor(Date.now()/1000)),
    'x-tubot-sf-auth-nonce':'a'.repeat(24),'x-tubot-sf-auth-signature':'a'.repeat(43)}),env));
await probe('tubot-sf-auth','missing channel fields rejected before storage',()=>auth.fetch(req('/internal/channels/query',{query:'SELECT Id FROM Account'}),env),r=>r.status===400&&calls.length===0);
globalThis.fetch=originalFetch;
await Bun.write(new URL('./owasp-endpoints.json',import.meta.url),JSON.stringify({
  generatedAt:new Date().toISOString(),scope:'sf-auth only: local actual handler with instrumented storage; no live mutations or network calls',results},null,2)+'\n');
for(const r of results) console.log(`${r.pass===true?'PASS':r.pass===false?'FAIL':'INCONCLUSIVE'} ${r.service}: ${r.name??r.error} ${r.status??''}`);
process.exitCode=results.some(r=>r.pass!==true)?1:0;
