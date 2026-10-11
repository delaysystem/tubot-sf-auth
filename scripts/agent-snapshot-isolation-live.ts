#!/usr/bin/env bun
/** Read-only checks against the snapshots produced by agent-snapshot-live.ts. */
import { readFile } from "node:fs/promises";
import { run, debugValue } from "./jwt-api-smoke";
const targets = process.argv.slice(2);
if (targets.length !== 2 || targets.some(t => !/^[A-Za-z0-9_-]+$/.test(t))) throw new Error("Usage: bun scripts/agent-snapshot-isolation-live.ts <alias-a> <alias-b>");
async function main() {
  const identities = await Promise.all(targets.map(async target => JSON.parse(await readFile(`/tmp/tubot-agent-verification-${target}/identity.json`, "utf8"))));
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index], own = identities[index], foreign = identities[1 - index];
    if (own.orgId === foreign.orgId) throw new Error("Isolation verification requires distinct orgs.");
    for (const operation of ["status", "download"]) {
      for (const identity of [own, foreign]) {
        const body = Buffer.from(JSON.stringify({ orgId: own.orgId, jobId: identity.jobId, teamId: "caller-supplied-scope-must-be-ignored" })).toString("base64");
        const apex = `HttpRequest r=new HttpRequest();r.setEndpoint('callout:'+PanelAuthSupportService.getNamedCredentialName()+'/api/v1/salesforce/channels/${own.channelId}/agents/${operation}');r.setMethod('POST');r.setHeader('Content-Type','application/json');r.setTimeout(120000);r.setBody(EncodingUtil.base64Decode('${body}').toString());HttpResponse response=new Http().send(r);System.debug('ISOLATION_STATUS='+response.getStatusCode());`;
        const response = await run("sf", ["apex", "run", "--target-org", target], apex);
        const status = Number(debugValue(response.stdout, "ISOLATION_STATUS="));
        const expected = identity === own ? 200 : 404;
        if (response.status || status !== expected) throw new Error(`${target} ${operation} expected HTTP ${expected}, received ${status}.`);
      }
    }
    console.log(JSON.stringify({ target, ownSnapshot: "accessible", foreignOrgSnapshot: "rejected with HTTP 404", callerTenantOverride: "ignored" }));
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Isolation verification failed."); process.exitCode = 1; });
