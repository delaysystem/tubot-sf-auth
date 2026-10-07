#!/usr/bin/env bun
/**
 * Point a Messaging channel's Omni session handler at an Omni flow.
 *
 * Retrieves MessagingChannel:<name> via `sf` CLI auth, sets
 * sessionHandlerType=Flow, sessionHandlerFlow=<flow>,
 * sessionHandlerQueue=<fallback queue>, redeploys, then re-retrieves
 * to blind-verify the values stuck.
 *
 * Usage:
 *   bun scripts/set-channel-omni-flow.ts --target-org <alias>
 *       --channel <DeveloperName> [--flow t2]
 *       [--fallback-queue AI_Bot_Holding_Queue_100] [--check-only]
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STAGING = join(import.meta.dir, "restored-flows"); // project context
const TMP = join(STAGING, ".tmp-channel");

function usage(exit = 1): never {
  console.error(
    "Usage: bun scripts/set-channel-omni-flow.ts --target-org <alias> --channel <DeveloperName> [--flow t2] [--fallback-queue AI_Bot_Holding_Queue_100] [--check-only]",
  );
  process.exit(exit);
}

const args = process.argv.slice(2);
function flagValue(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
}
const targetOrg = flagValue("--target-org");
const channel = flagValue("--channel");
if (!targetOrg || !channel) usage();
const flow = flagValue("--flow") ?? "t2";
const fallbackQueue = flagValue("--fallback-queue") ?? "AI_Bot_Holding_Queue_100";
const checkOnly = args.includes("--check-only");

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

/** Retrieve one channel in metadata format; returns path to the XML. */
async function retrieve(outDir: string): Promise<string> {
  rmSync(join(STAGING, outDir), { recursive: true, force: true });
  const { out, err, code } = await runSf([
    "project",
    "retrieve",
    "start",
    "--metadata",
    `MessagingChannel:${channel}`,
    "--target-org",
    targetOrg,
    "--output-dir",
    outDir,
    "--json",
  ]);
  if (code !== 0) {
    console.error(`retrieve failed:\n${out}\n${err}`);
    process.exit(1);
  }
  const files = JSON.parse(out).result?.files ?? [];
  const hit = files.some((f: any) => (f.fullName as string).includes(channel));
  const xmlPath = join(STAGING, outDir, "messagingChannels", `${channel}.messagingChannel-meta.xml`);
  if (!hit) {
    try {
      readFileSync(xmlPath, "utf8");
    } catch {
      console.error(`channel ${channel} not found in org ${targetOrg}`);
      process.exit(1);
    }
  }
  return xmlPath;
}

function setField(src: string, tag: string, value: string): string {
  const re = new RegExp(`<${tag}>[^<]*</${tag}>`);
  const el = `<${tag}>${value}</${tag}>`;
  if (re.test(src)) return src.replace(re, el);
  return src.replace("</MessagingChannel>", `    ${el}\n</MessagingChannel>`);
}

function getField(src: string, tag: string): string | null {
  const m = src.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : null;
}

mkdirSync(STAGING, { recursive: true });
const xmlPath = await retrieve(".tmp-channel");
const before = readFileSync(xmlPath, "utf8");
console.log(
  `before: type=${getField(before, "sessionHandlerType")} flow=${getField(before, "sessionHandlerFlow")} queue=${getField(before, "sessionHandlerQueue")}`,
);

let after = setField(before, "sessionHandlerType", "Flow");
after = setField(after, "sessionHandlerFlow", flow);
after = setField(after, "sessionHandlerQueue", fallbackQueue);
if (after === before) {
  console.log("already set; nothing to do");
} else if (checkOnly) {
  console.log(`would set: type=Flow flow=${flow} queue=${fallbackQueue}`);
} else {
  writeFileSync(xmlPath, after);
  const { out, code } = await runSf([
    "project",
    "deploy",
    "start",
    "--source-dir",
    ".tmp-channel",
    "--target-org",
    targetOrg,
    "--concise",
    "--json",
  ]);
  const result = JSON.parse(out).result ?? {};
  console.log(`deploy status=${result.status} success=${result.success} (exit=${code})`);
  for (const f of result.details?.componentFailures ?? []) {
    console.log(`  FAIL ${f.componentType}/${f.fullName}: ${f.problem}`);
  }
  if (result.success !== true) process.exit(1);

  // Blind verify: fresh retrieve, assert values.
  const verifyPath = await retrieve(".tmp-channel-verify");
  const verifySrc = readFileSync(verifyPath, "utf8");
  const got = {
    type: getField(verifySrc, "sessionHandlerType"),
    flow: getField(verifySrc, "sessionHandlerFlow"),
    queue: getField(verifySrc, "sessionHandlerQueue"),
  };
  console.log(`verified: type=${got.type} flow=${got.flow} queue=${got.queue}`);
  if (got.type !== "Flow" || got.flow !== flow || got.queue !== fallbackQueue) {
    console.error("verification FAILED");
    process.exit(1);
  }
  console.log("verification PASSED");
}

rmSync(join(STAGING, ".tmp-channel"), { recursive: true, force: true });
rmSync(join(STAGING, ".tmp-channel-verify"), { recursive: true, force: true });
