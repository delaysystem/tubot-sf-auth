import { describe, expect, test } from 'bun:test';
import { invokeServiceReportWithContext, SERVICE_REPORT_ACTIONS } from './service-report-context';

const ROOT = '/services/data/v67.0';
const ROUTE = `${ROOT}/actions/standard/createServiceReport`;
const WO = '0WOg5000001aBcDEAU';
const SR = '0S9g5000001aBcEEAU';
const DOC = '069g5000001aBcFEAU';

type Req = (path: string, method?: string, body?: any) => Promise<{ status: number; ok: boolean; body: any }>;
const ok = (body: any, status = 200) => ({ status, ok: status >= 200 && status < 300, body });
const build = async (_n: string, _m: string, values: any) => ({ values });

const baseRequest = (over: Record<string, (m?: string, b?: any) => any> = {}): Req => async (path, method = 'GET', body) => {
  if (over[path]) return over[path](method, body);
  if (path === ROOT + '/sobjects/WorkOrder/describe') return ok({ createable: true, queryable: true, deletable: true, fields: [
    { name: 'Subject', createable: true, filterable: true },
  ] });
  if (path === ROUTE && method === 'GET') return ok({ inputs: [{ name: 'entityId' }] });
  if (path === ROOT + '/sobjects/WorkOrder' && method === 'POST') return ok({ id: WO }, 201);
  if (path === ROUTE && method === 'POST') return ok([{ actionName: 'createServiceReport', errors: null, isSuccess: true,
    outputValues: { serviceReportId: SR, contentVersionId: DOC } }]);
  if (path === ROOT + '/sobjects/ServiceReport/' + SR && method === 'GET') return ok({ Id: SR });
  if (path.startsWith(ROOT + '/query?q=')) return ok({ records: [] });
  if (method === 'DELETE') return ok(null, 204);
  return ok(null, 404);
};

describe('service-report owned context', () => {
  test('rejects unsupported actions', async () => {
    const out = await invokeServiceReportWithContext({ root: ROOT, route: ROOT + '/actions/standard/other', request: baseRequest(), build });
    expect(out.status).toBe(422);
    expect(SERVICE_REPORT_ACTIONS).toEqual(['createServiceReport']);
  });
  test('happy path converts with verified context and ordered cleanup', async () => {
    let marker = '', deleted: string[] = [];
    const seen: string[] = [];
    const request: Req = async (path, method = 'GET', body) => {
      if (path === ROOT + '/sobjects/WorkOrder' && method === 'POST') { marker = (body as any).Subject; return ok({ id: WO }, 201); }
      if (path === ROOT + '/sobjects/WorkOrder/' + WO && method === 'GET') {
        return deleted.includes(WO) ? ok(null, 404) : ok({ Subject: marker, Id: WO });
      }
      if (method === 'DELETE') { seen.push(path.split('/').at(-1)!); if (path.endsWith(WO)) deleted.push(WO); return ok(null, 204); }
      return baseRequest()(path, method, body);
    };
    const out = await invokeServiceReportWithContext({ root: ROOT, route: ROUTE, request, build });
    expect(out.status).toBe(200);
    expect(out.cleanupError).toBeUndefined();
    expect((out.contextSchema as any)?.verified).toBe(true);
    expect(seen).toEqual([SR, DOC, WO]);
  });
  test('missing outputs fail without verified context', async () => {
    let marker = '';
    const request: Req = async (path, method = 'GET', body) => {
      if (path === ROOT + '/sobjects/WorkOrder' && method === 'POST') { marker = (body as any).Subject; return ok({ id: WO }, 201); }
      if (path === ROOT + '/sobjects/WorkOrder/' + WO && method === 'GET') return ok({ Subject: marker, Id: WO });
      if (path === ROUTE && method === 'POST') return ok([{ actionName: 'createServiceReport', errors: null, isSuccess: true, outputValues: {} }]);
      if (method === 'DELETE') return ok(null, 204);
      return baseRequest()(path, method, body);
    };
    const out = await invokeServiceReportWithContext({ root: ROOT, route: ROUTE, request, build });
    expect(out.status).toBe(422);
    expect((out.body as any).errorCode).toBe('SERVICE_REPORT_OUTPUT_MISSING');
    expect((out.contextSchema as any)?.verified).not.toBe(true);
  });
});
