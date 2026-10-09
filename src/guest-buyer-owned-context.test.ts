import {expect,test} from 'bun:test';
import {invokeGuestBuyerRegistration} from './guest-buyer-owned-context';
const identities={WebStore:'0ZE000000000001AAA',Account:'001000000000001AAA',Contact:'003000000000001AAA'};
async function run(mode='normal'){
  const rows=new Map<string,any>(),calls:Array<{path:string;method:string;body:any}>=[];
  const existingId='0ZE000000000002AAA';
  if(mode==='wrong_store_response')rows.set(existingId,{objectName:'WebStore',Id:existingId,Name:'Existing customer store',Type:'B2CE'});
  const ok=(body:any,status=200)=>({status,ok:status>=200&&status<300,body});

  const result=await invokeGuestBuyerRegistration({root:'/services/data/v67.0',route:'/services/data/v67.0/actions/standard/registerGuestBuyer',
    build:async(_name,_marker,values)=>({values}),request:async(path,method='GET',body)=>{
      calls.push({path,method,body});
      if(path.endsWith('/describe')){
        if(path.includes('/Contact/'))return ok({queryable:true,deletable:true,fields:[{name:'AccountId',filterable:true}]});
        const storeTypes=mode==='fallthrough_types'?['B2B','B2C','B2CE']:['B2B'];
        const fields=[{name:'Name',createable:true,filterable:true,length:255},{name:'Type',createable:true,picklistValues:storeTypes.map(value=>({active:true,value}))}];
        if(path.includes('/Account/')&&mode!=='no_person_accounts')fields.push({name:'IsPersonAccount'} as any);
        return ok({queryable:true,deletable:mode!=='missing_cleanup',createable:true,fields});
      }
      if(path.includes('/query?')){const q=decodeURIComponent(path);
        // Person record type is pre-existing org data, never an owned leak.
        if(q.includes('FROM RecordType'))return ok({records:mode==='no_person_accounts'?[]:[{Id:'012000000000001AAA'}]});
        const name=q.match(/ FROM (\w+) WHERE/)?.[1]!;const conditions=[...q.matchAll(/(\w+)='([^']+)'/g)];return ok({records:[...rows.values()].filter(row=>row.objectName===name&&conditions.every(([,field,value])=>row[field]===value)).map(({objectName,...row})=>row)});}
      if(path.endsWith('/composite/batch'))return ok({results:body.batchRequests.map((v:any)=>{
        const key=v.url.split('/').at(-1);
        if(v.method==='DELETE'&&mode==='person_shadow'){
          const row=rows.get(key);
          // Live platform semantics: a PersonContact shadow refuses direct
          // deletion while its account lives, and cascades with the account.
          if(row?.objectName==='Contact'){
            const parentGone=[...rows.values()].every(r=>!(r.objectName==='Account'&&r.Id===row.AccountId));
            return parentGone?{statusCode:404}:{statusCode:400,result:[{errorCode:'INVALID_PERSON_ACCOUNT_OPERATION'}]};
          }
          if(row?.objectName==='Account'){rows.delete(key);for(const [k,r] of [...rows])if(r.objectName==='Contact'&&r.AccountId===key)rows.delete(k);return {statusCode:204};}
          if(row){rows.delete(key);return {statusCode:204};}
          return {statusCode:404};
        }
        if(v.method==='DELETE'&&mode!=='cleanup_rejection')rows.delete(key);
        return v.method==='GET'&&rows.has(key)?{statusCode:200,result:rows.get(key)}:{statusCode:rows.has(key)?403:v.method==='GET'?404:204};
      })});
      if(path.includes('/sobjects/')){
        const name=path.split('/')[5] as keyof typeof identities;
        if(method==='POST'){
          // Person-Account Name is platform-computed from LastName.
          const stored={objectName:name,Id:identities[name],...body};
          if(name==='Account'&&!stored.Name&&typeof body.LastName==='string')stored.Name=body.LastName;
          rows.set(identities[name],stored);return ok({id:mode==='wrong_store_response'&&name==='WebStore'?existingId:identities[name]},201);}
        if(method==='DELETE'){if(mode==='cleanup_rejection')return ok([],403);const deleted=rows.delete(path.split('/').at(-1)!);return deleted?ok(null,204):ok([],404);}
        const row=rows.get(path.split('/').at(-1)!);return row?ok(row):ok([],404);
      }
      if(method==='GET')return ok({inputs:[{name:'webstoreId'},{name:'accountId'}],outputs:[{name:'RegisterGuestBuyerOutput'}]});
      if(path.endsWith('/registerGuestBuyer')){
        if(mode==='fallthrough_types'&&calls.filter(c=>c.method==='POST'&&c.path.endsWith('/registerGuestBuyer')).length<=2)return ok([{isSuccess:false,errors:[{statusCode:'UNKNOWN_EXCEPTION',message:'business accounts not supported'}],outputValues:null}],400);
        if(mode==='lost_response')return ok({errorCode:'UPSTREAM_LOST'},502);
        if(mode==='empty_outcome')return ok([]);
        if(mode==='native_rejection')return ok([{isSuccess:false,errors:[{statusCode:'UNKNOWN_EXCEPTION',message:"The API isn't supported for B2CE store."}],outputValues:null}]);
        if(mode==='missing_output')return ok([{isSuccess:true,errors:null,outputValues:{}}]);
        const args=body.inputs[0];
        rows.set(identities.Contact,{objectName:'Contact',Id:identities.Contact,AccountId:args.accountId});
        return ok([{isSuccess:true,errors:null,outputValues:{RegisterGuestBuyerOutput:{buyerId:args.accountId}}}]);
      }
      throw Error('Unexpected request');
    }});
  return {result,rows,calls};
}
test('guest-buyer registration verifies the declared output and cleans the owned graph',async()=>{
  const {result,rows,calls}=await run();
  expect(result.contextSchema?.verified).toBe(true);expect(result.cleanupError).toBeUndefined();expect(rows.size).toBe(0);
  expect(result.contextSchema?.ownedRecords.some((r:any)=>r.objectName==='Contact')).toBe(true);
  expect(calls.some(c=>c.path.endsWith('/registerGuestBuyer')&&c.method==='POST')).toBe(true);
  expect(calls.length).toBeLessThan(40);
});
test('native success without the declared output is rejected while cleaning owned writes',async()=>{
  const {result,rows}=await run('missing_output');expect(result.contextSchema?.verified).toBe(false);expect(result.body.errorCode).toBe('GUEST_BUYER_REGISTRATION_UNVERIFIED');expect(rows.size).toBe(0);
});
test('a lost native response still discovers and removes owned writes',async()=>{
  const {result,rows}=await run('lost_response');expect(result.status).toBe(502);expect(rows.size).toBe(0);
});
test('an empty HTTP 200 action outcome is explicitly rejected while cleaning owned writes',async()=>{
  const {result,rows}=await run('empty_outcome');expect(result.body.errorCode).toBe('GUEST_BUYER_ACTION_OUTCOME_MISSING');expect(result.contextSchema?.nativeEvidence.outcomeCount).toBe(0);expect(rows.size).toBe(0);
});
test('native rejection is preserved and owned writes are cleaned',async()=>{
  const {result,rows}=await run('native_rejection');expect(result.body[0].isSuccess).toBe(false);expect(result.contextSchema?.verified).toBe(false);expect(rows.size).toBe(0);
});
test('cleanup readback failure remains explicit after actual native success',async()=>{
  const {result,rows}=await run('cleanup_rejection');expect(result.contextSchema?.verified).toBe(true);expect(result.cleanupError).toContain('cleanup');expect(rows.size).toBe(3);
});
test('missing cleanup access prevents all mutations',async()=>{
  const {result,calls}=await run('missing_cleanup');expect(result.body.errorCode).toBe('GUEST_BUYER_CONTEXT_PERMISSIONS_REQUIRED');expect(calls.some(c=>c.method==='POST')).toBe(false);
});
test('wrong fixture creation identity preserves the existing store',async()=>{
  const {result,rows,calls}=await run('wrong_store_response');
  expect(result.body.errorCode).toBe('GUEST_BUYER_STORE_UNVERIFIED');expect(result.cleanupError).toContain('deletion was withheld');
  expect(rows.size).toBe(1);expect(rows.get('0ZE000000000002AAA').Name).toBe('Existing customer store');
  expect(calls.filter(call=>call.path.endsWith('/composite/batch')).flatMap(call=>call.body.batchRequests).some(operation=>operation.method==='DELETE'&&operation.url.endsWith('0ZE000000000002AAA'))).toBe(false);
});
test('missing Person Accounts fails fast before any fixture',async()=>{
  const {result,rows,calls}=await run('no_person_accounts');
  expect(result.body.errorCode).toBe('GUEST_BUYER_PERSON_ACCOUNT_REQUIRED');expect(rows.size).toBe(0);
  expect(calls.some(c=>c.method==='POST')).toBe(false);
});
test('person-contact shadows cascade with the account instead of failing cleanup',async()=>{
  const {result,rows}=await run('person_shadow');
  expect(result.contextSchema?.verified).toBe(true);expect(result.cleanupError).toBeUndefined();expect(rows.size).toBe(0);
});
test('person-account buyers carry the person record type and B2CE is never attempted',async()=>{
  const {result,calls}=await run('fallthrough_types');
  expect(result.status).toBe(400);
  const storeTypes=calls.filter(c=>c.path.endsWith('/sobjects/WebStore')&&c.method==='POST').map(c=>c.body.Type);
  expect(storeTypes).toEqual(['B2B','B2C']);
  const buyerPost=calls.find(c=>c.path.endsWith('/sobjects/Account')&&c.method==='POST');
  expect(buyerPost?.body.RecordTypeId).toBe('012000000000001AAA');
  expect(typeof buyerPost?.body.LastName).toBe('string');
});
