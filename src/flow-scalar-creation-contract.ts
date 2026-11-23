import { clampVerificationWindowMs } from './verification-window';
type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const record = (v: any): v is Value => !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: any): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(v);
const identity = (v: any): v is string => typeof v === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
/** Resolve scalar creation inputs only through a declared record output and exact live field names. */
export async function describeFlowScalarCreationContract(input: { root: string; route: string; descriptor: any; request: (path: string) => Promise<Result> }) {
  const fail = (message: string) => ({ status: 422, body: { errorCode: 'FLOW_SCALAR_CREATION_UNRESOLVED', message } });
  const d = input.descriptor;
  if (!/create/i.test(input.route.split('/').at(-1) ?? '') || !record(d) || !Array.isArray(d.inputs) || !Array.isArray(d.outputs) || d.inputs.length > 12) return fail('A live creation route and bounded input contract are required.');
  const outputs = d.outputs.filter((v: Value) => v.type === 'SOBJECT' && identifier(v.sObjectType ?? v.sobjectType) && (v.maxOccurs ?? 1) <= 1 && /\bcreated\b/i.test(v.description ?? ''));
  if (outputs.length !== 1) return fail('A unique declared created-record output is required.');
  const output = outputs[0], objectName = output.sObjectType ?? output.sobjectType;
  if (!identifier(output.name)) return fail('The live created-record output has no valid name.');
  const schema = await input.request(input.root + '/sobjects/' + objectName + '/describe');
  if (!schema.ok || !Array.isArray(schema.body?.fields)) return schema;
  const fields: Value[] = schema.body.fields.filter(record), bindings: Value[] = [], omittedInputs: string[] = [];
  for (const v of d.inputs) {
    if (!identifier(v.name)) return fail('An input name is invalid.');
    const field = fields.find(f => f.name.toLowerCase() === v.name.toLowerCase() || (objectName + f.name).toLowerCase() === v.name.toLowerCase());
    if (v.type !== 'STRING' || (v.maxOccurs ?? 1) > 1 || !field || !['string', 'textarea'].includes(field.type)) {
      if (v.required === true) return fail('A required input cannot be mapped to a declared target field.');
      omittedInputs.push(v.name); continue;
    }
    if (!field.createable) return { status: 403, body: { errorCode: 'FLOW_SCALAR_CREATION_FIELD_PERMISSIONS_REQUIRED', message: 'A declared creation field lacks create access; automatically run setup:context-permissions --auto-record-contracts and retry.' } };
    bindings.push({ inputName: v.name, field: field.name, type: field.type });
  }
  const marker = fields.find(f => bindings.some(b => b.field === f.name) && f.filterable && f.type === 'string' && f.length >= 48 && !f.calculated && !f.autoNumber);
  if (!marker) return fail('No declared scalar input maps to a writable, queryable ownership marker.');
  if (!schema.body.createable || !schema.body.deletable || !schema.body.queryable) return { status: 403, body: { errorCode: 'FLOW_SCALAR_CREATION_PERMISSIONS_REQUIRED', message: 'Live creation, query and cleanup permissions are required; automatically run setup:context-permissions --auto-record-contracts and retry.' } };
  const fixtures: Value[] = [], referenceBindings: Value[] = [];
  // A generic customer/identity input may be grounded by a live lookup producer's
  // typed output. Never infer its Salesforce object from the input name alone.
  for (const name of [...omittedInputs]) {
    const variable = d.inputs.find((v: Value) => v.name === name);
    const role = name.replace(/^verified/i, '').replace(/id$/i, '').toLowerCase();
    if (!/id$/i.test(name) || role.length < 4 || !new RegExp(role, 'i').test(variable.description ?? '')) continue;
    const catalog = await input.request(input.root + '/actions/custom/flow');
    if (!catalog.ok || !Array.isArray(catalog.body?.actions)) continue;
    const providers = catalog.body.actions.filter((v: Value) => identifier(v.name) && /(?:get|identify)/i.test(v.name) && v.name.replace(/_/g, '').toLowerCase().includes(role)).slice(0, 5);
    const candidates = new Map<string, { field: string; providerRoutes: string[] }>();
    for (const provider of providers) {
      const live = await input.request(input.root + '/actions/custom/flow/' + provider.name);
      if (!live.ok || !Array.isArray(live.body?.outputs)) continue;
      for (const result of live.body.outputs) {
        const target = result.sObjectType ?? result.sobjectType;
        if (result.type !== 'SOBJECT' || !identifier(target) || !new RegExp(role, 'i').test(result.description ?? '')) continue;
        const relations = fields.filter(f => f.createable && f.type === 'reference' && Array.isArray(f.referenceTo) && f.referenceTo.length === 1 && f.referenceTo[0] === target);
        if (relations.length === 1) {
          const providerRoute = input.root + '/actions/custom/flow/' + provider.name;
          candidates.set(target, { field: relations[0].name, providerRoutes: [...(candidates.get(target)?.providerRoutes ?? []), providerRoute] });
        }
      }
    }
    if (candidates.size !== 1) continue;
    const [target, candidate] = [...candidates][0], field = candidate.field;
    const parent = await input.request(input.root + '/sobjects/' + target + '/describe');
    const parentFields: Value[] = parent.body?.fields?.filter(record) ?? [];
    const parentMarker = parentFields.find(f => f.nameField && f.type === 'string' && f.createable && f.filterable && f.length >= 48 && !f.calculated && !f.autoNumber) ?? parentFields.find(f => f.type === 'string' && f.createable && f.filterable && f.length >= 48 && !f.calculated && !f.autoNumber);
    if (!parent.ok) return parent;
    if (!parent.body.createable || !parent.body.deletable || !parent.body.queryable || !parentMarker) return { status: 403, body: { errorCode: 'FLOW_SCALAR_REFERENCE_PERMISSIONS_REQUIRED', message: 'A live typed identity context lacks create/query/delete or marker access; automatically run setup:context-permissions --auto-record-contracts and retry.' } };
    fixtures.push({ inputName: name, objectName: target, markerField: parentMarker.name, fields: parentFields, fixtureAccessReady: true });
    referenceBindings.push({ inputName: name, objectName: target, field, type: 'reference', providerRoutes: candidate.providerRoutes });
    omittedInputs.splice(omittedInputs.indexOf(name), 1);
  }
  return { status: 200, body: { discovered: true }, contextSchema: { source: 'salesforce_live_flow_scalar_creation_contract', targetObject: objectName, markerField: marker.name, outputName: output.name, bindings, referenceBindings, omittedInputs, fixtures,
    targets: [{ objectName, markerField: marker.name, bindings: [...bindings, ...referenceBindings], fields, fixtureAccessReady: true }],
    automaticSteps: ['Discover the declared created-record output', 'Map scalar inputs to exact live target fields', 'Resolve identity context through live typed lookup-producer outputs and target references', 'Save the discovered contract before invocation', 'Create and verify owned identity records', 'Invoke with a unique synthetic ownership marker', 'Independently query and verify the actual returned record and field values', 'Delete only owned records and verify absence'] } };
}
export async function invokeFlowScalarCreationContract(input: { root: string; route: string; plan: Value; verificationWindowMs?: number; request: (path: string, method?: string, body?: any) => Promise<Result>; build?: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }> }) {
  const { root, route, plan, request } = input;
  if (plan.source !== 'salesforce_live_flow_scalar_creation_contract' || ![plan.targetObject, plan.markerField, plan.outputName].every(identifier) || !Array.isArray(plan.bindings) || !plan.bindings.length || plan.bindings.some((b: Value) => !identifier(b.field) || !identifier(b.inputName))) return { status: 422, body: { errorCode: 'FLOW_SCALAR_CREATION_INVALID', message: 'A discovered scalar creation contract is required.' } };
  const marker = 'AS probe ' + crypto.randomUUID(), args: Value = {}, expectedChanges: Value = {}, ownedRecords: Value[] = [];
  for (const b of plan.bindings) { args[b.inputName] = marker; expectedChanges[b.field] = marker; }
  const discover = async () => {
    const fields = ['Id', ...new Set<string>([...plan.bindings.map((b: Value) => b.field), ...Object.keys(expectedChanges)])];
    const found = await request(root + '/query?q=' + encodeURIComponent(`SELECT ${fields.join(',')} FROM ${plan.targetObject} WHERE ${plan.markerField}='${marker}' LIMIT 3`));
    if (!found.ok || !Array.isArray(found.body?.records) || found.body.records.length >= 3) throw Error('Owned record discovery failed or exceeded the bounded contract.');
    for (const row of found.body.records) if (identity(row.Id) && row[plan.markerField] === marker && !ownedRecords.some(v => v.id === row.Id)) ownedRecords.push({ objectName: plan.targetObject, id: row.Id });
    return found.body.records as Value[];
  };
  let outcome: Result = { status: 422, ok: false, body: { errorCode: 'FLOW_SCALAR_CREATION_UNVERIFIED', message: 'The owned creation outcome could not be verified.' } }, verified = false, cleanupError: string | undefined;
  const ownedParents: Value[] = [];
  const attemptedParents: Value[] = [];
  let preparationFailure: Result | undefined;
  try {
    for (const fixture of plan.fixtures ?? []) {
      if (!input.build) throw Error('Owned parent construction is unavailable.');
      const built = await input.build(fixture.objectName, marker, { [fixture.markerField]: marker });
      if ('failure' in built) { preparationFailure = built.failure; throw Error('Owned parent construction was rejected.'); }
      attemptedParents.push(fixture);
      const created = await request(root + '/sobjects/' + fixture.objectName, 'POST', built.values);
      if (!created.ok || !identity(created.body?.id)) { preparationFailure = created; throw Error('Owned parent creation failed.'); }
      ownedParents.push({ objectName: fixture.objectName, id: created.body.id, markerField: fixture.markerField });
      const actual = await request(root + '/sobjects/' + fixture.objectName + '/' + created.body.id);
      if (!actual.ok || actual.body?.[fixture.markerField] !== marker) throw Error('Owned parent readback failed.');
      args[fixture.inputName] = created.body.id;
      const relation = plan.referenceBindings.find((v: Value) => v.inputName === fixture.inputName);
      expectedChanges[relation.field] = created.body.id;
    }
    outcome = await request(route, 'POST', { inputs: [args] });
    const rows = await discover(), result = Array.isArray(outcome.body) && outcome.body.length === 1 ? outcome.body[0] : undefined;
    const returned = result?.outputValues?.[plan.outputName];
    verified = outcome.ok && result?.isSuccess === true && !result.errors?.length && !result.outputValues?.errorMessage && result.outputValues?.isSuccess !== false && identity(returned?.Id) && rows.length === 1 && rows[0].Id.slice(0, 15) === returned.Id.slice(0, 15) && Object.entries(expectedChanges).every(([field, value]) => rows[0][field] === value);
    if (verified && input.verificationWindowMs) await new Promise(resolve => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
    if (outcome.ok && result?.isSuccess === true && !verified) outcome = { status: 422, ok: false, body: { errorCode: 'FLOW_SCALAR_CREATION_MUTATION_UNVERIFIED', message: 'Salesforce reported execution success without the actual declared record creation.', upstreamOutcome: outcome.body } };
  } catch { outcome = preparationFailure ?? { status: 502, ok: false, body: { errorCode: 'FLOW_SCALAR_CREATION_UPSTREAM_UNAVAILABLE', message: 'Execution or owned record readback failed; marker-scoped cleanup will run.' } }; }
  finally {
    try {
      if (!verified && ownedParents.length && input.verificationWindowMs) await new Promise(resolve => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
      await discover();
      for (const row of ownedRecords) {
        const path = root + '/sobjects/' + row.objectName + '/' + row.id, actual = await request(path);
        if (!actual.ok || actual.body?.[plan.markerField] !== marker) throw Error('Owned cleanup marker verification failed.');
        if (identity(actual.body?.CreatedById) && identity(actual.body?.OwnerId) && actual.body.OwnerId !== actual.body.CreatedById) {
          await request(path, 'PATCH', { OwnerId: actual.body.CreatedById });
        }
        const removed = await request(path, 'DELETE');
        if (!removed.ok || (await request(path)).status !== 404) throw Error('Owned cleanup could not be verified.');
      }
      if ((await discover()).length) throw Error('Owned records remain after cleanup.');
      for (const fixture of attemptedParents) {
        const found = await request(root + '/query?q=' + encodeURIComponent(`SELECT Id FROM ${fixture.objectName} WHERE ${fixture.markerField}='${marker}' LIMIT 3`));
        if (!found.ok || !Array.isArray(found.body?.records) || found.body.records.length >= 3) throw Error('Owned parent recovery failed.');
        for (const row of found.body.records) if (identity(row.Id) && !ownedParents.some(v => v.id === row.Id)) ownedParents.push({ objectName: fixture.objectName, id: row.Id, markerField: fixture.markerField });
      }
      for (const row of ownedParents.reverse()) {
        const path = root + '/sobjects/' + row.objectName + '/' + row.id, actual = await request(path);
        if (!actual.ok || actual.body?.[row.markerField] !== marker) throw Error('Owned parent cleanup marker failed.');
        if (!(await request(path, 'DELETE')).ok || (await request(path)).status !== 404) throw Error('Owned parent cleanup failed.');
      }
    } catch { cleanupError = 'Owned scalar Flow creation cleanup could not be independently verified.'; }
  }
  return { status: outcome.status, body: outcome.body, ...(cleanupError ? { cleanupError } : {}), contextSchema: { ...plan, marker, expectedChanges, ownedRecords: [...ownedRecords, ...ownedParents], verificationRecordIds: ownedRecords.map(v => v.id), verified } };
}
