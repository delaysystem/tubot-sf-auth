import { test, expect } from 'bun:test';
import {
  notificationActionName,
  isNotificationOwnedContextRoute,
  notificationInvocationInputs,
  notificationRecordIdRejected,
  notificationSendAccepted,
  notificationLicenseBlocked,
  invokeNotificationWithContext,
} from './notification-owned-context';

const ROOT = '/services/data/v67.0';
const ROUTE = `${ROOT}/actions/custom/sendNotification/amount_updated`;
const RECIPIENT = '005000000000001AAA';
const OWNED_ID = '006000000000001AAA';
const CASE_ID = '500000000000001AAA';

test('notification routes classify by live route shape only', () => {
  expect(notificationActionName(ROUTE)).toBe('amount_updated');
  expect(notificationActionName(`${ROOT}/actions/custom/sendNotification/deal_won`)).toBe('deal_won');
  expect(notificationActionName(`${ROOT}/actions/custom/sendNotification/future_type_added_tomorrow`)).toBe('future_type_added_tomorrow');
  expect(notificationActionName(`${ROOT}/actions/standard/sendNotification`)).toBeNull();
  expect(notificationActionName(`${ROOT}/actions/custom/flow/sendNotification`)).toBeNull();
  expect(notificationActionName('not a route')).toBeNull();
  expect(isNotificationOwnedContextRoute(ROUTE, 'custom/sendNotification')).toBe(true);
  expect(isNotificationOwnedContextRoute(ROUTE)).toBe(true);
  expect(isNotificationOwnedContextRoute(`${ROOT}/actions/standard/submit`, 'standard')).toBe(false);
});

test('invocation inputs resolve dynamically from the live descriptor', () => {
  const live = [
    { name: 'recipientIds', type: 'ID', required: true, maxOccurs: 500 },
    { name: 'recordId', type: 'ID', required: true, maxOccurs: 1 },
  ];
  expect(notificationInvocationInputs(live)).toEqual({ recipientField: 'recipientIds', recordField: 'recordId' });
  // Renamed fields keep working when the collection/single shape holds.
  const renamed = [
    { name: 'whoGetsIt', type: 'id', maxOccurs: 200 },
    { name: 'aboutWhat', type: 'ID', maxOccurs: 1 },
  ];
  expect(notificationInvocationInputs(renamed)).toEqual({ recipientField: 'whoGetsIt', recordField: 'aboutWhat' });
  expect('failure' in notificationInvocationInputs([{ name: 'onlyOne', type: 'ID', maxOccurs: 1 }])).toBe(true);
  expect('failure' in notificationInvocationInputs([])).toBe(true);
  expect('failure' in notificationInvocationInputs(null)).toBe(true);
});

test('send acceptance and license gates read the envelope only', () => {
  const ok = [{ isSuccess: true, errors: [], outputValues: { SuccessMessage: 'Your notification was submitted.' } }];
  expect(notificationSendAccepted(200, ok)).toBe(true);
  expect(notificationSendAccepted(200, [{ isSuccess: true, errors: null }])).toBe(true);
  expect(notificationSendAccepted(200, [{ isSuccess: false, errors: [] }])).toBe(false);
  expect(notificationSendAccepted(400, [{ isSuccess: true, errors: [] }])).toBe(false);
  expect(notificationSendAccepted(200, [])).toBe(false);
  expect(notificationLicenseBlocked([{ isSuccess: false, errors: [{ message: 'Custom Notifications need a Digital Experiences license' }] }])).toBe(true);
  expect(notificationLicenseBlocked(ok)).toBe(false);
});

