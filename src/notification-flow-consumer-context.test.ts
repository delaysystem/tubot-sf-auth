import { test, expect } from 'bun:test';
import {
  notificationFlowActionName,
  notificationFlowStem,
  notificationAlertStem,
  pairNotificationFlowAlerts,
  notificationFlowEmailFields,
  notificationFlowMarkerField,
  recipientEmailsNonRoutable,
  assessNotificationFlowInvocation,
  invokeNotificationFlowWithContext,
} from './notification-flow-consumer-context';

const ROOT = '/services/data/v67.0';
const SELF = '005000000000001AAA';
const SELF_EMAIL = 'worker@example.com';
const OWNED_ID = 'a0T000000000001AAA';
const OBJECT = 'sfcma__Subscription__c';
const FLOW = 'sfcma__BillingReminder_Notification_Flow';
const ROUTE = `${ROOT}/actions/custom/flow/${FLOW}`;
const WHATIDS_DESC = 'Loop through the email whatIds provided by the apex invoker of this flow.';

test('notification-flow routes classify by live route shape only', () => {
  for (const stem of ['BillingReminder', 'CancellationProcessed', 'CancellationRefund', 'FreeTrialEnding',
    'FreeTrialSignup', 'LicenseCountChanged', 'Mock', 'PaymentDeclined', 'PaymentProcessed', 'PurchaseConfirmation']) {
    expect(notificationFlowActionName(`${ROOT}/actions/custom/flow/sfcma__${stem}_Notification_Flow`))
      .toBe(`sfcma__${stem}_Notification_Flow`);
  }
  expect(notificationFlowActionName(`${ROOT}/actions/standard/submit`)).toBeNull();
  expect(notificationFlowActionName(`${ROOT}/actions/custom/sendNotification/amount_updated`)).toBeNull();
  expect(notificationFlowActionName('not a route')).toBeNull();
});

test('notification stems pair flows to alerts without enumerating names', () => {
  expect(notificationFlowStem('sfcma__BillingReminder_Notification_Flow')).toBe('BillingReminder');
  expect(notificationFlowStem('future__Thing_Notification_Flow')).toBe('Thing');
  expect(notificationFlowStem('sfcma__Something_Else')).toBeNull();
  expect(notificationAlertStem('sfcma__BillingReminder_Customer_Notification')).toBe('BillingReminder');
  expect(notificationAlertStem('sfcma__FreeTrialEnding_Partner_Notification')).toBe('FreeTrialEnding');
  expect(notificationAlertStem('sfcma__Mock_Email_Alert')).toBe('Mock');
  expect(notificationAlertStem('sfcma__Random_Template')).toBeNull();
  const alerts = [
    { name: 'sfcma__BillingReminder_Customer_Notification', targetEntityName: 'sfcma__Subscription__c' },
    { name: 'sfcma__FreeTrialEnding_Customer_Notification', targetEntityName: 'sfcma__Subscription__c' },
    { name: 'sfcma__FreeTrialEnding_Partner_Notification', targetEntityName: 'sfcma__Subscription__c' },
    { name: 'sfcma__Mock_Email_Alert', targetEntityName: 'sfcma__Customer__c' },
  ];
  expect(pairNotificationFlowAlerts('sfcma__BillingReminder_Notification_Flow', alerts)).toEqual({
    objectName: 'sfcma__Subscription__c', alertNames: ['sfcma__BillingReminder_Customer_Notification'],
  });
  const freeTrial = pairNotificationFlowAlerts('sfcma__FreeTrialEnding_Notification_Flow', alerts);
  if ('failure' in freeTrial) throw new Error('Expected FreeTrialEnding to pair.');
  expect(freeTrial.objectName).toBe('sfcma__Subscription__c');
  expect(freeTrial.alertNames).toHaveLength(2);
  expect(pairNotificationFlowAlerts('sfcma__Mock_Notification_Flow', alerts)).toEqual({
    objectName: 'sfcma__Customer__c', alertNames: ['sfcma__Mock_Email_Alert'],
  });
  expect(pairNotificationFlowAlerts('Thing_Notification_Flow',
    [{ name: 'Thing_Notification', targetEntityName: 'Order' }])).toEqual({
    objectName: 'Order', alertNames: ['Thing_Notification'],
  });
  expect('failure' in pairNotificationFlowAlerts('sfcma__Nope_Notification_Flow', alerts)).toBe(true);
  expect('failure' in pairNotificationFlowAlerts('sfcma__BillingReminder_Notification_Flow', [
    { name: 'sfcma__BillingReminder_Customer_Notification', targetEntityName: 'sfcma__Subscription__c' },
    { name: 'sfcma__BillingReminder_Partner_Notification', targetEntityName: 'Order' },
  ])).toBe(true);
  expect('failure' in pairNotificationFlowAlerts('other__BillingReminder_Notification_Flow', alerts)).toBe(true);
});

