type Value=Record<string,any>;
type Result={status:number;ok:boolean;body:any};
const identity=(v:any):v is string=>typeof v==='string'&&/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
export const xmlText=(v:string)=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export async function invokeCustomFieldActionContext(input:{root:string;route:string;target:string;verificationWindowMs?:number;
 request:(path:string,method?:string,body?:any)=>Promise<Result>;
 remove:(fullName:string)=>Promise<{status:number;ok:boolean;missing:boolean}>}){
 const {root,request,target}=input;
 const descriptor=await request(input.route), tooling=await request(root+'/tooling/sobjects/CustomField/describe');
 if(!descriptor.ok)return descriptor;if(!tooling.ok)return tooling;
 if(!descriptor.body?.inputs||!['Datatype','Entity','Label','Name'].every(n=>descriptor.body.inputs.some((f:Value)=>f.name===n&&f.type==='STRING'))||!tooling.body?.queryable)return {status:422,body:{errorCode:'CUSTOM_FIELD_ACTION_SCHEMA_UNAVAILABLE',message:'The live action and queryable CustomField schema are required.'}};
 const tables=tooling.body.fields?.find((f:Value)=>f.name==='TableEnumOrId')?.picklistValues;
 if(!tables?.some((v:Value)=>v.active&&v.value===target))return {status:422,body:{errorCode:'CUSTOM_FIELD_TARGET_UNSUPPORTED',message:'The selected live target is not exposed by the CustomField entity catalog.'}};
 const name='AS_field_'+crypto.randomUUID().replaceAll('-','').slice(0,24), prospectiveName=target+'.'+name+'__c', label='AS field probe '+crypto.randomUUID().slice(0,20);
 const lookup=()=>request(root+'/tooling/query?q='+encodeURIComponent(`SELECT Id,DeveloperName FROM CustomField WHERE TableEnumOrId='${target}' AND DeveloperName='${name}' LIMIT 2`));
 const before=await lookup();if(!before.ok||!Array.isArray(before.body?.records)||before.body.records.length)return {status:422,body:{errorCode:'CUSTOM_FIELD_OWNERSHIP_UNAVAILABLE',message:'A unique absent field name could not be independently established.'}};
 const access=await input.remove(prospectiveName);
 if(!access.ok&&!access.missing)return {status:access.status>=400?access.status:403,body:{errorCode:'CUSTOM_FIELD_METADATA_DELETE_REQUIRED',message:'Authenticated Metadata API delete access is required before creating an owned field; grant live metadata configuration permissions and retry.'}};
 let fullName=prospectiveName;
 let ownedId:string|undefined,verified=false,cleanupError:string|undefined;
 let outcome:Result={status:422,ok:false,body:{errorCode:'CUSTOM_FIELD_CONTEXT_UNAVAILABLE',message:'Owned CustomField creation could not be verified.'}};
 try{
  outcome=await request(input.route,'POST',{inputs:[{Datatype:'Text',Entity:target,Label:label,Name:name,Length:32,Required:false,Unique:false,Description:label}]});
  for(let attempt=0;attempt<10;attempt++){
   const found=await lookup();if(!found.ok||!Array.isArray(found.body?.records)||found.body.records.length>1)throw Error('Owned field discovery is unavailable or ambiguous.');
   if(found.body.records.length===1&&identity(found.body.records[0].Id)){ownedId=found.body.records[0].Id;break;}
   if(!outcome.ok)break;await new Promise(r=>setTimeout(r,1000));
  }
  if(ownedId){const actual=await request(root+'/tooling/sobjects/CustomField/'+ownedId);
   const namespace=actual.body?.NamespacePrefix; const qualified=target+'.'+(typeof namespace==='string'&&namespace?namespace+'__':'')+name+'__c';
   if(actual.body?.FullName===qualified) fullName=qualified;
   const outputValues=outcome.body?.[0]?.outputValues;
   const outputId=outputValues&&typeof outputValues==='object'?(outputValues.Id??Object.entries(outputValues).find(([k])=>/^id\.?$/i.test(k))?.[1]):undefined;
   verified=outcome.ok&&Array.isArray(outcome.body)&&outcome.body.length===1&&outcome.body[0]?.isSuccess===true&&!outcome.body[0]?.errors?.length&&identity(outputId)&&outputId.slice(0,15)===ownedId.slice(0,15)&&actual.ok&&actual.body?.FullName===fullName&&actual.body?.Metadata?.label===label&&actual.body?.Metadata?.type==='Text'&&actual.body?.Metadata?.length===32;}
  if(verified&&input.verificationWindowMs)await new Promise(r=>setTimeout(r,input.verificationWindowMs));
  if(outcome.ok&&outcome.body?.[0]?.isSuccess===true&&!verified)outcome={status:422,ok:false,body:{errorCode:'CUSTOM_FIELD_MUTATION_UNVERIFIED',message:'Salesforce reported success without the actual owned Text field metadata.',upstreamOutcome:outcome.body}};
 }catch{outcome={status:422,ok:false,body:{errorCode:'CUSTOM_FIELD_LIFECYCLE_UNVERIFIED',message:'Owned field metadata could not be verified.'}};}
 finally {
  const found = await lookup();
  if (!found.ok || !Array.isArray(found.body?.records) || found.body.records.length > 1) cleanupError = 'Owned CustomField cleanup discovery failed.';
  else if (found.body.records.length === 1) {
    const actualId = found.body.records[0].Id;
    if (!identity(actualId) || ownedId && ownedId !== actualId) cleanupError = 'Owned field cleanup identity is ambiguous.';
    else {
      ownedId = actualId;
      const actual = await request(root + '/tooling/sobjects/CustomField/' + ownedId);
      const ns = actual.body?.NamespacePrefix;
      const qualified = target + '.' + (typeof ns === 'string' && ns ? ns + '__' : '') + name + '__c';
      if (!actual.ok || actual.body?.FullName !== qualified || actual.body?.Metadata?.label !== label) cleanupError = 'Owned field full-name and marker cleanup verification failed.';
      else {
        fullName = qualified;
        const removed = await input.remove(fullName);
        if (!removed.ok && !removed.missing) cleanupError = 'Authenticated owned field metadata deletion failed.';
      }
    }
  }
  const gone = await lookup();
  if (!gone.ok || !Array.isArray(gone.body?.records) || gone.body.records.length) cleanupError = 'Owned field absence could not be verified after metadata deletion.';
 }
 return {status:outcome.status,body:outcome.body,cleanupError,contextSchema:{source:'salesforce_live_custom_field_action',targetObject:target,fieldName:name,fullName,label,fieldType:'Text',fieldLength:32,upstreamActionOutcome:outcome.body,verified,verificationRecordIds:ownedId?[ownedId]:[],ownedMetadata:ownedId?[{id:ownedId,fullName}]:[],objects:[tooling.body],automaticSteps:['Discover the live action and field entity catalog','Verify unique field absence and authenticated Metadata API deletion access','Invoke the existing native custom-field action','Read back actual field metadata','Delete only the owned field through Metadata API','Verify active field absence']}};
}
