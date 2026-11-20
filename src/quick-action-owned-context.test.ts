import { expect, test } from 'bun:test';
import { QUICK_ACTION_BUILDER_VERSION, invokeOwnedQuickAction, quickActionFailurePlanners, quickActionRouteTerminal, seedLiveReferenceCache } from './quick-action-owned-context';

test('quick-action builder version stays above the reselect floor', () => {
  expect(Number.isInteger(QUICK_ACTION_BUILDER_VERSION)).toBe(true);
  expect(QUICK_ACTION_BUILDER_VERSION).toBeGreaterThan(125);
});
const root = '/services/data/v67.0', route = root + '/actions/custom/quickAction/Account/NewTask';
const parentId = '001000000000001AAA', childId = '00T000000000001AAA', customerId = '001000000000099AAA';
function fixture(mode: 'success' | 'wrong-parent' | 'lost-parent' | 'lost-child' | 'readback-mismatch' | 'wrong-update') {
  const records = new Map<string, Record<string, any>>([[customerId, { Id: customerId, Name: 'Existing customer' }]]);
  const deleted: string[] = [];
  let actionCalls = 0;
  const request = async (path: string, method = 'GET', body?: any): Promise<any> => {
    if (path.endsWith('/composite/batch')) {
      const results = [];
      for (const item of body.batchRequests) results.push(await request('/services/data/' + item.url, item.method));
      return { status: 200, ok: true, body: { results: results.map(item => ({ statusCode: item.status, result: item.body })) } };
    }
    if (path.includes('/query?q=')) {
      const query = decodeURIComponent(path.split('?q=')[1]);
      const objectName = query.match(/FROM (\w+)/)?.[1];
      const pairs = [...query.matchAll(/(\w+) = '([^']+)'/g)].map(match => [match[1], match[2]]);
      return { status: 200, ok: true, body: { done: true, records: [...records.values()].filter(item => item.objectName === objectName && pairs.every(([name, value]) => item[name] === value)).map(item => ({ Id: item.Id })) } };
    }
    if (path === route && method === 'POST') {
      actionCalls++;
      if (mode === 'wrong-update') { records.get(parentId)!.Description = body.inputs[0].Description; return { status: 200, ok: true, body: [{ isSuccess: true }] }; }
      records.set(childId, { objectName: 'Task', Id: childId, Subject: 'unique-child-marker', WhatId: body.inputs[0].contextId });
      if (mode === 'lost-child') throw Error('Response lost after commit');
      return { status: 200, ok: true, body: [{ isSuccess: true }] };
    }
    if (path === root + '/sobjects/Account' && method === 'POST') {
      records.set(parentId, { objectName: 'Account', Id: parentId, ...body });
      if (mode === 'lost-parent') throw Error('Response lost after commit');
      return { status: 201, ok: true, body: { id: ['wrong-parent', 'wrong-update'].includes(mode) ? customerId : parentId } };
    }
    const id = path.split('/').at(-1)!;
    if (method === 'DELETE') { deleted.push(id); const existed = records.delete(id); return { status: existed ? 204 : 404, ok: existed, body: null }; }
    const value = records.get(id);
    return { status: value ? 200 : 404, ok: !!value, body: value ? { ...value, ...(mode === 'readback-mismatch' && id === parentId ? { Name: 'not-owned' } : {}) } : null };
  };
  const input = { root, route, target: 'Task', markerField: 'Subject', marker: 'unique-child-marker', global: false, fields: [], inputs: [{ name: 'Subject' }, { name: 'WhatId' }], values: { Subject: 'unique-child-marker' }, parent: { objectName: 'Account', field: 'WhatId', markerField: 'Name', marker: 'unique-parent-marker', values: { Name: 'unique-parent-marker' } }, request };
  return { records, deleted, input, calls: () => actionCalls };
}
test('wrong returned parent id never deletes an existing customer; actual owned creation is recovered', async () => {
  const state = fixture('wrong-parent');
  const result = await invokeOwnedQuickAction(state.input);
  expect(result.status).toBe(422);
  expect(state.records.has(customerId)).toBe(true);
  expect(state.deleted).toEqual([parentId]);
  expect(state.calls()).toBe(0);
  expect(result.cleanupError).toContain('deletion was withheld');
});
test('lost parent creation response is recovered and cleaned without invoking the action', async () => {
  const state = fixture('lost-parent');
  const result = await invokeOwnedQuickAction(state.input);
  expect(result.status).toBe(502);
  expect(state.records.has(parentId)).toBe(false);
  expect(state.records.has(customerId)).toBe(true);
  expect(state.calls()).toBe(0);
});
test('lost child response cleans proven child before owned parent and preserves anchors', async () => {
  const state = fixture('lost-child');
  const result = await invokeOwnedQuickAction(state.input);
  expect(result.status).toBe(502);
  expect(state.deleted).toEqual([childId, parentId]);
  expect(state.records.has(customerId)).toBe(true);
  expect(result.cleanupError).toBeUndefined();
});
test('successful child creation is independently verified and both owned records are cleaned', async () => {
  const state = fixture('success');
  const result = await invokeOwnedQuickAction(state.input);
  expect(result.status).toBe(200);
  expect(result.contextSchema.verified).toBe(true);
  expect(state.deleted).toEqual([childId, parentId]);
});
test('ownership readback mismatch withholds deletion', async () => {
  const state = fixture('readback-mismatch');
  const result = await invokeOwnedQuickAction(state.input);
  expect(result.status).toBe(422);
  expect(state.deleted).toEqual([]);
  expect(result.cleanupError).toContain('deletion was withheld');
});
test('wrong returned update-context id never updates or deletes an existing customer', async () => {
  const state = fixture('wrong-update');
  const result = await invokeOwnedQuickAction({ ...state.input, parent: undefined, target: 'Account', markerField: 'Name', marker: 'unique-parent-marker', values: { Name: 'unique-parent-marker' }, fields: [{ name: 'Description', type: 'string', updateable: true }], inputs: [{ name: 'Name' }, { name: 'Description' }] });
  expect(result.status).toBe(422);
  expect(state.calls()).toBe(0);
  expect(state.deleted).toEqual([parentId]);
  expect(state.records.get(customerId)?.Name).toBe('Existing customer');
});
test('lost global-create action response recovers the actual marker write and cleans it', async () => {
  const state = fixture('lost-child');
  const result = await invokeOwnedQuickAction({ ...state.input, parent: undefined, global: true });
  expect(result.status).toBe(502);
  expect(state.deleted).toEqual([childId]);
  expect(state.records.has(customerId)).toBe(true);
  expect(result.cleanupError).toBeUndefined();
});
test('lost owned-update creation response cleans its marker write without invoking an update', async () => {
  const state = fixture('lost-parent');
  const result = await invokeOwnedQuickAction({ ...state.input, parent: undefined, target: 'Account', markerField: 'Name', marker: 'unique-parent-marker', values: { Name: 'unique-parent-marker' } });
  expect(result.status).toBe(502);
  expect(state.deleted).toEqual([parentId]);
  expect(state.calls()).toBe(0);
  expect(state.records.has(customerId)).toBe(true);
});
test('required child binding is built only after the actual owned parent passes readback', async () => {
  const state = fixture('success');
  let built = false;
  const result = await invokeOwnedQuickAction({ ...state.input, values: undefined, buildTarget: async overrides => {
    expect(state.records.get(parentId)?.Name).toBe('unique-parent-marker');
    expect(overrides.WhatId).toBe(parentId);
    expect(state.calls()).toBe(0);
    built = true;
    return { values: overrides };
  } });
  expect(built).toBe(true);
  expect(result.status).toBe(200);
  expect(result.contextSchema.verified).toBe(true);
});
test('required boolean/date inputs resolve from the live target schema and invoke', async () => {
  const state = fixture('success');
  const result = await invokeOwnedQuickAction({ ...state.input,
    inputs: [...state.input.inputs, { name: 'IsReminderSet', required: true }, { name: 'ActivityDate', required: true }],
    fields: [{ name: 'IsReminderSet', type: 'boolean' }, { name: 'ActivityDate', type: 'date' }] });
  expect(result.status).toBe(200);
  expect(state.calls()).toBe(1);
  expect(state.records.has(customerId)).toBe(true);
});
test('required OwnerId resolves to the live integration user and invokes', async () => {
  const state = fixture('success');
  const ownerId = '005000000000001AAA';
  const result = await invokeOwnedQuickAction({ ...state.input, integrationUserId: ownerId,
    inputs: [...state.input.inputs, { name: 'OwnerId', required: true }],
    fields: [{ name: 'OwnerId', type: 'reference', referenceTo: ['User'] }] });
  expect(result.status).toBe(200);
  expect(state.calls()).toBe(1);
});
test('required OwnerId without a verified identity still rejects before invocation', async () => {
  const state = fixture('success');
  const result = await invokeOwnedQuickAction({ ...state.input,
    inputs: [...state.input.inputs, { name: 'OwnerId', required: true }],
    fields: [{ name: 'OwnerId', type: 'reference', referenceTo: ['User'] }] });
  expect(result.status).toBe(422);
  expect(state.calls()).toBe(0);
});
test('unresolved additional required references reject before invocation and clean the parent', async () => {
  const state = fixture('success');
  const result = await invokeOwnedQuickAction({ ...state.input, inputs: [...state.input.inputs, { name: 'OtherParentId', required: true }], fields: [{ name: 'OtherParentId', type: 'reference', referenceTo: ['Account'] }] });
  expect(result.status).toBe(422);
  expect(state.calls()).toBe(0);
  expect(state.deleted).toEqual([parentId]);
  expect(state.records.has(customerId)).toBe(true);
});
test('context-fixture creation addresses the action at the owned fixture and cleans child-first', async () => {
  const state = fixture('success');
  const feedId = '0D5000000000001AAA';
  const seen: string[] = [];
  const request = async (path: string, method = 'GET', body?: any): Promise<any> => {
    if (path === root + '/sobjects/FeedItem' && method === 'POST') {
      state.records.set(feedId, { objectName: 'FeedItem', Id: feedId, ...body });
      return { status: 201, ok: true, body: { id: feedId } };
    }
    if (path === route && method === 'POST') seen.push(body.inputs[0].contextId);
    return (state.input.request as any)(path, method, body);
  };
  const result = await invokeOwnedQuickAction({ ...state.input, request,
    inputs: [{ name: 'contextId', required: true }, { name: 'Subject' }],
    contextFixture: { objectName: 'FeedItem', values: { Body: 'fixture post' }, parentField: 'ParentId' } });
  expect(result.status).toBe(200);
  expect(result.contextSchema.verified).toBe(true);
  expect(seen).toEqual([feedId]);
  expect(result.contextSchema.contextFixtureRecordId).toBe(feedId);
  expect(state.deleted).toEqual([childId, feedId, parentId]);
  expect(state.records.has(customerId)).toBe(true);
});
test('context fixture without parent link or marker rejects before invocation', async () => {
  const state = fixture('success');
  const result = await invokeOwnedQuickAction({ ...state.input, parent: undefined,
    contextFixture: { objectName: 'FeedItem', values: { Body: 'fixture post' }, parentField: 'ParentId' } });
  expect(result.status).toBe(422);
  expect(state.calls()).toBe(0);
});
test('live reference seeding queries only required references and caches valid ids', async () => {
  const queries: string[] = [];
  const request = async (path: string): Promise<any> => {
    queries.push(path);
    const objectName = decodeURIComponent(path).match(/FROM (\w+)/)?.[1];
    return { status: 200, ok: true, body: { records: objectName === 'MessagingChannel' ? [{ Id: '0Mj000000000001AAA' }] : [] } };
  };
  const cache = await seedLiveReferenceCache(request, root, [
    { name: 'MessagingChannelId', type: 'reference', createable: true, nillable: false, referenceTo: ['MessagingChannel'] },
    { name: 'MessagingEndUserId', type: 'reference', createable: true, nillable: false, referenceTo: ['MessagingEndUser'] },
    { name: 'OwnerId', type: 'reference', createable: true, nillable: true, referenceTo: ['User'] },
    { name: 'Status', type: 'picklist', createable: true, nillable: false },
  ]);
  expect(cache.get('MessagingChannel')).toBe('0Mj000000000001AAA');
  expect(cache.has('MessagingEndUser')).toBe(false);
  expect(queries.length).toBe(2);
  expect(queries.every(q => q.includes('/query?q='))).toBe(true);
});
test('native fixture creation failure is preserved honestly instead of unverified', async () => {
  const state = fixture('success');
  const request = async (path: string, method = 'GET', body?: any): Promise<any> => {
    if (path === root + '/sobjects/Account' && method === 'POST')
      return { status: 400, ok: false, body: [{ errorCode: 'INVALID_INPUT', message: 'native rejection' }] };
    return (state.input.request as any)(path, method, body);
  };
  const result = await invokeOwnedQuickAction({ ...state.input, request });
  expect(result.status).toBe(400);
  expect(result.body).toEqual([{ errorCode: 'INVALID_INPUT', message: 'native rejection' }]);
  expect(state.calls()).toBe(0);
});
test('trigger-required nullable reference named in the error retries once with a live foreign key', async () => {
  const widgetId = 'a01000000000001AAA', convId = '0dw000000000001AAA';
  const marker = 'unique-widget-marker';
  let posts = 0, actionFlag: unknown;
  const rows = new Map<string, Record<string, any>>();
  const request = async (path: string, method = 'GET', body?: any): Promise<any> => {
    if (path.endsWith('/composite/batch')) {
      const results = [];
      for (const item of body.batchRequests) results.push(await request('/services/data/' + item.url, item.method));
      return { status: 200, ok: true, body: { results: results.map(item => ({ statusCode: item.status, result: item.body })) } };
    }
    if (path === root + '/sobjects/Widget__c/describe') return { status: 200, ok: true, body: { fields: [
      { name: 'Name', label: 'Widget Name', type: 'string', createable: true, nillable: false, length: 80 },
      { name: 'ConversationId', label: 'Conversation ID', type: 'reference', createable: true, nillable: true, referenceTo: ['Conversation'] },
      { name: 'Flag__c', type: 'boolean', createable: true, nillable: true, updateable: true }] } };
    if (path.includes('/query?q=')) {
      const q = decodeURIComponent(path);
      if (q.includes('FROM Conversation')) return { status: 200, ok: true, body: { records: [{ Id: convId }] } };
      return { status: 200, ok: true, body: { done: true, records: [...rows.values()].filter(r => q.includes(`Name = '${marker}'`) && r.Name === marker).map(r => ({ Id: r.Id })) } };
    }
    if (path === root + '/sobjects/Widget__c' && method === 'POST') {
      posts++;
      if (posts === 1) return { status: 400, ok: false, body: [{ errorCode: 'INVALID_INPUT', message: 'Conversation Identifier field required to be set.' }] };
      expect(body.ConversationId).toBe(convId);
      rows.set(widgetId, { Id: widgetId, Name: marker });
      return { status: 201, ok: true, body: { id: widgetId } };
    }
    if (path === route && method === 'POST') {
      actionFlag = body.inputs[0].Flag__c;
      return { status: 200, ok: true, body: [{ isSuccess: true }] };
    }
    if (path === root + `/sobjects/Widget__c/${widgetId}`) {
      if (method === 'DELETE') { rows.delete(widgetId); return { status: 204, ok: true, body: null }; }
      const row = rows.get(widgetId);
      return row ? { status: 200, ok: true, body: { ...row, Flag__c: actionFlag ?? row.Flag__c } } : { status: 404, ok: false, body: null };
    }
    throw Error('Unexpected request ' + method + ' ' + path);
  };
  const result = await invokeOwnedQuickAction({ root, route, target: 'Widget__c', markerField: 'Name', marker,
    global: false, fields: [{ name: 'Flag__c', type: 'boolean', updateable: true }],
    inputs: [{ name: 'contextId', required: true }, { name: 'Flag__c' }],
    buildTarget: async overrides => ({ values: overrides }), request });
  expect(posts).toBe(2);
  expect(result.status).toBe(200);
  expect(result.contextSchema.verified).toBe(true);
  expect(result.cleanupError).toBeUndefined();
  expect(rows.size).toBe(0);
});
test('live reference seeding runs no query without required references', async () => {
  let queries = 0;
  const cache = await seedLiveReferenceCache(async () => { queries++; return { status: 200, ok: true, body: {} }; }, root, [
    { name: 'Name', type: 'string', createable: true, nillable: false },
  ]);
  expect(cache.size).toBe(0);
  expect(queries).toBe(0);
});
test('describe-404 routes learn as unknown and invoke-404 as dead, nothing else', () => {
  const unknown = quickActionRouteTerminal({ status: 404 }, 'describe');
  expect(unknown?.body).toMatchObject({ errorCode: 'QUICK_ACTION_ROUTE_UNKNOWN', dropRoute: true, retryable: false });
  const dead = quickActionRouteTerminal({ status: 404 }, 'invoke');
  expect(dead?.body).toMatchObject({ errorCode: 'QUICK_ACTION_ROUTE_DEAD', deadRoute: true, retryable: false });
  expect(quickActionRouteTerminal({ status: 400 }, 'invoke')).toBeNull();
  expect(quickActionRouteTerminal({ status: 500 }, 'describe')).toBeNull();
  expect(quickActionRouteTerminal({ status: 200 }, 'invoke')).toBeNull();
});
test('failure planners map grants and the field branch only', () => {
  const grant = quickActionFailurePlanners({ status: 400, body: [
    { message: "Looks like you don't have access to this feature.", errorCode: 'FEATURE_ACCESS_REQUIRED' },
  ] });
  expect(grant.denialGrant?.family).toBe('feature-access');
  expect(grant.managedFlowFault).toBeUndefined();
  const field = quickActionFailurePlanners({ status: 400, body: [
    { message: 'Unable to create/update fields: WorkOrderId. Please check the security settings of this field and verify that it is read/write for your profile or permission set.', errorCode: 'INVALID_FIELD_FOR_INSERT_UPDATE' },
  ] });
  expect(field.denialGrant).toBeUndefined();
  expect(field.managedFlowFault?.code).toBe('FIELD_ACCESS_REQUIRED');
  expect(field.managedFlowFault?.fieldName).toBe('WorkOrderId');
  const flowShape = quickActionFailurePlanners({ status: 200, body: [{ isSuccess: true, outputValues: { errorMessage: 'ItemSysId is null' } }] });
  expect(flowShape).toEqual({});
  const success = quickActionFailurePlanners({ status: 200, body: [{ isSuccess: true }] });
  expect(success).toEqual({});
});
test('invoke-404 after owned setup returns dead-route learning and still cleans up', async () => {
  const state = fixture('success');
  const inner = state.input.request;
  const request = async (path: string, method = 'GET', body?: any): Promise<any> => {
    if (path === route && method === 'POST') {
      return { status: 404, ok: false, body: [{ message: 'The requested resource does not exist', errorCode: 'NOT_FOUND' }] };
    }
    return inner(path, method, body);
  };
  const result = await invokeOwnedQuickAction({ ...state.input, request });
  expect(result.status).toBe(404);
  expect(result.body).toMatchObject({ errorCode: 'QUICK_ACTION_ROUTE_DEAD', deadRoute: true, retryable: false });
  expect(state.deleted).toEqual([parentId]);
  expect(result.contextSchema.verified).toBe(false);
});
test('field-denial invoke failures attach the taxonomy fault', async () => {
  const state = fixture('success');
  const inner = state.input.request;
  const request = async (path: string, method = 'GET', body?: any): Promise<any> => {
    if (path === route && method === 'POST') {
      return { status: 400, ok: false, body: [{ message: 'Unable to create/update fields: WorkOrderId. Please check the security settings of this field and verify that it is read/write for your profile or permission set.', errorCode: 'INVALID_FIELD_FOR_INSERT_UPDATE' }] };
    }
    return inner(path, method, body);
  };
  const result = await invokeOwnedQuickAction({ ...state.input, request });
  expect(result.status).toBe(400);
  expect(result.managedFlowFault).toMatchObject({ code: 'FIELD_ACCESS_REQUIRED', fieldName: 'WorkOrderId' });
  expect(result.contextSchema.managedFlowFault).toMatchObject({ code: 'FIELD_ACCESS_REQUIRED' });
  expect(result.denialGrant).toBeUndefined();
  expect(state.deleted).toEqual([parentId]);
});
