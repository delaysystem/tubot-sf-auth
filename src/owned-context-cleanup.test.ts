import { expect, test } from 'bun:test';
import { cleanupDenialGrantNotes, cleanupOwnedContext, type OwnedRecord, type OwnershipScope } from './owned-context-cleanup';
const parent='001000000000001AAA', stranger='001000000000002AAA', child='003000000000001AAA';
function fixture(rows: Record<string,any>, mode='normal') {
  const deleted:string[]=[],batchSizes:number[]=[];
  const request=async(_path:string,_method?:string,body?:any)=>{
    batchSizes.push(body.batchRequests.length);
    return {status:200,ok:true,body:{results:body.batchRequests.map((operation:any)=>{
      const id=operation.url.split('/').at(-1);
      if(operation.method==='DELETE'){deleted.push(id);if(mode==='delete_failure')return {statusCode:403};delete rows[id];return {statusCode:204};}
      if(mode==='absence_unverifiable'&&deleted.length>0)return {statusCode:500};
      return rows[id]?{statusCode:200,result:rows[id]}:{statusCode:404};
    })}};
  };
  return {rows,deleted,batchSizes,request};
}
const record=(objectName:string,id:string):OwnedRecord=>({objectName,id});
const scopes:OwnershipScope[]=[{objectName:'Account',equals:{Name:'AS unique marker'}},
  {objectName:'Contact',equals:{AccountId:parent},ownedParents:[{field:'AccountId',objectName:'Account'}]}];
