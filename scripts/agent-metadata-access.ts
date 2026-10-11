#!/usr/bin/env bun
/** Explicit administrator provisioning; no passwords or CLI tokens leave Salesforce. */
import { run, queryRecords, queryChannelRecords, parseCliJson, buildPanelSessionPreflight, debugValue } from "./jwt-api-smoke";
const args = process.argv.slice(2);
const target = args[args.indexOf("--target-org") + 1];
const environment = args.includes("--env") ? args[args.indexOf("--env") + 1] : "production";
if (!args.includes("--target-org") || !target || target.startsWith("-") || !["production", "staging"].includes(environment)) throw new Error("Usage: bun scripts/agent-metadata-access.ts --target-org <alias> [--apply] [--create-metadata-user] [--env production|staging]");
const apply = args.includes("--apply"), dedicated = args.includes("--create-metadata-user");
const name = "Tubot_Agent_Metadata_Access";
let stage = "channel discovery";
const quoted = (value: unknown) => `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const values = (record: Record<string, unknown>) => Object.entries(record).map(([key, value]) => `${key}=${quoted(value)}`).join(" ");
async function mutation(argv: string[]) {
  const response = await run("sf", [...argv, "--target-org", target, "--json"]);
  const result = parseCliJson(response.stdout);
  if (response.status || result.status !== 0) throw new Error(`Salesforce rejected ${stage} (${typeof result.name === "string" ? result.name : "unknown_error"}).`);
}
async function assign(user: string, permissionSetId: string) {
  const existing = await queryRecords(target, `SELECT Id FROM PermissionSetAssignment WHERE AssigneeId='${user}' AND PermissionSetId='${permissionSetId}' LIMIT 1`);
  if (!existing.length) await mutation(["data", "create", "record", "--sobject", "PermissionSetAssignment", "--values", values({ AssigneeId: user, PermissionSetId: permissionSetId })]);
  if ((await queryRecords(target, `SELECT Id FROM PermissionSetAssignment WHERE AssigneeId='${user}' AND PermissionSetId='${permissionSetId}' LIMIT 1`)).length !== 1) throw new Error("Permission assignment independent verification failed.");
}
async function main() {
  const { schema, records } = await queryChannelRecords(target);
  if (!records.length) throw new Error("No registered channels found.");
  const primaryUsers = [...new Set(records.map(row => row[schema.integrationUserIdField]))];
  if (primaryUsers.some(id => typeof id !== "string" || !/^[A-Za-z0-9]{15,18}$/.test(id))) throw new Error("Invalid registered integration user.");
  console.log(`Metadata access ${apply ? "apply" : "plan"}: ${dedicated ? "dedicated API-only user" : "existing registered users"}. Salesforce requires Modify Metadata, View Setup and View Roles; this also permits metadata writes.`);
  if (!apply) return;
  const org = (await queryRecords(target, "SELECT Id FROM Organization LIMIT 1"))[0];
  if (typeof org?.Id !== "string") throw new Error("Organization identity unavailable.");
  let users = primaryUsers as string[];
  if (dedicated) {
    stage = "API-only license discovery";
    const profiles = await queryRecords(target, "SELECT Id,Name FROM Profile WHERE UserLicense.Name='Salesforce Integration' AND PermissionsApiEnabled=true AND PermissionsModifyAllData=false");
    const profile = profiles.find(p => p.Name === "Minimum Access - API Only Integrations") ?? (profiles.length === 1 ? profiles[0] : undefined);
    const license = (await queryRecords(target, "SELECT Id,TotalLicenses,UsedLicenses FROM PermissionSetLicense WHERE DeveloperName='SalesforceAPIIntegrationPsl' AND MaximumPermissionsModifyMetadata=true LIMIT 1"))[0];
    if (!profile || !license) throw new Error("Compatible API-only profile and metadata-capable API Integration license required.");
    const marker = `tubot-agent-metadata:${org.Id}`;
    let user = (await queryRecords(target, `SELECT Id,Username,IsActive,Profile.UserLicense.Name FROM User WHERE FederationIdentifier='${marker}' LIMIT 1`))[0];
    if (!user) {
      const capacity = (await queryRecords(target, "SELECT TotalLicenses,UsedLicenses FROM UserLicense WHERE Name='Salesforce Integration' LIMIT 1"))[0];
      if (!capacity || Number(capacity.UsedLicenses) >= Number(capacity.TotalLicenses) || Number(license.UsedLicenses) >= Number(license.TotalLicenses)) throw new Error("Unused Integration and API Integration licenses are required.");
      const displayed = await run("sf", ["org", "display", "--target-org", target, "--json"]);
      if (displayed.status) throw new Error("Admin identity unavailable.");
      const username = (parseCliJson(displayed.stdout).result as Record<string, unknown>)?.username;
      if (typeof username !== "string") throw new Error("Admin username unavailable.");
      const admin = (await queryRecords(target, `SELECT Email,TimeZoneSidKey,LocaleSidKey,LanguageLocaleKey,EmailEncodingKey FROM User WHERE Username=${quoted(username)} LIMIT 1`))[0];
      if (!admin?.Email) throw new Error("Administrator contact and locale unavailable.");
      stage = "dedicated API-only user creation";
      await mutation(["data", "create", "record", "--sobject", "User", "--values", values({
        Username: `metadata.${org.Id}.${crypto.randomUUID().slice(0, 8)}@integration.invalid`, Email: admin.Email,
        LastName: "TuBot Agent Metadata", Alias: "tbmeta", ProfileId: profile.Id, FederationIdentifier: marker,
        TimeZoneSidKey: admin.TimeZoneSidKey, LocaleSidKey: admin.LocaleSidKey,
        LanguageLocaleKey: admin.LanguageLocaleKey, EmailEncodingKey: admin.EmailEncodingKey, IsActive: true,
      })]);
      user = (await queryRecords(target, `SELECT Id,Username,IsActive,Profile.UserLicense.Name FROM User WHERE FederationIdentifier='${marker}' LIMIT 1`))[0];
    }
    const userProfile = user?.Profile as { UserLicense?: { Name?: string } } | undefined;
    if (!user || typeof user.Id !== "string" || typeof user.Username !== "string" || user.IsActive !== true || userProfile?.UserLicense?.Name !== "Salesforce Integration") throw new Error("Dedicated API-only user could not be independently verified.");
    users = [user.Id];
    stage = "API Integration permission-set license assignment";
    if (!(await queryRecords(target, `SELECT Id FROM PermissionSetLicenseAssign WHERE AssigneeId='${user.Id}' AND PermissionSetLicenseId='${license.Id}' LIMIT 1`)).length) {
      await mutation(["data", "create", "record", "--sobject", "PermissionSetLicenseAssign", "--values", values({ AssigneeId: user.Id, PermissionSetLicenseId: license.Id })]);
    }
    if ((await queryRecords(target, `SELECT Id FROM PermissionSetLicenseAssign WHERE AssigneeId='${user.Id}' AND PermissionSetLicenseId='${license.Id}' LIMIT 1`)).length !== 1) throw new Error("API Integration license assignment independent verification failed.");
    stage = "JWT preauthorization assignment";
    const grants = await queryRecords(target, `SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId='${primaryUsers[0]}' AND PermissionSet.Name='Tubot_JWT_PreAuth'`);
    if (grants.length !== 1 || typeof grants[0].PermissionSetId !== "string") throw new Error("Registered primary user's JWT preauthorization set could not be resolved uniquely.");
    await assign(user.Id, grants[0].PermissionSetId);
  } else {
    for (const user of users) {
      const row = (await queryRecords(target, `SELECT Profile.UserLicense.Name FROM User WHERE Id='${user}' LIMIT 1`))[0];
      const profile = row?.Profile as { UserLicense?: { Name?: string } } | undefined;
      if (profile?.UserLicense?.Name === "Analytics Cloud Integration User") throw new Error("System Analytics users cannot use Metadata API or change licenses. Use --create-metadata-user to provision a dedicated API-only user.");
    }
  }
  stage = "metadata permission-set provisioning";
  let permission = (await queryRecords(target, `SELECT Id,PermissionsModifyMetadata,PermissionsViewSetup,PermissionsViewRoles FROM PermissionSet WHERE Name='${name}' AND IsOwnedByProfile=false LIMIT 1`))[0];
  if (!permission) {
    await mutation(["data", "create", "record", "--sobject", "PermissionSet", "--values", values({ Name: name, Label: "TuBot Agent Metadata Access", Description: "Required for agent metadata extraction. Salesforce also permits metadata writes with this permission.", PermissionsModifyMetadata: true, PermissionsViewSetup: true, PermissionsViewRoles: true })]);
    permission = (await queryRecords(target, `SELECT Id,PermissionsModifyMetadata,PermissionsViewSetup,PermissionsViewRoles FROM PermissionSet WHERE Name='${name}' AND IsOwnedByProfile=false LIMIT 1`))[0];
  } else if (permission.PermissionsModifyMetadata !== true || permission.PermissionsViewSetup !== true || permission.PermissionsViewRoles !== true) {
    await mutation(["data", "update", "record", "--sobject", "PermissionSet", "--record-id", String(permission.Id), "--values", values({ PermissionsModifyMetadata: true, PermissionsViewSetup: true, PermissionsViewRoles: true })]);
  }
  if (!permission || typeof permission.Id !== "string") throw new Error("Metadata permission set creation could not be verified.");
  // Prompt-template definitions have their own object/license gate even
  // when they are returned as a dependency of a planner retrieval.
  stage = "prompt-template read access";
  const promptLicense = (await queryRecords(target, "SELECT Id,TotalLicenses,UsedLicenses FROM PermissionSetLicense WHERE DeveloperName='EinsteinGPTPromptTemplatesPsl' LIMIT 1"))[0];
  if (promptLicense) {
    for (const user of users) {
      const assigned = await queryRecords(target, `SELECT Id FROM PermissionSetLicenseAssign WHERE AssigneeId='${user}' AND PermissionSetLicenseId='${promptLicense.Id}' LIMIT 1`);
      if (!assigned.length) {
        const capacity = (await queryRecords(target, `SELECT TotalLicenses,UsedLicenses FROM PermissionSetLicense WHERE Id='${promptLicense.Id}' LIMIT 1`))[0];
        if (Number(capacity.UsedLicenses) >= Number(capacity.TotalLicenses)) throw new Error("No unused Einstein Prompt Templates license available.");
        await mutation(["data", "create", "record", "--sobject", "PermissionSetLicenseAssign", "--values", values({ AssigneeId: user, PermissionSetLicenseId: promptLicense.Id })]);
      }
      if ((await queryRecords(target, `SELECT Id FROM PermissionSetLicenseAssign WHERE AssigneeId='${user}' AND PermissionSetLicenseId='${promptLicense.Id}' LIMIT 1`)).length !== 1) throw new Error("Prompt-template license verification failed.");
    }
    await mutation(["data", "update", "record", "--sobject", "PermissionSet", "--record-id", permission.Id, "--values", values({ PermissionsManagePromptTemplates: true })]);
    const promptGrant = (await queryRecords(target, `SELECT PermissionsManagePromptTemplates FROM PermissionSet WHERE Id='${permission.Id}' LIMIT 1`))[0];
    if (promptGrant?.PermissionsManagePromptTemplates !== true) throw new Error("Prompt-template metadata permission verification failed.");
    let readAccess = (await queryRecords(target, `SELECT Id,PermissionsRead FROM ObjectPermissions WHERE ParentId='${permission.Id}' AND SobjectType='GenAiPromptTemplate' LIMIT 1`))[0];
    if (!readAccess) {
      await mutation(["data", "create", "record", "--sobject", "ObjectPermissions", "--values", values({ ParentId: permission.Id, SobjectType: "GenAiPromptTemplate", PermissionsRead: true })]);
    } else if (readAccess.PermissionsRead !== true) {
      await mutation(["data", "update", "record", "--sobject", "ObjectPermissions", "--record-id", String(readAccess.Id), "--values", values({ PermissionsRead: true })]);
    }
    readAccess = (await queryRecords(target, `SELECT PermissionsRead FROM ObjectPermissions WHERE ParentId='${permission.Id}' AND SobjectType='GenAiPromptTemplate' LIMIT 1`))[0];
    if (readAccess?.PermissionsRead !== true) throw new Error("Prompt-template object read verification failed.");
  }
  for (const user of users) {
    stage = "metadata permission assignment";
    await assign(user, permission.Id);
    const verified = await queryRecords(target, `SELECT PermissionSet.PermissionsModifyMetadata,PermissionSet.PermissionsViewSetup,PermissionSet.PermissionsViewRoles FROM PermissionSetAssignment WHERE AssigneeId='${user}' AND PermissionSetId='${permission.Id}' LIMIT 1`);
    const grant = verified[0]?.PermissionSet as Record<string, unknown> | undefined;
    if (grant?.PermissionsModifyMetadata !== true || grant.PermissionsViewSetup !== true || grant.PermissionsViewRoles !== true) throw new Error("Independent permission verification failed.");
  }
  if (dedicated) {
    stage = "Panel session preflight";
    const preflight = await run("sf", ["apex", "run", "--target-org", target], buildPanelSessionPreflight());
    if (preflight.status || !debugValue(preflight.stdout, "JWT_PANEL_SESSION_READY=")) throw new Error("Panel session unavailable.");
    const user = (await queryRecords(target, `SELECT Id,Username FROM User WHERE Id='${users[0]}' LIMIT 1`))[0];
    for (const record of records) {
      const channelId = record[schema.channelIdField];
      const payload = Buffer.from(JSON.stringify({ orgId: org.Id, metadataUserId: user.Id, metadataUsername: user.Username })).toString("base64");
      stage = "sf-auth metadata user registration";
      const apex = `HttpRequest r=new HttpRequest(); r.setEndpoint('callout:'+PanelAuthSupportService.getNamedCredentialName()+'/api/v1/salesforce/channels/${channelId}/agents/connect'); r.setMethod('POST'); r.setHeader('Content-Type','application/json'); r.setTimeout(120000); r.setBody(EncodingUtil.base64Decode('${payload}').toString()); HttpResponse response=new Http().send(r); System.debug('METADATA_CONNECT_STATUS='+response.getStatusCode());`;
      const response = await run("sf", ["apex", "run", "--target-org", target], apex);
      const status = debugValue(response.stdout, "METADATA_CONNECT_STATUS=");
      if (response.status || status !== "200") throw new Error(`Metadata user registration failed (HTTP ${status ?? "unknown"}).`);
      const d1 = await run("bun", ["x", "wrangler", "d1", "execute", "DB", "--env", environment, "--remote", "--command", `SELECT integration_user_id FROM sf_agent_metadata_user WHERE org_id='${org.Id}' AND channel_id='${channelId}'`, "--json"]);
      if (d1.status || JSON.parse(d1.stdout)[0]?.results?.[0]?.integration_user_id !== user.Id) throw new Error("Metadata user registration independent D1 verification failed.");
    }
  }
  console.log("Metadata user, license, permissions and registration independently verified.");
}
main().catch(error => { console.error(`Metadata setup failed during ${stage}: ${error instanceof Error ? error.message : "unknown"}`); process.exitCode = 1; });
