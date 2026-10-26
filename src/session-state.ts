import type {SessionHandoffState,TenantScope} from '../../tubot-sf-proxy/src/contracts';
type Read=(path:string)=>Promise<Response>;
const SFID=/^[A-Za-z0-9]{15,18}$/;
const FIELD=/^[A-Za-z][A-Za-z0-9_]*$/;
const QUEUE_NAME=/^[A-Za-z][A-Za-z0-9_]{0,79}$/;

// Handoff field discovery from a live MessagingSession describe: exact
// (unpackaged) first, then namespaced twins sorted for determinism — the same
// precedence shape as browser-echo.ts. No org-specific field spelling is
// assumed; orgs carrying both spellings read both and OR the verdict.
export function pickHandoffFields(schema:unknown,base:string):string[]{
 const names=Array.isArray((schema as any)?.fields)?((schema as any).fields as any[]).map(f=>f?.name).filter((n:any)=>typeof n==='string'&&FIELD.test(n)) as string[]:[];
 const exact=names.filter(n=>n===base);
 const namespaced=names.filter(n=>n!==base&&n.endsWith('__'+base)).sort();
 return [...new Set([...exact,...namespaced])];
}

async function query(read:Read,version:string,soql:string,code:string):Promise<any[]>{
 let res:Response;try{res=await read(`/services/data/${version}/query?q=${encodeURIComponent(soql)}`);}catch{throw Error(code);}
 if(!res.ok)throw Error(code);
 let body:any;try{body=await res.json();}catch{throw Error(code);}
 return Array.isArray(body?.records)?body.records:[];
}

// MessagingSession describe cache: the schema only feeds handoff-field
// discovery, so one entry per org+version with a short TTL cuts the
// per-turn describe GET without pinning schema evolution. Keyed by org
// because namespaced handoff twins differ per org; failures are never
// cached, so a describe outage still throws the same codes every call.
// In-flight calls share one GET so a cold burst never stampedes.
// Partitioned by the active fetch transport: a cached describe is only
// valid for the backend that served it. The platform transport never
// changes inside a worker isolate, so in production this behaves as a
// plain per-org cache; a swapped transport starts cold instead of
// risking a schema from another backend.
const DESCRIBE_TTL_MS=5*60*1000;
const DESCRIBE_CACHE_MAX=200;
const noTransport={};
function transportOf():object{
 try{const f=(globalThis as any)?.fetch;return typeof f==='function'?f:noTransport;}catch{return noTransport;}
}
const describeCache=new WeakMap<object,Map<string,{schema:any;expires:number}>>();
const describeInflight=new WeakMap<object,Map<string,Promise<any>>>();
function partition<T>(store:WeakMap<object,Map<string,T>>,transport:object):Map<string,T>{
 let m=store.get(transport);
 if(!m){m=new Map();store.set(transport,m);}
 return m;
}
async function getSchema(read:Read,version:string,orgId:string):Promise<any>{
 const transport=transportOf();
 const cache=partition(describeCache,transport);
 const key=`${version}\n${orgId}`;
 const hit=cache.get(key);
 if(hit&&hit.expires>Date.now())return hit.schema;
 const flying=partition(describeInflight,transport);
 const inflight=flying.get(key);
 if(inflight)return inflight;
 const pending=(async()=>{
  let meta:Response;try{meta=await read(`/services/data/${version}/sobjects/MessagingSession/describe`);}catch{throw Error('session_state_transport_unavailable');}
  if(!meta.ok)throw Error('session_state_schema_unavailable');
  let schema:any;try{schema=await meta.json();}catch{throw Error('session_state_schema_invalid_json');}
  return schema;
 })();
 flying.set(key,pending);
 try{
  const schema=await pending;
  if(cache.size>=DESCRIBE_CACHE_MAX){const oldest=cache.keys().next().value;if(oldest!==undefined)cache.delete(oldest);}
  cache.set(key,{schema,expires:Date.now()+DESCRIBE_TTL_MS});
  return schema;
 }finally{
  if(flying.get(key)===pending)flying.delete(key);
 }
}

