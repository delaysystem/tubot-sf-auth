/**
 * Repair consumers for retryable managed-flow faults.
 *
 * The auth worker classifies upstream managed-flow failures into stable
 * taxonomy codes (`managed-flow-faults.ts`), but parked rows never
 * convert: the generic opaque code (`MANAGED_FLOW_EXECUTION_FAULT`) only
 * gains a planner stamp, and the agent-context repair lifecycle
 * (`agent-customer-context.ts`) has no caller. This module closes that
 * loop generically — no flow, action, org, or tenant names anywhere:
 *
 * - `planFlowFaultRepair` maps every taxonomy code to a concrete repair
 *   strategy: producer-backed agent context, evidence narrowing,
 *   self-contained input reshapes, admin/vendor setup waits, or a
 *   terminal verdict. Unknown codes return null so the existing
 *   pipeline keeps its verdict untouched.
 * - `flowFaultRepairDue` recency-gates repair attempts on the searcher's
 *   QUOTABURN Q3 windows (24h, 7d once a code repeats): a repair runs
 *   only when never attempted, builder-stale, or past its window.
 * - `runFlowFaultRepairConsumer` applies the repair through existing
 *   executors and transports, re-probes, and re-diagnoses. Only
 *   genuinely unrepairable faults terminalize (taxonomy-terminal codes
 *   and evidence-proven skew); every unverifiable read, transport
 *   failure, or unexecutable reshape parks instead of terminalizing.
 *
 * Repairs never mutate permission sets, package configuration, or remote
 * endpoints: grant/setup codes park as await-setup with their precise
 * requirement and re-probe when due, so an admin-applied fix converts on
 * the next scheduled turn. The only writes are the executors' own
 * already-verified lifecycles (owned fixtures with ownership-scoped
 * cleanup, native re-probes the searcher would run anyway).
 *
 * Zero-hardcoding contract: no org IDs, aliases, instance URLs, tenant
 * names, or customer values appear here or in any output. Codes are
 * platform vocabulary; detail names are caller-supplied live identifiers
 * validated before use. Raw upstream messages are matched, never echoed.
 */

import { nativeActionSucceeded } from "./action-outcome";
import { invokeAgentFlowWithProducerContext } from "./agent-customer-context";
import {
  collectFlowExecutionEvidence,
  diagnoseFlowExecutionFault,
  fetchFlowMetadataReferences,
  type FlowExecutionEvidenceCache,
} from "./flow-execution-evidence";
import { type ManagedFlowFault } from "./managed-flow-faults";

/** Family builder version: searcher-side repair consumers for retryable
 * managed-flow faults. 1: planner/gating/runner plus the inline
 * agent-context repair in the owned-substrate failure path. */
export const FLOW_FAULT_REPAIR_BUILDER_VERSION = 1;

/** Recency windows mirroring the searcher's setup_pending gating
 * (SETUP_PENDING_RETRY_MS / SETUP_PENDING_STABLE_MS): repeats re-probe
 * on human/vendor timescales so repairs never churn quota. */
export const FLOW_FAULT_REPAIR_RETRY_MS = 24 * 60 * 60 * 1000;
export const FLOW_FAULT_REPAIR_STABLE_MS = 7 * 24 * 60 * 60 * 1000;
/** Repeats before a parked fault settles onto the stable window. */
export const FLOW_FAULT_REPAIR_STABLE_REPEATS = 2;

/** Repair-consumer bounds: one bounded pass, never a retry loop. */
export const FLOW_FAULT_REPAIR_BOUNDS = {
  /** Prior-arg entries carried into a reshape re-probe. */
  priorArgs: 32,
  /** Characters kept per carried string arg (matching only). */
  argTextLength: 2000,
  /** Native re-probes per consumer run. */
  reprobes: 1,
} as const;

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const record = (value: unknown): value is Value =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const validName = (value: unknown): value is string =>
  typeof value === "string" && IDENTIFIER.test(value);

const PROVIDER_TOKEN = /^[A-Za-z][A-Za-z0-9_:]{0,127}$/;
const validProvider = (value: unknown): value is string =>
  typeof value === "string" && PROVIDER_TOKEN.test(value);

const CALLOUT_TOKEN =
  /^[A-Za-z][A-Za-z0-9_]{0,62}(?:\.[A-Za-z][A-Za-z0-9_]{0,62})?$/;
