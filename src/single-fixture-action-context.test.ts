import { expect, test } from 'bun:test';
import { invokeSingleFixtureAction, SINGLE_FIXTURE_ACTION_SPECS, SINGLE_FIXTURE_BUILDER_VERSION } from './single-fixture-action-context';

const root = '/services/data/v67.0';
const route = `${root}/actions/standard/runCampaign`;

function harness(mode: 'success' | 'rejected' | 'stuck' = 'success') {
  const records = new Map<string, Record<string, any>>();
  const deleted: string[] = [];
  const seen: Array<{ path: string; method: string; body?: any }> = [];
  const request = async (path: string, method = 'GET', body?: any): Promise<any> => {
    seen.push({ path, method, body });
    if (path.endsWith('/describe')) {
      return { status: 200, ok: true, body: { createable: true, queryable: true, deletable: true,
        fields: [{ name: 'Name', type: 'string', length: 80, createable: true, filterable: true }] } };
    }
    if (path.includes('/query?q=')) {
      const marker = decodeURIComponent(path).match(/Name='([^']+)'/)?.[1];
      const hits = [...records.values()].filter((item) => item.Name === marker).map((item) => ({ Id: item.Id }));
      return { status: 200, ok: true, body: { done: true, records: hits } };
    }
    if (path === route && method === 'POST') {
      if (mode === 'rejected') return { status: 400, ok: false, body: [{ isSuccess: false, errors: [{ message: 'nope' }] }] };
      return { status: 200, ok: true, body: [{ isSuccess: true }] };
    }
    if (path === `${root}/sobjects/Campaign` && method === 'POST') {
      const id = '701000000000001AAA';
      records.set(id, { Id: id, ...body });
      return { status: 201, ok: true, body: { id } };
    }
    const id = path.split('/').at(-1)!;
    if (method === 'DELETE') {
      deleted.push(id);
      if (mode === 'stuck') return { status: 204, ok: true, body: null };
      const existed = records.delete(id);
      return { status: existed ? 204 : 404, ok: existed, body: null };
    }
    const value = records.get(id);
    if (mode === 'stuck' && method === 'GET' && path.includes('/sobjects/Campaign/')) {
      return { status: 200, ok: true, body: { Id: id, Name: 'AS probe stuck' } };
    }
    return { status: value ? 200 : 404, ok: !!value, body: value ?? null };
  };
  const build = async (_name: string, marker: string, values: Record<string, unknown>) => ({ values });
  return { records, deleted, seen, request, build };
}

test('single-fixture success invokes with the owned id and cleans it', async () => {
  const state = harness('success');
  const result = await invokeSingleFixtureAction({ root, route, target: 'Campaign', idInput: 'campaignId',
    markerField: 'Name', request: state.request, build: state.build });
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.cleanupError).toBeUndefined();
  const invoked = state.seen.find((call) => call.path === route && call.method === 'POST');
  expect(invoked?.body).toEqual({ inputs: [{ campaignId: '701000000000001AAA' }] });
  expect(state.records.size).toBe(0);
  expect(state.deleted).toEqual(['701000000000001AAA']);
});

test('native rejection passes through and still cleans the fixture', async () => {
  const state = harness('rejected');
  const result = await invokeSingleFixtureAction({ root, route, target: 'Campaign', idInput: 'campaignId',
    markerField: 'Name', request: state.request, build: state.build });
  expect(result.status).toBe(400);
  expect(result.contextSchema?.verified).toBe(false);
  expect(result.cleanupError).toBeUndefined();
  expect(state.records.size).toBe(0);
});

test('stuck fixture surfaces a cleanup error and drops verification', async () => {
  const state = harness('stuck');
  const result = await invokeSingleFixtureAction({ root, route, target: 'Campaign', idInput: 'campaignId',
    markerField: 'Name', request: state.request, build: state.build });
  expect(result.cleanupError).toContain('could not be verified');
  expect(result.contextSchema?.verified).toBe(false);
});

test('explicit OwnerId passes to the builder only for reference OwnerId fields', async () => {
  const state = harness('success');
  let builtValues: Record<string, unknown> = {};
  const build = async (_name: string, marker: string, values: Record<string, unknown>) => {
    builtValues = values;
    return { values };
  };
  const ownerId = '005000000000001AAA';
  await invokeSingleFixtureAction({ root, route, target: 'Campaign', idInput: 'campaignId',
    markerField: 'Name', ownerId, request: state.request, build });
  expect(builtValues.OwnerId).toBeUndefined();
  const withOwner = harness('success');
  const requestWithOwner = async (path: string, method = 'GET', body?: any): Promise<any> => {
    if (path.endsWith('/describe')) {
      return { status: 200, ok: true, body: { createable: true, queryable: true, deletable: true,
        fields: [{ name: 'MasterLabel', type: 'string', length: 80, createable: true, filterable: true },
          { name: 'OwnerId', type: 'reference' }] } };
    }
    return withOwner.request(path, method, body);
  };
  await invokeSingleFixtureAction({ root, route, target: 'AnalyticsVisualization', idInput: 'visualizationId',
    markerField: 'MasterLabel', ownerId, request: requestWithOwner, build });
  expect(builtValues.OwnerId).toBe(ownerId);
});
test('invalid spec identifiers refuse before any Salesforce call', async () => {
  const state = harness('success');
  const result = await invokeSingleFixtureAction({ root, route, target: 'Campaign;DROP', idInput: 'campaignId',
    markerField: 'Name', request: state.request, build: state.build });
  expect(result.status).toBe(422);
  expect(state.seen).toEqual([]);
});

