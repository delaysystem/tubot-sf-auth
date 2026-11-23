/**
 * Owned research-lifecycle context (`knowledgeSpaceRunResearch`,
 * `KnowledgeSpaceDeepResearchCancel`, `knowledgeSpaceViewReport`).
 *
 * Root cause (blind-verified 2026-10-03 via `sf` CLI in BOTH orgs):
 * DataKnowledgeSpaceSession IS insertable/queryable/deletable (Name-only
 * insert returns an id; deletion verifies absent; both orgs scrubbed back
 * to 0 rows), but no API-insertable row unblocks these actions. A live
 * session id, a linked DataKnowledgeRsrchRpt id, SessionKey, and
 * ReportIdentifier were each passed as researchId and every variant fails
 * natively: run/view hit an upstream istio-envoy 404 ("Failed to run deep
 * research", "Failed to load deep research report metadata"), cancel
 * answers "Research ID not found. Unable to resolve from session or
 * input.", and runResearch with empty inputs answers "Research ID is
 * required ... ensure the current session is linked to a research" (the
 * interactive caller session, not an insertable row). The researchId is
 * minted only by a genuine Deep Research run; it cannot be fabricated.
 *
 * This module therefore runs an honest owned lifecycle: it discovers live
 * substrate counts, returns setup-blocked WITHOUT invoking when the
 * substrate is empty, and otherwise creates one owned session fixture,
 * invokes with its id, classifies the native outcome, and deletes only
 * the owned fixture with verified absence. No org id, alias, username,
 * or URL appears here; every tenant value is caller-supplied or read live.
 */

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const ACTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

import { clampVerificationWindowMs } from "./verification-window";

export const RESEARCH_SESSION_OBJECT = "DataKnowledgeSpaceSession";
export const RESEARCH_REPORT_OBJECT = "DataKnowledgeRsrchRpt";
export const RESEARCH_SPACE_OBJECT = "DataKnowledgeSpace";
export const RESEARCH_FIXTURE_MARKER_FIELD = "Name";
export const RESEARCH_SUBSTRATE_OBJECTS = [RESEARCH_SESSION_OBJECT, RESEARCH_REPORT_OBJECT, RESEARCH_SPACE_OBJECT] as const;
/** Fixed setup requirement; no upstream or tenant values interpolated. */
export const RESEARCH_REQUIRED_SETUP =
  "Run a genuine Deep Research workflow in this org so its service mints a resolvable researchId, then retry.";

/** In-scope standard actions, keyed lowercase; route case is preserved. */
const RESEARCH_ACTIONS = new Set([
  "knowledgespacerunresearch",
  "knowledgespacedeepresearchcancel",
  "knowledgespaceviewreport",
]);
/** Family builder version: owned research-session lifecycle with substrate pre-checks. 80: the unresolvable end-state (substrate present, no researchId resolves) terminalizes; only the absent shape stays pending. */
export const RESEARCH_LIFECYCLE_BUILDER_VERSION = 80;

const record = (value: unknown): value is Value =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && SF_ID.test(value);

const fail = (errorCode: string, message: string, extra?: Value): Result => ({
  status: 422, ok: false, body: { errorCode, message, ...extra },
});

/**
 * Parse a live research route. Returns the action name, or null when the
 * route is not one of the three in-scope standard actions.
 */
export function researchActionName(route: string): string | null {
  const match = typeof route === "string"
    ? route.match(/^\/services\/data\/v\d+(?:\.\d+)?\/actions\/standard\/([A-Za-z][A-Za-z0-9_]{0,127})$/)
    : null;
  const name = match?.[1] ?? null;
  return name !== null && ACTION_NAME.test(name) && RESEARCH_ACTIONS.has(name.toLowerCase()) ? name : null;
}

/** True when the action belongs to the owned research lifecycle. */
export function isResearchOwnedContextRoute(route: string, actionType?: string): boolean {
  if (researchActionName(route) === null) return false;
  return actionType === undefined || actionType === "standard";
}

/**
 * Resolve the researchId input (and the optional workflow-action input)
 * from the live descriptor inputs. Names match case-insensitively; no
 * input name is ever assumed.
 */
export function researchInvocationInputs(descriptorInputs: unknown): {
  researchIdField: string; workflowField?: string;
} | { failure: string } {
  const inputs = Array.isArray(descriptorInputs) ? descriptorInputs.filter(record) : [];
  const named = inputs.filter((field): field is Value & { name: string } =>
    typeof field.name === "string" && FIELD_NAME.test(field.name));
  const researchIdField = named.find((field) => field.name.toLowerCase() === "researchid")?.name;
  if (!researchIdField) {
    return { failure: "The live research action does not declare a researchId input." };
  }
  const workflowField = named.find((field) => field.name.toLowerCase() === "deepresearchworkflowaction")?.name;
  return workflowField ? { researchIdField, workflowField } : { researchIdField };
}

