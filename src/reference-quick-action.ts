import { seedRequiredReferenceValues } from "./fixture-reference-seeding";
import { quickActionFailurePlanners, quickActionRouteTerminal } from "./quick-action-owned-context";
import { reclaimFixtureOwnerForDelete } from "./fixture-owner-reclaim";
import { grantFamilyForCleanupDenial } from "./permission-denial-grants";

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

/**
 * Family builder version (first worker-owned version; set above every
 * in-tree family version so stale searcher rows reselect): 126 seeds the
 * owned parent's required references (Case.BusinessHoursId) from live
 * lookups so chatterPost and markerless quick-action creation re-probe past
 * OWNED_CONTEXT_REQUIRED_REFERENCE_UNRESOLVED. 127: searcher-side
 * vocabulary-seed fallback (record actions reselect for target discovery).
 * 128: searcher-side live-catalog top-up generalized to every record
 * action (chatterPost reselects for target discovery).
 */
export const REFERENCE_QUICK_ACTION_BUILDER_VERSION = 128;
const record = (v: any): v is Value => v !== null && typeof v === "object" && !Array.isArray(v);
const safe = (v: any): v is string => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(v);
const id = (v: any): v is string => typeof v === "string" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);

/** Own a reference-only child through a disposable parent and the exact reference tuple. */
export async function invokeReferenceQuickAction(input: {
  root: string; route: string; target: string; parent: string; parentField: string;
  fields: Value[]; inputs: Value[]; integrationUserId: string; verificationWindowMs?: number;
  contextInputName?: string; markerInputName?: string; markerTargetField?: string; outputRecordField?: string; source?: string;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (objectName: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
}): Promise<{ status: number; body: any; contextSchema?: Value; cleanupError?: string }> {
  const { root, request } = input;
  const failure = (code: string, message: string) => ({ status: 422, body: { errorCode: code, message } });
  const parentField = input.fields.find(f => f.name === input.parentField);
  if (parentField?.type !== "reference" || !parentField.referenceTo?.includes(input.parent))
    return failure("QUICK_ACTION_PARENT_SCHEMA_MISMATCH", "The live child reference does not point to its declared context.");
  const parentSchema = await request(`${root}/sobjects/${input.parent}/describe`);
  const parentFields = record(parentSchema.body) && Array.isArray(parentSchema.body.fields) ? parentSchema.body.fields.filter(record) : [];
  if (!parentSchema.ok || parentSchema.body?.createable !== true || parentSchema.body?.queryable !== true || parentSchema.body?.deletable !== true)
    return { status: 403, body: { errorCode: "QUICK_ACTION_PARENT_PERMISSIONS_REQUIRED", message: "The disposable reference parent needs create/read/delete access.",
      setupRequirement: `${input.parent} create/read/delete access for the execution user.` } };
  const candidates = parentFields.filter(f => safe(f.name) && f.createable === true && f.filterable === true &&
    f.calculated !== true && f.autoNumber !== true && f.type === "string" && f.length >= 24 && !parentFields.some(c => c.compoundFieldName === f.name));
  const markerField = candidates.find(f => f.nameField) ?? candidates.find(f => f.nillable === false) ?? candidates[0];
  if (!markerField) return { ...failure("QUICK_ACTION_PARENT_MARKER_UNAVAILABLE", "The live parent has no writable, queryable ownership marker."), contextSchema: { source: "salesforce_live_reference_context_discovery", parentContextObject: input.parent, fields: parentFields.filter(f => ["string", "textarea", "combobox"].includes(f.type)).slice(0, 40).map(f => ({ name: f.name, type: f.type, createable: f.createable, filterable: f.filterable, calculated: f.calculated, autoNumber: f.autoNumber, nameField: f.nameField, nillable: f.nillable, length: f.length, compoundFieldName: f.compoundFieldName })) } };
  const marker = `AS probe ${crypto.randomUUID()}`.slice(0, markerField.length);
  // Required parent references (Case.BusinessHoursId) seed from live
  // lookups; borrowed rows are never written, and unresolved fields fail
  // honest through the builder as before. The unique marker stays
  // authoritative over borrowed live ids.
  const refSeed = await seedRequiredReferenceValues(request, root, parentFields);
  const built = await input.build(input.parent, marker, { ...refSeed.overrides, [markerField.name]: marker });
  if ("failure" in built) return built.failure;
  const owned: Array<{ objectName: string; id: string }> = [];
  const args: Value = {}, references: Value = {};
  let verified = false, cleanupError: string | undefined;
  let outcome: { status: number; body: any } = failure("QUICK_ACTION_REFERENCE_CONTEXT_UNAVAILABLE", "The declared references could not be prepared.");
  let parentId: string | undefined;
  const verificationRecordIds: string[] = [];
  const referenceAttempts: Value[] = [];
  let exclusion: Value | undefined;
  try {
    outcome = await (async () => {
    const created = await request(`${root}/sobjects/${input.parent}`, "POST", built.values);
    if (!created.ok || !id(created.body?.id)) return created;
    parentId = String(created.body.id);
    owned.push({ objectName: input.parent, id: parentId });
    const actual = await request(`${root}/sobjects/${input.parent}/${parentId}`);
    if (!actual.ok || actual.body?.[markerField.name] !== marker) return failure("QUICK_ACTION_CONTEXT_UNVERIFIED", "The owned parent failed readback.");
    args[input.contextInputName ?? "contextId"] = parentId;
    if (input.markerInputName) args[input.markerInputName] = marker;
    references[input.parentField] = parentId;
    const allowed = new Set(input.inputs.map(f => f.name));
    if (allowed.has(input.parentField)) args[input.parentField] = parentId;
    for (const field of input.fields) {
      if (!safe(field.name) || field.name === input.parentField || !allowed.has(field.name) || field.createable !== true ||
        !(field.nillable === false && field.defaultedOnCreate !== true || input.inputs.some(f => f.name === field.name && f.required === true))) continue;
      if (field.type !== "reference" || !Array.isArray(field.referenceTo)) {
        const targetValues = await input.build(input.target, marker, references);
        if ("failure" in targetValues) { outcome = targetValues.failure; return outcome; }
        if (Object.hasOwn(targetValues.values, field.name)) args[field.name] = targetValues.values[field.name];
        continue;
      }
      for (const reference of field.referenceTo.filter(safe).slice(0, 20)) {
        if (reference === input.parent) continue;
        if (reference === "User") {
          if (!id(input.integrationUserId)) return failure("QUICK_ACTION_EXECUTION_USER_UNAVAILABLE", "The connected execution identity is missing.");
          const found = await request(`${root}/query?q=${encodeURIComponent(`SELECT Id FROM User WHERE IsActive=true AND UserType='Standard' AND Id!='${input.integrationUserId}' ORDER BY CreatedDate LIMIT 1`)}`);
          const user = found.ok ? found.body?.records?.[0]?.Id : undefined;
          if (!id(user)) continue;
          args[field.name] = references[field.name] = user;
          exclusion = { field: field.name, value: input.integrationUserId };
          break;
        }
        const schema = await request(`${root}/sobjects/${reference}/describe`);
        const attempt: Value = { objectName: reference, describeStatus: schema.status, createable: schema.body?.createable === true, deletable: schema.body?.deletable === true };
        referenceAttempts.push(attempt);
        if (!schema.ok || schema.body?.createable !== true || schema.body?.deletable !== true) continue;
        const relatedFields: Value[] = schema.body.fields?.filter(record) ?? [];
        const relatedMarkers = relatedFields.filter(f => safe(f.name) && f.createable === true && f.filterable === true && f.type === "string" && f.length >= 24 && f.calculated !== true && f.autoNumber !== true && !relatedFields.some(c => c.compoundFieldName === f.name));
        const name = relatedMarkers.find(f => f.nameField && !f.compoundFieldName) ?? relatedMarkers.find(f => f.nillable === false) ?? relatedMarkers[0];
        attempt.markerAvailable = Boolean(name);
        if (!name) continue;
        const relatedMarker = `AS probe ${crypto.randomUUID()}`.slice(0, name.length ?? 80);
        const values = await input.build(reference, relatedMarker, { [name.name]: relatedMarker });
        if ("failure" in values) { attempt.preparationStatus = values.failure.status; continue; }
        const related = await request(`${root}/sobjects/${reference}`, "POST", values.values);
        attempt.creationStatus = related.status;
        if (!related.ok || !id(related.body?.id)) continue;
        owned.push({ objectName: reference, id: related.body.id });
        const actual = await request(`${root}/sobjects/${reference}/${related.body.id}`);
        if (!actual.ok || actual.body?.[name.name] !== relatedMarker) return failure("QUICK_ACTION_CONTEXT_UNVERIFIED", "The owned related reference failed readback.");
        args[field.name] = references[field.name] = related.body.id;
        break;
      }
      if (!Object.hasOwn(args, field.name)) return failure("QUICK_ACTION_REFERENCE_CONTEXT_UNAVAILABLE", "No accessible real reference could be resolved from the live child schema.");
    }
    const invoked = await request(input.route, "POST", { inputs: [args] });
    outcome = invoked;
    const predicate = Object.entries(references).map(([name, value]) => `${name}='${value}'`).join(" AND ");
    const returnedId = input.outputRecordField && Array.isArray(invoked.body) && invoked.body.length === 1 ? invoked.body[0]?.outputValues?.[input.outputRecordField] : undefined;
    const found = id(returnedId) ? { status: 200, ok: true, body: { records: [{ Id: returnedId }] } }
      : await request(`${root}/query?q=${encodeURIComponent(`SELECT Id FROM ${input.target} WHERE ${predicate} LIMIT ${input.markerTargetField ? 10 : 2}`)}`);
    referenceAttempts.push({ objectName: input.target, verificationStatus: found.status,
      ...(Array.isArray(found.body) && typeof found.body[0]?.errorCode === "string" ? { verificationErrorCode: found.body[0].errorCode } : {}), verificationSource: id(returnedId) ? "returned_record_readback" : "owned_reference_query" });
    const rows: Value[] = found.ok && Array.isArray(found.body?.records) ? found.body.records.filter(record) : [];
    verified = rows.length === 1;
    if (!found.ok || (input.markerTargetField ? rows.length >= 10 : rows.length > 1)) cleanupError = "The reference-child query failed or returned an ambiguous ownership tuple.";
    for (const child of rows) {
      if (!id(child.Id)) { verified = false; continue; }
      const actual = await request(`${root}/sobjects/${input.target}/${child.Id}`);
      if (input.markerTargetField && actual.ok && actual.body?.[input.parentField] === parentId && actual.body?.[input.markerTargetField] !== marker) continue;
      if (!actual.ok || Object.entries(references).some(([name, value]) => actual.body?.[name] !== value)) {
        verified = false; cleanupError = "The reference child could not be verified for cleanup."; continue;
      }
      owned.push({ objectName: input.target, id: child.Id });
      verificationRecordIds.push(child.Id);
    }
    if (input.markerTargetField) verified = verificationRecordIds.length === 1 && !cleanupError;
    if (verified && input.verificationWindowMs) await new Promise(resolve => setTimeout(resolve, input.verificationWindowMs));
    return outcome;
    })();
  } finally {
    // Parent deletion may also delete children; verify every known owned identity independently.
    for (const item of [...owned].reverse()) {
      const path = `${root}/sobjects/${item.objectName}/${item.id}`;
      await reclaimFixtureOwnerForDelete({ root, objectName: item.objectName, id: item.id, ownerId: input.integrationUserId, request }).catch(() => null);
      const removed = await request(path, "DELETE");
      const gone = await request(path);
      if ((!removed.ok && removed.status !== 404) || gone.status !== 404) {
        const grant = grantFamilyForCleanupDenial(item.objectName);
        cleanupError = `Reference action fixture deletion could not be verified (${item.objectName}/${item.id}: delete ${removed.status}, readback ${gone.status}).` +
          (grant ? ` Planner grant family ${grant.family} for ${item.objectName}: ${grant.requirement}` : "");
      }
    }
  }
  const contextSchema = { source: input.source ?? "salesforce_live_quick_action_definition", ownershipKind: "parent_reference",
    mutationKind: "create", targetObject: input.target, markerField: markerField.name,
    parentContextObject: input.parent, parentContextRecordId: parentId, parentField: input.parentField,
    changedFields: [...Object.keys(references), ...(input.markerTargetField ? [input.markerTargetField] : [])], expectedChanges: { ...references, ...(input.markerTargetField ? { [input.markerTargetField]: marker } : {}) }, ...(exclusion ? { childExclusion: exclusion } : {}),
    verificationRecordIds, ownedRecords: owned, referenceAttempts, verified,
    automaticSteps: ["Describe the live parent and child reference fields", "Create and read back a disposable parent and needed references", "Invoke the actual Quick Action", "Verify the exact child reference tuple", "Delete and verify every owned record"] };
  if (outcome.status >= 200 && outcome.status < 300 && !verified) outcome = { status: 422, body: { errorCode: "QUICK_ACTION_MUTATION_UNVERIFIED", message: "Salesforce returned an outcome without the independently verified reference child.", upstreamOutcome: outcome.body } };
  const terminal = quickActionRouteTerminal(outcome, "invoke");
  const final = terminal ?? outcome;
  const planners = terminal ? {} : quickActionFailurePlanners(final);
  return { ...final, contextSchema: { ...contextSchema, ...planners }, ...planners, ...(cleanupError ? { cleanupError } : {}) };
}
