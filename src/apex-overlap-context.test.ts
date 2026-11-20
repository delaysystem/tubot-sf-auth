import { test, expect } from 'bun:test';
import {
  apexOverlapAccepted,
  apexOverlapActionName,
  apexOverlapContractValid,
  apexOverlapWindowDays,
  invokeApexOverlapWithContext,
} from './apex-overlap-context';

const ROOT = '/services/data/v67.0';
const ROUTE = `${ROOT}/actions/custom/apex/FSL__RunFixScheduleOverlaps`;
const OWNER = '005000000000001AAA';
const RESOURCE_ID = '0Hn000000000001AAA';
const POLICY_ID = '0n1000000000001AAA';

const OVERLAP_INPUTS = [
  { name: 'ResourceId', type: 'STRING', required: true },
  { name: 'SchedulingPolicyId', type: 'STRING', required: true },
  { name: 'ResourceTimeZone', type: 'STRING', required: true },
  { name: 'StartTime', type: 'DATETIME', required: true },
  { name: 'EndTime', type: 'DATETIME', required: true },
];

const result = (body: any, status = 200) => ({ body, status, ok: status < 400 });

test('overlap routes classify by live route shape only', () => {
  expect(apexOverlapActionName(ROUTE)).toBe('FSL__RunFixScheduleOverlaps');
  expect(apexOverlapActionName(`${ROOT}/actions/custom/apex/FutureOverlapTwin`)).toBe('FutureOverlapTwin');
  expect(apexOverlapActionName(`${ROOT}/actions/custom/flow/SomeFlow`)).toBeNull();
  expect(apexOverlapActionName('not a route')).toBeNull();
});

test('overlap contract requires exactly the five-input fix shape', () => {
  expect(apexOverlapContractValid(OVERLAP_INPUTS)).toBe(true);
  expect(apexOverlapContractValid([...OVERLAP_INPUTS, { name: 'extra', type: 'STRING', required: true }])).toBe(false);
  expect(apexOverlapContractValid(OVERLAP_INPUTS.slice(0, 4))).toBe(false);
  expect(apexOverlapContractValid(OVERLAP_INPUTS.map((field) =>
    field.name === 'EndTime' ? { ...field, required: false } : field))).toBe(false);
  expect(apexOverlapContractValid([])).toBe(false);
  expect(apexOverlapContractValid(null)).toBe(false);
});

test('probe window spans a far-future UTC day', () => {
  const window = apexOverlapWindowDays(Date.parse('2026-10-06T12:00:00.000Z'));
  expect(window.start).toBe('2026-11-05T00:00:00.000Z');
  expect(window.end).toBe('2026-11-05T23:59:59.999Z');
});

test('overlap acceptance requires the success envelope', () => {
  expect(apexOverlapAccepted(200, [{ isSuccess: true, errors: null }])).toBe(true);
  expect(apexOverlapAccepted(200, [{ isSuccess: false, errors: [] }])).toBe(false);
  expect(apexOverlapAccepted(400, [{ isSuccess: true, errors: null }])).toBe(false);
  expect(apexOverlapAccepted(200, [])).toBe(false);
});

type HarnessOptions = {
  inputs?: any[];
  resources?: string[];
  policy?: string | null;
  zone?: string | null;
  guardBefore?: number;
  guardAfter?: number;
  invoke?: any;
};
function harness(options: HarnessOptions = {}) {
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  let guardCalls = 0;
  const request = async (path: string, method = 'GET', body?: any) => {
    calls.push({ path, method, body });
    if (method === 'GET' && path === ROUTE) return result({ inputs: options.inputs ?? OVERLAP_INPUTS });
    if (path.startsWith(`${ROOT}/query?q=`)) {
      const soql = decodeURIComponent(path.slice(`${ROOT}/query?q=`.length));
      if (soql.includes('FROM ServiceResource')) {
        return result({ records: (options.resources ?? [RESOURCE_ID]).map((Id) => ({ Id })) });
      }
      if (soql.includes('FROM FSL__Scheduling_Policy__c')) {
        return result({ records: options.policy === null ? [] : [{ Id: options.policy ?? POLICY_ID }] });
      }
      if (soql.includes('FROM Organization')) {
        return result({ records: options.zone === null ? [] : [{ TimeZoneSidKey: options.zone ?? 'America/Los_Angeles' }] });
      }
      if (soql.includes('FROM ServiceAppointment')) {
        guardCalls += 1;
        const count = guardCalls === 1 ? (options.guardBefore ?? 0) : (options.guardAfter ?? 0);
        return result({ records: Array.from({ length: count }, (_, n) => ({ Id: `08p00000000000${n}AAA` })) });
      }
    }
    if (method === 'POST' && path === ROUTE) {
      return result(options.invoke ?? [{ isSuccess: true, errors: null, outputValues: {} }]);
    }
    throw new Error(`unexpected call ${method} ${path}`);
  };
  return { request, calls };
}

