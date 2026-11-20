import { cleanupOwnedContext, type OwnershipScope } from "./owned-context-cleanup";
type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const record = (v: any): v is Value => !!v && typeof v === 'object' && !Array.isArray(v);
const identity = (v: any): v is string => typeof v === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
export const WAITLIST_CONTEXT_OBJECTS = ['OperatingHours', 'ServiceTerritory', 'AppointmentCategory', 'WorkType', 'ServiceResource',
  'ServiceTerritoryMember', 'ServiceTerritoryWorkType', 'Waitlist', 'WaitlistWorkType', 'WaitlistServiceResource'];
export const WAITLIST_CONTEXT_FIELDS = ['Name', 'TimeZone', 'OperatingHoursId', 'IsActive', 'EstimatedDuration',
  'DurationType', 'RelatedRecordId', 'ResourceType', 'ServiceTerritoryId', 'ServiceResourceId', 'EffectiveStartDate',
  'EffectiveEndDate', 'WorkTypeId', 'WaitlistId', 'Description', 'AppointmentCategoryId', 'IsDropIn'];

/** Standard Scheduler protocol names are validated against the active tenant's live schemas. */
export async function invokeWaitlistContext(input: { root: string; route: string; userId: string;
  verificationWindowMs?: number; request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }> }) {
  const { root, request } = input;
  const fail = (code: string, message: string): Result => ({ status: 422, ok: false, body: { errorCode: code, message } });
  if (input.route !== root + '/actions/standard/createWaitlist' || !identity(input.userId))
    return fail('WAITLIST_ACTION_INVALID', 'A discovered create-waitlist route and connected execution identity are required.');
  const schemas: Value = {};
  for (const name of WAITLIST_CONTEXT_OBJECTS) {
    const r = await request(root + '/sobjects/' + name + '/describe');
    if (!r.ok || !record(r.body) || !Array.isArray(r.body.fields)) return { status: r.status, body: r.body };
    if (!r.body.queryable || name !== 'ServiceResource' && (!r.body.deletable || !r.body.createable))
      return { status: 403, body: { errorCode: 'WAITLIST_FIXTURE_PERMISSIONS_REQUIRED', message:
        `Live ${name} create/read/delete access is required; automatically run setup:context-permissions --auto-waitlists during org provisioning.` } };
    schemas[name] = r.body;
  }
  const descriptor = await request(input.route);
  if (!descriptor.ok) return { status: descriptor.status, body: descriptor.body };
  const names = ['waitlistName', 'serviceTerritoryId', 'workTypeIds', 'serviceResourceIds'];
  if (!Array.isArray(descriptor.body?.inputs) || names.some(name => !descriptor.body.inputs.some((f: Value) => f.name === name && f.type === 'STRING')) ||
      !descriptor.body.outputs?.some((f: Value) => f.name === 'waitlistId' && f.type === 'STRING') ||
      descriptor.body.inputs.some((f: Value) => f.required && !names.includes(f.name)))
    return fail('WAITLIST_ACTION_SCHEMA_MISMATCH', 'The live action differs from the Scheduler waitlist contract.');
  const relations = [
    ['ServiceTerritory', 'OperatingHoursId', 'OperatingHours'], ['ServiceResource', 'RelatedRecordId', 'User'],
    ['WorkType', 'AppointmentCategoryId', 'AppointmentCategory'],
    ['ServiceTerritoryMember', 'ServiceTerritoryId', 'ServiceTerritory'], ['ServiceTerritoryMember', 'ServiceResourceId', 'ServiceResource'],
    ['ServiceTerritoryWorkType', 'ServiceTerritoryId', 'ServiceTerritory'], ['ServiceTerritoryWorkType', 'WorkTypeId', 'WorkType'],
    ['Waitlist', 'ServiceTerritoryId', 'ServiceTerritory'], ['WaitlistWorkType', 'WaitlistId', 'Waitlist'],
    ['WaitlistWorkType', 'WorkTypeId', 'WorkType'], ['WaitlistServiceResource', 'WaitlistId', 'Waitlist'],
    ['WaitlistServiceResource', 'ServiceResourceId', 'ServiceResource'],
  ];
  if (relations.some(([name, field, target]) => !schemas[name].fields.some((f: Value) => f.name === field && (name === 'ServiceResource' || f.createable) && f.type === 'reference' && f.referenceTo?.includes(target))))
    return fail('WAITLIST_REFERENCE_SCHEMA_MISMATCH', 'Live writable Scheduler relationships are required before owned context can be created.');
  if (!schemas.AppointmentCategory.fields.some((f: Value) => f.name === 'IsDropIn' && f.type === 'boolean' && f.createable))
    return fail('WAITLIST_DROP_IN_CATEGORY_UNAVAILABLE', 'The live appointment category needs a writable drop-in flag before waitlist context can be created.');
  // 37 chars: orgs with User Territory Sharing cap service territory
  // names at 40 characters, which the 45-char dashed marker exceeds.
  const marker = 'AS probe ' + crypto.randomUUID().replaceAll('-', '').slice(0, 28);
  const owned: Array<{ objectName: string; id: string }> = [];
  const fixtures: Value = {}, markerFields: Value = {}, attempted: Array<{ objectName: string; predicate: string }> = [];
  let verified = false, cleanupError: string | undefined, waitlistId: string | undefined;
  let outcome = fail('WAITLIST_CONTEXT_UNAVAILABLE', 'The owned Scheduler context could not be prepared.');
  const query = async (name: string, predicate: string) => {
    const r = await request(root + '/query?q=' + encodeURIComponent(`SELECT Id FROM ${name} WHERE ${predicate} LIMIT 3`));
    if (!r.ok || !Array.isArray(r.body?.records) || r.body.records.some((v: Value) => !identity(v.Id))) {
      outcome = r.ok ? fail('WAITLIST_QUERY_UNVERIFIED', `The live ${name} ownership query returned no usable record list.`) : r;
      throw Error('Owned Scheduler query failed.');
    }
    return r.body.records as Value[];
  };
  const capture = (name: string, id: string) => { if (!owned.some(v => v.objectName === name && v.id === id)) owned.push({ objectName: name, id }); };
  const create = async (name: string, supplied: Value = {}) => {
    const fields = schemas[name].fields;
    const markerField = fields.find((f: Value) => f.nameField && f.createable && f.filterable && f.type === 'string' && f.length >= marker.length && !f.autoNumber);
    const values: Value = { ...supplied, ...(markerField ? { [markerField.name]: marker } : {}) };
    if (markerField) markerFields[name] = markerField.name;
    if (fields.some((f: Value) => f.name === 'IsActive' && f.type === 'boolean' && f.createable)) values.IsActive = true;
    // Required references must be explicitly grounded in this owned lifecycle or its execution actor.
    if (fields.some((f: Value) => f.type === 'reference' && !f.nillable && !f.defaultedOnCreate && !Object.hasOwn(values, f.name))) {
      outcome = fail('WAITLIST_REQUIRED_REFERENCE_UNRESOLVED', `The live ${name} fixture has an unresolved required reference.`);
      throw Error('The live Scheduler fixture has an unresolved required reference.');
    }
    const predicate = markerField ? `${markerField.name}='${marker}'` : Object.entries(supplied)
      .filter(([key, value]) => fields.some((f: Value) => f.name === key && f.type === 'reference' && f.filterable) && identity(value))
      .map(([key, value]) => `${key}='${value}'`).join(' AND ');
    if (!predicate || !markerField && Object.values(supplied).filter(identity).length < 2) {
      outcome = fail('WAITLIST_OWNERSHIP_SCOPE_UNAVAILABLE', `The live ${name} fixture lacks a writable marker or unique owned-parent scope.`);
      throw Error('Owned Scheduler fixture lacks a unique scope.');
    }
    const built = await input.build(name, marker, values);
    if ('failure' in built) { outcome = built.failure; throw Error('Fixture construction failed.'); }
    attempted.push({ objectName: name, predicate });
    const result = await request(root + '/sobjects/' + name, 'POST', built.values);
    if (!result.ok || !identity(result.body?.id)) { outcome = result; throw Error('Fixture creation failed.'); }
    const id = result.body.id;
    capture(name, id); fixtures[name] = id;
    const read = await request(root + '/sobjects/' + name + '/' + id);
    const mismatches = Object.entries(values).filter(([key, value]) => fields.find((f: Value) => f.name === key)?.type === 'datetime'
      ? Date.parse(read.body?.[key]) !== Date.parse(String(value)) : read.body?.[key] !== value).map(([key]) => key).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(key));
    if (!read.ok || mismatches.length) {
      outcome = read.ok ? fail('WAITLIST_FIXTURE_READBACK_UNVERIFIED', `The actual ${name} fixture failed readback of live fields: ${mismatches.join(', ')}.`) : read;
      throw Error('Owned Scheduler fixture readback failed.');
    }
    return id;
  };
  try {
    outcome = await (async () => {
      const hours = await create('OperatingHours');
      const territory = await create('ServiceTerritory', { OperatingHoursId: hours });
      const category = await create('AppointmentCategory', { IsDropIn: true });
      const workType = await create('WorkType', { AppointmentCategoryId: category });
      // ServiceResource cannot be deleted by the Salesforce protocol. Provisioning
      // creates/reuses a single execution-actor resource; tests never mutate it.
      const actorResources = await query('ServiceResource', `RelatedRecordId='${input.userId}' AND IsActive=true`);
      if (actorResources.length !== 1) return fail('WAITLIST_EXECUTION_RESOURCE_REQUIRED',
        'One active service resource for the integration execution user is needed; automatically run setup:context-permissions --auto-waitlists during provisioning, which creates or reuses that retained configuration.');
      const resource = actorResources[0].Id;
      fixtures.ServiceResource = resource;
      // CARTREGRESS: Secondary membership — the execution resource may already
      // hold an open primary membership (leaked or live), and field-less
      // creates default to Primary and collide 400 DUPLICATE_VALUE.
      const memberValues: Value = { ServiceTerritoryId: territory, ServiceResourceId: resource,
        EffectiveStartDate: new Date(Math.floor((Date.now() - 60_000) / 60_000) * 60_000).toISOString() };
      if (schemas.ServiceTerritoryMember.fields.some((f: Value) => f.name === 'TerritoryType' && f.createable)) memberValues.TerritoryType = 'S';
      await create('ServiceTerritoryMember', memberValues);
      await create('ServiceTerritoryWorkType', { ServiceTerritoryId: territory, WorkTypeId: workType });
      markerFields.Waitlist = 'Name';
      if (!schemas.Waitlist.fields.some((f: Value) => f.name === 'Name' && f.createable && f.filterable && f.length >= marker.length))
        return fail('WAITLIST_MARKER_UNAVAILABLE', 'The live Waitlist name cannot carry a verifiable ownership marker.');
      attempted.push({ objectName: 'Waitlist', predicate: `Name='${marker}' AND ServiceTerritoryId='${territory}'` });
      const args: Value = { waitlistName: marker, serviceTerritoryId: territory, workTypeIds: workType, serviceResourceIds: resource };
      if (descriptor.body.inputs.some((f: Value) => f.name === 'selfCheckin' && f.type === 'BOOLEAN')) args.selfCheckin = false;
      const native = await request(input.route, 'POST', { inputs: [args] });
      const results = await query('Waitlist', `Name='${marker}' AND ServiceTerritoryId='${territory}'`);
      if (results.length === 1) { waitlistId = results[0].Id; capture('Waitlist', waitlistId!); }
      if (!native.ok || !Array.isArray(native.body) || native.body.length !== 1 || !native.body[0]?.isSuccess || native.body[0].errors?.length || native.body[0].outputValues?.errorMessage) return native;
      if (!waitlistId || native.body[0].outputValues?.waitlistId !== waitlistId)
        return fail('WAITLIST_MUTATION_UNVERIFIED', 'Salesforce reported success without the expected owned Waitlist identity.');
      const actual = await request(root + '/sobjects/Waitlist/' + waitlistId);
      const types = await query('WaitlistWorkType', `WaitlistId='${waitlistId}'`);
      const resources = await query('WaitlistServiceResource', `WaitlistId='${waitlistId}'`);
      for (const item of types) capture('WaitlistWorkType', item.Id);
      for (const item of resources) capture('WaitlistServiceResource', item.Id);
      const type = types.length === 1 ? await request(root + '/sobjects/WaitlistWorkType/' + types[0].Id) : null;
      const assigned = resources.length === 1 ? await request(root + '/sobjects/WaitlistServiceResource/' + resources[0].Id) : null;
      verified = !!(actual.ok && actual.body.Name === marker && actual.body.ServiceTerritoryId === territory &&
        type?.ok && type.body.WorkTypeId === workType && assigned?.ok && assigned.body.ServiceResourceId === resource);
      if (!verified) return fail('WAITLIST_RELATIONSHIPS_UNVERIFIED', 'The actual Waitlist, work type, and service resource relationships were not all verified.');
      return native;
    })();
  } catch { if (outcome.ok) outcome = fail('WAITLIST_LIFECYCLE_UNVERIFIED', 'Owned Scheduler context could not be verified; automatic cleanup still runs.'); }
  finally {
    // Observe successful and failed fixture mutations before deleting them for independent CLI checks.
    if (owned.length && input.verificationWindowMs) await new Promise(resolve => setTimeout(resolve, input.verificationWindowMs));
    for (const item of attempted) {
      try { const found = await query(item.objectName, item.predicate); if (found.length > 1) throw Error('Ambiguous owned Scheduler fixture.');
        for (const r of found) capture(item.objectName, r.Id);
      } catch { cleanupError = 'Owned Scheduler fixture recovery could not be verified.'; }
    }
    waitlistId ??= owned.find(v => v.objectName === 'Waitlist')?.id;
    if (waitlistId) for (const name of ['WaitlistWorkType', 'WaitlistServiceResource']) {
      try { for (const r of await query(name, `WaitlistId='${waitlistId}'`)) capture(name, r.Id); }
      catch { cleanupError = 'Owned Waitlist child recovery could not be verified.'; }
    }
    const scopes: OwnershipScope[] = Object.entries(markerFields).map(([objectName,field])=>({objectName,equals:{[String(field)]:marker}}));
    for (const name of ["ServiceTerritoryMember","ServiceTerritoryWorkType"]) scopes.push({objectName:name,equals:{ServiceTerritoryId:fixtures.ServiceTerritory},ownedParents:[{field:"ServiceTerritoryId",objectName:"ServiceTerritory"}]});
    for (const name of ["WaitlistWorkType","WaitlistServiceResource"]) scopes.push({objectName:name,equals:{WaitlistId:waitlistId},ownedParents:[{field:"WaitlistId",objectName:"Waitlist"}]});
    const cleaned=await cleanupOwnedContext({root,request,records:owned,scopes,order:["WaitlistServiceResource","WaitlistWorkType","Waitlist","ServiceTerritoryWorkType","ServiceTerritoryMember","WorkType","AppointmentCategory","ServiceTerritory","OperatingHours"]});
    cleanupError ??= cleaned.cleanupError;
    owned.splice(0,owned.length,...cleaned.ownedRecords);
  }
  return { status: outcome.status, body: outcome.body, cleanupError, contextSchema: {
    source: 'salesforce_live_waitlist_action', objects: Object.values(schemas), markerFields, fixtures,
    retainedRecords: fixtures.ServiceResource ? [{ objectName: 'ServiceResource', id: fixtures.ServiceResource }] : [],
    verified, marker, verificationRecordIds: waitlistId ? [waitlistId] : [], ownedRecords: owned,
    automaticSteps: ['Read the live Scheduler action and relationship schemas', 'Automatically run setup:context-permissions --auto-waitlists during provisioning',
      'Reuse the provisioned integration-actor service resource without changing it', 'Create owned operating hours, territory, drop-in appointment category, work type and associations',
      'Invoke createWaitlist with actual context identities', 'Verify the created Waitlist and both association records', 'Delete only owned records and independently verify absence'],
  } };
}
