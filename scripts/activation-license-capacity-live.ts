#!/usr/bin/env bun
/** Proves PSL exhaustion using the real inactive extraction account, without artificial license holders. */
import {run,queryRecords,queryChannelRecords,debugValue} from './jwt-api-smoke';
import {setTimeout as sleep} from 'node:timers/promises';
const args=process.argv.slice(2),target=args[args.indexOf('--target-org')+1];
async function main(){
 if(!args.includes('--target-org')||!target)throw new Error('Use --target-org <scratch-alias>');
 const listing=await run('sf',['org','list','--json']);if(listing.status||!JSON.parse(listing.stdout).result.scratchOrgs.some((o:any)=>o.alias===target||o.username===target))throw new Error('Disposable scratch org required.');
 const {schema,records}=await queryChannelRecords(target);if(records.length!==1)throw new Error('One active connection required.');
 const prefix=schema.objectName.startsWith('tubot__')?'tubot__':'',ns=prefix?'tubot.':'',input=`new Map<String,Object>{'channel'=>new Map<String,Object>{'id'=>'${records[0][schema.channelIdField]}'}}`;
 const user=(await queryRecords(target,`SELECT Id,IsActive,FederationIdentifier FROM User WHERE FederationIdentifier LIKE 'tubot-agent-metadata:%' AND Profile.UserLicense.Name='Salesforce Integration' LIMIT 2`));
 if(user.length!==1||user[0].IsActive!==true||!String(user[0].FederationIdentifier).startsWith('tubot-agent-metadata:'))throw new Error('One real TuBot extraction account required.');
 const userId=String(user[0].Id),marker=String(user[0].FederationIdentifier);
 const licenses=(await queryRecords(target,"SELECT TotalLicenses,UsedLicenses FROM PermissionSetLicense WHERE DeveloperName='SalesforceAPIIntegrationPsl'"))[0];
 if(Number(licenses.UsedLicenses)<Number(licenses.TotalLicenses))throw new Error('This scratch org has spare PSL capacity; refusing to consume extra licenses for a test.');
 const before=(await queryRecords(target,"SELECT Id FROM User WHERE Profile.UserLicense.Name='Salesforce Integration'")).length;
 async function update(active:boolean,identifier:string){const r=await run('sf',['data','update','record','--target-org',target,'--sobject','User','--record-id',userId,'--values',`IsActive=${active} FederationIdentifier=${identifier}`,'--json']);const actual=(await queryRecords(target,`SELECT IsActive,FederationIdentifier FROM User WHERE Id='${userId}'`))[0];if(r.status||actual?.IsActive!==active||actual.FederationIdentifier!==identifier)throw new Error('Account mutation was not independently verified.');}
 async function call(method:string){const r=await run('sf',['apex','run','--target-org',target],`System.debug('CAPACITY_RESULT='+JSON.serialize(${ns}SimpleSetupMetadataService.${method}(${input})));`);const text=debugValue(r.stdout,'CAPACITY_RESULT=');if(r.status||!text)throw new Error('Live capacity controller failed.');return JSON.parse(text);}
 async function settle(){for(let i=0;i<120;i++){const r=await call('progress');if(r.status!=='pending')return r;await sleep(2000);}throw new Error('Provisioning did not settle.');}
 let capacityScenario='verified';
 try{
  await update(false,'unlinked-'+marker);
  const freeUser=(await queryRecords(target,"SELECT TotalLicenses,UsedLicenses FROM UserLicense WHERE Name='Salesforce Integration'"))[0];
  if(Number(freeUser.UsedLicenses)>=Number(freeUser.TotalLicenses))throw new Error('User capacity was not freed.');
  const psl=(await queryRecords(target,"SELECT TotalLicenses,UsedLicenses FROM PermissionSetLicense WHERE DeveloperName='SalesforceAPIIntegrationPsl' AND MaximumPermissionsModifyMetadata=true"))[0];
  if(Number(psl.UsedLicenses)<Number(psl.TotalLicenses)){
   capacityScenario='unavailable: Salesforce released the sole user\'s permission-set license when the account was deactivated';
  }else{
   await call('prepare');const rejected=await settle();
   console.log(JSON.stringify({target,exhaustedResult:rejected}));
   if(rejected.status!=='partial'||!/permission-set license/i.test(rejected.message))throw new Error('Permission-set-license exhaustion was not explained.');
   if((await queryRecords(target,"SELECT Id FROM User WHERE Profile.UserLicense.Name='Salesforce Integration'")).length!==before)throw new Error('PSL shortage created an extra user.');
  }
 }finally{await update(true,marker);await call('prepare');if((await settle()).status!=='done')throw new Error('Account restoration failed.');}
 console.log(JSON.stringify({target,permissionSetLicenseExhaustion:capacityScenario,accountRestored:true}));
 const activation=await run('bun',['scripts/activation-metadata-live.ts','--target-org',target]);if(activation.status)throw new Error('Final activation failed: '+activation.stderr.slice(-1000));
 console.log(JSON.stringify({target,finalState:'SOQL and metadata retrieval verified after restoration'}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
