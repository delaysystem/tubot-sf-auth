import type {BrowserConfig,BrowserSyncEntry,BrowserSyncResult,TenantScope} from '../../tubot-sf-proxy/src/contracts';
import {validGuestId} from './echo-params';
type Read=(path:string)=>Promise<Response>;
type Write=(path:string,body:string)=>Promise<Response>;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sfId=/^[A-Za-z0-9]{15,18}$/;
// Clock/creation skew tolerance (ms) when matching an unbound MessagingSession to a visitor session.
const SYNC_SESSION_LOOKBACK_SLOP_MS=15000;
// Maximum Connect conversation entries fetched per /browser/sync poll.
const SYNC_ENTRIES_RECORD_LIMIT=50;
// Maximum visitor turn text length accepted from Connect transcript entries.
const MAX_SYNC_TURN_TEXT_LEN=4096;
const DEPLOYMENT_RE=/^[A-Za-z][A-Za-z0-9_]{0,159}$/;
const PAGE_NAME_RE=/^[A-Za-z0-9_]+$/;
// Exact host mirror of tubot-sf-app/e2e/get-test-chat-url.ts buildTestChatUrl:
// https://<myDomain>[.<pod>].my.salesforce.com
//   -> https://<myDomain>--<ns>[.<pod>].vf.force.com
function vfHostFor(instanceUrl:string,namespacePrefix:string|null):string{
 const ns=(namespacePrefix||'c').toLowerCase();
 if(!PAGE_NAME_RE.test(ns))throw Error(`invalid namespace: ${namespacePrefix}`);
 const host=new URL(instanceUrl).hostname.toLowerCase();
 const suffix='.my.salesforce.com';
 if(!host.endsWith(suffix))throw Error(`unexpected instance host: ${host}`);
 const labels=host.slice(0,-suffix.length).split('.');
 if(!labels[0])throw Error(`empty My Domain in: ${host}`);
 const pod=labels.slice(1).join('.');
 return `${labels[0]}--${ns}${pod?`.${pod}`:''}.vf.force.com`;
}
// V1 snippet allow-list: the deployment's VF test-page origin joins the site
// origin. The instance host is the scrt host with .my.salesforce-scrt.com
// reversed to .my.salesforce.com; the page namespace comes from a Tooling
// census of the generated ESW<deployment><timestamp> page (newest first,
// same dual-LIKE shape as e2e/web-deploy-shot.ts testChatUrl — LIKE '_'
// is a single-char wildcard, hence the escape plus the collapsed variant).
async function vfTestOrigins(read:Read,version:string,scrtOrigin:string,deployment:string,siteOrigin:string):Promise<string[]>{
 if(!DEPLOYMENT_RE.test(deployment))throw Error('invalid deployment name');
 const scrtHost=new URL(scrtOrigin).hostname.toLowerCase();
 const scrtSuffix='.my.salesforce-scrt.com';
 if(!scrtHost.endsWith(scrtSuffix))throw Error(`unexpected scrt host: ${scrtHost}`);
 const instanceUrl=`https://${scrtHost.slice(0,-scrtSuffix.length)}.my.salesforce.com`;
 const like=`ESW${deployment.replace(/_/g,'\\_')}%`;
 const collapsed=`ESW${deployment.replace(/_/g,'')}%`;
 const where=like===collapsed?`Name LIKE '${like}'`:`(Name LIKE '${like}' OR Name LIKE '${collapsed}')`;
 const res=await read(`/services/data/${version}/tooling/query?q=${encodeURIComponent(`SELECT Name, NamespacePrefix FROM ApexPage WHERE ${where} ORDER BY CreatedDate DESC LIMIT 1`)}`);
 if(!res.ok)throw Error('tooling query unavailable');
 const found:any=await res.json().catch(()=>null);
 const page=found?.records?.[0];
 if(!page?.Name)throw Error('test page not found');
 return [...new Set([siteOrigin,`https://${vfHostFor(instanceUrl,typeof page.NamespacePrefix==='string'?page.NamespacePrefix:null)}`])];
}
export async function browserConfig(read:Read,version:string,scrtOrigin:string,scope:TenantScope,deployment:string,channelAddress:string):Promise<BrowserConfig>{
 const url=new URL('/embeddedservice/v1/embedded-service-config',scrtOrigin);url.search=new URLSearchParams({orgId:scope.orgId,esConfigName:deployment,language:'en_US'}).toString();
 let response:Response;try{response=await fetch(url.toString(),{redirect:'manual',signal:AbortSignal.timeout(20000)});}catch{throw Error('browser_config_transport_unavailable');}if(!response.ok)throw Error('browser_config_unavailable');
 let body:any;try{body=await response.json();}catch{throw Error('browser_config_invalid_json');}const config=body?.embeddedServiceConfig;
 if(config?.deploymentType==='Mobile')throw Error('browser_deployment_type_unsupported');
 if(config?.deploymentType!=='Web'||config?.embeddedServiceMessagingChannel?.channelAddressIdentifier!==channelAddress)throw Error('browser_channel_mismatch');
 let site:URL;try{site=new URL(config.siteUrl);}catch{throw Error('browser_site_invalid');}if(site.protocol!=='https:')throw Error('browser_site_insecure');
 let metadata:Response;try{metadata=await read(`/services/data/${version}/sobjects/MessagingSession/describe`);}catch{throw Error('browser_schema_transport_unavailable');}if(!metadata.ok)throw Error('browser_schema_unavailable');
 let schema:any;try{schema=await metadata.json();}catch{throw Error('browser_schema_invalid_json');}
 const names=((schema.fields||[]) as any[]).map(f=>f?.name).filter((n:any)=>typeof n==='string') as string[];
 const exact=names.filter(n=>n==='Proxy_Echo_Visitor_Ref__c');
 const namespaced=names.filter(n=>n!=='Proxy_Echo_Visitor_Ref__c'&&n.endsWith('__Proxy_Echo_Visitor_Ref__c')).sort();
 // The routing flow variant decides which binding field it writes; orgs with
 // both packaged and unpackaged fields try each in precedence order.
 const visitorFields=[...new Set([...exact,...namespaced])];
 if(!visitorFields.length)throw Error('browser_binding_field_unavailable');
 // Best-effort VF origin: a missing test page (or any lookup failure) keeps
 // the site-only allow-list with a log, never a throw — registration must
 // not fail over the V1 snippet origin.
 let origins=[site.origin];
 try{origins=await vfTestOrigins(read,version,scrtOrigin,deployment,site.origin);}
 catch(cause){console.log(JSON.stringify({event:'browser_vf_origin_fallback',deployment,reason:String((cause as Error)?.message??cause).slice(0,120)}));}
 return {origin:site.origin,origins,apiVersion:version,visitorField:visitorFields[0],visitorFields};
}
export type BrowserVerdict={ok:boolean;code:string;recipient?:string};
// Self-bind: when the routing flow never stamped the visitor reference
// (deployment without the hidden pre-chat field, async flow lag), the
// broker binds it directly — transcript proof first, exactly one unbound
// session row, never overwriting an existing binding — then re-verifies.
// Any failure falls back to binding_absent: callers without a writer and
// orgs where the flow already binds behave exactly as before.
async function selfBind(read:Read,write:Write,scope:TenantScope,config:BrowserConfig,turn:{reference:string;conversationId:string;messageId:string;text:string},fields:string[],entries:Response,query:string):Promise<BrowserVerdict|null>{
 try{
  if(!entries.ok)return null;
  const transcript:any=await entries.json();
  const entry=transcript.conversationEntries?.find((e:any)=>e.identifier===turn.messageId&&e.sender?.role==='EndUser');
  if(entry?.messageText!==transcriptText(turn.text))return null;
  const cols=['Id','Status','MessagingEndUserId',...fields].join(',');
  const lookup=`SELECT ${cols} FROM MessagingSession WHERE Conversation.ConversationIdentifier='${turn.conversationId}' AND MessagingChannelId='${scope.channelId}' ORDER BY CreatedDate ASC LIMIT 10`;
  const found=await read(`/services/data/${config.apiVersion}/query?q=${encodeURIComponent(lookup)}`);
  if(!found.ok)return null;
  const rows:any=await found.json();
  const records:any[]=Array.isArray(rows.records)?rows.records:[];
  if(!records.length||records.some(r=>fields.some(f=>typeof r?.[f]==='string'&&r[f].length>0)))return null;
  const liveRows=records.filter(r=>r?.Status!=='Ended');
  const row=liveRows.length===1?liveRows[0]:records.length===1?records[0]:null;
  if(!row||!sfId.test(row.Id??''))return null;
  const patched=await write(`/services/data/${config.apiVersion}/sobjects/MessagingSession/${row.Id}`,JSON.stringify({[fields[0]]:turn.reference}));
  if(!patched.ok)return null;
  const again=await read(`/services/data/${config.apiVersion}/query?q=${encodeURIComponent(query)}`);
  if(!again.ok)return null;
  const rebound:any=await again.json();
  if(rebound.records?.length!==1)return null;
  const recipient=rebound.records[0]?.MessagingEndUserId;
  return {ok:true,code:'verified',...(validGuestId(recipient)?{recipient}:{})};
 }catch{return null;}
}
export async function verifyBrowserTurn(read:Read,scope:TenantScope,config:BrowserConfig,turn:{reference:string;conversationId:string;messageId:string;text:string},write?:Write):Promise<BrowserVerdict>{
 const fields=(Array.isArray(config.visitorFields)&&config.visitorFields.length?config.visitorFields:[config.visitorField]).filter((f):f is string=>typeof f==='string'&&/^[A-Za-z][A-Za-z0-9_]*$/.test(f));
 if(!/^[a-f0-9]{64}$/.test(turn.reference)||!uuid.test(turn.conversationId)||!uuid.test(turn.messageId)||typeof turn.text!=='string'||!turn.text.length||turn.text.length>4096||!/^v\d+\.\d+$/.test(config.apiVersion)||!fields.length)return {ok:false,code:'invalid_turn'};
 const match=fields.map(f=>`${f}='${turn.reference}'`).join(' OR ');
 const query=`SELECT Id,MessagingEndUserId FROM MessagingSession WHERE Conversation.ConversationIdentifier='${turn.conversationId}' AND MessagingChannelId='${scope.channelId}' AND (${match}) LIMIT 1`;
 const [session,entries]=await Promise.all([read(`/services/data/${config.apiVersion}/query?q=${encodeURIComponent(query)}`),read(`/services/data/${config.apiVersion}/connect/conversation/${turn.conversationId}/entries?recordLimit=1000`)]);if(!session.ok)throw Error('browser_binding_unavailable');
 const sessions:any=await session.json();
 if(sessions.records?.length!==1){
  if(write){
   const bound=await selfBind(read,write,scope,config,turn,fields,entries,query);
   if(bound)return bound;
  }
  // F5: Salesforce accepts the visitor message before committing the
  // MessagingSession row (4-10s Omni-Channel lag). Zero rows for the
  // conversation means commit lag (retryable session_pending), while rows
  // bound to a different visitor stay permanent binding_absent. One extra
  // SOQL on the failure path only; lookup failure keeps old behavior.
  try{
   const exist=await read(`/services/data/${config.apiVersion}/query?q=${encodeURIComponent(`SELECT Id FROM MessagingSession WHERE Conversation.ConversationIdentifier='${turn.conversationId}' AND MessagingChannelId='${scope.channelId}' LIMIT 1`)}`);
   if(exist.ok){
    const exBody:any=await exist.json().catch(()=>null);
    if(Array.isArray(exBody?.records)&&exBody.records.length===0)return {ok:false,code:'session_pending'};
   }
  }catch{/* fall through to binding_absent */}
  return {ok:false,code:'binding_absent'};
 }
 const recipient=sessions.records[0]?.MessagingEndUserId;
 if(!entries.ok)throw Error('browser_entries_unavailable');
 const transcript:any=await entries.json();const entry=transcript.conversationEntries?.find((e:any)=>e.identifier===turn.messageId&&e.sender?.role==='EndUser');
 if(typeof entry?.messageText!=='string')return {ok:false,code:'transcript_mismatch'};
 // Compare the canonical Connect transcript representation, preserving literal
 // entities, whitespace and Unicode rather than trusting browser-provided text.
 if(entry.messageText!==transcriptText(turn.text))return {ok:false,code:'transcript_mismatch'};
 // Pass the verified recipient through so echo skips its duplicate session
 // query; a missing guest id stays verified and echo falls back to the query.
 return {ok:true,code:'verified',...(validGuestId(recipient)?{recipient}:{})};
}
export const transcriptText=(text:string)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export const decodeTranscriptText=(text:string)=>text.replaceAll('&#39;',"'").replaceAll('&quot;','"').replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&');
export async function discoverBrowserTurns(read:Read,scope:TenantScope,config:BrowserConfig,input:{reference:string;conversationId?:string;sinceMs?:number}):Promise<BrowserSyncResult>{
 const fields=(Array.isArray(config.visitorFields)&&config.visitorFields.length?config.visitorFields:[config.visitorField]).filter((f):f is string=>typeof f==='string'&&/^[A-Za-z][A-Za-z0-9_]*$/.test(f));
 if(!/^[a-f0-9]{64}$/.test(input?.reference||'')||!/^v\d+\.\d+$/.test(config.apiVersion)||!fields.length)return {conversationId:null,entries:[]};
 const sinceFloor=typeof input.sinceMs==='number'&&Number.isFinite(input.sinceMs)&&input.sinceMs>0?Math.max(0,input.sinceMs-SYNC_SESSION_LOOKBACK_SLOP_MS):0;
 let conversationId:string|null=null;
 let isUnboundCandidate=false;
 if(typeof input.conversationId==='string'&&uuid.test(input.conversationId)){
  const cols=['Id','Status',...fields].join(',');
  const q=`SELECT ${cols} FROM MessagingSession WHERE Conversation.ConversationIdentifier='${input.conversationId}' AND MessagingChannelId='${scope.channelId}' ORDER BY CreatedDate DESC LIMIT 10`;
  const res=await read(`/services/data/${config.apiVersion}/query?q=${encodeURIComponent(q)}`);
  if(res.ok){
   const data:any=await res.json().catch(()=>null);
   const rows:any[]=Array.isArray(data?.records)?data.records:[];
   if(rows.length){
    if(rows.some(r=>fields.some(f=>typeof r?.[f]==='string'&&r[f].length>0&&r[f]!==input.reference)))return {conversationId:null,entries:[]};
    const boundRow=rows.find(r=>fields.some(f=>r?.[f]===input.reference));
    const liveRow=rows.find(r=>r?.Status!=='Ended');
    const effective=boundRow?(boundRow.Status!=='Ended'?boundRow:(liveRow||boundRow)):(liveRow||rows[0]);
    if(effective?.Status==='Ended')return {conversationId:null,conversationEnded:true,entries:[]};
    conversationId=input.conversationId;
   }
  }
 }
 if(!conversationId){
  const match=fields.map(f=>`${f}='${input.reference}'`).join(' OR ');
  const boundQuery=`SELECT Id,Status,Conversation.ConversationIdentifier FROM MessagingSession WHERE MessagingChannelId='${scope.channelId}' AND Status != 'Ended' AND (${match}) ORDER BY CreatedDate DESC LIMIT 1`;
  const boundRes=await read(`/services/data/${config.apiVersion}/query?q=${encodeURIComponent(boundQuery)}`);
  if(boundRes.ok){
   const boundData:any=await boundRes.json().catch(()=>null);
   const cand=boundData?.records?.[0]?.Conversation?.ConversationIdentifier;
   if(typeof cand==='string'&&uuid.test(cand))conversationId=cand;
  }
 }
 if(!conversationId){
  const unboundFilter=fields.map(f=>`${f} = null`).join(' AND ');
  const createdClause=sinceFloor>0?` AND CreatedDate >= ${new Date(sinceFloor).toISOString()}`:'';
  const unboundQuery=`SELECT Id,Status,Conversation.ConversationIdentifier FROM MessagingSession WHERE MessagingChannelId='${scope.channelId}' AND Status != 'Ended' AND (${unboundFilter})${createdClause} ORDER BY CreatedDate DESC LIMIT 1`;
  const unboundRes=await read(`/services/data/${config.apiVersion}/query?q=${encodeURIComponent(unboundQuery)}`);
  if(unboundRes.ok){
   const unboundData:any=await unboundRes.json().catch(()=>null);
   const cand=unboundData?.records?.[0]?.Conversation?.ConversationIdentifier;
   if(typeof cand==='string'&&uuid.test(cand)){conversationId=cand;isUnboundCandidate=true;}
  }
 }
 if(!conversationId)return {conversationId:null,entries:[]};
 const entriesRes=await read(`/services/data/${config.apiVersion}/connect/conversation/${conversationId}/entries?recordLimit=${SYNC_ENTRIES_RECORD_LIMIT}`);
 if(!entriesRes.ok)return {conversationId:isUnboundCandidate?null:conversationId,entries:[]};
 const body:any=await entriesRes.json().catch(()=>null);
 const rawEntries:any[]=Array.isArray(body?.conversationEntries)?body.conversationEntries:[];
 const entries:BrowserSyncEntry[]=[];
 for(const item of rawEntries){
  if(item?.sender?.role!=='EndUser')continue;
  const messageId=typeof item?.identifier==='string'?item.identifier:'';
  const rawText=typeof item?.messageText==='string'?item.messageText:'';
  if(!uuid.test(messageId)||!rawText.length)continue;
  const text=decodeTranscriptText(rawText);
  if(!text.length||text.length>MAX_SYNC_TURN_TEXT_LEN)continue;
  const timestamp=Number(item?.clientTimestamp||item?.serverReceivedTimestamp||0);
  if(isUnboundCandidate&&sinceFloor>0&&timestamp>0&&timestamp<sinceFloor)continue;
  entries.push({messageId,text,timestamp:Number.isFinite(timestamp)?timestamp:0});
 }
 if(isUnboundCandidate&&entries.length===0)return {conversationId:null,entries:[]};
 entries.sort((a,b)=>a.timestamp-b.timestamp);
 return {conversationId,entries};
}
