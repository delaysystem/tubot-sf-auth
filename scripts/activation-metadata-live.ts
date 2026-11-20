#!/usr/bin/env bun
/** Executes the real Activation controller; --reset explicitly starts the org over. */
import { run, queryRecords, queryChannelRecords, buildPanelSessionPreflight, debugValue } from "./jwt-api-smoke";
import { setTimeout as sleep } from "node:timers/promises";
const argv=process.argv.slice(2), target=argv[argv.indexOf("--target-org")+1];
if (!argv.includes("--target-org") || !target) throw new Error("Usage: bun scripts/activation-metadata-live.ts --target-org <alias> [--reset]");
let stage="discovery";
async function main() {
  const {schema,records}=await queryChannelRecords(target);
  if (records.length>1 || (!records.length && argv.includes("--reset"))) throw new Error("Expected one channel to reset, or an empty org for fresh activation.");
  const ns=schema.objectName.startsWith("tubot__")?"tubot.":"";
  const field=(name:string)=>schema.objectName.startsWith("tubot__")?"tubot__"+name:name;
  const primary=records.length?records[0][schema.integrationUserIdField]:(await queryRecords(target,"SELECT Id FROM User WHERE IsActive=true AND Profile.UserLicense.Name='Analytics Cloud Integration User' ORDER BY Name LIMIT 1"))[0]?.Id;
  if(typeof primary!=="string")throw new Error("An existing Analytics integration user is required for this dedicated-user verification scenario.");
  const channelId=records[0]?.[schema.channelIdField];
  const state:Record<string,unknown>={user:{id:primary},...(channelId?{channel:{id:channelId}}:{})};
  async function apex(expression:string) {
    const executed=await run("sf",["apex","run","--target-org",target],`System.debug('ACTIVATION_RESULT='+JSON.serialize(${expression}));`);
    const value=debugValue(executed.stdout,"ACTIVATION_RESULT=");
    if(executed.status || !value) throw new Error(`Controller call failed during ${stage}: Salesforce execution did not return a successful result`);
    return JSON.parse(value);
  }
  const preflight=await run("sf",["apex","run","--target-org",target],buildPanelSessionPreflight().replaceAll("PanelAuthController",ns+"PanelAuthController"));
  if(preflight.status) throw new Error("Panel preflight failed.");
  if(argv.includes("--reset")) {
    stage="reset";
    const result=await apex(ns+"SimpleSetupController.resetSetupData()");
    if(result.success!==true) throw new Error("Reset failed.");
    if((await queryRecords(target,`SELECT Id FROM ${schema.objectName} LIMIT 1`)).length) throw new Error("Reset left channel records.");
    console.log(JSON.stringify({target,reset:"independently verified"}));
  }
  for(const step of ["user","channel","eca","finalize","finalize-register","metadata-prepare","metadata-register","metadata-verify"]) {
    stage=step;
    const encoded=Buffer.from(JSON.stringify(state)).toString("base64");
    const input=`(Map<String,Object>)JSON.deserializeUntyped(EncodingUtil.base64Decode('${encoded}').toString())`;
    let result=await apex(`${ns}SimpleSetupController.runStep('${step}',${input})`);
    for(let poll=0;result.status==="pending"&&poll<180;poll++) {
      await sleep(2000);
      result=await apex(`${ns}SimpleSetupController.runStep('${step==="metadata-prepare"?"metadata-status":step}',${input})`);
    }
    if(step==="eca"&&result.status==="popup-required") {
      result=await apex(`${ns}SimpleSetupController.checkEcaAuthorization('${primary}')`);
    }
    if(result.status!=="done") throw new Error(JSON.stringify(result));
    if(result.user)state.user=result.user;
    if(result.channel)state.channel=result.channel;
    console.log(JSON.stringify({target,step,status:result.status}));
  }
  stage="final verification";
  const verified=await apex(ns+"SimpleSetupController.verifySetup()");
  if(verified.verified!==true||verified.soqlReady!==true||verified.agentExtractionReady!==true)throw new Error(JSON.stringify(verified));
  const rows=await queryRecords(target,`SELECT ${schema.channelIdField},${field("Metadata_User_Id__c")},${field("Metadata_Setup_State__c")},${schema.integrationUserIdField} FROM ${schema.objectName} LIMIT 1`);
  if(rows[0]?.[schema.integrationUserIdField]!==primary || typeof rows[0]?.[field("Metadata_User_Id__c")]!=="string")throw new Error("Persisted identity verification failed.");
  const userId=rows[0][field("Metadata_User_Id__c")];
  const user=(await queryRecords(target,`SELECT IsActive,Profile.UserLicense.Name FROM User WHERE Id='${userId}' LIMIT 1`))[0];
  if(user?.IsActive!==true)throw new Error("Extraction user unavailable.");
  const org=(await queryRecords(target,"SELECT Id FROM Organization LIMIT 1"))[0];
  const remote=await run("bun",["x","wrangler","d1","execute","DB","--env","production","--remote","--command",`SELECT integration_user_id,json_extract(verification_json,'$.verifiedAt') AS verified_at FROM sf_agent_metadata_user WHERE org_id='${org.Id}' AND channel_id='${rows[0][schema.channelIdField]}'`,"--json"]);
  const registered=JSON.parse(remote.stdout)[0]?.results?.[0];
  if(remote.status||registered?.integration_user_id!==userId||!registered.verified_at)throw new Error(`Independent D1 identity/retrieval verification failed (exit=${remote.status}, registered=${!!registered}, identityMatches=${registered?.integration_user_id===userId}, retrievalVerified=${!!registered?.verified_at}).`);
  console.log(JSON.stringify({target,soqlReady:true,agentExtractionReady:true,license:(user.Profile as any)?.UserLicense?.Name,remoteRegistration:"verified"}));
}
main().catch(error=>{console.error(`Activation verification failed during ${stage}: ${error.message}`);process.exitCode=1;});
