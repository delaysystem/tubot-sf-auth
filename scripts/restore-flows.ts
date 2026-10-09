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
 *       [--verify-only] [--with-routing-deps] [--with-session-metadata]
 *       [--namespace <ns>] [--t2-subflow <flowApiName>]
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
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE); // tubot-sf-auth/
const ARCHIVE = join(ROOT, "tubot-sf-package/archive/pre-appexchange-cleanup");
const STAGING = join(HERE, "restored-flows");

const FLOWS = ["t2", "t100", "defaultFlowTuBot", "OmniMessagingRoutingFlow"];
const SKILL = "TuBot_On_Hold_DO_NOT_EDIT";
const DEP_QUEUES = ["Chat_Queue", "AI_Bot_Holding_Queue_100"];
const DEP_ROUTING = ["Chat_Routing_Config", "Holding_Routing_Config"];
// Unprefixed custom refs inside the archived flows; rewritten to
// `<ns>__<token>` when the namespaced package owns them in the target org.
const NAMESPACED_TOKENS = [
  "Tubot_Setting__mdt",
  "Fallback_Queue_Api_Name__c",
  "AI_Routing__c",
  "Queues_and_Skills__c",
  "Escalate_To_Human__c",
  "varRouting__c",
  "varSkillLevel__c",
  "varTargetQueueName__c",
  "varTargetSkillName__c",
  "varFlowHuman__c",
];

function usage(exit = 1): never {
  console.error(
    "Usage: bun scripts/restore-flows.ts --target-org <alias> [--check-only] [--verify-only] [--with-routing-deps] [--with-session-metadata] [--namespace <ns>] [--t2-subflow <flowApiName>]",
  );
  process.exit(exit);
}

const args = process.argv.slice(2);
function flagValue(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
}
const targetOrg: string = flagValue("--target-org") ?? usage();
const checkOnly = args.includes("--check-only");
const verifyOnly = args.includes("--verify-only");
const withDeps = args.includes("--with-routing-deps");
const withSessionMeta = args.includes("--with-session-metadata");
const t2Subflow = flagValue("--t2-subflow");
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
  const done = spawnSync("sf", cmdArgs, { cwd: STAGING, encoding: "utf8" });
  return { out: done.stdout ?? "", err: done.stderr ?? "", code: done.status ?? 1 };
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

const NS_RE = new RegExp(`(?<!\\w)(${NAMESPACED_TOKENS.join("|")})`, "g");

function applyNamespace(ns: string) {
  const dir = join(STAGING, "force-app/main/default/flows");
  for (const f of FLOWS) {
    const p = join(dir, `${f}.flow-meta.xml`);
    const src = readFileSync(p, "utf8");
    const out = src.replace(NS_RE, `${ns}__$1`);
    if (out !== src) {
      writeFileSync(p, out);
      console.log(`namespaced ${f}.flow-meta.xml -> ${ns}__*`);
    }
  }
  // MDT record follows the type: subscriber record on a packaged type.
  const mdDir = join(STAGING, "force-app/main/default/customMetadata");
  const plain = join(mdDir, "Tubot_Setting.Default.md-meta.xml");
  try {
    const src = readFileSync(plain, "utf8");
    writeFileSync(join(mdDir, `${ns}__Tubot_Setting.Default.md-meta.xml`), src.replace(NS_RE, `${ns}__$1`));
    rmSync(plain);
    console.log(`namespaced Tubot_Setting.Default record -> ${ns}__*`);
  } catch {
    /* not staged */
  }
}

/** Copy a metadata dir tree from package source into staging. */
function stagePkgDir(srcRel: string, destSub: string) {
  const dest = join(STAGING, "force-app/main/default", destSub);
  mkdirSync(dest, { recursive: true });
  cpSync(join(ROOT, "tubot-sf-package/force-app/main/default", srcRel), dest, {
    recursive: true,
  });
  console.log(`staged ${destSub}/ from package source (${srcRel})`);
}

