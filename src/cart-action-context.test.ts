import {expect,test} from 'bun:test';
import {invokeCartMutation} from './cart-action-context';
const identities={WebStore:'0ZE000000000001AAA',Account:'001000000000001AAA',WebCart:'0a6000000000001AAA',BuyerAccount:'0BJ000000000001AAA',BuyerGroupMember:'0ZJ000000000001AAA',Contact:'003000000000001AAA'};
// A GET-only composite batch (batched describes) reads without mutating.
const isMutation=(c:{path:string;method:string;body:any})=>c.method==='POST'&&!(c.path.endsWith('/composite/batch')&&Array.isArray(c.body?.batchRequests)&&c.body.batchRequests.every((v:any)=>v.method==='GET'));
async function run(action='createCart',mode='normal'){
  const rows=new Map<string,any>(),calls:Array<{path:string;method:string;body:any}>=[];
  const existingId='0ZE000000000002AAA';
  if(mode==='wrong_store_response')rows.set(existingId,{objectName:'WebStore',Id:existingId,Name:'Existing customer store',Type:'B2CE'});
  const provisionedStore='0ZE000000000009AAA',provisionedNetwork='0DB000000000009AAA',provisionedGroup='0ZI000000000009AAA';
  const secondGroup='0ZI000000000008AAA';
  if(mode==='reuse_store'||mode==='reuse_ladder'||mode==='reuse_all_refuse'){
    rows.set(provisionedStore,{objectName:'WebStore',Id:provisionedStore,Name:'Provisioned storefront store',Type:'B2B'});
    rows.set('0ZF000000000009AAA',{objectName:'WebStoreNetwork',Id:'0ZF000000000009AAA',WebStoreId:provisionedStore,NetworkId:provisionedNetwork});
    rows.set(provisionedNetwork,{objectName:'Network',Id:provisionedNetwork,Status:'Live'});
    rows.set('0CD000000000009AAA',{objectName:'WebStoreBuyerGroup',Id:'0CD000000000009AAA',WebStoreId:provisionedStore,BuyerGroupId:provisionedGroup});
    if(mode!=='reuse_store')rows.set('0CD000000000008AAA',{objectName:'WebStoreBuyerGroup',Id:'0CD000000000008AAA',WebStoreId:provisionedStore,BuyerGroupId:secondGroup});
  }
  const ok=(body:any,status=200)=>({status,ok:status>=200&&status<300,body});
  const result=await invokeCartMutation({root:'/services/data/v67.0',route:'/services/data/v67.0/actions/standard/'+action,
    build:async(_name,_marker,values)=>({values}),request:async(path,method='GET',body)=>{
      calls.push({path,method,body});
      if(path.endsWith('/describe')){const web=path.includes('/WebStore/');const values=mode==='type_fallthrough'&&web?[{active:true,value:'B2C'},{active:true,value:'B2CE'}]:[{active:true,value:web?'B2CE':'Cart'}];return ok({queryable:true,deletable:mode!=='missing_cleanup',createable:true,fields:[{name:'Name',createable:true,filterable:true,length:255},{name:'Type',createable:true,picklistValues:values}]});}
      if(path.includes('/query?')){const q=decodeURIComponent(path);const name=q.match(/ FROM (\w+)/)?.[1]!;const conditions=[...q.matchAll(/(\w+)='([^']+)'/g)];return ok({records:[...rows.values()].filter(row=>row.objectName===name&&conditions.every(([,field,value])=>row[field]===value)).map(({objectName,...row})=>row)});}
      if(path.endsWith('/composite/batch'))return ok({results:body.batchRequests.map((v:any)=>{
        if(v.method==='GET'&&v.url.endsWith('/describe')){const web=v.url.includes('/WebStore/');const values=mode==='type_fallthrough'&&web?[{active:true,value:'B2C'},{active:true,value:'B2CE'}]:[{active:true,value:web?'B2CE':'Cart'}];return {statusCode:200,result:{queryable:true,deletable:mode!=='missing_cleanup',createable:true,fields:[{name:'Name',createable:true,filterable:true,length:255},{name:'Type',createable:true,picklistValues:values}]}};}
        if(v.method==='GET'&&v.url.includes('/actions/standard/')){const name=v.url.split('/').at(-1);return {statusCode:200,result:{inputs:(name==='createCart'?['webStoreId','cartInput']:['webStoreId','effectiveAccountId','cartStateOrId','userId']).map(n=>({name:n}))}};}
        const key=v.url.split('/').at(-1);
        if(v.method==='DELETE'&&mode!=='cleanup_rejection')rows.delete(key);
        return v.method==='GET'&&rows.has(key)?{statusCode:200,result:rows.get(key)}:{statusCode:rows.has(key)?403:v.method==='GET'?404:204};
      })});
      if(path.includes('/sobjects/')){
        const name=path.split('/')[5] as keyof typeof identities;
        const fallthroughId=mode==='type_fallthrough'&&method==='POST'&&name==='WebStore'?(body.Type==='B2CE'?'0ZE000000000CE1':'0ZE000000000BC1'):null;
        const rowId=fallthroughId??identities[name];
        if(method==='POST'){
          // Live group semantics: the first linked group is not account-based.
          if(name==='BuyerGroupMember'&&(mode==='reuse_ladder'&&body.BuyerGroupId===provisionedGroup||mode==='reuse_all_refuse'))
            return ok([{message:"can't be added to this buyer group. Select an account-based buyer group.",errorCode:'INVALID_FIELD'}],400);
          rows.set(rowId,{objectName:name,Id:rowId,...body});return ok({id:fallthroughId??(mode==='wrong_store_response'&&name==='WebStore'?existingId:identities[name])},201);}
        const row=rows.get(path.split('/').at(-1)!);return row?ok(row):ok([],404);
      }
      if(method==='GET')return ok({inputs:(path.endsWith('/createCart')?['webStoreId','cartInput']:['webStoreId','effectiveAccountId','cartStateOrId','userId']).map(name=>({name}))});
      if(path.endsWith('/createCart')){
        const args=body.inputs[0],cart=args.cartInput;
        if(mode==='type_fallthrough'&&args.webStoreId==='0ZE000000000BC1')return ok([{isSuccess:false,errors:[{statusCode:'ILLEGAL_QUERY_PARAMETER_VALUE',message:"Argument: '[salesforce-id]' - This isn't a buyer account."}]}],400);
        if(mode==='type_stop_non400'&&!calls.some(c=>c.method==='POST'&&c.path.endsWith('/createCart')&&c.body!==body))return ok({message:'forbidden'},403);
        if(mode!=='false_success')rows.set(identities.WebCart,{objectName:'WebCart',Id:identities.WebCart,Name:cart.name,WebStoreId:args.webStoreId,AccountId:cart.effectiveAccountId,OwnerId:'005000000000001AAA',Status:'Active',Type:'Cart'});
        if(mode==='lost_response')return ok({errorCode:'UPSTREAM_LOST'},502);
        if(mode==='empty_outcome')return ok([]);
        return ok([{isSuccess:true,errors:null,outputValues:{cartSummary:{cartId:mode==='wrong_identity'?'0a6000000000002AAA':identities.WebCart,accountId:cart.effectiveAccountId,webstoreId:args.webStoreId,name:cart.name,status:'Active'}}}]);
      }
      if(path.endsWith('/deleteCart')){
        if(mode!=='delete_no_change')rows.get(identities.WebCart).Status='PendingDelete';
        return ok([{isSuccess:mode!=='delete_rejection',errors:mode==='delete_rejection'?[{statusCode:'REJECTED'}]:null,outputValues:{}}]);
      }
      throw Error('Unexpected request');
    }});
  return {result,rows,calls};
}
for(const action of ['createCart','deleteCart'])test(`native ${action} verifies actual owned relationships and cleanup`,async()=>{
  const {result,rows,calls}=await run(action);
  expect(result.contextSchema?.verified).toBe(true);expect(result.cleanupError).toBeUndefined();expect(rows.size).toBe(0);
  expect(calls.some(c=>c.path.endsWith('/'+action)&&c.method==='POST')).toBe(true);
  expect(calls.length).toBeLessThan(40);
});
for(const mode of ['false_success','wrong_identity'])test(`native createCart rejects ${mode} and cleans the owned graph`,async()=>{
  const {result,rows}=await run('createCart',mode);expect(result.contextSchema?.verified).toBe(false);expect(result.body.errorCode).toBe('CART_CREATION_UNVERIFIED');expect(rows.size).toBe(0);
});
test('a lost native creation response still discovers and removes the actual cart',async()=>{
  const {result,rows}=await run('createCart','lost_response');expect(result.status).toBe(502);expect(result.contextSchema?.ownedRecords.some((r:any)=>r.objectName==='WebCart')).toBe(true);expect(rows.size).toBe(0);
});
test('an empty HTTP 200 action outcome is explicitly rejected while cleaning any actual writes',async()=>{
  const {result,rows}=await run('createCart','empty_outcome');expect(result.body.errorCode).toBe('CART_ACTION_OUTCOME_MISSING');expect(result.contextSchema?.nativeCreateEvidence.outcomeCount).toBe(0);expect(result.contextSchema?.verified).toBe(false);expect(rows.size).toBe(0);
});
test('native deletion success without an actual effect is rejected',async()=>{
  const {result,rows}=await run('deleteCart','delete_no_change');expect(result.body.errorCode).toBe('CART_DELETION_UNVERIFIED');expect(result.contextSchema?.verified).toBe(false);expect(rows.size).toBe(0);
});
test('native rejection survives even when the record changes',async()=>{
  const {result,rows}=await run('deleteCart','delete_rejection');expect(result.body[0].isSuccess).toBe(false);expect(result.contextSchema?.verified).toBe(false);expect(rows.size).toBe(0);
});
test('cleanup readback failure remains explicit after actual native success',async()=>{
  const {result,rows}=await run('createCart','cleanup_rejection');expect(result.contextSchema?.verified).toBe(true);expect(result.cleanupError).toContain('cleanup');expect(rows.size).toBe(3);
});
test('missing cleanup access prevents all mutations',async()=>{
  const {result,calls}=await run('createCart','missing_cleanup');expect(result.body.errorCode).toBe('CART_CONTEXT_PERMISSIONS_REQUIRED');expect(calls.some(isMutation)).toBe(false);
});
test('wrong fixture creation identity preserves the existing store and recovers the actual owned write',async()=>{
  const {result,rows,calls}=await run('createCart','wrong_store_response');
  expect(result.body.errorCode).toBe('CART_STORE_UNVERIFIED');expect(result.cleanupError).toContain('deletion was withheld');
  expect(rows.size).toBe(1);expect(rows.get('0ZE000000000002AAA').Name).toBe('Existing customer store');
  expect(calls.filter(call=>call.path.endsWith('/composite/batch')).flatMap(call=>call.body.batchRequests).some(operation=>operation.method==='DELETE'&&operation.url.endsWith('0ZE000000000002AAA'))).toBe(false);
});
test('a 400 buyer refusal on one store type falls through to the next type and converts',async()=>{
  const {result,rows,calls}=await run('createCart','type_fallthrough');
  expect(result.contextSchema?.verified).toBe(true);expect(result.cleanupError).toBeUndefined();expect(rows.size).toBe(0);
  expect(result.contextSchema?.storeType).toBe('B2CE');
  expect(calls.filter(c=>c.path.endsWith('/sobjects/WebStore')&&c.method==='POST').length).toBe(2);
  expect(calls.filter(c=>c.path.endsWith('/createCart')&&c.method==='POST').length).toBe(2);
});
test('a non-400 native refusal stops the store-type ladder immediately',async()=>{
  const {result,calls}=await run('createCart','type_stop_non400');
  expect(result.status).toBe(403);expect(result.contextSchema?.verified).toBe(false);
  expect(calls.filter(c=>c.path.endsWith('/sobjects/WebStore')&&c.method==='POST').length).toBe(1);
});
test('a provisioned storefront reuses its store and buyer chain without minting or deleting substrate',async()=>{
  const {result,rows,calls}=await run('createCart','reuse_store');
  expect(result.contextSchema?.verified).toBe(true);expect(result.cleanupError).toBeUndefined();
  expect(result.contextSchema?.reusedStore).toBe(true);expect(result.contextSchema?.storeType).toBe('B2B');
  expect(result.contextSchema?.storeId).toBe('0ZE000000000009AAA');
  expect(calls.some(c=>c.path.endsWith('/sobjects/WebStore')&&c.method==='POST')).toBe(false);
  expect(calls.some(c=>c.path.endsWith('/sobjects/BuyerAccount')&&c.method==='POST')).toBe(true);
  expect(calls.some(c=>c.path.endsWith('/sobjects/BuyerGroupMember')&&c.method==='POST')).toBe(true);
  const deletes=calls.filter(call=>call.path.endsWith('/composite/batch')).flatMap(call=>call.body.batchRequests).filter((operation:any)=>operation.method==='DELETE').map((operation:any)=>operation.url);
  for(const kept of ['0ZE000000000009AAA','0ZF000000000009AAA','0DB000000000009AAA','0CD000000000009AAA']){
    expect(rows.has(kept)).toBe(true);
    expect(deletes.some((url:string)=>url.endsWith(kept))).toBe(false);
  }
  expect(rows.size).toBe(4);
});
test('a non-account-based first group ladders to the next linked group and converts',async()=>{
  const {result,rows,calls}=await run('createCart','reuse_ladder');
  expect(result.contextSchema?.verified).toBe(true);expect(result.cleanupError).toBeUndefined();
  expect(result.contextSchema?.reusedStore).toBe(true);
  expect(result.contextSchema?.memberAttempts).toEqual([
    {groupId:'0ZI000000000009AAA',status:400,errorCode:'INVALID_FIELD'},
    {groupId:'0ZI000000000008AAA',status:201},
  ]);
  expect(calls.filter(c=>c.path.endsWith('/sobjects/BuyerGroupMember')&&c.method==='POST').length).toBe(2);
  expect(rows.size).toBe(5);
});
test('an exhausted group ladder cleans partials by marker and falls through to mint',async()=>{
  const {result,rows}=await run('createCart','reuse_all_refuse');
  expect(result.contextSchema?.verified).toBe(true);expect(result.cleanupError).toBeUndefined();
  expect(result.contextSchema?.reusedStore).toBe(false);
  expect(result.contextSchema?.memberAttempts).toEqual([
    {groupId:'0ZI000000000009AAA',status:400,errorCode:'INVALID_FIELD'},
    {groupId:'0ZI000000000008AAA',status:400,errorCode:'INVALID_FIELD'},
  ]);
  // Seeded substrate survives; every owned partial is gone (no proof errors).
  expect([...rows.values()].every(r=>['WebStore','WebStoreNetwork','Network','WebStoreBuyerGroup'].includes(r.objectName))).toBe(true);
  expect([...rows.values()].filter(r=>r.objectName==='WebStoreBuyerGroup').length).toBe(2);
});
