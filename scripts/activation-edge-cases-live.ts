#!/usr/bin/env bun
/** Exercises real failure/recovery paths in a disposable scratch org. No mocks or customer fixtures. */
import {run,queryRecords,queryChannelRecords,debugValue} from './jwt-api-smoke';
import {setTimeout as sleep} from 'node:timers/promises';
const args=process.argv.slice(2),target=args[args.indexOf('--target-org')+1];
async function main(){
 if(!args.includes('--target-org')||!target)throw new Error('Use --target-org <scratch-alias>');
 const listing=await run('sf',['org','list','--json']);
 if(listing.status||!JSON.parse(listing.stdout).result.scratchOrgs.some((o:any)=>o.alias===target||o.username===target))throw new Error('Disposable scratch org required.');
 const {schema,records}=await queryChannelRecords(target);
 if(records.length!==1)throw new Error('One activated channel is required.');
 const prefix=schema.objectName.startsWith('tubot__')?'tubot__':'',ns=prefix?'tubot.':'';
 const channel=records[0][schema.channelIdField],input=`new Map<String,Object>{'channel'=>new Map<String,Object>{'id'=>'${channel}'}}`;
 async function apex(source:string){
  const result=await run('sf',['apex','run','--target-org',target],source);
  const text=debugValue(result.stdout,'EDGE_RESULT=');
  if(result.status||!text)throw new Error('Live Apex operation failed.');return JSON.parse(text);
 }
 const call=(method:string)=>apex(`System.debug('EDGE_RESULT='+JSON.serialize(${ns}SimpleSetupMetadataService.${method}(${input})));`);
 async function settle(){
  for(let i=0;i<120;i++){const r=await call('progress');if(r.status!=='pending')return r;await sleep(2000);}throw new Error('Provisioning did not settle.');
 }
 const row=(await queryRecords(target,`SELECT Id,${prefix}Metadata_User_Id__c FROM ${schema.objectName} LIMIT 1`))[0],userId=String(row[prefix+'Metadata_User_Id__c']);
 const set=(await queryRecords(target,"SELECT Id FROM PermissionSet WHERE Name='Tubot_Agent_Metadata_Access' LIMIT 1"))[0];
 if(!set||!userId)throw new Error('Metadata access must already exist.');
 const current=await settle();if(current.status!=='done')throw new Error('Existing provisioning is not ready.');
 const aborted=await apex(`Map<String,Object> first=${ns}SimpleSetupMetadataService.prepare(${input});Map<String,Object> repeat=${ns}SimpleSetupMetadataService.prepare(${input});if((Id)String.valueOf(first.get('jobId'))!=(Id)String.valueOf(repeat.get('jobId')))throw new IllegalArgumentException('Duplicate provisioning job');System.abortJob((Id)String.valueOf(first.get('jobId')));System.debug('EDGE_RESULT='+JSON.serialize(first));`);
 const job=(await queryRecords(target,`SELECT Status FROM AsyncApexJob WHERE Id='${aborted.jobId}'`))[0];
 if(job?.Status!=='Aborted'||(await call('progress')).status!=='partial')throw new Error('Aborted job did not become recoverable.');
 await call('prepare');if((await settle()).status!=='done')throw new Error('Retry after abort failed.');
 console.log(JSON.stringify({target,abortedJob:'independently verified; retry succeeded',repeatPrepare:'one job'}));
 const grants=await queryRecords(target,`SELECT Id FROM PermissionSetAssignment WHERE AssigneeId='${userId}' AND PermissionSetId='${set.Id}'`);
 if(grants.length!==1)throw new Error('One live metadata assignment required.');
 const deleted=await run('sf',['data','delete','record','--target-org',target,'--sobject','PermissionSetAssignment','--record-id',String(grants[0].Id),'--json']);
 if(deleted.status||(await queryRecords(target,`SELECT Id FROM PermissionSetAssignment WHERE Id='${grants[0].Id}'`)).length)throw new Error('Independent revocation verification failed.');
 try{
  if((await call('verify')).status!=='partial')throw new Error('Revoked permissions were not detected.');
 }finally{await call('prepare');if((await settle()).status!=='done')throw new Error('Explicit permission repair failed.');}
 const restored=await queryRecords(target,`SELECT Id FROM PermissionSetAssignment WHERE AssigneeId='${userId}' AND PermissionSetId='${set.Id}'`);
 const taskQuery=`SELECT ${prefix}Status__c,${prefix}State__c FROM ${prefix}Tubot_Activation_Task__c WHERE ${prefix}Key__c='provision:${row.Id}' LIMIT 1`;
 const owned=JSON.parse(String((await queryRecords(target,taskQuery))[0][prefix+'State__c']));
 if(!owned.ownedAssignments.some((id:string)=>id.slice(0,15)===String(restored[0]?.Id).slice(0,15)))throw new Error('Restored grant ownership was not journaled.');
 async function permission(value:boolean){
  const result=await run('sf',['data','update','record','--target-org',target,'--sobject','PermissionSet','--record-id',String(set.Id),'--values',`PermissionsModifyMetadata=${value}`,'--json']);
  if(result.status||(await queryRecords(target,`SELECT PermissionsModifyMetadata FROM PermissionSet WHERE Id='${set.Id}'`))[0]?.PermissionsModifyMetadata!==value)throw new Error('Permission mutation verification failed.');
 }
 try{
  await permission(false);await call('prepare');const failure=await settle();if(failure.status!=='partial')throw new Error('Permission denial did not produce partial activation.');
  const journal=JSON.parse(String((await queryRecords(target,taskQuery))[0][prefix+'State__c']));
  if(!journal.ownedAssignments.some((id:string)=>id.slice(0,15)===String(restored[0].Id).slice(0,15)))throw new Error('Failure discarded owned grants.');
 }finally{await permission(true);await call('prepare');if((await settle()).status!=='done')throw new Error('Permission recovery failed.');}
 console.log(JSON.stringify({target,revokedPermissions:'detected; explicitly repaired',failedAttemptOwnership:'preserved in Salesforce journal'}));
 const org=(await queryRecords(target,'SELECT Id FROM Organization LIMIT 1'))[0];
 const capacity=(await queryRecords(target,"SELECT TotalLicenses,UsedLicenses FROM UserLicense WHERE Name='Salesforce Integration' LIMIT 1"))[0];
 if(capacity&&Number(capacity.UsedLicenses)>=Number(capacity.TotalLicenses)){
  const before=await queryRecords(target,"SELECT Id FROM User WHERE Profile.UserLicense.Name='Salesforce Integration'");
  const marker='tubot-agent-metadata:'+org.Id;
  async function identify(value:string){const r=await run('sf',['data','update','record','--target-org',target,'--sobject','User','--record-id',userId,'--values',`FederationIdentifier=${value}`,'--json']);if(r.status||(await queryRecords(target,`SELECT FederationIdentifier FROM User WHERE Id='${userId}'`))[0]?.FederationIdentifier!==value)throw new Error('Identity mutation verification failed.');}
  try{
   await identify('unlinked-'+marker);await call('prepare');const rejected=await settle();
   if(rejected.status!=='partial'||!/unused Salesforce Integration user license/.test(rejected.message))throw new Error('User-license exhaustion was not explained.');
   if((await queryRecords(target,"SELECT Id FROM User WHERE Profile.UserLicense.Name='Salesforce Integration'")).length!==before.length)throw new Error('License shortage left an extra user.');
  }finally{await identify(marker);await call('prepare');if((await settle()).status!=='done')throw new Error('License-shortage recovery failed.');}
  console.log(JSON.stringify({target,userLicenseExhaustion:'precise partial result; no extra user; recovery verified'}));
 }
 const login=(await queryRecords(target,`SELECT Id,IsFrozen FROM UserLogin WHERE UserId='${userId}' LIMIT 1`))[0];
 if(login&&!login.IsFrozen){
  async function freeze(value:boolean){const r=await run('sf',['data','update','record','--target-org',target,'--sobject','UserLogin','--record-id',String(login.Id),'--values',`IsFrozen=${value}`,'--json']);if(r.status||(await queryRecords(target,`SELECT IsFrozen FROM UserLogin WHERE Id='${login.Id}'`))[0]?.IsFrozen!==value)throw new Error('Freeze mutation verification failed.');}
  try{await freeze(true);const result=await call('verify');if(result.status!=='partial'||!/frozen/.test(result.message))throw new Error('Frozen login was not detected.');}finally{await freeze(false);}
  console.log(JSON.stringify({target,frozenAccount:'detected; restored and independently verified'}));
 }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