test('guarded lifecycle invokes inside a proven-empty window and verifies it stayed empty', async () => {
  const h = harness();
  const outcome = await invokeApexOverlapWithContext({ root: ROOT, route: ROUTE,
    ownerUserId: OWNER, request: h.request });
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema?.verified).toBe(true);
  expect(outcome.contextSchema?.resourceId).toBe(RESOURCE_ID);
  expect(outcome.contextSchema?.policyId).toBe(POLICY_ID);
  expect(outcome.contextSchema?.guardBefore).toBe(0);
  expect(outcome.contextSchema?.guardAfter).toBe(0);
  const posted = h.calls.find((call) => call.method === 'POST' && call.path === ROUTE);
  expect(posted?.body.inputs[0]).toMatchObject({
    ResourceId: RESOURCE_ID, SchedulingPolicyId: POLICY_ID, ResourceTimeZone: 'America/Los_Angeles',
  });
  expect(typeof posted?.body.inputs[0].StartTime).toBe('string');
});

test('occupied window refuses with no apex POST', async () => {
  const h = harness({ guardBefore: 1 });
  const outcome = await invokeApexOverlapWithContext({ root: ROOT, route: ROUTE,
    ownerUserId: OWNER, request: h.request });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('APEX_OVERLAP_WINDOW_OCCUPIED');
  expect(h.calls.some((call) => call.method === 'POST' && call.path === ROUTE)).toBe(false);
});

test('dirtied window fails verification instead of claiming success', async () => {
  const h = harness({ guardAfter: 1 });
  const outcome = await invokeApexOverlapWithContext({ root: ROOT, route: ROUTE,
    ownerUserId: OWNER, request: h.request });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('APEX_OVERLAP_WINDOW_DIRTIED');
  expect(outcome.contextSchema?.verified).toBe(false);
});

test('missing resource, policy, or timezone refuse before any invoke', async () => {
  for (const options of [{ resources: [] }, { policy: null }, { zone: null }] as HarnessOptions[]) {
    const h = harness(options);
    const outcome = await invokeApexOverlapWithContext({ root: ROOT, route: ROUTE,
      ownerUserId: OWNER, request: h.request });
    expect(outcome.status).toBe(422);
    expect(h.calls.some((call) => call.method === 'POST' && call.path === ROUTE)).toBe(false);
  }
  const h = harness({ resources: [RESOURCE_ID, '0Hn000000000002AAA'] });
  const outcome = await invokeApexOverlapWithContext({ root: ROOT, route: ROUTE,
    ownerUserId: OWNER, request: h.request });
  expect(outcome.body.errorCode).toBe('APEX_OVERLAP_RESOURCE_AMBIGUOUS');
});

test('contract drift refuses with no apex POST', async () => {
  const h = harness({ inputs: [{ name: 'ResourceId', type: 'STRING', required: true }] });
  const outcome = await invokeApexOverlapWithContext({ root: ROOT, route: ROUTE,
    ownerUserId: OWNER, request: h.request });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('APEX_OVERLAP_CONTRACT_UNSUPPORTED');
  expect(h.calls.some((call) => call.method === 'POST')).toBe(false);
});
