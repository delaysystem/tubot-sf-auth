import { expect, test } from 'bun:test';
import { ASSET_REPLACE_BUILDER_VERSION, ASSET_REPLACE_SPECS, invokeAssetReplace } from './asset-replace-context';

const root = '/services/data/v67.0';
const route = `${root}/actions/standard/replaceAsset`;
const ACTION = 'replaceAsset';

const ACCT = '001000000000001AAA';
const A1 = '02i000000000001AAA';
const A2 = '02i000000000002AAA';
const REL = '1AR000000000001AAA';

function harness(mode: 'success' | 'no-relationship' | 'rowless-account' = 'success') {
  const records = new Map<string, Record<string, any>>();
  const seen: Array<{ path: string; method: string; body?: any }> = [];
  let minted = 0;
  const request = async (path: string, method = 'GET', body?: any): Promise<any> => {
    seen.push({ path, method, body });
    if (path.endsWith('/sobjects/Asset/describe')) {
      return { status: 200, ok: true, body: { createable: true, queryable: true, deletable: true,
        fields: [
          { name: 'Name', type: 'string', length: 255, createable: true, filterable: true },
          { name: 'AccountId', type: 'reference', createable: true, referenceTo: ['Account'] },
        ] } };
    }
    if (path.includes('/query?q=')) {
      const decoded = decodeURIComponent(path);
      if (decoded.includes('FROM Account')) {
        return { status: 200, ok: true, body: { records: mode === 'rowless-account' ? [] : [{ Id: ACCT }] } };
      }
      if (decoded.includes('FROM AssetRelationship')) {
        const hit = [...records.values()].find((item) => item.AssetId !== undefined && item.RelatedAssetId !== undefined);
        return { status: 200, ok: true, body: { records: hit ? [{ Id: hit.Id }] : [] } };
      }
      const marker = decoded.match(/Name='([^']+)'/)?.[1];
      const hits = [...records.values()].filter((item) => item.Name === marker).map((item) => ({ Id: item.Id }));
      return { status: 200, ok: true, body: { done: true, records: hits } };
    }
    if (path === route && method === 'POST') {
      if (mode !== 'no-relationship') {
        records.set(REL, { Id: REL, AssetId: body.inputs[0].assetId, RelatedAssetId: body.inputs[0].relatedAssetId });
      }
      return { status: 200, ok: true, body: [{ isSuccess: true, errors: [], outputValues: {} }] };
    }
    if (path === `${root}/sobjects/Asset` && method === 'POST') {
      minted += 1;
      const id = minted === 1 ? A1 : A2;
      records.set(id, { Id: id, ...body });
      return { status: 201, ok: true, body: { id } };
    }
    const id = path.split('/').at(-1)!;
    if (method === 'DELETE') {
      const existed = records.delete(id);
      return { status: existed ? 204 : 404, ok: existed, body: null };
    }
    const value = records.get(id);
    return { status: value ? 200 : 404, ok: !!value, body: value ?? null };
  };
  const build = async (_name: string, _marker: string, values: Record<string, unknown>) => ({ values });
  return { records, seen, request, build };
}

test('asset replace mints two owned assets, verifies the relationship, and cleans all', async () => {
  const state = harness('success');
  const result = await invokeAssetReplace({ root, route, actionName: ACTION,
    request: state.request, build: state.build });
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.relationshipVerified).toBe(true);
  expect(result.cleanupError).toBeUndefined();
  const invoked = state.seen.find((call) => call.path === route && call.method === 'POST');
  expect(invoked?.body.inputs[0]).toEqual({ assetId: A1, relatedAssetId: A2 });
  expect(state.records.size).toBe(0);
});

test('rowless account refuses honest before any fixture', async () => {
  const state = harness('rowless-account');
  const result = await invokeAssetReplace({ root, route, actionName: ACTION,
    request: state.request, build: state.build });
  expect(result.body).toMatchObject({ errorCode: 'ASSET_REPLACE_SETUP_REQUIRED' });
  expect(state.records.size).toBe(0);
});

test('missing relationship withholds verification but still cleans', async () => {
  const state = harness('no-relationship');
  const result = await invokeAssetReplace({ root, route, actionName: ACTION,
    request: state.request, build: state.build });
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(false);
  expect(result.contextSchema?.relationshipVerified).toBe(false);
  expect(result.cleanupError).toBeUndefined();
  expect(state.records.size).toBe(0);
});

test('asset replace spec map and builder version cover the member', async () => {
  expect(Object.keys(ASSET_REPLACE_SPECS)).toEqual(['replaceAsset']);
  expect(ASSET_REPLACE_BUILDER_VERSION).toBe(151);
  const state = harness('success');
  const result = await invokeAssetReplace({ root, route: `${root}/actions/standard/unknownAction`, actionName: 'unknownAction',
    request: state.request, build: state.build });
  expect(result.body).toMatchObject({ errorCode: 'ASSET_REPLACE_SPEC_INVALID' });
});
