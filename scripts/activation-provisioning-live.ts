#!/usr/bin/env bun
/** Verifies provisioning against real service users in a disposable scratch org. */
import { run,queryRecords,debugValue } from './jwt-api-smoke';
const args=process.argv.slice(2),target=args[args.indexOf('--target-org')+1];
if(!args.includes('--target-org')||!target)throw new Error('Usage: bun scripts/activation-provisioning-live.ts --target-org <scratch-alias>');
async function main(){
 const listed=await run('sf',['org','list','--json']);
 if(listed.status||!JSON.parse(listed.stdout).result.scratchOrgs.some((o:any)=>o.alias===target||o.username===target))throw new Error('A disposable scratch org is required.');
 const org=(await queryRecords(target,'SELECT Id,NamespacePrefix FROM Organization LIMIT 1'))[0];
 const ns=org.NamespacePrefix?org.NamespacePrefix+'.':'';
 const primary=(await queryRecords(target,"SELECT Id FROM User WHERE IsActive=true AND Profile.UserLicense.Name='Analytics Cloud Integration User' ORDER BY Name LIMIT 1"))[0];
 if(!primary)throw new Error('A real Analytics integration user is required.');
 async function apex(source:string){
  const result=await run('sf',['apex','run','--target-org',target],source);
  const value=debugValue(result.stdout,'PROVISION_RESULT=');
  if(result.status||!value)throw new Error('Live Apex provisioning call failed.');
  return JSON.parse(value);
 }
 const invoke=`System.debug('PROVISION_RESULT='+JSON.serialize(${ns}SimpleSetupMetadataPermissions.provision('${primary.Id}')));`;
 const first=await apex(invoke),second=await apex(invoke);
 if(first.status!=='done'||second.status!=='done'||first.userId!==second.userId||second.ownedAssignments.length||second.ownedLicenses.length)throw new Error('Repeated provisioning created additional resources.');
 const userId=first.userId;
 const users=await queryRecords(target,`SELECT Id,IsActive,Profile.UserLicense.Name FROM User WHERE FederationIdentifier='tubot-agent-metadata:${org.Id}'`);
 if(users.length!==1||users[0].Id!==userId||(users[0].Profile as any)?.UserLicense?.Name!=='Salesforce Integration')throw new Error('Dedicated identity/license verification failed.');
 const grants=await queryRecords(target,`SELECT Id FROM PermissionSetAssignment WHERE AssigneeId='${userId}' AND PermissionSet.PermissionsModifyMetadata=true`);
 if(!grants.length)throw new Error('Metadata grant missing.');
 const reused=await apex(`${ns}SimpleSetupEcaStep.prepare(UserInfo.getUserId());System.debug('PROVISION_RESULT='+JSON.serialize(${ns}SimpleSetupMetadataPermissions.provision(UserInfo.getUserId())));`);
 const admin=await run('sf',['org','display','user','--target-org',target,'--json']);
 if(admin.status||reused.userId!==JSON.parse(admin.stdout).result.id)throw new Error('Compatible selected user was not reused.');
 async function active(value:boolean){
  const changed=await run('sf',['data','update','record','--target-org',target,'--sobject','User','--record-id',userId,'--values',`IsActive=${value}`,'--json']);
  if(changed.status)throw new Error('Scratch service-user lifecycle update failed.');
  if((await queryRecords(target,`SELECT IsActive FROM User WHERE Id='${userId}' LIMIT 1`))[0]?.IsActive!==value)throw new Error('Independent active-state verification failed.');
 }
 try{
  await active(false);
  const partial=await apex(`try{${ns}SimpleSetupMetadataPermissions.provision('${primary.Id}');System.debug('PROVISION_RESULT={"status":"unexpected"}');}catch(Exception denied){System.debug('PROVISION_RESULT='+JSON.serialize(${ns}SimpleSetupMetadataService.partial(denied.getMessage())));}`);
  if(partial.status!=='partial'||!/inactive/.test(partial.message))throw new Error('Unavailable account did not fail explicitly.');
 }finally{await active(true);}
 console.log(JSON.stringify({target,dedicatedUser:'verified',repeatProvisioning:'no duplicates',compatibleUser:'reused',inactiveAccount:'explicit partial result; restored'}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
