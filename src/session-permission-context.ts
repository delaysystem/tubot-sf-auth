import { sameSalesforceId } from "./salesforce-id";

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const record = (v: any): v is Value => v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v: any): v is string => typeof v === "string" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
const succeeded = (r: Result) => r.ok && Array.isArray(r.body) && r.body.length > 0 && r.body.every(v => record(v) && v.isSuccess === true && (!Array.isArray(v.errors) || v.errors.length === 0));

/** Exercise an existing session action with an owned, empty permission set. */
export async function invokeSessionPermissionContext(input: {
  root: string; route: string; userId: string; verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
}): Promise<{ status: number; body: any; contextSchema?: Value; cleanupError?: string }> {
  const { root, request } = input;
  const action = input.route.split("/").at(-1);
  const failure = (errorCode: string, message: string): Result => ({ status: 422, ok: false, body: { errorCode, message } });
  if (!["activateSessionPermSet", "deactivateSessionPermSet"].includes(action ?? "") || !id(input.userId)) return failure("SESSION_CONTEXT_INVALID", "A discovered session action and connected execution identity are required.");
  const definitions: Value = {};
  for (const name of ["PermissionSet", "PermissionSetAssignment", "SessionPermSetActivation"]) {
    const r = await request(`${root}/sobjects/${name}/describe`);
    if (!r.ok || !record(r.body) || !Array.isArray(r.body.fields)) return r;
    definitions[name] = r.body;
  }
  if (["PermissionSet", "PermissionSetAssignment"].some(name => definitions[name].createable !== true || definitions[name].deletable !== true || definitions[name].queryable !== true) ||
    definitions.SessionPermSetActivation.queryable !== true || !["Name", "Label", "HasActivationRequired"].every(name => definitions.PermissionSet.fields.some((f: Value) => f.name === name && f.createable === true)))
    return { status: 403, body: { errorCode: "SESSION_FIXTURE_PERMISSIONS_REQUIRED", message: "Owned session context requires permission-set create/read/delete, assignment create/read/delete and activation read access; automatically run setup:context-permissions --session-permissions." } };
  const descriptor = await request(input.route);
  if (!descriptor.ok || !descriptor.body?.inputs?.some((f: Value) => f.name === "PermSetName")) return descriptor.ok ? failure("SESSION_ACTION_SCHEMA_MISMATCH", "The live session action does not expose PermSetName.") : descriptor;
  const name = `AS_session_${crypto.randomUUID().replaceAll("-", "")}`, marker = `AS probe ${crypto.randomUUID()}`;
  let permissionSetId: string | undefined, assignmentId: string | undefined, verified = false, cleanupError: string | undefined;
  let namespace: string | undefined;
  let outcome: Result = failure("SESSION_CONTEXT_UNAVAILABLE", "The owned session context could not be prepared.");
  const observedActivationIds: string[] = [];
  const query = async (soql: string): Promise<Value[]> => {
    const r = await request(`${root}/query?q=${encodeURIComponent(soql)}`);
    if (!r.ok || !Array.isArray(r.body?.records)) throw Error("Live session fixture readback failed.");
    return r.body.records;
  };
  const activations = () => query(`SELECT Id,PermissionSetId,AuthSessionId,UserId FROM SessionPermSetActivation WHERE PermissionSetId='${permissionSetId}' LIMIT 2`);
  const argumentsForSession = () => ({ PermSetName: name, ...(namespace ? { PermSetNamespace: namespace } : {}) });
  const invoke = (operation: string) => request(`${root}/actions/standard/${operation}`, "POST", { inputs: [argumentsForSession()] });
  try {
    outcome = await (async () => {
      // Reject missing activation-read permissions before creating setup fixtures.
      await query("SELECT Id FROM SessionPermSetActivation LIMIT 1");
      const created = await request(`${root}/sobjects/PermissionSet`, "POST", { Name: name, Label: marker, HasActivationRequired: true });
      if (!created.ok || !id(created.body?.id)) return created;
      permissionSetId = created.body.id;
      const actual = await request(`${root}/sobjects/PermissionSet/${permissionSetId}`);
      if (!actual.ok || actual.body?.Name !== name || actual.body?.Label !== marker || actual.body?.HasActivationRequired !== true) return failure("SESSION_PERMISSION_SET_UNVERIFIED", "The owned session permission set failed readback.");
      if (actual.body.NamespacePrefix != null) {
        if (typeof actual.body.NamespacePrefix !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(actual.body.NamespacePrefix)) return failure("SESSION_NAMESPACE_UNAVAILABLE", "The owned permission set namespace is invalid.");
        namespace = actual.body.NamespacePrefix;
      }
      const assigned = await request(`${root}/sobjects/PermissionSetAssignment`, "POST", { PermissionSetId: permissionSetId, AssigneeId: input.userId });
      if (!assigned.ok || !id(assigned.body?.id)) return assigned;
      assignmentId = assigned.body.id;
      const assignment = await request(`${root}/sobjects/PermissionSetAssignment/${assignmentId}`);
      if (!assignment.ok || assignment.body?.PermissionSetId !== permissionSetId || !sameSalesforceId(assignment.body?.AssigneeId, input.userId)) return failure("SESSION_ASSIGNMENT_UNVERIFIED", "The permission set was not assigned to the connected execution user.");
      if (action === "deactivateSessionPermSet") {
        const activated = await invoke("activateSessionPermSet");
        if (!succeeded(activated)) return activated;
        const rows = await activations();
        if (rows.length !== 1 || !id(rows[0].Id) || !sameSalesforceId(rows[0].UserId, input.userId)) return failure("SESSION_ACTIVATION_UNVERIFIED", "The prerequisite activation was not stored for the connected execution user.");
        observedActivationIds.push(rows[0].Id);
        if (input.verificationWindowMs) await new Promise(resolve => setTimeout(resolve, input.verificationWindowMs));
      }
      const result = await request(input.route, "POST", { inputs: [argumentsForSession()] });
      if (!succeeded(result)) return result;
      const rows = await activations();
      verified = action === "activateSessionPermSet" ? rows.length === 1 && id(rows[0].Id) && id(rows[0].AuthSessionId) && sameSalesforceId(rows[0].UserId, input.userId) : rows.length === 0;
      if (verified && action === "activateSessionPermSet") {
        observedActivationIds.push(rows[0].Id);
        if (input.verificationWindowMs) await new Promise(resolve => setTimeout(resolve, input.verificationWindowMs));
      }
      return verified ? result : failure("SESSION_ACTION_MUTATION_UNVERIFIED", "Salesforce returned success without the expected session activation state.");
    })();
  } catch (error) { outcome = failure("SESSION_LIFECYCLE_UNVERIFIED", error instanceof Error ? error.message : "Session context verification failed."); }
  finally {
    try {
      if (permissionSetId) {
        if ((await activations()).length) {
          const deactivated = await invoke("deactivateSessionPermSet");
          if (!succeeded(deactivated) || (await activations()).length) throw Error("Owned session activation cleanup failed.");
        }
        if (assignmentId) {
          const removed = await request(`${root}/sobjects/PermissionSetAssignment/${assignmentId}`, "DELETE");
          if (!removed.ok || (await request(`${root}/sobjects/PermissionSetAssignment/${assignmentId}`)).status !== 404) throw Error("Owned permission assignment deletion was not verified.");
        }
        const removed = await request(`${root}/sobjects/PermissionSet/${permissionSetId}`, "DELETE");
        if (!removed.ok || (await request(`${root}/sobjects/PermissionSet/${permissionSetId}`)).status !== 404) throw Error("Owned permission set deletion was not verified.");
      }
    } catch (error) { cleanupError = error instanceof Error ? error.message : "Owned session cleanup failed."; }
  }
  return { status: outcome.status, body: outcome.body, ...(cleanupError ? { cleanupError } : {}), contextSchema: {
    source: "salesforce_live_session_permission_action", targetObject: "SessionPermSetActivation", markerField: "Label", parentContextObject: "PermissionSet", parentField: "PermissionSetId",
    permissionSetId, assignmentId, permissionSetName: name, namespace, executionUserId: input.userId, verified, verificationRecordIds: observedActivationIds,
    mutationKind: action === "activateSessionPermSet" ? "create" : "delete",
    automaticSteps: ["Discover live permission and activation schemas", "Create an empty owned session permission set", "Assign it to the connected execution identity", "Invoke the current-session action", "Read actual activation state", "Deactivate and remove owned assignment and permission set"],
  } };
}
