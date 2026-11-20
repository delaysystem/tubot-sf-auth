import { describe, expect, test } from 'bun:test';
import { invokePaymentAuthorizationWithContext, PAYMENT_AUTH_ACTIONS } from './payment-auth-owned-context';

const ROOT = '/services/data/v67.0';
const ROUTE = `${ROOT}/actions/standard/authorizePayment`;
const ACCT = '001g5000001aBcDAAU';
const METHOD = '8ZJg50000001aBcEAU';
const GATEWAY = '0Uvg50000001aBcEAU';
const AUTH = '8WJg50000001aBcEAU';

type Req = (path: string, method?: string, body?: any) => Promise<{ status: number; ok: boolean; body: any }>;
const ok = (body: any, status = 200) => ({ status, ok: status >= 200 && status < 300, body });
const build = async (_n: string, _m: string, values: any) => ({ values });
const accepted = () => [{ actionName: 'authorizePayment', errors: null, isSuccess: true, outputValues: { paymentAuthorizationId: AUTH } }];

const baseRequest = (over: Record<string, (m?: string, b?: any) => any> = {}): Req => async (path, method = 'GET', body) => {
  if (over[path]) return over[path](method, body);
  if (path === ROOT + '/sobjects/Account/describe') return ok({ createable: true, queryable: true });
  if (path === ROOT + '/sobjects/CardPaymentMethod/describe') return ok({ createable: true, queryable: true, fields: [
    { name: 'Status', picklistValues: [{ active: true, value: 'Active' }] },
    { name: 'ProcessingMode', picklistValues: [{ active: true, value: 'External' }, { active: true, value: 'Salesforce' }] },
  ] });
  if (path === ROOT + '/actions/standard/authorizePayment' && method === 'GET') return ok({ inputs: [{ name: 'paymentAuthorizationRequest' }] });
  if (path.startsWith(ROOT + '/query?q=')) {
    const q = decodeURIComponent(path.slice((ROOT + '/query?q=').length));
    if (q.includes('FROM PaymentGateway')) return ok({ records: [{ Id: GATEWAY, PaymentGatewayName: 'AS test' }] });
    if (q.includes('FROM CurrencyType')) return ok({ records: [{ IsoCode: 'USD' }] });
    if (q.includes('FROM PaymentAuthorization')) return ok({ records: [{ Id: AUTH }] });
    return ok({ records: [] });
  }
  if (path === ROOT + '/sobjects/Account' && method === 'POST') return ok({ id: ACCT }, 201);
  if (path === ROOT + '/sobjects/CardPaymentMethod' && method === 'POST') return ok({ id: METHOD }, 201);
  if (path === ROOT + '/sobjects/CardPaymentMethod/' + METHOD && method === 'GET') return ok({ NickName: body ?? undefined, Id: METHOD });
  if (path === ROUTE && method === 'POST') return ok(accepted());
  if (path === ROOT + '/composite/batch' && method === 'POST') {
    const n = Array.isArray((body as any)?.batchRequests) ? (body as any).batchRequests.length : 0;
    return ok({ results: Array.from({ length: n }, () => ({ statusCode: 404 })) });
  }
  if (method === 'DELETE') return ok(null, 204);
  if (method === 'PATCH') return ok(null, 204);
  return ok(null, 404);
};