const validCallout = (value: unknown): value is string =>
  typeof value === "string" && CALLOUT_TOKEN.test(value);

const API_ROOT = /^\/services\/data\/v\d+(?:\.\d+)?$/;
const FLOW_ROUTE =
  /^\/services\/data\/v\d+(?:\.\d+)?\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/;

export type FlowFaultRepairStrategy =
  /** Run the producer-backed agent lifecycle, then re-diagnose. */
  | "agent-customer-context"
  /** Gather branch evidence and re-diagnose the opaque fault. */
  | "narrow-evidence"
  /** Reshape request-side inputs from the live descriptor, then re-probe. */
  | "reshape-inputs"
  /** Admin/vendor/human setup owns the fix; park and re-probe when due. */
  | "await-setup"
  /** Genuinely unrepairable: record terminally, no reads, no probe. */
  | "terminal";

/** Self-contained reshape directives the runner can apply from the live
 * descriptor plus prior args. `live-values` needs searcher-owned
 * discovery, so the runner parks with the directive instead of guessing. */
export type FlowFaultReshapeDirective =
  | "declared-only"
  | "json-document"
  | "live-values";

export type FlowFaultRepairDetail = {
  objectName?: string;
  fieldName?: string;
  actionElement?: string;
  providerName?: string;
  invocableName?: string;
  inputName?: string;
};

export type FlowFaultRepairPlan = {
  strategy: FlowFaultRepairStrategy;
  /** Taxonomy code consumed. */
  code: string;
  /** Fixed requirement text with only validated identifiers. */
  requirement: string;
  /** Mirrors the taxonomy verdict: only false terminalizes. */
  retryable: boolean;
  /** Validated fault detail, when the fault carried any. */
  detail?: FlowFaultRepairDetail;
  /** Reshape directive for `reshape-inputs` plans. */
  reshape?: FlowFaultReshapeDirective;
};

/** Terminal codes: taxonomy verdicts no repair can unblock. */
const TERMINAL_CODES: ReadonlySet<string> = new Set([
  "FLOW_LOOKUP_SCHEMA_SKEW",
  "SUMMARIZER_BACKEND_UNAVAILABLE",
  "MANAGED_INVOCABLE_INTERNAL",
  "AGENTIC_RETRIEVAL_BACKEND_FAULT",
  "UPSTREAM_ERROR_ID_FAULT",
  "MANAGED_FLOW_INTERVIEW_START_GACK",
  "FLOW_EXECUTION_SCHEMA_SKEW",
  "MANAGED_TRIGGER_NULL_FAULT",
  "VENDOR_DML_ROW_FAULT",
  "INTEGRATION_PROCEDURE_INPUT_UNAVAILABLE",
  "VENDOR_EMPTY_RESULT_FAULT",
  "MODEL_INFERENCE_UNAVAILABLE",
  "UDD_TARGET_ENTITY_UNRESOLVABLE",
]);

/** Retryable codes whose fix is admin, vendor, packaging, or human setup:
 * the consumer parks and re-probes when due so an applied fix converts. */
const AWAIT_SETUP_CODES: ReadonlySet<string> = new Set([
  "INVITATION_URL_PREFIX_REQUIRED",
  "FLOW_QUICK_ACTION_UNRESOLVED",
  "FLOW_ACTION_ELEMENT_UNRESOLVED",
  "FLOW_LOOKUP_FIELD_ACCESS_REQUIRED",
  "PERSON_ACCOUNTS_REQUIRED",
  "PROMPT_DATA_PROVIDER_UNAVAILABLE",
  "FLOW_RUN_PERMISSION_REQUIRED",
  "FLOW_PACKAGE_PERMISSION_REQUIRED",
  "FLOW_EXTERNAL_CALLOUT_UNAVAILABLE",
  "FLOW_EXECUTION_INVOCABLE_MISSING",
  "PACKAGE_TRIGGER_DATA_REQUIRED",
  "CALLOUT_ENDPOINT_SETUP_REQUIRED",
  "SESSION_ASSIGNMENT_REQUIRED",
  "PARDOT_DATA_ACCESS_REQUIRED",
]);

