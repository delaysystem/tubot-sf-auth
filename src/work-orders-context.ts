import { clampVerificationWindowMs } from './verification-window';
/** Owned lifecycle for generateWorkOrders.
 * Live-proven recipe: fslfulfill lane (test2 2026-10-04), hardened for
 * shared orgs: the lane deleted by global baseline-diff (unsafe with
 * concurrent writers); this executor scopes every minted row by
 * MaintenancePlanId, caps deletion, and alarms on any global surplus.
 * Recurrence is mandatory (bare plans refuse); required-set drift or a
 * missing live Calendar type fails closed. No org IDs, aliases, or URLs. */
type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const id = (v: any): v is string => typeof v === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
const successful = (r: Result) => r.ok && Array.isArray(r.body) && r.body.length === 1 && r.body[0]?.isSuccess === true && !r.body[0].errors?.length;
export const WORK_ORDERS_ACTIONS = ['generateWorkOrders'];
export const WORK_ORDERS_BUILDER_VERSION = 90;
const MAX_MINTED_DELETE = 50;
const POLLS = 6, POLL_MS = 15000;

export async function invokeWorkOrdersWithContext(input: {
  root: string; route: string; verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
}): Promise<{status: number; body: any; cleanupError?: string; contextSchema?: Value}> {
  const {root,request} = input, action = input.route.split('/').at(-1)!;
  const fail = (errorCode: string, message: string): Result => ({status:422,ok:false,body:{errorCode,message}});
  if (!WORK_ORDERS_ACTIONS.includes(action)) return fail('WORK_ORDERS_ACTION_INVALID','A supported discovered work-orders route is required.');
  const mp = await request(root+'/sobjects/MaintenancePlan/describe');
  const mwr = await request(root+'/sobjects/MaintenanceWorkRule/describe');
  if (!mp.ok) return mp;
  if (!mwr.ok) return mwr;
  for (const [name, schema] of [['MaintenancePlan', mp], ['MaintenanceWorkRule', mwr]] as const) {
    if (!schema.body?.createable || !schema.body?.queryable || !schema.body?.deletable || !Array.isArray(schema.body?.fields)) {
      return fail('WORK_ORDERS_CONTEXT_PERMISSIONS_REQUIRED',`Live owned ${name} fixtures require create, read and delete access.`);
    }
  }
  const mpFields = mp.body.fields as Value[], mwrFields = mwr.body.fields as Value[];
  const mpRequired = mpFields.filter(f => f.createable === true && f.nillable === false && f.defaultedOnCreate === false).map(f => f.name);
  for (const need of ['StartDate', 'NextSuggestedMaintenanceDate', 'GenerationTimeframe']) {
    if (!mpRequired.includes(need)) return fail('WORK_ORDERS_SHAPE_DRIFTED',`MaintenancePlan required set drifted (missing ${need}); refusing to guess fixture shapes.`);
  }
  if (!mwrFields.find(f => f.name === 'Type')?.picklistValues?.some((p: Value) => p.active && p.value === 'Calendar')) {
    return fail('WORK_ORDERS_RULE_UNAVAILABLE','MaintenanceWorkRule has no live Calendar type; recurrence fixture shape unknown.');
  }
  if (!mpFields.some(f => f.name === 'WorkOrderGenerationStatus')) {
    return fail('WORK_ORDERS_STATUS_UNAVAILABLE','MaintenancePlan exposes no generation-status field to poll.');
  }
  const descriptor = await request(root+'/actions/standard/'+action);
  if (!descriptor.ok) return descriptor;
  if (!Array.isArray(descriptor.body?.inputs) || !descriptor.body.inputs.some((f: Value) => f.name === 'recordId')) {
    return fail('WORK_ORDERS_INPUT_UNDECLARED','The live descriptor does not declare recordId.');
  }
  const marker = 'AS genorders '+crypto.randomUUID();
  // Recent window: far-past dates deterministically yield NoWorkOrderGenerated
  // (the lane's single minted row was a stale-baseline artifact under
  // concurrency). A recent window mints the full daily set (~31); deletion is
  // plan-scoped and batched, so the probe stays cheap and sound.
  const day = 86400000, at = (t: number) => new Date(t).toISOString().slice(0, 10);
  const now = Date.now();
  let planId: string|undefined, ruleId: string|undefined;
  let globalBefore = -1;
  let outcome: Result = fail('WORK_ORDERS_CONTEXT_UNAVAILABLE','The owned work-orders lifecycle could not be verified.');
  let cleanupError: string|undefined;
  const scopedMinted = async (): Promise<string[]|null> => {
    const found = await request(root+'/query?q='+encodeURIComponent(`SELECT Id FROM WorkOrder WHERE MaintenancePlanId = '${planId}' LIMIT 100`));
    if (!found.ok || !Array.isArray((found.body as any)?.records)) return null;
    return (found.body as any).records.map((r: Value) => r.Id).filter(id);
  };
  try {
    outcome = await (async()=>{
      const global = await request(root+'/query?q='+encodeURIComponent('SELECT COUNT() FROM WorkOrder'));
      globalBefore = global.ok && typeof (global.body as any)?.totalSize === 'number' ? (global.body as any).totalSize : -1;
      const builtPlan = await input.build('MaintenancePlan',marker,{MaintenancePlanTitle:marker,
        StartDate:at(now-30*day),NextSuggestedMaintenanceDate:at(now-day),GenerationTimeframe:1});
      if ('failure' in builtPlan) return builtPlan.failure;
      const createdPlan = await request(root+'/sobjects/MaintenancePlan','POST',builtPlan.values);
      if (!createdPlan.ok || !id(createdPlan.body?.id)) return createdPlan;
      planId = createdPlan.body.id;
      const builtRule = await input.build('MaintenanceWorkRule',marker,{Title:marker,SortOrder:1,
        ParentMaintenancePlanId:planId,Type:'Calendar',RecurrencePattern:'FREQ=DAILY;INTERVAL=1'});
      if ('failure' in builtRule) return builtRule.failure;
      const createdRule = await request(root+'/sobjects/MaintenanceWorkRule','POST',builtRule.values);
      if (!createdRule.ok || !id(createdRule.body?.id)) return createdRule;
      ruleId = createdRule.body.id;
      const invoked = await request(input.route,'POST',{inputs:[{recordId:planId}]});
      if (!successful(invoked)) return invoked;
      let minted: string[] = [];
      for (let poll = 0; poll < POLLS; poll++) {
        await new Promise(r=>setTimeout(r,POLL_MS));
        const status = await request(root+'/query?q='+encodeURIComponent(
          `SELECT WorkOrderGenerationStatus FROM MaintenancePlan WHERE Id = '${planId}'`));
        const state = status.ok && Array.isArray((status.body as any)?.records)
          ? String((status.body as any).records[0]?.WorkOrderGenerationStatus ?? '') : '';
        const found = await scopedMinted();
        if (found) minted = found;
        if (minted.length > 0 || /complete|error|fail/i.test(state)) break;
      }
      if (!minted.length) return fail('WORK_ORDERS_LIFECYCLE_UNVERIFIED','No plan-scoped WorkOrder minted within the poll window.');
      if (minted.length > MAX_MINTED_DELETE) {
        cleanupError ??= `${minted.length} plan-scoped WorkOrders minted; mass deletion refused, rows remain.`;
        return fail('WORK_ORDERS_MINTED_OVERFLOW','Minted row count exceeds the bounded-delete cap.');
      }
      const apiVersion = root.split('/')[3] || 'v67.0';
      for (let i = 0; i < minted.length; i += 25) {
        const batch = await request(root+'/composite/batch','POST',{haltOnError:false,batchRequests:
          minted.slice(i, i + 25).map(rowId => ({method:'DELETE',url:`${apiVersion}/sobjects/WorkOrder/${rowId}`}))});
        const codes: number[] = Array.isArray((batch.body as any)?.results)
          ? (batch.body as any).results.map((r: Value) => r.statusCode) : [];
        if (!batch.ok || codes.length !== Math.min(25, minted.length - i) || codes.some(c => c !== 200 && c !== 204 && c !== 404)) {
          return fail('WORK_ORDERS_MINTED_CLEANUP_FAILED','A minted WorkOrder could not be deleted.');
        }
      }
      const rescan = await scopedMinted();
      if (rescan === null || rescan.length) return fail('WORK_ORDERS_MINTED_CLEANUP_FAILED','Minted WorkOrders remain after cleanup.');
      if (input.verificationWindowMs) await new Promise(r=>setTimeout(r,clampVerificationWindowMs(input.verificationWindowMs)));
      return invoked;
    })();
  } catch { outcome = fail('WORK_ORDERS_LIFECYCLE_UNVERIFIED','The owned work-orders lifecycle could not be verified.'); }
  finally {
    try {
      if (ruleId) {
        const gone = await request(root+'/sobjects/MaintenanceWorkRule/'+ruleId,'DELETE');
        if (!gone.ok) cleanupError ??= 'Owned MaintenanceWorkRule cleanup failed.';
      }
      if (planId) {
        const gone = await request(root+'/sobjects/MaintenancePlan/'+planId,'DELETE');
        if (!gone.ok) { cleanupError ??= 'Owned MaintenancePlan cleanup failed.'; }
        else {
          const reread = await request(root+'/sobjects/MaintenancePlan/'+planId);
          if (reread.ok) cleanupError ??= 'Owned MaintenancePlan deletion could not be verified.';
        }
        const sweep = await request(root+'/query?q='+encodeURIComponent(`SELECT Id FROM MaintenancePlan WHERE MaintenancePlanTitle = '${marker}'`));
        const rows = sweep.ok && Array.isArray((sweep.body as any)?.records) ? (sweep.body as any).records : null;
        if (!sweep.ok || rows === null) cleanupError ??= 'Owned MaintenancePlan marker sweep could not be read back.';
        else if (rows.length) cleanupError ??= 'An owned MaintenancePlan marker row remains after cleanup.';
        const global = await request(root+'/query?q='+encodeURIComponent('SELECT COUNT() FROM WorkOrder'));
        const after = global.ok && typeof (global.body as any)?.totalSize === 'number' ? (global.body as any).totalSize : -1;
        if (globalBefore >= 0 && after >= 0 && after > globalBefore) {
          cleanupError ??= `WorkOrder surplus detected (${globalBefore} -> ${after}); minted rows may have escaped plan scope.`;
        }
      }
    } catch { cleanupError ??= 'Owned work-orders cleanup could not be independently read back.'; }
  }
  if (cleanupError) return {status:outcome.status,body:outcome.body,cleanupError};
  return successful(outcome)
    ? {...outcome, contextSchema:{source:'salesforce_live_native_work_orders_action',verified:true,marker}}
    : outcome;
}