describe('payment-auth owned context', () => {
  test('rejects unsupported actions', async () => {
    const out = await invokePaymentAuthorizationWithContext({ root: ROOT, route: ROOT + '/actions/standard/other', request: baseRequest(), build });
    expect(out.status).toBe(422);
    expect(PAYMENT_AUTH_ACTIONS).toEqual(['authorizePayment']);
  });
  test('fails without an Active gateway', async () => {
    const request = baseRequest({
      [ROOT + '/query?q=' + encodeURIComponent("SELECT Id,PaymentGatewayName FROM PaymentGateway WHERE Status = 'Active' ORDER BY CreatedDate LIMIT 1")]: () => ok({ records: [] }),
    });
    const out = await invokePaymentAuthorizationWithContext({ root: ROOT, route: ROUTE, request, build });
    expect(out.status).toBe(422);
    expect((out.body as any).errorCode).toBe('PAYMENT_AUTH_GATEWAY_UNAVAILABLE');
  });
  test('happy path converts and reports the neutralized auth as residue', async () => {
    let methodNick: string | undefined, marker: string | undefined;
    const request: Req = async (path, method = 'GET', body) => {
      if (path === ROOT + '/sobjects/CardPaymentMethod' && method === 'POST') { methodNick = (body as any).NickName; return ok({ id: METHOD }, 201); }
      if (path === ROOT + '/sobjects/CardPaymentMethod/' + METHOD && method === 'GET') return ok({ NickName: methodNick, Id: METHOD });
      if (path === ROOT + '/sobjects/PaymentAuthorization/' + AUTH && method === 'DELETE') return ok({ message: 'guarded' }, 400);
      if (path === ROOT + '/sobjects/PaymentAuthorization/' + AUTH && method === 'PATCH' && (body as any)?.Comments) marker = (body as any).Comments;
      if (path === ROOT + '/sobjects/PaymentAuthorization/' + AUTH && method === 'GET') {
        return ok({ Id: AUTH, Status: 'Canceled', AccountId: null, PaymentMethodId: null, Comments: marker });
      }
      return baseRequest()(path, method, body);
    };
    const out = await invokePaymentAuthorizationWithContext({ root: ROOT, route: ROUTE, request, build });
    expect(out.status).toBe(200);
    expect((out.body as any)[0].isSuccess).toBe(true);
    expect(out.cleanupError).toBeUndefined();
    expect((out.contextSchema as any).verified).toBe(true);
    expect((out.contextSchema as any).residue).toEqual([
      { objectName: 'PaymentAuthorization', id: AUTH, status: 'Canceled', unlinked: true, markerCommented: true },
    ]);
  });
  test('guard-blocked survivor without proven neutralization keeps a cleanup error', async () => {
    let methodNick: string | undefined;
    const request: Req = async (path, method = 'GET', body) => {
      if (path === ROOT + '/sobjects/CardPaymentMethod' && method === 'POST') { methodNick = (body as any).NickName; return ok({ id: METHOD }, 201); }
      if (path === ROOT + '/sobjects/CardPaymentMethod/' + METHOD && method === 'GET') return ok({ NickName: methodNick, Id: METHOD });
      if (path === ROOT + '/sobjects/PaymentAuthorization/' + AUTH && method === 'DELETE') return ok({ message: 'guarded' }, 400);
      if (path === ROOT + '/sobjects/PaymentAuthorization/' + AUTH && method === 'GET') {
        return ok({ Id: AUTH, Status: 'Pending', AccountId: ACCT, PaymentMethodId: METHOD, Comments: null });
      }
      return baseRequest()(path, method, body);
    };
    const out = await invokePaymentAuthorizationWithContext({ root: ROOT, route: ROUTE, request, build });
    expect(out.status).toBe(200);
    expect(out.cleanupError).toContain('guard-blocked');
    expect((out.contextSchema as any).verified).toBe(false);
    expect((out.contextSchema as any).residue).toBeUndefined();
  });
  test('retires cleanly when the platform allows auth deletion', async () => {
    let methodNick: string | undefined;
    const request: Req = async (path, method = 'GET', body) => {
      if (path === ROOT + '/sobjects/CardPaymentMethod' && method === 'POST') { methodNick = (body as any).NickName; return ok({ id: METHOD }, 201); }
      if (path === ROOT + '/sobjects/CardPaymentMethod/' + METHOD && method === 'GET') return ok({ NickName: methodNick, Id: METHOD });
      return baseRequest()(path, method, body);
    };
    const out = await invokePaymentAuthorizationWithContext({ root: ROOT, route: ROUTE, request, build });
    expect(out.status).toBe(200);
    expect(out.cleanupError).toBeUndefined();
  });
});
