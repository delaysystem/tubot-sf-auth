import { expect, test } from 'bun:test';
import { APEX_SOBJECT_RECORD_BUILDER_VERSION, APEX_SOBJECT_RECORD_SPECS, invokeApexSObjectRecord } from './apex-sobject-record-context';

const root = '/services/data/v67.0';
const route = `${root}/actions/custom/apex/SDO_SCOM_OOA_Utility`;
const ACTION = 'SDO_SCOM_OOA_Utility';

const ACCT = '001000000000001AAA';
const CART = '0a6000000000001AAA';
const APPR = 'a3t000000000001AAA';
const WS = '0ZE000000000001AAA';
const APPROVAL = 'SDO_SCOM_OOA_Commerce_Approval_Requests__c';

function harness(mode: 'success' | 'no-flip' | 'rowless-store' | 'picklist-miss' = 'success') {
  const records = new Map<string, Record<string, any>>();
  const seen: Array<{ path: string; method: string; body?: any }> = [];
  const request = async (path: string, method = 'GET', body?: any): Promise<any> => {
    seen.push({ path, method, body });
    if (path.endsWith('/sobjects/Account/describe')) {
      return { status: 200, ok: true, body: { createable: true, queryable: true, deletable: true,
        fields: [{ name: 'Name', type: 'string', length: 255, createable: true, filterable: true }] } };
    }
    if (path.endsWith('/sobjects/WebCart/describe')) {
      return { status: 200, ok: true, body: { createable: true, queryable: true, deletable: true,
        fields: [
          { name: 'Name', type: 'string', length: 255, createable: true, filterable: true },
          { name: 'WebStoreId', type: 'reference', createable: true, referenceTo: ['WebStore'] },
          { name: 'AccountId', type: 'reference', createable: true, referenceTo: ['Account'] },
        ] } };
    }
    if (path.endsWith(`/sobjects/${APPROVAL}/describe`)) {
      const statusValues = mode === 'picklist-miss'
        ? [{ value: 'Awaiting Response', active: true }]
        : [{ value: 'Awaiting Response', active: true }, { value: 'Approved', active: true }, { value: 'Denied', active: true }];
      return { status: 200, ok: true, body: { createable: true, queryable: true, deletable: true,
        fields: [
          { name: 'Cart__c', type: 'reference', createable: true, referenceTo: ['WebCart'] },
          { name: 'Type__c', type: 'picklist', createable: true,
            picklistValues: [{ value: 'Credit Override', active: true }, { value: 'Product/Quantity', active: true }] },
          { name: 'Status__c', type: 'picklist', createable: true, picklistValues: statusValues },
        ] } };
    }
    if (path.includes('/query?q=')) {
      const decoded = decodeURIComponent(path);
      if (decoded.includes('FROM WebStore')) {
        return { status: 200, ok: true, body: { records: mode === 'rowless-store' ? [] : [{ Id: WS }] } };
      }
      const marker = decoded.match(/Name='([^']+)'/)?.[1];
      const hits = [...records.values()].filter((item) => item.Name === marker).map((item) => ({ Id: item.Id }));
      return { status: 200, ok: true, body: { done: true, records: hits } };
    }
    if (path === route && method === 'POST') {
      const sent = body.inputs[0].approvalRecords;
      if (mode !== 'no-flip') {
        const cart = records.get(sent.Cart__c);
        if (cart) cart.SDO_SCOM_OOA_Credit_Override_Status__c = sent.Status__c;
      }
      return { status: 200, ok: true, body: [{ isSuccess: true, errors: [], outputValues: {} }] };
    }
    if (path === `${root}/sobjects/Account` && method === 'POST') {
      records.set(ACCT, { Id: ACCT, ...body });
      return { status: 201, ok: true, body: { id: ACCT } };
    }
    if (path === `${root}/sobjects/WebCart` && method === 'POST') {
      records.set(CART, { Id: CART, ...body });
      return { status: 201, ok: true, body: { id: CART } };
    }
    if (path === `${root}/sobjects/${APPROVAL}` && method === 'POST') {
      records.set(APPR, { Id: APPR, ...body });
      return { status: 201, ok: true, body: { id: APPR } };
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

test('apex record success chains fixtures, verifies the flip, and cleans all', async () => {
  const state = harness('success');
  const result = await invokeApexSObjectRecord({ root, route, actionName: ACTION,
    request: state.request, build: state.build });
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.businessVerified).toBe(true);
  expect(result.cleanupError).toBeUndefined();
  const invoked = state.seen.find((call) => call.path === route && call.method === 'POST');
  expect(invoked?.body.inputs[0].approvalRecords).toMatchObject({
    Id: APPR, Cart__c: CART, Type__c: 'Credit Override', Status__c: 'Approved',
  });
  expect(state.records.size).toBe(0);
});

test('rowless setup refuses honest before any fixture', async () => {
  const state = harness('rowless-store');
  const result = await invokeApexSObjectRecord({ root, route, actionName: ACTION,
    request: state.request, build: state.build });
  expect(result.body).toMatchObject({ errorCode: 'APEX_SOBJECT_LIVE_ID_REQUIRED' });
  expect(state.records.size).toBe(0);
});

test('picklist contract miss refuses honest', async () => {
  const state = harness('picklist-miss');
  const result = await invokeApexSObjectRecord({ root, route, actionName: ACTION,
    request: state.request, build: state.build });
  expect(result.body).toMatchObject({ errorCode: 'APEX_SOBJECT_PICKLIST_REQUIRED' });
  expect(state.records.size).toBe(0);
});

test('missing business flip withholds verification but still cleans', async () => {
  const state = harness('no-flip');
  const result = await invokeApexSObjectRecord({ root, route, actionName: ACTION,
    request: state.request, build: state.build });
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(false);
  expect(result.contextSchema?.businessVerified).toBe(false);
  expect(result.cleanupError).toBeUndefined();
  expect(state.records.size).toBe(0);
});

test('apex record spec map and builder version cover the member', async () => {
  expect(Object.keys(APEX_SOBJECT_RECORD_SPECS)).toEqual(['SDO_SCOM_OOA_Utility']);
  expect(APEX_SOBJECT_RECORD_BUILDER_VERSION).toBe(150);
  const state = harness('success');
  const result = await invokeApexSObjectRecord({ root, route: `${root}/actions/custom/apex/Unknown`, actionName: 'Unknown',
    request: state.request, build: state.build });
  expect(result.body).toMatchObject({ errorCode: 'APEX_SOBJECT_SPEC_INVALID' });
});
