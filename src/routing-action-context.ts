import { seedRequiredReferenceValues } from "./fixture-reference-seeding";

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
/**
 * Family builder version (previously the searcher literal 60, which sat
 * below the shared-contract floor and could never reselect rows): 125
 * seeds required fixture references (Case.BusinessHoursId) from live
 * lookups so routeWork/skillsBasedRouting re-probe past
 * OWNED_CONTEXT_REQUIRED_REFERENCE_UNRESOLVED.
 */
export const ROUTING_CONTEXT_BUILDER_VERSION = 125;
const id = (v: any): v is string => typeof v === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
export const ROUTING_CONTEXT_ACTIONS = ['skillsBasedRouting', 'routeWork'];
export const ROUTING_CONTEXT_OBJECTS = ['ServiceChannel', 'QueueRoutingConfig', 'PendingServiceRouting'];
export const routingTargets = (fields: Value[]) => {
  const options = fields.find(f => f.name === 'RelatedEntity')?.picklistValues;
  const names: string[] = Array.isArray(options) ? options.filter(v => v.active && /^[A-Za-z][A-Za-z0-9_]*$/.test(v.value)).map(v => v.value) : [];
  return names.includes('Case') ? ['Case', ...names.filter(n => n !== 'Case')] : names;
};
export async function invokeRoutingContext(input: {
  root: string; route: string; target: string; verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
}): Promise<{ status: number; body: any; contextSchema?: Value; cleanupError?: string }> {
  const { root, request, target } = input, action = input.route.split('/').at(-1)!;
  const fail = (errorCode: string, message: string): Result => ({ status: 422, ok: false, body: { errorCode, message } });
  if (!ROUTING_CONTEXT_ACTIONS.includes(action)) return fail('ROUTING_ACTION_INVALID', 'A discovered routing action is required.');
  const schemas: Value = {};
  for (const name of [...ROUTING_CONTEXT_OBJECTS, target]) {
    const r = await request(`${root}/sobjects/${name}/describe`);
    if (!r.ok || !Array.isArray(r.body?.fields)) return r;
    schemas[name] = r.body;
    if (!r.body.queryable || !r.body.createable || !r.body.deletable) return { status: 403, body: { errorCode: 'ROUTING_CONTEXT_PERMISSIONS_REQUIRED', message: `Live ${name} create/read/delete access is required to prepare and clean routing context; automatically run setup:context-permissions --auto-routing during org provisioning, then retry.` } };
  }
  if (!routingTargets(schemas.ServiceChannel.fields).includes(target)) return fail('ROUTING_TARGET_UNSUPPORTED', 'The live service-channel schema does not support the selected work item.');
  const markerField = schemas[target].fields.find((f: Value) => f.createable && f.filterable && f.type === 'string' && f.length >= 48 && !f.autoNumber && (f.nameField || f.name === 'Subject'));
  if (!markerField) return fail('ROUTING_OWNERSHIP_UNAVAILABLE', 'The live work item has no suitable ownership field.');
  const descriptor = await request(input.route);
  if (!descriptor.ok) return descriptor;
  const required = action === 'skillsBasedRouting' ? ['recordId', 'routingConfigId'] : ['serviceChannelId', 'serviceChannelLabel', 'serviceChannelDevName', 'routingType'];
  if (!Array.isArray(descriptor.body?.inputs) || required.some(name => !descriptor.body.inputs.some((f: Value) => f.name === name))) return fail('ROUTING_ACTION_SCHEMA_MISMATCH', 'The live action does not declare the required routing inputs.');
  const marker = `AS probe ${crypto.randomUUID()}`, developerName = `AS_Routing_${crypto.randomUUID().replaceAll('-', '')}`;
  const owned: Array<{ objectName: string; id: string }> = [];
  const cleanupResults: Array<{ objectName: string; deleteStatus: number; errorCode?: string; absent?: boolean }> = [];
  let anchorRecordId: string | undefined, channel: Value | undefined, configId: string | undefined, verified = false, cleanupError: string | undefined;
  let outcome = fail('ROUTING_CONTEXT_UNAVAILABLE', 'The owned routing context could not be prepared.');
  const create = async (name: string, values: Value) => {
    const r = await request(`${root}/sobjects/${name}`, 'POST', values);
    if (!r.ok || !id(r.body?.id)) { outcome = r.ok ? fail('ROUTING_FIXTURE_ID_UNVERIFIED', 'Salesforce did not return a valid fixture identity.') : r; throw Error('Salesforce rejected owned routing context.'); }
    owned.push({ objectName: name, id: r.body.id });
    const actual = await request(`${root}/sobjects/${name}/${r.body.id}`);
    if (!actual.ok || Object.entries(values).some(([field, value]) => actual.body?.[field] !== value)) throw Error(`Owned ${name} field readback failed.`);
    return actual.body as Value;
  };
  const children = async () => {
    const r = await request(`${root}/query?q=${encodeURIComponent(`SELECT Id,WorkItemId,ServiceChannelId FROM PendingServiceRouting WHERE WorkItemId='${anchorRecordId}' LIMIT 20`)}`);
    if (!r.ok || !Array.isArray(r.body?.records)) throw Error('Owned pending-routing readback failed.');
    for (const v of r.body.records) if (id(v.Id) && v.WorkItemId === anchorRecordId && !owned.some(o => o.id === v.Id)) owned.push({ objectName: 'PendingServiceRouting', id: v.Id });
    return r.body.records as Value[];
  };
  try {
    outcome = await (async () => {
      const existing = await request(`${root}/query?q=${encodeURIComponent(`SELECT Id,DeveloperName,MasterLabel,RelatedEntity FROM ServiceChannel WHERE RelatedEntity='${target}' LIMIT 1`)}`);
      if (!existing.ok) return existing;
      channel = existing.body?.records?.[0];
      if (!channel) channel = await create('ServiceChannel', { DeveloperName: developerName, MasterLabel: developerName, RelatedEntity: target });
      if (!id(channel?.Id) || channel.RelatedEntity !== target) return fail('ROUTING_CHANNEL_UNVERIFIED', 'The actual channel does not match the work item.');
      const models = schemas.QueueRoutingConfig.fields.find((f: Value) => f.name === 'RoutingModel')?.picklistValues?.filter((v: Value) => v.active).map((v: Value) => v.value) ?? [];
      const model = models.find((v: string) => v === 'LeastActive') ?? models.find((v: string) => v === 'MostAvailable');
      if (!model) return fail('ROUTING_MODEL_UNAVAILABLE', 'The live routing configuration has no supported internal routing model.');
      const config = await create('QueueRoutingConfig', { DeveloperName: developerName, MasterLabel: developerName, RoutingPriority: 1, RoutingModel: model, CapacityWeight: 1 });
      configId = config.Id;
      // Required fixture references (Case.BusinessHoursId on the sweep org)
      // seed from live lookups; borrowed ids ride the planned build values
      // and unresolved fields fail honest through the builder as before.
      const refSeed = await seedRequiredReferenceValues(request, root, schemas[target].fields);
      const built = await input.build(target, marker, { [markerField.name]: marker, ...refSeed.overrides });
      if ('failure' in built) return built.failure;
      // Marker and foreign keys, rather than unrelated defaulted fields, prove ownership.
      const created = await request(`${root}/sobjects/${target}`, 'POST', built.values);
      if (!created.ok || !id(created.body?.id)) return created;
      anchorRecordId = created.body.id;
      owned.push({ objectName: target, id: anchorRecordId! });
      const actual = await request(`${root}/sobjects/${target}/${anchorRecordId}`);
      if (!actual.ok || actual.body?.[markerField.name] !== marker) return fail('ROUTING_ANCHOR_UNVERIFIED', 'The actual work item ownership marker did not match.');
      const args = action === 'skillsBasedRouting' ? { recordId: anchorRecordId, routingConfigId: configId } : {
        recordId: anchorRecordId, recordsToRouteType: 'single', serviceChannelId: channel.Id,
        serviceChannelLabel: channel.MasterLabel, serviceChannelDevName: channel.DeveloperName,
        routingType: 'SkillsBased', skillOption: 'RunSBRRules', routingConfigId: configId, routingConfigLabel: config.MasterLabel,
      };
      const invoked = await request(input.route, 'POST', { inputs: [args] });
      const rows = await children();
      verified = rows.length === 1 && rows[0].ServiceChannelId === channel.Id;
      if (verified && input.verificationWindowMs) await new Promise(resolve => setTimeout(resolve, input.verificationWindowMs));
      const accepted = invoked.ok && Array.isArray(invoked.body) && invoked.body.length > 0 && invoked.body.every((v: Value) => v.isSuccess === true && !v.errors?.length);
      return accepted && !verified ? fail('ROUTING_MUTATION_UNVERIFIED', 'Salesforce reported success without a readable pending-routing record linked to the owned work item and actual channel.') : invoked;
    })();
  } catch (error) {
    if (outcome.body?.errorCode === 'ROUTING_CONTEXT_UNAVAILABLE') outcome = fail('ROUTING_LIFECYCLE_UNVERIFIED', error instanceof Error ? error.message : 'The owned routing lifecycle failed.');
  } finally {
    const errors: string[] = [];
    if (anchorRecordId) try { await children(); } catch { errors.push('Pending-routing cleanup discovery failed.'); }
    for (const item of [...owned].reverse()) {
      const deleted = await request(`${root}/sobjects/${item.objectName}/${item.id}`, 'DELETE');
      // Active routing can reject direct PSR deletion; deleting its owned work item
      // removes it through Salesforce cascade. Assert final absence after all cleanup.
      const errorCode = Array.isArray(deleted.body) ? deleted.body[0]?.errorCode : deleted.body?.errorCode;
      cleanupResults.push({ objectName: item.objectName, deleteStatus: deleted.status, ...(typeof errorCode === 'string' ? { errorCode } : {}) });
    }
    for (const item of owned) {
      const gone = await request(`${root}/sobjects/${item.objectName}/${item.id}`);
      const proof = cleanupResults.find(v => v.objectName === item.objectName);
      if (proof) proof.absent = gone.status === 404;
      if (gone.status !== 404) errors.push(`Owned ${item.objectName} cleanup was not verified.`);
    }
    if (errors.length) cleanupError = [...new Set(errors)].join(' ');
  }
  return { status: outcome.status, body: outcome.body, ...(cleanupError ? { cleanupError } : {}), contextSchema: {
    source: 'salesforce_live_routing_action', targetObject: 'PendingServiceRouting', anchorObject: target, anchorRecordId,
    markerField: markerField.name, serviceChannelId: channel?.Id, routingConfigId: configId, ownedRecords: owned, cleanupResults,
    verified, verificationRecordIds: verified ? owned.filter(v => v.objectName === 'PendingServiceRouting').map(v => v.id) : [],
    objects: Object.entries(schemas).map(([name, schema]) => ({ name, fields: schema.fields })), mutationKind: 'create',
    automaticSteps: ['Discover live routing and work-item schemas', 'Resolve or create a live service channel for the supported object', 'Create and read back an owned routing configuration and work item', 'Invoke with actual channel names and identities', 'Verify pending routing against the owned work item', 'Delete only owned pending routing, work item and configuration/channel and verify absence'],
  } };
}
