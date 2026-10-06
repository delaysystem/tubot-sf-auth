import { test, expect } from 'bun:test';
import { invokeWaitlistContext, WAITLIST_CONTEXT_OBJECTS } from './waitlist-action-context';
const root = '/services/data/v67.0', route = root + '/actions/standard/createWaitlist', userId = '005000000000001AAA';
function fixture(mode: 'success' | 'false-success' | 'lost-response' | 'bad-link' | 'cleanup-failure' | 'wrong-fixture-id' = 'success') {
  const store = new Map<string, any>(), schemas: any = {}; let sequence = 1;
  for (const name of WAITLIST_CONTEXT_OBJECTS) schemas[name] = { createable: true, queryable: true, deletable: true, fields: [] };
  for (const name of ['OperatingHours','ServiceTerritory','AppointmentCategory','WorkType','ServiceResource','Waitlist']) schemas[name].fields.push({ name:'Name', nameField:true,createable:true,filterable:true,type:'string',length:80 });
  schemas.AppointmentCategory.fields.push({ name:'IsDropIn',type:'boolean',createable:true });
  for (const [name, field, target] of [['ServiceTerritory','OperatingHoursId','OperatingHours'],['ServiceResource','RelatedRecordId','User'],['WorkType','AppointmentCategoryId','AppointmentCategory'],['ServiceTerritoryMember','ServiceTerritoryId','ServiceTerritory'],['ServiceTerritoryMember','ServiceResourceId','ServiceResource'],['ServiceTerritoryWorkType','ServiceTerritoryId','ServiceTerritory'],['ServiceTerritoryWorkType','WorkTypeId','WorkType'],['Waitlist','ServiceTerritoryId','ServiceTerritory'],['WaitlistWorkType','WaitlistId','Waitlist'],['WaitlistWorkType','WorkTypeId','WorkType'],['WaitlistServiceResource','WaitlistId','Waitlist'],['WaitlistServiceResource','ServiceResourceId','ServiceResource']]) schemas[name].fields.push({name:field,type:'reference',referenceTo:[target],createable:true,filterable:true,nillable:false});
  schemas.ServiceTerritoryMember.fields.push({ name:'EffectiveStartDate',type:'datetime',createable:true });
  const insert = (name: string, body: any) => { const id = 'a00000000000' + String(sequence++).padStart(3,'0') + 'AAA'; store.set(name+'/'+id,{...body,Id:id});return id; };
  insert('ServiceResource',{Name:'AS resource retained configuration',RelatedRecordId:userId,IsActive:true});
  const existing=mode==='wrong-fixture-id'?insert('WorkType',{Name:'Existing customer work type'}):undefined;
  schemas.ServiceResource.createable=false;schemas.ServiceResource.deletable=false;
  const stats={upstreamCalls:0};
  const execute = async (path:string,method='GET',body?:any):Promise<any> => {
    if(path===root+'/composite/batch') {
      const results=[];
      for(const item of body.batchRequests){const r=await execute('/services/data/'+item.url,item.method);results.push({statusCode:r.status,result:r.body});}
      return {status:200,ok:true,body:{results}};
    }
    if(path===route && method==='GET')return {status:200,ok:true,body:{inputs:['waitlistName','serviceTerritoryId','workTypeIds','serviceResourceIds'].map(name=>({name,type:'STRING',required:true})),outputs:[{name:'waitlistId',type:'STRING'}]}};
    if(path===route){const args=body.inputs[0];let id;
      if(mode!=='false-success'){id=insert('Waitlist',{Name:args.waitlistName,ServiceTerritoryId:args.serviceTerritoryId});insert('WaitlistWorkType',{WaitlistId:id,WorkTypeId:mode==='bad-link'?userId:args.workTypeIds});insert('WaitlistServiceResource',{WaitlistId:id,ServiceResourceId:args.serviceResourceIds});}
      return {status:200,ok:true,body:[{isSuccess:true,errors:[],outputValues:{waitlistId:id}}]};}
    if(path.includes('/query?')){const q=new URL('https://example.invalid'+path).searchParams.get('q')!, name=q.match(/FROM (\w+)/)![1], conditions=[...q.matchAll(/(\w+)='([^']+)'/g)];return {status:200,ok:true,body:{records:[...store.entries()].filter(([k,v])=>k.startsWith(name+'/')&&conditions.every(([,field,value])=>v[field]===value)).map(([,v])=>({Id:v.Id}))}};}
    const match=path.match(/\/sobjects\/(\w+)(?:\/(.+))?$/)!,name=match[1],tail=match[2];
    if(tail==='describe')return {status:200,ok:true,body:schemas[name]};
    if(method==='POST'){const id=insert(name,body);return mode==='lost-response'&&name==='WorkType'?{status:502,ok:false,body:{errorCode:'UNAVAILABLE'}}:{status:201,ok:true,body:{id:mode==='wrong-fixture-id'&&name==='WorkType'?existing:id}};}
    if(method==='DELETE'){if(mode==='cleanup-failure'&&name==='Waitlist')return {status:403,ok:false,body:null};store.delete(name+'/'+tail);return {status:204,ok:true,body:null};}
    const value=store.get(name+'/'+tail);const actual=value?{...value}:null;
    // Salesforce persists Scheduler datetime values at whole-second precision.
    if(actual?.EffectiveStartDate)actual.EffectiveStartDate=actual.EffectiveStartDate.replace(/\.\d{3}Z$/,'.000+0000');
    return {status:value?200:404,ok:!!value,body:actual};
  };
  const request=async(path:string,method='GET',body?:any)=>{stats.upstreamCalls++;return execute(path,method,body);};
  return {store,schemas,request,stats,build:async(_name:string,_marker:string,values:any)=>{
    // The production builder reads one live object schema before constructing values.
    stats.upstreamCalls++;return {values};
  }};
}
test('waitlist action verifies the actual owned output and both associations, then deletes all context',async()=>{
 const f=fixture(),r=await invokeWaitlistContext({root,route,userId,...f});
 expect(r.contextSchema?.verified).toBe(true);expect(r.status).toBe(200);expect(r.contextSchema?.ownedRecords).toHaveLength(9);expect(f.store.size).toBe(1);expect(r.contextSchema?.retainedRecords).toHaveLength(1);expect(r.cleanupError).toBeUndefined();
 expect(f.stats.upstreamCalls).toBeLessThan(50);
});
test('waitlist envelopes without persisted outcomes and wrong associations never become success',async()=>{
 for(const mode of ['false-success','bad-link'] as const){const f=fixture(mode),r=await invokeWaitlistContext({root,route,userId,...f});expect(r.contextSchema?.verified).toBe(false);expect(r.status).toBe(422);expect(f.store.size).toBe(1);}
});
test('waitlist fixture lost responses are recovered using marker ownership and removed',async()=>{
 const f=fixture('lost-response'),r=await invokeWaitlistContext({root,route,userId,...f});expect(r.status).toBe(502);expect(r.contextSchema?.verified).toBe(false);expect(f.store.size).toBe(1);expect(r.cleanupError).toBeUndefined();
});
test('waitlist cleanup failures remain explicit',async()=>{
 const f=fixture('cleanup-failure'),r=await invokeWaitlistContext({root,route,userId,...f});expect(r.cleanupError).toBeDefined();expect(f.store.size).toBe(2);
});
test('waitlist missing permissions and altered relationship schemas fail before any fixture is created',async()=>{
 for(const field of ['permission','relationship']){const f=fixture();if(field==='permission')f.schemas.Waitlist.deletable=false;else f.schemas.ServiceTerritory.fields=[];const r=await invokeWaitlistContext({root,route,userId,...f});expect([403,422]).toContain(r.status);expect(f.store.size).toBe(1);}
});
test('waitlist recovery deletes actual owned fixtures while preserving a mismatched existing identity',async()=>{
 const f=fixture('wrong-fixture-id'),r=await invokeWaitlistContext({root,route,userId,...f});
 expect(r.contextSchema?.verified).toBe(false);expect(r.cleanupError).toContain('deletion was withheld');
 expect(f.store.size).toBe(2);expect([...f.store.values()].some(row=>row.Name==='Existing customer work type')).toBe(true);
});
test('waitlist member uses Secondary territory type when the live describe advertises it',async()=>{
 const f=fixture();
 f.schemas.ServiceTerritoryMember.fields.push({name:'TerritoryType',type:'picklist',createable:true});
 const posts:Array<any>=[];
 const inner=f.request;
 const r=await invokeWaitlistContext({root,route,userId,store:f.store,schemas:f.schemas,build:f.build,request:async(path:string,method='GET',body?:any)=>{if(path.endsWith('/sobjects/ServiceTerritoryMember')&&method==='POST')posts.push(body);return inner(path,method,body);}});
 expect(r.contextSchema?.verified).toBe(true);expect(posts.length).toBe(1);expect(posts[0].TerritoryType).toBe('S');
});
test('ownership markers fit the 40-char territory name cap',async()=>{
  const f=fixture(),markers:string[]=[],inner=f.request;
  const request=async(path:string,method='GET',body?:any)=>{if(method==='POST'&&path.includes('/sobjects/'))for(const v of Object.values(body))if(typeof v==='string'&&v.startsWith('AS probe '))markers.push(v);return inner(path,method,body);};
  const r=await invokeWaitlistContext({root,route,userId,...f,request});
  expect(r.contextSchema?.verified).toBe(true);expect(markers.length).toBeGreaterThan(0);
  for(const m of markers)expect(m.length).toBeLessThanOrEqual(40);
});
