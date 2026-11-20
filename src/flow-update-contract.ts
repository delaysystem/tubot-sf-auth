import { seedRequiredReferenceValues } from './fixture-reference-seeding';
import { reclaimFixtureOwnerForDelete } from './fixture-owner-reclaim';
type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const record = (v: any): v is Value => v !== null && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: any): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(v);
const identity = (v: any): v is string => typeof v === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
export async function describeFlowUpdateContract(input: { root: string; route: string; descriptor: any; request: (path: string) => Promise<Result> }) {
  const fail = (message: string) => ({ status: 422, body: { errorCode: 'FLOW_UPDATE_CONTRACT_UNRESOLVED', message } });
  const { descriptor } = input, closing = /close/i.test(input.route.split('/').at(-1) ?? '');
  if (!record(descriptor) || !Array.isArray(descriptor.inputs) || !Array.isArray(descriptor.outputs) || !/(?:update|close)/i.test(input.route.split('/').at(-1) ?? '')) return fail('A live update or close route is required.');
  const typedInputs = descriptor.inputs.filter((v: Value) => v.type === 'SOBJECT' && identifier(v.sObjectType) && identifier(v.name) && (v.maxOccurs ?? 1) <= 1);
  const typedOutputs = descriptor.outputs.filter((v: Value) => v.type === 'SOBJECT' && identifier(v.sObjectType ?? v.sobjectType));
  const objectName = typedInputs.length === 1 ? typedInputs[0].sObjectType : typedOutputs.length === 1 ? typedOutputs[0].sObjectType ?? typedOutputs[0].sobjectType : null;
  if (!identifier(objectName) || typedInputs.length > 1) return fail('A unique live typed update target is required.');
  const anchor = typedInputs[0] ?? descriptor.inputs.find((v: Value) => v.type === 'STRING' && new RegExp('^(?:verified)?' + objectName + 'id$', 'i').test(v.name));
  if (!anchor || !identifier(anchor.name)) return fail('No unambiguous typed target or identity input is exposed.');
  const described = await input.request(input.root + '/sobjects/' + objectName + '/describe');
  if (!described.ok || !Array.isArray(described.body?.fields)) return described;
  const fields: Value[] = described.body.fields.filter(record);
  const markers = fields.filter(f => f.createable && f.filterable && f.type === 'string' && f.length >= 48 && !f.calculated && !f.autoNumber);
  const marker = markers.find(f => f.nameField) ?? markers.find(f => !f.nillable) ?? markers.find(f => ['Subject', 'Title'].includes(f.name));
  const bindings: Value[] = [], omitted: string[] = [];
  for (const v of descriptor.inputs.filter((v: Value) => v !== anchor)) {
    if (!identifier(v.name) || v.type !== 'STRING' || (v.maxOccurs ?? 1) > 1) return fail('Only declared scalar text updates can be resolved.');
    const normalized = v.name.replace(/^new/i, '').replace(/(?:Number|Address)$/i, '');
    const field = fields.find(f => f.name.toLowerCase() === normalized.toLowerCase() || (objectName + f.name).toLowerCase() === v.name.toLowerCase());
    if (!field || !['phone', 'email', 'string', 'textarea', 'picklist'].includes(field.type)) {
      if (v.required === true || !/If no change is desired.*empty/i.test(v.description ?? '')) return fail('An update input has no unique live field mapping or declared no-change behavior.');
      omitted.push(v.name); continue;
    }
    if (!field.updateable || !field.createable) return { status: 403, body: { errorCode: 'FLOW_UPDATE_FIELD_PERMISSIONS_REQUIRED', message: 'A declared update field lacks live create/edit access; automatically run setup:context-permissions --auto-record-contracts and retry.' } };
    bindings.push({ inputName: v.name, field: field.name, type: field.type });
  }
  if (!bindings.length || !marker) return fail('A writable ownership marker and update assignment are required.');
  let closedStatus: string | undefined;
  if (closing) {
    // CaseStatus is a Salesforce protocol catalog, queried only for a discovered Case.Status assignment.
    if (objectName !== 'Case' || !bindings.some(b => b.field === 'Status')) return fail('The live close target does not expose a supported status catalog.');
    const statuses = await input.request(input.root + '/query?q=' + encodeURIComponent('SELECT MasterLabel FROM CaseStatus WHERE IsClosed=true ORDER BY SortOrder LIMIT 20'));
    if (!statuses.ok) return statuses;
    closedStatus = statuses.body?.records?.find((r: Value) => fields.find(f => f.name === 'Status')?.picklistValues?.some((p: Value) => p.active && p.value === r.MasterLabel))?.MasterLabel;
    if (!closedStatus) return fail('No live active closed status is available to the execution user.');
  }
  return { status: 200, body: { discovered: true }, contextSchema: { source: 'salesforce_live_flow_update_contract', targetObject: objectName, markerField: marker.name,
    anchorInput: anchor.name, anchorType: anchor.type, fields, bindings, omittedInputs: omitted, closedStatus,
    fixtures: [{ objectName, markerField: marker.name, fields, bindings, fixtureAccessReady: !!(described.body.createable && described.body.updateable && described.body.queryable && described.body.deletable) }], targets: [],
    automaticSteps: ['Discover typed update target and writable scalar assignments', 'Automatically run setup:context-permissions --auto-record-contracts during org provisioning, including retained-field read access', 'Discover live picklist choices', 'Create and read back an owned target', 'Invoke the existing Flow', 'Verify actual field changes', 'Delete the owned target and verify absence'] } };
}
export async function invokeFlowUpdateContract(input: { root: string; route: string; plan: Value; verificationWindowMs?: number; userId?: string;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }> }) {
  const { plan, request, root } = input;
  let ownedId: string | undefined, verified = false, cleanupError: string | undefined;
  let denialGrant: Value | undefined;
  let creationAttempted = false;
  const expectedChanges: Value = {}, beforeValues: Value = {};
  let outcome: Result = { status: 422, ok: false, body: { errorCode: 'FLOW_UPDATE_CONTEXT_UNAVAILABLE', message: 'Owned update context is unavailable.' } };
  const marker = 'AS probe ' + crypto.randomUUID();
  try {
    // Required references (Case.BusinessHoursId) seed from setup defaults; borrowed rows are never written.
    const refSeed = await seedRequiredReferenceValues(request, root, plan.fields ?? [], { allowLiveBorrow: false });
    const built = await input.build(plan.targetObject, marker, { ...refSeed.overrides, [plan.markerField]: marker });
    if ('failure' in built) {
      outcome = built.failure;
      // Reference-target read denials (BusinessHours on a fresh org) are
      // auto-provisionable: name the grant so denial-driven self-heal
      // applies it and the retry seeds past the unresolved reference.
      const unresolvedRefs = record(built.failure.body) &&
        (built.failure.body as Value).errorCode === 'OWNED_CONTEXT_REQUIRED_REFERENCE_UNRESOLVED';
      if (unresolvedRefs && refSeed.readDenied.length) {
        const target = refSeed.readDenied[0];
        denialGrant = { family: 'object-crud', objectName: target, retryable: true,
          requirement: `Grant the execution identity ${target} read access through the fixture permission set during org provisioning, then retry.` };
      }
    }
    else {
      const args: Value = Object.fromEntries(plan.omittedInputs.map((name: string) => [name, '']));
      for (const binding of plan.bindings) {
        const field = plan.fields.find((f: Value) => f.name === binding.field);
        const choice = field.picklistValues?.find((p: Value) => p.active && p.value !== built.values[field.name])?.value;
        const next = binding.field === 'Status' && plan.closedStatus ? plan.closedStatus : field.type === 'picklist' ? choice : field.type === 'phone' ? '+12025550123' : field.type === 'email' ? 'probe-' + crypto.randomUUID() + '@example.invalid' : marker + ' changed';
        if (next === undefined) throw Error('No actual alternative field value is available.');
        args[binding.inputName] = next; expectedChanges[binding.field] = next;
        if (field.type === 'phone') built.values[binding.field] = '+12025550124';
        if (field.type === 'picklist' && built.values[binding.field] === next) built.values[binding.field] = field.picklistValues.find((p: Value) => p.active && p.value !== next)?.value;
      }
      creationAttempted = true;
      const created = await request(root + '/sobjects/' + plan.targetObject, 'POST', built.values);
      outcome = created;
      if (created.ok && identity(created.body?.id)) {
        ownedId = created.body.id;
        const path = root + '/sobjects/' + plan.targetObject + '/' + ownedId;
        const before = await request(path);
        if (!before.ok || before.body?.[plan.markerField] !== marker) throw Error('Owned update marker readback failed.');
        for (const name of Object.keys(expectedChanges)) { beforeValues[name] = before.body[name]; if (before.body[name] === expectedChanges[name]) throw Error('The requested update does not change the owned target.'); }
        args[plan.anchorInput] = plan.anchorType === 'SOBJECT' ? before.body : ownedId;
        outcome = await request(input.route, 'POST', { inputs: [args] });
        const after = await request(path);
        verified = outcome.ok && Array.isArray(outcome.body) && outcome.body.length === 1 && outcome.body[0]?.isSuccess === true && !outcome.body[0]?.errors?.length && !outcome.body[0]?.outputValues?.errorMessage && after.ok && after.body?.[plan.markerField] === marker && Object.entries(expectedChanges).every(([field, value]) => after.body[field] === value);
        if (verified && input.verificationWindowMs) await new Promise(resolve => setTimeout(resolve, input.verificationWindowMs));
        if (outcome.ok && outcome.body?.[0]?.isSuccess === true && !verified) outcome = { status: 422, ok: false, body: { errorCode: 'FLOW_UPDATE_MUTATION_UNVERIFIED', message: 'Salesforce reported execution success without the expected actual field changes.', upstreamOutcome: outcome.body } };
      }
    }
  } catch { outcome = { status: 422, ok: false, body: { errorCode: 'FLOW_UPDATE_LIFECYCLE_UNVERIFIED', message: 'Owned update context or mutation could not be verified.' } }; }
  finally {
    if (creationAttempted) {
      const found = await request(root + '/query?q=' + encodeURIComponent(`SELECT Id FROM ${plan.targetObject} WHERE ${plan.markerField}='${marker}' LIMIT 2`));
      if (!found.ok || !Array.isArray(found.body?.records) || found.body.records.length > 1 || found.body.records.some((r: Value) => !identity(r.Id))) cleanupError = 'Owned update cleanup discovery could not be verified.';
      else if (found.body.records.length === 1) {
        if (ownedId && ownedId !== found.body.records[0].Id) cleanupError = 'Owned update cleanup identity is ambiguous.';
        else ownedId = found.body.records[0].Id;
      }
    }
    if (ownedId) {
      const path = root + '/sobjects/' + plan.targetObject + '/' + ownedId;
      if (typeof input.userId === 'string') {
        await reclaimFixtureOwnerForDelete({ root, objectName: plan.targetObject, id: ownedId, ownerId: input.userId, request }).catch(() => null);
      }
      await request(path, 'DELETE'); if ((await request(path)).status !== 404) cleanupError = 'Owned Flow update target cleanup could not be verified.';
    }
  }
  return { status: outcome.status, body: outcome.body, cleanupError, ...(denialGrant ? { denialGrant } : {}), contextSchema: { ...plan, verified, mutationKind: 'update', expectedChanges, beforeValues, verificationRecordIds: ownedId ? [ownedId] : [], ownedRecords: ownedId ? [{ objectName: plan.targetObject, id: ownedId }] : [], ...(denialGrant ? { denialGrant } : {}) } };
}
