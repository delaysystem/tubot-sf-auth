import { cleanupOwnedContext } from './owned-context-cleanup';
import { batchDescribe, discoverProvisionedStorefront, discoverStoreBuyerGroups, provisionBuyerChain } from './commerce-provisioned-context';
type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const id = (v: any): v is string => typeof v === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
const successful = (r: Result) => r.ok && Array.isArray(r.body) && r.body.length === 1 && r.body[0]?.isSuccess === true && !r.body[0].errors?.length;
export const CART_MUTATION_ACTIONS = ['createCart', 'deleteCart'];
export const CART_MUTATION_OBJECTS = ['WebStore', 'Account', 'WebCart'];

/** Native Commerce actions operate only on an owned store, buyer and cart. */
export async function invokeCartMutation(input: {
  root: string; route: string; verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
}): Promise<{status: number; body: any; cleanupError?: string; contextSchema?: Value}> {
  const {root,request} = input, action = input.route.split('/').at(-1)!;
  const fail = (errorCode: string, message: string): Result => ({status:422,ok:false,body:{errorCode,message}});
  if (!CART_MUTATION_ACTIONS.includes(action)) return fail('CART_ACTION_INVALID','A supported discovered native cart route is required.');
  const described = await batchDescribe(request, root, [...CART_MUTATION_OBJECTS], action === 'deleteCart' ? [...CART_MUTATION_ACTIONS] : ['createCart']);
  if (!described) return fail('CART_DESCRIBE_UNAVAILABLE','Live object and action describes could not be read.');
  const schemas: Value = described.schemas, descriptors: Value = described.descriptors;
  for (const name of CART_MUTATION_OBJECTS) {
    if (!schemas[name]?.queryable || !schemas[name]?.deletable || !Array.isArray(schemas[name]?.fields)) return fail('CART_CONTEXT_PERMISSIONS_REQUIRED','Live owned Commerce records require query and cleanup access.');
  }
  for (const name of Object.keys(descriptors)) {
    if (!Array.isArray(descriptors[name]?.inputs)) return fail('CART_ACTION_SCHEMA_UNAVAILABLE','The native cart descriptor has no input schema.');
  }
  if (!['webStoreId','cartInput'].every(name => descriptors.createCart.inputs.some((f: Value)=>f.name===name))) return fail('CART_ACTION_SCHEMA_UNAVAILABLE','The live creation action does not publish store and cart inputs.');
  const types = schemas.WebStore.fields.find((f: Value)=>f.name==='Type'&&f.createable)?.picklistValues?.filter((p: Value)=>p.active&&typeof p.value==='string').map((p: Value)=>p.value) ?? [];
  const cartType = schemas.WebCart.fields.find((f: Value)=>f.name==='Type')?.picklistValues?.find((p: Value)=>p.active&&p.value==='Cart')?.value;
  if (!types.length || !cartType) return fail('CART_TYPE_UNAVAILABLE','Live store types and the standard Cart type are required.');
  for (const name of ['WebStore','Account']) if (!schemas[name].createable || !schemas[name].fields.some((f: Value)=>f.name==='Name'&&f.createable&&f.filterable&&f.length>=48)) return fail('CART_MARKER_UNAVAILABLE','Owned store and buyer records require writable, queryable Name markers.');
  if (!schemas.WebCart.fields.some((f: Value)=>f.name==='Name'&&f.filterable)) return fail('CART_MARKER_UNAVAILABLE','Owned cart discovery requires a queryable Name marker.');
  // Provisioned substrate first: a live store<->site pair (one store per
  // site) reuses its store and mapping while the buyer stays owned; the
  // mint ladder below stays the fallback when no pair exists.
  let provisioned: {storeId:string;networkId:string;groupIds:string[]}|null = null;
  const found = await discoverProvisionedStorefront(request, root);
  if (found) {
    let reuseSchemas = true;
    for (const name of ['BuyerAccount','BuyerGroupMember','Contact']) {
      const live = await request(root+'/sobjects/'+name+'/describe');
      if (!live.ok || !live.body?.queryable || !live.body?.deletable || !live.body?.createable) { reuseSchemas = false; break; }
      schemas[name] = live.body;
    }
    if (reuseSchemas) {
      const groupIds = await discoverStoreBuyerGroups(request, root, found.storeId);
      if (groupIds.length) provisioned = {...found, groupIds};
    }
  }
  let last = fail('CART_CONTEXT_UNAVAILABLE','No live store type supported the native cart lifecycle.');
  const memberAttempts: Array<{groupId:string;status:number;errorCode?:string}> = [];
  const attempts: Array<{kind:'reuse';storeId:string;groupIds:string[]}|{kind:'mint';type:string}> = [
    ...(provisioned ? [{kind:'reuse' as const,storeId:provisioned.storeId,groupIds:provisioned.groupIds}] : []),
    ...types.map((type: string) => ({kind:'mint' as const,type})),
  ];
  for (const attempt of attempts) {
    const marker = 'AS cart '+crypto.randomUUID(), owned: Array<{objectName:string;id:string}> = [];
    let storeId: string|undefined, accountId: string|undefined, cartId: string|undefined, verified=false, cleanupError: string|undefined, provisionedType: string|undefined;
    let attemptedStore=false,attemptedBuyer=false,attemptedCart=false,before: Value|undefined,after: Value|undefined,nativeCreateEvidence: Value|undefined;
    const capture = (objectName: string, value: string) => {if(!owned.some(v=>v.id===value))owned.push({objectName,id:value});};
    const find = async (name: string, predicate=`Name='${marker}'`) => {
      const result = await request(root+'/query?q='+encodeURIComponent(`SELECT Id,Name${name==='WebCart'?',WebStoreId,AccountId,OwnerId,Status,Type':''} FROM ${name} WHERE ${predicate} LIMIT 3`));
      if (!result.ok || !Array.isArray(result.body?.records) || result.body.records.length>=3) throw Error('Owned Commerce discovery could not be verified.');
      for (const row of result.body.records) {
        if (!id(row.Id)||row.Name!==marker||name==='WebCart'&&row.WebStoreId!==storeId) throw Error('Owned Commerce marker or relationship mismatch.');
        capture(name,row.Id);
      }
      return result.body.records as Value[];
    };
    let outcome: Result = last;
    try {
      outcome = await (async()=>{
        if (attempt.kind === 'reuse') {
          storeId = attempt.storeId;
          const storeRead=await request(root+'/sobjects/WebStore/'+storeId);
          if(!storeRead.ok||!id(storeRead.body?.Id)||typeof storeRead.body?.Type!=='string')return fail('CART_STORE_UNVERIFIED','Actual provisioned store readback failed.');
          provisionedType=storeRead.body.Type;
          attemptedBuyer=true;
          const chain=await provisionBuyerChain({root,marker,groupIds:attempt.groupIds,request,build:input.build,capture});
          memberAttempts.push(...chain.memberAttempts);
          if('failure' in chain)return chain.failure;
          accountId=chain.ids.accountId;
        } else {
          const store = await input.build('WebStore',marker,{Name:marker,Type:attempt.type});
          if ('failure' in store) return store.failure;
          attemptedStore=true;
          const createdStore=await request(root+'/sobjects/WebStore','POST',store.values);
          if (!createdStore.ok||!id(createdStore.body?.id)) return createdStore;
          storeId=createdStore.body.id;capture('WebStore',storeId!);
          const storeRead=await request(root+'/sobjects/WebStore/'+storeId);
          if(!storeRead.ok||storeRead.body?.Name!==marker||storeRead.body?.Type!==attempt.type)return fail('CART_STORE_UNVERIFIED','Actual owned store readback failed.');
          const buyer=await input.build('Account',marker,{Name:marker});
          if('failure' in buyer)return buyer.failure;
          attemptedBuyer=true;
          const createdBuyer=await request(root+'/sobjects/Account','POST',buyer.values);
          if(!createdBuyer.ok||!id(createdBuyer.body?.id))return createdBuyer;
          accountId=createdBuyer.body.id;capture('Account',accountId!);
          const buyerRead=await request(root+'/sobjects/Account/'+accountId);
          if(!buyerRead.ok||buyerRead.body?.Name!==marker)return fail('CART_BUYER_UNVERIFIED','Actual owned buyer readback failed.');
        }
        attemptedCart=true;
        const created=await request(root+'/actions/standard/createCart','POST',{inputs:[{webStoreId:storeId,cartInput:{name:marker,type:cartType,effectiveAccountId:accountId}}]});
        nativeCreateEvidence={status:created.status,bodyKind:created.body===null?'null':Array.isArray(created.body)?'array':typeof created.body,
          outcomeCount:Array.isArray(created.body)?created.body.length:null,successFlags:Array.isArray(created.body)?created.body.map((v: Value)=>v?.isSuccess===true):[],
          outputKeys:Array.isArray(created.body)?created.body.flatMap((v: Value)=>Object.keys(v?.outputValues??{}).filter(k=>/^[A-Za-z][A-Za-z0-9_]*$/.test(k))):[]};
        const records=await find('WebCart',`WebStoreId='${storeId}' AND Name='${marker}'`);
        if(created.ok&&(created.body===null||Array.isArray(created.body)&&created.body.length===0))return fail('CART_ACTION_OUTCOME_MISSING','Salesforce returned no native cart creation outcome for the owned buyer and store; no mutation is counted as successful.');
        if(!successful(created))return created;
        const returned=created.body[0].outputValues?.cartSummary;
        before=records[0];cartId=before?.Id;
        if(records.length!==1||!id(cartId)||!id(before?.OwnerId)||before?.AccountId!==accountId||before?.Type!==cartType||returned?.cartId!==cartId||returned?.accountId!==accountId||returned?.webstoreId!==storeId||returned?.name!==marker||returned?.status!==before?.Status)return fail('CART_CREATION_UNVERIFIED','Native creation did not return one actual cart with the owned buyer and store.');
        if(action==='createCart'){
          verified=true;after=before;
          if(input.verificationWindowMs)await new Promise(resolve=>setTimeout(resolve,input.verificationWindowMs));
          return created;
        }
        const names=new Set(descriptors.deleteCart.inputs.map((f: Value)=>f.name));
        if(!['webStoreId','cartStateOrId'].every(name=>names.has(name)))return fail('CART_DELETE_SCHEMA_UNAVAILABLE','The native delete descriptor lacks store/cart identity inputs.');
        if(input.verificationWindowMs)await new Promise(resolve=>setTimeout(resolve,input.verificationWindowMs));
        const args={webStoreId:storeId,cartStateOrId:cartId,effectiveAccountId:accountId,userId:before!.OwnerId};
        const deleted=await request(input.route,'POST',{inputs:[Object.fromEntries(Object.entries(args).filter(([name])=>names.has(name)))]});
        const actual=await request(root+'/sobjects/WebCart/'+cartId);after=actual.body;
        if(!successful(deleted))return deleted;
        verified=actual.status===404||actual.ok&&after?.Id===cartId&&after?.Name===marker&&after?.WebStoreId===storeId&&after?.AccountId===accountId&&before?.Status!=='PendingDelete'&&after?.Status==='PendingDelete';
        if(verified&&input.verificationWindowMs)await new Promise(resolve=>setTimeout(resolve,input.verificationWindowMs));
        return verified?deleted:fail('CART_DELETION_UNVERIFIED','Native deletion did not remove the owned cart or change its actual state to PendingDelete.');
      })();
    } catch {outcome=fail('CART_LIFECYCLE_UNVERIFIED','The owned native Commerce lifecycle could not be verified.');}
    finally {
      try {
        // Discover writes even when a create response was lost or malformed.
        // Reuse never owns the store: no store discovery, no mapping capture.
        if(attemptedStore)await find('WebStore');
        if(attemptedBuyer)await find('Account');
        if(attempt.kind==='reuse'&&accountId) {
          for (const [name, field] of [['BuyerAccount','BuyerId'],['BuyerGroupMember','BuyerId'],['Contact','AccountId']] as const) {
            const links = await request(root+'/query?q='+encodeURIComponent(`SELECT Id FROM ${name} WHERE ${field}='${accountId}' LIMIT 3`));
            if (links.ok && Array.isArray(links.body?.records)) for (const row of links.body.records) if (id(row?.Id)) capture(name, row.Id);
          }
        }
        if(attemptedCart&&storeId)await find('WebCart',`WebStoreId='${storeId}' AND Name='${marker}'`);
      }catch{cleanupError='Owned Commerce cleanup could not be independently read back.';}
      // Partial buyer chains (member ladder exhausted) capture owned rows
      // without a known account id; marker equality still proves ownership
      // (BuyerAccount.Name and Contact.LastName carry the UUID marker), so
      // partials clean instead of failing proof. BuyerGroupMember has no
      // marker: it scopes only by a known parent, and a failed ladder mints
      // no member to scope.
      const cleaned=await cleanupOwnedContext({root,request,records:owned,order:['WebCart','WebStore','Account','BuyerAccount','BuyerGroupMember','Contact'],scopes:[
        {objectName:'WebStore',equals:{Name:marker}}, {objectName:'Account',equals:{Name:marker}},
        ...(attempt.kind==='reuse'
          ? [{objectName:'WebCart',equals:{Name:marker},...(accountId?{ownedParents:[{field:'AccountId',objectName:'Account'}]}:{})}]
          : [{objectName:'WebCart',equals:{Name:marker},ownedParents:[{field:'WebStoreId',objectName:'WebStore'}]}]),
        ...(attempt.kind==='reuse' ? [
          ...(accountId
            ? [{objectName:'BuyerAccount',equals:{BuyerId:accountId},ownedParents:[{field:'BuyerId',objectName:'Account'}]},
               {objectName:'BuyerGroupMember',equals:{BuyerId:accountId},ownedParents:[{field:'BuyerId',objectName:'Account'}]},
               {objectName:'Contact',equals:{AccountId:accountId},ownedParents:[{field:'AccountId',objectName:'Account'}]}]
            : [{objectName:'BuyerAccount',equals:{Name:marker}},{objectName:'Contact',equals:{LastName:marker}}]),
        ] : []),
      ]});
      cleanupError ??= cleaned.cleanupError;
      owned.splice(0,owned.length,...cleaned.ownedRecords);
    }
    const result={status:outcome.status,body:outcome.body,cleanupError,contextSchema:{source:'salesforce_live_native_cart_action',objects:Object.values(schemas),descriptors,marker,storeType:attempt.kind==='reuse'?provisionedType:attempt.type,reusedStore:attempt.kind==='reuse',storeId,accountId,cartId,ownedRecords:owned,verified,nativeCreateEvidence,memberAttempts,beforeStatus:before?.Status,afterStatus:after?.Status,
      verificationRecordIds:cartId?[cartId]:[],automaticSteps:['Read live native descriptors and owned record schemas','Select only published store types','Create and read back an owned store and buyer','Invoke native createCart and verify the actual returned relationships',...(action==='deleteCart'?['Invoke native deleteCart and read back absence or PendingDelete']:[]),'Delete owned context and independently CLI verify absence']}};
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