/** Retryable input-caused codes keyed by the reshape that repairs them. */
const RESHAPE_CODES: ReadonlyMap<string, FlowFaultReshapeDirective> = new Map([
  ["DECLARED_INPUT_SHAPE_REQUIRED", "declared-only"],
  ["JSON_DOCUMENT_INPUT_REQUIRED", "json-document"],
  ["SEGMENT_CONTEXT_REQUIRED", "live-values"],
  ["PROMPT_SESSION_CONTEXT_REQUIRED", "live-values"],
  ["FLOW_INPUT_IDENTIFIER_REQUIRED", "live-values"],
  ["STRUCTURED_INPUT_VALUE_REQUIRED", "live-values"],
  ["LIVE_INPUT_VALUE_REQUIRED", "live-values"],
  ["DYNAMIC_QUERY_IDENTIFIER_REQUIRED", "live-values"],
  ["ALPHANUMERIC_CONTEXT_NAME_REQUIRED", "live-values"],
  ["SCHEMA_IDENTIFIER_VALUE_REQUIRED", "live-values"],
]);

const KNOWN_CODES: ReadonlySet<string> = new Set([
  ...TERMINAL_CODES,
  ...AWAIT_SETUP_CODES,
  ...RESHAPE_CODES.keys(),
  "FLOW_AGENT_CONTEXT_REQUIRED",
  "MANAGED_FLOW_EXECUTION_FAULT",
]);

/** True when the code is a classified managed-flow fault with a repair consumer. */
export function isFlowFaultRepairCode(value: unknown): value is string {
  return typeof value === "string" && KNOWN_CODES.has(value);
}

const cleanDetail = (fault: ManagedFlowFault): FlowFaultRepairDetail => {
  const detail: FlowFaultRepairDetail = {};
  if (validName(fault.objectName)) detail.objectName = fault.objectName;
  if (validName(fault.fieldName)) detail.fieldName = fault.fieldName;
  if (validName(fault.actionElement)) detail.actionElement = fault.actionElement;
  if (validProvider(fault.providerName)) detail.providerName = fault.providerName;
  if (validCallout(fault.invocableName)) detail.invocableName = fault.invocableName;
  if (validName(fault.inputName)) detail.inputName = fault.inputName;
  return detail;
};

/**
 * Map a classified fault to its concrete repair. Pure: no reads, no
 * logging. Null for unknown codes so the existing generic pipeline
 * keeps its verdict untouched. Invalid detail is dropped but the plan
 * stands: the code is the match key, detail only narrows the repair.
 */
export function planFlowFaultRepair(
  fault: ManagedFlowFault,
): FlowFaultRepairPlan | null {
  if (!record(fault) || !isFlowFaultRepairCode(fault.code)) return null;
  const code = fault.code;
  const requirement =
    typeof fault.requirement === "string" && fault.requirement.length > 0
      ? fault.requirement
      : "A classified managed-flow fault was diagnosed; no setup requirement was recorded.";
  const detail = cleanDetail(fault);
  const extra = Object.keys(detail).length > 0 ? { detail } : {};
  if (TERMINAL_CODES.has(code)) {
    return { strategy: "terminal", code, requirement, retryable: false, ...extra };
  }
  if (code === "FLOW_AGENT_CONTEXT_REQUIRED") {
    return {
      strategy: "agent-customer-context",
      code,
      requirement,
      retryable: true,
      ...extra,
    };
  }
  if (code === "MANAGED_FLOW_EXECUTION_FAULT") {
    return {
      strategy: "narrow-evidence",
      code,
      requirement,
      retryable: true,
      ...extra,
    };
  }
  const reshape = RESHAPE_CODES.get(code);
  if (reshape) {
    return { strategy: "reshape-inputs", code, requirement, retryable: true, reshape, ...extra };
  }
  if (AWAIT_SETUP_CODES.has(code)) {
    return { strategy: "await-setup", code, requirement, retryable: true, ...extra };
  }
  return null;
}

export type FlowFaultRepairGating = {
  /** Last repair/re-probe attempt (epoch ms). Null/undefined: never attempted. */
  lastAttemptAt?: number | null;
  /** Consecutive repeats of the parked code. */
  repeatCount?: number | null;
  /** Builder version stamped on the last attempt. */
  builderVersion?: number | null;
  /** Current family builder version (freshness authority). */
  currentBuilderVersion?: number;
  /** Injected clock. */
  now?: number;
};

