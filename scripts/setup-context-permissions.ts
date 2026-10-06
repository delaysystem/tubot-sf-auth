#!/usr/bin/env bun
/**
 * setup:context-permissions — fixture permission-set planner and applier.
 *
 * Setup-side only: consumes planner-only `denialGrant` families (see
 * `src/permission-denial-grants.ts`) plus `setupRequirement` object names
 * and turns them into a fixture permission-set change plan. Dry-run by
 * default: without `--apply` nothing executes and no org is contacted —
 * the plan (auto-appliable operations, manual admin steps, and the exact
 * `sf` commands `--apply` would run) prints to stdout.
 *
 * With `--apply`, auto-appliable operations execute through the `sf` CLI
 * against `--target-org` (Tooling API upserts: PermissionSet ensure,
 * ObjectPermissions, FieldPermissions, PermissionSetAssignment). Manual
 * families (record-access, cross-reference, feature-access,
 * action-access, package-data) always print admin steps and never
 * execute anything: sharing/ownership and feature permissions have no
 * safe CLI-able grant.
 *
 * Zero-hardcoding contract: the permission-set name, execution-user id,
 * target org, and every object/field name are caller-supplied and
 * validated; no org IDs, aliases, instance URLs, tenant names, or
 * customer values appear here. `sf` JSON output is parsed and only the
 * needed fields are read — full responses (which can carry tokens) are
 * never printed or logged.
 *
 * Usage:
 *   bun scripts/setup-context-permissions.ts --permset NAME --user USERID \
 *     --target-org ALIAS [--api-version 67.0] [--dry-run | --apply] \
 *     --grant object-crud:Case [--grant field-access:Obj.Field ...]
 */

import { spawnSync } from "node:child_process";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const API_VERSION = /^\d{2,3}\.\d+$/;
const GRANT_FAMILIES = new Set([
  "object-crud",
  "record-access",
  "cross-reference",
  "feature-access",
  "action-access",
  "package-data",
  "field-access",
]);
const OPS = new Set(["create", "read", "edit", "update", "delete"]);

export type ParsedGrant =
  | { family: "object-crud"; object: string; ops: Ops }
  | { family: "record-access"; object?: string }
  | { family: "cross-reference"; object?: string }
  | { family: "feature-access" }
  | { family: "action-access" }
  | { family: "package-data" }
  | { family: "field-access"; object: string; field: string };

export type Ops = { create: boolean; read: boolean; edit: boolean; delete: boolean };
export const FULL_CRUD: Ops = { create: true, read: true, edit: true, delete: true };

export type SetupOptions = {
  permset: string;
  user: string;
  targetOrg: string;
  apiVersion: string;
  apply: boolean;
  grants: ParsedGrant[];
};

export type SetupOperation =
  | { op: "ensure-permset"; permset: string }
  | { op: "object-permissions"; object: string; ops: Ops }
  | { op: "field-permissions"; object: string; field: string }
  | { op: "assign"; user: string }
  | { op: "manual"; title: string; detail: string };

const usage = (): string =>
  [
    "setup:context-permissions — fixture permission-set planner (dry-run by default).",
    "",
    "  --permset NAME        Fixture permission set developer name (required).",
    "  --user USERID         Execution-user 15/18-char ID for assignment (required).",
    "  --target-org ALIAS    sf target org; contacted only under --apply (required).",
    "  --api-version VER     Tooling API version, e.g. 67.0 (default 67.0).",
    "  --grant SPEC          Repeatable. SPEC is one of:",
    "                          object-crud:Object[:op,op]  (default ops: full CRUD)",
    "                          field-access:Object.Field",
    "                          record-access[:Object]      (manual: sharing/ownership)",
    "                          cross-reference[:Object]    (manual: parent-row access)",
    "                          feature-access              (manual: admin resolves)",
    "                          action-access               (manual: admin resolves)",
    "                          package-data                (manual: admin resolves)",
    "  --dry-run             Print the plan; contact no org (default).",
    "  --apply               Execute auto-appliable operations via the sf CLI.",
    "  --help                Print this usage.",
  ].join("\n");

