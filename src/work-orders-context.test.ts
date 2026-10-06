import { describe, expect, test } from 'bun:test';
import { invokeWorkOrdersWithContext, WORK_ORDERS_ACTIONS } from './work-orders-context';

const ROOT = '/services/data/v67.0';
const ROUTE = `${ROOT}/actions/standard/generateWorkOrders`;
const PLAN = '01Ng5000001aBcDEAU';
const RULE = '01Og5000001aBcEEAU';
const WO1 = '0WOg5000001aBcFEAU';

type Req = (path: string, method?: string, body?: any) => Promise<{ status: number; ok: boolean; body: any }>;
const ok = (body: any, status = 200) => ({ status, ok: status >= 200 && status < 300, body });
const build = async (_n: string, _m: string, values: any) => ({ values });

const MP_DESCRIBE = { createable: true, queryable: true, deletable: true, fields: [
  { name: 'MaintenancePlanTitle', createable: true },
  { name: 'StartDate', createable: true, nillable: false, defaultedOnCreate: false },
  { name: 'NextSuggestedMaintenanceDate', createable: true, nillable: false, defaultedOnCreate: false },
  { name: 'GenerationTimeframe', createable: true, nillable: false, defaultedOnCreate: false },
  { name: 'WorkOrderGenerationStatus' },
] };
const MWR_DESCRIBE = { createable: true, queryable: true, deletable: true, fields: [
  { name: 'Title', createable: true }, { name: 'SortOrder', createable: true },
  { name: 'ParentMaintenancePlanId', createable: true },
  { name: 'Type', createable: true, picklistValues: [{ active: true, value: 'Calendar' }] },
  { name: 'RecurrencePattern', createable: true },
] };

describe('work-orders owned context', () => {
  test('rejects unsupported actions', async () => {
    const request: Req = async () => ok(null, 404);
    const out = await invokeWorkOrdersWithContext({ root: ROOT, route: ROOT + '/actions/standard/other', request, build });
    expect(out.status).toBe(422);
    expect(WORK_ORDERS_ACTIONS).toEqual(['generateWorkOrders']);
  });
  test('fails closed on fixture-shape drift', async () => {
    const drifted = { ...MP_DESCRIBE, fields: MP_DESCRIBE.fields.filter(f => f.name !== 'GenerationTimeframe') };
    const request: Req = async (path) => {
      if (path === ROOT + '/sobjects/MaintenancePlan/describe') return ok(drifted);
      if (path === ROOT + '/sobjects/MaintenanceWorkRule/describe') return ok(MWR_DESCRIBE);
      return ok(null, 404);
    };
    const out = await invokeWorkOrdersWithContext({ root: ROOT, route: ROUTE, request, build });
    expect(out.status).toBe(422);
    expect((out.body as any).errorCode).toBe('WORK_ORDERS_SHAPE_DRIFTED');
  });
  test('happy path converts with scoped cleanup and no surplus', async () => {
    let minted = false, planDeleted = false;
    const request: Req = async (path, method = 'GET', body) => {
      if (path === ROOT + '/sobjects/MaintenancePlan/describe') return ok(MP_DESCRIBE);
      if (path === ROOT + '/sobjects/MaintenanceWorkRule/describe') return ok(MWR_DESCRIBE);
      if (path === ROUTE && method === 'GET') return ok({ inputs: [{ name: 'recordId' }] });
      if (path === ROOT + '/sobjects/MaintenancePlan' && method === 'POST') return ok({ id: PLAN }, 201);
      if (path === ROOT + '/sobjects/MaintenanceWorkRule' && method === 'POST') return ok({ id: RULE }, 201);
      if (path === ROUTE && method === 'POST') { minted = true; return ok([{ actionName: 'generateWorkOrders', errors: null, isSuccess: true, outputValues: {} }]); }
      if (path.startsWith(ROOT + '/query?q=')) {
        const q = decodeURIComponent(path.slice((ROOT + '/query?q=').length));
        if (q.startsWith('SELECT COUNT() FROM WorkOrder')) return ok({ totalSize: 0 });
        if (q.includes('MaintenancePlanId')) return ok({ records: minted ? [{ Id: WO1 }] : [] });
        if (q.includes('WorkOrderGenerationStatus')) return ok({ records: [{ WorkOrderGenerationStatus: 'Complete' }] });
        return ok({ records: [] });
      }
      if (path === ROOT + '/composite/batch' && method === 'POST') {
        const n = Array.isArray((body as any)?.batchRequests) ? (body as any).batchRequests.length : 0;
        minted = false;
        return ok({ results: Array.from({ length: n }, () => ({ statusCode: 204 })) });
      }
      if (path === ROOT + '/sobjects/WorkOrder/' + WO1 && method === 'DELETE') { minted = false; return ok(null, 204); }
      if (path === ROOT + '/sobjects/MaintenanceWorkRule/' + RULE && method === 'DELETE') return ok(null, 204);
      if (path === ROOT + '/sobjects/MaintenancePlan/' + PLAN && method === 'DELETE') { planDeleted = true; return ok(null, 204); }
      if (path === ROOT + '/sobjects/MaintenancePlan/' + PLAN && method === 'GET') return planDeleted ? ok(null, 404) : ok({ Id: PLAN });
      return ok(null, 404);
    };
    const out = await invokeWorkOrdersWithContext({ root: ROOT, route: ROUTE, request, build });
    expect(out.status).toBe(200);
    expect(out.cleanupError).toBeUndefined();
    expect((out.contextSchema as any)?.verified).toBe(true);
  }, 120000);
});