/**
 * True when a repair attempt is due. Mirrors the searcher's
 * setup_pending predicate exactly: builder-stale rows always pass (a
 * behavior fix re-opens every parked fault), never-attempted rows pass,
 * and repeats wait 24h — 7d once the code repeats — so repairs never
 * churn quota on human/vendor timescales.
 */
export function flowFaultRepairDue(gating: FlowFaultRepairGating = {}): boolean {
  const current = Number.isInteger(gating.currentBuilderVersion)
    ? (gating.currentBuilderVersion as number)
    : FLOW_FAULT_REPAIR_BUILDER_VERSION;
  if (!Number.isInteger(gating.builderVersion) || (gating.builderVersion as number) < current)
    return true;
  if (gating.lastAttemptAt === null || gating.lastAttemptAt === undefined) return true;
  if (!Number.isFinite(gating.lastAttemptAt)) return true;
  const now = Number.isFinite(gating.now) ? (gating.now as number) : Date.now();
  const repeats = Number.isInteger(gating.repeatCount) ? (gating.repeatCount as number) : 0;
  const window =
    repeats >= FLOW_FAULT_REPAIR_STABLE_REPEATS
      ? FLOW_FAULT_REPAIR_STABLE_MS
      : FLOW_FAULT_REPAIR_RETRY_MS;
  return gating.lastAttemptAt < now - window;
}

export type FlowFaultRepairTransport = (
  path: string,
  method?: string,
  body?: any,
) => Promise<Result>;
export type FlowFaultRepairBuild = (
  name: string,
  marker: string,
  values: Value,
) => Promise<{ values: Value } | { failure: Result }>;
/** Native re-probe seam: the caller owns arg building, the runner owns the verdict. */
export type FlowFaultRepairProbe = (args: Value) => Promise<Result>;

export type FlowFaultRepairInput = {
  fault: ManagedFlowFault;
  root: string;
  route: string;
  request: FlowFaultRepairTransport;
  /** Fixture builder for the agent-context lifecycle. */
  build?: FlowFaultRepairBuild;
  /** Re-probe implementation; defaults to a direct flow POST. */
  probe?: FlowFaultRepairProbe;
  /** Last probe args, carried into reshape/await-setup re-probes. */
  priorArgs?: unknown;
  /** Recency state; absent means never attempted (due). */
  gating?: Omit<FlowFaultRepairGating, "now" | "currentBuilderVersion">;
  /** Bounded verification window forwarded to the agent lifecycle. */
  verificationWindowMs?: number;
  cache?: FlowExecutionEvidenceCache;
  now?: () => number;
};

export type FlowFaultRepairOutcome = {
  /** repaired: native success after repair. reprobed: still faulty, new
   * fault attached. parked: gated, unexecutable, or awaiting setup.
   * terminal: genuinely unrepairable. */
  disposition: "repaired" | "reprobed" | "parked" | "terminal";
  plan: FlowFaultRepairPlan;
  /** Post-repair diagnosis (pre-repair fault when no re-probe ran). */
  fault: ManagedFlowFault | null;
  attempts: number;
  /** True when recency gating skipped the repair. */
  gated?: boolean;
  /** Reshape directive the searcher must apply (live-values only). */
  reshapeDirective?: FlowFaultReshapeDirective;
  /** Lifecycle failure code when the agent repair did not convert. */
  lifecycleCode?: string;
  /** Native success envelope when the repair converted. */
  repairedBody?: unknown;
};

const safeRequest = async (
  request: FlowFaultRepairTransport,
  path: string,
  method = "GET",
  body?: any,
): Promise<Result | null> => {
  try {
    const result =
      body === undefined
        ? await request(path, method)
        : await request(path, method, body);
    if (
      !result ||
      typeof result.status !== "number" ||
      typeof result.ok !== "boolean"
    )
      return null;
    return result;
  } catch {
    return null;
  }
};

/** Bounded JSON value carry for one prior arg: scalars plus plain
 * objects/arrays to a fixed depth, identifier keys only, text
 * truncated. Undefined when the value is unusable (safe direction:
 * the key is dropped, never guessed). Fresh containers only, so
 * circular sources cannot poison the carried shape. */
function carryValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return value;
  if (typeof value === "string") {
    if (value.length > 4000) return undefined;
    return value.slice(0, FLOW_FAULT_REPAIR_BOUNDS.argTextLength);
  }
  if (depth >= 3) return undefined;
  if (Array.isArray(value)) {
    if (value.length > 32) return undefined;
    const items: unknown[] = [];
    for (const item of value) {
      const carried = carryValue(item, depth + 1);
      if (carried === undefined) return undefined;
      items.push(carried);
    }
    return items;
  }
  if (record(value)) {
    const entries = Object.entries(value);
    if (entries.length > 32) return undefined;
    const carried: Value = {};
    for (const [key, entry] of entries) {
      if (!IDENTIFIER.test(key)) return undefined;
      const item = carryValue(entry, depth + 1);
      if (item === undefined) return undefined;
      carried[key] = item;
    }
    return carried;
  }
  return undefined;
}

/** Bounded prior-args carry: identifier keys with JSON values (the
 * re-probe replays the prior shape, so objects like the `attributes`
 * wrapper survive for the reshape to strip). Anything unparseable or
 * oversized yields no args (safe direction: fewer args, planner
 * fallthrough). */
function carryPriorArgs(priorArgs: unknown): Value | null {
  if (!record(priorArgs)) return null;
  const carried: Value = {};
  let count = 0;
  for (const [key, value] of Object.entries(priorArgs)) {
    if (count >= FLOW_FAULT_REPAIR_BOUNDS.priorArgs) break;
    if (!IDENTIFIER.test(key)) continue;
    const item = carryValue(value, 0);
    if (item === undefined) continue;
    carried[key] = item;
    count += 1;
  }
  if (count === 0) return null;
  try {
    if (JSON.stringify(carried).length > 16_000) return null;
  } catch {
    return null;
  }
  return carried;
}

/** Live-descriptor declared input names (validated, bounded). Null when
 * the descriptor is unreadable. */
function declaredInputNames(descriptorBody: unknown): Set<string> | null {
  if (!record(descriptorBody) || !Array.isArray(descriptorBody.inputs))
    return null;
  const names = new Set<string>();
  for (const field of descriptorBody.inputs.filter(record)) {
    if (
      typeof field.name === "string" &&
      IDENTIFIER.test(field.name) &&
      names.size < FLOW_FAULT_REPAIR_BOUNDS.priorArgs
    )
      names.add(field.name);
  }
  return names;
}

/** JSON-documented scalar inputs from live descriptor vocabulary: a
 * JSON-string input given a bare token faults `Unrecognized token`, so
 * only inputs whose description documents JSON are wrapped. */
function jsonDocumentedInputs(descriptorBody: unknown): Set<string> {
  const names = new Set<string>();
  if (!record(descriptorBody) || !Array.isArray(descriptorBody.inputs))
    return names;
  for (const field of descriptorBody.inputs.filter(record)) {
    if (
      typeof field.name === "string" &&
      IDENTIFIER.test(field.name) &&
      typeof field.description === "string" &&
      /\bjson\b/i.test(field.description) &&
      names.size < FLOW_FAULT_REPAIR_BOUNDS.priorArgs
    )
      names.add(field.name);
  }
  return names;
}

/**
 * Apply a planned repair, re-probe, and re-diagnose. One bounded pass:
 * at most one native re-probe (plus the agent lifecycle's own owned
 * invoke). Null when the fault has no repair plan, so unknown codes
 * keep the caller's verdict untouched.
 *
 * Disposition rules (terminalize only the genuinely unrepairable):
 * - native success after repair → repaired;
 * - a fresh taxonomy-terminal diagnosis → terminal;
 * - gated, unexecutable, transport-failed, or still-retryable → parked
 *   with the newest fault attached for the next due turn.
 */
