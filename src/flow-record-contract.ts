import { isNameMarkerField, isPersonContactField } from './describe-marker-field';
import { describeFlowUpdateContract } from './flow-update-contract';
import { describeFlowScalarCreationContract } from './flow-scalar-creation-contract';
import { reclaimFixtureOwnerForDelete } from './fixture-owner-reclaim';
import { clampVerificationWindowMs } from './verification-window';
type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const record = (v: any): v is Value => v !== null && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: any): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(v);
const id = (v: any): v is string => typeof v === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
/** Live packaged Flow contracts may expose record inputs and matching identity outputs
 * even when Salesforce does not expose their internal FlowDefinition metadata. */
export function flowRecordContracts(descriptor: any): Array<{ inputName: string; objectName: string; outputName: string }> {
  if (!record(descriptor) || !Array.isArray(descriptor.inputs) || !Array.isArray(descriptor.outputs) || !descriptor.inputs.length || descriptor.inputs.length > 3) return [];
  const contracts = descriptor.inputs.map((input: any) => {
    if (!record(input) || input.type !== 'SOBJECT' || !identifier(input.name) || !identifier(input.sObjectType) || (input.maxOccurs ?? 1) > 1 || !/\bcreate\b/i.test(String(input.description))) return;
    const output = descriptor.outputs.find((v: any) => record(v) && v.name === input.name + 'Id' && ['ID', 'STRING'].includes(v.type) && (v.maxOccurs ?? 1) <= 1);
    return output ? { inputName: input.name, objectName: input.sObjectType, outputName: output.name } : undefined;
  });
  return contracts.every(Boolean) ? contracts as Array<{ inputName: string; objectName: string; outputName: string }> : [];
}
export async function describeFlowRecordContract(input: { root: string; descriptor: any; request: (path: string) => Promise<Result> }) {
  const contracts = flowRecordContracts(input.descriptor);
  if (!contracts.length) return { status: 422, body: { errorCode: 'FLOW_RECORD_CONTRACT_UNRESOLVED', message: 'The live Flow descriptor does not declare a complete record-creation input and identity-output contract.' } };
  const targets: Value[] = [];
  for (const contract of contracts) {
    const schema = await input.request(`${input.root}/sobjects/${contract.objectName}/describe`);
    if (!schema.ok || !Array.isArray(schema.body?.fields)) return schema;
    const fields = schema.body.fields.filter(record);
    const choices = fields.filter((f: Value) => f.createable && f.filterable && f.type === 'string' && f.length >= 48 && !f.calculated && !f.autoNumber && !isPersonContactField(f));
    const marker = choices.find(isNameMarkerField) ?? choices.find((f: Value) => !f.nillable) ?? choices[0];
    if (!marker || !schema.body.createable || !schema.body.deletable || !schema.body.queryable) return { status: 403, body: { errorCode: 'FLOW_RECORD_CONTRACT_PERMISSIONS_REQUIRED', message: `Live ${contract.objectName} creation, query, deletion and ownership-marker access are required; automatically run setup:context-permissions --auto-record-contracts during org provisioning.` } };
    targets.push({ ...contract, fixtureAccessReady: true, markerField: marker.name, fields });
  }
  return { status: 200, body: { discovered: true }, contextSchema: { source: 'salesforce_live_flow_record_contract', supportsStoredResolution: contracts.every(c => /\bretrieve\b/i.test(String(input.descriptor.inputs.find((v: Value) => v.name === c.inputName)?.description))), targets, targetObject: targets[0].objectName, markerField: targets[0].markerField,
    automaticSteps: ['Discover live typed creation inputs and identity outputs', 'Describe live target fields and fixture access', 'Supply owned synthetic record values', 'Invoke the existing Flow', 'Read back returned identities and independently query unique ownership markers', 'Delete only owned created records and verify absence'] } };
}
export async function invokeFlowRecordContract(input: { root: string; route: string; plan: Value; verificationWindowMs?: number; userId?: string;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
}): Promise<{ status: number; body: any; contextSchema?: Value; cleanupError?: string }> {
  const { root, request, plan } = input;
  const targets = Array.isArray(plan.targets) ? plan.targets.filter(record) : [];
  if (plan.source !== 'salesforce_live_flow_record_contract' || !targets.length || targets.length > 3 || targets.some(t => ![t.objectName, t.inputName, t.outputName, t.markerField].every(identifier))) return { status: 422, body: { errorCode: 'FLOW_RECORD_CONTRACT_INVALID', message: 'A discovered typed Flow record contract is required.' } };
  const marker = `AS probe ${crypto.randomUUID()}`, args: Value = {}, owned: Array<{ objectName: string; id: string }> = [];
  const sparseInputs: Value = {};
  const identityKeys: Value = {};
  const verificationRecordIds: string[] = [], markers: Value = {};
  let resolutionMode = "unsaved_record_creation";
  let outcome: Result = { status: 422, ok: false, body: { errorCode: 'FLOW_RECORD_CONTRACT_CONTEXT_UNAVAILABLE', message: 'Owned record input values could not be prepared.' } }, verified = false, cleanupError: string | undefined;
  const discover = async (target: Value) => {
    const q = `SELECT Id FROM ${target.objectName} WHERE ${target.markerField}='${marker}' LIMIT 4`;
    const found = await request(`${root}/query?q=${encodeURIComponent(q)}`);
    if (!found.ok || !Array.isArray(found.body?.records) || found.body.records.length >= 4) throw Error('Owned Flow record discovery failed or exceeded its bounded lifecycle.');
    for (const item of found.body.records) if (id(item.Id) && !owned.some(v => v.id === item.Id)) owned.push({ objectName: target.objectName, id: item.Id });
    return found.body.records as Value[];
  };
  try {
    outcome = await (async () => {
      for (const target of targets) {
        // Protected retrieve-or-create Flows can use email as their lookup key
        // even though the public contract marks its record field optional.
        // Supply unique synthetic values only for live writable email fields.
        const identityFields = plan.supportsStoredResolution === true ? Object.fromEntries((target.fields ?? [])
          .filter((f: Value) => identifier(f.name) && f.type === 'email' && f.createable && !f.calculated && !f.autoNumber && !isPersonContactField(f))
          .slice(0, 4).map((f: Value) => [f.name, `probe-${crypto.randomUUID()}@example.invalid`])) : {};
        const built = await input.build(target.objectName, marker, { ...identityFields, [target.markerField]: marker });
        if ('failure' in built) return built.failure;
        identityKeys[target.inputName] = Object.keys(identityFields);
        // Explicit-null RecordTypeId faults interviews (verified A/B); the platform defaults the record type when omitted.
        // Person-Contact (`__pc`) fields are likewise never nulled: even explicit nulls 400 "bad field names"
        // on the business-record inserts these fixtures always are.
        const nulls = Object.fromEntries((target.fields ?? []).filter((f: Value) => f.createable && f.nillable === true && !f.defaultedOnCreate && !f.calculated && !f.autoNumber && f.name !== 'RecordTypeId' && !isPersonContactField(f)).map((f: Value) => [f.name, null]));
        args[target.inputName] = { ...nulls, ...built.values, attributes: { type: target.objectName } };
        sparseInputs[target.inputName] = { ...built.values, attributes: { type: target.objectName } };
        markers[target.objectName] = target.markerField;
      }
      let invoked = await request(input.route, 'POST', { inputs: [args] });
      // Dense explicit-null records can poison flows that bridge the record
      // to a second object (live evidence: a Contact record's nulled person
      // fields fault the flow's business-Account insert, while the same
      // sparse record succeeds). The execution identity only ever sees the
      // generic interview fault, so the single sparse retry is keyed on
      // that fault plus the presence of suspect compound-member nulls —
      // never on detail text. Required + marker + identity values only.
      const faultTexts: string[] = [];
      const collectFaults = (node: unknown): void => {
        if (typeof node === 'string') faultTexts.push(node);
        else if (Array.isArray(node)) node.forEach(collectFaults);
        else if (record(node)) Object.values(node).forEach(collectFaults);
      };
      collectFaults(invoked.body);
      const interviewFaulted = !invoked.ok && faultTexts.some(text => /executing a flow interview/i.test(text));
      const riskyNulls = targets.some(t => (t.fields ?? []).some((f: Value) => f.createable && f.nillable === true &&
        !f.defaultedOnCreate && !f.calculated && !f.autoNumber && typeof f.compoundFieldName === 'string' && f.compoundFieldName !== f.name));
      if (interviewFaulted && riskyNulls) {
        for (const target of targets) args[target.inputName] = sparseInputs[target.inputName];
        invoked = await request(input.route, 'POST', { inputs: [args] });
      }
      // Second subtraction: synthetic identity emails can poison the same
      // bridges (live evidence: a Contact identity email reaches the
      // flow's business-Account insert as PersonEmail). When the sparse
      // shape still faults the interview generically, retry once minimal:
      // required + marker values only, identity emails stripped.
      const sparseFaults: string[] = [];
      const collectSparse = (node: unknown): void => {
        if (typeof node === 'string') sparseFaults.push(node);
        else if (Array.isArray(node)) node.forEach(collectSparse);
        else if (record(node)) Object.values(node).forEach(collectSparse);
      };
      collectSparse(invoked.body);
      const sparseFaulted = !invoked.ok && sparseFaults.some(text => /executing a flow interview/i.test(text));
      const hasIdentity = targets.some(t => (identityKeys[t.inputName] ?? []).length > 0);
      if (sparseFaulted && hasIdentity) {
        for (const target of targets) {
          const minimal = { ...sparseInputs[target.inputName] };
          for (const key of identityKeys[target.inputName] ?? []) delete minimal[key];
          args[target.inputName] = minimal;
        }
        invoked = await request(input.route, 'POST', { inputs: [args] });
      }
      // Last shape: Person-Account-creating flows need person names instead
      // of the Name compound (live evidence: FirstName+LastName with no
      // Name succeeds where every Name shape faults). Person orgs only,
      // Account targets only: the marker splits across the name pair so
      // the computed Name still carries the full ownership marker.
      const personFaults: string[] = [];
      const collectPerson = (node: unknown): void => {
        if (typeof node === 'string') personFaults.push(node);
        else if (Array.isArray(node)) node.forEach(collectPerson);
        else if (record(node)) Object.values(node).forEach(collectPerson);
      };
      collectPerson(invoked.body);
      const minimalFaulted = !invoked.ok && personFaults.some(text => /executing a flow interview/i.test(text));
      const personTargets = targets.filter(t => t.objectName === 'Account' &&
        (t.fields ?? []).some((f: Value) => f.name === 'Name' && f.compoundFieldName === 'Name'));
      if (minimalFaulted && personTargets.length > 0) {
        for (const target of personTargets) {
          const parts = marker.split(' ');
          const personShape: Value = { attributes: { type: target.objectName } };
          for (const [key, value] of Object.entries(sparseInputs[target.inputName] ?? {})) {
            if (key === 'Name' || key === 'attributes' || (identityKeys[target.inputName] ?? []).includes(key)) continue;
            personShape[key] = value;
          }
          personShape.FirstName = parts[0];
          personShape.LastName = parts.slice(1).join(' ');
          args[target.inputName] = personShape;
        }
        invoked = await request(input.route, 'POST', { inputs: [args] });
      }
      const initialAccepted = invoked.ok && Array.isArray(invoked.body) && invoked.body.length === 1 && invoked.body[0]?.isSuccess === true && !invoked.body[0]?.errors?.length;
      // These live contracts explicitly support retrieval as well as creation. If an
      // unsaved input is rejected without partial mutations, materialize owned records
      // and retry the same real Flow with their stored fields and identities.
      if (!initialAccepted && plan.supportsStoredResolution === true) {
        for (const target of targets) await discover(target);
        if (!owned.length) {
          const materialized = new Map<string, Value>(), building = new Set<string>();
          const create = async (target: Value): Promise<Value> => {
            if (materialized.has(target.objectName)) return materialized.get(target.objectName)!;
            if (building.has(target.objectName)) throw Error('Owned Flow record dependencies are cyclic.');
            building.add(target.objectName);
            const values = { ...args[target.inputName] }; delete values.attributes;
            for (const parent of targets.filter(v => v.objectName !== target.objectName)) {
              const relation = target.fields?.find((f: Value) => f.createable && f.type === 'reference' && f.name === parent.objectName + 'Id' && f.referenceTo?.includes(parent.objectName));
              if (relation && !values[relation.name]) values[relation.name] = (await create(parent)).Id;
            }
            const created = await request(root + '/sobjects/' + target.objectName, 'POST', values);
            if (!created.ok || !id(created.body?.id)) { outcome = created; throw Error('Salesforce rejected owned stored-record context.'); }
            owned.push({ objectName: target.objectName, id: created.body.id });
            const actual = await request(root + '/sobjects/' + target.objectName + '/' + created.body.id);
            if (!actual.ok || actual.body?.[target.markerField] !== marker) throw Error('Owned stored-record marker readback failed.');
            materialized.set(target.objectName, actual.body); building.delete(target.objectName);
            return actual.body;
          };
          for (const target of targets) args[target.inputName] = { ...await create(target), attributes: { type: target.objectName } };
          resolutionMode = 'stored_record_resolution';
          invoked = await request(input.route, 'POST', { inputs: [args] });
        }
      }
      const accepted = invoked.ok && Array.isArray(invoked.body) && invoked.body.length === 1 && invoked.body[0]?.isSuccess === true && !invoked.body[0]?.errors?.length;
      verified = accepted;
      for (const target of targets) {
        const records = await discover(target), identity = invoked.body?.[0]?.outputValues?.[target.outputName];
        if (!id(identity) || records.length !== 1 || records[0].Id !== identity) { verified = false; continue; }
        const actual = await request(`${root}/sobjects/${target.objectName}/${identity}`);
        if (!actual.ok || actual.body?.[target.markerField] !== marker) { verified = false; continue; }
        verificationRecordIds.push(identity);
      }
      if ((verified || owned.length) && input.verificationWindowMs) await new Promise(resolve => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
      return accepted && !verified ? { status: 422, ok: false, body: { errorCode: 'FLOW_RECORD_CONTRACT_MUTATION_UNVERIFIED', message: 'Salesforce reported success without returning all actual owned creation identities.', upstreamOutcome: invoked.body } } : invoked;
    })();
  } catch (error) { if (outcome.body?.errorCode === 'FLOW_RECORD_CONTRACT_CONTEXT_UNAVAILABLE') outcome = { status: 422, ok: false, body: { errorCode: 'FLOW_RECORD_CONTRACT_LIFECYCLE_UNVERIFIED', message: error instanceof Error ? error.message : 'Owned record lifecycle failed.' } }; }
  finally {
    const errors: string[] = [];
    for (const target of targets) try { await discover(target); } catch { errors.push('Owned Flow cleanup discovery failed.'); }
    for (const item of [...owned].reverse()) {
      if (typeof input.userId === 'string') {
        await reclaimFixtureOwnerForDelete({ root, objectName: item.objectName, id: item.id, ownerId: input.userId, request }).catch(() => null);
      }
      const removed = await request(`${root}/sobjects/${item.objectName}/${item.id}`, 'DELETE');
      if (!removed.ok && removed.status !== 404) errors.push(`Owned ${item.objectName} deletion failed.`);
    }
    for (const item of owned) if ((await request(`${root}/sobjects/${item.objectName}/${item.id}`)).status !== 404) errors.push(`Owned ${item.objectName} cleanup was not verified.`);
    if (errors.length) cleanupError = [...new Set(errors)].join(' ');
  }
  return { status: outcome.status, body: outcome.body, ...(cleanupError ? { cleanupError } : {}), contextSchema: { ...plan, mutationKind: resolutionMode === "stored_record_resolution" ? "resolve" : "create", resolutionMode, markers, verified, verificationRecordIds, ownedRecords: owned } };
}
/** Resolve a creation contract whose typed output references a typed input parent.
 * Each scalar assignment is matched to an actual target field by its declared name. */
export async function describeFlowReferenceContract(input: { root: string; route: string; descriptor: any; request: (path: string) => Promise<Result> }) {
  const fail = (message: string) => ({ status: 422, body: { errorCode: 'FLOW_REFERENCE_CONTRACT_UNRESOLVED', message } });
  const descriptor = input.descriptor;
  if (!record(descriptor) || !Array.isArray(descriptor.inputs) || !Array.isArray(descriptor.outputs) || !/create/i.test(input.route.split('/').at(-1) ?? '')) return fail('No declared creation route with a typed output was found.');
  const outputs = descriptor.outputs.filter((v: any) => record(v) && v.type === 'SOBJECT' && identifier(v.sobjectType ?? v.sObjectType) && (v.maxOccurs ?? 1) <= 1);
  const parents = descriptor.inputs.filter((v: any) => record(v) && v.type === 'SOBJECT' && identifier(v.name) && identifier(v.sObjectType) && (v.maxOccurs ?? 1) <= 1);
  if (outputs.length !== 1 || parents.length !== 1) return fail('A single live typed creation output and parent input are required.');
  const objectName = outputs[0].sobjectType ?? outputs[0].sObjectType, parent = parents[0];
  if (objectName === parent.sObjectType) return fail('A distinct typed parent and child creation output are required.');
  const target = await input.request(input.root + '/sobjects/' + objectName + '/describe');
  if (!target.ok || !Array.isArray(target.body?.fields)) return target;
  const fields = target.body.fields.filter(record);
  const reference = fields.find((f: Value) => f.name === parent.sObjectType + 'Id' && f.type === 'reference' && f.referenceTo?.includes(parent.sObjectType));
  if (reference && !reference.createable) return { status: 403, body: { errorCode: 'FLOW_REFERENCE_CONTRACT_PERMISSIONS_REQUIRED', message: 'The live target reference is not writable; automatically run setup:context-permissions --auto-record-contracts during org provisioning, then retry.' } };
  if (!reference) return fail('The live output object exposes no writable reference to its typed input parent.');
  const bindings: Value[] = [{ field: reference.name, inputName: parent.name, inputField: 'Id', type: 'reference' }];
  const variables: Value[] = [{ name: parent.name, dataType: 'SObject' }];
  for (const variable of descriptor.inputs.filter((v: any) => v !== parent)) {
    if (!record(variable) || !identifier(variable.name) || (variable.maxOccurs ?? 1) > 1) return fail('All declared scalar creation inputs must be resolved.');
    const field = fields.find((f: Value) => (objectName + f.name).toLowerCase() === variable.name.toLowerCase());
    if (field && !field.createable) return { status: 403, body: { errorCode: 'FLOW_REFERENCE_CONTRACT_PERMISSIONS_REQUIRED', message: 'A declared live target assignment is not writable; automatically run setup:context-permissions --auto-record-contracts during org provisioning, then retry.' } };
    const matches = field && ({ STRING: ['string', 'textarea', 'picklist', 'combobox', 'email', 'phone', 'url'], BOOLEAN: ['boolean'], INTEGER: ['int'], DOUBLE: ['double', 'currency', 'percent'] } as Value)[variable.type]?.includes(field.type);
    if (!field || !matches) return fail('A declared scalar creation input has no unambiguous live target-field assignment.');
    bindings.push({ field: field.name, inputName: variable.name, type: field.type });
    variables.push({ name: variable.name, dataType: variable.type === 'STRING' ? 'String' : variable.type === 'BOOLEAN' ? 'Boolean' : 'Number' });
  }
  const schema = await input.request(input.root + '/sobjects/' + parent.sObjectType + '/describe');
  if (!schema.ok || !Array.isArray(schema.body?.fields)) return schema;
  const markers = schema.body.fields.filter((f: Value) => f.createable && f.filterable && f.type === 'string' && f.length >= 48 && !f.calculated && !f.autoNumber && !isPersonContactField(f));
  const marker = markers.find(isNameMarkerField) ?? markers.find((f: Value) => !f.nillable) ?? markers.find((f: Value) => f.name === 'Subject' || f.name === 'Title') ?? markers[0];
  if (!marker) return fail('The typed parent exposes no writable ownership marker.');
  return { status: 200, body: { discovered: true }, contextSchema: { source: 'salesforce_live_flow_reference_contract',
    fixtures: [{ inputName: parent.name, objectName: parent.sObjectType, fields: schema.body.fields, markerField: marker.name, collection: false, fixtureAccessReady: schema.body.createable === true && schema.body.queryable === true && schema.body.deletable === true }],
    targets: [{ objectName, outputName: outputs[0].name, fields, bindings, fixtureAccessReady: target.body.createable === true && target.body.queryable === true && target.body.deletable === true }], inputVariables: variables,
    targetObject: objectName, parentContextObject: parent.sObjectType, markerField: marker.name, referenceField: reference.name, anchorInput: parent.name,
    automaticSteps: ['Discover a live typed creation output and parent input', 'Match scalar inputs and parent reference to live target fields', 'Create and read back a disposable parent', 'Invoke the existing Flow', 'Query and verify the actual created child and assigned values', 'Delete owned child and parent and independently verify absence'] } };
}
/** Match a declared scalar child name to an actual live parent child relationship. */
export async function describeFlowChildContract(input: { root: string; route: string; descriptor: any; request: (path: string) => Promise<Result> }) {
  const fail = (message: string) => ({ status: 422, body: { errorCode: 'FLOW_CHILD_CONTRACT_UNRESOLVED', message } });
  const descriptor = input.descriptor;
  if (!record(descriptor) || !Array.isArray(descriptor.inputs) || descriptor.inputs.length !== 2 || !/(?:add|create)/i.test(input.route.split('/').at(-1) ?? '')) return fail('A declared child creation route with two inputs is required.');
  const parent = descriptor.inputs.find((v: Value) => v.type === 'SOBJECT' && identifier(v.name) && identifier(v.sObjectType) && (v.maxOccurs ?? 1) <= 1);
  const scalar = descriptor.inputs.find((v: Value) => v.type === 'STRING' && identifier(v.name) && (v.maxOccurs ?? 1) <= 1);
  if (!parent || !scalar) return fail('A single typed parent and scalar child input are required.');
  const schema = await input.request(input.root + '/sobjects/' + parent.sObjectType + '/describe');
  if (!schema.ok || !Array.isArray(schema.body?.fields) || !Array.isArray(schema.body?.childRelationships)) return schema;
  const relationships = schema.body.childRelationships.filter((v: Value) => identifier(v.childSObject) && identifier(v.field) && v.childSObject.toLowerCase() === scalar.name.toLowerCase());
  if (relationships.length !== 1) return fail('The scalar input does not match one actual child relationship of the typed parent.');
  const relationship = relationships[0], target = await input.request(input.root + '/sobjects/' + relationship.childSObject + '/describe');
  if (!target.ok || !Array.isArray(target.body?.fields)) return target;
  const fields = target.body.fields.filter(record), reference = fields.find((f: Value) => f.name === relationship.field && f.type === 'reference' && f.referenceTo?.includes(parent.sObjectType));
  const textFields = fields.filter((f: Value) => f.createable && f.type === 'textarea' && !f.calculated);
  const childStem = relationship.childSObject.startsWith(parent.sObjectType) ? relationship.childSObject.slice(parent.sObjectType.length) : relationship.childSObject;
  const bodyField = textFields.find((f: Value) => f.name.toLowerCase() === (childStem + 'Body').toLowerCase()) ?? (textFields.length === 1 ? textFields[0] : undefined);
  if (!reference || !reference.createable || !bodyField) return fail('The live child needs one writable text body and its actual writable parent reference.');
  const markers = schema.body.fields.filter((f: Value) => f.createable && f.filterable && f.type === 'string' && f.length >= 48 && !f.calculated && !f.autoNumber && !isPersonContactField(f));
  const marker = markers.find(isNameMarkerField) ?? markers.find((f: Value) => !f.nillable) ?? markers.find((f: Value) => f.name === 'Subject' || f.name === 'Title') ?? markers[0];
  if (!marker) return fail('The live parent has no writable ownership marker.');
  return { status: 200, body: { discovered: true }, contextSchema: { source: 'salesforce_live_flow_child_contract',
    fixtures: [{ inputName: parent.name, objectName: parent.sObjectType, fields: schema.body.fields, markerField: marker.name, collection: false, fixtureAccessReady: schema.body.createable === true && schema.body.queryable === true && schema.body.deletable === true }],
    targets: [{ objectName: relationship.childSObject, fields, bindings: [
      { field: reference.name, inputName: parent.name, inputField: 'Id', type: 'reference' },
      { field: bodyField.name, inputName: scalar.name, type: bodyField.type },
    ], fixtureAccessReady: target.body.createable === true && target.body.queryable === true && target.body.deletable === true }],
    inputVariables: [{ name: parent.name, dataType: 'SObject' }, { name: scalar.name, dataType: 'String' }],
    targetObject: relationship.childSObject, parentContextObject: parent.sObjectType, markerField: marker.name, referenceField: reference.name, anchorInput: parent.name,
    automaticSteps: ['Discover declared parent and child inputs', 'Match the child input to a live parent relationship', 'Describe the actual child body and reference fields', 'Create a disposable parent', 'Invoke and verify the actual child, body and parent link', 'Delete only owned child and parent and verify absence'] } };
}
export async function describePackagedFlowContract(input: { root: string; route: string; descriptor: any; request: (path: string) => Promise<Result> }) {
  const records = await describeFlowRecordContract(input);
  if (records.status !== 422) return records;
  const reference = await describeFlowReferenceContract(input);
  if (reference.status !== 422) return reference;
  const child = await describeFlowChildContract(input);
  if (child.status !== 422) return child;
  const scalar = await describeFlowScalarCreationContract(input);
  return scalar.status !== 422 ? scalar : describeFlowUpdateContract(input);
}
