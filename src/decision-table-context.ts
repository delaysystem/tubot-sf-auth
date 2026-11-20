/**
 * Side-effect-free executor for decision-table actions
 * (`custom/decisionTableAction/*`).
 *
 * Root cause (blind-verified 2026-10-06, SDOSTAINLESS, live native probes):
 * decision-table descriptors declare every input optional, so an empty
 * payload 400s INVALID_API_INPUT (`Payload is missing`) across the whole
 * family. Evaluation creates no rows, so no fixtures are needed: every
 * declared input is populated from live descriptor metadata (defaultValue,
 * then the first active picklist choice, then a type-appropriate sample)
 * and the native outcome passes through untouched. Live wire rules: DATE
 * criteria take ISO datetimes (a bare YYYY-MM-DD 400s), numerics take 0,
 * strings take short probe text; TIME has no proven wire shape and stays
 * unshaped. No table name, value, org id, alias, or URL appears here;
 * anything unbuildable refuses with no native POST.
 */

import { nativeActionSucceeded } from "./action-outcome";

type Value = Record<string, unknown>;
type Result = { status: number; ok: boolean; body: any };

export const DECISION_TABLE_BUILDER_VERSION = 1;

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const ACTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const NUMERIC_TYPES = new Set(["INTEGER", "INT", "LONG", "DOUBLE", "DECIMAL", "CURRENCY", "PERCENT"]);

const record = (value: unknown): value is Value =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const fail = (errorCode: string, message: string, extra?: Value): Result => ({
  status: 422, ok: false, body: { errorCode, message, ...extra },
});

/**
 * Parse a live decision-table route. Returns the table action name, or
 * null when the route is not in this family. Classification uses the
 * route shape only; no table name is ever enumerated here.
 */
export function decisionTableActionName(route: string): string | null {
  const match = typeof route === "string"
    ? route.match(/^\/services\/data\/v\d+(?:\.\d+)?\/actions\/custom\/decisionTableAction\/([A-Za-z][A-Za-z0-9_]{0,127})$/)
    : null;
  const name = match?.[1] ?? null;
  return name !== null && ACTION_NAME.test(name) ? name : null;
}

/** Compact probe text that fits any sane criterion cap (14 chars). */
export function decisionTableProbeText(): string {
  return `AS dt ${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Well-formed evaluation args for every declared descriptor input.
 * Precedence per input: bounded defaultValue, first active picklist
 * choice, type-appropriate sample (booleans false, numerics 0, ISO
 * datetimes for DATE/DATETIME, short probe text). Collection inputs
 * (maxOccurs > 1) wrap in an array. Reference/ID/sObject/TIME inputs
 * are never invented: required ones fail the build, optional ones are
 * omitted. Empty arg sets refuse: the platform 400s a missing payload.
 */
export function decisionTableArgs(
  descriptorInputs: unknown,
): { args: Record<string, unknown> } | { failure: string } {
  const inputs = Array.isArray(descriptorInputs) ? descriptorInputs.filter(record) : [];
  if (!inputs.length) return { failure: "The live descriptor declares no inputs." };
  const args: Record<string, unknown> = {};
  for (const field of inputs) {
    const name = field.name;
    if (typeof name !== "string" || !FIELD_NAME.test(name)) {
      return { failure: "The live descriptor declares an unusable input name." };
    }
    const type = typeof field.type === "string" ? field.type.toUpperCase() : "";
    const required = field.required === true;
    const collect = typeof field.maxOccurs === "number" && field.maxOccurs > 1;
    const wrap = (value: unknown): unknown => (collect ? [value] : value);
    const fallback = field.defaultValue;
    if (typeof fallback === "string" && fallback.length > 0 && fallback.length <= 255) {
      args[name] = wrap(fallback);
      continue;
    }
    if (typeof fallback === "number" && Number.isFinite(fallback)) {
      args[name] = wrap(fallback);
      continue;
    }
    if (typeof fallback === "boolean") {
      args[name] = wrap(fallback);
      continue;
    }
    const choices = Array.isArray(field.picklistValues) ? field.picklistValues.filter(record) : [];
    const choice = choices.find((entry) => entry.active === true && typeof entry.value === "string");
    if (choice) {
      args[name] = wrap(choice.value as string);
      continue;
    }
    if (type === "BOOLEAN") { args[name] = wrap(false); continue; }
    if (NUMERIC_TYPES.has(type)) { args[name] = wrap(0); continue; }
    if (type === "DATE" || type === "DATETIME") { args[name] = wrap(new Date().toISOString()); continue; }
    if (type === "EMAIL") {
      args[name] = wrap(`dt-${crypto.randomUUID().slice(0, 8)}@example.invalid`);
      continue;
    }
    if (type === "STRING" || type === "TEXT" || type === "TEXTAREA" || type === "PHONE" ||
      type === "URL" || type === "COMBOBOX" || type === "ENCRYPTEDSTRING" || type === "PICKLIST") {
      args[name] = wrap(decisionTableProbeText());
      continue;
    }
    if (required) return { failure: `No discovered live value for required input ${name}.` };
  }
  if (!Object.keys(args).length) {
    return { failure: "No declared input has a safe sample value; an empty payload would 400." };
  }
  return { args };
}

export type DecisionTableLifecycleInput = {
  root: string;
  route: string;
  verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
};

export async function invokeDecisionTableWithContext(input: DecisionTableLifecycleInput): Promise<{
  status: number; body: any; cleanupError?: string; contextSchema?: Value;
}> {
  const { root, request } = input;
  const action = decisionTableActionName(input.route);
  const automaticSteps = [
    "Resolve the live decision-table descriptor inputs",
    "Populate every declared input from descriptor metadata (never empty)",
    "Invoke the side-effect-free native evaluation",
    "Verify the native acceptance envelope",
  ];
  const base = { source: "salesforce_live_decision_table_action", action, automaticSteps };
  const done = (outcome: Result, extra: Value) => ({
    status: outcome.status, body: outcome.body, contextSchema: { ...base, ...extra },
  });
  if (!action || !root.startsWith("/services/data/") || !input.route.startsWith(`${root}/actions/`)) {
    return done(fail("DECISION_TABLE_ACTION_INVALID", "A discovered decision-table action route is required."), { verified: false });
  }
  if (input.verificationWindowMs !== undefined &&
    (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail("DECISION_TABLE_WINDOW_INVALID", "A bounded verification window is required."), { verified: false });
  }
  const descriptor = await request(input.route);
  if (!descriptor.ok) return done(descriptor, { verified: false });
  const body = record(descriptor.body) ? descriptor.body : null;
  const built = decisionTableArgs(body?.inputs);
  if ("failure" in built) {
    return done(fail("DECISION_TABLE_ARGS_UNBUILDABLE", `${built.failure} The native call was not attempted.`), { verified: false });
  }
  const invoked = await request(input.route, "POST", { inputs: [built.args] });
  if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, input.verificationWindowMs));
  const verified = nativeActionSucceeded(invoked.status, invoked.body);
  return done(invoked, { verified, inputCount: Object.keys(built.args).length });
}
