import { clampVerificationWindowMs } from './verification-window';
/** Owned lifecycle for the Order Management fulfillment-capacity family.
 * Live-proven recipe: fslfulfill lane (test2 2026-10-04). One owned Location
 * fixture (ShouldTrackFoCapacity, FoCapacity 100, live LocationType) grounds
 * all four actions; counters are read back through the native values action,
 * holds are released back to zero, and the fixture is deleted with a marker
 * sweep. No org IDs, aliases, or URLs; input names are live-descriptor
 * platform vocabulary verified before use. */
type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const id = (v: any): v is string => typeof v === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
const successful = (r: Result) => r.ok && Array.isArray(r.body) && r.body.length === 1 && r.body[0]?.isSuccess === true && !r.body[0].errors?.length;
export const FULFILLMENT_CAPACITY_ACTIONS = ['holdFulfillmentOrderCapacity', 'confirmHeldFulfillmentOrderCapacity',
  'releaseHeldFulfillmentOrderCapacity', 'getFulfillmentOrderCapacityValues'];
export const FULFILLMENT_CAPACITY_BUILDER_VERSION = 90;

const INPUTS: Record<string, string> = {
  holdFulfillmentOrderCapacity: 'holdFOCapacityInput',
  confirmHeldFulfillmentOrderCapacity: 'confirmHeldFOCapacityInput',
  releaseHeldFulfillmentOrderCapacity: 'releaseHeldFOCapacityInput',
  getFulfillmentOrderCapacityValues: 'getFulfillmentOrderCapacityValuesInput',
};

