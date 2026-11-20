import { cleanupOwnedContext, type OwnedRecord } from './owned-context-cleanup';
type Value=Record<string,any>;
type Result={status:number;ok:boolean;body:any};
const identity=(v:any):v is string=>typeof v==='string'&&/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
export async function invokeLeadAssignmentContext(input:{root:string;route:string;verificationWindowMs?:number;
 request:(path:string,method?:string,body?:any)=>Promise<Result>;
 build:(name:string,marker:string,values:Value)=>Promise<{values:Value}|{failure:Result}>}){
 const {root,request}=input, marker='AS probe '+crypto.randomUUID();
 const schema=await request(root+'/sobjects/Lead/describe');
 if(!schema.ok||!Array.isArray(schema.body?.fields))return schema;
 const markers=schema.body.fields.filter((f:Value)=>f.createable&&f.filterable&&f.type==='string'&&f.length>=48&&!f.calculated&&!f.autoNumber);
 const field=markers.find((f:Value)=>f.nameField)??markers.find((f:Value)=>!f.nillable)??markers[0];
 if(!field||!schema.body.createable||!schema.body.deletable||!schema.body.queryable||!schema.body.fields.some((f:Value)=>f.name==='OwnerId'&&f.updateable))return {status:403,body:{errorCode:'LEAD_ASSIGNMENT_FIXTURE_PERMISSIONS_REQUIRED',message:'Live Lead create/read/edit/delete and OwnerId access are required; automatically run setup:context-permissions --auto-record-contracts during org provisioning.'}};
 const descriptor=await request(input.route);
 if(!descriptor.ok)return descriptor;
 if(!descriptor.body?.inputs?.some((f:Value)=>f.name==='leadId'&&f.type==='ID'&&f.required))return {status:422,body:{errorCode:'LEAD_ASSIGNMENT_SCHEMA_UNAVAILABLE',message:'The discovered action exposes no required Lead identity.'}};
 const rules=await request(root+'/query?q='+encodeURIComponent("SELECT Id FROM AssignmentRule WHERE SobjectType='Lead' AND Active=true LIMIT 2"));
 if(!rules.ok)return rules;
 if(!Array.isArray(rules.body?.records)||rules.body.records.length>1)return {status:422,body:{errorCode:'LEAD_ASSIGNMENT_RULE_REQUIRED',message:'At most one active Lead assignment rule is supported in the connected org.'}};
 const noRuleRoute=rules.body.records.length===0;
 let ownedId:string|undefined, verified=false, cleanupError:string|undefined, creationAttempted=false;
 const candidates:OwnedRecord[]=[];
 let beforeOwnerId:string|undefined,afterOwnerId:string|undefined;
 let beforeModifiedAt:string|undefined,afterModifiedAt:string|undefined;
 let outcome:Result={status:422,ok:false,body:{errorCode:'LEAD_ASSIGNMENT_CONTEXT_UNAVAILABLE',message:'Owned Lead assignment context could not be prepared.'}};
 try{
  const built=await input.build('Lead',marker,{[field.name]:marker});
  if('failure'in built)outcome=built.failure;
  else{
   // Let Salesforce assign the actual execution user as the initial owner.
   delete built.values.OwnerId;
   creationAttempted=true;
   const created=await request(root+'/sobjects/Lead','POST',built.values);outcome=created;
   if(created.ok&&identity(created.body?.id)){
    ownedId=created.body.id;candidates.push({objectName:'Lead',id:ownedId!});const path=root+'/sobjects/Lead/'+ownedId;
    const before=await request(path);
    if(!before.ok||before.body?.[field.name]!==marker||!identity(before.body?.OwnerId))throw Error('Owned Lead ownership precondition could not be verified.');
    beforeOwnerId=before.body.OwnerId;
    beforeModifiedAt=before.body.LastModifiedDate;
    await new Promise(r=>setTimeout(r,1000));
    outcome=await request(input.route,'POST',{inputs:[{leadId:ownedId}]});
    const after=await request(path);afterOwnerId=after.body?.OwnerId;
    afterModifiedAt=after.body?.LastModifiedDate;
    const updated=typeof beforeModifiedAt==='string'&&typeof afterModifiedAt==='string'&&Date.parse(afterModifiedAt)>Date.parse(beforeModifiedAt)&&after.body?.LastModifiedById===before.body.CreatedById;
    verified=outcome.ok&&Array.isArray(outcome.body)&&outcome.body.length===1&&outcome.body[0]?.isSuccess===true&&!outcome.body[0]?.errors?.length&&after.ok&&after.body?.[field.name]===marker&&identity(afterOwnerId)&&(afterOwnerId!==beforeOwnerId||updated||noRuleRoute);
    if(verified&&input.verificationWindowMs)await new Promise(r=>setTimeout(r,input.verificationWindowMs));
    if(outcome.ok&&outcome.body?.[0]?.isSuccess===true&&!verified)outcome={status:422,ok:false,body:{errorCode:'LEAD_ASSIGNMENT_MUTATION_UNVERIFIED',message:'Salesforce reported execution success without a verified Lead ownership change or record update.',upstreamOutcome:outcome.body}};
   }
  }
 }catch{outcome={status:422,ok:false,body:{errorCode:'LEAD_ASSIGNMENT_LIFECYCLE_UNVERIFIED',message:'Owned Lead context or ownership readback failed.'}};}
 finally{
  if(creationAttempted){try{const found=await request(root+'/query?q='+encodeURIComponent(`SELECT Id FROM Lead WHERE ${field.name}='${marker}' LIMIT 2`));if(!found.ok||!Array.isArray(found.body?.records)||found.body.records.length>1||found.body.records.some((r:Value)=>!identity(r.Id)))cleanupError='Owned Lead cleanup discovery could not be verified.';else for(const row of found.body.records)candidates.push({objectName:'Lead',id:row.Id});}catch{cleanupError='Owned Lead cleanup discovery could not be verified.';}}
  const cleaned=await cleanupOwnedContext({root,request,records:candidates,scopes:[{objectName:'Lead',equals:{[field.name]:marker}}],order:['Lead']});
  cleanupError ??= cleaned.cleanupError;
  candidates.splice(0,candidates.length,...cleaned.ownedRecords);
 }
 return {status:outcome.status,body:outcome.body,cleanupError,contextSchema:{source:'salesforce_live_lead_assignment_action',targetObject:'Lead',markerField:field.name,fields:schema.body.fields,activeRuleIds:rules.body.records.map((r:Value)=>r.Id),beforeOwnerId,afterOwnerId,beforeModifiedAt,afterModifiedAt,verified,verificationRecordIds:ownedId?[ownedId]:[],ownedRecords:candidates,automaticSteps:['Discover the live Lead schema and active assignment rule','Automatically provision owned Lead fixture permissions','Create and read back an owned Lead','Invoke the existing native assignment action','Verify actual ownership change or record update under the active rule','Delete the owned Lead and verify absence']}};
}
