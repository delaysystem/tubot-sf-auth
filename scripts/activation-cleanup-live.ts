#!/usr/bin/env bun
/** Real scratch-account rotation proves cleanup ownership and explicit license release. */
import {run,queryRecords,queryChannelRecords,debugValue,buildPanelSessionPreflight} from './jwt-api-smoke';
import {setTimeout as sleep} from 'node:timers/promises';
const args=process.argv.slice(2),target=args[args.indexOf('--target-org')+1];
async function main(){
 if(!args.includes('--target-org')||!target)throw new Error('Use --target-org <scratch-alias>');
 const listing=await run('sf',['org','list','--json']);
 if(listing.status||!JSON.parse(listing.stdout).result.scratchOrgs.some((o:any)=>o.alias===target||o.username===target))throw new Error('Disposable scratch org required.');
 const {schema,records}=await queryChannelRecords(target),prefix=schema.objectName.startsWith('tubot__')?'tubot__':'',ns=prefix?'tubot.':'';
 if(records.length!==1)throw new Error('One activated scratch connection is required.');
 const org=(await queryRecords(target,'SELECT Id FROM Organization LIMIT 1'))[0],marker='tubot-agent-metadata:'+org.Id;
 async function apex(expression:string){const r=await run('sf',['apex','run','--target-org',target],`System.debug('CLEANUP_RESULT='+JSON.serialize(${expression}));`);const value=debugValue(r.stdout,'CLEANUP_RESULT=');if(r.status||!value)throw new Error('Cleanup controller failed.');return JSON.parse(value);}
 async function activation(){const r=await run('bun',['scripts/activation-metadata-live.ts','--target-org',target]);if(r.status)throw new Error('Activation after cleanup failed: '+(r.stdout+'\n'+r.stderr).slice(-1600));}
 async function resetAndCheck(){
  const channel=(await queryRecords(target,`SELECT Id,${prefix}Metadata_User_Id__c,${prefix}Metadata_Setup_State__c FROM ${schema.objectName} LIMIT 1`))[0];
  const userId=String(channel[prefix+'Metadata_User_Id__c']),state=JSON.parse(String(channel[prefix+'Metadata_Setup_State__c']));
  const before=await queryRecords(target,`SELECT Id FROM PermissionSetAssignment WHERE AssigneeId='${userId}'`);
  const refresh=await run('sf',['apex','run','--target-org',target],buildPanelSessionPreflight().replaceAll('PanelAuthController',ns+'PanelAuthController'));if(refresh.status)throw new Error('Panel session refresh failed.');
  const result=await apex(ns+'SimpleSetupController.resetSetupData()');
  if(!result.success||(await queryRecords(target,`SELECT Id FROM ${schema.objectName} LIMIT 1`)).length)throw new Error('Reset target verification failed.');
  let completed=false;
  for(let i=0;i<120;i++){
   const tasks=await queryRecords(target,`SELECT ${prefix}Status__c FROM ${prefix}Tubot_Activation_Task__c WHERE ${prefix}Kind__c='cleanup' AND ${prefix}User_Id__c='${userId}' ORDER BY CreatedDate DESC LIMIT 1`);
   if(tasks[0]?.[prefix+'Status__c']==='done'){completed=true;break;}
   if(i===60)await apex(ns+'SimpleSetupMetadataRevokeJob.retryPending()');await sleep(2000);
  }
  if(!completed)throw new Error('Durable cleanup did not finish.');
  const after=await queryRecords(target,`SELECT Id FROM PermissionSetAssignment WHERE AssigneeId='${userId}'`),licenses=await queryRecords(target,`SELECT Id FROM PermissionSetLicenseAssign WHERE AssigneeId='${userId}'`);
  const ids=(values:unknown[])=>new Set(values.map(id=>String(id).slice(0,15))),owned=ids(state.ownedAssignments??[]),ownedLicenses=ids(state.ownedLicenses??[]);
  if(after.some(row=>owned.has(String(row.Id).slice(0,15)))||licenses.some(row=>ownedLicenses.has(String(row.Id).slice(0,15))))throw new Error('Owned grants survived cleanup.');
  if(before.some(row=>!owned.has(String(row.Id).slice(0,15))&&!after.some(current=>String(current.Id).slice(0,15)===String(row.Id).slice(0,15))))throw new Error('Cleanup removed an unrelated grant.');
  const remote=await run('bun',['x','wrangler','d1','execute','DB','--env','production','--remote','--command',`SELECT channel_id FROM sf_agent_metadata_user WHERE org_id='${org.Id}'`,'--json']);
  if(remote.status||JSON.parse(remote.stdout)[0]?.results?.length)throw new Error('Remote metadata registration survived reset.');
  console.log(JSON.stringify({target,cleanup:'owned grants removed; unrelated grants retained; D1 registration removed'}));
  return {userId,state,after,licenses};
 }
 const initial=await resetAndCheck();
 const journals=await queryRecords(target,`SELECT ${prefix}State__c FROM ${prefix}Tubot_Activation_Task__c WHERE ${prefix}User_Id__c='${initial.userId}' AND ${prefix}Kind__c='provision'`);
 const hasCreationProof=journals.some(row=>JSON.parse(String(row[prefix+'State__c'])).userCreated===true);
 let rotated=false;
 if(!hasCreationProof){
  const denied=await apex(ns+'SimpleSetupMetadataRevokeJob.deactivateUnusedUser()');if(denied.status!=='partial')throw new Error('Unproven account was deactivated.');
  // Retire only the prior disposable TuBot service account, after proving every remaining grant belongs to its known setup.
  const user=(await queryRecords(target,`SELECT FederationIdentifier,Profile.UserLicense.Name FROM User WHERE Id='${initial.userId}'`))[0];
  if(user?.FederationIdentifier!==marker||(user.Profile as any)?.UserLicense?.Name!=='Salesforce Integration')throw new Error('Refusing to rotate a non-TuBot integration account.');
  const grants=await queryRecords(target,`SELECT Id,PermissionSet.Name FROM PermissionSetAssignment WHERE AssigneeId='${initial.userId}' AND PermissionSet.IsOwnedByProfile=false`);
  const licenses=await queryRecords(target,`SELECT Id,PermissionSetLicense.DeveloperName FROM PermissionSetLicenseAssign WHERE AssigneeId='${initial.userId}'`);
  if(grants.some(r=>!['Tubot_JWT_PreAuth','Tubot_Agent_Metadata_Access','Tubot_Agent_Prompt_Access'].includes((r.PermissionSet as any)?.Name))||licenses.some(r=>(r.PermissionSetLicense as any)?.DeveloperName!=='SalesforceAPIIntegrationPsl'))throw new Error('Unrelated access prevents disposable account rotation.');
  for(const [object,rows]of [['PermissionSetAssignment',grants],['PermissionSetLicenseAssign',licenses]] as const){for(const row of rows){const r=await run('sf',['data','delete','record','--target-org',target,'--sobject',object,'--record-id',String(row.Id),'--json']);if(r.status||(await queryRecords(target,`SELECT Id FROM ${object} WHERE Id='${row.Id}'`)).length)throw new Error('Retirement grant removal was not confirmed.');}}
  const retired=await run('sf',['data','update','record','--target-org',target,'--sobject','User','--record-id',initial.userId,'--values',`IsActive=false FederationIdentifier=retired:${org.Id}`,'--json']);
  if(retired.status||(await queryRecords(target,`SELECT IsActive FROM User WHERE Id='${initial.userId}'`))[0]?.IsActive!==false)throw new Error('Retirement was not confirmed.');
  await activation();rotated=true;
 }
 const current=(await queryRecords(target,`SELECT Id,IsActive FROM User WHERE FederationIdentifier='${marker}'`))[0];
 if(!current)throw new Error('New extraction account missing.');
 if(rotated)await resetAndCheck();
 const released=await apex(ns+'SimpleSetupMetadataRevokeJob.deactivateUnusedUser()');
 if(released.status!=='done'||(await queryRecords(target,`SELECT IsActive FROM User WHERE Id='${current.Id}'`))[0]?.IsActive!==false)throw new Error('Explicit license release was not confirmed.');
 const capacity=(await queryRecords(target,"SELECT UsedLicenses,TotalLicenses FROM UserLicense WHERE Name='Salesforce Integration'"))[0];
 if(Number(capacity.UsedLicenses)>=Number(capacity.TotalLicenses))throw new Error('User-license capacity was not released.');
 console.log(JSON.stringify({target,licenseRelease:'proven TuBot-created account deactivated; capacity independently verified'}));
 const restored=await run('sf',['data','update','record','--target-org',target,'--sobject','User','--record-id',String(current.Id),'--values','IsActive=true','--json']);
 if(restored.status||(await queryRecords(target,`SELECT IsActive FROM User WHERE Id='${current.Id}'`))[0]?.IsActive!==true)throw new Error('Explicit test-account restoration failed.');
 await activation();console.log(JSON.stringify({target,finalState:'activated with real service account; no package version created'}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
