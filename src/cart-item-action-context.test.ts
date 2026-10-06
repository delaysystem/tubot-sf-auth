import {expect,test} from 'bun:test';
import {invokeCartItemMutation,cartInventoryReservationUnsupported,salesforceRejectionOf,isStoreHostnameUnavailable} from './cart-item-action-context';
const identities={WebStore:'0ZE000000000001AAA',Account:'001000000000001AAA',WebCart:'0a6000000000001AAA',
  Product2:'01t000000000001AAA',PricebookEntry:'01u000000000001AAA',CartItem:'0a9000000000001AAA',CartDeliveryGroup:'0a7000000000001AAA',
  WebStoreNetwork:'0n5000000000000AAA',BuyerAccount:'0BJ000000000001AAA',BuyerGroupMember:'0ZJ000000000001AAA',Contact:'003000000000001AAA',
  WebStoreCatalog:'0CA000000000001AAA',ProductCategoryProduct:'0C1000000000001AAA',CommerceEntitlementProduct:'0CE000000000001AAA'};
const liveNetworkIds=['0DB000000000000AAA','0DB000000000001AAA'];
// A GET-only composite batch (batched describes) reads without mutating.
const isMutation=(c:{path:string;method:string;body:any})=>c.method==='POST'&&!(c.path.endsWith('/composite/batch')&&Array.isArray(c.body?.batchRequests)&&c.body.batchRequests.every((v:any)=>v.method==='GET'));
const standardPricebookId='01s000000000001AAA', otherProductId='01t000000000002AAA';
async function run(action='addCartItem',mode='normal'){
  const rows=new Map<string,any>(),calls:Array<{path:string;method:string;body:any}>=[];
  const existingId='0ZE000000000002AAA';
  if(mode==='wrong_store_response')rows.set(existingId,{objectName:'WebStore',Id:existingId,Name:'Existing customer store',Type:'B2CE'});
  if(mode==='prefer_proven_link')rows.set('0n5000000000001AAA',{objectName:'WebStoreNetwork',Id:'0n5000000000001AAA',WebStoreId:'0ZE000000000009AAA',NetworkId:liveNetworkIds[1]});
  const provisionedStore='0ZE000000000009AAA',provisionedGroup='0ZI000000000009AAA',provisionedCatalog='0ZS000000000009AAA';
  if(mode==='reuse_store'){
    rows.set(provisionedStore,{objectName:'WebStore',Id:provisionedStore,Name:'Provisioned storefront store',Type:'B2B'});
    rows.set('0ZF000000000009AAA',{objectName:'WebStoreNetwork',Id:'0ZF000000000009AAA',WebStoreId:provisionedStore,NetworkId:liveNetworkIds[0]});
    rows.set('0CD000000000009AAA',{objectName:'WebStoreBuyerGroup',Id:'0CD000000000009AAA',WebStoreId:provisionedStore,BuyerGroupId:provisionedGroup});
    rows.set('0CH000000000009AAA',{objectName:'WebStorePricebook',Id:'0CH000000000009AAA',WebStoreId:provisionedStore,Pricebook2Id:'01s000000000009AAA',IsActive:true});
    rows.set(provisionedCatalog,{objectName:'ProductCatalog',Id:provisionedCatalog,Name:'Provisioned catalog'});
    rows.set('0ZG000000000009AAA',{objectName:'ProductCategory',Id:'0ZG000000000009AAA',CatalogId:provisionedCatalog,Name:'Products'});
    rows.set('0CE000000000009AAA',{objectName:'CommerceEntitlementBuyerGroup',Id:'0CE000000000009AAA',BuyerGroupId:provisionedGroup,PolicyId:'1CE000000000009AAA'});
  }
  const liveNetworks=mode==='no_live_network'?[]:mode==='mapping_rejected'||mode==='prefer_proven_link'?liveNetworkIds:[liveNetworkIds[0]];
  const ok=(body:any,status=200)=>({status,ok:status>=200&&status<300,body});
  const inputsFor=(name:string)=>name==='createCart'?['webStoreId','cartInput']
    :name==='addCartItem'?['webStoreId','effectiveAccountId','cartStateOrId','userId','cartItemInput']
    :['webStoreId','effectiveAccountId','cartStateOrId','userId','cartItemId','cartItemInput'];
  const result=await invokeCartItemMutation({root:'/services/data/v67.0',route:'/services/data/v67.0/actions/standard/'+action,
    build:async(_name,_marker,values)=>({values}),request:async(path,method='GET',body)=>{
      calls.push({path,method,body});
      const answerDescribe=(p:string)=>({queryable:true,deletable:mode!=='missing_cleanup',createable:!(mode==='mapping_not_createable'&&p.includes('/WebStoreNetwork/')),fields:[{name:'Name',createable:true,filterable:true,length:255},{name:'Type',createable:true,picklistValues:[{active:true,value:p.includes('/WebStore/')?'B2CE':'Cart'}]}]});
      const answerQuery=(q:string)=>{
        if(q.includes('FROM Pricebook2'))return {records:mode==='no_pricebook'?[]:[{Id:standardPricebookId}]};
        const name=q.match(/ FROM (\w+)/)?.[1]!;const conditions=[...q.matchAll(/(\w+)='([^']+)'/g)];
        // Live communities are pre-existing org data, never owned leaks.
        if(name==='Network')return {records:liveNetworks.filter(Id=>conditions.every(([,field,value])=>(field!=='Status'||value==='Live')&&(field!=='Id'||value===Id))).map(Id=>({Id,Status:'Live',Name:'Network '+Id.slice(-4),UrlPathPrefix:'prefix'+Id.slice(-4)}))};
        return {records:[...rows.values()].filter(row=>row.objectName===name&&conditions.every(([,field,value])=>row[field]===value)).map(({objectName,...row})=>row)};
      };
      if(path.endsWith('/describe'))return ok(answerDescribe(path));
      if(path.includes('/query?'))return ok(answerQuery(decodeURIComponent(path)));
      if(path.endsWith('/composite/batch'))return ok({results:body.batchRequests.map((v:any)=>{
        if(v.method==='GET'&&v.url.includes('/query?q='))return {statusCode:200,result:answerQuery(decodeURIComponent(v.url.split('/query?q=')[1]))};
        if(v.method==='GET'&&v.url.endsWith('/describe'))return {statusCode:200,result:answerDescribe(v.url)};
        if(v.method==='GET'&&v.url.includes('/actions/standard/'))return {statusCode:200,result:{inputs:inputsFor(v.url.split('/').at(-1)!).map(name=>({name}))}};
        const key=v.url.split('/').at(-1);
        if(v.method==='DELETE'&&mode!=='cleanup_rejection')rows.delete(key);
        return v.method==='GET'&&rows.has(key)?{statusCode:200,result:rows.get(key)}:{statusCode:rows.has(key)?403:v.method==='GET'?404:204};
      })});
      if(path.includes('/sobjects/')){
        const name=path.split('/')[5] as keyof typeof identities;
        if(method==='POST'&&name==='WebStoreNetwork'&&(mode==='mapping_rejected'||mode==='prefer_proven_link'))
          return ok([{message:"This site doesn't support hosting a store.",errorCode:'FIELD_INTEGRITY_EXCEPTION'}],400);
        if(method==='POST'&&name==='WebStoreNetwork'&&mode==='mapping_unavailable')
          return {status:502,ok:false,body:{errorCode:'UPSTREAM_UNAVAILABLE'}};
        if(method==='POST'){rows.set(identities[name],{objectName:name,Id:identities[name],...body});return ok({id:mode==='wrong_store_response'&&name==='WebStore'?existingId:identities[name]},201);}
        const row=rows.get(path.split('/').at(-1)!);return row?ok(row):ok([],404);
      }
      if(method==='GET')return ok({inputs:inputsFor(path.split('/').at(-1)!).map(name=>({name}))});
      if(path.endsWith('/createCart')){
        if(mode==='create_hostname_rejection')return ok([{isSuccess:false,errors:[{statusCode:'INVALID_INPUT_COMBINATION',message:"Invalid Argument: Couldn't get the store hostname."}],outputValues:null}]);
        const args=body.inputs[0],cart=args.cartInput;
        rows.set(identities.WebCart,{objectName:'WebCart',Id:identities.WebCart,Name:cart.name,WebStoreId:args.webStoreId,AccountId:cart.effectiveAccountId,OwnerId:'005000000000001AAA',Status:'Active',Type:'Cart'});
        rows.set(identities.CartDeliveryGroup,{objectName:'CartDeliveryGroup',Id:identities.CartDeliveryGroup,CartId:identities.WebCart});
        return ok([{isSuccess:true,errors:null,outputValues:{cartSummary:{cartId:identities.WebCart,accountId:cart.effectiveAccountId,webstoreId:args.webStoreId,name:cart.name,status:'Active'}}}]);
      }
      if(path.endsWith('/addCartItem')){
        const args=body.inputs[0];
        if(mode==='empty_outcome')return ok([]);
        if(mode==='upstream_rejection')return ok([{isSuccess:false,errors:[{statusCode:'INVALID_INPUT_COMBINATION',message:'Invalid Argument: quantity must be a positive integer.'}],outputValues:null}]);
        if(mode==='linked_hostname_rejection')return ok([{isSuccess:false,errors:[{statusCode:'INVALID_INPUT_COMBINATION',message:"Invalid Argument: Couldn't get the store hostname."}],outputValues:null}]);
        if(mode==='lost_response'){rows.set(identities.CartItem,{objectName:'CartItem',Id:identities.CartItem,CartId:args.cartStateOrId,CartDeliveryGroupId:identities.CartDeliveryGroup,Product2Id:args.cartItemInput.productId,Quantity:1});return ok({errorCode:'UPSTREAM_LOST'},502);}
        const productId=mode==='wrong_identity'?otherProductId:args.cartItemInput.productId;
        if(mode!=='false_success')rows.set(identities.CartItem,{objectName:'CartItem',Id:identities.CartItem,CartId:args.cartStateOrId,CartDeliveryGroupId:identities.CartDeliveryGroup,Product2Id:productId,Quantity:1});
        const outputId=mode==='output_mismatch'?'0a9000000000002AAA':mode==='wrong_identity'?identities.CartItem:mode==='false_success'?undefined:identities.CartItem;
        return ok([{isSuccess:true,errors:null,outputValues:{cartItem:outputId?{cartItemId:outputId}:null}}]);
      }
      if(path.endsWith('/updateCartItem')){
        if(mode==='update_hostname_rejection')return ok([{isSuccess:false,errors:[{statusCode:'INVALID_INPUT_COMBINATION',message:"Invalid Argument: Couldn't get the store hostname."}],outputValues:null}]);
        if(mode==='empty_outcome')return ok([]);
        if(mode==='update_rejection')return ok([{isSuccess:false,errors:[{statusCode:'REJECTED'}],outputValues:null}]);
        if(mode!=='update_no_change')rows.get(identities.CartItem).Quantity=2;
        return ok([{isSuccess:true,errors:null,outputValues:{}}]);
      }
      throw Error('Unexpected request');
    }});
  return {result,rows,calls};
}
for(const action of ['addCartItem','updateCartItem'])test(`native ${action} verifies the actual owned item and cleanup`,async()=>{
  const {result,rows,calls}=await run(action);
  expect(result.contextSchema?.verified).toBe(true);expect(result.cleanupError).toBeUndefined();expect(rows.size).toBe(0);
  expect(result.contextSchema?.source).toBe('salesforce_live_native_cart_item_action');
  expect(result.contextSchema?.verificationRecordIds).toEqual([identities.CartItem]);
  if(action==='updateCartItem')expect(result.contextSchema?.afterQuantity).toBe(2);
  expect(calls.some(c=>c.path.endsWith('/'+action)&&c.method==='POST')).toBe(true);
  expect(calls.length).toBeLessThan(80);
});
test('native addCartItem provisions no existing customer product',async()=>{
  const {result,calls}=await run('addCartItem');
  expect(calls.filter(c=>c.path.includes('/sobjects/Product2')&&c.method==='POST').length).toBe(1);
  expect(calls.filter(c=>c.path.includes('/sobjects/PricebookEntry')&&c.method==='POST').length).toBe(1);
  expect(result.contextSchema?.productId).toBe(identities.Product2);
  expect(result.contextSchema?.pricebookEntryId).toBe(identities.PricebookEntry);
});
for(const mode of ['false_success','wrong_identity','output_mismatch'])test(`native addCartItem rejects ${mode} and cleans the owned graph`,async()=>{
  const {result,rows}=await run('addCartItem',mode);expect(result.contextSchema?.verified).toBe(false);
  expect(result.body.errorCode).toBe('CART_ITEM_UNVERIFIED');expect(rows.size).toBe(0);
});
test('a lost native add response still discovers and removes the actual item',async()=>{
  const {result,rows}=await run('addCartItem','lost_response');expect(result.status).toBe(502);
  expect(result.contextSchema?.ownedRecords.some((r:any)=>r.objectName==='CartItem')).toBe(true);expect(rows.size).toBe(0);
});
test('an empty HTTP 200 item outcome is explicitly rejected while cleaning any actual writes',async()=>{
  const {result,rows}=await run('addCartItem','empty_outcome');expect(result.body.errorCode).toBe('CART_ACTION_OUTCOME_MISSING');
  expect(result.contextSchema?.nativeAddEvidence.outcomeCount).toBe(0);expect(result.contextSchema?.verified).toBe(false);expect(rows.size).toBe(0);
});
test('a genuine Salesforce provisioning rejection is preserved with cleanup',async()=>{
  const {result,rows}=await run('addCartItem','upstream_rejection');
  expect(result.body[0].isSuccess).toBe(false);expect(result.body[0].errors[0].statusCode).toBe('INVALID_INPUT_COMBINATION');
  expect(result.contextSchema?.verified).toBe(false);expect(rows.size).toBe(0);
});
test('native update success without an actual quantity change is rejected',async()=>{
  const {result,rows}=await run('updateCartItem','update_no_change');expect(result.body.errorCode).toBe('CART_ITEM_UPDATE_UNVERIFIED');
  expect(result.contextSchema?.verified).toBe(false);expect(rows.size).toBe(0);
});
test('native update rejection survives even when the record exists',async()=>{
  const {result,rows}=await run('updateCartItem','update_rejection');expect(result.body[0].isSuccess).toBe(false);
  expect(result.contextSchema?.verified).toBe(false);expect(rows.size).toBe(0);
});
test('a missing standard pricebook fails explicitly after cleaning owned store, buyer and product',async()=>{
  const {result,rows}=await run('addCartItem','no_pricebook');expect(result.body.errorCode).toBe('CART_PRICEBOOK_UNAVAILABLE');
  expect(result.contextSchema?.verified).toBe(false);expect(rows.size).toBe(0);
});
test('cleanup readback failure remains explicit after actual native item success',async()=>{
  const {result,rows}=await run('addCartItem','cleanup_rejection');expect(result.contextSchema?.verified).toBe(true);
  expect(result.cleanupError).toContain('cleanup');expect(rows.size).toBeGreaterThan(0);
});
test('missing cleanup access prevents all item mutations',async()=>{
  const {result,calls}=await run('addCartItem','missing_cleanup');expect(result.body.errorCode).toBe('CART_CONTEXT_PERMISSIONS_REQUIRED');
  expect(calls.some(isMutation)).toBe(false);
});
test('wrong fixture creation identity preserves the existing store and recovers the actual owned write',async()=>{
  const {result,rows,calls}=await run('addCartItem','wrong_store_response');
  expect(result.body.errorCode).toBe('CART_STORE_UNVERIFIED');expect(result.cleanupError).toContain('deletion was withheld');
  expect(rows.size).toBe(1);expect(rows.get('0ZE000000000002AAA').Name).toBe('Existing customer store');
  expect(calls.filter(call=>call.path.endsWith('/composite/batch')).flatMap(call=>call.body.batchRequests).some(operation=>operation.method==='DELETE'&&operation.url.endsWith('0ZE000000000002AAA'))).toBe(false);
});
test('inventory reservation stays an explicit failure without any mutation',async()=>{
  const failure=cartInventoryReservationUnsupported();
  expect(failure.status).toBe(422);expect(failure.ok).toBe(false);
  expect(failure.body.errorCode).toBe('CART_INVENTORY_RESERVATION_UNSUPPORTED');
});
test('the hostname mapping links the owned store and is cleaned with the graph',async()=>{
  const {result,rows,calls}=await run('addCartItem');
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.webStoreNetworkId).toBe(identities.WebStoreNetwork);
  expect(result.contextSchema?.networkId).toBe(liveNetworkIds[0]);
  expect(result.contextSchema?.hostnameEvidence).toMatchObject({liveNetworkCount:1,linked:true});
  expect(calls.some(call=>call.path.endsWith('/sobjects/WebStoreNetwork')&&call.method==='POST')).toBe(true);
  expect(rows.size).toBe(0);
});
test('no live community refuses honestly before any item mutation',async()=>{
  const {result,rows,calls}=await run('addCartItem','no_live_network');
  expect(result.body.errorCode).toBe('CART_STORE_HOSTNAME_UNAVAILABLE');
  expect(result.body.message).toContain('0 live site(s)');
  expect(result.contextSchema?.verified).toBe(false);
  expect(result.contextSchema?.hostnameEvidence).toMatchObject({liveNetworkCount:0,linked:false});
  expect(calls.some(call=>call.path.includes('/sobjects/Account')&&call.method==='POST')).toBe(false);
  expect(calls.some(call=>call.path.endsWith('/createCart')&&call.method==='POST')).toBe(false);
  expect(rows.size).toBe(0);
});
test('rejected mappings record per-candidate reasons then refuse honestly',async()=>{
  const {result,rows,calls}=await run('addCartItem','mapping_rejected');
  expect(result.body.errorCode).toBe('CART_STORE_HOSTNAME_UNAVAILABLE');
  expect(result.body.message).toContain("doesn't support hosting a store");
  const attempts=result.contextSchema?.hostnameEvidence.mappingAttempts;
  expect(attempts.length).toBe(2);
  expect(attempts[0]).toMatchObject({networkId:liveNetworkIds[0],rejected:true,errorCode:'FIELD_INTEGRITY_EXCEPTION'});
  expect(attempts[0].message).toContain("doesn't support hosting a store");
  expect(calls.filter(call=>call.path.endsWith('/sobjects/WebStoreNetwork')&&call.method==='POST').length).toBe(2);
  expect(calls.some(call=>call.path.includes('/sobjects/Account')&&call.method==='POST')).toBe(false);
  expect(rows.size).toBe(0);
});
test('a linked native hostname rejection maps to the honest setup code',async()=>{
  const {result,rows}=await run('addCartItem','linked_hostname_rejection');
  expect(result.body.errorCode).toBe('CART_STORE_HOSTNAME_UNAVAILABLE');
  expect(result.status).toBe(422);
  expect(result.contextSchema?.verified).toBe(false);
  expect(result.contextSchema?.hostnameEvidence).toMatchObject({liveNetworkCount:1,linked:true});
  expect(result.contextSchema?.webStoreNetworkId).toBe(identities.WebStoreNetwork);
  expect(rows.size).toBe(0);
});
test('a native hostname failure on createCart maps to the honest setup code',async()=>{
  const {result,rows}=await run('addCartItem','create_hostname_rejection');
  expect(result.body.errorCode).toBe('CART_STORE_HOSTNAME_UNAVAILABLE');
  expect(result.contextSchema?.verified).toBe(false);
  expect(result.contextSchema?.hostnameEvidence).toMatchObject({linked:true});
  expect(rows.size).toBe(0);
});
test('a native hostname failure on updateCartItem maps to the honest setup code',async()=>{
  const {result,rows}=await run('updateCartItem','update_hostname_rejection');
  expect(result.body.errorCode).toBe('CART_STORE_HOSTNAME_UNAVAILABLE');
  expect(result.contextSchema?.verified).toBe(false);
  expect(result.contextSchema?.hostnameEvidence).toMatchObject({linked:true});
  expect(rows.size).toBe(0);
});
test('proven store-template candidates are tried before unproven ones',async()=>{
  const {result,rows,calls}=await run('addCartItem','prefer_proven_link');
  expect(result.body.errorCode).toBe('CART_STORE_HOSTNAME_UNAVAILABLE');
  const posts=calls.filter(call=>call.path.endsWith('/sobjects/WebStoreNetwork')&&call.method==='POST');
  expect(posts.length).toBe(2);
  expect(posts[0].body.NetworkId).toBe(liveNetworkIds[1]);
  expect(result.contextSchema?.hostnameEvidence.provenStoreLinkCount).toBe(1);
  expect(result.contextSchema?.hostnameEvidence.mappingAttempts[0]).toMatchObject({networkId:liveNetworkIds[1],provenStoreLink:true});
  expect(rows.get('0n5000000000001AAA').NetworkId).toBe(liveNetworkIds[1]);
  expect(rows.size).toBe(1);
});
test('hostname detection matches only the exact native lookup failure',()=>{
  expect(isStoreHostnameUnavailable([{isSuccess:false,errors:[{message:"Invalid Argument: Couldn't get the store hostname."}]}])).toBe(true);
  expect(isStoreHostnameUnavailable({errorCode:'X',message:'quantity must be a positive integer'})).toBe(false);
  expect(isStoreHostnameUnavailable([{isSuccess:false,errors:[{message:'Invalid store id'}]}])).toBe(false);
  expect(isStoreHostnameUnavailable(null)).toBe(false);
});
test('rejection extraction covers array and object failure shapes',()=>{
  expect(salesforceRejectionOf({status:400,ok:false,body:[{message:"This site doesn't support hosting a store.",errorCode:'FIELD_INTEGRITY_EXCEPTION'}]}))
    .toEqual({status:400,errorCode:'FIELD_INTEGRITY_EXCEPTION',message:"This site doesn't support hosting a store."});
  expect(salesforceRejectionOf({status:422,ok:false,body:{errorCode:'CART_X',message:'nope'}})).toEqual({status:422,errorCode:'CART_X',message:'nope'});
  expect(salesforceRejectionOf({status:502,ok:false,body:{errorCode:'UPSTREAM_UNAVAILABLE'}})).toEqual({status:502,errorCode:'UPSTREAM_UNAVAILABLE'});
});
test('unavailable mapping access fails explicitly without any mutation',async()=>{
  const {result,rows,calls}=await run('addCartItem','mapping_not_createable');
  expect(result.body.errorCode).toBe('CART_STORE_HOSTNAME_UNAVAILABLE');
  expect(calls.some(isMutation)).toBe(false);
  expect(rows.size).toBe(0);
});
test('a transport failure while linking preserves the upstream error',async()=>{
  const {result,rows}=await run('addCartItem','mapping_unavailable');
  expect(result.status).toBe(502);
  expect(result.contextSchema?.verified).toBe(false);
  expect(rows.size).toBe(0);
});
for(const action of ['addCartItem','updateCartItem'])test(`provisioned reuse converts native ${action} without touching substrate`,async()=>{
  const {result,rows,calls}=await run(action,'reuse_store');
  expect(result.contextSchema?.verified).toBe(true);expect(result.cleanupError).toBeUndefined();
  expect(result.contextSchema?.reusedStore).toBe(true);expect(result.contextSchema?.storeType).toBe('B2B');
  expect(result.contextSchema?.storeId).toBe('0ZE000000000009AAA');
  expect(calls.some(c=>c.path.endsWith('/sobjects/WebStore')&&c.method==='POST')).toBe(false);
  expect(calls.some(c=>c.path.endsWith('/sobjects/WebStoreNetwork')&&c.method==='POST')).toBe(false);
  expect(calls.some(c=>c.path.endsWith('/sobjects/BuyerAccount')&&c.method==='POST')).toBe(true);
  expect(calls.some(c=>c.path.endsWith('/sobjects/CommerceEntitlementProduct')&&c.method==='POST')).toBe(true);
  const deletes=calls.filter(call=>call.path.endsWith('/composite/batch')).flatMap(call=>call.body.batchRequests).filter((operation:any)=>operation.method==='DELETE').map((operation:any)=>operation.url);
  for(const kept of ['0ZE000000000009AAA','0ZF000000000009AAA','0CD000000000009AAA','0CH000000000009AAA','0ZS000000000009AAA','0ZG000000000009AAA','0CE000000000009AAA']){
    expect(rows.has(kept)).toBe(true);
    expect(deletes.some((url:string)=>url.endsWith(kept))).toBe(false);
  }
  expect(rows.size).toBe(7);
});
