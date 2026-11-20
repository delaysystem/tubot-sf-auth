/**
 * Guarded shared-resource lifecycle for schedule-overlap-fix invocable Apex.
 *
 * Root cause (blind-verified 2026-10-06, live native probes): the family
 * reschedules a service resource's overlapping appointments inside a day
 * window, so the verb skip parks it forever — yet no owned resource can
 * ever back a fixture (Salesforce rejects a second Technician resource per
 * user with DUPLICATE_VALUE). The only sound probe reuses the
 * integration-user resource behind a proven-empty far-future window: the
 * action cannot change what does not exist, and a strict after-guard
 * proves the window stayed empty (a concurrent arrival fails verification
 * instead of claiming success).
 *
 * This module runs that shape for ANY custom/apex action declaring the
 * overlap-fix contract (resource + scheduling policy + resource timezone +
 * day-window datetimes): resolve the single active integration-user
 * resource, a live scheduling policy, and the live org timezone; prove
 * the +30d window holds zero appointments for the resource; invoke; prove
 * the window is still empty. No fixtures are created, so no cleanup
 * applies. No class name, org id, alias, or URL appears here; any
 * ambiguity or any window occupancy refuses with no apex POST.
 */

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const ACTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
/** IANA timezone keys (`Area/Location[/Subzone]`) as stored on Organization. */
const TIMEZONE_KEY = /^[A-Za-z][A-Za-z0-9_+\-]*\/[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)?$/;
/** Far-future probe window offset: real scheduling rarely reaches it. */
const WINDOW_OFFSET_DAYS = 30;

const record = (value: unknown): value is Value =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && SF_ID.test(value);

const fail = (errorCode: string, message: string, extra?: Value): Result => ({
  status: 422, ok: false, body: { errorCode, message, ...extra },
});

/**
 * Parse a live invocable-apex route. Returns the class name, or null when
 * the route is not in this family. Classification uses the route shape
 * only; no class name is ever enumerated here.
 */
export function apexOverlapActionName(route: string): string | null {
  const match = typeof route === "string"
    ? route.match(/^\/services\/data\/v\d+(?:\.\d+)?\/actions\/custom\/apex\/([A-Za-z][A-Za-z0-9_]{0,127})$/)
    : null;
  const name = match?.[1] ?? null;
  return name !== null && ACTION_NAME.test(name) ? name : null;
}

const REQUIRED_CONTRACT = ["ResourceId", "SchedulingPolicyId", "ResourceTimeZone", "StartTime", "EndTime"];

/** True when the live descriptor declares exactly the overlap-fix contract. */
export function apexOverlapContractValid(descriptorInputs: unknown): boolean {
  if (!Array.isArray(descriptorInputs)) return false;
  const inputs = descriptorInputs.filter(record);
  if (inputs.some((field) => typeof field.name !== "string" || !FIELD_NAME.test(field.name))) return false;
  const required = new Set(inputs.filter((field) => field.required === true).map((field) => field.name as string));
  if (required.size !== REQUIRED_CONTRACT.length) return false;
  return REQUIRED_CONTRACT.every((name) => required.has(name));
}

/** Probe day window in UTC day boundaries, far enough out to sit empty. */
export function apexOverlapWindowDays(now = Date.now()): { start: string; end: string } {
  const day = new Date(now + WINDOW_OFFSET_DAYS * 86_400_000);
  day.setUTCHours(0, 0, 0, 0);
  const start = day.toISOString();
  const end = new Date(day.getTime() + 86_400_000 - 1).toISOString();
  return { start, end };
}

/** True for a genuinely accepted action envelope (no outputs declared). */
export function apexOverlapAccepted(status: number, body: unknown): boolean {
  if (!(status >= 200 && status < 300) || !Array.isArray(body) || body.length !== 1) return false;
  const item = body[0];
  if (!record(item) || item.isSuccess !== true) return false;
  if (!(item.errors === null || item.errors === undefined ||
    (Array.isArray(item.errors) && item.errors.length === 0))) return false;
  if ((typeof item.errorCode === "string" && item.errorCode !== "") ||
    (typeof item.errorMessage === "string" && item.errorMessage !== "")) return false;
  return true;
}

export type ApexOverlapLifecycleInput = {
  root: string;
  route: string;
  /** Live integration-user id whose resource is reused; never guessed. */
  ownerUserId: string;
  verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
};

const liveId = (body: unknown): string | null => {
  const rows = record(body) && Array.isArray(body.records) ? body.records.filter(record) : [];
  const row = rows.find((candidate) => identity(candidate.Id));
  return row ? row.Id as string : null;
};