test('email and marker fields resolve from the live describe only', () => {
  const body = { fields: [
    { name: 'Name', type: 'string', createable: true },
    { name: 'sfcma__Email__c', type: 'email', createable: true },
    { name: 'Other__c', type: 'email', createable: false },
    { name: 'Amount__c', type: 'currency', createable: true },
    { name: '9bad', type: 'email', createable: true },
  ] };
  expect(notificationFlowEmailFields(body)).toEqual(['sfcma__Email__c']);
  expect(notificationFlowEmailFields(null)).toEqual([]);
  expect(notificationFlowMarkerField(body)).toBe('Name');
  expect(notificationFlowMarkerField({ fields: [{ name: 'Subject', type: 'string', createable: true }] })).toBe('Subject');
  expect(notificationFlowMarkerField({ fields: [
    { name: 'Wide__c', type: 'textarea', createable: true, filterable: true, length: 255 },
  ] })).toBe('Wide__c');
  expect(notificationFlowMarkerField({ fields: [{ name: 'Name', type: 'reference', createable: true }] })).toBeNull();
  expect(notificationFlowMarkerField(null)).toBeNull();
});

test('recipient invariant accepts only non-routable-or-empty email values', () => {
  expect(recipientEmailsNonRoutable({ a: 'x@Example.INVALID' }, ['a'])).toBe(true);
  expect(recipientEmailsNonRoutable({ a: null, b: '' }, ['a', 'b'])).toBe(true);
  expect(recipientEmailsNonRoutable({}, ['a'])).toBe(true);
  expect(recipientEmailsNonRoutable({ a: 'real@example.com' }, ['a'])).toBe(false);
  expect(recipientEmailsNonRoutable({ a: 'not-an-email' }, ['a'])).toBe(false);
});

test('consumer invocation evidence requires Finished, whatIds echo, and clean mail results', () => {
  const finished = (outputValues: any) => [{ isSuccess: true, errors: [], outputValues }];
  expect(assessNotificationFlowInvocation(200, finished({
    Flow__InterviewStatus: 'Finished', whatIds: [OWNED_ID], mailResults: ['sent'],
  }), OWNED_ID)).toEqual({ ok: true, mailResults: ['sent'] });
  expect(assessNotificationFlowInvocation(500, finished({}), OWNED_ID).ok).toBe(false);
  expect(assessNotificationFlowInvocation(200, [{ isSuccess: false, errors: [], outputValues: {} }], OWNED_ID))
    .toMatchObject({ ok: false, code: 'NOTIFICATION_FLOW_CONSUMER_FAILED' });
  expect(assessNotificationFlowInvocation(200, finished({ Flow__InterviewStatus: 'Error' }), OWNED_ID))
    .toMatchObject({ ok: false, code: 'NOTIFICATION_FLOW_CONSUMER_FAILED' });
  expect(assessNotificationFlowInvocation(200, finished({
    Flow__InterviewStatus: 'Finished', whatIds: [OWNED_ID], mailResults: ['Failed to send mail'],
  }), OWNED_ID)).toMatchObject({ ok: false, code: 'NOTIFICATION_FLOW_CONSUMER_FAILED' });
  expect(assessNotificationFlowInvocation(200, finished({
    Flow__InterviewStatus: 'Finished', whatIds: ['a0T000000000009AAA'], mailResults: [],
  }), OWNED_ID)).toMatchObject({ ok: false, code: 'NOTIFICATION_FLOW_CONSUMER_UNVERIFIED' });
});