function stageSessionMetadata() {
  if (namespace) {
    // Packaged fields own the schema; only the MDT record is missing.
    console.log("namespace active: skipping unpackaged session fields (package provides them)");
  } else {
    stagePkgDir("objects/MessagingSession/fields", "objects/MessagingSession/fields");
    stagePkgDir("objects/Tubot_Setting__mdt", "objects/Tubot_Setting__mdt");
  }
  stage("customMetadata", ["Tubot_Setting.Default"], "md-meta.xml");
}

async function verifyDeps(prefix: string) {
  if (withDeps) {
    const cfgs = await query(
      `SELECT DeveloperName FROM QueueRoutingConfig WHERE DeveloperName IN (${DEP_ROUTING.map((q) => `'${q}'`).join(",")})`,
    );
    console.log(
      `  routing configs: ${cfgs.length}/${DEP_ROUTING.length} present`,
    );
    const queues = await query(
      `SELECT DeveloperName FROM Group WHERE Type = 'Queue' AND DeveloperName IN (${DEP_QUEUES.map((q) => `'${q}'`).join(",")})`,
    );
    console.log(`  queues: ${queues.length}/${DEP_QUEUES.length} present`);
    if (cfgs.length !== DEP_ROUTING.length || queues.length !== DEP_QUEUES.length) {
      console.error("\nverification FAILED (routing deps)");
      process.exit(1);
    }
  }
  if (withSessionMeta) {
    const recs = await query(
      `SELECT DeveloperName FROM ${prefix}Tubot_Setting__mdt WHERE DeveloperName = 'Default'`,
    );
    console.log(`  MDT ${prefix}Tubot_Setting.Default record: ${recs.length ? "PRESENT" : "MISSING"}`);
    const fields = await query(
      `SELECT QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'MessagingSession' AND QualifiedApiName LIKE '${prefix}%__c'`,
    );
    console.log(`  MessagingSession ${prefix || "(unpackaged) "}custom fields: ${fields.length}`);
    if (!recs.length || !fields.length) {
      console.error("\nverification FAILED (session metadata)");
      process.exit(1);
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
// --verify-only still needs the prefix for MDT/field checks.
if (!namespace && verifyOnly) {
  const pkgs = await query(
    "SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName = 'tubot__Tubot_Setting__mdt'",
  );
  if (pkgs.length) namespace = "tubot";
}
if (withSessionMeta && !verifyOnly) stageSessionMetadata();
if (namespace && !verifyOnly) applyNamespace(namespace);

if (t2Subflow && !verifyOnly) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(t2Subflow)) {
    console.error(`invalid flow name: ${t2Subflow}`);
    process.exit(1);
  }
  // System-side resolution: target must exist in the org or in this deploy.
  if (!FLOWS.includes(t2Subflow)) {
    const found = await query(
      `SELECT DeveloperName FROM FlowDefinition WHERE DeveloperName = '${t2Subflow}'`,
      true,
    );
    if (!found.length) {
      console.error(`subflow target ${t2Subflow} not found in ${targetOrg}; aborting`);
      process.exit(1);
    }
  }
  const p = join(STAGING, "force-app/main/default/flows/t2.flow-meta.xml");
  const src = readFileSync(p, "utf8");
  if (!src.includes("<flowName>defaultFlowTuBot</flowName>")) {
    console.error("t2 staged flow has no defaultFlowTuBot subflow element; aborting");
    process.exit(1);
  }
  writeFileSync(p, src.replace("<flowName>defaultFlowTuBot</flowName>", `<flowName>${t2Subflow}</flowName>`));
  console.log(`t2 subflow element -> ${t2Subflow}`);
}

if (!verifyOnly) await deploy();
if (!checkOnly) {
  await verify();
  await verifyDeps(namespace ? `${namespace}__` : "");
}