test('required fixture reference binds from a live lookup', async () => {
  const liveParentId = 'a01000000000001AAA';
  const state = harness('success');
  let builtValues: Record<string, unknown> = {};
  const build = async (_name: string, marker: string, values: Record<string, unknown>) => {
    builtValues = values;
    return state.build(_name, marker, values);
  };
  const request = async (path: string, method = 'GET', body?: any): Promise<any> => {
    if (path.endsWith('/sobjects/Campaign/describe')) {
      return { status: 200, ok: true, body: { createable: true, queryable: true, deletable: true,
        fields: [{ name: 'Name', type: 'string', length: 80, createable: true, filterable: true },
          { name: 'Parent__c', type: 'reference', nillable: false, defaultedOnCreate: false,
            createable: true, referenceTo: ['Tenant_Parent__c'] }] } };
    }
    if (path.includes('/query?q=') && decodeURIComponent(path).includes('FROM Tenant_Parent__c')) {
      return { status: 200, ok: true, body: { done: true, records: [{ Id: liveParentId }] } };
    }
    return state.request(path, method, body);
  };
  const result = await invokeSingleFixtureAction({ root, route, target: 'Campaign', idInput: 'campaignId',
    markerField: 'Name', request, build });
  expect(result.status).toBe(200);
  expect(builtValues.Parent__c).toBe(liveParentId);
  expect(state.records.get('701000000000001AAA')).toBeUndefined();
  expect(result.cleanupError).toBeUndefined();
});

test('verified OwnerId pin wins over a borrowed user id', async () => {
  const borrowedUserId = '005000000000009AAA';
  const pinnedUserId = '005000000000001AAA';
  const state = harness('success');
  let builtValues: Record<string, unknown> = {};
  const build = async (_name: string, marker: string, values: Record<string, unknown>) => {
    builtValues = values;
    return state.build(_name, marker, values);
  };
  const request = async (path: string, method = 'GET', body?: any): Promise<any> => {
    if (path.endsWith('/sobjects/Campaign/describe')) {
      return { status: 200, ok: true, body: { createable: true, queryable: true, deletable: true,
        fields: [{ name: 'Name', type: 'string', length: 80, createable: true, filterable: true },
          { name: 'OwnerId', type: 'reference', nillable: false, defaultedOnCreate: false,
            createable: true, referenceTo: ['User'] }] } };
    }
    if (path.includes('/query?q=') && decodeURIComponent(path).includes('FROM User ')) {
      return { status: 200, ok: true, body: { done: true, records: [{ Id: borrowedUserId }] } };
    }
    return state.request(path, method, body);
  };
  const result = await invokeSingleFixtureAction({ root, route, target: 'Campaign', idInput: 'campaignId',
    markerField: 'Name', ownerId: pinnedUserId, request, build });
  expect(result.status).toBe(200);
  expect(builtValues.OwnerId).toBe(pinnedUserId);
});

test('unresolvable reference fails honest without creating a fixture', async () => {
  const state = harness('success');
  const build = async (name: string, _marker: string, values: Record<string, unknown>) => {
    if (!('Parent__c' in values)) {
      return { failure: { status: 422, ok: false, body: { errorCode: 'OWNED_CONTEXT_REQUIRED_REFERENCE_UNRESOLVED',
        message: `The temporary ${name}.Parent__c needs one explicit scoped reference.` } } };
    }
    return state.build(name, _marker, values);
  };
  const request = async (path: string, method = 'GET', body?: any): Promise<any> => {
    if (path.endsWith('/sobjects/Campaign/describe')) {
      return { status: 200, ok: true, body: { createable: true, queryable: true, deletable: true,
        fields: [{ name: 'Name', type: 'string', length: 80, createable: true, filterable: true },
          { name: 'Parent__c', type: 'reference', nillable: false, defaultedOnCreate: false,
            createable: true, referenceTo: ['Tenant_Parent__c'] }] } };
    }
    if (path.includes('/query?q=') && decodeURIComponent(path).includes('FROM Tenant_Parent__c')) {
      return { status: 200, ok: true, body: { done: true, records: [] } };
    }
    if (path.endsWith('/sobjects/Tenant_Parent__c/describe')) {
      return { status: 200, ok: true, body: { createable: false, queryable: true, deletable: false, fields: [] } };
    }
    return state.request(path, method, body);
  };
  const result = await invokeSingleFixtureAction({ root, route, target: 'Campaign', idInput: 'campaignId',
    markerField: 'Name', request, build });
  expect(result.status).toBe(422);
  expect(result.body).toMatchObject({ errorCode: 'OWNED_CONTEXT_REQUIRED_REFERENCE_UNRESOLVED' });
  expect(state.seen.some((call) => call.path === `${root}/sobjects/Campaign` && call.method === 'POST')).toBe(false);
});

test('single-fixture builder version sits above the stranded stamp', () => {
  expect(SINGLE_FIXTURE_BUILDER_VERSION).toBeGreaterThan(87);
});

test('spec map covers the single-identity standard family', () => {
  expect(Object.keys(SINGLE_FIXTURE_ACTION_SPECS).sort()).toEqual(
    ['contentWorkspaceEnableFolders', 'generateWorkPlans', 'runCampaign', 'updateVisualization']);
  for (const spec of Object.values(SINGLE_FIXTURE_ACTION_SPECS)) {
    expect(spec.object).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,127}$/);
    expect(spec.idInput).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,127}$/);
    expect(spec.markerField).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,127}$/);
  }
});