type HarnessOptions = { postError?: unknown; deleteStuck?: boolean; buildMismatch?: boolean; caseDescribeDenied?: boolean };
function harness(options: HarnessOptions = {}) {
  let fixture: any = null;
  let caseFixture: any = null;
  const calls: Array<{ path: string; method: string }> = [];
  const inputs = [
    { name: 'recipientIds', type: 'ID', required: true, maxOccurs: 500 },
    { name: 'recordId', type: 'ID', required: true, maxOccurs: 1 },
  ];
  const result = (body: any, status = 200) => ({ body, status, ok: status < 400 });
  const request = async (path: string, method = 'GET', body?: any) => {
    calls.push({ path, method });
    if (method === 'GET' && path === ROUTE) return result({ inputs });
    if (path === `${ROOT}/sobjects/Opportunity/describe`) {
      return result({ createable: true, deletable: true, queryable: true, fields: [{ name: 'Name' }] });
    }
    if (path === `${ROOT}/sobjects/Case/describe`) {
      if (options.caseDescribeDenied) return result({ errorCode: 'NOT_FOUND' }, 404);
      return result({ createable: true, deletable: true, queryable: true, fields: [{ name: 'Subject' }] });
    }
    if (path === `${ROOT}/sobjects/Opportunity` && method === 'POST') {
      fixture = { ...body, Id: OWNED_ID };
      return result({ id: OWNED_ID }, 201);
    }
    if (path === `${ROOT}/sobjects/Case` && method === 'POST') {
      caseFixture = { ...body, Id: CASE_ID };
      return result({ id: CASE_ID }, 201);
    }
    if (path === `${ROOT}/sobjects/Opportunity/${OWNED_ID}`) {
      if (method === 'DELETE') {
        if (!options.deleteStuck) fixture = null;
        return result(null, 204);
      }
      return fixture ? result(fixture) : result([], 404);
    }
    if (path === `${ROOT}/sobjects/Case/${CASE_ID}`) {
      if (method === 'DELETE') {
        if (!options.deleteStuck) caseFixture = null;
        return result(null, 204);
      }
      return caseFixture ? result(caseFixture) : result([], 404);
    }
    if (path.startsWith(`${ROOT}/query?q=`)) {
      const soql = decodeURIComponent(path.slice(`${ROOT}/query?q=`.length));
      if (soql.includes('FROM Case ')) return result({ records: caseFixture ? [caseFixture] : [] });
      return result({ records: fixture ? [fixture] : [] });
    }
    if (method === 'POST' && path === ROUTE) {
      const recordId = body?.inputs?.[0]?.recordId;
      if (options.postError && recordId === OWNED_ID) return result(options.postError, 400);
      return result([{ isSuccess: true, errors: null, outputValues: { SuccessMessage: 'Your notification was submitted.' } }]);
    }
    throw new Error(`unexpected call ${method} ${path}`);
  };
  const build = async (_name: string, marker: string, values: any) => ({
    values: options.buildMismatch ? { ...values, Name: 'tampered' } : values,
  });
  return { request, build, calls, markerOf: () => (fixture ? (fixture as any).Name : null) };
}

test('owned lifecycle sends to the live recipient about the owned fixture', async () => {
  const h = harness();
  const outcome = await invokeNotificationWithContext({
    root: ROOT, route: ROUTE, recipientUserId: RECIPIENT, request: h.request, build: h.build,
  });
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema?.verified).toBe(true);
  expect(outcome.contextSchema?.ownedRecordId).toBe(OWNED_ID);
  expect(outcome.contextSchema?.deliveryMessage).toBe('Your notification was submitted.');
  expect(outcome.cleanupError).toBeUndefined();
  const post = h.calls.filter((c) => c.path === ROUTE && c.method === 'POST');
  expect(post).toHaveLength(1);
  // Fixture deleted and absence verified.
  expect(h.calls.some((c) => c.path === `${ROOT}/sobjects/Opportunity/${OWNED_ID}` && c.method === 'DELETE')).toBe(true);
});

test('skipped Case fallback records which gate did not fire', async () => {
  const h = harness({ postError: [{ isSuccess: false, errors: [{ message: 'Invalid parameter value for: recordId' }] }], caseDescribeDenied: true });
  const outcome = await invokeNotificationWithContext({
    root: ROOT, route: ROUTE, recipientUserId: RECIPIENT, request: h.request, build: h.build,
  });
  expect(outcome.contextSchema?.verified).toBe(false);
  expect(outcome.contextSchema?.fallbackSkipped).toBe('case-schema');
  expect(outcome.contextSchema?.fallbackFixture).toBeUndefined();
  expect(outcome.cleanupError).toBeUndefined();
});

