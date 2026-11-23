import { cleanupOwnedContext, type OwnershipScope } from './owned-context-cleanup';
import {
  batchDescribe, batchGet, discoverProvisionedSubstrate, provisionBuyerChain, type ProvisionedSubstrate,
} from './commerce-provisioned-context';
import { clampVerificationWindowMs } from './verification-window';
type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const id = (v: any): v is string => typeof v === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
const successful = (r: Result) => r.ok && Array.isArray(r.body) && r.body.length === 1 && r.body[0]?.isSuccess === true && !r.body[0].errors?.length;
export const CART_ITEM_MUTATION_ACTIONS = ['addCartItem', 'updateCartItem'];
export const CART_INVENTORY_RESERVATION_ACTIONS = ['createInvRsvForCart', 'deleteInvRsvForCart'];
export const CART_ITEM_MUTATION_OBJECTS = ['WebStore', 'WebStoreNetwork', 'Account', 'WebCart', 'CartItem', 'Product2', 'PricebookEntry'];
/** Native cart item actions resolve the store hostname from a live storefront community link. Only the
 * mapping is owned and cleaned; live communities are pre-existing org data discovered via SOQL. */
export const CART_STORE_HOSTNAME_OBJECTS = ['WebStoreNetwork', 'Network'];
const ADD_QUANTITY = '1', UPDATE_QUANTITY = '2';
const STORE_HOSTNAME_MESSAGE = /couldn[''’]?t get the store hostname/i;

