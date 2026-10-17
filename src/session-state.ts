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

// Live session handoff state for the proxy guard. SCRT routinely stores
// several MessagingSession rows per conversation (only one carries live
// routing), so the verdict is conversation-level: escalated when ANY row is
// flagged (exact query, no row cap), queue from the flagged row's routing
// when flagged, else from the newest routed row. Session/describe failures
// throw explicit codes (never a negative state); routing-name resolution
// degrades to nulls so a Group-read outage can never silence the escalated
// flag. Unknown sessions return null (callers fail open by design).
export async function resolveSessionState(read:Read,version:string,scope:TenantScope,conversationId:string):Promise<SessionHandoffState|null>{
 let meta:Response;try{meta=await read(`/services/data/${version}/sobjects/MessagingSession/describe`);}catch{throw Error('session_state_transport_unavailable');}
 if(!meta.ok)throw Error('session_state_schema_unavailable');
 let schema:any;try{schema=await meta.json();}catch{throw Error('session_state_schema_invalid_json');}
 const escalate=pickHandoffFields(schema,'Escalate_To_Human__c');
 const where=`Conversation.ConversationIdentifier='${conversationId}' AND MessagingChannelId='${scope.channelId}'`;
 let flaggedId:string|undefined;
 if(escalate.length){
  const flagged=await query(read,version,`SELECT Id FROM MessagingSession WHERE ${where} AND (${escalate.map(f=>`${f}=true`).join(' OR ')}) LIMIT 1`,'session_state_unavailable');
  if(flagged.length&&typeof flagged[0].Id==='string'&&SFID.test(flagged[0].Id))flaggedId=flagged[0].Id;
 }
 const escalated=flaggedId!==undefined;
 const recent=(await query(read,version,`SELECT Id FROM MessagingSession WHERE ${where} ORDER BY CreatedDate DESC LIMIT 10`,'session_state_unavailable'))
  .map(r=>r?.Id).filter((id:any):id is string=>typeof id==='string'&&SFID.test(id));
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
