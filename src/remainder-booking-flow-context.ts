/** Owned lifecycle for single-recordCreate invocable flows (e.g. Create_Booking).
 *
 * Root cause (blind-verified via admin CLI against the live org): the generic
 * Flow-creation probe reports FLOW_CREATION_FIELD_UNAVAILABLE for
 * Create_Booking even though the live Booking__c schema exposes every field
 * the active Flow version assigns (Contact__c, Number_of_Guests__c,
 * Session__c) and the native sequence succeeds end to end: owned Contact +
 * owned Session__c fixtures, invoke with their ids plus a live-typed guest
 * count, one Booking__c created with both references, all fixtures deleted
 * and absence verified. This lifecycle drives that proven sequence from live
 * metadata only.
 *
 * Zero-hardcoding contract: the route must be a discovered custom/flow route;
 * the Flow definition, active version, recordCreate assignments, target
 * schema, reference targets, marker fields, and descriptor input names all
 * come from live responses. Fixture values use unique markers; markerless
 * parents (Session__c Name is an autonumber) are tracked by exact creation
 * id and never broad-queried. No org IDs, aliases, URLs, or customer values.
 */

import { flowCreationRecipes } from "./flow-creation-context";

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const record = (v: any): v is Value => v !== null && typeof v === "object" && !Array.isArray(v);
const identity = (v: any): v is string =>
  typeof v === "string" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
const identifier = (v: any): v is string =>
  typeof v === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(v);
const successful = (r: Result) =>
  r.ok && Array.isArray(r.body) && r.body.length === 1 &&
  r.body[0]?.isSuccess === true && !r.body[0].errors?.length &&
  !r.body[0].outputValues?.errorMessage;

export const REMAINDER_BOOKING_FLOW_ROUTE = /\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/;

/** Scalar synthesis from the live target field type. Returns undefined for
 * unsupported live types so the caller fails explicitly instead of guessing. */
export function remainderScalarForField(field: Value, marker: string): unknown {
  switch (String(field.type)) {
    case "double":
    case "currency":
    case "int":
    case "long":
    case "percent": return 2;
    case "boolean": return false;
    case "date": return new Date().toISOString().slice(0, 10);
    case "datetime": return new Date(Date.now() + 3600000).toISOString();
    case "time": return `${new Date().toISOString().slice(11, 23)}Z`;
    case "base64": return "QWN0aW9uUHJvYmU=";
    case "email": return `remainder-probe-${crypto.randomUUID()}@example.invalid`;
    case "string":
    case "textarea":
    case "combobox":
    case "encryptedstring":
    case "phone":
    case "url": {
      const length = typeof field.length === "number" ? field.length : marker.length;
      return length >= marker.length ? marker : undefined;
    }
    default: return undefined;
  }
}

