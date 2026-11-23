import { cleanupOwnedContext, type OwnershipScope } from './owned-context-cleanup';
import { clampVerificationWindowMs } from './verification-window';
type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const identity = (v:any):v is string => typeof v==='string'&&/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
export const INVITATION_CONTEXT_OBJECTS=['OperatingHours','ServiceTerritory','WorkType','ServiceResource','AppointmentInvitation','AppointmentInvitee'];
export const INVITATION_CONTEXT_FIELDS=['Name','TimeZone','OperatingHoursId','IsActive','EstimatedDuration','DurationType','RelatedRecordId',
 'ServiceTerritoryId','AppointmentTopicId','BookingStartDate','BookingEndDate','UrlExpiryDate','InvitationUrl','AppointmentInvitationId','ParticipantServiceResourceId','IsRequiredResource'];
/** The Scheduler object names are platform contracts, validated against live tenant metadata. */
export async function invokeAppointmentInvitation(input:{root:string;route:string;userId:string;verificationWindowMs?:number;invitationPrefixField?:string;
 connectedOrigin:()=>Promise<string>;request:(path:string,method?:string,body?:any)=>Promise<Result>;
 build:(name:string,marker:string,values:Value)=>Promise<{values:Value}|{failure:Result}>}){
 const {root,request}=input,fail=(code:string,message:string):Result=>({status:422,ok:false,body:{errorCode:code,message}});
 if(input.route!==root+'/actions/standard/saveAppointmentInvitationDetails'||!identity(input.userId))return fail('INVITATION_ROUTE_INVALID','A discovered invitation action and connected execution identity are required.');
 const schemas:Value={};
 for(const name of INVITATION_CONTEXT_OBJECTS){const r=await request(root+'/sobjects/'+name+'/describe');if(!r.ok)return r;
  if(!Array.isArray(r.body?.fields)||!r.body.queryable||name!=='ServiceResource'&&(!r.body.createable||!r.body.deletable))return {status:403,body:{errorCode:'INVITATION_FIXTURE_PERMISSIONS_REQUIRED',message:`Live ${name} fixture access is required; automatically run setup:context-permissions --auto-invitations during provisioning.`}};
  schemas[name]=r.body;
 }
 const descriptor=await request(input.route);if(!descriptor.ok)return descriptor;
 if(!['appointmentInvitationDetails','appointmentInviteeDetails'].every(name=>descriptor.body?.inputs?.some((f:Value)=>f.name===name&&f.type==='STRING'))||
  descriptor.body.inputs.some((f:Value)=>f.required&&!['appointmentInvitationDetails','appointmentInviteeDetails'].includes(f.name))||
  !descriptor.body.outputs?.some((f:Value)=>f.name==='appointmentInvitationId'&&f.type==='STRING'))return fail('INVITATION_CONTRACT_UNAVAILABLE','The live native invitation contract differs from the declared JSON record contract.');
 for(const [name,field,target] of [['ServiceTerritory','OperatingHoursId','OperatingHours'],['AppointmentInvitation','ServiceTerritoryId','ServiceTerritory'],
  ['AppointmentInvitation','AppointmentTopicId','WorkType'],['AppointmentInvitee','AppointmentInvitationId','AppointmentInvitation'],['AppointmentInvitee','ParticipantServiceResourceId','ServiceResource'],['ServiceResource','RelatedRecordId','User']])
  if(!schemas[name].fields.some((f:Value)=>f.name===field&&(name==='ServiceResource'||f.createable)&&f.filterable&&f.referenceTo?.includes(target)))return { ...fail('INVITATION_REFERENCE_UNAVAILABLE',`Live writable ${name}.${field} relationship to ${target} is required; automatically run setup:context-permissions --auto-invitations and retry.`), contextSchema: { source: 'salesforce_live_appointment_invitation_action', objects: Object.values(schemas), verified: false, missingRelationship: { objectName: name, fieldName: field, target, live: schemas[name].fields.find((f:Value)=>f.name===field) } } };
 for(const field of ['BookingStartDate','BookingEndDate','UrlExpiryDate','IsActive','InvitationUrl'])if(!schemas.AppointmentInvitation.fields.some((f:Value)=>f.name===field&&f.createable))return fail('INVITATION_FIELD_UNAVAILABLE','Live writable invitation date and active fields are required.');
 // 37-char marker: User Territory Sharing caps territory names at 40 chars, which the 45-char dashed marker exceeds.
 const marker='AS probe '+crypto.randomUUID().replaceAll('-','').slice(0,28),owned:Array<{objectName:string;id:string}>=[],fixtures:Value={},markerFields:Value={};
 const attempted:Array<{objectName:string;predicate:string}>=[];let nativeInputTypeFields:Array<{name:string;type:string;source:string}>=[];let verified=false,cleanupError:string|undefined,invitationId:string|undefined,invitationUrl:string|undefined;
 let outcome=fail('INVITATION_CONTEXT_UNAVAILABLE','Owned Scheduler invitation context could not be prepared.');
 const capture=(name:string,id:string)=>{if(!owned.some(v=>v.objectName===name&&v.id===id))owned.push({objectName:name,id});};
 const query=async(name:string,predicate:string,fields='Id')=>{const r=await request(root+'/query?q='+encodeURIComponent(`SELECT ${fields} FROM ${name} WHERE ${predicate} LIMIT 3`));
  if(!r.ok||!Array.isArray(r.body?.records)||r.body.records.some((v:Value)=>!identity(v.Id))){outcome=r.ok?fail('INVITATION_QUERY_UNVERIFIED','Live owned invitation query did not return a usable record list.'):r;throw Error('Owned query failed.');}return r.body.records as Value[];};
 const create=async(name:string,values:Value={})=>{
  const field=schemas[name].fields.find((f:Value)=>f.nameField&&f.createable&&f.filterable&&f.type==='string'&&!f.autoNumber&&f.length>=marker.length);
  if(!field){outcome=fail('INVITATION_MARKER_UNAVAILABLE',`Live ${name} lacks a writable ownership marker.`);throw Error('Marker unavailable.');}
  values={...values,[field.name]:marker};markerFields[name]=field.name;
  if(schemas[name].fields.some((f:Value)=>f.name==='IsActive'&&f.createable))values.IsActive=true;
  if(schemas[name].fields.some((f:Value)=>f.type==='reference'&&!f.nillable&&!f.defaultedOnCreate&&!Object.hasOwn(values,f.name))){outcome=fail('INVITATION_REQUIRED_REFERENCE_UNRESOLVED',`Live ${name} has an unresolved required reference.`);throw Error('Reference unresolved.');}
  const built=await input.build(name,marker,values);if('failure' in built){outcome=built.failure;throw Error('Build failed.');}
  attempted.push({objectName:name,predicate:`${field.name}='${marker}'`});
  const r=await request(root+'/sobjects/'+name,'POST',built.values);if(!r.ok||!identity(r.body?.id)){outcome=r;throw Error('Create failed.');}
  capture(name,r.body.id);fixtures[name]=r.body.id;
  const actual=await request(root+'/sobjects/'+name+'/'+r.body.id);if(!actual.ok||Object.entries(values).some(([key,value])=>actual.body?.[key]!==value)){
   outcome=actual.ok?fail('INVITATION_FIXTURE_UNVERIFIED',`Actual ${name} failed ownership/context readback.`):actual;throw Error('Readback failed.');}
  return r.body.id as string;
 };
 try{outcome=await(async()=>{
  const resources=await query('ServiceResource',`RelatedRecordId='${input.userId}' AND IsActive=true`);
  if(resources.length!==1)return fail('INVITATION_EXECUTION_RESOURCE_REQUIRED','One active integration-actor resource is needed; automatically run setup:context-permissions --auto-invitations during provisioning.');
  fixtures.ServiceResource=resources[0].Id;
  const hours=await create('OperatingHours'),territory=await create('ServiceTerritory',{OperatingHoursId:hours}),topic=await create('WorkType');
  const day=(offset:number)=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
  const invitation={ServiceTerritoryId:territory,AppointmentTopicId:topic,BookingStartDate:day(1),BookingEndDate:day(7),UrlExpiryDate:day(10),IsActive:false};
  const invitee={ParticipantServiceResourceId:fixtures.ServiceResource};
  if(schemas.AppointmentInvitee.fields.some((f:Value)=>f.name==='IsRequiredResource'&&f.createable))Object.assign(invitee,{IsRequiredResource:true});
  attempted.push({objectName:'AppointmentInvitation',predicate:`ServiceTerritoryId='${territory}'`});
  const project=(value:Value)=>Object.fromEntries(Object.entries(value).map(([name,v])=>[name[0].toLowerCase()+name.slice(1),v]));
  const topicObject=schemas.AppointmentInvitation.fields.find((f:Value)=>f.name==='AppointmentTopicId')?.referenceTo?.find((name:string)=>fixtures[name]===topic);
  if(!topicObject)return fail('INVITATION_TOPIC_IDENTITY_UNRESOLVED','The owned topic identity does not match a live referenced object type.');
  const topicIdentityKey=topicObject[0].toLowerCase()+topicObject.slice(1)+'Id';
  const origin=new URL(await input.connectedOrigin());
  if(origin.protocol!=='https:'||origin.username||origin.password)return fail('INVITATION_ORIGIN_INVALID','The authenticated Salesforce origin must be a valid HTTPS origin.');
  const invitationUrlPrefix=origin.origin+'/';
  const prefixField=schemas.AppointmentInvitation.fields.find((f:Value)=>f.name==='InvitationUrl'&&f.createable)!.name;
  const urlNames=[prefixField,prefixField[0].toLowerCase()+prefixField.slice(1)].flatMap(name=>[name,name.replace(/Url/g,'URL')]);
  const prefixNames=[...new Set(urlNames.flatMap(name=>[name,name+'Prefix']))];
  const prefixProbe=Object.fromEntries(prefixNames.map(name=>[name,{}]));
  let native=await request(input.route,'POST',{inputs:[{appointmentInvitationDetails:JSON.stringify({...project(invitation),[topicIdentityKey]:topic,...prefixProbe}),appointmentInviteeDetails:JSON.stringify([project(invitee)])}]});
  const messages:string[]=[];
  const inspectError=(v:any,depth=0)=>{if(!v||typeof v!=='object'||depth>8)return;if(typeof v.message==='string')messages.push(v.message);for(const nested of Object.values(v))if(nested&&typeof nested==='object')inspectError(nested,depth+1);};
  inspectError(native.body);
  const typeMessage=messages.find(message=>/java\.lang\.String/.test(message));
  if(typeMessage)nativeInputTypeFields=[...new Set([...typeMessage.matchAll(/\["([A-Za-z][A-Za-z0-9_]{0,127})"\]/g)].map(v=>v[1]).filter(name=>prefixNames.includes(name)))].map(name=>({name,type:'string',source:'salesforce_live_json_type_validator'}));
  if(input.invitationPrefixField&&nativeInputTypeFields.some(f=>f.name===input.invitationPrefixField))
    native=await request(input.route,'POST',{inputs:[{appointmentInvitationDetails:JSON.stringify({...project(invitation),[topicIdentityKey]:topic,[input.invitationPrefixField]:invitationUrlPrefix}),appointmentInviteeDetails:JSON.stringify([project(invitee)])}]});
  const found=await query('AppointmentInvitation',`ServiceTerritoryId='${territory}'`,'Id,ServiceTerritoryId,AppointmentTopicId,BookingStartDate,BookingEndDate,UrlExpiryDate,IsActive,InvitationUrl');
  for(const r of found)capture('AppointmentInvitation',r.Id);
  if(found.length===1){invitationId=found[0].Id;fixtures.AppointmentInvitation=invitationId;}
  if(invitationId){for(const r of await query('AppointmentInvitee',`AppointmentInvitationId='${invitationId}'`))capture('AppointmentInvitee',r.Id);}
  if(!native.ok||!Array.isArray(native.body)||native.body.length!==1||native.body[0]?.isSuccess!==true||native.body[0].errors?.length||native.body[0].outputValues?.errorMessage)return native;
  if(!invitationId||native.body[0].outputValues?.appointmentInvitationId!==invitationId)return fail('INVITATION_MUTATION_UNVERIFIED','Native success did not match the actual owned invitation identity.');
  const children=await query('AppointmentInvitee',`AppointmentInvitationId='${invitationId}'`,'Id,AppointmentInvitationId,ParticipantServiceResourceId');
  if(children.length===1)fixtures.AppointmentInvitee=children[0].Id;
  invitationUrl=native.body[0].outputValues?.appointmentInvitationUrl;
  const actual=found[0];verified=!!(Object.entries(invitation).every(([key,value])=>actual[key]===value)&&children.length===1&&children[0].ParticipantServiceResourceId===fixtures.ServiceResource&&
   typeof invitationUrl==='string'&&invitationUrl.length>0&&actual.InvitationUrl===invitationUrl);
  return verified?native:fail('INVITATION_RELATIONSHIPS_UNVERIFIED','The actual owned invitation fields, generated URL and integration-actor invitee relationship were not all verified.');
 })();}catch{if(outcome.ok)outcome=fail('INVITATION_LIFECYCLE_UNVERIFIED','The native owned invitation lifecycle could not be verified.');}
 finally{
  if(owned.length&&input.verificationWindowMs)await new Promise(resolve=>setTimeout(resolve,clampVerificationWindowMs(input.verificationWindowMs)));
  for(const item of attempted){try{const found=await query(item.objectName,item.predicate);if(found.length>2)throw Error('Ambiguous context.');for(const r of found)capture(item.objectName,r.Id);}catch{cleanupError='Owned invitation recovery could not be verified.';}}
  for(const parent of owned.filter(v=>v.objectName==='AppointmentInvitation')){try{for(const r of await query('AppointmentInvitee',`AppointmentInvitationId='${parent.id}'`))capture('AppointmentInvitee',r.Id);}catch{cleanupError='Owned invitation child recovery could not be verified.';}}
  const scopes: OwnershipScope[]=Object.entries(markerFields).map(([objectName,field])=>({objectName,equals:{[String(field)]:marker}}));
  scopes.push({objectName:'AppointmentInvitation',equals:{ServiceTerritoryId:fixtures.ServiceTerritory},ownedParents:[{field:'ServiceTerritoryId',objectName:'ServiceTerritory'}]},
   {objectName:'AppointmentInvitee',equals:{AppointmentInvitationId:invitationId},ownedParents:[{field:'AppointmentInvitationId',objectName:'AppointmentInvitation'}]});
  const cleaned=await cleanupOwnedContext({root,request,records:owned,scopes,order:['AppointmentInvitee','AppointmentInvitation','WorkType','ServiceTerritory','OperatingHours']});
  cleanupError??=cleaned.cleanupError;
  owned.splice(0,owned.length,...cleaned.ownedRecords);
 }
 return {status:outcome.status,body:outcome.body,cleanupError,contextSchema:{source:'salesforce_live_appointment_invitation_action',objects:Object.values(schemas),marker,markerFields,fixtures,ownedRecords:owned,verified,
  payloadCandidate:{source:'synthetic_field_case_projection',case:'lowerCamel',topicIdentityProjection:'live_referenced_object_type',urlPrefixSource:'authenticated_salesforce_origin',urlPrefixCandidateKey:'live_url_field_case_type_probe',invitationShape:'object',inviteeShape:'array',acceptedAndIndependentlyVerified:verified},
  nativeInputTypeFields,
  retainedRecords:fixtures.ServiceResource?[{objectName:'ServiceResource',id:fixtures.ServiceResource}]:[],verificationRecordIds:invitationId?[invitationId]:[],
  automaticSteps:['Read the live Scheduler action and all referenced object schemas','Automatically run setup:context-permissions --auto-invitations during provisioning',
   'Reuse the active integration-actor resource without changing it','Create owned operating hours, territory and work type','Invoke native invitation save with owned topic, dates and integration actor',
   'Verify the actual invitation, generated URL and invitee relationship','Delete only owned context and independently verify absence']}};
}