export function parseGrant(spec: unknown): ParsedGrant {
  if (typeof spec !== "string" || !spec) throw new Error("Grant specs must be non-empty strings.");
  const [family, rest, opsSpec] = spec.split(":");
  if (!GRANT_FAMILIES.has(family)) throw new Error(`Unknown grant family "${family.slice(0, 40)}".`);
  if (family === "object-crud") {
    if (!rest || !IDENTIFIER.test(rest)) throw new Error(`object-crud needs an object name: "${spec.slice(0, 80)}".`);
    const ops: Ops = { create: false, read: false, edit: false, delete: false };
    if (opsSpec === undefined) return { family, object: rest, ops: { ...FULL_CRUD } };
    for (const token of opsSpec.split(",")) {
      const op = token.trim().toLowerCase();
      if (!OPS.has(op)) throw new Error(`Unknown crud op "${token.slice(0, 20)}" (want create,read,edit,delete).`);
      ops[op === "update" ? "edit" : (op as keyof Ops)] = true;
    }
    if (!ops.create && !ops.read && !ops.edit && !ops.delete) throw new Error("object-crud needs at least one op.");
    return { family, object: rest, ops };
  }
  if (family === "field-access") {
    const [object, field] = (rest ?? "").split(".");
    if (!object || !field || !IDENTIFIER.test(object) || !IDENTIFIER.test(field)) {
      throw new Error(`field-access needs Object.Field: "${spec.slice(0, 80)}".`);
    }
    return { family, object, field };
  }
  if (family === "record-access" || family === "cross-reference") {
    if (rest !== undefined && !IDENTIFIER.test(rest)) throw new Error(`Invalid object name: "${spec.slice(0, 80)}".`);
    return rest === undefined ? { family } : { family, object: rest };
  }
  if (rest !== undefined) throw new Error(`Grant family "${family}" takes no object: "${spec.slice(0, 80)}".`);
  return { family } as ParsedGrant;
}

export function parseArgs(argv: string[]): SetupOptions {
  const options: SetupOptions = {
    permset: "", user: "", targetOrg: "", apiVersion: "67.0", apply: false, grants: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
      i++;
      return value;
    };
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--permset") options.permset = next();
    else if (arg === "--user") options.user = next();
    else if (arg === "--target-org") options.targetOrg = next();
    else if (arg === "--api-version") options.apiVersion = next();
    else if (arg === "--grant") options.grants.push(parseGrant(next()));
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--apply") options.apply = true;
    else throw new Error(`Unknown flag "${arg.slice(0, 40)}".`);
  }
  if (!IDENTIFIER.test(options.permset)) throw new Error("--permset needs a permission-set developer name.");
  if (!SF_ID.test(options.user)) throw new Error("--user needs a 15/18-char execution-user ID.");
  if (!options.targetOrg || options.targetOrg.length > 128) throw new Error("--target-org is required.");
  if (!API_VERSION.test(options.apiVersion)) throw new Error("--api-version must look like 67.0.");
  if (!options.grants.length) throw new Error("Nothing to plan: pass at least one --grant.");
  return options;
}

