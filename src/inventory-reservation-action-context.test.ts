import {expect,test} from 'bun:test';
import {invokeInventoryReservation,inventoryProviderRejectionOf,INVENTORY_RESERVATION_ACTIONS} from './inventory-reservation-action-context';
const identities={WebStore:'0ZE000000000001AAA',Account:'001000000000001AAA',WebCart:'0a6000000000001AAA',
  Product2:'01t000000000001AAA',CartItem:'0a9000000000001AAA',CartDeliveryGroup:'0a7000000000001AAA',
  Location:'131000000000001AAA',LocationGroup:'0gh000000000001AAA',LocationGroupAssignment:'0gx000000000001AAA',
  WebStoreInventorySource:'10t000000000001AAA',InventoryReservation:'0tv000000000001AAA',InventoryItemReservation:'0tw000000000001AAA'};
async function run(action='createInvRsvForCart',mode='normal'){
  const rows=new Map<string,any>(),calls:Array<{path:string;method:string;body:any}>=[];
  const ok=(body:any,status=200)=>({status,ok:status>=200&&status<300,body});
  const fieldsFor=(name:string)=>{
    const base=[{name:'Id'},{name:'Name',createable:true,filterable:true,length:255}];
    if(name==='WebStore')return [...base,{name:'Type',createable:true,picklistValues:[{active:true,value:'B2CE'}]}];
    if(name==='WebCart')return [{name:'Name',filterable:true},{name:'Type',picklistValues:[{active:true,value:'Cart'}]}];
    if(name==='Product2')return mode==='sku_unavailable'?base:[...base,{name:'StockKeepingUnit',createable:true,length:255}];
    if(name==='Location')return [...base,{name:'LocationType',createable:true,picklistValues:mode==='no_location_picklist'?[]:[{active:true,value:'Site'}]},
      {name:'IsInventoryLocation',createable:true},{name:'ExternalReference',createable:true}];
    if(name==='LocationGroup')return [{name:'LocationGroupName',createable:true,filterable:true,length:255},
      {name:'ExternalReference',createable:true},{name:'IsEnabled',createable:true},{name:'ShouldSyncWithOci',createable:true}];
    if(name==='LocationGroupAssignment')return [{name:'LocationId',createable:true},{name:'LocationGroupId',createable:true}];
    if(name==='WebStoreInventorySource')return [{name:'WebStoreId',createable:true},{name:'LocationSourceId',createable:true},
      {name:'ReservationDurationInSeconds',createable:true},{name:'InventoryDimension',createable:true,picklistValues:[{active:true,value:'AvailableToFulfill'}]}];
    if(name==='CartItem')return [...base,{name:'Type',createable:true}];
    return base;
  };
  const inputsFor=(name:string)=>name==='createCart'?['webStoreId','cartInput']
    :name==='createInvRsvForCart'?['webStoreId','activeCartOrId','effectiveAccountId','cartInventoryReservationInputRepresentation']
    :['webStoreId','activeCartOrId','effectiveAccountId'];
  const writeReservationRows=()=>{
    rows.set(identities.InventoryReservation,{objectName:'InventoryReservation',Id:identities.InventoryReservation});
    rows.set(identities.InventoryItemReservation,{objectName:'InventoryItemReservation',Id:identities.InventoryItemReservation,
      InventoryReservationId:identities.InventoryReservation,ItemReservationSourceId:identities.CartItem,Product2Id:identities.Product2,
      Quantity:1,ReservedAtLocationId:identities.LocationGroup});
  };
  const result=await invokeInventoryReservation({root:'/services/data/v67.0',route:'/services/data/v67.0/actions/standard/'+action,
    build:async(_name,_marker,values)=>({values}),request:async(path,method='GET',body)=>{
      calls.push({path,method,body});
      if(path.endsWith('/describe')){
        const name=path.split('/')[5];
        return ok({queryable:true,deletable:mode!=='missing_cleanup',createable:!(mode==='source_not_createable'&&name==='WebStoreInventorySource'),fields:fieldsFor(name)});
      }
      if(path.includes('/query?')){
        const q=decodeURIComponent(path);
        const name=q.match(/ FROM (\w+)/)?.[1]!;const conditions=[...q.matchAll(/(\w+)='([^']+)'/g)];
        return ok({records:[...rows.values()].filter(row=>row.objectName===name&&conditions.every(([,field,value])=>String(row[field])===value)).map(({objectName,...row})=>row)});
      }
      if(path.endsWith('/composite/batch'))return ok({results:body.batchRequests.map((v:any)=>{
        const key=v.url.split('/').at(-1);
        if(v.url.endsWith('/describe')){
          const name=v.url.split('/').at(-2);
          return {statusCode:200,result:{queryable:true,deletable:mode!=='missing_cleanup',createable:!(mode==='source_not_createable'&&name==='WebStoreInventorySource'),fields:fieldsFor(name)}};
        }
        if(v.url.includes('/actions/standard/'))return {statusCode:200,result:{inputs:inputsFor(key).map(name=>({name}))}};
        if(v.method==='DELETE'&&mode!=='cleanup_rejection')rows.delete(key);
        return v.method==='GET'&&rows.has(key)?{statusCode:200,result:rows.get(key)}:{statusCode:rows.has(key)?403:v.method==='GET'?404:204};
      })});
      if(path.includes('/sobjects/')){
        const name=path.split('/')[5] as keyof typeof identities;
        if(method==='POST'){rows.set(identities[name],{objectName:name,Id:identities[name],...body});return ok({id:identities[name]},201);}
        const row=rows.get(path.split('/').at(-1)!);return row?ok(row):ok([],404);
      }
      if(method==='GET')return ok({inputs:inputsFor(path.split('/').at(-1)!).map(name=>({name}))});
      if(path.endsWith('/createCart')){
        const args=body.inputs[0],cart=args.cartInput;
        rows.set(identities.WebCart,{objectName:'WebCart',Id:identities.WebCart,Name:cart.name,WebStoreId:args.webStoreId,AccountId:cart.effectiveAccountId,OwnerId:'005000000000001AAA',Status:'Active',Type:'Cart'});
        rows.set(identities.CartDeliveryGroup,{objectName:'CartDeliveryGroup',Id:identities.CartDeliveryGroup,CartId:identities.WebCart});
        return ok([{isSuccess:true,errors:null,outputValues:{cartSummary:{cartId:identities.WebCart,accountId:cart.effectiveAccountId,webstoreId:args.webStoreId,name:cart.name,status:'Active'}}}]);
      }
      if(path.endsWith('/createInvRsvForCart')){
        if(mode==='empty_outcome')return ok([]);
        if(mode==='upstream_rejection')return ok([{isSuccess:false,errors:[{statusCode:'INVALID_INPUT_COMBINATION',message:'Invalid Argument: webStoreId is required.'}],outputValues:null}]);
        if(mode==='lost_response'){writeReservationRows();return ok({errorCode:'UPSTREAM_LOST'},502);}
        if(mode==='provider_rejection'||mode==='setup_provider_fail')return ok([{isSuccess:true,errors:null,outputValues:{cartInventoryReservationOutputRepresentation:
          {success:false,errorCode:'UnregisteredOciError',errorMessage:'There was an unregistered inventory provider error.',reservationIdentifier:'rsv-mock-1',inventoryItemReservations:[]}}}]);
        if(mode!=='unverified_success')writeReservationRows();
        return ok([{isSuccess:true,errors:null,outputValues:{cartInventoryReservationOutputRepresentation:
          {success:true,reservationIdentifier:'rsv-mock-1',inventoryItemReservations:[{itemReservationSourceId:identities.CartItem,productId:identities.Product2,quantity:1,reservedAtLocationId:identities.LocationGroup}]}}}]);
      }
      if(path.endsWith('/deleteInvRsvForCart')){
        if(mode==='empty_outcome')return ok([]);
        if(mode!=='release_unverified'){rows.delete(identities.InventoryItemReservation);rows.delete(identities.InventoryReservation);}
        return ok([{isSuccess:true,errors:null,outputValues:null}]);
      }
      throw Error('Unexpected request');
    }});
  return {result,rows,calls};
}
for(const action of INVENTORY_RESERVATION_ACTIONS)test(`native ${action} verifies actual reservations and cleanup`,async()=>{
  const {result,rows,calls}=await run(action);
  expect(result.contextSchema?.verified).toBe(true);expect(result.cleanupError).toBeUndefined();expect(rows.size).toBe(0);
  expect(result.contextSchema?.source).toBe('salesforce_live_native_inventory_reservation_action');
  expect(calls.some(c=>c.path.endsWith('/'+action)&&c.method==='POST')).toBe(true);
  if(action==='createInvRsvForCart')expect(result.contextSchema?.verificationRecordIds).toEqual([identities.InventoryItemReservation]);
  else expect(result.contextSchema?.verificationRecordIds).toEqual([identities.CartItem]);
  expect(calls.length).toBeLessThan(110);
  // Worker subrequest budget: the full lifecycle (schema batch, fixtures,
  // native invokes, recovery check, cleanup batches) must stay well under
  // the 50-subrequest invocation cap or cleanup starves and leaks.
  expect(calls.length).toBeLessThan(45);
});
test('a provider-level rejection stays explicit with the native evidence and full cleanup',async()=>{
  const {result,rows}=await run('createInvRsvForCart','provider_rejection');
  expect(result.body.errorCode).toBe('INVENTORY_PROVIDER_UNAVAILABLE');
  expect(result.body.message).toContain('UnregisteredOciError');
  expect(result.contextSchema?.verified).toBe(false);
  expect(result.contextSchema?.nativeReservationEvidence.providerSuccess).toBe(false);
  expect(result.contextSchema?.nativeReservationEvidence.actualItemReservationCount).toBe(0);
  expect(rows.size).toBe(0);
});
test('provider success without actual item rows is rejected',async()=>{
  const {result,rows}=await run('createInvRsvForCart','unverified_success');
  expect(result.body.errorCode).toBe('INVENTORY_RESERVATION_UNVERIFIED');
  expect(result.contextSchema?.verified).toBe(false);expect(rows.size).toBe(0);
});
test('a genuine native rejection is preserved with cleanup',async()=>{
  const {result,rows}=await run('createInvRsvForCart','upstream_rejection');
  expect(result.body[0].isSuccess).toBe(false);
  expect(result.contextSchema?.verified).toBe(false);expect(rows.size).toBe(0);
});
test('an empty HTTP 200 outcome is explicitly rejected while cleaning any actual writes',async()=>{
  const {result,rows}=await run('createInvRsvForCart','empty_outcome');
  expect(result.body.errorCode).toBe('INVENTORY_ACTION_OUTCOME_MISSING');
  expect(result.contextSchema?.verified).toBe(false);expect(rows.size).toBe(0);
});
test('native release leaving actual rows is rejected',async()=>{
  const {result,rows}=await run('deleteInvRsvForCart','release_unverified');
  expect(result.body.errorCode).toBe('INVENTORY_RELEASE_UNVERIFIED');
  expect(result.contextSchema?.verified).toBe(false);expect(rows.size).toBe(0);
});
test('delete verifies absence even when the provider setup yielded nothing',async()=>{
  const {result,rows}=await run('deleteInvRsvForCart','setup_provider_fail');
  expect(result.contextSchema?.verified).toBe(true);expect(result.cleanupError).toBeUndefined();expect(rows.size).toBe(0);
});
test('a lost native create response still discovers and removes actual reservation rows',async()=>{
  const {result,rows}=await run('createInvRsvForCart','lost_response');expect(result.status).toBe(502);
  expect(result.contextSchema?.ownedRecords.some((r:any)=>r.objectName==='InventoryItemReservation')).toBe(true);expect(rows.size).toBe(0);
});
test('missing cleanup access prevents all reservation mutations',async()=>{
  const {result,calls}=await run('createInvRsvForCart','missing_cleanup');
  expect(result.body.errorCode).toBe('INVENTORY_CONTEXT_PERMISSIONS_REQUIRED');
  expect(calls.some(c=>c.method==='POST'&&!c.path.endsWith('/composite/batch'))).toBe(false);
});
test('missing source creation access prevents all reservation mutations',async()=>{
  const {result,calls}=await run('createInvRsvForCart','source_not_createable');
  expect(result.body.errorCode).toBe('INVENTORY_CONTEXT_PERMISSIONS_REQUIRED');
  expect(calls.some(c=>c.method==='POST'&&!c.path.endsWith('/composite/batch'))).toBe(false);
});
test('a missing product SKU fails explicitly before any mutation',async()=>{
  const {result,calls}=await run('createInvRsvForCart','sku_unavailable');
  expect(result.body.errorCode).toBe('INVENTORY_SKU_UNAVAILABLE');
  expect(calls.some(c=>c.method==='POST'&&!c.path.endsWith('/composite/batch'))).toBe(false);
});
test('fallback location types apply only when the live describe advertises none',async()=>{
  const {result}=await run('createInvRsvForCart','no_location_picklist');
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.locationTypeUsed).toBe('Site');
});
test('cleanup readback failure remains explicit after actual native success',async()=>{
  const {result,rows}=await run('createInvRsvForCart','cleanup_rejection');
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.cleanupError).toContain('cleanup');expect(rows.size).toBeGreaterThan(0);
});
test('provider rejection extraction never invents a block',()=>{
  expect(inventoryProviderRejectionOf(null)).toBeNull();
  expect(inventoryProviderRejectionOf({success:true})).toBeNull();
  expect(inventoryProviderRejectionOf({success:false,errorCode:'UnregisteredOciError',errorMessage:'There was an unregistered inventory provider error.'})).toMatchObject({errorCode:'UnregisteredOciError'});
});