test('a mismatched creation ID is never deleted while actual owned siblings are cleaned',async()=>{
  const f=fixture({[parent]:{Id:parent,Name:'AS unique marker'},[stranger]:{Id:stranger,Name:'Customer'}});
  const result=await cleanupOwnedContext({root:'/services/data/v67.0',...f,records:[record('Account',stranger),record('Account',parent)],scopes,order:['Account']});
  expect(f.deleted).toEqual([parent]);expect(f.rows[stranger].Name).toBe('Customer');
  expect(result.cleanupError).toContain('deletion was withheld');expect(result.ownedRecords).toEqual([record('Account',parent)]);
});
test('owned-parent proof permits cleanup of recovered children without trusting returned identities',async()=>{
  const f=fixture({[parent]:{Id:parent,Name:'AS unique marker'},[child]:{Id:child,AccountId:parent}});
  const result=await cleanupOwnedContext({root:'/services/data/v67.0',...f,records:[record('Contact',child),record('Account',parent)],scopes,order:['Contact','Account']});
  expect(result.cleanupError).toBeUndefined();expect(f.deleted).toEqual([child,parent]);expect(Object.keys(f.rows)).toHaveLength(0);
});
test('unproven parent identity cannot authorize deleting an unrelated child',async()=>{
  const f=fixture({[parent]:{Id:parent,Name:'Customer'},[child]:{Id:child,AccountId:parent}});
  const result=await cleanupOwnedContext({root:'/services/data/v67.0',...f,records:[record('Contact',child),record('Account',parent)],scopes,order:['Contact','Account']});
  expect(result.cleanupError).toBeDefined();expect(f.deleted).toEqual([]);
});
test('DELETE rejection and incomplete target readback fail closed',async()=>{
  const f=fixture({[parent]:{Id:parent,Name:'AS unique marker'}},'delete_failure');
  expect((await cleanupOwnedContext({root:'/services/data/v67.0',...f,records:[record('Account',parent)],scopes,order:['Account']})).cleanupError)
    .toBe(`Owned Account cleanup deletion returned 403; absence was not verified. ` +
      `Planner grant family object-crud for Account: Grant the execution identity Account delete access ` +
      `through the fixture permission set during org provisioning, then retry.`);
  const broken=await cleanupOwnedContext({root:'/services/data/v67.0',records:[record('Account',parent)],scopes,order:['Account'],request:async()=>({status:200,ok:true,body:{results:[]}})});
  expect(broken.ownedRecords).toEqual([]);expect(broken.cleanupError).toContain('incomplete');
});
test('issued delete with benign readback reports absence-unverifiable with the status',async()=>{
  const f=fixture({[parent]:{Id:parent,Name:'AS unique marker'}},'absence_unverifiable');
  const result=await cleanupOwnedContext({root:'/services/data/v67.0',...f,records:[record('Account',parent)],scopes,order:['Account']});
  expect(result.cleanupError).toBe(`Owned Account cleanup deletion verified but absence readback returned 500.`);
});
test('delete denials carry machine-readable planner diagnosis',async()=>{
  const f=fixture({[parent]:{Id:parent,Name:'AS unique marker'}},'delete_failure');
  const result=await cleanupOwnedContext({root:'/services/data/v67.0',...f,records:[record('Account',parent)],scopes,order:['Account']});
  expect(result.cleanupDiagnosis).toEqual([{objectName:'Account',kind:'delete-denied',status:403}]);
});
test('a transient absence mismatch verifies on the bounded re-read',async()=>{
  const rows:Record<string,any>={[parent]:{Id:parent,Name:'AS unique marker'}};
  let verifyGets=0;
  const request=async(_path:string,method?:string,body?:any)=>{
    return {status:200,ok:true,body:{results:body.batchRequests.map((operation:any)=>{
      const id=operation.url.split('/').at(-1);
      if(operation.method==='DELETE'){delete rows[id];return {statusCode:204};}
      if(rows[id])return {statusCode:200,result:rows[id]};
      // The delete-batch absence leg (a 2-leg batch) still sees the row;
      // the follow-up absence re-read (a GET-only batch) observes the
      // deletion (transient lag).
      if(body.batchRequests.length===2&&verifyGets++===0)
        return {statusCode:200,result:{Id:parent,Name:'AS unique marker'}};
      return {statusCode:404};
    })}};
  };
  const result=await cleanupOwnedContext({root:'/services/data/v67.0',records:[record('Account',parent)],scopes,order:['Account'],request});
  expect(result.cleanupError).toBeUndefined();expect(result.cleanupDiagnosis).toBeUndefined();
  expect(result.ownedRecords).toEqual([record('Account',parent)]);
});
test('a persistent absence mismatch fails closed with unverified diagnosis',async()=>{
  const f=fixture({[parent]:{Id:parent,Name:'AS unique marker'}},'absence_unverifiable');
  const result=await cleanupOwnedContext({root:'/services/data/v67.0',...f,records:[record('Account',parent)],scopes,order:['Account']});
  expect(result.cleanupError).toBe(`Owned Account cleanup deletion verified but absence readback returned 500.`);
  expect(result.cleanupDiagnosis).toEqual([{objectName:'Account',kind:'absence-unverified',status:500}]);
});
test('delete denials name their grant family in the recorded error artifact',async()=>{
  const f=fixture({[parent]:{Id:parent,Name:'AS unique marker'}},'delete_failure');
  const result=await cleanupOwnedContext({root:'/services/data/v67.0',...f,records:[record('Account',parent)],scopes,order:['Account']});
  expect(result.cleanupError).toContain('Planner grant family object-crud for Account');
  expect(result.cleanupError).toContain('Account delete access');
  expect(result.cleanupDiagnosis).toEqual([{objectName:'Account',kind:'delete-denied',status:403}]);
});
test('absence-unverified errors name no grant family',async()=>{
  const f=fixture({[parent]:{Id:parent,Name:'AS unique marker'}},'absence_unverifiable');
  const result=await cleanupOwnedContext({root:'/services/data/v67.0',...f,records:[record('Account',parent)],scopes,order:['Account']});
  expect(result.cleanupError).not.toContain('grant family');
});
test('denial grant notes cover one object once and skip non-denials',()=>{
  expect(cleanupDenialGrantNotes([{objectName:'WebCart',kind:'delete-denied',status:403}]))
    .toEqual(['Planner grant family object-crud for WebCart: Grant the execution identity WebCart delete access through the fixture permission set during org provisioning, then retry.']);
  expect(cleanupDenialGrantNotes([
    {objectName:'Account',kind:'delete-denied'},
    {objectName:'Account',kind:'delete-denied',status:403},
    {objectName:'Contact',kind:'delete-denied'},
  ])).toHaveLength(2);
  expect(cleanupDenialGrantNotes([{objectName:'Account',kind:'absence-unverified',status:500}])).toEqual([]);
  expect(cleanupDenialGrantNotes([{objectName:'../../etc',kind:'delete-denied'}])).toEqual([]);
  expect(cleanupDenialGrantNotes([{objectName:'',kind:'delete-denied'}])).toEqual([]);
  expect(cleanupDenialGrantNotes([null,'nope',42,{kind:'delete-denied'}])).toEqual([]);
  expect(cleanupDenialGrantNotes(null)).toEqual([]);
  expect(cleanupDenialGrantNotes(undefined)).toEqual([]);
  expect(cleanupDenialGrantNotes('nope')).toEqual([]);
});
test('cleanup bounds every batch and skips already absent candidates',async()=>{
  const rows:Record<string,any>={},records:OwnedRecord[]=[];
  for(let index=0;index<30;index++){const id='001'+String(index).padStart(12,'0')+'AAA';records.push(record('Account',id));rows[id]={Id:id,Name:'AS unique marker'};}
  records.push(record('Account',stranger));delete rows[stranger];
  const f=fixture(rows),result=await cleanupOwnedContext({root:'/services/data/v67.0',...f,records,scopes,order:['Account']});
  expect(result.cleanupError).toBeUndefined();expect(Math.max(...f.batchSizes)).toBeLessThanOrEqual(25);expect(Object.keys(rows)).toHaveLength(0);
});
