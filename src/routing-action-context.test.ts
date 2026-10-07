import { test, expect } from 'bun:test';
import { ROUTING_CONTEXT_BUILDER_VERSION, invokeRoutingContext, routingTargets } from './routing-action-context';
test('routing targets come only from active live channel options', () => {
  expect(routingTargets([{ name: 'RelatedEntity', picklistValues: [{ value: 'Account', active: true }, { value: 'Case', active: true }, { value: 'Hidden', active: false }, { value: "Invalid'Name", active: true }] }])).toEqual(['Case', 'Account']);
  expect(routingTargets([])).toEqual([]);
});
test('routing refuses incomplete tenant permissions before creating context', async () => {
  const calls: string[] = [];
  const result = await invokeRoutingContext({ root: '/services/data/v67.0', route: '/services/data/v67.0/actions/standard/routeWork', target: 'Case',
    request: async (path, method = 'GET') => { calls.push(method); return { status: 200, ok: true, body: { fields: [], queryable: true, createable: false, deletable: true } }; },
    build: async () => { throw Error('Must not fabricate context'); },
  });
  expect(result.status).toBe(403);
  expect(result.body.errorCode).toBe('ROUTING_CONTEXT_PERMISSIONS_REQUIRED');
  expect(calls).toEqual(['GET']);
});
test('routing rejects an undiscovered action before requests', async () => {
  const result = await invokeRoutingContext({ root: '/services/data/v67.0', route: '/services/data/v67.0/actions/standard/unknown', target: 'Case',
    request: async () => { throw Error('Must not execute'); }, build: async () => { throw Error('Must not create'); },
  });
  expect(result.status).toBe(422);
});
function harness(reject = false, missingMutation = false) {
  const data = new Map<string, any>(); let counter = 0;
  const deleted: string[] = [], posted: any[] = [];
  const root = '/services/data/v67.0';
  const channel = [{ name: 'RelatedEntity', picklistValues: [{ value: 'Case', active: true }] }];
  const fields = [{ name: 'Subject', type: 'string', createable: true, filterable: true, length: 255 }, { name: 'RoutingModel', picklistValues: [{ value: 'LeastActive', active: true }] }];
  const request = async (path: string, method = 'GET', body?: any) => {
    const result = (body: any, status = 200) => ({ body, status, ok: status < 400 });
    if (path.endsWith('/describe')) return result({ queryable: true, createable: true, deletable: true, fields: path.includes('/ServiceChannel/') ? channel : fields });
    if (path.includes('/actions/')) {
      if (method === 'GET') return result({ inputs: ['recordId', 'routingConfigId', 'serviceChannelId', 'serviceChannelLabel', 'serviceChannelDevName', 'routingType'].map(name => ({ name })) });
      posted.push(body.inputs[0]);
      if (!reject && !missingMutation) data.set('PendingServiceRouting/0JR000000000001AAA', { Id: '0JR000000000001AAA', WorkItemId: body.inputs[0].recordId, ServiceChannelId: [...data.values()].find(v => v.RelatedEntity === 'Case').Id });
      return result([{ isSuccess: !reject, errors: reject ? [{ message: 'Feature is disabled' }] : [] }]);
    }
    if (path.includes('/query?')) {
      const query = decodeURIComponent(path.split('?q=')[1]);
      return result({ records: query.includes('FROM ServiceChannel') ? [] : [...data.entries()].filter(([key]) => key.startsWith('PendingServiceRouting/')).map(([, value]) => value) });
    }
    const relative = path.split('/sobjects/')[1];
    if (method === 'POST') { const identity = `001${String(++counter).padStart(12, '0')}AAA`; data.set(relative + '/' + identity, { ...body, Id: identity }); return result({ id: identity }, 201); }
    if (method === 'DELETE') { deleted.push(relative); data.delete(relative); return result(null, 204); }
    return data.has(relative) ? result(data.get(relative)) : result([], 404);
  };
  return { request, deleted, posted, data, root };
}
for (const action of ['routeWork', 'skillsBasedRouting']) test(action + ' uses actual metadata and cleans verified owned records', async () => {
  const h = harness();
  const result = await invokeRoutingContext({ ...h, route: h.root + '/actions/standard/' + action, target: 'Case', build: async (_, __, values) => ({ values }) });
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.verificationRecordIds).toHaveLength(1);
  expect(h.data.size).toBe(0);
  expect(h.deleted[0]).toStartWith('PendingServiceRouting/');
  if (action === 'routeWork') { expect(h.posted[0].serviceChannelLabel).toStartWith('AS_Routing_'); expect(h.posted[0].serviceChannelDevName).toBe(h.posted[0].serviceChannelLabel); }
});
test('provider business rejection remains a failure and all owned context is cleaned', async () => {
  const h = harness(true);
  const result = await invokeRoutingContext({ ...h, route: h.root + '/actions/standard/routeWork', target: 'Case', build: async (_, __, values) => ({ values }) });
  expect(result.body[0].isSuccess).toBe(false);
  expect(result.contextSchema?.verified).toBe(false);
  expect(h.data.size).toBe(0);
});
test('provider success without actual routing mutation is rejected and cleaned', async () => {
  const h = harness(false, true);
  const result = await invokeRoutingContext({ ...h, route: h.root + '/actions/standard/routeWork', target: 'Case', build: async (_, __, values) => ({ values }) });
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe('ROUTING_MUTATION_UNVERIFIED');
  expect(h.data.size).toBe(0);
});
test('active routing cleanup verifies final parent cascade after direct deletion is rejected', async () => {
  const h = harness();
  const request = async (path: string, method = 'GET', body?: any) => {
    if (method === 'DELETE' && path.includes('/PendingServiceRouting/')) return { status: 400, ok: false, body: [{ errorCode: 'DELETE_FAILED' }] };
    if (method === 'DELETE' && path.includes('/Case/')) for (const key of h.data.keys()) if (key.startsWith('PendingServiceRouting/')) h.data.delete(key);
    return h.request(path, method, body);
  };
  const result = await invokeRoutingContext({ ...h, request, route: h.root + '/actions/standard/routeWork', target: 'Case', build: async (_, __, values) => ({ values }) });
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.cleanupError).toBeUndefined();
  expect(h.data.size).toBe(0);
});
test('routing seeds required Case references from live lookups', async () => {
  const h = harness();
  const hoursId = '01m000000000001AAA';
  let builtValues: any = null;
  const request = async (path: string, method = 'GET', body?: any) => {
    if (path.endsWith('/sobjects/Case/describe')) {
      return { body: { queryable: true, createable: true, deletable: true, fields: [
        { name: 'Subject', type: 'string', createable: true, filterable: true, length: 255 },
        { name: 'BusinessHoursId', type: 'reference', createable: true, nillable: false, defaultedOnCreate: false, referenceTo: ['BusinessHours'] },
      ] }, status: 200, ok: true };
    }
    if (path.includes('/query?') && decodeURIComponent(path).includes('FROM BusinessHours')) {
      return { body: { records: [{ Id: hoursId }] }, status: 200, ok: true };
    }
    return h.request(path, method, body);
  };
  const result = await invokeRoutingContext({ ...h, request, route: h.root + '/actions/standard/routeWork', target: 'Case',
    build: async (_, __, values) => { builtValues = values; return { values }; } });
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(builtValues.BusinessHoursId).toBe(hoursId);
  expect(h.data.size).toBe(0);
});
test('routing builder version forces re-probe past the skip heuristic', () => {
  expect(Number.isInteger(ROUTING_CONTEXT_BUILDER_VERSION)).toBe(true);
  expect(ROUTING_CONTEXT_BUILDER_VERSION).toBeGreaterThan(60);
});
test('remaining routing record after cleanup is an explicit failure', async () => {
  const h = harness();
  const request = async (path: string, method = 'GET', body?: any) => method === 'DELETE' && path.includes('/PendingServiceRouting/')
    ? { status: 400, ok: false, body: [{ errorCode: 'DELETE_FAILED' }] } : h.request(path, method, body);
  const result = await invokeRoutingContext({ ...h, request, route: h.root + '/actions/standard/routeWork', target: 'Case', build: async (_, __, values) => ({ values }) });
  expect(result.cleanupError).toContain('Owned PendingServiceRouting cleanup was not verified');
});
test('skillsBasedRouting sweeps automation-owned pending routing before invoke', async () => {
  const h = harness();
  const automationPsr = '0JR000000000009AAA';
  h.data.set('PendingServiceRouting/' + automationPsr, { Id: automationPsr, WorkItemId: '500000000000000AAA', ServiceChannelId: '0N9000000000000EAA', RoutingType: 'SkillsBased' });
  const ops: string[] = [];
  const request = async (path: string, method = 'GET', body?: any) => {
    if (method === 'DELETE' && path.endsWith('/' + automationPsr)) ops.push('sweep');
    if (method === 'POST' && path.includes('/actions/')) ops.push('invoke');
    return h.request(path, method, body);
  };
  const result = await invokeRoutingContext({ ...h, request, route: h.root + '/actions/standard/skillsBasedRouting', target: 'Case', build: async (_, __, values) => ({ values }) });
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(ops[0]).toBe('sweep');
  expect(ops).toContain('invoke');
  expect(h.deleted).toContain('PendingServiceRouting/' + automationPsr);
  expect(h.data.size).toBe(0);
});
test('routing reports sweep failure when automation-owned routing cannot be removed', async () => {
  const h = harness();
  h.data.set('PendingServiceRouting/0JR000000000009AAA', { Id: '0JR000000000009AAA', WorkItemId: '500000000000000AAA', ServiceChannelId: '0N9000000000000EAA', RoutingType: 'SkillsBased' });
  const request = async (path: string, method = 'GET', body?: any) => method === 'DELETE' && path.includes('/PendingServiceRouting/')
    ? { status: 400, ok: false, body: [{ errorCode: 'DELETE_FAILED' }] } : h.request(path, method, body);
  const result = await invokeRoutingContext({ ...h, request, route: h.root + '/actions/standard/skillsBasedRouting', target: 'Case', build: async (_, __, values) => ({ values }) });
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe('ROUTING_AUTOMATION_SWEEP_FAILED');
  expect(result.cleanupError).toContain('Drifted fixture target: Case.');
});
test('routing sweep denial carries the grant vocabulary for self-heal', async () => {
  const h = harness();
  h.data.set('PendingServiceRouting/0JR000000000009AAA', { Id: '0JR000000000009AAA', WorkItemId: '500000000000000AAA', ServiceChannelId: '0N9000000000000EAA', RoutingType: 'SkillsBased' });
  const request = async (path: string, method = 'GET', body?: any) => method === 'DELETE' && path.includes('/PendingServiceRouting/')
    ? { status: 403, ok: false, body: [{ errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY' }] } : h.request(path, method, body);
  const result = await invokeRoutingContext({ ...h, request, route: h.root + '/actions/standard/skillsBasedRouting', target: 'Case', build: async (_, __, values) => ({ values }) });
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe('ROUTING_SWEEP_PERMISSIONS_REQUIRED');
  expect(result.body.message).toContain('PendingServiceRouting create/read/delete access for the execution user');
});
test('queue-based automation rows drift the target without a sweep delete attempt', async () => {
  const h = harness();
  // Harness mints channel(1)/config(2)/anchor(3): the anchor id below lets
  // children() track the seeded row in owned like the live SOQL filter.
  h.data.set('PendingServiceRouting/0JR000000000009AAA', { Id: '0JR000000000009AAA', WorkItemId: '001000000000003AAA', ServiceChannelId: '0N9000000000000EAA', RoutingType: 'QueueBased' });
  const result = await invokeRoutingContext({ ...h, route: h.root + '/actions/standard/skillsBasedRouting', target: 'Case', build: async (_, __, values) => ({ values }) });
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe('ROUTING_AUTOMATION_SWEEP_FAILED');
  expect(result.body.message).toContain('queue-based rows cannot be deleted');
  expect(result.cleanupError).toContain('Drifted fixture target: Case.');
  expect(h.posted).toHaveLength(0);
  // Exactly one delete (the finally-block absence pass): the pre-invoke
  // sweep must never attempt the platform-refused queue-based delete.
  expect(h.deleted.filter(entry => entry.endsWith('0JR000000000009AAA'))).toHaveLength(1);
});
test('routing prefers skills-capable targets after Case without filtering', () => {
  const fields = [{ name: 'RelatedEntity', picklistValues: [
    { value: 'Account', active: true }, { value: 'Contact', active: true },
    { value: 'Case', active: true }, { value: 'Lead', active: true },
    { value: 'Order', active: true }, { value: 'Route__c', active: true },
  ] }];
  expect(routingTargets(fields)).toEqual(['Case', 'Lead', 'Order', 'Route__c', 'Account', 'Contact']);
  expect(routingTargets([])).toEqual([]);
});