/** Generic rejection extraction: first error code/message from any Salesforce failure body shape. */
export function salesforceRejectionOf(result: Result): {status:number; errorCode?:string; message?:string} {
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

/** True only when the native outcome carries the exact store-hostname lookup failure. */
export function isStoreHostnameUnavailable(body: unknown): boolean {
  const visit = (value: unknown, depth: number): boolean => {
    if (typeof value === 'string') return STORE_HOSTNAME_MESSAGE.test(value);
    if (depth > 6 || !value || typeof value !== 'object') return false;
    return Object.values(value).some(entry => visit(entry, depth + 1));
  };
  return visit(body, 0);
}

/** Inventory reservation needs fulfillment locations and stock, which the
 * owned store/cart/product fixture does not provision. Never mock it. */
export function cartInventoryReservationUnsupported(): Result {
  return {status:422,ok:false,body:{errorCode:'CART_INVENTORY_RESERVATION_UNSUPPORTED',
    message:'Native inventory reservation requires a fulfillment location and stock fixture beyond the owned store, buyer, product and cart context; no mutation was attempted.'}};
}

/** Native Commerce item actions operate only on an owned store, buyer, product, price entry and cart. */
export async function invokeCartItemMutation(input: {
  root: string; route: string; verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
}): Promise<{status: number; body: any; cleanupError?: string; contextSchema?: Value}> {
  const {root,request} = input, action = input.route.split('/').at(-1)!;
  const fail = (errorCode: string, message: string, extra?: Value): Result =>
    ({status:422,ok:false,body:{errorCode,message,...(extra??{})}});
  if (!CART_ITEM_MUTATION_ACTIONS.includes(action)) return fail('CART_ACTION_INVALID','A supported discovered native cart item route is required.');
  const described = await batchDescribe(request, root, [...CART_ITEM_MUTATION_OBJECTS], [...new Set(['createCart', 'addCartItem', action])]);
  if (!described) return fail('CART_DESCRIBE_UNAVAILABLE','Live object and action describes could not be read.');
  const schemas: Value = described.schemas, descriptors: Value = described.descriptors;
  for (const name of CART_ITEM_MUTATION_OBJECTS) {
    if (!schemas[name]?.queryable || !schemas[name]?.deletable || !Array.isArray(schemas[name]?.fields)) return fail('CART_CONTEXT_PERMISSIONS_REQUIRED','Live owned Commerce records require query and cleanup access.');
  }
  for (const name of Object.keys(descriptors)) {
    if (!Array.isArray(descriptors[name]?.inputs)) return fail('CART_ACTION_SCHEMA_UNAVAILABLE','The native cart descriptor has no input schema.');
  }
  if (!['webStoreId','cartInput'].every(name => descriptors.createCart.inputs.some((f: Value)=>f.name===name))) return fail('CART_ACTION_SCHEMA_UNAVAILABLE','The live creation action does not publish store and cart inputs.');
  const addNames = new Set(descriptors.addCartItem.inputs.map((f: Value)=>f.name));
  if (!['webStoreId','cartStateOrId','cartItemInput'].every(name=>addNames.has(name)))
    return fail('CART_ITEM_SCHEMA_UNAVAILABLE','The native add item descriptor lacks store, cart or payload inputs.');
  const itemNames = new Set(descriptors[action].inputs.map((f: Value)=>f.name));
  if (!['webStoreId','cartStateOrId','cartItemInput'].every(name=>itemNames.has(name)) || action==='updateCartItem' && !itemNames.has('cartItemId'))
    return fail('CART_ITEM_SCHEMA_UNAVAILABLE','The native cart item descriptor lacks store, cart, item or payload inputs.');
  const types = schemas.WebStore.fields.find((f: Value)=>f.name==='Type'&&f.createable)?.picklistValues?.filter((p: Value)=>p.active&&typeof p.value==='string').map((p: Value)=>p.value) ?? [];
  const cartType = schemas.WebCart.fields.find((f: Value)=>f.name==='Type')?.picklistValues?.find((p: Value)=>p.active&&p.value==='Cart')?.value;
  if (!types.length || !cartType) return fail('CART_TYPE_UNAVAILABLE','Live store types and the standard Cart type are required.');
  for (const name of ['WebStore','Account','Product2'])
    if (!schemas[name].createable || !schemas[name].fields.some((f: Value)=>f.name==='Name'&&f.createable&&f.filterable&&f.length>=48))
      return fail('CART_MARKER_UNAVAILABLE','Owned store, buyer and product records require writable, queryable Name markers.');
  if (!schemas.PricebookEntry.createable) return fail('CART_PRICEBOOK_UNAVAILABLE','Owned price entries require writable PricebookEntry access.');
  if (!schemas.WebCart.fields.some((f: Value)=>f.name==='Name'&&f.filterable)) return fail('CART_MARKER_UNAVAILABLE','Owned cart discovery requires a queryable Name marker.');
  if (!schemas.WebStoreNetwork.createable) return fail('CART_STORE_HOSTNAME_UNAVAILABLE','No store-capable community found for the owned store (mapping access unavailable); native cart item actions require a storefront hostname and no mutation was attempted.');
  // Provisioned substrate first: a live store<->site pair (one store per
  // site) reuses its store, mapping, group, pricebook, catalog and policy
  // while buyer, product and cart fixtures stay owned; the mint ladder
  // stays the fallback when no pair exists.
  let provisioned: ProvisionedSubstrate|null = null;
  const found = await discoverProvisionedSubstrate(request, root);
  if (found) { provisioned = found; Object.assign(schemas, found.schemas); }
  let last = fail('CART_CONTEXT_UNAVAILABLE','No live store type supported the native cart item lifecycle.');
  const memberAttempts: Array<{groupId:string;status:number;errorCode?:string}> = [];
  const attempts: Array<{kind:'reuse';substrate:ProvisionedSubstrate}|{kind:'mint';type:string}> = [
    ...(provisioned ? [{kind:'reuse' as const,substrate:provisioned}] : []),
    ...types.map((type: string) => ({kind:'mint' as const,type})),
  ];
  for (const attempt of attempts) {
    const marker = 'AS cart '+crypto.randomUUID(), owned: Array<{objectName:string;id:string}> = [];
    let storeId: string|undefined, accountId: string|undefined, productId: string|undefined, pricebookEntryId: string|undefined,
      cartId: string|undefined, ownerId: string|undefined, itemId: string|undefined, deliveryGroupId: string|undefined,
      networkId: string|undefined, webStoreNetworkId: string|undefined, catalogId: string|undefined,
      verified=false, cleanupError: string|undefined, hostnameEvidence: Value|undefined, provisionedType: string|undefined;
    let attemptedStore=false,attemptedBuyer=false,attemptedProduct=false,attemptedEntry=false,attemptedCart=false,attemptedItem=false;
    let beforeQuantity: unknown, afterQuantity: unknown, nativeCreateEvidence: Value|undefined, nativeAddEvidence: Value|undefined, nativeUpdateEvidence: Value|undefined;
    const capture = (objectName: string, value: string) => {if(!owned.some(v=>v.id===value))owned.push({objectName,id:value});};
    const find = async (name: string, predicate: string, columns='Id,Name') => {
      const result = await request(root+'/query?q='+encodeURIComponent(`SELECT ${columns} FROM ${name} WHERE ${predicate} LIMIT 3`));
      if (!result.ok || !Array.isArray(result.body?.records) || result.body.records.length>=3) throw Error('Owned Commerce discovery could not be verified.');
      return result.body.records as Value[];
    };
    const findMarked = async (name: string) => {
      const records = await find(name, `Name='${marker}'`, `Id,Name${name==='WebCart'?',WebStoreId,AccountId,OwnerId,Status,Type':''}`);
      for (const row of records) {
        if (!id(row.Id)||row.Name!==marker||name==='WebCart'&&row.WebStoreId!==storeId) throw Error('Owned Commerce marker or relationship mismatch.');
        capture(name,row.Id);
      }
      return records;
    };
    let outcome: Result = last;
    try {
      outcome = await (async()=>{
        if (attempt.kind === 'reuse') {
          storeId = attempt.substrate.storeId; networkId = attempt.substrate.networkId;
          const storeRead=await request(root+'/sobjects/WebStore/'+storeId);
          if(!storeRead.ok||!id(storeRead.body?.Id)||typeof storeRead.body?.Type!=='string')return fail('CART_STORE_UNVERIFIED','Actual provisioned store readback failed.');
          provisionedType=storeRead.body.Type;
          hostnameEvidence={reused:true,linked:true,liveNetworkCount:1,provenStoreLinkCount:1,mappingAttempts:[]};
        } else {
          const store = await input.build('WebStore',marker,{Name:marker,Type:attempt.type});
          if ('failure' in store) return store.failure;
          attemptedStore=true;
          const createdStore=await request(root+'/sobjects/WebStore','POST',store.values);
          if (!createdStore.ok||!id(createdStore.body?.id)) return createdStore;
          storeId=createdStore.body.id;capture('WebStore',storeId!);
          const storeRead=await request(root+'/sobjects/WebStore/'+storeId);
          if(!storeRead.ok||storeRead.body?.Name!==marker||storeRead.body?.Type!==attempt.type)return fail('CART_STORE_UNVERIFIED','Actual owned store readback failed.');
        }
        // Native item actions resolve the store hostname from a storefront community link.
        // Discover live sites dynamically and attach the owned store to the first one that
        // accepts it; template or entitlement rejections fall through to the next candidate.
        // Networks already hosting a store (live WebStoreNetwork rows) are proven
        // store-template candidates, so they are tried first; the mapping outcome itself
        // stays the ground truth for every candidate. Reuse skips mapping: the
        // provisioned pair already owns the only link its site accepts.
        if (attempt.kind === 'mint') {
        const discovered=await request(root+'/query?q='+encodeURIComponent(`SELECT Id,Name,UrlPathPrefix FROM Network WHERE Status='Live' LIMIT 10`));
        const liveNetworks=discovered.ok&&Array.isArray(discovered.body?.records)?discovered.body.records.filter((row: Value)=>id(row.Id)):[];
        const provenLinks=await request(root+'/query?q='+encodeURIComponent('SELECT NetworkId FROM WebStoreNetwork LIMIT 200'));
        const provenStoreNetworks=new Set(provenLinks.ok&&Array.isArray(provenLinks.body?.records)?provenLinks.body.records.filter((row: Value)=>id(row.NetworkId)).map((row: Value)=>row.NetworkId):[]);
        const candidates=[...liveNetworks].sort((a: Value,b: Value)=>Number(provenStoreNetworks.has(b.Id))-Number(provenStoreNetworks.has(a.Id)));
        const mappingAttempts: Value[]=[];
        for (const network of candidates) {
          const candidate={networkId:network.Id,...(typeof network.Name==='string'?{name:network.Name.slice(0,120)}:{}),provenStoreLink:provenStoreNetworks.has(network.Id)};
          const link=await input.build('WebStoreNetwork',marker,{WebStoreId:storeId,NetworkId:network.Id});
          if('failure' in link)return link.failure;
          const created=await request(root+'/sobjects/WebStoreNetwork','POST',link.values);
          if(!created.ok||!id(created.body?.id)){
            if(created.status>=500&&created.status<=599)return created;
            mappingAttempts.push({...candidate,...salesforceRejectionOf(created),rejected:true});
            continue;
          }
          const mappingRead=await request(root+'/sobjects/WebStoreNetwork/'+created.body.id);
          if(!mappingRead.ok||mappingRead.body?.WebStoreId!==storeId){
            capture('WebStoreNetwork',created.body.id);
            const readback=salesforceRejectionOf(mappingRead);
            mappingAttempts.push({...candidate,...readback,...(!readback.errorCode&&!readback.message?{message:'Hostname mapping readback did not return the owned store link.'}:{}),rejected:true});
            continue;
          }
          mappingAttempts.push({...candidate,status:created.status,rejected:false});
          networkId=network.Id;webStoreNetworkId=created.body.id;capture('WebStoreNetwork',webStoreNetworkId!);
          break;
        }
        hostnameEvidence={liveNetworkCount:liveNetworks.length,provenStoreLinkCount:provenStoreNetworks.size,mappingAttempts,linked:webStoreNetworkId!==undefined,
          ...(!discovered.ok?{discoveryStatus:discovered.status}:{}),...(!provenLinks.ok?{provenLinkDiscoveryStatus:provenLinks.status}:{})};
        // Community-less native attempts are gated on the storefront link: live orgs
        // reject them at the native hostname lookup, so without a mapping the honest
        // verdict is setup_blocked with per-candidate reasons — no item mutation runs.
        if(!webStoreNetworkId){
          const rejected=mappingAttempts.filter(attempt=>attempt.rejected);
          const reasons=rejected.map(attempt=>`${attempt.errorCode??'HTTP '+attempt.status}${attempt.message?': '+attempt.message:''}`.slice(0,140)).join('; ');
          const discovery=!discovered.ok?`live site discovery failed (HTTP ${discovered.status})`
            :`${liveNetworks.length} live site(s) discovered, ${rejected.length} mapping(s) rejected${reasons?' ('+reasons.slice(0,280)+')':''}`;
          hostnameEvidence={...hostnameEvidence,discovery};
          return fail('CART_STORE_HOSTNAME_UNAVAILABLE',`No store-capable community found for the owned store (${discovery}); native cart item actions require a storefront hostname and no item mutation was attempted.`);
        }
        }
        // A linked store can still fail hostname resolution (wrong community template):
        // map the exact native lookup failure to the honest setup code, never invalid_input.
        const mapHostname=(native: Result): Result=>isStoreHostnameUnavailable(native.body)
          ?fail('CART_STORE_HOSTNAME_UNAVAILABLE','Salesforce could not resolve the store hostname for the owned store despite the linked storefront community; native cart item actions require a store-template community link and the attempted mutation was rejected.')
          :native;
        if (attempt.kind === 'reuse') {
          attemptedBuyer=true;
          const chain=await provisionBuyerChain({root,marker,groupIds:attempt.substrate.groupIds,request,build:input.build,capture});
          memberAttempts.push(...chain.memberAttempts);
          if('failure' in chain)return chain.failure;
          accountId=chain.ids.accountId;
        } else {
          const buyer=await input.build('Account',marker,{Name:marker});
          if('failure' in buyer)return buyer.failure;
          attemptedBuyer=true;
          const createdBuyer=await request(root+'/sobjects/Account','POST',buyer.values);
          if(!createdBuyer.ok||!id(createdBuyer.body?.id))return createdBuyer;
          accountId=createdBuyer.body.id;capture('Account',accountId!);
          const buyerRead=await request(root+'/sobjects/Account/'+accountId);
          if(!buyerRead.ok||buyerRead.body?.Name!==marker)return fail('CART_BUYER_UNVERIFIED','Actual owned buyer readback failed.');
        }
        const product=await input.build('Product2',marker,{Name:marker,IsActive:true});
        if('failure' in product)return product.failure;
        attemptedProduct=true;
        const createdProduct=await request(root+'/sobjects/Product2','POST',product.values);
        if(!createdProduct.ok||!id(createdProduct.body?.id))return createdProduct;
        productId=createdProduct.body.id;capture('Product2',productId!);
        const productRead=await request(root+'/sobjects/Product2/'+productId);
        if(!productRead.ok||productRead.body?.Name!==marker)return fail('CART_PRODUCT_UNVERIFIED','Actual owned product readback failed.');
        const pricebook=await request(root+'/query?q='+encodeURIComponent('SELECT Id FROM Pricebook2 WHERE IsStandard=true LIMIT 1'));
        const standardPricebookId=Array.isArray(pricebook.body?.records)&&pricebook.body.records.length===1&&id(pricebook.body.records[0]?.Id)?pricebook.body.records[0].Id:undefined;
        if(!pricebook.ok||!standardPricebookId)return fail('CART_PRICEBOOK_UNAVAILABLE','The live standard pricebook required for the owned price entry is unavailable.');
        if (attempt.kind === 'reuse') {
          // Product visibility on a provisioned store: standard + store
          // pricebook entries, catalog link (reuse-or-mint), category
          // assignment and entitlement product. Every id is captured owned.
          const provision=async(name: string, values: Value): Promise<string|Result>=>{
            const built=await input.build(name,marker,values);
            if('failure' in built)return built.failure;
            const created=await request(root+'/sobjects/'+name,'POST',built.values);
            if(!created.ok||!id(created.body?.id))return created;
            capture(name,created.body.id);
            return created.body.id;
          };
          attemptedEntry=true;
          // Standard entry first (custom prices require it) but captured
          // LAST: same-object cleanup follows capture order and the standard
          // price cannot be deleted while a custom price references it.
          const stdBuilt=await input.build('PricebookEntry',marker,{Pricebook2Id:standardPricebookId,Product2Id:productId,UnitPrice:1,IsActive:true});
          if('failure' in stdBuilt)return stdBuilt.failure;
          const stdCreated=await request(root+'/sobjects/PricebookEntry','POST',stdBuilt.values);
          if(!stdCreated.ok||!id(stdCreated.body?.id))return stdCreated;
          const storeEntry=await provision('PricebookEntry',{Pricebook2Id:attempt.substrate.pricebookId,Product2Id:productId,UnitPrice:1,IsActive:true,UseStandardPrice:false});
          if(typeof storeEntry!=='string')return storeEntry;
          capture('PricebookEntry',stdCreated.body.id);
          pricebookEntryId=storeEntry;
          const entryRead=await request(root+'/sobjects/PricebookEntry/'+pricebookEntryId);
          if(!entryRead.ok||entryRead.body?.Product2Id!==productId)return fail('CART_PRICE_ENTRY_UNVERIFIED','Actual owned price entry readback failed.');
          catalogId=attempt.substrate.catalogId;
          if(!attempt.substrate.catalogLinkId){
            const link=await provision('WebStoreCatalog',{SalesStoreId:storeId,ProductCatalogId:catalogId});
            if(typeof link!=='string')return link;
          }
          if(attempt.substrate.categoryId){
            const assigned=await provision('ProductCategoryProduct',{ProductCategoryId:attempt.substrate.categoryId,ProductId:productId});
            if(typeof assigned!=='string')return assigned;
          }
          if(attempt.substrate.policyId){
            const entitled=await provision('CommerceEntitlementProduct',{PolicyId:attempt.substrate.policyId,ProductId:productId});
            if(typeof entitled!=='string')return entitled;
          }
        } else {
          const entry=await input.build('PricebookEntry',marker,{Pricebook2Id:standardPricebookId,Product2Id:productId,UnitPrice:1,IsActive:true,UseStandardPrice:false});
          if('failure' in entry)return entry.failure;
          attemptedEntry=true;
          const createdEntry=await request(root+'/sobjects/PricebookEntry','POST',entry.values);
          if(!createdEntry.ok||!id(createdEntry.body?.id))return createdEntry;
          pricebookEntryId=createdEntry.body.id;capture('PricebookEntry',pricebookEntryId!);
          const entryRead=await request(root+'/sobjects/PricebookEntry/'+pricebookEntryId);
          if(!entryRead.ok||entryRead.body?.Product2Id!==productId)return fail('CART_PRICE_ENTRY_UNVERIFIED','Actual owned price entry readback failed.');
        }
        attemptedCart=true;
        const created=await request(root+'/actions/standard/createCart','POST',{inputs:[{webStoreId:storeId,cartInput:{name:marker,type:cartType,effectiveAccountId:accountId}}]});
        nativeCreateEvidence={status:created.status,bodyKind:created.body===null?'null':Array.isArray(created.body)?'array':typeof created.body,
          outcomeCount:Array.isArray(created.body)?created.body.length:null,successFlags:Array.isArray(created.body)?created.body.map((v: Value)=>v?.isSuccess===true):[]};
        const carts=await findMarked('WebCart');
        if(created.ok&&(created.body===null||Array.isArray(created.body)&&created.body.length===0))return fail('CART_ACTION_OUTCOME_MISSING','Salesforce returned no native cart creation outcome for the owned buyer and store; no mutation is counted as successful.');
        if(!successful(created))return mapHostname(created);
        const returned=created.body[0].outputValues?.cartSummary;
        if(carts.length!==1||!id(carts[0]?.Id)||returned?.cartId!==carts[0].Id)return fail('CART_CREATION_UNVERIFIED','Native creation did not return one actual cart with the owned buyer and store.');
        cartId=carts[0].Id;ownerId=id(carts[0].OwnerId)?carts[0].OwnerId:undefined;
        const groups=await find('CartDeliveryGroup',`CartId='${cartId}'`,'Id,CartId');
        if(groups.length===1&&id(groups[0]?.Id)){deliveryGroupId=groups[0].Id;capture('CartDeliveryGroup',deliveryGroupId!);}
        attemptedItem=true;
        const itemArgs={webStoreId:storeId,cartStateOrId:cartId,effectiveAccountId:accountId,userId:ownerId,cartItemInput:{productId,quantity:ADD_QUANTITY}};
        const addInputs={inputs:[Object.fromEntries(Object.entries(itemArgs).filter(([name])=>addNames.has(name)))]};
        // updateCartItem probes still add their item through the live add route first.
        const added=await request(action==='addCartItem'?input.route:root+'/actions/standard/addCartItem','POST',addInputs);
        let items=await find('CartItem',`CartId='${cartId}'`,'Id,CartId,CartDeliveryGroupId,Product2Id,Quantity');
        // Lifecycle mismatch: the native write can settle after the outcome
        // returns; one bounded re-read before declaring unverified.
        if(items.length!==1){await new Promise(resolve=>setTimeout(resolve,clampVerificationWindowMs(input.verificationWindowMs??1500)));
          items=await find('CartItem',`CartId='${cartId}'`,'Id,CartId,CartDeliveryGroupId,Product2Id,Quantity');}
        nativeAddEvidence={status:added.status,bodyKind:added.body===null?'null':Array.isArray(added.body)?'array':typeof added.body,
          outcomeCount:Array.isArray(added.body)?added.body.length:null,successFlags:Array.isArray(added.body)?added.body.map((v: Value)=>v?.isSuccess===true):[],
          outputKeys:Array.isArray(added.body)?added.body.flatMap((v: Value)=>Object.keys(v?.outputValues??{}).filter(k=>/^[A-Za-z][A-Za-z0-9_]*$/.test(k))):[],
          actualItemCount:items.length};
        if(added.ok&&(added.body===null||Array.isArray(added.body)&&added.body.length===0))return fail('CART_ACTION_OUTCOME_MISSING','Salesforce returned no native cart item outcome for the owned cart and product; no mutation is counted as successful.');
        if(!successful(added))return mapHostname(added);
        if(items.length!==1||!id(items[0]?.Id)||items[0]?.CartId!==cartId||items[0]?.Product2Id!==productId||Number(items[0]?.Quantity)!==Number(ADD_QUANTITY))
          return fail('CART_ITEM_UNVERIFIED','Native item creation did not return one actual cart item with the owned cart and product.',
            {actualItemCount:items.length,actual:items.map(item=>({Id:item?.Id,CartId:item?.CartId,Product2Id:item?.Product2Id,Quantity:item?.Quantity})),
              expected:{CartId:cartId,Product2Id:productId,Quantity:ADD_QUANTITY}});
        const outputItem=added.body[0].outputValues?.cartItem;
        const outputIds=outputItem&&typeof outputItem==='object'?Object.entries(outputItem).filter(([k,v])=>/id$/i.test(k)&&id(v)).map(([,v])=>v):[];
        if(outputIds.length&&!outputIds.includes(items[0].Id))return fail('CART_ITEM_UNVERIFIED','The native item outcome identity does not match the actual cart item.');
        itemId=items[0].Id;beforeQuantity=items[0].Quantity;capture('CartItem',itemId!);
        if(id(items[0]?.CartDeliveryGroupId)){deliveryGroupId=items[0].CartDeliveryGroupId;capture('CartDeliveryGroup',deliveryGroupId!);}
        if(action==='addCartItem'){
          verified=true;afterQuantity=beforeQuantity;
          if(input.verificationWindowMs)await new Promise(resolve=>setTimeout(resolve,clampVerificationWindowMs(input.verificationWindowMs)));
          return added;
        }
        const updateNames=new Set(descriptors.updateCartItem.inputs.map((f: Value)=>f.name));
        const updateArgs={webStoreId:storeId,cartStateOrId:cartId,cartItemId:itemId,effectiveAccountId:accountId,userId:ownerId,cartItemInput:{productId,quantity:UPDATE_QUANTITY}};
        const updated=await request(input.route,'POST',{inputs:[Object.fromEntries(Object.entries(updateArgs).filter(([name])=>updateNames.has(name)))]});
        nativeUpdateEvidence={status:updated.status,successFlags:Array.isArray(updated.body)?updated.body.map((v: Value)=>v?.isSuccess===true):[]};
        const reread=await find('CartItem',`CartId='${cartId}'`,'Id,CartId,CartDeliveryGroupId,Product2Id,Quantity');
        afterQuantity=reread[0]?.Quantity;
        if(updated.ok&&(updated.body===null||Array.isArray(updated.body)&&updated.body.length===0))return fail('CART_ACTION_OUTCOME_MISSING','Salesforce returned no native cart item update outcome; no mutation is counted as successful.');
        if(!successful(updated))return mapHostname(updated);
        verified=reread.length===1&&reread[0]?.Id===itemId&&reread[0]?.Product2Id===productId&&Number(reread[0]?.Quantity)===Number(UPDATE_QUANTITY);
        if(verified&&input.verificationWindowMs)await new Promise(resolve=>setTimeout(resolve,clampVerificationWindowMs(input.verificationWindowMs)));
        return verified?updated:fail('CART_ITEM_UPDATE_UNVERIFIED','Native item update did not change the actual cart item quantity.');
      })();
    } catch {outcome=fail('CART_LIFECYCLE_UNVERIFIED','The owned native Commerce lifecycle could not be verified.');}
    finally {
      try {
        if(attemptedStore)await findMarked('WebStore');
        if(attemptedBuyer)await findMarked('Account');
        if(attemptedProduct)await findMarked('Product2');
        if(attemptedCart&&storeId)await findMarked('WebCart');
        // The hostname mapping carries no marker; it is discovered through the owned store.
        // Reuse never owns the store or its mapping: skip, or the provisioned
        // link would be captured for deletion.
        if(storeId&&attempt.kind==='mint') {
          const links=await find('WebStoreNetwork',`WebStoreId='${storeId}'`,'Id,WebStoreId,NetworkId');
          for (const row of links) if(id(row.Id)&&row.WebStoreId===storeId)capture('WebStoreNetwork',row.Id);
        }
        if(attempt.kind==='reuse') {
          // One composite call: five recovery reads, one subrequest.
          const recovery: Array<{name:string;field:string;value:string|undefined}> = [
            {name:'BuyerAccount',field:'BuyerId',value:accountId},
            {name:'BuyerGroupMember',field:'BuyerId',value:accountId},
            {name:'Contact',field:'AccountId',value:accountId},
            {name:'CommerceEntitlementProduct',field:'ProductId',value:productId},
            {name:'ProductCategoryProduct',field:'ProductId',value:productId},
          ].filter(entry => typeof entry.value === 'string');
          const recovered = await batchGet(request, root, recovery.map(entry =>
            '/query?q=' + encodeURIComponent(`SELECT Id FROM ${entry.name} WHERE ${entry.field}='${entry.value}' LIMIT 3`)));
          recovered.forEach((entry, index) => {
            if (entry.ok && Array.isArray(entry.body?.records)) for (const row of entry.body.records) if (id(row?.Id)) capture(recovery[index].name, row.Id);
          });
        }
        // Marker-less children are discovered through their owned parents, even
        // when the action response was lost or reported another identity.
        if(attemptedEntry&&productId) {
          const entries=await find('PricebookEntry',`Product2Id='${productId}'`,'Id,Product2Id,Pricebook2Id,UnitPrice');
          for (const row of entries) if(id(row.Id)&&row.Product2Id===productId)capture('PricebookEntry',row.Id);
        }
        if(attemptedItem&&cartId) {
          const items=await find('CartItem',`CartId='${cartId}'`,'Id,CartId,CartDeliveryGroupId,Product2Id,Quantity');
          for (const row of items) if(id(row.Id)&&row.CartId===cartId)capture('CartItem',row.Id);
        }
        if(cartId) {
          const groups=await find('CartDeliveryGroup',`CartId='${cartId}'`,'Id,CartId');
          for (const row of groups) if(id(row.Id)&&row.CartId===cartId)capture('CartDeliveryGroup',row.Id);
        }
      }catch{cleanupError='Owned Commerce cleanup could not be independently read back.';}
      const reuse = attempt.kind==='reuse';
      const scopes: OwnershipScope[]=[
        {objectName:'WebStore',equals:{Name:marker}}, {objectName:'Account',equals:{Name:marker}},
        {objectName:'Product2',equals:{Name:marker}},
        ...(reuse
          ? [{objectName:'WebCart',equals:{Name:marker},...(accountId?{ownedParents:[{field:'AccountId',objectName:'Account'}]}:{})}]
          : [{objectName:'WebCart',equals:{Name:marker},ownedParents:[{field:'WebStoreId',objectName:'WebStore'}]}]),
        ...(cartId?[
          {objectName:'CartItem',equals:{CartId:cartId},ownedParents:[{field:'CartId',objectName:'WebCart'}]},
          {objectName:'CartDeliveryGroup',equals:{CartId:cartId},ownedParents:[{field:'CartId',objectName:'WebCart'}]},
        ]:[]),
        ...(productId?[{objectName:'PricebookEntry',equals:{Product2Id:productId},ownedParents:[{field:'Product2Id',objectName:'Product2'}]}]:[]),
        ...(storeId&&!reuse?[{objectName:'WebStoreNetwork',equals:{WebStoreId:storeId},ownedParents:[{field:'WebStoreId',objectName:'WebStore'}]}]:[]),
        ...(reuse?[
          ...(accountId
            ? [{objectName:'BuyerAccount',equals:{BuyerId:accountId},ownedParents:[{field:'BuyerId',objectName:'Account'}]},
               {objectName:'BuyerGroupMember',equals:{BuyerId:accountId},ownedParents:[{field:'BuyerId',objectName:'Account'}]},
               {objectName:'Contact',equals:{AccountId:accountId},ownedParents:[{field:'AccountId',objectName:'Account'}]}]
            : [{objectName:'BuyerAccount',equals:{Name:marker}},{objectName:'Contact',equals:{LastName:marker}}]),
        ]:[]),
        ...(reuse&&productId?[
          {objectName:'CommerceEntitlementProduct',equals:{ProductId:productId},ownedParents:[{field:'ProductId',objectName:'Product2'}]},
          {objectName:'ProductCategoryProduct',equals:{ProductId:productId},ownedParents:[{field:'ProductId',objectName:'Product2'}]},
        ]:[]),
        ...(reuse&&storeId&&catalogId?[{objectName:'WebStoreCatalog',equals:{SalesStoreId:storeId,ProductCatalogId:catalogId}}]:[]),
      ];
      const cleaned=await cleanupOwnedContext({root,request,records:owned,order:['CartItem','CartDeliveryGroup','WebCart','WebStoreNetwork','WebStore','Account','PricebookEntry','Product2','BuyerAccount','BuyerGroupMember','Contact','WebStoreCatalog','ProductCategoryProduct','CommerceEntitlementProduct'],scopes});
      cleanupError ??= cleaned.cleanupError;
      owned.splice(0,owned.length,...cleaned.ownedRecords);
    }
    const result={status:outcome.status,body:outcome.body,cleanupError,contextSchema:{source:'salesforce_live_native_cart_item_action',objects:Object.values(schemas),descriptors,marker,storeType:attempt.kind==='reuse'?provisionedType:attempt.type,reusedStore:attempt.kind==='reuse',storeId,accountId,productId,pricebookEntryId,cartId,itemId,deliveryGroupId,networkId,webStoreNetworkId,hostnameEvidence,ownedRecords:owned,verified,memberAttempts,nativeCreateEvidence,nativeAddEvidence,nativeUpdateEvidence,beforeQuantity,afterQuantity,
      verificationRecordIds:itemId?[itemId]:[],automaticSteps:['Read live native descriptors and owned record schemas','Select only published store types','Create and read back an owned store, buyer, product and price entry','Link the owned store to a live storefront community and verify the hostname mapping','Invoke native createCart and verify the actual returned relationships','Invoke native addCartItem and verify the actual cart item',...(action==='updateCartItem'?['Invoke native updateCartItem and read back the changed quantity']:[]),'Delete owned context and independently CLI verify absence']}};
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