// Live session handoff state for the proxy guard. SCRT routinely stores
// several MessagingSession rows per conversation (only one carries live
// routing), so the verdict is conversation-level: escalated when ANY row is
// flagged (exact query, no row cap), queue from the flagged row's routing
// when flagged, else from the newest routed row. Session/describe failures
// throw explicit codes (never a negative state); routing-name resolution
// degrades to nulls so a Group-read outage can never silence the escalated
// flag. Unknown sessions return null (callers fail open by design).
export async function resolveSessionState(read:Read,version:string,scope:TenantScope,conversationId:string):Promise<SessionHandoffState|null>{
 const schema=await getSchema(read,version,scope.orgId);
 const escalate=pickHandoffFields(schema,'Escalate_To_Human__c');
 const where=`Conversation.ConversationIdentifier='${conversationId}' AND MessagingChannelId='${scope.channelId}'`;
 // Flagged-existence and recent-id queries are independent (same SOQL and
 // same 'session_state_unavailable' code as before) so they run in one
 // parallel batch (flagged still initiated first, as before); verdict
 // derivation below is unchanged. Merging them
 // into a single LIMIT 10 query would NOT be equivalent: flagged
 // existence spans every row while recent covers only the newest 10.
 const flaggedPromise=escalate.length
  ?query(read,version,`SELECT Id FROM MessagingSession WHERE ${where} AND (${escalate.map(f=>`${f}=true`).join(' OR ')}) LIMIT 1`,'session_state_unavailable')
  :Promise.resolve([] as any[]);
 const recentPromise=query(read,version,`SELECT Id FROM MessagingSession WHERE ${where} ORDER BY CreatedDate DESC LIMIT 10`,'session_state_unavailable');
 const [flagged,recentRows]=await Promise.all([flaggedPromise,recentPromise]);
 let flaggedId:string|undefined;
 if(flagged.length&&typeof flagged[0].Id==='string'&&SFID.test(flagged[0].Id))flaggedId=flagged[0].Id;
 const escalated=flaggedId!==undefined;
 const recent=recentRows.map(r=>r?.Id).filter((id:any):id is string=>typeof id==='string'&&SFID.test(id));
 if(!recent.length)return null;
 const ids=[...new Set([...(flaggedId?[flaggedId]:[]),...recent])];
 let routing:Record<string,string|null>={};
 try{
  const rows=await query(read,version,`SELECT WorkItemId,QueueId FROM PendingServiceRouting WHERE WorkItemId IN (${ids.map(id=>`'${id}'`).join(',')}) ORDER BY CreatedDate DESC`,'session_state_routing_unavailable');
  for(const r of rows)if(typeof r?.WorkItemId==='string'&&!(r.WorkItemId in routing))routing[r.WorkItemId]=typeof r?.QueueId==='string'&&SFID.test(r.QueueId)?r.QueueId:null;
 }catch{return {escalated,queueName:null,queueId:null};}
 const ordered=[...(flaggedId?[flaggedId]:[]),...recent];
 const routed=ordered.find(id=>id in routing);
 if(routed===undefined)return {escalated,queueName:null,queueId:null};
 const queueId=routing[routed];
 if(queueId===null)return {escalated,queueName:null,queueId:null};
 let group:Response;try{group=await read(`/services/data/${version}/query?q=${encodeURIComponent(`SELECT DeveloperName FROM Group WHERE Id='${queueId}' LIMIT 1`)}`);}catch{return {escalated,queueName:null,queueId};}
 if(!group.ok)return {escalated,queueName:null,queueId};
 let groupBody:any;try{groupBody=await group.json();}catch{return {escalated,queueName:null,queueId};}
 const queueName=groupBody?.records?.[0]?.DeveloperName;
 return {escalated,queueName:typeof queueName==='string'&&QUEUE_NAME.test(queueName)?queueName:null,queueId};
}
