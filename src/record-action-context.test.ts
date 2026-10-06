import { expect, test } from 'bun:test';
import { invokeOwnedRecordAction } from './record-action-context';

const root = '/services/data/v67.0', target = 'Live_Record__c', marker = 'AS probe 36b48227-5f7e-4b5e-93d7-3fa3f8225c5a';
const ownedId = 'a01000000000001AAA', customerId = 'a01000000000002AAA';
function harness(options: { wrongId?: boolean; lostFixtureResponse?: boolean; lostActionResponse?: boolean; changedOwnership?: boolean } = {}) {
  const records = new Map<string, Record<string, unknown>>([[customerId, { Id: customerId, Name: 'Existing customer record' }]]);
  const deletes: string[] = [], updates: string[] = [];
  let actionCalls = 0, cleanupStarted = false;
  const request = async (path: string, method = 'GET', body?: any): Promise<any> => {
    const result = (status: number, value: unknown) => ({ status, ok: status >= 200 && status < 300, body: value });
    if (path.endsWith('/composite/batch')) {
      cleanupStarted = true;
      if (options.changedOwnership && records.has(ownedId)) records.set(ownedId, { Id: ownedId, Name: 'Reassigned customer data' });
      const results = [];
      for (const item of body.batchRequests) {
        const read = await request('/services/data/' + item.url, item.method);
        results.push({ statusCode: read.status, result: read.body });
      }
      return result(200, { results });
    }
    if (path.startsWith(root + '/query?')) return result(200, { records: [...records.values()]
      .filter(record => record.Name === marker || record.Name === marker + ' changed').map(record => ({ Id: record.Id })) });
    if (path === root + '/sobjects/' + target && method === 'POST') {
      records.set(ownedId, { Id: ownedId, ...body });
      if (options.lostFixtureResponse) throw Error('Connection lost after committed write');
      return result(201, { id: options.wrongId ? customerId : ownedId });
    }
    if (path.includes('/actions/standard/')) {
      actionCalls++;
      const args = body.inputs[0];
      if (args.recordId) { updates.push(args.recordId); records.set(args.recordId, { ...records.get(args.recordId), ...args.recordData }); }
      else records.set(ownedId, { Id: ownedId, ...args.recordData });
      if (options.lostActionResponse) throw Error('Connection lost after action mutation');
      return result(200, [{ isSuccess: true, errors: [], outputValues: { recordId: ownedId } }]);
    }
    const id = path.split('/').at(-1)!;
    if (method === 'DELETE') { deletes.push(id); records.delete(id); return result(204, null); }
    return records.has(id) ? result(200, records.get(id)) : result(404, []);
  };
  return { request, records, deletes, updates, calls: () => actionCalls, cleanupStarted: () => cleanupStarted };
}
const invoke = (state: ReturnType<typeof harness>, update: boolean) => invokeOwnedRecordAction({ root, target,
  route: root + '/actions/standard/' + (update ? 'updateRecord' : 'createRecord'), update,
  markerField: 'Name', marker, markerLength: 80, values: { Name: marker }, request: state.request });

test('wrong returned customer ID authorizes neither record update nor cleanup deletion', async () => {
  const state = harness({ wrongId: true });
  const result = await invoke(state, true);
  expect(result.contextSchema.verified).toBe(false);
  expect(state.calls()).toBe(0);
  expect(state.updates).toEqual([]);
  expect(state.deletes).toEqual([ownedId]);
  expect(state.records.get(customerId)?.Name).toBe('Existing customer record');
  expect(result.cleanupError).toContain('deletion was withheld');
});
test('lost fixture response recovers and cleans the committed owned write without replaying update', async () => {
  const state = harness({ lostFixtureResponse: true });
  const result = await invoke(state, true);
  expect(result.status).toBe(502);
  expect(result.contextSchema.verified).toBe(false);
  expect(state.calls()).toBe(0);
  expect(state.deletes).toEqual([ownedId]);
  expect(result.cleanupError).toBeUndefined();
});
for (const update of [false, true]) test(`lost ${update ? 'update' : 'create'} action response recovers marker writes without reporting success`, async () => {
  const state = harness({ lostActionResponse: true });
  const result = await invoke(state, update);
  expect(result.status).toBe(502);
  expect(result.contextSchema.verified).toBe(false);
  expect(state.calls()).toBe(1);
  expect(state.deletes).toEqual([ownedId]);
  expect(state.records.has(customerId)).toBe(true);
  expect(result.cleanupError).toBeUndefined();
});
test('upstream REST denials attach planner-only grant families', async () => {
  const denied = async (path: string, method = 'GET', _body?: any): Promise<any> => {
    const result = (status: number, value: unknown) => ({ status, ok: status >= 200 && status < 300, body: value });
    if (path.startsWith(root + '/query?')) return result(200, { records: [] });
    if (path.includes('/actions/standard/')) return result(403, [
      { message: 'insufficient access rights on object id: a01000000000002AAA', errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY' }]);
    return result(404, []);
  };
  const result = await invokeOwnedRecordAction({ root, target,
    route: root + '/actions/standard/createRecord', update: false,
    markerField: 'Name', marker, markerLength: 80, values: { Name: marker }, request: denied });
  expect(result.status).toBe(403);
  expect(result.denialGrant).toMatchObject({ family: 'record-access', retryable: true });
  expect(result.denialGrant.requirement).toContain('row visibility');
  expect(result.contextSchema.denialGrant).toMatchObject({ family: 'record-access' });
});
test('non-denial failures and successes attach no grant', async () => {
  const rejected = async (path: string, method = 'GET', _body?: any): Promise<any> => {
    const result = (status: number, value: unknown) => ({ status, ok: status >= 200 && status < 300, body: value });
    if (path.startsWith(root + '/query?')) return result(200, { records: [] });
    if (path.includes('/actions/standard/')) return result(400, [
      { message: 'Required fields are missing', errorCode: 'REQUIRED_FIELD_MISSING' }]);
    return result(404, []);
  };
  const failure = await invokeOwnedRecordAction({ root, target,
    route: root + '/actions/standard/createRecord', update: false,
    markerField: 'Name', marker, markerLength: 80, values: { Name: marker }, request: rejected });
  expect(failure.status).toBe(400);
  expect(failure.denialGrant).toBeUndefined();
  expect(failure.contextSchema.denialGrant).toBeUndefined();
  const state = harness({});
  const success = await invoke(state, false);
  expect(success.contextSchema.verified).toBe(true);
  expect(success.denialGrant).toBeUndefined();
  expect(success.contextSchema.denialGrant).toBeUndefined();
});
test('fresh ownership is required again at cleanup after successful mutation verification', async () => {
  const state = harness({ changedOwnership: true });
  const result = await invoke(state, false);
  expect(result.contextSchema.verified).toBe(true);
  expect(state.cleanupStarted()).toBe(true);
  expect(state.deletes).toEqual([]);
  expect(result.cleanupError).toContain('deletion was withheld');
});