export async function runFlowFaultRepairConsumer(
  input: FlowFaultRepairInput,
): Promise<FlowFaultRepairOutcome | null> {
  const plan = record(input) ? planFlowFaultRepair(input.fault) : null;
  if (!plan) return null;
  const parked = (
    fault: ManagedFlowFault | null,
    extra?: Partial<FlowFaultRepairOutcome>,
  ): FlowFaultRepairOutcome => ({
    disposition: "parked",
    plan,
    fault,
    attempts: 0,
    ...extra,
  });
  if (plan.strategy === "terminal") {
    return { disposition: "terminal", plan, fault: input.fault, attempts: 0 };
  }
  const now = input.now ?? Date.now;
  const gating: FlowFaultRepairGating = {
    ...(record(input.gating) ? input.gating : {}),
    currentBuilderVersion: FLOW_FAULT_REPAIR_BUILDER_VERSION,
    now: now(),
  };
  if (!flowFaultRepairDue(gating)) {
    return parked(input.fault, { gated: true });
  }
  if (
    typeof input.root !== "string" ||
    !API_ROOT.test(input.root) ||
    typeof input.route !== "string" ||
    typeof input.request !== "function"
  ) {
    return parked(input.fault);
  }

  if (plan.strategy === "agent-customer-context") {
    return runAgentContextRepair(input, plan);
  }
  if (plan.strategy === "narrow-evidence") {
    return runNarrowEvidenceRepair(input, plan);
  }
  if (plan.strategy === "reshape-inputs") {
    return runReshapeRepair(input, plan);
  }
  return runAwaitSetupReprobe(input, plan);
}

/** Producer-backed agent repair: run the lifecycle, then gate on its
 * real outcome. Lifecycle failures carry precise setup requirements,
 * so they park (another lane or an admin may supply the gap) — never
 * terminalize. */
async function runAgentContextRepair(
  input: FlowFaultRepairInput,
  plan: FlowFaultRepairPlan,
): Promise<FlowFaultRepairOutcome> {
  if (typeof input.build !== "function" || !FLOW_ROUTE.test(input.route)) {
    return { disposition: "parked", plan, fault: input.fault, attempts: 0 };
  }
  let repair: Awaited<ReturnType<typeof invokeAgentFlowWithProducerContext>>;
  try {
    repair = await invokeAgentFlowWithProducerContext({
      root: input.root,
      route: input.route,
      request: input.request,
      build: input.build,
      ...(typeof input.verificationWindowMs === "number"
        ? { verificationWindowMs: input.verificationWindowMs }
        : {}),
    });
  } catch {
    return { disposition: "parked", plan, fault: input.fault, attempts: 1 };
  }
  const verified =
    !repair.cleanupError &&
    record(repair.contextSchema) &&
    repair.contextSchema.verified === true &&
    nativeActionSucceeded(repair.status, repair.body);
  if (verified) {
    return {
      disposition: "repaired",
      plan,
      fault: null,
      attempts: 1,
      repairedBody: repair.body,
    };
  }
  const rediagnosed = diagnoseFlowExecutionFault({
    status: repair.status,
    body: repair.body,
  });
  const lifecycleCode =
    record(repair.body) && typeof repair.body.errorCode === "string"
      ? repair.body.errorCode
      : undefined;
  if (rediagnosed && rediagnosed.retryable !== true) {
    return {
      disposition: "terminal",
      plan,
      fault: rediagnosed,
      attempts: 1,
      ...(lifecycleCode ? { lifecycleCode } : {}),
    };
  }
  return {
    disposition: rediagnosed ? "reprobed" : "parked",
    plan,
    fault: rediagnosed ?? input.fault,
    attempts: 1,
    ...(lifecycleCode ? { lifecycleCode } : {}),
  };
}

/** Evidence narrowing for the opaque execution fault: flow-metadata
 * references checked against live surfaces split the generic stamp
 * into missing-invocable (parked: package alignment is admin-side) or
 * proven skew (terminal). Unverifiable evidence keeps the generic park. */
