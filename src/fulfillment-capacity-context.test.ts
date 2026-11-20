import { describe, expect, test } from 'bun:test';
import { invokeFulfillmentCapacityWithContext, FULFILLMENT_CAPACITY_ACTIONS } from './fulfillment-capacity-context';

const ROOT = '/services/data/v67.0';
const LOC = '131g5000001aBcDAAU';
const routeFor = (a: string) => `${ROOT}/actions/standard/${a}`;

type Req = (path: string, method?: string, body?: any) => Promise<{ status: number; ok: boolean; body: any }>;
const ok = (body: any, status = 200) => ({ status, ok: status >= 200 && status < 300, body });
const build = async (_n: string, _m: string, values: any) => ({ values });
const accepted = (action: string) => [{ actionName: action, errors: null, isSuccess: true, outputValues: { accepted: true } }];

const LOCATION_DESCRIBE = { createable: true, queryable: true, deletable: true, fields: [
  { name: 'Name', createable: true, filterable: true },
  { name: 'LocationType', createable: true, picklistValues: [{ active: true, value: 'Site' }] },
  { name: 'IsMobile', createable: true }, { name: 'IsInventoryLocation', createable: true },
  { name: 'ShouldTrackFoCapacity', createable: true }, { name: 'FoCapacity', createable: true },
] };

const baseRequest = (over: Record<string, (m?: string, b?: any) => any> = {}): Req => async (path, method = 'GET', body) => {
  if (over[path]) return over[path](method, body);
  if (path === ROOT + '/sobjects/Location/describe') return ok(LOCATION_DESCRIBE);
  if (path.startsWith(ROOT + '/actions/standard/') && method === 'GET') {
    return ok({ inputs: [{ name: 'holdFOCapacityInput' }, { name: 'confirmHeldFOCapacityInput' },
      { name: 'releaseHeldFOCapacityInput' }, { name: 'getFulfillmentOrderCapacityValuesInput' }] });
  }
  if (path === ROOT + '/sobjects/Location' && method === 'POST') return ok({ id: LOC }, 201);
  if (path === ROOT + '/sobjects/Location/' + LOC && method === 'GET') return ok({ Name: body ?? undefined, Id: LOC });
  if (path === ROOT + '/actions/standard/getFulfillmentOrderCapacityValues' && method === 'POST') {
    return ok([{ actionName: 'getFulfillmentOrderCapacityValues', errors: null, isSuccess: true,
      outputValues: { getFulfillmentOrderCapacityValuesOutput: { locations: [{ capacity: 100, assigned: 0, heldCapacity: 1 }] } } }]);
  }
  if (path.startsWith(ROOT + '/actions/standard/') && method === 'POST') {
    const action = path.split('/').at(-1)!;
    return ok(accepted(action));
  }
  if (path.startsWith(ROOT + '/query?q=')) return ok({ records: [] });
  if (method === 'DELETE') return ok(null, 204);
  return ok(null, 404);
};

describe('fulfillment-capacity owned context', () => {
  test('rejects unsupported actions', async () => {
    const out = await invokeFulfillmentCapacityWithContext({ root: ROOT, route: routeFor('other'), request: baseRequest(), build });
    expect(out.status).toBe(422);
    expect(FULFILLMENT_CAPACITY_ACTIONS).toHaveLength(4);
  });
  test('fails without a live LocationType value', async () => {
    const noTypes = { ...LOCATION_DESCRIBE, fields: LOCATION_DESCRIBE.fields.map(f =>
      f.name === 'LocationType' ? { ...f, picklistValues: [] } : f) };
    const request = baseRequest({ [ROOT + '/sobjects/Location/describe']: () => ok(noTypes) });
    const out = await invokeFulfillmentCapacityWithContext({ root: ROOT, route: routeFor('holdFulfillmentOrderCapacity'), request, build });
    expect(out.status).toBe(422);
    expect((out.body as any).errorCode).toBe('FULFILLMENT_TYPE_UNAVAILABLE');
  });
  test('hold converts with verified counters and clean sweep', async () => {
    let marker = '';
    const request: Req = async (path, method = 'GET', body) => {
      if (path === ROOT + '/sobjects/Location' && method === 'POST') { marker = (body as any).Name; return ok({ id: LOC }, 201); }
      if (path === ROOT + '/sobjects/Location/' + LOC && method === 'GET') {
        return method === 'GET' && marker ? ok({ Name: marker, Id: LOC }) : ok(null, 404);
      }
      return baseRequest()(path, method, body);
    };
    const deleting: Req = async (path, method = 'GET', body) => {
      if (path === ROOT + '/sobjects/Location/' + LOC && method === 'DELETE') { marker = ''; return ok(null, 204); }
      return request(path, method, body);
    };
    const out = await invokeFulfillmentCapacityWithContext({ root: ROOT, route: routeFor('holdFulfillmentOrderCapacity'), request: deleting, build });
    expect(out.status).toBe(200);
    expect(out.cleanupError).toBeUndefined();
    expect((out.contextSchema as any)?.verified).toBe(true);
  });
  test('values read converts on exact fresh counters', async () => {
    let marker = 'x', deleted = false;
    const request: Req = async (path, method = 'GET', body) => {
      if (path === ROOT + '/sobjects/Location' && method === 'POST') { marker = (body as any).Name; return ok({ id: LOC }, 201); }
      if (path === ROOT + '/sobjects/Location/' + LOC && method === 'GET') return deleted ? ok(null, 404) : ok({ Name: marker, Id: LOC });
      if (path === ROOT + '/sobjects/Location/' + LOC && method === 'DELETE') { deleted = true; return ok(null, 204); }
      if (path === ROOT + '/actions/standard/getFulfillmentOrderCapacityValues' && method === 'POST') {
        return ok([{ actionName: 'getFulfillmentOrderCapacityValues', errors: null, isSuccess: true,
          outputValues: { getFulfillmentOrderCapacityValuesOutput: { locations: [{ capacity: 100, assigned: 0, heldCapacity: 0 }] } } }]);
      }
      return baseRequest()(path, method, body);
    };
    const out = await invokeFulfillmentCapacityWithContext({ root: ROOT, route: routeFor('getFulfillmentOrderCapacityValues'), request, build });
    expect(out.status).toBe(200);
    expect((out.contextSchema as any)?.verified).toBe(true);
  });
  test('refusals pass through without verified context', async () => {
    let marker = '', deleted = false;
    const request: Req = async (path, method = 'GET', body) => {
      if (path === ROOT + '/sobjects/Location' && method === 'POST') { marker = (body as any).Name; return ok({ id: LOC }, 201); }
      if (path === ROOT + '/sobjects/Location/' + LOC) {
        if (method === 'DELETE') { deleted = true; return ok(null, 204); }
        return deleted ? ok(null, 404) : ok({ Name: marker, Id: LOC });
      }
      if (path === ROOT + '/actions/standard/holdFulfillmentOrderCapacity' && method === 'POST') {
        return ok([{ actionName: 'holdFulfillmentOrderCapacity', errors: [{ message: 'nope' }], isSuccess: false }]);
      }
      return baseRequest()(path, method, body);
    };
    const out = await invokeFulfillmentCapacityWithContext({ root: ROOT, route: routeFor('holdFulfillmentOrderCapacity'), request, build });
    expect(out.status).toBe(200);
    expect((out.contextSchema as any)?.verified).not.toBe(true);
  });
});
