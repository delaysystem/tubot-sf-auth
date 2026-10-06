import {test,expect} from 'bun:test';
import {invokeAppointmentCancellation} from './appointment-cancel-context';
const root='/services/data/v67.0',route=root+'/actions/standard/cancelAppointment';
function fixture(mode='success',attendees=false){
 const store=new Map<string,any>();let sequence=1;
 const existingId='a00000000000999AAA';
 if(mode==='wrong-fixture-id')store.set('ServiceAppointment/'+existingId,{Id:existingId,Subject:'Existing customer appointment',Status:'None'});
 const marker={name:'Subject',type:'string',createable:true,filterable:true,length:255};
 const schemas:any={WorkOrder:{createable:true,deletable:true,queryable:true,fields:[marker]},ServiceAppointment:{createable:true,deletable:true,queryable:true,fields:[marker,
  {name:'ParentRecordId',type:'reference',createable:true,referenceTo:['WorkOrder'],nillable:false},
  ...['EarliestStartTime','DueDate'].map(name=>({name,type:'datetime',createable:true})),
  {name:'Status',type:'picklist',createable:true,updateable:true,picklistValues:[{value:'None',active:true,defaultValue:true},{value:'Canceled',active:true}]}]}};
 schemas.Contact={createable:true,deletable:true,queryable:true,fields:[{...marker,name:'LastName'}]};
 schemas.ServiceAppointment.fields.push({name:'AttendeeLimit',type:'int',createable:true},{name:'AppointmentMode',type:'picklist',createable:true,picklistValues:[{value:'Group',active:true}]});
 schemas.ServiceAppointmentAttendee={createable:true,deletable:true,queryable:true,fields:[{name:'ServiceAppointmentId',type:'reference',referenceTo:['ServiceAppointment'],createable:true,filterable:true},{name:'AttendeeId',type:'reference',referenceTo:['Contact'],createable:true,filterable:true}]};
 const attendeeRoute=root+'/actions/standard/saveServiceAppointmentAttendees';
 const execute=async(path:string,method='GET',body?:any):Promise<any>=>{
  if(path===root+'/composite/batch'){const results=[];for(const item of body.batchRequests){const r=await execute('/services/data/'+item.url,item.method);results.push({statusCode:r.status,result:r.body});}return {status:200,ok:true,body:{results}};}
  if(path===attendeeRoute&&method==='GET')return {status:200,ok:true,body:{inputs:['serviceAppointmentId','attendeesFields'].map(name=>({name,type:'STRING',required:false})),outputs:[{name:'createdCount',type:'INTEGER'}]}};
  if(path===attendeeRoute){let args=JSON.parse(body.inputs[0].attendeesFields)[0];
   if(mode==='strict-json'&&Object.hasOwn(args,'ServiceAppointmentId')) return {status:400,ok:false,body:[{errorCode:'UNKNOWN_EXCEPTION',message:'Unrecognized field "ServiceAppointmentId" (5 known properties: "extendedFields", "name", "email", "attendeeId", "serviceAppointmentAttendeeId"])'}]};
   if(mode==='strict-json')args={ServiceAppointmentId:body.inputs[0].serviceAppointmentId,AttendeeId:args.attendeeId};if(mode!=='false-success'){const id='a00000000000'+String(sequence++).padStart(3,'0')+'AAA';store.set('ServiceAppointmentAttendee/'+id,{...args,AttendeeId:mode==='bad-link'?'a00000000000099AAA':args.AttendeeId,Id:id});}return {status:200,ok:true,body:[{isSuccess:mode!=='rejection',errors:[],outputValues:{createdCount:1}}]};}
  if(path===route&&method==='GET')return {status:200,ok:true,body:{inputs:['recordId','cancelStatus'].map(name=>({name,type:'STRING',required:true})),outputs:[{name:'serviceAppointment',type:'SOBJECT',sobjectType:'ServiceAppointment'}]}};
  if(path===route){const args=body.inputs[0],v=store.get('ServiceAppointment/'+args.recordId);if(mode!=='false-success')v.Status=args.cancelStatus;return {status:200,ok:true,body:[{isSuccess:mode!=='rejection',errors:[],outputValues:{...(mode==="omitted-output"?{}:{serviceAppointment:{...v,Id:mode==="wrong-output"?"a00000000000099AAA":v.Id}}),...(mode==='rejection'?{errorMessage:'Native rejected cancellation'}:{})}}]};}
  if(path.includes('/query?')){const q=new URL('https://example.invalid'+path).searchParams.get('q')!,name=q.match(/FROM (\w+)/)![1],conditions=[...q.matchAll(/(\w+)='([^']+)'/g)];return {status:200,ok:true,body:{records:[...store.entries()].filter(([k,v])=>k.startsWith(name+'/')&&conditions.every(([,field,value])=>v[field]===value)).map(([,v])=>({...v}))}};}
  const m=path.match(/\/sobjects\/(\w+)(?:\/(.+))?$/)!,name=m[1],tail=m[2];if(tail==='describe')return {status:200,ok:true,body:schemas[name]};
  if(method==='POST'){const id='a00000000000'+String(sequence++).padStart(3,'0')+'AAA';store.set(name+'/'+id,{...body,Id:id});return mode==='lost-response'&&name==='ServiceAppointment'?{status:502,ok:false,body:{errorCode:'UNAVAILABLE'}}:{status:201,ok:true,body:{id:mode==='wrong-fixture-id'&&name==='ServiceAppointment'?existingId:id}};}
  if(method==='DELETE'){if(mode==='cleanup-failure'&&name===(attendees?'ServiceAppointmentAttendee':'ServiceAppointment'))return {status:403,ok:false,body:null};store.delete(name+'/'+tail);return {status:204,ok:true,body:null};}
  const v=store.get(name+'/'+tail);return {status:v?200:404,ok:!!v,body:v?{...v}:null};
 };
 return {store,schemas,request:execute,build:async(_name:string,_marker:string,values:any)=>({values})};
}
test('native cancellation requires actual owned status mutation and cleans both records',async()=>{const f=fixture(),r=await invokeAppointmentCancellation({root,route,...f});expect(r.contextSchema?.verified).toBe(true);expect(r.contextSchema?.beforeValue).toBe('None');expect(r.contextSchema?.afterValue).toBe('Canceled');expect(r.cleanupError).toBeUndefined();expect(f.store.size).toBe(0);});
test('HTTP 200 envelopes cannot substitute for a real cancellation',async()=>{for(const mode of ['false-success','rejection']){const f=fixture(mode),r=await invokeAppointmentCancellation({root,route,...f});expect(r.contextSchema?.verified).toBe(false);expect(f.store.size).toBe(0);}});
test('lost create response is recovered through unique ownership and cleaned',async()=>{const f=fixture('lost-response'),r=await invokeAppointmentCancellation({root,route,...f});expect(r.status).toBe(502);expect(r.cleanupError).toBeUndefined();expect(f.store.size).toBe(0);});
test('cleanup failure is explicit',async()=>{const f=fixture('cleanup-failure'),r=await invokeAppointmentCancellation({root,route,...f});expect(r.cleanupError).toBeDefined();});
test('appointment fixture identity mismatch withholds deletion of existing records and cleans actual owned writes',async()=>{
 const f=fixture('wrong-fixture-id'),r=await invokeAppointmentCancellation({root,route,...f});
 expect(r.contextSchema?.verified).toBe(false);expect(r.cleanupError).toContain('deletion was withheld');
 expect(f.store.size).toBe(1);expect([...f.store.values()][0].Subject).toBe('Existing customer appointment');
});
test('live permission and custom status mismatches fail before mutation',async()=>{for(const mode of ['permission','status']){const f=fixture();if(mode==='permission')f.schemas.ServiceAppointment.deletable=false;else f.schemas.ServiceAppointment.fields.find((f:any)=>f.name==='Status').picklistValues=[];const r=await invokeAppointmentCancellation({root,route,...f});expect([403,422]).toContain(r.status);expect(f.store.size).toBe(0);}});

test('native omitted output is accepted only with actual persisted cancellation',async()=>{const f=fixture('omitted-output'),r=await invokeAppointmentCancellation({root,route,...f});expect(r.contextSchema?.verified).toBe(true);expect(r.contextSchema?.nativeOutputEvidence?.kind).toBe('undefined');expect(f.store.size).toBe(0);});
test('contradictory native typed identity is rejected despite actual mutation',async()=>{const f=fixture('wrong-output'),r=await invokeAppointmentCancellation({root,route,...f});expect(r.contextSchema?.verified).toBe(false);expect(f.store.size).toBe(0);});

test('native attendee save verifies the actual Contact relationship and cleans all four records',async()=>{const f=fixture('success',true),r=await invokeAppointmentCancellation({root,route:root+'/actions/standard/saveServiceAppointmentAttendees',...f});expect(r.contextSchema?.verified).toBe(true);expect(r.contextSchema?.ownedRecords).toHaveLength(4);expect(r.cleanupError).toBeUndefined();expect(f.store.size).toBe(0);});
test('native attendee success counts cannot replace actual owned records',async()=>{for(const mode of ['false-success','rejection','bad-link']){const f=fixture(mode,true),r=await invokeAppointmentCancellation({root,route:root+'/actions/standard/saveServiceAppointmentAttendees',...f});expect(r.contextSchema?.verified).toBe(false);expect(f.store.size).toBe(0);}});
test('attendee cleanup failures and live schema mismatches remain explicit',async()=>{const f=fixture('cleanup-failure',true),r=await invokeAppointmentCancellation({root,route:root+'/actions/standard/saveServiceAppointmentAttendees',...f});expect(r.cleanupError).toBeDefined();const other=fixture('success',true);other.schemas.ServiceAppointmentAttendee.fields=[];const rejected=await invokeAppointmentCancellation({root,route:root+'/actions/standard/saveServiceAppointmentAttendees',...other});expect(rejected.status).toBe(422);expect(other.store.size).toBe(0);});

test('attendee wrapper properties come from live validation and require saved evidence before retry',async()=>{
 const first=fixture('strict-json',true),discovery=await invokeAppointmentCancellation({root,route:root+'/actions/standard/saveServiceAppointmentAttendees',...first});
 expect(discovery.status).toBe(400);expect(discovery.contextSchema?.verified).toBe(false);expect(discovery.contextSchema?.attendeePayloadFields).toContain('attendeeId');expect(first.store.size).toBe(0);
 const saved=JSON.parse(JSON.stringify(discovery.contextSchema));const second=fixture('strict-json',true),success=await invokeAppointmentCancellation({root,route:root+'/actions/standard/saveServiceAppointmentAttendees',attendeePayloadFields:saved.attendeePayloadFields,...second});expect(success.contextSchema?.verified).toBe(true);expect(second.store.size).toBe(0);
 const third=fixture('strict-json',true),rejected=await invokeAppointmentCancellation({root,route:root+'/actions/standard/saveServiceAppointmentAttendees',attendeePayloadFields:['inventedField'],...third});expect(rejected.contextSchema?.verified).toBe(false);expect(third.store.size).toBe(0);
});
test('scheduling fixtures are minute-aligned for platform truncation',async()=>{
 const f=fixture();let seen:any=null;
 const request=async(path:string,method='GET',body?:any)=>{if(method==='POST'&&path.endsWith('/sobjects/ServiceAppointment'))seen=body;return f.request(path,method,body);};
 const r=await invokeAppointmentCancellation({root,route,...f,request});
 expect(r.contextSchema?.verified).toBe(true);
 expect(new Date(seen.EarliestStartTime).getUTCSeconds()).toBe(0);
 expect(new Date(seen.EarliestStartTime).getUTCMilliseconds()).toBe(0);
 expect(new Date(seen.DueDate).getUTCSeconds()).toBe(0);
});
test('platform datetime rewrites name the diverged live fields',async()=>{
 const f=fixture(),inner=f.request;
 const request=async(path:string,method='GET',body?:any)=>{const r=await inner(path,method,body);
  if(method==='GET'&&path.includes('/sobjects/ServiceAppointment/')&&!path.endsWith('describe')&&r.ok)
   return {...r,body:{...r.body,DueDate:new Date(Date.parse(r.body.DueDate)+60000).toISOString()}};
  return r;};
 const r=await invokeAppointmentCancellation({root,route,...f,request});
 expect(r.contextSchema?.verified).toBe(false);expect(String(r.body?.message??'')).toContain('DueDate');
});