export async function invokeFulfillmentCapacityWithContext(input: {
  root: string; route: string; verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
}): Promise<{status: number; body: any; cleanupError?: string; contextSchema?: Value}> {
  const {root,request} = input, action = input.route.split('/').at(-1)!;
  const fail = (errorCode: string, message: string): Result => ({status:422,ok:false,body:{errorCode,message}});
  const inputName = INPUTS[action];
  if (!inputName) return fail('FULFILLMENT_ACTION_INVALID','A supported discovered fulfillment-capacity route is required.');
  const schema = await request(root+'/sobjects/Location/describe');
  if (!schema.ok) return schema;
  if (!schema.body?.createable || !schema.body?.queryable || !schema.body?.deletable || !Array.isArray(schema.body?.fields)) {
    return fail('FULFILLMENT_CONTEXT_PERMISSIONS_REQUIRED','Live owned Location fixtures require create, read and delete access.');
  }
  const fields = schema.body.fields as Value[];
  const nameField = fields.find(f => f.name === 'Name');
  if (!nameField?.createable || !nameField?.filterable) return fail('FULFILLMENT_MARKER_UNAVAILABLE','Location exposes no writable, filterable Name marker.');
  const locationType = fields.find(f => f.name === 'LocationType');
  const liveType = locationType?.picklistValues?.filter((p: Value) => p.active && typeof p.value === 'string').map((p: Value) => p.value)[0];
  for (const need of ['IsMobile', 'IsInventoryLocation', 'ShouldTrackFoCapacity', 'FoCapacity']) {
    if (!fields.some(f => f.name === need && f.createable)) return fail('FULFILLMENT_FIXTURE_SCHEMA_UNAVAILABLE',`Location.${need} is not writable on the live object.`);
  }
  if (typeof liveType !== 'string') return fail('FULFILLMENT_TYPE_UNAVAILABLE','Location.LocationType exposes no active value.');
  const descriptor = await request(root+'/actions/standard/'+action);
  if (!descriptor.ok) return descriptor;
  const inputs = Array.isArray(descriptor.body?.inputs) ? descriptor.body.inputs : [];
  if (!inputs.some((f: Value) => f.name === inputName)) return fail('FULFILLMENT_INPUT_UNDECLARED',`The live descriptor does not declare ${inputName}.`);
  const marker = 'AS focap '+crypto.randomUUID();
  let locationId: string|undefined, outcome: Result = fail('FULFILLMENT_CONTEXT_UNAVAILABLE','The owned fulfillment lifecycle could not be verified.');
  let cleanupError: string|undefined;
  const invoke = async (name: string, payload: Value): Promise<Result> =>
    request(root+'/actions/standard/'+name,'POST',{inputs:[payload]});
  const counters = async (): Promise<Value|null> => {
    const read = await invoke('getFulfillmentOrderCapacityValues',{getFulfillmentOrderCapacityValuesInput:{locationIds:[locationId]}});
    if (!successful(read)) return null;
    const found = (read.body[0].outputValues as any)?.getFulfillmentOrderCapacityValuesOutput?.locations?.[0];
    return found && typeof found === 'object' ? found : null;
  };
  try {
    outcome = await (async()=>{
      const built = await input.build('Location',marker,{Name:marker,LocationType:liveType,IsMobile:false,
        IsInventoryLocation:false,ShouldTrackFoCapacity:true,FoCapacity:100});
      if ('failure' in built) return built.failure;
      const created = await request(root+'/sobjects/Location','POST',built.values);
      if (!created.ok || !id(created.body?.id)) return created;
      locationId = created.body.id;
      const read = await request(root+'/sobjects/Location/'+locationId);
      if (!read.ok || read.body?.Name !== marker) return fail('FULFILLMENT_FIXTURE_UNVERIFIED','Actual owned Location readback failed.');
      const tag = marker.replace(/[^A-Za-z0-9-]/g,'-');
      const setupHold = async (suffix: string): Promise<Result|null> => {
        const held = await invoke('holdFulfillmentOrderCapacity',{holdFOCapacityInput:{allOrNothing:false,
          capacityRequests:[{actionRequestId:`${tag}-${suffix}`,locationId}]}});
        return successful(held) ? null : held;
      };
      if (action === 'getFulfillmentOrderCapacityValues') {
        const got = await invoke(action,{[inputName]:{locationIds:[locationId]}});
        if (!successful(got)) return got;
        const c = await counters();
        if (!c || c.capacity !== 100 || c.assigned !== 0 || c.heldCapacity !== 0) {
          return fail('FULFILLMENT_READBACK_MISMATCH','Fresh-fixture counters did not read back exactly.');
        }
        if (input.verificationWindowMs) await new Promise(r=>setTimeout(r,clampVerificationWindowMs(input.verificationWindowMs)));
        return got;
      }
      if (action === 'holdFulfillmentOrderCapacity') {
        const held = await invoke(action,{[inputName]:{allOrNothing:false,
          capacityRequests:[{actionRequestId:`${tag}-H`,locationId}]}});
        if (!successful(held)) return held;
        const c = await counters();
        if (!c || c.heldCapacity !== 1) return fail('FULFILLMENT_READBACK_MISMATCH','heldCapacity did not read back 1 after hold.');
        const released = await invoke('releaseHeldFulfillmentOrderCapacity',{releaseHeldFOCapacityInput:{allOrNothing:false,
          capacityRequests:[{actionRequestId:`${tag}-REL`,locationId}]}});
        if (!successful(released)) return fail('FULFILLMENT_RESTORE_FAILED','Cleanup release was refused; counters left held.');
        if (input.verificationWindowMs) await new Promise(r=>setTimeout(r,clampVerificationWindowMs(input.verificationWindowMs)));
        return held;
      }
      // confirm + release both need a setup hold first.
      const setup = await setupHold('SETUP');
      if (setup) return setup;
      const main = await invoke(action,{[inputName]:{allOrNothing:false,
        capacityRequests:[{actionRequestId:`${tag}-MAIN`,locationId}]}});
      if (!successful(main)) return main;
      const c = await counters();
      if (action === 'confirmHeldFulfillmentOrderCapacity') {
        if (!c || c.assigned !== 1 || c.heldCapacity !== 0) return fail('FULFILLMENT_READBACK_MISMATCH','Confirm did not read back assigned 1 / held 0.');
      } else if (!c || c.heldCapacity !== 0) {
        return fail('FULFILLMENT_READBACK_MISMATCH','Release did not read back held 0.');
      }
      if (input.verificationWindowMs) await new Promise(r=>setTimeout(r,clampVerificationWindowMs(input.verificationWindowMs)));
      return main;
    })();
  } catch { outcome = fail('FULFILLMENT_LIFECYCLE_UNVERIFIED','The owned fulfillment lifecycle could not be verified.'); }
  finally {
    try {
      if (locationId) {
        // Restore zero before delete: a held unit must never strand.
        if (action === 'holdFulfillmentOrderCapacity') {
          const c = await counters().catch(()=>null);
          if (c && c.heldCapacity !== 0) {
            await invoke('releaseHeldFulfillmentOrderCapacity',{releaseHeldFOCapacityInput:{allOrNothing:false,
              capacityRequests:[{actionRequestId:marker.replace(/[^A-Za-z0-9-]/g,'-')+'-FINAL',locationId}]}});
          }
        }
        const gone = await request(root+'/sobjects/Location/'+locationId,'DELETE');
        if (!gone.ok) { cleanupError ??= 'Owned Location cleanup failed.'; }
        else {
          const reread = await request(root+'/sobjects/Location/'+locationId);
          if (reread.ok) cleanupError ??= 'Owned Location deletion could not be verified.';
        }
        const sweep = await request(root+'/query?q='+encodeURIComponent(`SELECT Id FROM Location WHERE Name = '${marker}'`));
        const rows = sweep.ok && Array.isArray((sweep.body as any)?.records) ? (sweep.body as any).records : null;
        if (!sweep.ok || rows === null) cleanupError ??= 'Owned Location marker sweep could not be read back.';
        else if (rows.length) cleanupError ??= 'An owned Location marker row remains after cleanup.';
      }
    } catch { cleanupError ??= 'Owned fulfillment cleanup could not be independently read back.'; }
  }
  if (cleanupError) return {status:outcome.status,body:outcome.body,cleanupError};
  return successful(outcome)
    ? {...outcome, contextSchema:{source:'salesforce_live_native_fulfillment_action',verified:true,marker}}
    : outcome;
}