/** Declarative plan: auto-appliable operations plus manual admin steps. Pure. */
export function planSetup(options: SetupOptions): SetupOperation[] {
  const plan: SetupOperation[] = [{ op: "ensure-permset", permset: options.permset }];
  const seen = new Set<string>();
  for (const grant of options.grants) {
    if (grant.family === "object-crud") {
      const key = `object:${grant.object}`;
      const prior = plan.find((entry): entry is Extract<SetupOperation, { op: "object-permissions" }> =>
        entry.op === "object-permissions" && entry.object === grant.object);
      if (prior) {
        prior.ops.create ||= grant.ops.create;
        prior.ops.read ||= grant.ops.read;
        prior.ops.edit ||= grant.ops.edit;
        prior.ops.delete ||= grant.ops.delete;
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      plan.push({ op: "object-permissions", object: grant.object, ops: { ...grant.ops } });
    } else if (grant.family === "field-access") {
      const key = `field:${grant.object}.${grant.field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      plan.push({ op: "field-permissions", object: grant.object, field: grant.field });
    } else if (grant.family === "record-access") {
      plan.push({
        op: "manual", title: "record-access",
        detail: `Give the execution user visibility into the denied row${grant.object ? ` (${grant.object})` : ""} via ownership, sharing, or role hierarchy. No permission-set grant fixes row visibility.`,
      });
    } else if (grant.family === "cross-reference") {
      plan.push({
        op: "manual", title: "cross-reference",
        detail: `Give the execution user access to the referenced parent or shared row${grant.object ? ` (${grant.object})` : ""} via ownership, sharing, or role hierarchy.`,
      });
    } else if (grant.family === "feature-access") {
      plan.push({
        op: "manual", title: "feature-access",
        detail: "Grant the execution user the feature permission the gated action requires (Setup resolves the exact permission), then retry.",
      });
    } else if (grant.family === "action-access") {
      plan.push({
        op: "manual", title: "action-access",
        detail: "Grant the execution user permission to run the gated action (Setup resolves the exact permission), then retry.",
      });
    } else if (grant.family === "package-data") {
      plan.push({
        op: "manual", title: "package-data",
        detail: "Grant the execution user access to the integration data the action reads (Setup resolves the exact permission), then retry.",
      });
    }
  }
  plan.push({ op: "assign", user: options.user });
  return plan;
}

const opsText = (ops: Ops): string =>
  (["create", "read", "edit", "delete"] as const).filter((name) => ops[name]).join(",");

/** Human-readable dry-run rendering. Pure. */
export function renderPlan(plan: SetupOperation[], options: SetupOptions): string {
  const lines = [
    `setup:context-permissions plan (permset ${options.permset}, org ${options.targetOrg})`,
    ...plan.map((entry) => {
      if (entry.op === "ensure-permset") return `  [auto] ensure permission set ${entry.permset} exists`;
      if (entry.op === "object-permissions") return `  [auto] ${entry.object} object permissions: ${opsText(entry.ops)}`;
      if (entry.op === "field-permissions") return `  [auto] ${entry.object}.${entry.field} field permissions: read,edit`;
      if (entry.op === "assign") return `  [auto] assign ${options.permset} to the execution user`;
      return `  [manual] ${entry.title}: ${entry.detail}`;
    }),
    options.apply ? "mode: apply (executes [auto] operations)" : "mode: dry-run (no org contact; pass --apply to execute [auto] operations)",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Executor (runs only under --apply; dry-run never reaches here).
// ---------------------------------------------------------------------------

type SfResult = { ok: boolean; json: any; stderr: string };

function runSf(args: string[]): SfResult {
  const done = spawnSync("sf", args, { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 });
  let json: any = null;
  try {
    json = done.stdout ? JSON.parse(done.stdout) : null;
  } catch {
    json = null;
  }
  return { ok: done.status === 0, json, stderr: String(done.stderr ?? "").slice(0, 300) };
}

function fail(step: string, result: SfResult): never {
  const detail = typeof result.json?.message === "string" ? result.json.message.slice(0, 200)
    : typeof result.json?.result?.error === "string" ? result.json.result.error.slice(0, 200)
    : result.stderr || "unknown error";
  throw new Error(`${step} failed: ${detail}`);
}

const tooling = (apiVersion: string, suffix: string): string =>
  `/services/data/v${apiVersion}/tooling${suffix}`;

async function executePlan(plan: SetupOperation[], options: SetupOptions): Promise<void> {
  const org = ["--target-org", options.targetOrg];
  const api = (method: string, path: string, body?: unknown): SfResult =>
    runSf(["api", "request", "rest", "--method", method, "--path", path,
      ...(body === undefined ? [] : ["--body", JSON.stringify(body)]), ...org, "--json"]);
  const preflight = runSf(["org", "display", ...org, "--json"]);
  if (!preflight.ok || preflight.json?.status !== 0) fail("org preflight", preflight);
  console.log(`connected org user: ${String(preflight.json?.result?.username ?? "unknown").slice(0, 120)}`);
  const query = (soql: string): any[] => {
    const done = api("GET", `${tooling(options.apiVersion, "/query")}?q=${encodeURIComponent(soql)}`);
    if (!done.ok || !Array.isArray(done.json?.records)) fail("tooling query", done);
    return done.json.records;
  };
  // Permission-set ensure.
  const found = query(`SELECT Id FROM PermissionSet WHERE Name = '${options.permset}' LIMIT 1`);
  let permsetId = typeof found[0]?.Id === "string" ? found[0].Id : null;
  if (!permsetId) {
    const created = api("POST", tooling(options.apiVersion, "/sobjects/PermissionSet"),
      { Name: options.permset, Label: options.permset });
    if (!created.ok || typeof created.json?.id !== "string") fail("permission-set create", created);
    permsetId = created.json.id;
    console.log(`created permission set ${options.permset}`);
  }
  for (const entry of plan) {
    if (entry.op === "ensure-permset" || entry.op === "assign") continue;
    if (entry.op === "manual") {
      console.log(`[manual] ${entry.title}: ${entry.detail}`);
      continue;
    }
    if (entry.op === "object-permissions") {
      const rows = query(`SELECT Id, PermissionsCreate, PermissionsRead, PermissionsEdit, PermissionsDelete FROM ObjectPermissions WHERE ParentId = '${permsetId}' AND SobjectType = '${entry.object}' LIMIT 1`);
      const body = {
        ParentId: permsetId, SobjectType: entry.object,
        PermissionsCreate: entry.ops.create || rows[0]?.PermissionsCreate === true,
        PermissionsRead: entry.ops.read || rows[0]?.PermissionsRead === true,
        PermissionsEdit: entry.ops.edit || rows[0]?.PermissionsEdit === true,
        PermissionsDelete: entry.ops.delete || rows[0]?.PermissionsDelete === true,
      };
      if (rows[0]?.Id) {
        const patched = api("PATCH", tooling(options.apiVersion, `/sobjects/ObjectPermissions/${rows[0].Id}`), body);
        if (!patched.ok) fail(`object permissions ${entry.object}`, patched);
      } else {
        const created = api("POST", tooling(options.apiVersion, "/sobjects/ObjectPermissions"), body);
        if (!created.ok) fail(`object permissions ${entry.object}`, created);
      }
      console.log(`upserted ${entry.object} object permissions (${opsText(entry.ops)})`);
    }
    if (entry.op === "field-permissions") {
      const rows = query(`SELECT Id FROM FieldPermissions WHERE ParentId = '${permsetId}' AND SobjectType = '${entry.object}' AND Field = '${entry.object}.${entry.field}' LIMIT 1`);
      if (!rows[0]?.Id) {
        const created = api("POST", tooling(options.apiVersion, "/sobjects/FieldPermissions"),
          { ParentId: permsetId, SobjectType: entry.object, Field: `${entry.object}.${entry.field}`, PermissionsRead: true, PermissionsEdit: true });
        if (!created.ok) fail(`field permissions ${entry.object}.${entry.field}`, created);
        console.log(`created ${entry.object}.${entry.field} field permissions (read,edit)`);
      } else {
        console.log(`field permissions ${entry.object}.${entry.field} already present`);
      }
    }
  }
  const assigned = query(`SELECT Id FROM PermissionSetAssignment WHERE PermissionSetId = '${permsetId}' AND AssigneeId = '${options.user}' LIMIT 1`);
  if (!assigned[0]?.Id) {
    const created = api("POST", tooling(options.apiVersion, "/sobjects/PermissionSetAssignment"),
      { PermissionSetId: permsetId, AssigneeId: options.user });
    if (!created.ok) fail("permission-set assignment", created);
    console.log("assigned the permission set to the execution user");
  } else {
    console.log("permission set already assigned to the execution user");
  }
}

const isMain = typeof process !== "undefined" && Array.isArray(process.argv) &&
  process.argv[1]?.endsWith("setup-context-permissions.ts");
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const plan = planSetup(options);
    console.log(renderPlan(plan, options));
    if (options.apply) await executePlan(plan, options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(2);
  }
}
