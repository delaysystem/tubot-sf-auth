import type {BrowserConfig,TenantScope} from '../../tubot-sf-proxy/src/contracts';
type Read=(path:string)=>Promise<Response>;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
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
 return {origin:site.origin,apiVersion:version,visitorField:visitorFields[0],visitorFields};
}
export type BrowserVerdict={ok:boolean;code:string};
export async function verifyBrowserTurn(read:Read,scope:TenantScope,config:BrowserConfig,turn:{reference:string;conversationId:string;messageId:string;text:string}):Promise<BrowserVerdict>{
 const fields=(Array.isArray(config.visitorFields)&&config.visitorFields.length?config.visitorFields:[config.visitorField]).filter((f):f is string=>typeof f==='string'&&/^[A-Za-z][A-Za-z0-9_]*$/.test(f));
 if(!/^[a-f0-9]{64}$/.test(turn.reference)||!uuid.test(turn.conversationId)||!uuid.test(turn.messageId)||typeof turn.text!=='string'||!turn.text.length||turn.text.length>4096||!/^v\d+\.\d+$/.test(config.apiVersion)||!fields.length)return {ok:false,code:'invalid_turn'};
 const match=fields.map(f=>`${f}='${turn.reference}'`).join(' OR ');
 const query=`SELECT Id FROM MessagingSession WHERE Conversation.ConversationIdentifier='${turn.conversationId}' AND MessagingChannelId='${scope.channelId}' AND (${match}) LIMIT 1`;
 const session=await read(`/services/data/${config.apiVersion}/query?q=${encodeURIComponent(query)}`);if(!session.ok)throw Error('browser_binding_unavailable');
 const sessions:any=await session.json();if(sessions.records?.length!==1)return {ok:false,code:'binding_absent'};
 const entries=await read(`/services/data/${config.apiVersion}/connect/conversation/${turn.conversationId}/entries?recordLimit=1000`);if(!entries.ok)throw Error('browser_entries_unavailable');
 const transcript:any=await entries.json();const entry=transcript.conversationEntries?.find((e:any)=>e.identifier===turn.messageId&&e.sender?.role==='EndUser');
 if(typeof entry?.messageText!=='string')return {ok:false,code:'transcript_mismatch'};
 // Compare the canonical Connect transcript representation, preserving literal
 // entities, whitespace and Unicode rather than trusting browser-provided text.
 return entry.messageText===transcriptText(turn.text)?{ok:true,code:'verified'}:{ok:false,code:'transcript_mismatch'};
}
export const transcriptText=(text:string)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