async function runNarrowEvidenceRepair(
  input: FlowFaultRepairInput,
  plan: FlowFaultRepairPlan,
): Promise<FlowFaultRepairOutcome> {
  const tail = input.route.match(FLOW_ROUTE)?.[1] ?? null;
  if (!tail) {
    return { disposition: "parked", plan, fault: input.fault, attempts: 0 };
  }
  try {
    const cache = input.cache ?? {};
    input.cache = cache;
    const refs = await fetchFlowMetadataReferences({
      root: input.root,
      flowName: tail,
      request: input.request,
      cache,
    });
    if (!refs || (refs.invocables.length === 0 && refs.schemaRefs.length === 0)) {
      return { disposition: "parked", plan, fault: input.fault, attempts: 0 };
    }
    const evidence = await collectFlowExecutionEvidence({
      root: input.root,
      request: input.request,
      invocables: refs.invocables,
      schemaRefs: refs.schemaRefs,
      cache,
    });
    if (!evidence.missingInvocable && !evidence.missingSchemaField) {
      return { disposition: "parked", plan, fault: input.fault, attempts: 0 };
    }
    // Re-diagnose the opaque sentence against the proven evidence. The
    // sentence is fixed taxonomy vocabulary (matched, never echoed from
    // any tenant), so the re-diagnosis only narrows what evidence proves.
    const narrowed = diagnoseFlowExecutionFault({
      status: 400,
      body: [
        {
          message: "An error occurred when executing a flow interview.",
          errorCode: "UNKNOWN_EXCEPTION",
        },
      ],
      evidence,
    });
    if (!narrowed) {
      return { disposition: "parked", plan, fault: input.fault, attempts: 0 };
    }
    if (narrowed.retryable !== true) {
      return { disposition: "terminal", plan, fault: narrowed, attempts: 0 };
    }
    return { disposition: "parked", plan, fault: narrowed, attempts: 0 };
  } catch {
    return { disposition: "parked", plan, fault: input.fault, attempts: 0 };
  }
}

function liveValuesNeutral(field: Value): unknown {
  switch (String(field.type ?? "STRING").toUpperCase()) {
    case "BOOLEAN": return false;
    case "INTEGER": case "INT": case "LONG": case "DOUBLE": case "DECIMAL": case "CURRENCY": case "PERCENT": return 0;
    case "DATE": return "1970-01-01";
    case "DATETIME": return "1970-01-01T00:00:00.000Z";
    case "TIME": return "00:00:00.000Z";
    default: return `probe-nonexistent-${crypto.randomUUID()}`;
  }
}
function liveValuesPicklist(field: Value): string | undefined {
  const raw = field as Value & { values?: unknown; picklistValues?: unknown };
  const candidates = Array.isArray(raw.values) ? raw.values : Array.isArray(raw.picklistValues) ? raw.picklistValues : [];
  for (const entry of candidates) {
    if (typeof entry === "string" && entry) return entry;
    if (record(entry) && typeof entry.value === "string" && entry.value && entry.active !== false) return entry.value;
  }
  return undefined;
}
function liveValuesScalarArgs(descriptorBody: unknown, carried: Value): Value | null {
  if (!record(descriptorBody) || !Array.isArray(descriptorBody.inputs)) return null;
  const shaped: Value = { ...carried };
  let added = 0;
  for (const field of descriptorBody.inputs.filter(record)) {
    if (typeof field.name !== "string" || !IDENTIFIER.test(field.name)) continue;
    if (Object.hasOwn(shaped, field.name)) continue;
    if (field.required === true) continue;
    if (field.isCollection === true || (typeof field.maxOccurs === "number" && field.maxOccurs > 1)) continue;
    if (typeof field.apexClass === "string" && field.apexClass.length > 0) continue;
    const type = String(field.type ?? "STRING").toUpperCase();
    if (type === "SOBJECT" || type === "ID" || type === "REFERENCE") continue;
    if (/(?:ids?|ids?list)$/i.test(field.name)) continue;
    shaped[field.name] = liveValuesPicklist(field) ?? liveValuesNeutral(field);
    added += 1;
    if (added >= FLOW_FAULT_REPAIR_BOUNDS.priorArgs) break;
  }
  return added > 0 ? shaped : null;
}
async function liveValuesScalarReprobe(
  input: FlowFaultRepairInput,
  plan: FlowFaultRepairPlan,
): Promise<FlowFaultRepairOutcome | null> {
  if (!FLOW_ROUTE.test(input.route)) return null;
  const carried = carryPriorArgs(input.priorArgs) ?? (record(input.priorArgs) ? {} : null);
  if (!carried) return null;
  const descriptor = await safeRequest(input.request, input.route);
  if (!descriptor?.ok) return null;
  const shaped = liveValuesScalarArgs(descriptor.body, carried);
  if (!shaped) return null;
  return reprobeWithArgs(input, plan, shaped);
}
/** Self-contained reshapes plus one re-probe. `live-values` on flow
 * routes first binds omitted optional non-reference scalars from the
 * live descriptor (verified DeleteAppt/SendConf convert) and re-probes
 * once; reference gaps still park with the directive. */
