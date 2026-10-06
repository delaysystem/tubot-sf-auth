import { expect, test } from 'bun:test';
import { discoverStoreBuyerGroups, provisionBuyerChain } from './commerce-provisioned-context';

const ROOT = '/services/data/v67.0';
const ACCT = '001000000000001AAA';
const BUYER = '0BJ000000000001AAA';
const MEMBER = '0ZJ000000000001AAA';
const G1 = '0ZI000000000001AAA';
const G2 = '0ZI000000000002AAA';

type Req = (path: string, method?: string, body?: any) => Promise<{ status: number; ok: boolean; body: any }>;
const ok = (body: any, status = 200) => ({ status, ok: status >= 200 && status < 300, body });
const build = async (_n: string, _m: string, values: any) => ({ values });

test('group discovery returns every linked group id-validated', async () => {
  const request: Req = async (path) => {
    if (decodeURIComponent(path).includes('FROM WebStoreBuyerGroup')) return ok({ records: [{ BuyerGroupId: G1 }, { BuyerGroupId: G2 }, { BuyerGroupId: 'bogus' }, { BuyerGroupId: G1 }] });
    return ok(null, 404);
  };
  expect(await discoverStoreBuyerGroups(request, ROOT, '0ZE000000000001AAA')).toEqual([G1, G2]);
});

test('group discovery fails closed to an empty list', async () => {
  const request: Req = async () => ok(null, 500);
  expect(await discoverStoreBuyerGroups(request, ROOT, '0ZE000000000001AAA')).toEqual([]);
});

test('member ladder falls through a 400 group and converts on the next', async () => {
  const seen: string[] = [];
  const request: Req = async (path, method = 'GET', body) => {
    if (path === ROOT + '/sobjects/Account' && method === 'POST') return ok({ id: ACCT }, 201);
    if (path === ROOT + '/sobjects/Account/' + ACCT) return ok({ Id: ACCT, Name: (body as any)?.Name ?? 'x' });
    if (path === ROOT + '/sobjects/BuyerAccount' && method === 'POST') return ok({ id: BUYER }, 201);
    if (path === ROOT + '/sobjects/Contact' && method === 'POST') return ok({ id: '003000000000001AAA' }, 201);
    if (path === ROOT + '/sobjects/BuyerGroupMember' && method === 'POST') {
      seen.push((body as any).BuyerGroupId);
      if ((body as any).BuyerGroupId === G1) return ok([{ message: "can't be added to this buyer group.", errorCode: 'INVALID_FIELD' }], 400);
      return ok({ id: MEMBER }, 201);
    }
    return ok(null, 404);
  };
  // Account readback must echo the marker for the chain to proceed.
  const chain = await provisionBuyerChain({
    root: ROOT, marker: 'm', groupIds: [G1, G2], request: (async (path: string, method?: string, body?: any) => {
      if (path === ROOT + '/sobjects/Account/' + ACCT) return ok({ Id: ACCT, Name: 'm' });
      return request(path, method, body);
    }) as Req, build, capture: () => {},
  });
  expect(seen).toEqual([G1, G2]);
  expect('ids' in chain && chain.ids.memberId).toBe(MEMBER);
  expect('ids' in chain && chain.memberAttempts).toEqual([
    { groupId: G1, status: 400, errorCode: 'INVALID_FIELD' },
    { groupId: G2, status: 201 },
  ]);
});

test('member ladder stops honest on non-400 with partial cleanup evidence', async () => {
  const captured: Array<{ objectName: string; id: string }> = [];
  const request: Req = async (path, method = 'GET') => {
    if (path === ROOT + '/sobjects/Account' && method === 'POST') return ok({ id: ACCT }, 201);
    if (path === ROOT + '/sobjects/Account/' + ACCT) return ok({ Id: ACCT, Name: 'm' });
    if (path === ROOT + '/sobjects/BuyerAccount' && method === 'POST') return ok({ id: BUYER }, 201);
    if (path === ROOT + '/sobjects/Contact' && method === 'POST') return ok({ id: '003000000000001AAA' }, 201);
    if (path === ROOT + '/sobjects/BuyerGroupMember' && method === 'POST') return ok(null, 403);
    return ok(null, 404);
  };
  const chain = await provisionBuyerChain({
    root: ROOT, marker: 'm', groupIds: [G1, G2], request, build,
    capture: (objectName, id) => captured.push({ objectName, id }),
  });
  expect('failure' in chain && chain.failure.status).toBe(403);
  expect('failure' in chain && chain.memberAttempts).toEqual([{ groupId: G1, status: 403 }]);
  expect('failure' in chain && chain.partial.map((p) => p.objectName)).toEqual(['Account', 'BuyerAccount', 'Contact']);
  expect(captured.map((p) => p.objectName)).toEqual(['Account', 'BuyerAccount', 'Contact']);
});

test('empty candidate groups fail before any write', async () => {
  let posts = 0;
  const request: Req = async (_p, method = 'GET') => { if (method === 'POST') posts++; return ok(null, 404); };
  const chain = await provisionBuyerChain({ root: ROOT, marker: 'm', groupIds: [], request, build, capture: () => {} });
  expect('failure' in chain && (chain.failure.body as any).errorCode).toBe('CART_BUYER_GROUP_UNAVAILABLE');
  expect(posts).toBe(0);
});
