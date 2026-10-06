import { cleanupOwnedContext, type OwnedRecord } from './owned-context-cleanup';
type Value = Record<string, any>;
type Result = {status:number;ok:boolean;body:any};
const record = (v:any):v is Value => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v:any):v is string => typeof v === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
/** Creates a terminal contact request owned by the execution user; never calls a phone API. */
export async function invokeContactRequestContext(input:{root:string;route:string;userId:string;verificationWindowMs?:number;request:(path:string,method?:string,body?:any)=>Promise<Result>}) {
  const {root,request}=input;
  const failure=(status:number,errorCode:string,message:string)=>({status,body:{errorCode,message}});
  if(!id(input.userId)||input.route!==`${root}/actions/standard/contactRequestAction`)return failure(400,'CONTACT_REQUEST_INVALID','A discovered contact request action and execution identity are required.');
  const descriptor=await request(input.route),schema=await request(`${root}/sobjects/ContactRequest/describe`);
  if(!descriptor.ok)return descriptor;if(!schema.ok)return schema;
  if(!record(descriptor.body)||!Array.isArray(descriptor.body.inputs)||!record(schema.body)||!Array.isArray(schema.body.fields)||!schema.body.createable||!schema.body.queryable||!schema.body.deletable)return failure(403,'CONTACT_REQUEST_PERMISSIONS_REQUIRED','ContactRequest create/read/delete and native input field access are required; automatically run setup:context-permissions --auto-contact-requests.');
  const fields=schema.body.fields.filter(record),inputs=descriptor.body.inputs.filter(record);
  const markerField=fields.find(f=>f.name==='RequestDescription'&&f.createable&&f.type==='textarea'&&inputs.some(v=>v.name===f.name));
  const statusField=fields.find(f=>f.name==='Status'&&f.createable);
  const terminal=statusField?.picklistValues?.find((v:Value)=>v.active===true&&v.value==='Abandoned')?.value;
  if(!markerField||!terminal)return failure(422,'CONTACT_REQUEST_TERMINAL_CONTEXT_UNAVAILABLE','A live writable description marker and terminal Abandoned status are required before creating a non-dispatching fixture.');
  const marker=`AS probe ${crypto.randomUUID()}`,args:Value={[markerField.name]:marker,OwnerId:input.userId,Status:terminal};
  for(const parameter of inputs.filter(v=>v.required===true)) {
    if(Object.hasOwn(args,parameter.name))continue;
    const field=fields.find(f=>f.name===parameter.name&&f.createable===true);
    if(!field)return failure(403,'CONTACT_REQUEST_INPUT_ACCESS_REQUIRED',`The live ${parameter.name} input has no writable target field; automatically provision its discovered field permission.`);
    if(field.type==='picklist')args[parameter.name]=field.picklistValues?.find((v:Value)=>v.active&&v.defaultValue)?.value??field.picklistValues?.find((v:Value)=>v.active)?.value;
    else if(field.type==='phone')args[parameter.name]='+12025550100'; // North American reserved fictional subscriber range.
    else return failure(422,'CONTACT_REQUEST_INPUT_UNRESOLVED',`The live required ${parameter.name} input needs an owned context resolver.`);
    if(args[parameter.name]===undefined)return failure(422,'CONTACT_REQUEST_CHOICE_UNAVAILABLE','A required contact request field has no live active choice.');
  }
  const startedAt = new Date(Date.now()-1000).toISOString();
  let ownedId:string|undefined,verified=false,cleanupError:string|undefined;
  const candidates:OwnedRecord[]=[];
  let outcome:any=failure(422,'CONTACT_REQUEST_UNVERIFIED','The native action did not produce a verified owned request.');
  try {
    outcome=await request(input.route,'POST',{inputs:[args]});
    const accepted=outcome.ok&&Array.isArray(outcome.body)&&outcome.body.length>0&&outcome.body.every((v:any)=>record(v)&&v.isSuccess===true&&(!Array.isArray(v.errors)||!v.errors.length));
    if(accepted){const value=outcome.body[0]?.outputValues?.Id;if(id(value))ownedId=value;}
    // Recover ownership by execution actor + creation window if Salesforce loses its action response.
    if(!ownedId) {
      const result=await request(`${root}/query?q=${encodeURIComponent(`SELECT Id,RequestDescription FROM ContactRequest WHERE OwnerId='${input.userId}' AND CreatedDate>=${startedAt} ORDER BY CreatedDate DESC LIMIT 20`)}`);
      const matches=Array.isArray(result.body?.records)?result.body.records.filter((v:Value)=>v.RequestDescription===marker&&id(v.Id)):[];
      if(matches.length===1)ownedId=matches[0].Id;
      if (!result.ok || !Array.isArray(result.body?.records) || matches.length > 1 || (!ownedId && (accepted || outcome.status >= 500))) cleanupError = 'Owned contact request recovery could not establish cleanup; the failed invocation must remain unresolved.';
    }
    if(ownedId){const actual=await request(`${root}/sobjects/ContactRequest/${ownedId}`);verified=accepted&&actual.ok&&actual.body?.RequestDescription===marker&&actual.body?.OwnerId===input.userId&&actual.body?.Status===terminal;}
    if(verified&&input.verificationWindowMs)await new Promise(resolve=>setTimeout(resolve,input.verificationWindowMs));
    if(accepted&&!verified)outcome=failure(422,'CONTACT_REQUEST_MUTATION_UNVERIFIED','Salesforce reported success without the owned terminal record state.');
  } finally {
    if(ownedId)candidates.push({objectName:'ContactRequest',id:ownedId});
    try {
      // Description is not filterable. Recover even when an envelope returned a
      // different existing ID, using an actor-scoped bounded creation window.
      const result=await request(`${root}/query?q=${encodeURIComponent(`SELECT Id,RequestDescription FROM ContactRequest WHERE OwnerId='${input.userId}' AND CreatedDate>=${startedAt} ORDER BY CreatedDate DESC LIMIT 20`)}`);
      if(!result.ok||!Array.isArray(result.body?.records)||result.body.records.length>=20)cleanupError='Owned contact request cleanup recovery could not be completely verified.';
      if(result.ok&&Array.isArray(result.body?.records))for(const row of result.body.records)if(row.RequestDescription===marker&&id(row.Id))candidates.push({objectName:'ContactRequest',id:row.Id});
    }catch{cleanupError='Owned contact request cleanup recovery could not be verified.';}
    const cleaned=await cleanupOwnedContext({root,request,records:candidates,scopes:[{objectName:'ContactRequest',equals:{RequestDescription:marker,OwnerId:input.userId}}],order:['ContactRequest']});
    cleanupError ??= cleaned.cleanupError;
    candidates.splice(0,candidates.length,...cleaned.ownedRecords);
  }
  return {...outcome,...(cleanupError?{cleanupError}:{}),contextSchema:{source:'salesforce_live_record_action',targetObject:'ContactRequest',markerField:markerField.name,marker,markerFilterable:false,ownerId:input.userId,mutationKind:'create',verified,verificationRecordIds:verified?[ownedId]:[],ownedRecords:candidates,expectedChanges:{Status:terminal,OwnerId:input.userId},automaticSteps:['Discover native inputs and ContactRequest fields','Resolve live picklist values and a terminal state','Create through the native action with the execution user as owner','Independently read the unique description and terminal state','Delete only the owned request and verify absence']}};
}