test('record id rejection reads only the rejection signal', () => {
  expect(notificationRecordIdRejected(400, [{ errors: [{ errorCode: 'INVALID_ARGUMENT_TYPE' }] }])).toBe(true);
  expect(notificationRecordIdRejected(400, [{ isSuccess: false, errors: [{ message: 'Invalid parameter value for: recordId' }] }])).toBe(true);
  expect(notificationRecordIdRejected(400, [{ isSuccess: false, errors: [{ message: 'Upstream exploded' }] }])).toBe(false);
  expect(notificationRecordIdRejected(200, [{ isSuccess: true, errors: null }])).toBe(false);
  expect(notificationRecordIdRejected(500, [{ message: 'Invalid parameter value for: recordId' }])).toBe(false);
});

test('upstream rejection never verifies but still cleans up', async () => {
  const h = harness({ postError: [{ isSuccess: false, errors: [{ message: 'Upstream exploded' }] }] });
  const outcome = await invokeNotificationWithContext({
    root: ROOT, route: ROUTE, recipientUserId: RECIPIENT, request: h.request, build: h.build,
  });
  expect(outcome.contextSchema?.verified).toBe(false);
  expect(outcome.cleanupError).toBeUndefined();
  expect(h.calls.some((c) => c.path === `${ROOT}/sobjects/Opportunity/${OWNED_ID}` && c.method === 'DELETE')).toBe(true);
  // No record rejection: no Case fallback attempted.
  expect(h.calls.some((c) => c.path === `${ROOT}/sobjects/Case` && c.method === 'POST')).toBe(false);
});

test('record id rejection retries once with a Case fixture and cleans up both', async () => {
  const h = harness({ postError: [{ isSuccess: false, errors: [{ message: 'Invalid parameter value for: recordId' }] }] });
  const outcome = await invokeNotificationWithContext({
    root: ROOT, route: ROUTE, recipientUserId: RECIPIENT, request: h.request, build: h.build,
  });
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema?.verified).toBe(true);
  expect(outcome.contextSchema?.fallbackFixture).toBe('Case');
  expect(outcome.cleanupError).toBeUndefined();
  const posts = h.calls.filter((c) => c.path === ROUTE && c.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(h.calls.some((c) => c.path === `${ROOT}/sobjects/Opportunity/${OWNED_ID}` && c.method === 'DELETE')).toBe(true);
  expect(h.calls.some((c) => c.path === `${ROOT}/sobjects/Case/${CASE_ID}` && c.method === 'DELETE')).toBe(true);
});

test('stuck fixture surfaces a cleanup error and drops verification', async () => {
  const h = harness({ deleteStuck: true });
  const outcome = await invokeNotificationWithContext({
    root: ROOT, route: ROUTE, recipientUserId: RECIPIENT, request: h.request, build: h.build,
  });
  expect(typeof outcome.cleanupError).toBe('string');
  expect(outcome.contextSchema?.verified).toBe(false);
});

test('no identity is ever fabricated', async () => {
  const h = harness();
  const badRecipient = await invokeNotificationWithContext({
    root: ROOT, route: ROUTE, recipientUserId: 'not-an-id', request: h.request, build: h.build,
  });
  expect(badRecipient.body?.errorCode).toBe('NOTIFICATION_RECIPIENT_INVALID');
  expect(h.calls).toHaveLength(0);
  const badRoute = await invokeNotificationWithContext({
    root: ROOT, route: `${ROOT}/actions/standard/submit`, recipientUserId: RECIPIENT, request: h.request, build: h.build,
  });
  expect(badRoute.body?.errorCode).toBe('NOTIFICATION_ACTION_INVALID');
  const ht = harness({ buildMismatch: true });
  const tampered = await invokeNotificationWithContext({
    root: ROOT, route: ROUTE, recipientUserId: RECIPIENT, request: ht.request, build: ht.build,
  });
  expect(tampered.body?.errorCode).toBe('NOTIFICATION_BUILD_UNSCOPED');
});