/** True when every envelope item reports success with no errors. */
export function researchRunAccepted(status: number, body: unknown): boolean {
  if (!(status >= 200 && status < 300) || !Array.isArray(body) || body.length === 0) return false;
  return body.every((item) =>
    record(item) && item.isSuccess === true &&
    (item.errors === null || item.errors === undefined || (Array.isArray(item.errors) && item.errors.length === 0)));
}

const researchFaultTexts = (body: unknown): string[] => {
  const parts: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4) return;
    if (typeof node === "string") {
      if (node.length > 0 && node.length < 2000) parts.push(node);
      return;
    }
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    if (!record(node)) return;
    for (const key of ["message", "errorMessage", "error_description", "errorCode", "statusCode", "code"]) {
      if (typeof node[key] === "string" && node[key].length) parts.push(node[key]);
    }
    for (const key of ["errors", "outputValues", "result", "body"]) {
      if (node[key] !== undefined && node[key] !== null) visit(node[key], depth + 1);
    }
  };
  visit(body, 0);
  return parts;
};

/**
 * True when upstream reports the research substrate gap: an unresolvable
 * or required researchId, or the upstream metadata/run 404 behind
 * run/view. Matched vocabulary is never echoed into reasons.
 */
export function researchSubstrateFault(body: unknown): boolean {
  const text = researchFaultTexts(body).join(" ").toLowerCase();
  return /research id (not found|is required)|unable to resolve from session|failed to (run deep research|load deep research report metadata)/.test(text);
}

export type ResearchSubstrateCounts = { sessions: number; reports: number; spaces: number };

/**
 * Bounded read-only capability pre-check: COUNT() rows on the three
 * research substrate objects. The session count is authoritative (the
 * fixture object); report/space counts are best-effort evidence and
 * report -1 when unreadable.
 */
export async function researchSubstrateStatus(input: {
  root: string;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
}): Promise<ResearchSubstrateCounts | { failure: string }> {
  const count = async (objectName: string): Promise<number | null> => {
    const response = await input.request(`${input.root}/query?q=${encodeURIComponent(`SELECT COUNT() FROM ${objectName}`)}`);
    const total = record(response.body) ? response.body.totalSize : undefined;
    return response.ok && typeof total === "number" && Number.isInteger(total) && total >= 0 ? total : null;
  };
  const sessions = await count(RESEARCH_SESSION_OBJECT);
  if (sessions === null) {
    return { failure: "The live research session substrate could not be read; execution-user read access is required." };
  }
  return {
    sessions,
    reports: (await count(RESEARCH_REPORT_OBJECT)) ?? -1,
    spaces: (await count(RESEARCH_SPACE_OBJECT)) ?? -1,
  };
}

export type ResearchLifecycleInput = {
  root: string;
  route: string;
  verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
};