type HarnessOptions = { catalog404?: boolean; emailMismatch?: boolean; creatorMismatch?: boolean };
function harness(options: HarnessOptions = {}) {
  let fixture: any = null;
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  const result = (body: any, status = 200) => ({ body, status, ok: status < 400 });
  const subPath = `${ROOT}/actions/custom/emailAlert/${OBJECT}`;
  const alertPath = `${subPath}/sfcma__BillingReminder_Customer_Notification`;
  const request = async (path: string, method = 'GET', body?: any) => {
    calls.push({ path, method, body });
    if (method === 'GET' && path === ROUTE) {
      return result({
        inputs: [
          { name: 'whatIds', type: 'STRING', required: false, maxOccurs: 2000, description: WHATIDS_DESC },
          { name: 'mailResults', type: 'STRING', required: false, maxOccurs: 2000 },
        ],
        outputs: [{ name: 'Flow__InterviewStatus' }],
      });
    }
    if (method === 'GET' && path === `${ROOT}/actions/custom/emailAlert`) {
      if (options.catalog404) return result([{ message: 'Not found', errorCode: 'NOT_FOUND' }], 404);
      return result({ [OBJECT]: subPath });
    }
    if (method === 'GET' && path === subPath) return result({ actions: [{ url: alertPath }] });
    if (method === 'GET' && path === alertPath) {
      return result({ name: `sfcma.${OBJECT}.sfcma__BillingReminder_Customer_Notification`, targetEntityName: OBJECT });
    }
    if (path === `${ROOT}/sobjects/${OBJECT}/describe`) {
      return result({ createable: true, deletable: true, queryable: true, fields: [
        { name: 'Name', type: 'string', createable: true },
        { name: 'sfcma__Email__c', type: 'email', createable: true },
      ] });
    }
    if (path === `${ROOT}/sobjects/${OBJECT}` && method === 'POST') {
      fixture = { ...body, Id: OWNED_ID, CreatedById: options.creatorMismatch ? '005000000000009AAA' : SELF };
      if (options.emailMismatch) fixture.sfcma__Email__c = 'real@example.com';
      return result({ id: OWNED_ID }, 201);
    }
    if (path === `${ROOT}/sobjects/${OBJECT}/${OWNED_ID}`) {
      if (method === 'DELETE') { fixture = null; return result(null, 204); }
      return fixture ? result(fixture) : result([], 404);
    }
    if (path.startsWith(`${ROOT}/query?q=`)) {
      const soql = decodeURIComponent(path.slice(`${ROOT}/query?q=`.length));
      if (soql.includes('FROM EmailMessage')) return result({ records: [] });
      return result({ records: fixture ? [fixture] : [] });
    }
    if (method === 'POST' && path === ROUTE) {
      return result([{ isSuccess: true, errors: [], outputValues: {
        Flow__InterviewStatus: 'Finished', whatIds: [OWNED_ID], mailResults: ['queued'],
      } }]);
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const invoke = () => invokeNotificationFlowWithContext({
    root: ROOT, route: ROUTE, selfUserId: SELF, selfEmail: SELF_EMAIL, request,
    build: async (_name, _marker, values) => ({ values }),
  });
  return { invoke, calls: () => calls, state: () => ({ fixture }) };
}

test('lifecycle converts with verified recipient and zero residue', async () => {
  const h = harness();
  const result = await h.invoke();
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.invokedUpstream).toBe(true);
  expect(result.contextSchema?.fixtureObject).toBe(OBJECT);
  expect(result.contextSchema?.pairedAlerts).toEqual(['sfcma__BillingReminder_Customer_Notification']);
  expect(result.contextSchema?.emailFields).toEqual(['sfcma__Email__c']);
  const ordered = h.calls().map((c) => `${c.method} ${c.path}`);
  const readback = ordered.findIndex((c) => c === `GET ${ROOT}/sobjects/${OBJECT}/${OWNED_ID}`);
  const flowPost = ordered.findIndex((c) => c === `POST ${ROUTE}`);
  expect(readback).toBeGreaterThanOrEqual(0);
  expect(flowPost).toBeGreaterThan(readback);
  expect(h.calls()[flowPost].body).toEqual({ inputs: [{ whatIds: [OWNED_ID] }] });
  expect(ordered).toContain(`DELETE ${ROOT}/sobjects/${OBJECT}/${OWNED_ID}`);
  expect(JSON.stringify(result.contextSchema)).not.toContain('@');
  expect(result.cleanupError).toBeUndefined();
  expect(h.state().fixture).toBeNull();
});

test('lifecycle never POSTs when the recipient invariant fails', async () => {
  for (const options of [{ emailMismatch: true }, { creatorMismatch: true }]) {
    const h = harness(options);
    const result = await h.invoke();
    expect(result.status).toBe(422);
    expect(result.body.errorCode).toBe('NOTIFICATION_FLOW_RECIPIENT_UNVERIFIED');
    expect(result.contextSchema?.invokedUpstream).toBe(false);
    expect(h.calls().some((c) => c.method === 'POST' && c.path === ROUTE)).toBe(false);
    expect(h.state().fixture).toBeNull();
  }
});

test('lifecycle fails safe when the alert catalog is unavailable', async () => {
  const h = harness({ catalog404: true });
  const result = await h.invoke();
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe('NOTIFICATION_FLOW_ALERT_CATALOG_UNAVAILABLE');
  expect(h.calls().some((c) => c.method === 'POST' && c.path.includes('/sobjects/'))).toBe(false);
});
