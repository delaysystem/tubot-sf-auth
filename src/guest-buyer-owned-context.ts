import { cleanupOwnedContext } from './owned-context-cleanup';
type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const id = (v: any): v is string => typeof v === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
const successful = (r: Result) => r.ok && Array.isArray(r.body) && r.body.length === 1 && r.body[0]?.isSuccess === true && !r.body[0].errors?.length;
export const GUEST_BUYER_ACTIONS = ['registerGuestBuyer'];
export const GUEST_BUYER_OBJECTS = ['WebStore', 'Account'];
export const GUEST_BUYER_LIFECYCLE_BUILDER_VERSION = 85;

/** Guest-buyer registration operates only on an owned store and buyer account. */
export async function invokeGuestBuyerRegistration(input: {
  root: string; route: string; verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
}): Promise<{status: number; body: any; cleanupError?: string; contextSchema?: Value}> {
  const {root,request} = input, action = input.route.split('/').at(-1)!;
  const fail = (errorCode: string, message: string): Result => ({status:422,ok:false,body:{errorCode,message}});
  if (!GUEST_BUYER_ACTIONS.includes(action)) return fail('GUEST_BUYER_ACTION_INVALID','A supported discovered guest-buyer route is required.');
  const schemas: Value = {};
  for (const name of GUEST_BUYER_OBJECTS) {
    const live = await request(root+'/sobjects/'+name+'/describe');
    if (!live.ok) return live;
    if (!live.body?.queryable || !live.body?.deletable || !Array.isArray(live.body?.fields)) return fail('GUEST_BUYER_CONTEXT_PERMISSIONS_REQUIRED','Live owned guest-buyer records require query and cleanup access.');
    schemas[name] = live.body;
  }
  const descriptor = await request(root+'/actions/standard/'+action);
  if (!descriptor.ok) return descriptor;
  if (!Array.isArray(descriptor.body?.inputs)) return fail('GUEST_BUYER_ACTION_SCHEMA_UNAVAILABLE','The native guest-buyer descriptor has no input schema.');
  if (!['webstoreId','accountId'].every(name => descriptor.body.inputs.some((f: Value)=>f.name===name))) return fail('GUEST_BUYER_ACTION_SCHEMA_UNAVAILABLE','The live registration action does not publish store and account inputs.');
  const outputName = Array.isArray(descriptor.body?.outputs) ? descriptor.body.outputs.find((f: Value)=>typeof f?.name==='string')?.name : undefined;
  // The vendor rejects business-account buyers on every store type and B2CE
  // stores unconditionally ("The API isn't supported for B2CE store"):
  // Person Accounts are the only substrate. Fail fast before any fixture.
  if (!schemas.Account.fields.some((f: Value)=>f.name==='IsPersonAccount')) return fail('GUEST_BUYER_PERSON_ACCOUNT_REQUIRED','Guest-buyer registration requires Person Accounts: the live Account schema has no IsPersonAccount field. Enable Person Accounts through Setup (an irreversible org change) before retrying.');
  const personRt = await request(root+'/query?q='+encodeURIComponent("SELECT Id FROM RecordType WHERE SobjectType='Account' AND IsPersonType=true LIMIT 1"));
  const personRtId = personRt.ok && Array.isArray(personRt.body?.records) && personRt.body.records.length===1 && id(personRt.body.records[0]?.Id) ? personRt.body.records[0].Id : undefined;
  if (!personRtId) return fail('GUEST_BUYER_PERSON_ACCOUNT_REQUIRED','Guest-buyer registration requires a Person-Account record type and none is queryable.');
  const types = (schemas.WebStore.fields.find((f: Value)=>f.name==='Type'&&f.createable)?.picklistValues?.filter((p: Value)=>p.active&&typeof p.value==='string').map((p: Value)=>p.value) ?? []).filter((t: string)=>t!=='B2CE');
  if (!types.length) return fail('GUEST_BUYER_TYPE_UNAVAILABLE','Live store types are required.');
  for (const name of GUEST_BUYER_OBJECTS) if (!schemas[name].createable || !schemas[name].fields.some((f: Value)=>f.name==='Name'&&f.createable&&f.filterable&&f.length>=48)) return fail('GUEST_BUYER_MARKER_UNAVAILABLE','Owned store and buyer records require writable, queryable Name markers.');
  const contactSchema = await request(root+'/sobjects/Contact/describe');
  const contactQueryable = contactSchema.ok && contactSchema.body?.queryable === true && Array.isArray(contactSchema.body?.fields) && contactSchema.body.fields.some((f: Value)=>f.name==='AccountId'&&f.filterable);
  let last = fail('GUEST_BUYER_CONTEXT_UNAVAILABLE','No live store type supported guest-buyer registration.');
  for (const type of types) {
    const marker = 'AS guestbuyer '+crypto.randomUUID(), owned: Array<{objectName:string;id:string}> = [];
    let storeId: string|undefined, accountId: string|undefined, verified=false, cleanupError: string|undefined;
    let attemptedStore=false,attemptedBuyer=false,nativeEvidence: Value|undefined,outputKeys: string[] = [];
    const capture = (objectName: string, value: string) => {if(!owned.some(v=>v.id===value))owned.push({objectName,id:value});};
    const find = async (name: string, predicate: string, select='Id,Name') => {
      const result = await request(root+'/query?q='+encodeURIComponent(`SELECT ${select} FROM ${name} WHERE ${predicate} LIMIT 3`));
      if (!result.ok || !Array.isArray(result.body?.records) || result.body.records.length>=3) throw Error('Owned guest-buyer discovery could not be verified.');
      for (const row of result.body.records) {
        if (!id(row.Id)||name!=='Contact'&&row.Name!==marker||name==='Contact'&&row.AccountId!==accountId) throw Error('Owned guest-buyer marker or relationship mismatch.');
        capture(name,row.Id);
      }
      return result.body.records as Value[];
    };
    let outcome: Result = last;
    try {
      outcome = await (async()=>{
        const store = await input.build('WebStore',marker,{Name:marker,Type:type});
        if ('failure' in store) return store.failure;
        attemptedStore=true;
        const createdStore=await request(root+'/sobjects/WebStore','POST',store.values);
        if (!createdStore.ok||!id(createdStore.body?.id)) return createdStore;
        storeId=createdStore.body.id;capture('WebStore',storeId!);
        const storeRead=await request(root+'/sobjects/WebStore/'+storeId);
        if(!storeRead.ok||storeRead.body?.Name!==marker||storeRead.body?.Type!==type)return fail('GUEST_BUYER_STORE_UNVERIFIED','Actual owned store readback failed.');
        const buyer=await input.build('Account',marker,{LastName:marker,RecordTypeId:personRtId});
        if('failure' in buyer)return buyer.failure;
        attemptedBuyer=true;
        const createdBuyer=await request(root+'/sobjects/Account','POST',buyer.values);
        if(!createdBuyer.ok||!id(createdBuyer.body?.id))return createdBuyer;
        accountId=createdBuyer.body.id;capture('Account',accountId!);
        const buyerRead=await request(root+'/sobjects/Account/'+accountId);
        if(!buyerRead.ok||buyerRead.body?.Name!==marker)return fail('GUEST_BUYER_BUYER_UNVERIFIED','Actual owned buyer readback failed.');
        const created=await request(input.route,'POST',{inputs:[{webstoreId:storeId,accountId}]});
        outputKeys=Object.keys(created.body?.[0]?.outputValues??{}).filter(k=>/^[A-Za-z][A-Za-z0-9_]*$/.test(k));
        nativeEvidence={status:created.status,bodyKind:created.body===null?'null':Array.isArray(created.body)?'array':typeof created.body,
          outcomeCount:Array.isArray(created.body)?created.body.length:null,successFlags:Array.isArray(created.body)?created.body.map((v: Value)=>v?.isSuccess===true):[],outputKeys};
        if(created.ok&&(created.body===null||Array.isArray(created.body)&&created.body.length===0))return fail('GUEST_BUYER_ACTION_OUTCOME_MISSING','Salesforce returned no native registration outcome for the owned buyer and store; no mutation is counted as successful.');
        if(!successful(created))return created;
        const output = created.body[0].outputValues;
        if(!output||typeof output!=='object'||outputName!==undefined&&output[outputName]===undefined)return fail('GUEST_BUYER_REGISTRATION_UNVERIFIED','Native registration returned no declared output for the owned buyer and store.');
        const storeReread=await request(root+'/sobjects/WebStore/'+storeId);
        const buyerReread=await request(root+'/sobjects/Account/'+accountId);
        if(!storeReread.ok||storeReread.body?.Name!==marker||!buyerReread.ok||buyerReread.body?.Name!==marker)return fail('GUEST_BUYER_REGISTRATION_UNVERIFIED','Owned fixtures could not be read back after native registration.');
        if(contactQueryable&&accountId)await find('Contact',`AccountId='${accountId}'`,'Id,AccountId');
        verified=true;
        if(input.verificationWindowMs)await new Promise(resolve=>setTimeout(resolve,input.verificationWindowMs));
        return created;
      })();
    } catch {outcome=fail('GUEST_BUYER_LIFECYCLE_UNVERIFIED','The owned guest-buyer lifecycle could not be verified.');}
    finally {
      try {
        // Discover writes even when a create response was lost or malformed.
        if(attemptedStore)await find('WebStore',`Name='${marker}'`);
        if(attemptedBuyer)await find('Account',`Name='${marker}'`);
        if(contactQueryable&&accountId)await find('Contact',`AccountId='${accountId}'`,'Id,AccountId');
      }catch{cleanupError='Owned guest-buyer cleanup could not be independently read back.';}
      // Person-account shadows cannot be deleted directly (400
      // INVALID_PERSON_ACCOUNT_OPERATION, live-verified); the Person Account
      // delete cascades its shadow, so the account precedes the contact and
      // the contact legs verify cascade absence.
      const cleaned=await cleanupOwnedContext({root,request,records:owned,order:['WebStore','Account','Contact'],scopes:[
        {objectName:'WebStore',equals:{Name:marker}}, {objectName:'Account',equals:{Name:marker}},
        ...(accountId?[{objectName:'Contact',equals:{AccountId:accountId},ownedParents:[{field:'AccountId',objectName:'Account'}]}]:[]),
      ]});
      cleanupError ??= cleaned.cleanupError;
      owned.splice(0,owned.length,...cleaned.ownedRecords);
    }
    const result={status:outcome.status,body:outcome.body,cleanupError,contextSchema:{source:'salesforce_live_native_guest_buyer_action',objects:Object.values(schemas),descriptor:descriptor.body,marker,storeType:type,storeId,accountId,ownedRecords:owned,verified,nativeEvidence,outputKeys,
      verificationRecordIds:accountId?[accountId]:[],automaticSteps:['Read live native descriptor and owned record schemas','Select only published store types','Create and read back an owned store and buyer','Invoke native registerGuestBuyer and verify the declared output','Delete owned context and independently CLI verify absence']}};
    if(verified||cleanupError)return result;
    last=outcome;
    // CARTREGRESS: fall through store types on client validation refusals
    // (HTTP 400 from the store mint OR the native call). B2CE is excluded
    // up front: the vendor rejects it unconditionally regardless of buyer.
    // Per-attempt cleanup already ran in `finally`. Return immediately only
    // on verified/cleanupError/non-400.
    if(outcome.status!==400)return result;
  }
  return {status:last.status,body:last.body};
}