async function runReshapeRepair(
  input: FlowFaultRepairInput,
  plan: FlowFaultRepairPlan,
): Promise<FlowFaultRepairOutcome> {
  if (plan.reshape === "live-values" || !plan.reshape) {
    const populated = await liveValuesScalarReprobe(input, plan);
    if (populated) return populated;
    return {
      disposition: "parked",
      plan,
      fault: input.fault,
      attempts: 0,
      reshapeDirective: "live-values",
    };
  }
  const carried = carryPriorArgs(input.priorArgs);
  if (!carried) {
    return { disposition: "parked", plan, fault: input.fault, attempts: 0 };
  }
  const descriptor = await safeRequest(input.request, input.route);
  if (!descriptor?.ok) {
    return { disposition: "parked", plan, fault: input.fault, attempts: 0 };
  }
  let shaped: Value | null = null;
  if (plan.reshape === "declared-only") {
    const declared = declaredInputNames(descriptor.body);
    if (!declared) {
      return { disposition: "parked", plan, fault: input.fault, attempts: 0 };
    }
    shaped = {};
    for (const [key, value] of Object.entries(carried)) {
      if (declared.has(key)) shaped[key] = value;
    }
    if (Object.keys(shaped).length === Object.keys(carried).length) {
      return { disposition: "parked", plan, fault: input.fault, attempts: 0 };
    }
  } else {
    const documented = jsonDocumentedInputs(descriptor.body);
    if (documented.size === 0) {
      return { disposition: "parked", plan, fault: input.fault, attempts: 0 };
    }
    shaped = { ...carried };
    let wrapped = 0;
    for (const name of documented) {
      const value = shaped[name];
      if (typeof value !== "string" || value.length === 0) continue;
      try {
        JSON.parse(value);
        continue;
      } catch {
        // Bare token: wrap as a JSON string document.
      }
      shaped[name] = JSON.stringify(value);
      wrapped += 1;
    }
    if (wrapped === 0) {
      return { disposition: "parked", plan, fault: input.fault, attempts: 0 };
    }
  }
  return reprobeWithArgs(input, plan, shaped);
}

/** Setup-wait re-probe: the fix is admin/vendor/human-side, so the
 * repair is the re-probe itself — an applied fix converts, a repeated
 * fault re-parks under the recency gate. */
async function runAwaitSetupReprobe(
  input: FlowFaultRepairInput,
  plan: FlowFaultRepairPlan,
): Promise<FlowFaultRepairOutcome> {
  const carried = carryPriorArgs(input.priorArgs);
  if (!carried) {
    return { disposition: "parked", plan, fault: input.fault, attempts: 0 };
  }
  return reprobeWithArgs(input, plan, carried);
}

/** One native re-probe with shaped args, gated on the real outcome and
 * re-diagnosed. Only a fresh taxonomy-terminal diagnosis terminalizes. */
async function reprobeWithArgs(
  input: FlowFaultRepairInput,
  plan: FlowFaultRepairPlan,
  args: Value,
): Promise<FlowFaultRepairOutcome> {
  let probed: Result | null;
  try {
    probed =
      typeof input.probe === "function"
        ? await input.probe(args)
        : await safeRequest(input.request, input.route, "POST", {
            inputs: [args],
          });
  } catch {
    probed = null;
  }
  // An unusable probe response parks (attempt spent, verdict kept);
  // a well-formed failure — ok:false included — is diagnosed below.
  if (!probed || typeof probed.status !== "number") {
    return { disposition: "parked", plan, fault: input.fault, attempts: 1 };
  }
  if (nativeActionSucceeded(probed.status, probed.body)) {
    return {
      disposition: "repaired",
      plan,
      fault: null,
      attempts: 1,
      repairedBody: probed.body,
    };
  }
  const rediagnosed = diagnoseFlowExecutionFault({
    status: probed.status,
    body: probed.body,
  });
  if (rediagnosed && rediagnosed.retryable !== true) {
    return { disposition: "terminal", plan, fault: rediagnosed, attempts: 1 };
  }
  return {
    disposition: rediagnosed ? "reprobed" : "parked",
    plan,
    fault: rediagnosed ?? input.fault,
    attempts: 1,
  };
}
