/**
 * Fixture permission-set self-provisioning (automatic, denial-driven).
 *
 * When owned-context fixture gates deny on object CRUD, the probe used to
 * stamp setup_pending and wait for a human to run the workstation
 * setup:context-permissions script. This module applies the same
 * auto-appliable object-crud grants in-worker through the execution
 * credential itself, so current and future orgs heal without manual
 * provisioning: ensure the fixture permission set, merge full CRUD per
 * denied object, and assign the set to the execution user.
 *
 * Attempt-driven and capability-adaptive: every step queries before it
 * writes (naturally idempotent across probes, isolates, and deploys),
 * and a Tooling denial surfaces as capabilityDenied so the caller keeps
 * its honest setup_pending verdict instead of retry-looping. Only
 * validated sObject identifiers ever interpolate into Tooling calls.
 *
 * Zero-hardcoding contract: the permission-set name is a fixed product
 * convention (not org data); org, user, and objects are caller-supplied.
 */

type Result = { status: number; ok: boolean; body: any };

export type ProvisionRequest = (path: string, method?: string, body?: unknown) => Promise<Result>;

/** Product-wide fixture permission-set convention (created when missing). */
export const FIXTURE_PERMSET_NAME = "ActionSearcher_Context_Fixtures";
const FIXTURE_PERMSET_LABEL = "ActionSearcher Context Fixtures";

export type ProvisionOutcome = {
  /** Objects confirmed granted after this call (newly applied or already present). */
  granted: string[];
  /** Objects whose grant write was refused or failed. */
  failed: Array<{ object: string; status: number }>;
  /** True when the execution identity was confirmed assigned to the fixture set. */
  assigned: boolean;
  /** True when Tooling refused permission-set management itself (admin must provision). */
  capabilityDenied: boolean;
};

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const MAX_OBJECTS = 12;

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && SF_ID.test(v);
const rowsOf = (body: unknown): Array<Record<string, unknown>> =>
  record(body) && Array.isArray(body.records) ? body.records.filter(record) : [];

const denied = (result: Result): boolean => {
  if (result.ok) return false;
  if (result.status === 403) return true;
  const items = Array.isArray(result.body) ? result.body : [result.body];
  return items.some((item) => {
    const code = record(item) ? item.errorCode : null;
    return code === "INSUFFICIENT_ACCESS_OR_READONLY" || code === "INSUFFICIENT_ACCESS" ||
      code === "INVALID_CROSS_REFERENCE_KEY" || code === "NOT_FOUND";
  });
};

/**
 * Ensure full fixture CRUD for the denied objects and assign the fixture
 * set to the execution user. Returns what holds after the call; never
 * throws on Salesforce denials (they are the capability signal).
 */
export async function selfProvisionFixtureGrants(input: {
  root: string;
  userId: string;
  objects: string[];
  request: ProvisionRequest;
}): Promise<ProvisionOutcome> {
  const { root, request } = input;
  const outcome: ProvisionOutcome = { granted: [], failed: [], assigned: false, capabilityDenied: false };
  if (!SF_ID.test(input.userId)) { outcome.capabilityDenied = true; return outcome; }
  const objects = [...new Set(input.objects.filter((o) => OBJECT_NAME.test(o)))].slice(0, MAX_OBJECTS);
  if (!objects.length) { outcome.capabilityDenied = true; return outcome; }
  const tooling = `${root}/tooling`;

  const findPermset = await request(`${tooling}/query?q=${encodeURIComponent(
    `SELECT Id FROM PermissionSet WHERE Name = '${FIXTURE_PERMSET_NAME}' LIMIT 1`)}`);
  if (!findPermset.ok) { outcome.capabilityDenied = true; return outcome; }
  let permsetId = rowsOf(findPermset.body)[0]?.Id;
  if (!id(permsetId)) {
    const created = await request(`${tooling}/sobjects/PermissionSet`, "POST",
      { Name: FIXTURE_PERMSET_NAME, Label: FIXTURE_PERMSET_LABEL });
    permsetId = record(created.body) ? created.body.id : null;
    if (!created.ok || !id(permsetId)) { outcome.capabilityDenied = true; return outcome; }
  }

  for (const object of objects) {
    const existing = await request(`${tooling}/query?q=${encodeURIComponent(
      `SELECT Id, PermissionsCreate, PermissionsRead, PermissionsEdit, PermissionsDelete FROM ObjectPermissions WHERE ParentId = '${permsetId}' AND SobjectType = '${object}' LIMIT 1`)}`);
    if (!existing.ok) {
      if (denied(existing)) outcome.failed.push({ object, status: existing.status });
      else outcome.failed.push({ object, status: existing.status });
      continue;
    }
    const row = rowsOf(existing.body)[0];
    const full = row !== undefined && row.PermissionsCreate === true && row.PermissionsRead === true &&
      row.PermissionsEdit === true && row.PermissionsDelete === true;
    if (full) { outcome.granted.push(object); continue; }
    const write = id(row?.Id)
      ? await request(`${tooling}/sobjects/ObjectPermissions/${row.Id}`, "PATCH",
        { PermissionsCreate: true, PermissionsRead: true, PermissionsEdit: true, PermissionsDelete: true })
      : await request(`${tooling}/sobjects/ObjectPermissions`, "POST",
        { ParentId: permsetId, SobjectType: object, PermissionsCreate: true, PermissionsRead: true, PermissionsEdit: true, PermissionsDelete: true });
    if (write.ok) outcome.granted.push(object);
    else outcome.failed.push({ object, status: write.status });
  }

  const assigned = await request(`${tooling}/query?q=${encodeURIComponent(
    `SELECT Id FROM PermissionSetAssignment WHERE PermissionSetId = '${permsetId}' AND AssigneeId = '${input.userId}' LIMIT 1`)}`);
  if (assigned.ok && id(rowsOf(assigned.body)[0]?.Id)) {
    outcome.assigned = true;
    return outcome;
  }
  if (!assigned.ok && denied(assigned)) { outcome.capabilityDenied = true; return outcome; }
  const grant = await request(`${tooling}/sobjects/PermissionSetAssignment`, "POST",
    { PermissionSetId: permsetId, AssigneeId: input.userId });
  if (grant.ok) outcome.assigned = true;
  else if (denied(grant)) outcome.capabilityDenied = true;
  return outcome;
}