export async function invokeApexOverlapWithContext(input: ApexOverlapLifecycleInput): Promise<{
  status: number; body: any; cleanupError?: string; contextSchema?: Value;
}> {
  const { root, request } = input;
  const action = apexOverlapActionName(input.route);
  const automaticSteps = [
    "Resolve the single active integration-user resource, a live policy, and the org timezone",
    "Prove the far-future probe window holds zero appointments for the resource",
    "Invoke the overlap fix inside the proven-empty window",
    "Prove the window stayed empty; no fixtures exist so no cleanup applies",
  ];
  const base = { source: "salesforce_live_apex_overlap_action", action, automaticSteps };
  const done = (outcome: Result, extra: Value): { status: number; body: any; cleanupError?: string; contextSchema?: Value } => ({
    status: outcome.status, body: outcome.body,
    contextSchema: { ...base, ...extra },
  });
  if (!action || !root.startsWith("/services/data/") || !input.route.startsWith(`${root}/actions/`)) {
    return done(fail("APEX_OVERLAP_ACTION_INVALID", "A discovered invocable apex route is required."), { verified: false });
  }
  if (!identity(input.ownerUserId)) {
    return done(fail("APEX_OVERLAP_OWNER_INVALID", "A live integration-user identity is required; none is ever guessed."), { verified: false });
  }
  if (input.verificationWindowMs !== undefined &&
    (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail("APEX_OVERLAP_WINDOW_INVALID", "A bounded verification window is required."), { verified: false });
  }
  let outcome: Result = fail("APEX_OVERLAP_CONTEXT_UNAVAILABLE", "The owned apex overlap context could not be prepared.");
  let verified = false;
  let resourceId: string | null = null;
  let policyId: string | null = null;
  let timeZone: string | null = null;
  let windowStart = "";
  let windowEnd = "";
  let guardBefore: number | null = null;
  let guardAfter: number | null = null;
  try {
    outcome = await (async (): Promise<Result> => {
      const descriptor = await request(input.route);
      if (!descriptor.ok) return descriptor;
      if (!apexOverlapContractValid(record(descriptor.body) ? descriptor.body.inputs : undefined)) {
        return fail("APEX_OVERLAP_CONTRACT_UNSUPPORTED",
          "The live descriptor does not declare the overlap-fix contract; the native call was not attempted.");
      }
      const resources = await request(`${root}/query?q=${encodeURIComponent(
        `SELECT Id FROM ServiceResource WHERE RelatedRecordId='${input.ownerUserId}' AND IsActive=true ORDER BY Id LIMIT 2`)}`);
      const resourceRows = record(resources.body) && Array.isArray(resources.body.records)
        ? resources.body.records.filter(record).map((row) => row.Id).filter(identity) : [];
      if (!resources.ok || resourceRows.length < 1) {
        return fail("APEX_OVERLAP_RESOURCE_ABSENT",
          "No active service resource backs the integration user; the native call was not attempted.");
      }
      if (resourceRows.length > 1) {
        return fail("APEX_OVERLAP_RESOURCE_AMBIGUOUS",
          "Two-plus active service resources back the integration user; the native call was not attempted.");
      }
      resourceId = resourceRows[0];
      const policy = await request(`${root}/query?q=${encodeURIComponent(
        "SELECT Id FROM FSL__Scheduling_Policy__c ORDER BY Name LIMIT 1")}`);
      policyId = policy.ok ? liveId(policy.body) : null;
      if (!policyId) {
        return fail("APEX_OVERLAP_POLICY_ROWLESS",
          "No live scheduling policy backs the probe window; the native call was not attempted.");
      }
      const organization = await request(`${root}/query?q=${encodeURIComponent(
        "SELECT TimeZoneSidKey FROM Organization LIMIT 1")}`);
      const zone = record(organization.body) && Array.isArray(organization.body.records)
        ? organization.body.records.filter(record).find((row) =>
          typeof row.TimeZoneSidKey === "string" && TIMEZONE_KEY.test(row.TimeZoneSidKey))?.TimeZoneSidKey as string | undefined
        : undefined;
      if (!organization.ok || !zone) {
        return fail("APEX_OVERLAP_TIMEZONE_UNAVAILABLE",
          "No live organization timezone backs the probe window; the native call was not attempted.");
      }
      timeZone = zone;
      const window = apexOverlapWindowDays();
      windowStart = window.start;
      windowEnd = window.end;
      const guardSoql = `SELECT Id FROM ServiceAppointment WHERE Id IN (SELECT ServiceAppointmentId FROM AssignedResource WHERE ServiceResourceId='${resourceId}') AND SchedStartTime < ${windowEnd} AND SchedEndTime > ${windowStart} LIMIT 1`;
      const before = await request(`${root}/query?q=${encodeURIComponent(guardSoql)}`);
      const beforeRows = record(before.body) && Array.isArray(before.body.records) ? before.body.records : null;
      if (!before.ok || !beforeRows) return before;
      guardBefore = beforeRows.length;
      if (beforeRows.length > 0) {
        return fail("APEX_OVERLAP_WINDOW_OCCUPIED",
          "The probe window holds live appointments for the resource; the native call was not attempted.");
      }
      const invoked = await request(input.route, "POST", { inputs: [{
        ResourceId: resourceId, SchedulingPolicyId: policyId, ResourceTimeZone: timeZone,
        StartTime: windowStart, EndTime: windowEnd,
      }] });
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, input.verificationWindowMs));
      const after = await request(`${root}/query?q=${encodeURIComponent(guardSoql)}`);
      const afterRows = record(after.body) && Array.isArray(after.body.records) ? after.body.records : null;
      if (!after.ok || !afterRows) return after;
      guardAfter = afterRows.length;
      if (afterRows.length > 0) {
        return fail("APEX_OVERLAP_WINDOW_DIRTIED",
          "The probe window gained appointments around the invoke; overlap-fix success could not be verified.");
      }
      verified = apexOverlapAccepted(invoked.status, invoked.body);
      return invoked;
    })();
  } catch {
    if (outcome.body?.errorCode === "APEX_OVERLAP_CONTEXT_UNAVAILABLE") {
      outcome = fail("APEX_OVERLAP_LIFECYCLE_UNVERIFIED", "The owned apex overlap lifecycle failed.");
    }
    verified = false;
  }
  return done(outcome, {
    verified,
    resourceId, policyId, timeZone, windowStart, windowEnd,
    guardBefore, guardAfter,
    verificationRecordIds: resourceId ? [resourceId] : [],
  });
}
