import {test,expect} from 'bun:test';
import {invokeAppointmentInvitation,INVITATION_CONTEXT_OBJECTS} from './appointment-invitation-context';
const root='/services/data/v67.0',route=root+'/actions/standard/saveAppointmentInvitationDetails',userId='005000000000001AAA';
function fixture(mode='success'){
 const schemas:any={},store=new Map<string,any>();let sequence=1;const stats={calls:0};
 for(const name of INVITATION_CONTEXT_OBJECTS)schemas[name]={queryable:true,createable:true,deletable:true,fields:[]};
 for(const name of ['OperatingHours','ServiceTerritory','WorkType'])schemas[name].fields.push({name:'Name',nameField:true,type:'string',createable:true,filterable:true,length:100});
 for(const [name,field,target] of [['ServiceTerritory','OperatingHoursId','OperatingHours'],['AppointmentInvitation','ServiceTerritoryId','ServiceTerritory'],['AppointmentInvitation','AppointmentTopicId','WorkType'],['AppointmentInvitee','AppointmentInvitationId','AppointmentInvitation'],['AppointmentInvitee','ParticipantServiceResourceId','ServiceResource'],['ServiceResource','RelatedRecordId','User']])schemas[name].fields.push({name:field,type:'reference',createable:true,filterable:true,referenceTo:[target]});
 for(const name of ['BookingStartDate','BookingEndDate','UrlExpiryDate'])schemas.AppointmentInvitation.fields.push({name,type:'date',createable:true});
 schemas.AppointmentInvitation.fields.push({name:'IsActive',type:'boolean',createable:true},{name:'InvitationUrl',type:'url',createable:true});schemas.AppointmentInvitee.fields.push({name:'IsRequiredResource',type:'boolean',createable:true});
 schemas.ServiceResource.createable=false;schemas.ServiceResource.deletable=false;
 const insert=(name:string,values:any)=>{const id='a00000000000'+String(sequence++).padStart(3,'0')+'AAA';store.set(name+'/'+id,{...values,Id:id});return id;};
 insert('ServiceResource',{RelatedRecordId:userId,IsActive:true});
 const existing=mode==='wrong-fixture-id'?insert('WorkType',{Name:'Existing customer configuration'}):undefined;
 const execute=async(path:string,method='GET',body?:any):Promise<any>=>{
  if(path===root+'/composite/batch'){const results=[];for(const v of body.batchRequests){const r=await execute('/services/data/'+v.url,v.method);results.push({statusCode:r.status,result:r.body});}return {status:200,ok:true,body:{results}};}
  if(path===route&&method==='GET')return {status:200,ok:true,body:{inputs:['appointmentInvitationDetails','appointmentInviteeDetails'].map(name=>({name,type:'STRING',required:false})),outputs:[{name:'appointmentInvitationId',type:'STRING'}]}};
  if(path===route){const raw=JSON.parse(body.inputs[0].appointmentInvitationDetails);if(raw.InvitationUrl && typeof raw.InvitationUrl==='object')return {status:400,ok:false,body:[{errorCode:'UNKNOWN_EXCEPTION',message:'Cannot deserialize java.lang.String from Object value (through reference chain: AppointmentInvitationDetails["InvitationUrl"])'}]};let id,url;if(mode!=='false-success'){const restore=(value:any)=>Object.fromEntries(Object.entries(value).map(([k,v])=>[k[0].toUpperCase()+k.slice(1),v]));const details=restore(JSON.parse(body.inputs[0].appointmentInvitationDetails));url='https://example.invalid/'+crypto.randomUUID();id=insert('AppointmentInvitation',{...details,InvitationUrl:url});const actor=restore(JSON.parse(body.inputs[0].appointmentInviteeDetails)[0]);insert('AppointmentInvitee',{...actor,AppointmentInvitationId:id,ParticipantServiceResourceId:mode==='bad-link'?'005000000000099AAA':actor.ParticipantServiceResourceId});}
   return {status:200,ok:true,body:[{isSuccess:mode!=='rejection',errors:[],outputValues:{appointmentInvitationId:mode==='wrong-output'?'a00000000000099AAA':id,appointmentInvitationUrl:url}}]};}
  if(path.includes('/query?')){const q=new URL('https://example.invalid'+path).searchParams.get('q')!,name=q.match(/FROM (\w+)/)![1],conditions=[...q.matchAll(/(\w+)='([^']+)'/g)];return {status:200,ok:true,body:{records:[...store.entries()].filter(([k,v])=>k.startsWith(name+'/')&&conditions.every(([,field,value])=>v[field]===value)&&(!q.includes('IsActive=true')||v.IsActive===true)).map(([,v])=>({...v}))}};}
  const m=path.match(/\/sobjects\/(\w+)(?:\/(.+))?$/)!,name=m[1],tail=m[2];if(tail==='describe')return {status:200,ok:true,body:schemas[name]};
  if(method==='POST'){const id=insert(name,body);return mode==='lost-response'&&name==='WorkType'?{status:502,ok:false,body:{errorCode:'UNAVAILABLE'}}:{status:201,ok:true,body:{id:mode==='wrong-fixture-id'&&name==='WorkType'?existing:id}};}
  if(method==='DELETE'){if(mode==='cleanup-failure'&&name==='AppointmentInvitation')return {status:403,ok:false,body:null};store.delete(name+'/'+tail);return {status:204,ok:true,body:null};}
  const value=store.get(name+'/'+tail);return {status:value?200:404,ok:!!value,body:value?{...value}:null};
 };
 return {store,schemas,stats,invitationPrefixField:'InvitationUrl',connectedOrigin:async()=> 'https://example.invalid',request:async(path:string,method='GET',body?:any)=>{stats.calls++;return execute(path,method,body);},build:async(_name:string,_marker:string,values:any)=>{stats.calls++;return {values};}};
}
test('invitation verifies actual fields, URL and execution-actor relationship, then cleans owned context',async()=>{const f=fixture(),r=await invokeAppointmentInvitation({root,route,userId,...f});expect(r.contextSchema?.verified).toBe(true);expect(r.contextSchema?.ownedRecords).toHaveLength(5);expect(r.contextSchema?.retainedRecords).toHaveLength(1);expect(r.cleanupError).toBeUndefined();expect(f.store.size).toBe(1);expect(f.stats.calls).toBeLessThan(50);});
test('missing actual outcomes, rejected envelopes, wrong output and wrong actor links never become success',async()=>{for(const mode of ['false-success','rejection','wrong-output','bad-link']){const f=fixture(mode),r=await invokeAppointmentInvitation({root,route,userId,...f});expect(r.contextSchema?.verified).toBe(false);expect(f.store.size).toBe(1);}});
test('lost fixture responses are recovered through owned markers',async()=>{const f=fixture('lost-response'),r=await invokeAppointmentInvitation({root,route,userId,...f});expect(r.status).toBe(502);expect(r.cleanupError).toBeUndefined();expect(f.store.size).toBe(1);});
test('a wrong fixture identity cannot authorize deleting existing configuration',async()=>{const f=fixture('wrong-fixture-id'),r=await invokeAppointmentInvitation({root,route,userId,...f});expect(r.contextSchema?.verified).toBe(false);expect(r.cleanupError).toContain('deletion was withheld');expect(f.store.size).toBe(2);expect([...f.store.values()].some(v=>v.Name==='Existing customer configuration')).toBe(true);expect([...f.store.values()].some(v=>typeof v.Name==='string'&&v.Name.startsWith('AS probe '))).toBe(false);});
test('cleanup failures remain explicit',async()=>{const f=fixture('cleanup-failure'),r=await invokeAppointmentInvitation({root,route,userId,...f});expect(r.cleanupError).toBeDefined();});
test('missing permissions and invalid live relationships fail before creation',async()=>{for(const type of ['permission','relationship']){const f=fixture();if(type==='permission')f.schemas.AppointmentInvitation.deletable=false;else f.schemas.AppointmentInvitee.fields=[];const r=await invokeAppointmentInvitation({root,route,userId,...f});expect([403,422]).toContain(r.status);expect(f.store.size).toBe(1);}});

test('live prefix type discovery is saved before retry and invented field names cannot bypass validation',async()=>{
 const f=fixture();delete (f as any).invitationPrefixField;const discovery=await invokeAppointmentInvitation({root,route,userId,...f});expect(discovery.status).toBe(400);expect(discovery.contextSchema?.verified).toBe(false);expect(discovery.contextSchema?.nativeInputTypeFields).toEqual([{name:'InvitationUrl',type:'string',source:'salesforce_live_json_type_validator'}]);expect(f.store.size).toBe(1);
 const saved=JSON.parse(JSON.stringify(discovery.contextSchema));const next=fixture(),actual=await invokeAppointmentInvitation({root,route,userId,...next,invitationPrefixField:saved.nativeInputTypeFields[0].name});expect(actual.contextSchema?.verified).toBe(true);expect(next.store.size).toBe(1);
 const bad=fixture(),rejected=await invokeAppointmentInvitation({root,route,userId,...bad,invitationPrefixField:'fabricatedField'});expect(rejected.contextSchema?.verified).toBe(false);expect(bad.store.size).toBe(1);
});
test('ownership markers fit the 40-char territory name cap',async()=>{
 const f=fixture(),markers:string[]=[],inner=f.request;
 const request=async(path:string,method='GET',body?:any)=>{if(method==='POST'&&path.includes('/sobjects/'))for(const v of Object.values(body))if(typeof v==='string'&&v.startsWith('AS probe '))markers.push(v);return inner(path,method,body);};
 const r=await invokeAppointmentInvitation({root,route,userId,...f,request});
 expect(r.contextSchema?.verified).toBe(true);expect(markers.length).toBeGreaterThan(0);
 for(const m of markers)expect(m.length).toBeLessThanOrEqual(40);
});
