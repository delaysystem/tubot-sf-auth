import { clampVerificationWindowMs } from "./verification-window";
import { isRecord as record } from "./record-guard";
type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const id = (v: any): v is string => typeof v === "string" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
export const WORK_PLAN_CONTEXT_ACTIONS = ["addWorkPlans", "addWorkSteps", "deleteWorkPlans"];
export const WORK_PLAN_CONTEXT_OBJECTS = ["WorkOrder", "WorkPlanTemplate", "WorkStepTemplate", "WorkPlan", "WorkStep"];
export const workPlanContextObjects = (action: string) => action === "addWorkSteps"
  ? ["WorkOrder", "WorkPlan", "WorkStepTemplate", "WorkStep"] : ["WorkOrder", "WorkPlanTemplate", "WorkPlan"];
const success = (r: Result) => r.ok && Array.isArray(r.body) && r.body.length > 0 && r.body.every(v => record(v) && v.isSuccess === true && (!Array.isArray(v.errors) || !v.errors.length));

export async function invokeWorkPlanContext(input: {
  root: string; route: string; verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
}): Promise<{ status: number; body: any; contextSchema?: Value; cleanupError?: string }> {
  const { root, request } = input, action = input.route.split("/").at(-1)!;
  const fail = (errorCode: string, message: string): Result => ({ status: 422, ok: false, body: { errorCode, message } });
  if (!WORK_PLAN_CONTEXT_ACTIONS.includes(action)) return fail("WORK_PLAN_ACTION_INVALID", "A discovered Work Plan action is required.");
  const schemas: Value = {};
  for (const name of workPlanContextObjects(action)) {
    const r = await request(`${root}/sobjects/${name}/describe`);
    if (!r.ok || !record(r.body) || !Array.isArray(r.body.fields)) return r;
    if (r.body.createable !== true || r.body.deletable !== true || r.body.queryable !== true)
      return { status: 403, body: { errorCode: "WORK_PLAN_FIXTURE_PERMISSIONS_REQUIRED", message: `Live ${name} create/read/delete access is required; automatically run setup:context-permissions --work-plans.` } };
    schemas[name] = r.body;
  }
  if (!schemas.WorkPlan.fields.some((f: Value) => f.name === "ParentRecordId" && f.referenceTo?.includes("WorkOrder")) ||
    (action === "addWorkSteps" && !schemas.WorkStep.fields.some((f: Value) => f.name === "WorkPlanId" && f.referenceTo?.includes("WorkPlan"))))
    return fail("WORK_PLAN_PARENT_SCHEMA_MISMATCH", "The live Work Plan/Step parent relationships do not match the action context.");
  const descriptor = await request(input.route);
  if (!descriptor.ok) return descriptor;
  const requiredInputs = ["recordId", ...(action === "addWorkPlans" ? ["workPlanTemplateIdList"] : action === "addWorkSteps" ? ["workStepTemplateIdList"] : [])];
  if (!Array.isArray(descriptor.body?.inputs) || requiredInputs.some(name => !descriptor.body.inputs.some((f: Value) => f.name === name)))
    return fail("WORK_PLAN_ACTION_SCHEMA_MISMATCH", "The live action does not expose its required parent/template inputs.");
  const marker = `AS probe ${crypto.randomUUID()}`;
  const owned: Array<{ objectName: string; id: string }> = [], fixtures: Value = {}, markerFields: Value = {};
  const verificationRecordIds: string[] = [];
  let orderId: string | undefined, planId: string | undefined, verified = false, cleanupError: string | undefined;
  let outcome: Result = fail("WORK_PLAN_CONTEXT_UNAVAILABLE", "The owned Work Plan context could not be prepared.");
  const create = async (name: string, overrides: Value = {}) => {
    const fields = schemas[name].fields.filter((f: Value) => typeof f.name === "string" && f.createable === true && f.filterable === true && f.type === "string" && f.length >= 24 && !f.calculated && !f.autoNumber);
    const field = fields.find((f: Value) => f.nameField === true) ?? fields.find((f: Value) => f.name === "Subject") ?? fields.find((f: Value) => f.nillable === false) ?? fields[0];
    if (!field) throw Error(`The live ${name} schema has no writable ownership marker.`);
    markerFields[name] = field.name;
    const values: Value = { ...overrides, [field.name]: marker.slice(0, field.length) };
    if (schemas[name].fields.some((f: Value) => f.name === "IsActive" && f.createable === true && f.type === "boolean")) values.IsActive = true;
    const built = await input.build(name, marker, values);
    if ("failure" in built) { outcome = built.failure; throw Error(`The live ${name} fixture values could not be prepared.`); }
    const created = await request(`${root}/sobjects/${name}`, "POST", built.values);
    if (!created.ok || !id(created.body?.id)) { outcome = created.ok ? fail("WORK_PLAN_FIXTURE_ID_UNVERIFIED", "Salesforce did not return a valid newly created fixture identity.") : created; throw Error(`Salesforce rejected the owned ${name} creation.`); }
    const fixtureId = String(created.body.id);
    owned.push({ objectName: name, id: fixtureId });
    fixtures[name] = fixtureId;
    const actual = await request(`${root}/sobjects/${name}/${fixtureId}`);
    if (!actual.ok || actual.body?.[field.name] !== values[field.name] || Object.entries(overrides).some(([key, value]) => actual.body?.[key] !== value))
      throw Error(`The owned ${name} fixture failed its marker/reference readback.`);
    return fixtureId;
  };
  const readChildren = async (name: string, field: string, parent: string) => {
    const r = await request(`${root}/query?q=${encodeURIComponent(`SELECT Id,${field} FROM ${name} WHERE ${field}='${parent}' LIMIT 10`)}`);
    if (!r.ok || !Array.isArray(r.body?.records)) throw Error("Owned Work Plan child readback failed.");
    return r.body.records as Value[];
  };
  const invokePlans = () => request(`${root}/actions/standard/addWorkPlans`, "POST", { inputs: [{ recordId: orderId, workPlanTemplateIdList: [fixtures.WorkPlanTemplate] }] });
  const capturePlans = async (r: Result) => {
    const list = r.body?.[0]?.outputValues?.workPlanIdList;
    if (!success(r) || !Array.isArray(list) || list.length !== 1 || !id(list[0])) return false;
    const actual = await request(`${root}/sobjects/WorkPlan/${list[0]}`);
    if (!actual.ok || actual.body?.ParentRecordId !== orderId) return false;
    planId = list[0]; owned.push({ objectName: "WorkPlan", id: planId! });
    return true;
  };
  try {
    outcome = await (async () => {
      orderId = await create("WorkOrder");
      if (action === "addWorkSteps") {
        planId = await create("WorkPlan", { ParentRecordId: orderId });
        await create("WorkStepTemplate");
      } else await create("WorkPlanTemplate");
      if (action === "deleteWorkPlans") {
        const prepared = await invokePlans();
        if (!await capturePlans(prepared)) return success(prepared) ? fail("WORK_PLAN_PREREQUISITE_UNVERIFIED", "No owned plan was created for deletion.") : prepared;
        verificationRecordIds.push(planId!);
        if (input.verificationWindowMs) await new Promise(resolve => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
      }
      const args = action === "addWorkSteps" ? { recordId: planId, workStepTemplateIdList: [fixtures.WorkStepTemplate] }
        : action === "addWorkPlans" ? { recordId: orderId, workPlanTemplateIdList: [fixtures.WorkPlanTemplate] } : { recordId: orderId };
      const result = await request(input.route, "POST", { inputs: [args] });
      if (!success(result)) return result;
      if (action === "addWorkPlans") { verified = await capturePlans(result); if (verified) verificationRecordIds.push(planId!); }
      else if (action === "deleteWorkPlans") verified = (await request(`${root}/sobjects/WorkPlan/${planId}`)).status === 404 && !(await readChildren("WorkPlan", "ParentRecordId", orderId!)).length;
      else {
        const steps = result.body?.[0]?.outputValues?.workStepIdList;
        if (Array.isArray(steps) && steps.length === 1 && id(steps[0])) {
          const actual = await request(`${root}/sobjects/WorkStep/${steps[0]}`);
          if (actual.ok && actual.body?.WorkPlanId === planId) { owned.push({ objectName: "WorkStep", id: steps[0] }); verificationRecordIds.push(steps[0]); verified = true; }
        }
      }
      if (verified && input.verificationWindowMs) await new Promise(resolve => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
      return verified ? result : { ...fail("WORK_PLAN_MUTATION_UNVERIFIED", "Salesforce returned success without the expected owned Work Plan/Step mutation."), body: { errorCode: "WORK_PLAN_MUTATION_UNVERIFIED", message: "Salesforce returned success without the expected owned Work Plan/Step mutation.", upstreamOutcome: result.body } };
    })();
  } catch (error) { if (outcome.ok === false && outcome.body?.errorCode === "WORK_PLAN_CONTEXT_UNAVAILABLE") outcome = fail("WORK_PLAN_LIFECYCLE_UNVERIFIED", error instanceof Error ? error.message : "The owned Work Plan lifecycle failed."); }
  finally {
    const errors: string[] = [];
    // Parent deletion also cleans children whose IDs an unsuccessful action omitted.
    for (const item of [...owned].reverse()) try {
      const existing = await request(`${root}/sobjects/${item.objectName}/${item.id}`);
      if (existing.status === 404) continue;
      const removed = await request(`${root}/sobjects/${item.objectName}/${item.id}`, "DELETE");
      if (!removed.ok) errors.push(`Owned ${item.objectName} deletion was rejected.`);
    } catch { errors.push(`Owned ${item.objectName} cleanup request failed.`); }
    for (const item of owned) if ((await request(`${root}/sobjects/${item.objectName}/${item.id}`)).status !== 404) errors.push(`Owned ${item.objectName} deletion was not verified.`);
    if (errors.length) cleanupError = [...new Set(errors)].join(" ");
  }
  return { status: outcome.status, body: outcome.body, ...(cleanupError ? { cleanupError } : {}), contextSchema: {
    source: "salesforce_live_work_plan_action", targetObject: action === "addWorkSteps" ? "WorkStep" : "WorkPlan", markerField: markerFields.WorkOrder,
    objects: Object.entries(schemas).map(([name, schema]) => ({ name, createable: schema.createable, deletable: schema.deletable, queryable: schema.queryable,
      fields: schema.fields.map((field: Value) => ({ name: field.name, type: field.type, createable: field.createable, filterable: field.filterable,
        nillable: field.nillable, defaultedOnCreate: field.defaultedOnCreate, length: field.length, referenceTo: field.referenceTo, picklistValues: field.picklistValues })) })),
    anchorObject: "WorkOrder", anchorRecordId: orderId, fixtures, markerFields, ownedRecords: owned, verified, verificationRecordIds,
    parentContextObject: action === "addWorkSteps" ? "WorkPlan" : "WorkOrder", parentContextRecordId: action === "addWorkSteps" ? planId : orderId,
    parentField: action === "addWorkSteps" ? "WorkPlanId" : "ParentRecordId", mutationKind: action === "deleteWorkPlans" ? "delete" : "create",
    automaticSteps: ["Discover live Work Plan and template schemas", "Create and read back owned order/templates", "Prepare actual plan context", "Invoke the discovered action", "Verify created/deleted children and parent links", "Remove owned children, templates and order and verify absence"],
  } };
}
