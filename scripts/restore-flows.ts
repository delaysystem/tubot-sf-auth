#!/usr/bin/env bun
/**
 * Restore archived pre-AppExchange flows + skill into a Salesforce org.
 *
 * Source of truth: tubot-sf-package/archive/pre-appexchange-cleanup/
 * Strips the IGNORE_ filename prefix, deploys via `sf` CLI auth
 * (--target-org), then verifies each FlowDefinition + Skill via SOQL.
 *
 * Usage:
 *   bun scripts/restore-flows.ts --target-org <alias> [--check-only]
 *       [--verify-only] [--with-routing-deps] [--namespace <ns>]
 *
 * Notes:
 * - t2.flow references QueueRoutingConfig Holding_Routing_Config. Without
 *   --with-routing-deps the deploy of t2 fails if that config is missing
 *   in the target org; the script reports per-component status.
 * - The flows reference Tubot_Setting__mdt / MessagingSession custom fields
 *   unprefixed. On orgs with the TuBot package installed, pass
 *   --namespace tubot (auto-detected when omitted) to rewrite those refs.
 * - Uses real `sf` CLI auth; no mocks, no synthetic backends.
 */
import { $ } from "bun";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = dirname(import.meta.dir); // tubot-sf-auth/
const ARCHIVE = join(ROOT, "tubot-sf-package/archive/pre-appexchange-cleanup");
const STAGING = join(import.meta.dir, "restored-flows");

const FLOWS = ["t2", "t100", "defaultFlowTuBot", "OmniMessagingRoutingFlow"];
const SKILL = "TuBot_On_Hold_DO_NOT_EDIT";
const DEP_QUEUES = ["Chat_Queue", "AI_Bot_Holding_Queue_100"];
const DEP_ROUTING = ["Chat_Routing_Config", "Holding_Routing_Config"];
// Unprefixed custom refs inside the archived flows; rewritten to
// `<ns>__<token>` when the namespaced package owns them in the target org.
const NAMESPACED_TOKENS = [
  "Tubot_Setting__mdt",
  "Fallback_Queue_Api_Name__c",
  "Escalate_To_Human__c",
  "varRouting__c",
  "varSkillLevel__c",
  "varTargetQueueName__c",
  "varTargetSkillName__c",
];

function usage(exit = 1): never {
  console.error(
    "Usage: bun scripts/restore-flows.ts --target-org <alias> [--check-only] [--verify-only] [--with-routing-deps] [--namespace <ns>]",
  );
  process.exit(exit);
}

const args = process.argv.slice(2);
function flagValue(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
}
const targetOrg = flagValue("--target-org");
if (!targetOrg) usage();
const checkOnly = args.includes("--check-only");
const verifyOnly = args.includes("--verify-only");
const withDeps = args.includes("--with-routing-deps");
let namespace = flagValue("--namespace");

function stage(subdir: string, names: string[], ext: string) {
  const dest = join(STAGING, "force-app/main/default", subdir);
  mkdirSync(dest, { recursive: true });
  for (const name of names) {
    const src = join(ARCHIVE, subdir, `IGNORE_${name}.${ext}`);
    cpSync(src, join(dest, `${name}.${ext}`));
    console.log(`staged ${subdir}/${name}.${ext}`);
  }
}

async function runSf(cmdArgs: string[]) {
  const proc = Bun.spawn(["sf", ...cmdArgs], {
    cwd: STAGING,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

async function deploy() {
  const deployArgs = [
    "project",
    "deploy",
    "start",
    "--source-dir",
    "force-app",
    "--target-org",
    targetOrg,
    "--concise",
    "--json",
  ];
  if (checkOnly) deployArgs.push("--dry-run");
  const { out, err, code } = await runSf(deployArgs);
  let json: any = null;
  try {
    json = JSON.parse(out);
  } catch {
    console.error("deploy output was not JSON:\n" + out + "\n" + err);
    process.exit(1);
  }
  const result = json.result ?? {};
  const deployed = result.deployedSource ?? [];
  const failed = result.details?.componentFailures ?? [];
  console.log(
    `\ndeploy ${checkOnly ? "(dry-run) " : ""}status=${result.status} success=${result.success} deployed=${deployed.length} failed=${failed.length} (exit=${code})`,
  );
  for (const f of failed) {
    console.log(`  FAIL ${f.componentType}/${f.fullName}: ${f.problem}`);
  }
  if (json.status !== 0 || result.success === false) process.exit(1);
}

async function query(soql: string, tooling = false): Promise<any[]> {
  const qargs = [
    "data",
    "query",
    "--query",
    soql,
    "--target-org",
    targetOrg,
    "--json",
  ];
  if (tooling) qargs.push("--use-tooling-api");
  const { out, code } = await runSf(qargs);
  if (code !== 0) {
    console.error(`query failed: ${soql}\n${out}`);
    process.exit(1);
  }
  return JSON.parse(out).result?.records ?? [];
}

async function verify() {
  console.log("\nverifying in target org (blind SOQL check):");
  let ok = true;
  const flowRows = await query(
    `SELECT DeveloperName, ActiveVersion.VersionNumber, ActiveVersion.Status FROM FlowDefinition WHERE DeveloperName IN (${FLOWS.map((f) => `'${f}'`).join(",")})`,
    true,
  );
  const seen = new Map(flowRows.map((r: any) => [r.DeveloperName, r]));
  for (const f of FLOWS) {
    const row = seen.get(f) as any;
    const ver = row?.ActiveVersion?.VersionNumber;
    console.log(`  flow ${f}: ${ver ? `ACTIVE v${ver}` : "MISSING or INACTIVE"}`);
    if (!ver) ok = false;
  }
  const skillRows = await query(
    `SELECT DeveloperName FROM Skill WHERE DeveloperName = '${SKILL}'`,
  );
  console.log(`  skill ${SKILL}: ${skillRows.length ? "PRESENT" : "MISSING"}`);
  if (!skillRows.length) ok = false;
  if (!ok) {
    console.error("\nverification FAILED");
    process.exit(1);
  }
  console.log("\nverification PASSED");
}

function applyNamespace(ns: string) {
  const dir = join(STAGING, "force-app/main/default/flows");
  const re = new RegExp(`(?<!\\w)(${NAMESPACED_TOKENS.join("|")})`, "g");
  for (const f of FLOWS) {
    const p = join(dir, `${f}.flow-meta.xml`);
    const src = readFileSync(p, "utf8");
    const out = src.replace(re, `${ns}__$1`);
    if (out !== src) {
      writeFileSync(p, out);
      console.log(`namespaced ${f}.flow-meta.xml -> ${ns}__*`);
    }
  }
}

// Regenerate staging from archive so prefix-stripping is reproducible.
rmSync(join(STAGING, "force-app"), { recursive: true, force: true });
stage("flows", FLOWS, "flow-meta.xml");
stage("skills", [SKILL], "skill-meta.xml");
if (withDeps) {
  stage("queues", DEP_QUEUES, "queue-meta.xml");
  stage("queueRoutingConfigs", DEP_ROUTING, "queueRoutingConfig-meta.xml");
}

if (!namespace && !verifyOnly) {
  const pkgs = await query(
    "SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName = 'tubot__Tubot_Setting__mdt'",
  );
  if (pkgs.length) {
    namespace = "tubot";
    console.log("auto-detected installed tubot package; applying namespace rewrite");
  }
}
if (namespace && !verifyOnly) applyNamespace(namespace);

if (!verifyOnly) await deploy();
if (!checkOnly) await verify();