export async function invokeRemainderBookingFlow(input: {
  root: string; route: string; verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
}): Promise<{ status: number; body: any; cleanupError?: string; contextSchema?: Value }> {
  const { root, request } = input;
  const match = typeof input.route === "string" ? input.route.match(REMAINDER_BOOKING_FLOW_ROUTE) : null;
  const fail = (errorCode: string, message: string, extra?: Value): Result =>
    ({ status: 422, ok: false, body: { errorCode, message, ...extra } });
  if (!match || !input.route.startsWith(root + "/")) {
    return { status: 422, body: fail("REMAINDER_BOOKING_ROUTE_INVALID",
      "A discovered tenant-relative custom Flow route is required.").body };
  }
  if (input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) ||
      input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return { status: 422, body: fail("REMAINDER_BOOKING_WINDOW_INVALID",
      "A bounded verification window is required.").body };
  }
  const fullName = match[1];
  const local = fullName.includes("__") ? fullName.slice(fullName.indexOf("__") + 2) : fullName;
  const descriptor = await request(input.route);
  if (!descriptor.ok) return descriptor;
  const descriptorInputs = record(descriptor.body) && Array.isArray(descriptor.body.inputs)
    ? descriptor.body.inputs.filter(record) : [];
  const definition = await request(`${root}/tooling/query?q=${encodeURIComponent(
    `SELECT DeveloperName,NamespacePrefix,ActiveVersionId FROM FlowDefinition WHERE DeveloperName IN ('${fullName}','${local}')`)}`);
  if (!definition.ok) return definition;
  const definitions = record(definition.body) && Array.isArray(definition.body.records)
    ? definition.body.records.filter(record).filter(item =>
      (item.NamespacePrefix ? `${item.NamespacePrefix}__${item.DeveloperName}` : item.DeveloperName) === fullName) : [];
  const versionId = definitions.length === 1 ? definitions[0].ActiveVersionId : null;
  if (!identity(versionId)) {
    return { status: 422, body: fail("REMAINDER_BOOKING_METADATA_UNAVAILABLE",
      "The live Flow exposes no single active version for owned creation.").body };
  }
  const retrieved = await request(`${root}/tooling/query?q=${encodeURIComponent(
    `SELECT Metadata FROM Flow WHERE Id='${versionId}'`)}`);
  if (!retrieved.ok) return retrieved;
  const metadata = record(retrieved.body) && Array.isArray(retrieved.body.records)
    ? retrieved.body.records.filter(record)[0]?.Metadata : null;
  const recipes = flowCreationRecipes(metadata);
  if (recipes.length !== 1) {
    return { status: 422, body: fail("REMAINDER_BOOKING_SHAPE_UNSUPPORTED",
      "The live Flow metadata does not declare exactly one owned record creation.").body };
  }
  const recipe = recipes[0];
  const schema = await request(`${root}/sobjects/${recipe.objectName}/describe`);
  if (!schema.ok) return schema;
  if (!record(schema.body) || schema.body.createable !== true || schema.body.queryable !== true ||
      schema.body.deletable !== true || !Array.isArray(schema.body.fields)) {
    return { status: 403, body: { errorCode: "REMAINDER_BOOKING_PERMISSIONS_REQUIRED",
      message: `Automatic ${recipe.objectName} context requires live create, read and delete access.` } };
  }
  const fields = schema.body.fields.filter(record);
  const missing = recipe.fields.map(item => item.field).filter(name => !fields.some(field => field.name === name));
  if (missing.length) {
    return { status: 422, body: fail("REMAINDER_BOOKING_FIELD_UNAVAILABLE",
      `Live ${recipe.objectName} lacks assigned fields: ${missing.join(", ")}.`,
      { missingFields: missing }).body };
  }
  const variables = record(metadata) && Array.isArray(metadata.variables)
    ? metadata.variables.filter(record).filter(item => item.isInput === true) : [];
  const marker = `AS probe ${crypto.randomUUID()}`;
  const automaticSteps = [
    "Read the live Flow descriptor, definition and active version metadata",
    "Describe the live creation target and every referenced parent schema",
    "Create and read back uniquely marked owned fixtures",
    "Invoke the native Flow with owned identities and live-typed scalars",
    "Verify exactly one created child carries the owned references",
    "Delete owned children and fixtures and verify absence",
  ];
  type Fixture = { inputName: string; field: string; objectName: string; markerField?: string; id?: string };
  const fixtures: Fixture[] = [];
  const args: Value = {};
  for (const assignment of recipe.fields) {
    const field = fields.find(item => item.name === assignment.field)!;
    if (assignment.inputName === undefined) {
      if (assignment.literal === undefined) {
        return { status: 422, body: fail("REMAINDER_BOOKING_BINDING_UNRESOLVED",
          `Live assignment for ${assignment.field} has no input or literal source.`).body };
      }
      continue;
    }
    if (!identifier(assignment.inputName) ||
        !descriptorInputs.some(item => item.name === assignment.inputName)) {
      return { status: 422, body: fail("REMAINDER_BOOKING_INPUT_UNAVAILABLE",
        `Live descriptor lacks the assigned input ${String(assignment.inputName)}.`).body };
    }
    if (field.type !== "reference") continue;
    if (assignment.inputField && assignment.inputField !== "Id") {
      return { status: 422, body: fail("REMAINDER_BOOKING_REFERENCE_UNRESOLVED",
        `Live reference ${assignment.field} requires an identity binding.`).body };
    }
    const targets = [...new Set((Array.isArray(field.referenceTo) ? field.referenceTo : [])
      .filter(identifier))];
    const variable = variables.find(item => item.name === assignment.inputName);
    const objectName = targets.length === 1 ? targets[0]
      : typeof variable?.objectType === "string" && targets.includes(variable.objectType)
        ? String(variable.objectType) : null;
    if (!objectName) {
      return { status: 422, body: fail("REMAINDER_BOOKING_REFERENCE_AMBIGUOUS",
        `Live reference ${assignment.field} needs one disposable target.`, { targets }).body };
    }
    if (!fixtures.some(item => item.inputName === assignment.inputName)) {
      const parent = await request(`${root}/sobjects/${objectName}/describe`);
      if (!parent.ok) return parent;
      if (!record(parent.body) || parent.body.createable !== true || parent.body.queryable !== true ||
          parent.body.deletable !== true || !Array.isArray(parent.body.fields)) {
        return { status: 403, body: { errorCode: "REMAINDER_BOOKING_PARENT_PERMISSIONS_REQUIRED",
          message: `Automatic ${objectName} fixture requires live create, read and delete access.` } };
      }
      const parentFields = parent.body.fields.filter(record);
      const candidates = parentFields.filter(item => identifier(item.name) &&
        (item.type === "string" || item.type === "combobox") && item.createable === true &&
        item.filterable === true && item.calculated !== true && item.autoNumber !== true &&
        !item.compoundFieldName && typeof item.length === "number" && item.length >= marker.length);
      const chosen = candidates.find(item => item.nameField === true) ??
        candidates.find(item => item.nillable === false) ?? candidates[0];
      fixtures.push({ inputName: assignment.inputName, field: assignment.field, objectName,
        ...(typeof chosen?.name === "string" ? { markerField: String(chosen.name) } : {}) });
    }
  }
  const owned: Array<{ objectName: string; id: string }> = [];
  let createdId: string | undefined;
  let verified = false;
  let cleanupError: string | undefined;
  let outcome: Result = fail("REMAINDER_BOOKING_CONTEXT_UNAVAILABLE",
    "The owned Flow creation context could not be prepared.");
  const base = { source: "salesforce_live_remainder_booking_flow", action: fullName,
    targetObject: recipe.objectName, automaticSteps };
  try {
    outcome = await (async (): Promise<Result> => {
      for (const fixture of fixtures) {
        const values: Value = fixture.markerField ? { [fixture.markerField]: marker } : {};
        const built = await input.build(fixture.objectName, marker, values);
        if ("failure" in built) return built.failure;
        if (fixture.markerField && built.values[fixture.markerField] !== marker) {
          return fail("REMAINDER_BOOKING_BUILD_UNSCOPED",
            "The fixture builder changed a planned ownership field.");
        }
        const created = await request(`${root}/sobjects/${fixture.objectName}`, "POST", built.values);
        const newId: unknown = created.body?.id;
        if (!created.ok || !identity(newId)) return created;
        fixture.id = newId;
        owned.push({ objectName: fixture.objectName, id: fixture.id });
        const actual = await request(`${root}/sobjects/${fixture.objectName}/${fixture.id}`);
        if (!actual.ok || actual.body?.Id !== fixture.id ||
            (fixture.markerField && actual.body?.[fixture.markerField] !== marker)) {
          return fail("REMAINDER_BOOKING_FIXTURE_UNVERIFIED",
            `The owned ${fixture.objectName} fixture failed independent readback.`);
        }
        args[fixture.inputName] = fixture.id;
      }
      for (const assignment of recipe.fields) {
        if (assignment.inputName === undefined || args[assignment.inputName] !== undefined) continue;
        const field = fields.find(item => item.name === assignment.field)!;
        const value = assignment.literal !== undefined
          ? assignment.literal
          : remainderScalarForField(field, marker);
        if (value === undefined) {
          return fail("REMAINDER_BOOKING_SCALAR_UNSUPPORTED",
            `Live field ${assignment.field} has no supported synthetic scalar type.`,
            { fieldType: String(field.type) });
        }
        args[assignment.inputName] = value;
      }
      const invoked = await request(input.route, "POST", { inputs: [args] });
      if (!successful(invoked)) return invoked;
      const predicates = fixtures.filter(item => item.id).map(item => `${item.field}='${item.id}'`);
      if (!predicates.length) {
        return fail("REMAINDER_BOOKING_OWNERSHIP_UNRESOLVED",
          "The live creation has no owned reference anchor for verification.");
      }
      const selected = [...new Set(recipe.fields.map(item => item.field))];
      const found = await request(`${root}/query?q=${encodeURIComponent(
        `SELECT Id,${selected.join(",")} FROM ${recipe.objectName} WHERE ${predicates.join(" AND ")} LIMIT 3`)}`);
      if (!found.ok || !record(found.body) || !Array.isArray(found.body.records) ||
          found.body.records.length !== 1 || !identity(found.body.records[0]?.Id)) {
        return fail("REMAINDER_BOOKING_MUTATION_UNVERIFIED",
          "Salesforce reported success without exactly one owned created child.");
      }
      const row = found.body.records[0];
      for (const assignment of recipe.fields) {
        if (assignment.inputName === undefined || args[assignment.inputName] === undefined) continue;
        if (fixtures.some(item => item.inputName === assignment.inputName)) continue;
        const field = fields.find(item => item.name === assignment.field)!;
        const expected = args[assignment.inputName];
        const actual = row[assignment.field];
        const matches = ["double", "currency", "int", "long", "percent"].includes(String(field.type))
          ? Number(actual) === Number(expected) : actual === expected;
        if (!matches) {
          return fail("REMAINDER_BOOKING_MUTATION_UNVERIFIED",
            `The owned child field ${assignment.field} did not carry the invoked value.`);
        }
      }
      const outputs = Array.isArray(invoked.body) && record(invoked.body[0]?.outputValues)
        ? Object.entries(invoked.body[0].outputValues) : [];
      const outputIds = outputs.flatMap(([, value]) => {
        if (identity(value)) return [value];
        if (record(value)) {
          return Object.entries(value)
            .filter(([key, nested]) => /id$/i.test(key) && identity(nested))
            .map(([, nested]) => nested as string);
        }
        return [];
      });
      if (outputIds.length && !outputIds.includes(row.Id)) {
        return fail("REMAINDER_BOOKING_MUTATION_UNVERIFIED",
          "The native outcome identity does not match the actual owned child.");
      }
      const childId: unknown = row.Id;
      if (!identity(childId)) {
        return fail("REMAINDER_BOOKING_MUTATION_UNVERIFIED",
          "The owned created child has no usable identity.");
      }
      createdId = childId;
      owned.push({ objectName: recipe.objectName, id: createdId });
      verified = true;
      if (input.verificationWindowMs) {
        await new Promise(resolve => setTimeout(resolve, input.verificationWindowMs));
      }
      return invoked;
    })();
  } finally {
    for (const item of [...owned].reverse()) {
      await request(`${root}/sobjects/${item.objectName}/${item.id}`, "DELETE");
      const check = await request(`${root}/sobjects/${item.objectName}/${item.id}`);
      if (check.status !== 404) {
        cleanupError = "Owned Flow creation cleanup could not be verified; a record may still exist.";
      }
    }
    if (!cleanupError) {
      for (const fixture of fixtures.filter(item => item.markerField)) {
        const swept = await request(`${root}/query?q=${encodeURIComponent(
          `SELECT Id FROM ${fixture.objectName} WHERE ${fixture.markerField}='${marker}' LIMIT 2`)}`);
        const rows = record(swept.body) && Array.isArray(swept.body.records) ? swept.body.records : null;
        if (!swept.ok || !rows || rows.length > 0) {
          cleanupError = "Owned fixture cleanup could not be verified; a marker-scoped sibling may remain.";
        }
      }
    }
  }
  return { status: outcome.status, body: outcome.body,
    ...(cleanupError ? { cleanupError } : {}),
    contextSchema: { ...base, verified: cleanupError ? false : verified, marker,
      fixtures: fixtures.map(item => ({ inputName: item.inputName, field: item.field,
        objectName: item.objectName, markerField: item.markerField ?? null, id: item.id ?? null })),
      createdRecordId: createdId ?? null, verificationRecordIds: createdId ? [createdId] : [],
      ownedRecords: owned, ...(cleanupError ? { cleanupError } : {}) } };
}