export async function invokeResearchWithOwnedContext(input: ResearchLifecycleInput): Promise<{
  status: number; body: any; cleanupError?: string; contextSchema?: Value;
}> {
  const { root, request } = input;
  const action = researchActionName(input.route);
  const automaticSteps = [
    "Count the live research substrate rows (session, report, space)",
    "Create an owned research session carrying a unique verifiable marker",
    "Invoke the native action with the owned session id as researchId",
    "Classify the native outcome against the blind-verified fault shapes",
    "Delete only the owned session and verify absence",
  ];
  const base = { source: "salesforce_live_research_action", action, targetObject: RESEARCH_SESSION_OBJECT, automaticSteps };
  const done = (outcome: Result, extra: Value): { status: number; body: any; cleanupError?: string; contextSchema?: Value } => ({
    status: outcome.status, body: outcome.body,
    ...(typeof extra.cleanupError === "string" ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...base, ...extra },
  });
  if (!action || !root.startsWith("/services/data/") || !input.route.startsWith(`${root}/actions/`)) {
    return done(fail("RESEARCH_ACTION_INVALID", "A discovered standard research action route is required."), { verified: false });
  }
  if (input.verificationWindowMs !== undefined &&
    (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail("RESEARCH_WINDOW_INVALID", "A bounded verification window is required."), { verified: false });
  }
  const marker = `RS probe ${crypto.randomUUID()}`;
  let cleanupError: string | undefined;
  let outcome: Result = fail("RESEARCH_CONTEXT_UNAVAILABLE", "The owned research context could not be prepared.");
  let verified = false;
  let ownedId: string | undefined;
  let substrate: ResearchSubstrateCounts | undefined;
  let researchIdField: string | undefined;
  try {
    outcome = await (async (): Promise<Result> => {
      const descriptor = await request(input.route);
      if (!descriptor.ok) return descriptor;
      const mapped = researchInvocationInputs(record(descriptor.body) ? descriptor.body.inputs : undefined);
      if ("failure" in mapped) return fail("RESEARCH_ACTION_SCHEMA_MISMATCH", mapped.failure);
      researchIdField = mapped.researchIdField;
      const schema = await request(`${root}/sobjects/${RESEARCH_SESSION_OBJECT}/describe`);
      if (!schema.ok || !record(schema.body) || schema.body.createable !== true ||
        schema.body.deletable !== true || schema.body.queryable !== true || !Array.isArray(schema.body.fields)) {
        return fail("RESEARCH_FIXTURE_PERMISSIONS_REQUIRED",
          "Automatic research context requires live research-session create, read and delete access.",
          { setupRequirement: "DataKnowledgeSpaceSession create/read/delete access for the execution user." });
      }
      const status = await researchSubstrateStatus({ root, request });
      if ("failure" in status) {
        return fail("RESEARCH_SUBSTRATE_UNREADABLE", status.failure,
          { setupRequirement: "DataKnowledgeSpaceSession read access for the execution user." });
      }
      substrate = status;
      if (substrate.sessions === 0 && substrate.reports === 0 && substrate.spaces === 0) {
        // The native call is never made with an invented identity: with no
        // substrate rows, no researchId can resolve (blind-verified).
        return fail("RESEARCH_SUBSTRATE_ABSENT",
          "The org is missing research substrate: the research session, report and space objects hold no rows. " +
          RESEARCH_REQUIRED_SETUP,
          { setupRequirement: RESEARCH_REQUIRED_SETUP, substrate });
      }
      const built = await input.build(RESEARCH_SESSION_OBJECT, marker, { [RESEARCH_FIXTURE_MARKER_FIELD]: marker });
      if ("failure" in built) return built.failure;
      if (built.values[RESEARCH_FIXTURE_MARKER_FIELD] !== marker) {
        return fail("RESEARCH_BUILD_UNSCOPED", "The fixture builder changed a planned ownership field.");
      }
      const created = await request(`${root}/sobjects/${RESEARCH_SESSION_OBJECT}`, "POST", built.values);
      const createdId: unknown = created.body?.id ?? created.body?.Id;
      if (!created.ok || !identity(createdId)) return created;
      ownedId = createdId;
      const actual = await request(`${root}/sobjects/${RESEARCH_SESSION_OBJECT}/${ownedId}`);
      if (!actual.ok || actual.body?.[RESEARCH_FIXTURE_MARKER_FIELD] !== marker) {
        return fail("RESEARCH_FIXTURE_UNVERIFIED", "The owned fixture readback did not carry the marker.");
      }
      const args: Value = { [researchIdField]: ownedId };
      if (action.toLowerCase() === "knowledgespaceviewreport" && mapped.workflowField) {
        args[mapped.workflowField] = "VIEW_REPORT";
      }
      const invoked = await request(input.route, "POST", { inputs: [args] });
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
      if (researchRunAccepted(invoked.status, invoked.body)) {
        verified = true;
        return invoked;
      }
      if (researchSubstrateFault(invoked.body)) {
        // Even with substrate rows present, a fabricated researchId never
        // resolves (blind-verified across session, report, and key ids).
        return {
          ...fail("RESEARCH_SUBSTRATE_UNRESOLVABLE",
            "The org is missing runnable research: the native service could not resolve the researchId. " +
            RESEARCH_REQUIRED_SETUP,
            { setupRequirement: RESEARCH_REQUIRED_SETUP, substrate, upstreamOutcome: invoked.body }),
        };
      }
      return invoked;
    })();
  } catch {
    if (outcome.body?.errorCode === "RESEARCH_CONTEXT_UNAVAILABLE") {
      outcome = fail("RESEARCH_LIFECYCLE_UNVERIFIED", "The owned research lifecycle failed; ownership-scoped cleanup still runs.");
    }
    verified = false;
  } finally {
    if (ownedId) {
      await request(`${root}/sobjects/${RESEARCH_SESSION_OBJECT}/${ownedId}`, "DELETE");
      const check = await request(`${root}/sobjects/${RESEARCH_SESSION_OBJECT}/${ownedId}`);
      if (check.status !== 404) {
        cleanupError = "Owned research fixture cleanup could not be verified; the record may still exist.";
      } else {
        const swept = await request(`${root}/query?q=${encodeURIComponent(
          `SELECT Id FROM ${RESEARCH_SESSION_OBJECT} WHERE ${RESEARCH_FIXTURE_MARKER_FIELD}='${marker}' LIMIT 2`)}`);
        const rows = record(swept.body) && Array.isArray(swept.body.records) ? swept.body.records : null;
        if (!swept.ok || !rows || rows.length > 0) {
          cleanupError = "Owned research fixture cleanup could not be verified; a marker-scoped sibling may remain.";
        }
      }
    }
  }
  return done(outcome, {
    verified: cleanupError ? false : verified,
    marker, markerField: RESEARCH_FIXTURE_MARKER_FIELD,
    ownedRecordId: ownedId ?? null,
    researchIdField: researchIdField ?? null,
    substrate: substrate ?? null,
    verificationRecordIds: ownedId ? [ownedId] : [],
    ...(cleanupError ? { cleanupError } : {}),
  });
}
