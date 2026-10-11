#!/usr/bin/env bun
/** Interrupts an actual result writer, then proves journal-based recovery without regranting. */
import {run,queryRecords,queryChannelRecords,debugValue} from './jwt-api-smoke';
import {setTimeout as sleep} from 'node:timers/promises';
const args=process.argv.slice(2),target=args[args.indexOf('--target-org')+1];
async function main(){
 if(!args.includes('--target-org')||!target)throw new Error('Use --target-org <scratch-alias>');
 const listing=await run('sf',['org','list','--json']);if(listing.status||!JSON.parse(listing.stdout).result.scratchOrgs.some((o:any)=>o.alias===target||o.username===target))throw new Error('Disposable scratch org required.');
 const {schema,records}=await queryChannelRecords(target);if(records.length!==1)throw new Error('One active channel required.');
 const prefix=schema.objectName.startsWith('tubot__')?'tubot__':'',ns=prefix?'tubot.':'',channel=records[0][schema.channelIdField];
 const row=(await queryRecords(target,`SELECT Id,${prefix}Metadata_User_Id__c FROM ${schema.objectName} LIMIT 1`))[0],userId=String(row[prefix+'Metadata_User_Id__c']);
 const input=`new Map<String,Object>{'channel'=>new Map<String,Object>{'id'=>'${channel}'}}`;
 async function apex(source:string){const result=await run('sf',['apex','run','--target-org',target],source);const text=debugValue(result.stdout,'WRITER_RESULT=');if(result.status||!text)throw new Error('Writer recovery Apex call failed.');return JSON.parse(text);}
 const call=(method:string)=>apex(`System.debug('WRITER_RESULT='+JSON.serialize(${ns}SimpleSetupMetadataService.${method}(${input})));`);
 const before=(await queryRecords(target,`SELECT Id FROM PermissionSetAssignment WHERE AssigneeId='${userId}'`)).map(r=>String(r.Id)).sort();
 // Capture the CLI session only in memory; the shared runner never logs stdout.
 const displayed=await run('env',['SF_TEMP_SHOW_SECRETS=true','sf','org','display','--target-org',target,'--json']);
 if(displayed.status)throw new Error('Scratch session unavailable.');
 const session=JSON.parse(displayed.stdout).result;
 const versions=await fetch(session.instanceUrl+'/services/data/',{headers:{Authorization:'Bearer '+session.accessToken}});
 if(!versions.ok)throw new Error('Live API discovery failed.');
 const advertised=await versions.json() as Array<{version:string}>,version=advertised.at(-1)!.version;
 let captured:any;
 for(let attempt=0;attempt<5&&!captured;attempt++){
  await call('prepare');
  for(let i=0;i<180;i++){
   const query=`SELECT ${prefix}Status__c,${prefix}Writer_Job_Id__c FROM ${prefix}Tubot_Activation_Task__c WHERE ${prefix}Key__c='provision:${row.Id}' LIMIT 1`;
   const response=await fetch(session.instanceUrl+'/services/data/v'+version+'/query?q='+encodeURIComponent(query),{headers:{Authorization:'Bearer '+session.accessToken},signal:AbortSignal.timeout(30000)});
   if(!response.ok)throw new Error('Live queue query failed.');
   const result=(await response.json() as {records:Array<Record<string,string>>}).records[0];
   if(result[prefix+'Status__c']==='published')break;
   const writer=result[prefix+'Writer_Job_Id__c'];
   if(result[prefix+'Status__c']==='recorded'&&writer){
    if(!/^[A-Za-z0-9]{15,18}$/.test(writer))throw new Error('Invalid live job identity.');
    const source=`System.abortJob('${writer}');`;
    const abort=await fetch(session.instanceUrl+'/services/data/v'+version+'/tooling/executeAnonymous/?anonymousBody='+encodeURIComponent(source),{headers:{Authorization:'Bearer '+session.accessToken},signal:AbortSignal.timeout(30000)});
    if(!abort.ok)throw new Error('Live queue interruption request failed.');
    if((await abort.json() as {success:boolean}).success){captured={writer};break;}
   }
   await sleep(1000);
  }
 }
 if(!captured)throw new Error('Could not capture a queued writer.');
 const aborted=(await queryRecords(target,`SELECT Status FROM AsyncApexJob WHERE Id='${captured.writer}'`))[0];if(aborted?.Status!=='Aborted')throw new Error('Writer abort was not independently verified.');
 let status=await call('progress');for(let i=0;status.status==='pending'&&i<120;i++){await sleep(2000);status=await call('progress');}
 if(status.status!=='done')throw new Error('Journal-based publishing did not recover.');
 const after=(await queryRecords(target,`SELECT Id FROM PermissionSetAssignment WHERE AssigneeId='${userId}'`)).map(r=>String(r.Id)).sort();
 if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Writer recovery changed permission grants.');
 console.log(JSON.stringify({target,resultWriter:'actual queued job aborted; durable journal republished',permissionAssignments:'unchanged'}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
