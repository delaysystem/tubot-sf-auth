import { expect,test } from 'bun:test';
import { invokeOwnedFlowCreation } from './owned-flow-creation-context';
const root='/services/data/v67.0',route=root+'/actions/custom/flow/LiveCreateChild';
const customerAccount='001000000000099AAA',customerParent='a00000000000099AAA';
function fixture(mode='normal'){
  let sequence=1;const rows=new Map<string,any>(),calls:Array<{path:string;method:string;body:any}>=[];
  rows.set('Account/'+customerAccount,{Id:customerAccount,Name:'Existing customer account'});
  rows.set('Parent/'+customerParent,{Id:customerParent,Name:'Existing customer parent',AccountId:customerAccount});
  const marker={name:'Name',type:'string',nameField:true,createable:true,filterable:true,length:mode==='short-marker'?44:80};
  const schemas:any={Account:{name:'Account',createable:true,queryable:true,deletable:mode!=='missing-access',fields:[marker]},
    Parent:{name:'Parent',createable:true,queryable:true,deletable:true,fields:[marker,{name:'AccountId',type:'reference',referenceTo:['Account'],createable:true,nillable:false}]}};
  const insert=(name:string,values:any)=>{const id='a00000000000'+String(sequence++).padStart(3,'0')+'AAA';rows.set(name+'/'+id,{...values,Id:id});return id;};
  const reply=(status:number,body:any)=>({status,ok:status>=200&&status<300,body});
  const request=async(path:string,method='GET',body?:any):Promise<any>=>{
    calls.push({path,method,body});
    if(path.endsWith('/composite/batch')){const results=[];for(const item of body.batchRequests){const result=await request('/services/data/'+item.url,item.method);results.push({statusCode:result.status,result:result.body});}return reply(200,{results});}
    if(path===route){const values=body.inputs[0];insert('Child',{ParentId:values.parent.Id,Body:values.text});return mode==='lost-native'?reply(502,{errorCode:'LOST'}):reply(200,[{isSuccess:mode!=='native-rejection',errors:mode==='native-rejection'?[{errorCode:'REJECTED'}]:[],outputValues:mode==='nested-rejection'?{isSuccess:false}:{}}]);}
    if(path.includes('/query?')){const query=decodeURIComponent(path),name=query.match(/ FROM (\w+) WHERE/)![1],conditions=[...query.matchAll(/(\w+)='([^']+)'/g)];return reply(200,{records:[...rows.entries()].filter(([key,row])=>key.startsWith(name+'/')&&conditions.every(([,field,value])=>row[field]===value)).map(([,row])=>({Id:row.Id}))});}
    const parts=path.match(/\/sobjects\/(\w+)(?:\/(.+))?$/)!,name=parts[1],tail=parts[2];
    if(tail==='describe')return reply(200,schemas[name]);
    if(method==='POST'){const id=insert(name,body);return mode==='lost-fixture'&&name==='Parent'?reply(502,{errorCode:'LOST'}):reply(201,{id:mode==='wrong-id'&&name==='Parent'?customerParent:id});}
    if(method==='DELETE'){rows.delete(name+'/'+tail);return reply(204,null);}
    return rows.has(name+'/'+tail)?reply(200,rows.get(name+'/'+tail)):reply(404,null);
  };
  const plan={source:'salesforce_live_flow_creation',targetObject:'Child',fixtures:[{objectName:'Parent',inputName:'parent',markerField:'Name',fixtureAccessReady:true}],
    targets:[{objectName:'Child',fixtureAccessReady:true,bindings:[{field:'ParentId',type:'reference',inputName:'parent',inputField:'Id'},{field:'Body',type:'string',inputName:'text'}]}],inputVariables:[{name:'parent',dataType:'SObject'},{name:'text',dataType:'String'}]};
  return {rows,calls,plan,request,build:async(_name:string,_marker:string,values:any)=>({values})};
}
test('Flow plans all dependencies before writes and never borrows an existing customer reference',async()=>{
  const f=fixture(),result=await invokeOwnedFlowCreation({root,route,...f});
  expect(result.contextSchema?.verified).toBe(true);expect(result.cleanupError).toBeUndefined();expect(f.rows.size).toBe(2);
  const posts=f.calls.filter(call=>call.method==='POST'&&call.path.includes('/sobjects/'));
  expect(posts.map(call=>call.path.split('/').at(-1))).toEqual(['Account','Parent']);expect(posts[1].body.AccountId).not.toBe(customerAccount);
  expect(f.calls.findIndex(call=>call.path.endsWith('/Account/describe'))).toBeLessThan(f.calls.findIndex(call=>call.method==='POST'));
  expect(f.calls.some(call=>decodeURIComponent(call.path).includes('SELECT Id FROM Account LIMIT 1'))).toBe(false);
});
test('a fresh tenant with no dependency records uses the same owned graph and leaves no fixtures',async()=>{
  const f=fixture();f.rows.clear();const result=await invokeOwnedFlowCreation({root,route,...f});
  expect(result.contextSchema?.verified).toBe(true);expect(result.cleanupError).toBeUndefined();expect(f.rows.size).toBe(0);
  expect(f.calls.filter(call=>call.method==='POST'&&call.path.includes('/sobjects/')).map(call=>call.path.split('/').at(-1))).toEqual(['Account','Parent']);
});
for(const mode of ['wrong-id','lost-fixture','lost-native','native-rejection','nested-rejection'])test(`Flow ${mode} recovers actual owned graph while preserving customer records`,async()=>{
  const f=fixture(mode),result=await invokeOwnedFlowCreation({root,route,...f});expect(result.contextSchema?.verified).toBe(false);
  expect(f.rows.size).toBe(2);expect(f.rows.get('Parent/'+customerParent).Name).toBe('Existing customer parent');
  expect(f.calls.some(call=>call.method==='DELETE'&&call.path.endsWith(customerParent))).toBe(false);
  if(mode==='wrong-id')expect(result.cleanupError).toContain('deletion was withheld');else expect(result.cleanupError).toBeUndefined();
});
test('missing targets and ambiguous duplicate owned input roles fail without writes',async()=>{
  for(const mode of ['empty-targets','duplicate-fixtures']){
    const f=fixture();if(mode==='empty-targets')f.plan.targets=[];else f.plan.fixtures.push({...f.plan.fixtures[0],inputName:'otherParent'});
    const result=await invokeOwnedFlowCreation({root,route,...f});expect(result.status).toBe(422);expect(f.calls).toHaveLength(0);
  }
});
for(const mode of ['missing-access','short-marker'])test(`Flow ${mode} fails complete graph preflight before any writes`,async()=>{
  const f=fixture(mode),result=await invokeOwnedFlowCreation({root,route,...f});expect(result.status).toBe(422);expect(f.calls.some(call=>call.method==='POST')).toBe(false);expect(f.rows.size).toBe(2);
});
function setupFixture(mode='rescue'){
  let sequence=1;const rows=new Map<string,any>(),calls:Array<{path:string;method:string;body:any}>=[];
  const liveHours='001000000000007AAA';
  if(mode!=='no-live-row')rows.set('BusinessHours/'+liveHours,{Id:liveHours,Name:'Default'});
  const marker={name:'Name',type:'string',nameField:true,createable:true,filterable:true,length:80};
  const schemas:any={Ticket:{name:'Ticket',createable:true,queryable:true,deletable:true,fields:[marker,
    {name:'BusinessHoursId',type:'reference',referenceTo:['BusinessHours'],createable:true,nillable:false}]},
    BusinessHours:{name:'BusinessHours',createable:false,queryable:true,deletable:false,fields:[marker]}};
  const insert=(name:string,values:any)=>{const id='a00000000000'+String(sequence++).padStart(3,'0')+'AAA';rows.set(name+'/'+id,{...values,Id:id});return id;};
  const reply=(status:number,body:any)=>({status,ok:status>=200&&status<300,body});
  const request=async(path:string,method='GET',body?:any):Promise<any>=>{
    calls.push({path,method,body});
    if(path.endsWith('/composite/batch')){const results=[];for(const item of body.batchRequests){const result=await request('/services/data/'+item.url,item.method);results.push({statusCode:result.status,result:result.body});}return reply(200,{results});}
    if(path===route){const values=body.inputs[0];insert('Child',{ParentId:values.parent.Id,Body:values.text});return reply(200,[{isSuccess:true,errors:[],outputValues:{}}]);}
    if(path.includes('/query?')){const query=decodeURIComponent(path),name=query.match(/ FROM (\w+)/)![1];
      if(!query.includes('WHERE'))return reply(200,{records:[...rows.entries()].filter(([key])=>key.startsWith(name+'/')).slice(0,1).map(([,row])=>({Id:row.Id}))});
      const conditions=[...query.matchAll(/(\w+)='([^']+)'/g)];return reply(200,{records:[...rows.entries()].filter(([key,row])=>key.startsWith(name+'/')&&conditions.every(([,field,value])=>row[field]===value)).map(([,row])=>({Id:row.Id}))});}
    const parts=path.match(/\/sobjects\/(\w+)(?:\/(.+))?$/)!,name=parts[1],tail=parts[2];
    if(tail==='describe')return reply(200,schemas[name]);
    if(method==='POST'){const id=insert(name,body);return reply(201,{id});}
    if(method==='DELETE'){rows.delete(name+'/'+tail);return reply(204,null);}
    return rows.has(name+'/'+tail)?reply(200,rows.get(name+'/'+tail)):reply(404,null);
  };
  const plan={source:'salesforce_live_flow_creation',targetObject:'Child',fixtures:[{objectName:'Ticket',inputName:'parent',markerField:'Name',fixtureAccessReady:true}],
    targets:[{objectName:'Child',fixtureAccessReady:true,bindings:[{field:'ParentId',type:'reference',inputName:'parent',inputField:'Id'},{field:'Body',type:'string',inputName:'text'}]}],inputVariables:[{name:'parent',dataType:'SObject'},{name:'text',dataType:'String'}]};
  return {rows,calls,plan,request,liveHours,build:async(_name:string,_marker:string,values:any)=>({values})};
}
test('unmintable setup references retain one live row instead of refusing the graph',async()=>{
  const f=setupFixture(),result=await invokeOwnedFlowCreation({root,route,...f});
  expect(result.contextSchema?.verified).toBe(true);expect(result.cleanupError).toBeUndefined();
  const posts=f.calls.filter(call=>call.method==='POST'&&call.path.includes('/sobjects/'));
  expect(posts.map(call=>call.path.split('/').at(-1))).toEqual(['Ticket']);
  expect(posts[0].body.BusinessHoursId).toBe(f.liveHours);
  expect(f.calls.some(call=>decodeURIComponent(call.path).includes('SELECT Id FROM BusinessHours LIMIT 1'))).toBe(true);
  expect(f.rows.size).toBe(1);
});
test('setup rescue refuses honestly without a live row and names the object',async()=>{
  const f=setupFixture('no-live-row'),result=await invokeOwnedFlowCreation({root,route,...f});
  expect(result.status).toBe(422);expect(result.body?.errorCode).toBe('OWNED_CONTEXT_LIFECYCLE_ACCESS_REQUIRED');
  expect(result.body?.message).toContain('BusinessHours');
  expect(f.calls.some(call=>call.method==='POST'&&call.path.includes('/sobjects/'))).toBe(false);
});
