import { test, expect } from 'bun:test';
import { parseArgs, parseGrant, planSetup, renderPlan } from './setup-context-permissions';

const base = (grants: string[]) => parseArgs([
  '--permset', 'AS_Fixture', '--user', '005000000000001AAA', '--target-org', 'sweep',
  ...grants.flatMap((spec) => ['--grant', spec]),
]);

test('grant specs parse and validate strictly', () => {
  expect(parseGrant('object-crud:Case')).toEqual({
    family: 'object-crud', object: 'Case', ops: { create: true, read: true, edit: true, delete: true },
  });
  expect(parseGrant('object-crud:Case:read,delete')).toEqual({
    family: 'object-crud', object: 'Case', ops: { create: false, read: true, edit: false, delete: true },
  });
  expect(parseGrant('object-crud:Case:update')).toMatchObject({ ops: { edit: true } });
  expect(parseGrant('field-access:WorkOrderLineItem.WorkOrderId')).toEqual({
    family: 'field-access', object: 'WorkOrderLineItem', field: 'WorkOrderId',
  });
  expect(parseGrant('record-access:Case')).toEqual({ family: 'record-access', object: 'Case' });
  expect(parseGrant('feature-access')).toEqual({ family: 'feature-access' });
  expect(() => parseGrant('object-crud:../../etc')).toThrow();
  expect(() => parseGrant('object-crud')).toThrow();
  expect(() => parseGrant('field-access:Case')).toThrow();
  expect(() => parseGrant('feature-access:Case')).toThrow();
  expect(() => parseGrant('nope:Case')).toThrow();
  expect(() => parseGrant('object-crud:Case:fly')).toThrow();
});

test('args require validated permset, user, org, and grants', () => {
  const options = base(['object-crud:Case']);
  expect(options).toMatchObject({ permset: 'AS_Fixture', apply: false });
  expect(base(['object-crud:Case:read,delete']).grants).toHaveLength(1);
  expect(() => parseArgs(['--user', '005000000000001AAA', '--target-org', 's', '--grant', 'feature-access'])).toThrow();
  expect(() => parseArgs(['--permset', 'P', '--user', 'nope', '--target-org', 's', '--grant', 'feature-access'])).toThrow();
  expect(() => parseArgs(['--permset', 'P', '--user', '005000000000001AAA', '--grant', 'feature-access'])).toThrow();
  expect(() => parseArgs(['--permset', 'P', '--user', '005000000000001AAA', '--target-org', 's'])).toThrow();
  expect(() => parseArgs(['--permset', 'P', '--user', '005000000000001AAA', '--target-org', 's', '--grant', 'feature-access', '--api-version', 'x'])).toThrow();
});

test('plans merge object grants and keep manual families manual', () => {
  const plan = planSetup(base(['object-crud:Case:read', 'object-crud:Case:delete', 'field-access:WorkOrderLineItem.WorkOrderId', 'record-access:Case', 'feature-access']));
  expect(plan[0]).toEqual({ op: 'ensure-permset', permset: 'AS_Fixture' });
  expect(plan).toContainEqual({ op: 'object-permissions', object: 'Case', ops: { create: false, read: true, edit: false, delete: true } });
  expect(plan).toContainEqual({ op: 'field-permissions', object: 'WorkOrderLineItem', field: 'WorkOrderId' });
  expect(plan.filter((entry) => entry.op === 'object-permissions')).toHaveLength(1);
  expect(plan.filter((entry) => entry.op === 'manual').map((entry) => (entry as { title: string }).title).sort())
    .toEqual(['feature-access', 'record-access']);
  expect(plan[plan.length - 1]).toEqual({ op: 'assign', user: '005000000000001AAA' });
});

test('dry-run renders without secrets or raw identifiers leaking shape', () => {
  const options = base(['object-crud:ChangeRequest:read,delete', 'record-access']);
  const text = renderPlan(planSetup(options), options);
  expect(text).toContain('ChangeRequest');
  expect(text).toContain('read,delete');
  expect(text).toContain('[manual] record-access');
  expect(text).toContain('dry-run');
  expect(text).not.toContain('005000000000001AAA');
});
