import { expect, test } from 'bun:test';
import { invokeFixtureBackedRead, FIXTURE_READ_ACTION_SPECS } from './fixture-read-context';

const root = '/services/data/v67.0';

function harness(mode: 'success' | 'rejected' | 'stuck' | 'noeid' = 'success') {
  const records = new Map<string, Record<string, any>>();
  const seen: Array<{ path: string; method: string; body?: any }> = [];
  const request = async (path: string, method = 'GET', body?: any): Promise<any> => {
    seen.push({ path, method, body });
    if (path.endsWith('/describe')) {
      return { status: 200, ok: true, body: { createable: true, queryable: true, deletable: true,
        fields: [{ name: 'Name', type: 'string', length: 80, createable: true, filterable: true, nameField: true }] } };
    }
    if (path.includes('/query?q=')) {
      const marker = decodeURIComponent(path).match(/Name='([^']+)'/)?.[1];
      const hits = [...records.values()].filter((item) => item.Name === marker).map((item) => ({ Id: item.Id }));
      return { status: 200, ok: true, body: { done: true, records: hits } };
    }
    if (path.includes('/actions/standard/') && method === 'POST') {
      const id = body?.inputs?.[0]?.recordId ?? body?.inputs?.[0]?.parentRecordId;
      if (mode === 'rejected') return { status: 400, ok: false, body: [{ isSuccess: false, errors: [{ message: 'nope' }] }] };
      if (mode === 'noeid') return { status: 200, ok: true, body: [{ isSuccess: true, outputValues: {} }] };
      return { status: 200, ok: true, body: [{ isSuccess: true, outputValues: { Id: id } }] };
    }
    if (path === `${root}/sobjects/Account` && method === 'POST') {
      const id = '001000000000001AAA';
      records.set(id, { Id: id, ...body });
      return { status: 201, ok: true, body: { id } };
    }
    const id = path.split('/').at(-1)!;
    if (method === 'DELETE') {
      if (mode === 'stuck') return { status: 204, ok: true, body: null };
      const existed = records.delete(id);
      return { status: existed ? 204 : 404, ok: existed, body: null };
    }
    const value = records.get(id);
    return value ? { status: 200, ok: true, body: value } : { status: 404, ok: false, body: null };
  };
  const build = async (_name: string, _marker: string, values: Record<string, any>) => ({ values });
  return { request, build, seen };
}

test('fixture-backed getRecord verifies the echoed identity and cleans up', async () => {
  const { request, build, seen } = harness();
  const result = await invokeFixtureBackedRead({ root, route: `${root}/actions/standard/getRecord`,
    target: 'Account', idInput: 'recordId', verifyIdentityInResponse: true,
    args: { objectApiName: 'Account' }, request, build });
  expect(result.status).toBe(200);
  expect((result.contextSchema as any).verified).toBe(true);
  expect(result.cleanupError).toBeUndefined();
  const post = seen.find((call) => call.method === 'POST' && call.path.includes('/actions/standard/'));
  expect(post?.body.inputs[0].recordId).toBe('001000000000001AAA');
  expect(post?.body.inputs[0].objectApiName).toBe('Account');
});

test('fixture-backed getRelatedList accepts native success without id echo', async () => {
  const { request, build, seen } = harness('noeid');
  const result = await invokeFixtureBackedRead({ root, route: `${root}/actions/standard/getRelatedList`,
    target: 'Account', idInput: 'parentRecordId', verifyIdentityInResponse: false,
    args: { relatedListName: 'Contacts' }, request, build });
  expect(result.status).toBe(200);
  expect((result.contextSchema as any).verified).toBe(true);
  expect(result.cleanupError).toBeUndefined();
  const post = seen.find((call) => call.method === 'POST' && call.path.includes('/actions/standard/'));
  expect(post?.body.inputs[0].parentRecordId).toBe('001000000000001AAA');
});

test('getRecord without echoed identity is unverified, never weakened', async () => {
  const { request, build } = harness('noeid');
  const result = await invokeFixtureBackedRead({ root, route: `${root}/actions/standard/getRecord`,
    target: 'Account', idInput: 'recordId', verifyIdentityInResponse: true,
    args: { objectApiName: 'Account' }, request, build });
  expect(result.status).toBe(422);
  expect((result.contextSchema as any).verified).toBe(false);
  expect(result.cleanupError).toBeUndefined();
});

test('stuck fixtures surface an honest cleanupError', async () => {
  const { request, build } = harness('stuck');
  const result = await invokeFixtureBackedRead({ root, route: `${root}/actions/standard/getRecord`,
    target: 'Account', idInput: 'recordId', verifyIdentityInResponse: true,
    args: { objectApiName: 'Account' }, request, build });
  expect(result.cleanupError).toBeString();
  expect((result.contextSchema as any).verified).toBe(false);
});

test('spec membership covers the read family', () => {
  expect(Object.keys(FIXTURE_READ_ACTION_SPECS).sort()).toEqual(['getRecord', 'getRelatedList']);
});
