import { cleanupOwnedContext, type OwnershipScope } from './owned-context-cleanup';
type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const id = (v: any): v is string => typeof v === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
const successful = (r: Result) => r.ok && Array.isArray(r.body) && r.body.length === 1 && r.body[0]?.isSuccess === true && !r.body[0].errors?.length;
export const INVENTORY_RESERVATION_ACTIONS = ['createInvRsvForCart', 'deleteInvRsvForCart'];
export const INVENTORY_RESERVATION_BUILDER_VERSION = 83;
export const INVENTORY_RESERVATION_OBJECTS = ['WebStore', 'Account', 'Product2', 'WebCart', 'CartItem', 'CartDeliveryGroup',
  'Location', 'LocationGroup', 'LocationGroupAssignment', 'WebStoreInventorySource', 'InventoryReservation', 'InventoryItemReservation'];
const CREATED_INVENTORY_OBJECTS = ['WebStore', 'Account', 'Product2', 'CartItem', 'Location', 'LocationGroup', 'LocationGroupAssignment', 'WebStoreInventorySource'];
const RESERVATION_QUANTITY = '1', RESERVATION_DURATION_SECONDS = 3600;
/** Platform-standard LocationType values, used only when the live describe advertises no active picklist entry. */
const FALLBACK_LOCATION_TYPES = ['Site', 'Warehouse', 'Plant', 'Van'];

/** Generic rejection extraction: first error code/message from any Salesforce failure body shape. */
function salesforceRejectionOf(result: Result): {status:number; errorCode?:string; message?:string} {
  const rejection: {status:number; errorCode?:string; message?:string} = {status:result.status};
  const bodies = Array.isArray(result.body) ? result.body : [result.body];
  for (const entry of bodies) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Value;
    const nested = Array.isArray(record.errors) ? record.errors.find((e: Value)=>e && typeof e === 'object') : undefined;
    const errorCode = record.errorCode ?? record.statusCode ?? record.code ?? nested?.errorCode ?? nested?.statusCode;
    const message = record.message ?? nested?.message;
    if (typeof errorCode === 'string' && errorCode) rejection.errorCode = errorCode.slice(0, 96);
    if (typeof message === 'string' && message) rejection.message = message.slice(0, 280);
    if (rejection.errorCode || rejection.message) break;
  }
  return rejection;
}

/** Provider verdict inside an accepted native outcome; null when the provider accepted or never answered. */
export function inventoryProviderRejectionOf(output: unknown): {errorCode?:string; message?:string} | null {
  if (!output || typeof output !== 'object') return null;
  const record = output as Value;
  if (record.success === true || record.success === undefined && record.errorCode === undefined) return null;
  const rejection: {errorCode?:string; message?:string} = {};
  if (typeof record.errorCode === 'string' && record.errorCode) rejection.errorCode = record.errorCode.slice(0, 96);
  const message = record.errorMessage ?? record.message;
  if (typeof message === 'string' && message) rejection.message = message.slice(0, 280);
  return rejection.errorCode || rejection.message ? rejection : {message:'The inventory provider reported failure without detail.'};
}

/** Native inventory reservation operates on an owned store, buyer, SKU product, cart, placed item and inventory source. */
export async function invokeInventoryReservation(input: {
  root: string; route: string; verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value, schema?: unknown) => Promise<{ values: Value } | { failure: Result }>;
}): Promise<{status: number; body: any; cleanupError?: string; contextSchema?: Value}> {
  const {root,request} = input, action = input.route.split('/').at(-1)!;
  const fail = (errorCode: string, message: string): Result => ({status:422,ok:false,body:{errorCode,message}});
  if (!INVENTORY_RESERVATION_ACTIONS.includes(action)) return fail('INVENTORY_ACTION_INVALID','A supported discovered native inventory reservation route is required.');
  const schemas: Value = {}, descriptors: Value = {};
  // One composite read for all 15 schemas: sequential describes exhaust the
  // worker subrequest budget before cleanup can run (fixtures leak).
  {
    const api = root.replace(/^\/services\/data\//,'');
    const actionNames = [...new Set(['createCart', 'createInvRsvForCart', action])];
    const urls = [...INVENTORY_RESERVATION_OBJECTS.map(name=>`${api}/sobjects/${name}/describe`),
      ...actionNames.map(name=>`${api}/actions/standard/${name}`)];
    const batched = await request(root+'/composite/batch','POST',{haltOnError:false,
      batchRequests:urls.map(url=>({method:'GET',url}))});
    if (!batched.ok || !Array.isArray(batched.body?.results) || batched.body.results.length!==urls.length)
      return {status:502,body:{errorCode:'INVENTORY_SCHEMA_BATCH_UNAVAILABLE',message:'Live schema batch readback was incomplete.'}};
    for (const [index,name] of INVENTORY_RESERVATION_OBJECTS.entries()) {
      const sub = batched.body.results[index];
      if (sub?.statusCode!==200 || sub.result==null) return {status:sub?.statusCode??502,body:sub?.result??{errorCode:'INVENTORY_SCHEMA_UNAVAILABLE',message:`Live ${name} schema could not be read.`}};
      if (!sub.result.queryable || !sub.result.deletable || !Array.isArray(sub.result.fields)) return fail('INVENTORY_CONTEXT_PERMISSIONS_REQUIRED','Live owned inventory records require query and cleanup access.');
      if (CREATED_INVENTORY_OBJECTS.includes(name) && !sub.result.createable) return fail('INVENTORY_CONTEXT_PERMISSIONS_REQUIRED','Live owned inventory fixtures require creation access.');
      schemas[name] = sub.result;
    }
    for (const [offset,name] of actionNames.entries()) {
      const sub = batched.body.results[INVENTORY_RESERVATION_OBJECTS.length+offset];
      if (sub?.statusCode!==200 || sub.result==null) return {status:sub?.statusCode??502,body:sub?.result??{errorCode:'INVENTORY_ACTION_SCHEMA_UNAVAILABLE',message:'The native reservation descriptor could not be read.'}};
      if (!Array.isArray(sub.result.inputs)) return fail('INVENTORY_ACTION_SCHEMA_UNAVAILABLE','The native reservation descriptor has no input schema.');
      descriptors[name] = sub.result;
    }
  }
  if (!['webStoreId','cartInput'].every(name => descriptors.createCart.inputs.some((f: Value)=>f.name===name))) return fail('INVENTORY_ACTION_SCHEMA_UNAVAILABLE','The live creation action does not publish store and cart inputs.');
  const createNames = new Set(descriptors.createInvRsvForCart.inputs.map((f: Value)=>f.name));
  if (!['webStoreId','activeCartOrId','effectiveAccountId','cartInventoryReservationInputRepresentation'].every(name=>createNames.has(name)))
    return fail('INVENTORY_ACTION_SCHEMA_UNAVAILABLE','The native create reservation descriptor lacks store, cart, buyer or payload inputs.');
  if (action==='deleteInvRsvForCart') {
    const deleteNames = new Set(descriptors.deleteInvRsvForCart.inputs.map((f: Value)=>f.name));
    if (!['webStoreId','activeCartOrId','effectiveAccountId'].every(name=>deleteNames.has(name)))
      return fail('INVENTORY_ACTION_SCHEMA_UNAVAILABLE','The native delete reservation descriptor lacks store, cart or buyer inputs.');
  }
  const types = schemas.WebStore.fields.find((f: Value)=>f.name==='Type'&&f.createable)?.picklistValues?.filter((p: Value)=>p.active&&typeof p.value==='string').map((p: Value)=>p.value) ?? [];
  const cartType = schemas.WebCart.fields.find((f: Value)=>f.name==='Type')?.picklistValues?.find((p: Value)=>p.active&&p.value==='Cart')?.value;
  if (!types.length || !cartType) return fail('INVENTORY_TYPE_UNAVAILABLE','Live store types and the standard Cart type are required.');
  for (const name of ['WebStore','Account','Product2','Location'])
    if (!schemas[name].createable || !schemas[name].fields.some((f: Value)=>f.name==='Name'&&f.createable&&f.filterable&&f.length>=48))
      return fail('INVENTORY_MARKER_UNAVAILABLE','Owned store, buyer, product and location records require writable, queryable Name markers.');
  if (!schemas.LocationGroup.fields.some((f: Value)=>f.name==='LocationGroupName'&&f.createable&&f.filterable&&f.length>=48))
    return fail('INVENTORY_MARKER_UNAVAILABLE','Owned location groups require a writable, queryable group-name marker.');
  if (!schemas.WebCart.fields.some((f: Value)=>f.name==='Name'&&f.filterable)) return fail('INVENTORY_MARKER_UNAVAILABLE','Owned cart discovery requires a queryable Name marker.');
  if (!schemas.CartItem.fields.some((f: Value)=>f.name==='Name'&&f.createable)) return fail('INVENTORY_ITEM_UNAVAILABLE','Owned cart items require a writable Name for direct placement; the native item route needs a storefront hostname.');
  const skuField = schemas.Product2.fields.find((f: Value)=>f.name==='StockKeepingUnit'&&f.createable);
  if (!skuField) return fail('INVENTORY_SKU_UNAVAILABLE','Owned products require a writable SKU; the native reservation rejects products without one.');
  if (!schemas.WebStoreInventorySource.fields.some((f: Value)=>f.name==='LocationSourceId'&&f.createable)
    || !schemas.WebStoreInventorySource.fields.some((f: Value)=>f.name==='ReservationDurationInSeconds'&&f.createable))
    return fail('INVENTORY_SOURCE_UNAVAILABLE','Owned inventory sources require a writable location link and reservation duration.');
  const liveLocationTypes = schemas.Location.fields.find((f: Value)=>f.name==='LocationType'&&f.createable)?.picklistValues?.filter((p: Value)=>p.active&&typeof p.value==='string').map((p: Value)=>p.value) ?? [];
  const locationTypeCandidates = liveLocationTypes.length ? liveLocationTypes : FALLBACK_LOCATION_TYPES;
  const inventoryDimension = schemas.WebStoreInventorySource.fields.find((f: Value)=>f.name==='InventoryDimension'&&f.createable)?.picklistValues?.find((p: Value)=>p.active&&typeof p.value==='string')?.value;
  const locationExtras = (marker: string, extRef: string, locationType: string) => ({Name:marker,LocationType:locationType,
    ...(schemas.Location.fields.some((f: Value)=>f.name==='IsInventoryLocation'&&f.createable)?{IsInventoryLocation:true}:{}),
    ...(schemas.Location.fields.some((f: Value)=>f.name==='ExternalReference'&&f.createable)?{ExternalReference:extRef}:{})});
  let last = fail('INVENTORY_CONTEXT_UNAVAILABLE','No live store type supported the native inventory reservation lifecycle.');
  for (const type of types) {
    const marker = 'AS invr '+crypto.randomUUID(), owned: Array<{objectName:string;id:string}> = [];
    const extRef = ('AS-invr-'+crypto.randomUUID()).slice(0, 80);
    const skuLength = typeof skuField.length === 'number' && skuField.length > 0 ? Math.min(skuField.length, 80) : 44;
    const sku = ('AS-invr-'+crypto.randomUUID()).slice(0, Math.max(36, skuLength));
    let storeId: string|undefined, accountId: string|undefined, productId: string|undefined, cartId: string|undefined,
      itemId: string|undefined, deliveryGroupId: string|undefined, locationId: string|undefined, locationGroupId: string|undefined,
      assignmentId: string|undefined, inventorySourceId: string|undefined, locationTypeUsed: string|undefined,
      verified=false, cleanupError: string|undefined;
    let attemptedStore=false,attemptedBuyer=false,attemptedProduct=false,attemptedCart=false,attemptedItem=false,
      attemptedLocation=false,attemptedGroup=false,attemptedAssignment=false,attemptedSource=false;
    let nativeCreateEvidence: Value|undefined, nativeItemEvidence: Value|undefined,
      nativeReservationEvidence: Value|undefined, nativeDeleteEvidence: Value|undefined;
    const capture = (objectName: string, value: string) => {if(!owned.some(v=>v.id===value))owned.push({objectName,id:value});};
    const find = async (name: string, predicate: string, columns='Id,Name') => {
      const result = await request(root+'/query?q='+encodeURIComponent(`SELECT ${columns} FROM ${name} WHERE ${predicate} LIMIT 3`));
      if (!result.ok || !Array.isArray(result.body?.records) || result.body.records.length>=3) {
        const rows = Array.isArray(result.body?.records) ? result.body.records.length : 'unreadable';
        throw Error(`Owned inventory discovery failed for ${name}: status ${result.status}, rows ${rows}.`);
      }
      return result.body.records as Value[];
    };
    const findMarked = async (name: string, markerField='Name', extra='') => {
      const records = await find(name, `${markerField}='${marker}'`, `Id,${markerField}${extra}`);
      for (const row of records) {
        if (!id(row.Id)||row[markerField]!==marker||name==='WebCart'&&row.WebStoreId!==storeId) throw Error('Owned inventory marker or relationship mismatch.');
        capture(name,row.Id);
      }
      return records;
    };
    const findItemReservations = async () => {
      const rows = await find('InventoryItemReservation',`ItemReservationSourceId='${itemId}'`,'Id,InventoryReservationId,ItemReservationSourceId,ProductId,Quantity,ReservedAtLocationId');
      for (const row of rows) {
        if (!id(row.Id)||row.ItemReservationSourceId!==itemId) throw Error('Owned reservation marker or relationship mismatch.');
        capture('InventoryItemReservation',row.Id);
        if (id(row.InventoryReservationId)) capture('InventoryReservation',row.InventoryReservationId);
      }
      return rows;
    };
    let outcome: Result = last;
    try {
      outcome = await (async()=>{
        const store = await input.build('WebStore',marker,{Name:marker,Type:type},schemas.WebStore);
        if ('failure' in store) return store.failure;
        attemptedStore=true;
        const createdStore=await request(root+'/sobjects/WebStore','POST',store.values);
        if (!createdStore.ok||!id(createdStore.body?.id)) return createdStore;
        storeId=createdStore.body.id;capture('WebStore',storeId!);
        const storeRead=await request(root+'/sobjects/WebStore/'+storeId);
        if(!storeRead.ok||storeRead.body?.Name!==marker||storeRead.body?.Type!==type)return fail('INVENTORY_STORE_UNVERIFIED','Actual owned store readback failed.');
        const buyer=await input.build('Account',marker,{Name:marker},schemas.Account);
        if('failure' in buyer)return buyer.failure;
        attemptedBuyer=true;
        const createdBuyer=await request(root+'/sobjects/Account','POST',buyer.values);
        if(!createdBuyer.ok||!id(createdBuyer.body?.id))return createdBuyer;
        accountId=createdBuyer.body.id;capture('Account',accountId!);
        const buyerRead=await request(root+'/sobjects/Account/'+accountId);
        if(!buyerRead.ok||buyerRead.body?.Name!==marker)return fail('INVENTORY_BUYER_UNVERIFIED','Actual owned buyer readback failed.');
        const product=await input.build('Product2',marker,{Name:marker,IsActive:true,StockKeepingUnit:sku},schemas.Product2);
        if('failure' in product)return product.failure;
        attemptedProduct=true;
        const createdProduct=await request(root+'/sobjects/Product2','POST',product.values);
        if(!createdProduct.ok||!id(createdProduct.body?.id))return createdProduct;
        productId=createdProduct.body.id;capture('Product2',productId!);
        const productRead=await request(root+'/sobjects/Product2/'+productId);
        if(!productRead.ok||productRead.body?.Name!==marker||productRead.body?.StockKeepingUnit!==sku)return fail('INVENTORY_PRODUCT_UNVERIFIED','Actual owned SKU product readback failed.');
        attemptedCart=true;
        const created=await request(root+'/actions/standard/createCart','POST',{inputs:[{webStoreId:storeId,cartInput:{name:marker,type:cartType,effectiveAccountId:accountId}}]});
        nativeCreateEvidence={status:created.status,bodyKind:created.body===null?'null':Array.isArray(created.body)?'array':typeof created.body,
          outcomeCount:Array.isArray(created.body)?created.body.length:null,successFlags:Array.isArray(created.body)?created.body.map((v: Value)=>v?.isSuccess===true):[]};
        const carts=await findMarked('WebCart','Name',',WebStoreId,AccountId,OwnerId,Status,Type');
        if(created.ok&&(created.body===null||Array.isArray(created.body)&&created.body.length===0))return fail('INVENTORY_ACTION_OUTCOME_MISSING','Salesforce returned no native cart creation outcome for the owned buyer and store; no mutation is counted as successful.');
        if(!successful(created))return created;
        const returned=created.body[0].outputValues?.cartSummary;
        if(carts.length!==1||!id(carts[0]?.Id)||returned?.cartId!==carts[0].Id)return fail('INVENTORY_CART_UNVERIFIED','Native creation did not return one actual cart with the owned buyer and store.');
        cartId=carts[0].Id;
        const groups=await find('CartDeliveryGroup',`CartId='${cartId}'`,'Id,CartId');
        if(groups.length!==1||!id(groups[0]?.Id))return fail('INVENTORY_DELIVERY_GROUP_UNAVAILABLE','Native cart creation did not yield one actual delivery group for item placement.');
        deliveryGroupId=groups[0].Id;capture('CartDeliveryGroup',deliveryGroupId!);
        // Native addCartItem resolves a storefront hostname the owned community-less store
        // has no mapping for; the item is a real owned record placed directly and read back.
        const itemValues = {Name:marker,CartId:cartId,CartDeliveryGroupId:deliveryGroupId,Product2Id:productId,Quantity:RESERVATION_QUANTITY,
          ...(schemas.CartItem.fields.some((f: Value)=>f.name==='Type'&&f.createable)?{Type:'Product'}:{})};
        const item=await input.build('CartItem',marker,itemValues,schemas.CartItem);
        if('failure' in item)return item.failure;
        attemptedItem=true;
        const placedItem=await request(root+'/sobjects/CartItem','POST',item.values);
        nativeItemEvidence={status:placedItem.status,returnedId:placedItem.body?.id??null};
        if(!placedItem.ok||!id(placedItem.body?.id))return placedItem;
        itemId=placedItem.body.id;capture('CartItem',itemId!);
        const items=await find('CartItem',`CartId='${cartId}'`,'Id,CartId,CartDeliveryGroupId,Product2Id,Quantity');
        if(items.length!==1||items[0]?.Id!==itemId||items[0]?.Product2Id!==productId||Number(items[0]?.Quantity)!==Number(RESERVATION_QUANTITY))
          return fail('INVENTORY_ITEM_UNVERIFIED','Direct item placement did not yield one actual cart item with the owned cart and product.');
        const locationAttempts: Value[]=[];
        for (const locationType of locationTypeCandidates) {
          const built=await input.build('Location',marker,locationExtras(marker,extRef,locationType),schemas.Location);
          if('failure' in built)return built.failure;
          attemptedLocation=true;
          const createdLocation=await request(root+'/sobjects/Location','POST',built.values);
          if(createdLocation.ok&&id(createdLocation.body?.id)){
            locationId=createdLocation.body.id;locationTypeUsed=locationType;capture('Location',locationId!);
            break;
          }
          if(createdLocation.status>=500&&createdLocation.status<=599)return createdLocation;
          locationAttempts.push({locationType,...salesforceRejectionOf(createdLocation),rejected:true});
        }
        if(!locationId)return fail('INVENTORY_LOCATION_UNAVAILABLE','No live location type accepted the owned fulfillment location; no reservation was attempted.');
        const locationRead=await request(root+'/sobjects/Location/'+locationId);
        if(!locationRead.ok||locationRead.body?.Name!==marker)return fail('INVENTORY_LOCATION_UNVERIFIED','Actual owned location readback failed.');
        const group=await input.build('LocationGroup',marker,{LocationGroupName:marker,
          ...(schemas.LocationGroup.fields.some((f: Value)=>f.name==='ExternalReference'&&f.createable)?{ExternalReference:extRef}:{}),
          ...(schemas.LocationGroup.fields.some((f: Value)=>f.name==='IsEnabled'&&f.createable)?{IsEnabled:true}:{}),
          ...(schemas.LocationGroup.fields.some((f: Value)=>f.name==='ShouldSyncWithOci'&&f.createable)?{ShouldSyncWithOci:false}:{})},schemas.LocationGroup);
        if('failure' in group)return group.failure;
        attemptedGroup=true;
        const createdGroup=await request(root+'/sobjects/LocationGroup','POST',group.values);
        if(!createdGroup.ok||!id(createdGroup.body?.id))return createdGroup;
        locationGroupId=createdGroup.body.id;capture('LocationGroup',locationGroupId!);
        const groupRead=await request(root+'/sobjects/LocationGroup/'+locationGroupId);
        if(!groupRead.ok||groupRead.body?.LocationGroupName!==marker)return fail('INVENTORY_GROUP_UNVERIFIED','Actual owned location group readback failed.');
        const assignment=await input.build('LocationGroupAssignment',marker,{LocationId:locationId,LocationGroupId:locationGroupId},schemas.LocationGroupAssignment);
        if('failure' in assignment)return assignment.failure;
        attemptedAssignment=true;
        const createdAssignment=await request(root+'/sobjects/LocationGroupAssignment','POST',assignment.values);
        if(!createdAssignment.ok||!id(createdAssignment.body?.id))return createdAssignment;
        assignmentId=createdAssignment.body.id;capture('LocationGroupAssignment',assignmentId!);
        const assignmentRead=await request(root+'/sobjects/LocationGroupAssignment/'+assignmentId);
        if(!assignmentRead.ok||assignmentRead.body?.LocationGroupId!==locationGroupId||assignmentRead.body?.LocationId!==locationId)
          return fail('INVENTORY_ASSIGNMENT_UNVERIFIED','Actual owned location assignment readback failed.');
        const source=await input.build('WebStoreInventorySource',marker,{WebStoreId:storeId,LocationSourceId:locationGroupId,
          ReservationDurationInSeconds:RESERVATION_DURATION_SECONDS,...(inventoryDimension?{InventoryDimension:inventoryDimension}:{})},schemas.WebStoreInventorySource);
        if('failure' in source)return source.failure;
        attemptedSource=true;
        const createdSource=await request(root+'/sobjects/WebStoreInventorySource','POST',source.values);
        if(!createdSource.ok||!id(createdSource.body?.id))return createdSource;
        inventorySourceId=createdSource.body.id;capture('WebStoreInventorySource',inventorySourceId!);
        const sourceRead=await request(root+'/sobjects/WebStoreInventorySource/'+inventorySourceId);
        if(!sourceRead.ok||sourceRead.body?.WebStoreId!==storeId)return fail('INVENTORY_SOURCE_UNVERIFIED','Actual owned inventory source readback failed.');
        const createArgs={webStoreId:storeId,activeCartOrId:cartId,effectiveAccountId:accountId,cartInventoryReservationInputRepresentation:{}};
        // deleteInvRsvForCart probes still create their reservation through the live create route first.
        const reserved=await request(action==='createInvRsvForCart'?input.route:root+'/actions/standard/createInvRsvForCart','POST',
          {inputs:[Object.fromEntries(Object.entries(createArgs).filter(([name])=>createNames.has(name)))]});
        if(reserved.ok&&(reserved.body===null||Array.isArray(reserved.body)&&reserved.body.length===0))return fail('INVENTORY_ACTION_OUTCOME_MISSING','Salesforce returned no native reservation outcome for the owned cart; no mutation is counted as successful.');
        if(!successful(reserved))return reserved;
        const output=reserved.body[0].outputValues?.cartInventoryReservationOutputRepresentation;
        const providerRejection=inventoryProviderRejectionOf(output);
        const setupRows=await findItemReservations();
        nativeReservationEvidence={status:reserved.status,providerSuccess:output?.success??null,
          providerErrorCode:providerRejection?.errorCode??null,providerMessage:providerRejection?.message??null,
          reservationIdentifier:typeof output?.reservationIdentifier==='string'?output.reservationIdentifier:null,
          actualItemReservationCount:setupRows.length,
          outputKeys:output&&typeof output==='object'?Object.keys(output).filter(k=>/^[A-Za-z][A-Za-z0-9_]*$/.test(k)):[]};
        if(action==='createInvRsvForCart'){
          const rowsMatch=setupRows.length>=1&&setupRows.every(row=>row.Product2Id===productId&&Number(row.Quantity)===Number(RESERVATION_QUANTITY));
          verified=output?.success===true&&rowsMatch;
          if(verified){
            if(input.verificationWindowMs)await new Promise(resolve=>setTimeout(resolve,input.verificationWindowMs));
            return reserved;
          }
          if(providerRejection)return fail('INVENTORY_PROVIDER_UNAVAILABLE',
            `The native inventory provider rejected the owned reservation (${providerRejection.errorCode??'provider failure'}${providerRejection.message?': '+providerRejection.message:''}); no local reservation was recorded.`.slice(0,280));
          return fail('INVENTORY_RESERVATION_UNVERIFIED','The native reservation outcome did not yield actual item reservations for the owned cart item.');
        }
        const deleteNames=new Set(descriptors.deleteInvRsvForCart.inputs.map((f: Value)=>f.name));
        const deleteArgs={webStoreId:storeId,activeCartOrId:cartId,effectiveAccountId:accountId};
        const released=await request(input.route,'POST',{inputs:[Object.fromEntries(Object.entries(deleteArgs).filter(([name])=>deleteNames.has(name)))]});
        const remaining=await findItemReservations();
        nativeDeleteEvidence={status:released.status,successFlags:Array.isArray(released.body)?released.body.map((v: Value)=>v?.isSuccess===true):[],
          remainingItemReservationCount:remaining.length};
        if(released.ok&&(released.body===null||Array.isArray(released.body)&&released.body.length===0))return fail('INVENTORY_ACTION_OUTCOME_MISSING','Salesforce returned no native reservation release outcome; no mutation is counted as successful.');
        if(!successful(released))return released;
        verified=remaining.length===0;
        if(verified&&input.verificationWindowMs)await new Promise(resolve=>setTimeout(resolve,input.verificationWindowMs));
        return verified?released:fail('INVENTORY_RELEASE_UNVERIFIED','Native release did not remove the actual item reservations for the owned cart item.');
      })();
    } catch {outcome=fail('INVENTORY_LIFECYCLE_UNVERIFIED','The owned native inventory reservation lifecycle could not be verified.');}
    finally {
      // Try-phase captures every created fixture id (each creation is read
      // back inline), so full recovery discovery runs only when an attempted
      // write has no captured identity; otherwise one reservation re-check
      // covers the lost-response case. Eleven unconditional queries exhaust
      // the worker subrequest budget and starve cleanup (fixtures leak).
      const capturedId=(objectName:string,value:string|undefined)=>value===undefined||owned.some(v=>v.objectName===objectName&&v.id===value);
      const missingRecovery=(attemptedStore&&!capturedId('WebStore',storeId))||(attemptedBuyer&&!capturedId('Account',accountId))||
        (attemptedProduct&&!capturedId('Product2',productId))||(attemptedLocation&&!capturedId('Location',locationId))||
        (attemptedGroup&&!capturedId('LocationGroup',locationGroupId))||(attemptedAssignment&&!capturedId('LocationGroupAssignment',assignmentId))||
        (attemptedSource&&!capturedId('WebStoreInventorySource',inventorySourceId))||(attemptedCart&&!capturedId('WebCart',cartId))||
        (attemptedItem&&!capturedId('CartItem',itemId))||(cartId!==undefined&&!capturedId('CartDeliveryGroup',deliveryGroupId));
      try {
        if(missingRecovery){
          if(attemptedStore)await findMarked('WebStore');
          if(attemptedBuyer)await findMarked('Account');
          if(attemptedProduct)await findMarked('Product2');
          if(attemptedLocation)await findMarked('Location');
          if(attemptedGroup)await findMarked('LocationGroup','LocationGroupName');
          if(attemptedCart&&storeId)await findMarked('WebCart','Name',',WebStoreId,AccountId,OwnerId,Status,Type');
          // Marker-less children are discovered through their owned parents, even
          // when the action response was lost or reported another identity.
          if(storeId) {
            const sources=await find('WebStoreInventorySource',`WebStoreId='${storeId}'`,'Id,WebStoreId,LocationSourceId');
            for (const row of sources) if(id(row.Id)&&row.WebStoreId===storeId)capture('WebStoreInventorySource',row.Id);
          }
          if(locationGroupId) {
            const assignments=await find('LocationGroupAssignment',`LocationGroupId='${locationGroupId}'`,'Id,LocationGroupId,LocationId');
            for (const row of assignments) if(id(row.Id)&&row.LocationGroupId===locationGroupId)capture('LocationGroupAssignment',row.Id);
          }
          if(cartId) {
            const items=await find('CartItem',`CartId='${cartId}'`,'Id,CartId,CartDeliveryGroupId,Product2Id,Quantity');
            for (const row of items) if(id(row.Id)&&row.CartId===cartId)capture('CartItem',row.Id);
            const groups=await find('CartDeliveryGroup',`CartId='${cartId}'`,'Id,CartId');
            for (const row of groups) if(id(row.Id)&&row.CartId===cartId)capture('CartDeliveryGroup',row.Id);
          }
        }
        if(itemId) await findItemReservations();
      }catch(err){cleanupError=`Owned inventory cleanup could not be independently read back: ${(err instanceof Error?err.message:String(err)).slice(0,200)}`;}
      if(owned.length){
      const reservationParents=[...new Set(owned.filter(v=>v.objectName==='InventoryReservation').map(v=>v.id))];
      const scopes: OwnershipScope[]=[
        {objectName:'WebStore',equals:{Name:marker}}, {objectName:'Account',equals:{Name:marker}},
        {objectName:'Product2',equals:{Name:marker}}, {objectName:'Location',equals:{Name:marker}},
        {objectName:'LocationGroup',equals:{LocationGroupName:marker}},
        {objectName:'WebCart',equals:{Name:marker},ownedParents:[{field:'WebStoreId',objectName:'WebStore'}]},
        ...(cartId?[
          {objectName:'CartItem',equals:{CartId:cartId},ownedParents:[{field:'CartId',objectName:'WebCart'}]},
          {objectName:'CartDeliveryGroup',equals:{CartId:cartId},ownedParents:[{field:'CartId',objectName:'WebCart'}]},
        ]:[]),
        ...(storeId?[{objectName:'WebStoreInventorySource',equals:{WebStoreId:storeId},ownedParents:[{field:'WebStoreId',objectName:'WebStore'}]}]:[]),
        ...(locationGroupId?[{objectName:'LocationGroupAssignment',equals:{LocationGroupId:locationGroupId},ownedParents:[{field:'LocationGroupId',objectName:'LocationGroup'}]}]:[]),
        ...(itemId?[{objectName:'InventoryItemReservation',equals:{ItemReservationSourceId:itemId},ownedParents:[{field:'ItemReservationSourceId',objectName:'CartItem'}]}]:[]),
        ...reservationParents.map(parentId=>({objectName:'InventoryReservation',equals:{Id:parentId}})),
      ];
      const cleaned=await cleanupOwnedContext({root,request,records:owned,order:['InventoryItemReservation','InventoryReservation','CartItem','CartDeliveryGroup','WebCart','WebStoreInventorySource','LocationGroupAssignment','WebStore','Account','LocationGroup','Location','Product2'],scopes});
      cleanupError=[cleanupError,cleaned.cleanupError].filter(Boolean).join(' ').slice(0,600)||undefined;
      owned.splice(0,owned.length,...cleaned.ownedRecords);
      }
    }
    const result={status:outcome.status,body:outcome.body,cleanupError,contextSchema:{source:'salesforce_live_native_inventory_reservation_action',objects:Object.values(schemas),descriptors,marker,storeType:type,storeId,accountId,productId,cartId,itemId,deliveryGroupId,locationId,locationGroupId,assignmentId,inventorySourceId,locationTypeUsed,ownedRecords:owned,verified,nativeCreateEvidence,nativeItemEvidence,nativeReservationEvidence,nativeDeleteEvidence,
      verificationRecordIds:action==='createInvRsvForCart'
        ?(verified?owned.filter(v=>v.objectName==='InventoryItemReservation').map(v=>v.id):[])
        :(verified&&itemId?[itemId]:[]),
      automaticSteps:['Read live native descriptors and owned record schemas','Select only published store types','Create and read back an owned store, buyer, SKU product and cart','Place and read back one owned cart item directly','Create and read back an owned fulfillment location, location group and inventory source','Invoke the native reservation route and verify actual item reservations',...(action==='deleteInvRsvForCart'?['Invoke native deleteInvRsvForCart and read back the release']:[]),'Delete owned context and independently CLI verify absence']}};
    if(verified||cleanupError)return result;
    last=outcome;
    // CARTREGRESS: fall through store types on client validation refusals
    // (HTTP 400 from the store mint OR the native call — e.g. B2C refuses
    // plain buyers while B2CE converts). Per-attempt cleanup already ran
    // in `finally`. Return immediately only on verified/cleanupError/non-400.
    if(outcome.status!==400)return result;
  }
  return {status:last.status,body:last.body};
}
