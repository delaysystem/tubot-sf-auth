import { test, expect } from 'bun:test';
import {
  SKIPPED_STANDARD_BUILDER_VERSION,
  contextNamespaceExpired,
  descriptorValidValue,
  invokeSkippedStandardWithOwnedContext,
  planSkippedStandardArgs,
  primaryFixtureFor,
  scaleCenterWindowNow,
  skippedStandardBindingSpec,
  skippedStandardCode,
  skippedStandardDiscoveries,
  skippedStandardFamilySlug,
  skippedStandardFixtures,
  skippedStandardRouteInfo,
} from './skipped-standard-lifecycle';

const ROOT = '/services/data/v67.0';
const std = (name: string) => `${ROOT}/actions/standard/${name}`;
const CONTACT_ID = '003000000000001AAA';
const CASE_ID = '500000000000001AAA';
const TASK_ID = '00T000000000001EAA';
const USER_ID = '005000000000001AAA';
const QUEUE_ID = '00G000000000001EAA';
const ORDER_ID = '1Os000000000001EAA';
const INVOICE_ID = '0c1000000000001EAA';

test('route parsing accepts standard, survey/matrix, apex, batch, and dynamic routes', () => {
  expect(skippedStandardRouteInfo(std('createTask'))).toEqual({ kind: 'standard', apiVersion: 'v67.0', action: 'createTask' });
  expect(skippedStandardRouteInfo(`${ROOT}/actions/custom/dynamicSendSurveyInvitation/case_csat_nps_survey`)).toEqual({
    kind: 'custom', apiVersion: 'v67.0', action: 'case_csat_nps_survey', customKind: 'dynamicSendSurveyInvitation',
  });
  expect(skippedStandardRouteInfo(`${ROOT}/actions/custom/runDecisionMatrix/SDO_Service_Cirrus_Locations`)).toEqual({
    kind: 'custom', apiVersion: 'v67.0', action: 'SDO_Service_Cirrus_Locations', customKind: 'runDecisionMatrix',
  });
  // R7: owned apex shapes, batch refusals, and dynamic twins route here.
  expect(skippedStandardRouteInfo(`${ROOT}/actions/custom/apex/SDO_Service_BotsUpdateEmail`)).toEqual({
    kind: 'apex', apiVersion: 'v67.0', action: 'SDO_Service_BotsUpdateEmail',
  });
  expect(skippedStandardRouteInfo(`${ROOT}/actions/custom/batchJobAction/inv_replenishment__ReplenishInventory`)).toEqual({
    kind: 'batch', apiVersion: 'v67.0', action: 'inv_replenishment__ReplenishInventory',
  });
  expect(skippedStandardRouteInfo(`${ROOT}/actions/custom/buildContextDynamic/build_context_x`)).toEqual({
    kind: 'dynamic', apiVersion: 'v67.0', action: 'build_context_x', dynamicKind: 'buildContextDynamic',
  });
  expect(skippedStandardRouteInfo(`${ROOT}/actions/custom/flow/Send_Survey`)).toBeNull();
  expect(skippedStandardRouteInfo(`${ROOT}/actions/custom/quickAction/Case/Create_Task`)).toBeNull();
  expect(skippedStandardRouteInfo(`${ROOT}/actions/custom/sendNotification/deal_won`)).toBeNull();
  expect(skippedStandardRouteInfo(`${ROOT}/actions/custom/generatePromptResponse/x`)).toBeNull();
  expect(skippedStandardRouteInfo('not a route')).toBeNull();
  expect(skippedStandardRouteInfo(null)).toBeNull();
});

test('misrouted custom probes are refused, never executed or thrown from', async () => {
  // Round-4 harness rows reached this seam with custom routes the engine
  // cannot execute (notification/order-summary name-vocabulary misroutes).
  // The seam owns its contract: unclaimed routes, structured refusal, no
  // throw, no invocation, no fixture. The caller must route custom flows
  // to the flow seam, quick actions to the reference seam, and prompts to
  // the prompt seam.
  const misroutes = [
    `${ROOT}/actions/custom/flow/FSAA__AA_Custom_NotificationFlow`,
    `${ROOT}/actions/custom/flow/FSSK__FSK_Canned_Notification_Dispatched`,
    `${ROOT}/actions/custom/flow/sales_channel__NotificationsSubflow`,
    `${ROOT}/actions/custom/flow/sfdc_Checkout_Order_Summary_Notification_Flow`,
    `${ROOT}/actions/custom/quickAction/OrderSummary/SDO_OMS_UpdateOrderSummary`,
    `${ROOT}/actions/custom/generatePromptResponse/OrderManagementIntelligence__searchOrderSummary`,
  ];
  for (const route of misroutes) {
    expect(skippedStandardRouteInfo(route)).toBeNull();
  }
  let calls = 0;
  const request = async () => { calls++; return { status: 200, ok: true, body: {} }; };
  for (const [route, family] of [
    [misroutes[0], 'notification'],
    [misroutes[4], 'order-summary'],
    [misroutes[5], 'order-summary'],
  ] as Array<[string, string]>) {
    const out = await invokeSkippedStandardWithOwnedContext({ root: ROOT, route, family, request, build: async () => ({ values: {} }) });
    expect((out.body as any).errorCode).toBe('SKIPPED_STANDARD_FAMILY_UNKNOWN');
    expect((out.contextSchema as any).verified).toBe(false);
    expect(out.cleanupError).toBeUndefined();
  }
  expect(calls).toBe(0);
});

test('family slugs validate and fault codes carry the family', () => {
  expect(skippedStandardFamilySlug('task-record')).toBe('task-record');
  expect(skippedStandardFamilySlug('survey-invitation')).toBe('survey-invitation');
  expect(skippedStandardFamilySlug('preview-read')).toBeNull();
  expect(skippedStandardFamilySlug('nope')).toBeNull();
  expect(skippedStandardFamilySlug(null)).toBeNull();
  expect(skippedStandardCode('survey-invitation', 'input_unresolved')).toBe('SKIPPED_STANDARD_SURVEY_INVITATION_INPUT_UNRESOLVED');
  expect(skippedStandardCode('outbound-call', 'unownable')).toBe('SKIPPED_STANDARD_OUTBOUND_CALL_UNOWNABLE');
});

test('binding plans use declared inputs only and refuse unresolvable required inputs', () => {
  const task = planSkippedStandardArgs(skippedStandardBindingSpec('task-record', 'createTask'), [
    { name: 'taskSubjectName', type: 'STRING', required: true },
    { name: 'taskAssignedToId', type: 'PICKLIST', required: false },
    { name: 'taskDueInDays', type: 'INTEGER', required: false },
  ], { marker: 'AS probe m', ownerUserId: USER_ID, fixtures: {}, discovered: {} });
  // Optional picklist assignee stays omitted: an invented value would 400.
  expect(task).toEqual({ args: { taskSubjectName: 'AS probe m' } });

  const matrix = planSkippedStandardArgs(skippedStandardBindingSpec('decision-matrix', 'SDO_Service_Cirrus_Locations'), [
    { name: 'PostalCode', type: 'STRING', required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: {} });
  expect(matrix).toEqual({ args: { PostalCode: 'AS probe m' } });
  const matrixYears = planSkippedStandardArgs(skippedStandardBindingSpec('decision-matrix', 'x'), [
    { name: 'YearsInstalled', type: 'DOUBLE', required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: {} });
  expect(matrixYears).toEqual({ args: { YearsInstalled: 1 } });
  // Identifiers are never invented, even for evaluation families.
  expect(planSkippedStandardArgs(skippedStandardBindingSpec('decision-matrix', 'x'), [
    { name: 'recordId', type: 'ID', required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: {} })).toEqual({ missing: 'recordId' });

  const queue = planSkippedStandardArgs(skippedStandardBindingSpec('record-assignment', 'assignToQueue'), [
    { name: 'queueId', type: 'STRING', required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: { queueId: QUEUE_ID } });
  expect(queue).toEqual({ args: { queueId: QUEUE_ID } });
  // Opaque id wrappers bind shaped live ids; rowless orgs refuse the wrapper.
  const funds = planSkippedStandardArgs(skippedStandardBindingSpec('order-summary', 'ensureFundsOrderSummaryAsync'), [
    { name: 'orderSummaryId', type: 'ID', required: true },
    { name: 'ensureFundsAsyncInput', type: 'APEX', required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: { orderSummaryId: ORDER_ID, invoiceId: INVOICE_ID } });
  expect(funds).toEqual({ args: { orderSummaryId: ORDER_ID, ensureFundsAsyncInput: { invoiceId: INVOICE_ID } } });
  expect(planSkippedStandardArgs(skippedStandardBindingSpec('order-summary', 'ensureFundsOrderSummaryAsync'), [
    { name: 'orderSummaryId', type: 'ID', required: true },
    { name: 'ensureFundsAsyncInput', type: 'APEX', required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: { orderSummaryId: ORDER_ID } }))
    .toEqual({ missing: 'ensureFundsAsyncInput' });
  expect(planSkippedStandardArgs(skippedStandardBindingSpec('record-assignment', 'assignToQueue'), [
    { name: 'queueId', type: 'STRING', required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: {} })).toEqual({ missing: 'queueId' });

  // Descriptor-declared picklist values win; missing values refuse.
  const withValues = planSkippedStandardArgs(skippedStandardBindingSpec('message-send', 'sendConversationMessages'), [
    { name: 'requestType', type: 'PICKLIST', required: true, values: [{ value: 'SendNotificationMessages', active: true }] } as never,
  ], { marker: 'AS probe m', fixtures: {}, discovered: {} });
  expect(withValues).toEqual({ args: { requestType: 'SendNotificationMessages' } });
  expect(planSkippedStandardArgs(skippedStandardBindingSpec('message-send', 'x'), [
    { name: 'requestType', type: 'PICKLIST', required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: {} })).toEqual({ missing: 'requestType' });

  // Collections wrap; unknown required inputs miss; unknown optionals skip.
  const list = planSkippedStandardArgs(skippedStandardBindingSpec('service-appointment', 'rebookNotifyForFieldService'), [
    { name: 'serviceAppointmentsList', type: 'ID', required: true, maxOccurs: 20 } as never,
    { name: 'flowId', type: 'STRING', required: false },
  ], { marker: 'AS probe m', fixtures: { ServiceAppointment: '0W0000000000001EAA' }, discovered: {} });
  expect(list).toEqual({ args: { serviceAppointmentsList: ['0W0000000000001EAA'] } });
  expect(planSkippedStandardArgs(skippedStandardBindingSpec('task-record', 'createTask'), [
    { name: 'taskSubjectName', type: 'STRING', required: true },
    { name: 'mystery', type: 'STRING', required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: {} })).toEqual({ missing: 'mystery' });
  expect(planSkippedStandardArgs(skippedStandardBindingSpec('task-record', 'createTask'), [
    { name: 'bad!!', type: 'STRING', required: false },
  ], { marker: 'AS probe m', fixtures: {}, discovered: {} })).toEqual({ missing: 'input_schema' });
});

test('synthetic-eval binds freeform ApplicationName to the probe marker', () => {
  const planned = planSkippedStandardArgs(skippedStandardBindingSpec('synthetic-eval', 'invokeRule'), [
    { name: 'ExpressionSet', type: 'STRING', required: true },
    { name: 'ApplicationName', type: 'STRING', required: true },
    { name: 'Parameters', type: 'APEX', required: false },
  ], { marker: 'AS probe m', fixtures: {}, discovered: { expressionSet: 'SDO_Service_Repair_Eligibility' } });
  expect(planned).toEqual({ args: { ExpressionSet: 'SDO_Service_Repair_Eligibility', ApplicationName: 'AS probe m', Parameters: [] } });
});

test('order-summary binds discovered ids and discovers live rows', () => {
  const discoveries = skippedStandardDiscoveries('order-summary', 'ensureFundsOrderSummaryAsync');
  expect(discoveries).toEqual([
    { key: 'orderSummaryId', queryId: ['SELECT Id FROM OrderSummary LIMIT 1'] },
    { key: 'webStoreId', queryId: ['SELECT Id FROM WebStore LIMIT 1'] },
    { key: 'invoiceId', queryId: ['SELECT Id FROM Invoice LIMIT 1'] },
  ]);
  const planned = planSkippedStandardArgs(skippedStandardBindingSpec('order-summary', 'ensureFundsOrderSummaryAsync'), [
    { name: 'orderSummaryId', type: 'ID', required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: { orderSummaryId: '1Os000000000001EAA' } });
  expect(planned).toEqual({ args: { orderSummaryId: '1Os000000000001EAA' } });
  expect(planSkippedStandardArgs(skippedStandardBindingSpec('order-summary', 'generateOrderSummaryUrl'), [
    { name: 'webStoreId', type: 'ID', required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: {} })).toEqual({ missing: 'webStoreId' });
});

test('opaque id wrappers bind a shaped live id or miss', () => {
  const planned = planSkippedStandardArgs(skippedStandardBindingSpec('order-summary', 'ensureFundsOrderSummaryAsync'), [
    { name: 'ensureFundsAsyncInput', type: null, required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: { invoiceId: '3tt000000000001AAA' } });
  expect(planned).toEqual({ args: { ensureFundsAsyncInput: { invoiceId: '3tt000000000001AAA' } } });
  expect(planSkippedStandardArgs(skippedStandardBindingSpec('order-summary', 'ensureFundsOrderSummaryAsync'), [
    { name: 'ensureFundsAsyncInput', type: null, required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: {} })).toEqual({ missing: 'ensureFundsAsyncInput' });
});

test('descriptor-documented valid values bind first literals', () => {
  expect(descriptorValidValue({ name: 'x', description: 'Valid values are "Email".' } as never)).toBe('Email');
  expect(descriptorValidValue({ name: 'x', description: 'The handler. Valid values are "Appointment Confirmation" and "Other".' } as never))
    .toBe('Appointment Confirmation');
  expect(descriptorValidValue({ name: 'x', description: 'No enumerated values here.' } as never)).toBeUndefined();
  expect(descriptorValidValue({ name: 'x' } as never)).toBeUndefined();
  const planned = planSkippedStandardArgs(skippedStandardBindingSpec('message-send', 'sendChannelMessage'), [
    { name: 'engagementChannel', type: 'STRING', required: true, description: 'Valid values are "Email".' },
    { name: 'messageTypeHandler', type: 'STRING', required: true, description: 'Valid values are "Appointment Confirmation" and "Single".' },
  ], { marker: 'AS probe m', fixtures: {}, discovered: {} });
  expect(planned).toEqual({ args: { engagementChannel: 'Email', messageTypeHandler: 'Appointment Confirmation' } });
  expect(planSkippedStandardArgs(skippedStandardBindingSpec('message-send', 'sendChannelMessage'), [
    { name: 'messageTypeHandler', type: 'STRING', required: true, description: 'Pick anything.' },
  ], { marker: 'AS probe m', fixtures: {}, discovered: {} })).toEqual({ missing: 'messageTypeHandler' });
});

test('referral performers bind a comma-joined live account list', () => {
  const discoveries = skippedStandardDiscoveries('referral-record', 'createReferral');
  expect(discoveries).toEqual([
    { key: 'performerIds', queryIdList: ['SELECT Id FROM Account LIMIT 3'], limit: 3 },
  ]);
  const planned = planSkippedStandardArgs(skippedStandardBindingSpec('referral-record', 'createReferral'), [
    { name: 'performers', type: 'STRING', required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: { performerIds: '001A,001B' } });
  expect(planned).toEqual({ args: { performers: '001A,001B' } });
  expect(planSkippedStandardArgs(skippedStandardBindingSpec('referral-record', 'createReferral'), [
    { name: 'performers', type: 'STRING', required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: {} })).toEqual({ missing: 'performers' });
});

test('timesheet compute flags stay off and validation stays on', () => {
  const planned = planSkippedStandardArgs(skippedStandardBindingSpec('timesheet-validate', 'validateTimesheet'), [
    { name: 'TimeSheetId', type: 'STRING', required: true },
    { name: 'ComputeTimeSheetEntryItem', type: 'BOOLEAN', required: false },
    { name: 'ComputeWageTypeSummary', type: 'BOOLEAN', required: false },
    { name: 'RunValidations', type: 'BOOLEAN', required: false },
  ], { marker: 'AS probe m', fixtures: { TimeSheet: '0T0000000000001EAA' }, discovered: {} });
  expect(planned).toEqual({ args: {
    TimeSheetId: '0T0000000000001EAA',
    ComputeTimeSheetEntryItem: false,
    ComputeWageTypeSummary: false,
    RunValidations: true,
  } });
});

test('timesheet-validate fixtures carry the discovered ServiceResourceId parent', () => {
  expect(skippedStandardFixtures('timesheet-validate', 'validateTimesheet')).toEqual([
    { objects: ['TimeSheet'], parents: { ServiceResourceId: { discovered: 'serviceResourceId' } } },
  ]);
  expect(skippedStandardDiscoveries('timesheet-validate', 'validateTimesheet').map((entry) => entry.key)).toEqual([
    'serviceResourceId',
  ]);
});

test('fixture and discovery plans stay platform-vocabulary', () => {
  expect(primaryFixtureFor('task-record')).toBe('Task');
  expect(primaryFixtureFor('timesheet-validate')).toBe('TimeSheet');
  expect(skippedStandardFixtures('survey-invitation', 'x').map((plan) => plan.objects)).toEqual([['Contact'], ['Case']]);
  expect(skippedStandardFixtures('decision-matrix', 'x')).toEqual([]);
  expect(skippedStandardFixtures('message-send', 'notifyUser')).toEqual([]);
  expect(skippedStandardFixtures('industries-async', 'industriesSendExtAsyncRequest')).toEqual([]);
  expect(skippedStandardFixtures('industries-async', 'industriesSendApexAsyncRequest').map((plan) => plan.objects)).toEqual([['Case']]);
  expect(skippedStandardDiscoveries('record-assignment', 'assignToQueue').map((entry) => entry.key)).toEqual(['queueId']);
  expect(skippedStandardDiscoveries('call-experience', 'postCallExperienceAction').map((entry) => entry.key)).toEqual(['endedCallId']);
});

// ---------------------------------------------------------------------------
// Scripted lifecycle harnesses (repo-established request/build injection).
// ---------------------------------------------------------------------------

type ScriptedResponse = { status: number; body: any };
type Harness = {
  request: (path: string, method?: string, body?: any) => Promise<{ status: number; ok: boolean; body: any }>;
  build: (name: string, marker: string, values: Record<string, any>) => Promise<{ values: Record<string, any> }>;
  calls: Array<{ method: string; path: string; body?: any }>;
};

function describeFor(object: string, fields: Array<Record<string, any>>): ScriptedResponse {
  return { status: 200, body: { name: object, createable: true, queryable: true, deletable: true, fields } };
}

function textField(name: string, length = 80): Record<string, any> {
  return { name, type: 'string', createable: true, filterable: true, nillable: true, length };
}

function scripted(routes: Array<{ match: (method: string, path: string) => boolean; respond: (method: string, path: string, body?: any) => ScriptedResponse }>): Harness {
  const calls: Harness['calls'] = [];
  return {
    calls,
    request: async (path: string, method = 'GET', body?: any) => {
      calls.push({ method, path, body });
      let decoded = path;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        /* match the raw path */
      }
      const route = routes.find((entry) => entry.match(method, path) || entry.match(method, decoded));
      const response = route ? route.respond(method, path, body) : { status: 404, body: { errorCode: 'NOT_FOUND' } };
      return { status: response.status, ok: response.status >= 200 && response.status < 300, body: response.body };
    },
    build: async (_name: string, _marker: string, values: Record<string, any>) => ({ values }),
  };
}

const ACCEPTED = [{ isSuccess: true, errors: [], outputValues: {} }];

test('terminal families refuse explicitly without invoking', async () => {
  for (const [route, family] of [
    [std('scvOutboundCall'), 'outbound-call'],
    [std('outboundAsyncAction'), 'outbound-call'],
    [std('itServicePasswordReset'), 'credential-reset'],
  ] as const) {
    const harness = scripted([
      { match: (method, path) => method === 'GET' && path === route, respond: () => ({ status: 200, body: { inputs: [] } }) },
    ]);
    const outcome = await invokeSkippedStandardWithOwnedContext({
      root: ROOT, route, family, ownerUserId: USER_ID, request: harness.request, build: harness.build,
    });
    expect(outcome.status).toBe(422);
    expect(outcome.body.errorCode).toBe(family === 'outbound-call'
      ? 'SKIPPED_STANDARD_OUTBOUND_CALL_UNOWNABLE'
      : 'SKIPPED_STANDARD_CREDENTIAL_RESET_UNOWNABLE');
    expect(harness.calls.some((call) => call.method === 'POST' && call.path === route)).toBe(false);
    expect(outcome.contextSchema).toMatchObject({ verified: false, family });
  }
});

test('unknown families, mismatched routes, and bad windows fail closed', async () => {
  const harness = scripted([]);
  const unknown = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route: std('createTask'), family: 'preview-read', request: harness.request, build: harness.build,
  });
  expect(unknown.body.errorCode).toBe('SKIPPED_STANDARD_FAMILY_UNKNOWN');
  expect(harness.calls.length).toBe(0);
  const mismatch = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route: `${ROOT}/actions/custom/runDecisionMatrix/x`, family: 'task-record',
    request: harness.request, build: harness.build,
  });
  expect(mismatch.body.errorCode).toBe('SKIPPED_STANDARD_TASK_RECORD_FAMILY_MISMATCH');
  const window = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route: std('createTask'), family: 'task-record', verificationWindowMs: 99_999,
    request: harness.request, build: harness.build,
  });
  expect(window.body.errorCode).toBe('SKIPPED_STANDARD_TASK_RECORD_WINDOW_INVALID');
  const badRoute = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route: `${ROOT}/actions/custom/flow/x`, family: 'task-record',
    request: harness.request, build: harness.build,
  });
  expect(badRoute.body.errorCode).toBe('SKIPPED_STANDARD_FAMILY_UNKNOWN');
});

test('decision-matrix evaluation succeeds on native acceptance with no fixtures', async () => {
  const route = `${ROOT}/actions/custom/runDecisionMatrix/SDO_Service_Cirrus_Locations`;
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [{ name: 'PostalCode', type: 'STRING', required: true }] } }) },
    { match: (method, path) => method === 'POST' && path === route,
      respond: (_m, _p, body) => {
        expect(body.inputs[0].PostalCode).toMatch(/^AS probe /);
        return { status: 200, body: [{ isSuccess: true, errors: [], outputValues: { Location: 'Cirrus' } }] };
      } },
  ]);
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'decision-matrix', request: harness.request, build: harness.build,
  });
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema).toMatchObject({ verified: true, family: 'decision-matrix' });
  expect(outcome.cleanupError).toBeUndefined();
});

test('task creation verifies the created row and deletes it with verified absence', async () => {
  const route = std('createTask');
  const posts: any[] = [];
  const deleted = new Set<string>();
  let taskQueries = 0;
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [{ name: 'taskSubjectName', type: 'STRING', required: true }] } }) },
    { match: (method, path) => method === 'POST' && path === route,
      respond: (_m, _p, body) => {
        posts.push(body);
        return { status: 200, body: ACCEPTED };
      } },
    { match: (method, path) => method === 'GET' && path.includes('/sobjects/Task/describe'),
      respond: () => describeFor('Task', [textField('Subject'), textField('Description', 32000)]) },
    { match: (method, path) => method === 'GET' && path.includes('FROM Task WHERE Subject'),
      respond: () => (++taskQueries === 1
        ? { status: 200, body: { records: [{ Id: TASK_ID }] } }
        : { status: 200, body: { records: [] } }) },
  ]);
  const request = async (path: string, method = 'GET', body?: any) => {
    if (method === 'DELETE') {
      deleted.add(path);
      return { status: 204, ok: true, body: null };
    }
    if (method === 'GET' && path.endsWith(`/sobjects/Task/${TASK_ID}`)) {
      return deleted.has(path)
        ? { status: 404, ok: false, body: { errorCode: 'NOT_FOUND' } }
        : { status: 200, ok: true, body: { Id: TASK_ID } };
    }
    return harness.request(path, method, body);
  };
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'task-record', ownerUserId: USER_ID, request, build: harness.build,
  });
  expect(posts[0].inputs[0].taskSubjectName).toMatch(/^AS probe /);
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema).toMatchObject({ verified: true, createdIds: [TASK_ID] });
  expect(outcome.cleanupError).toBeUndefined();
});

test('unverified cleanup flips verified false with a cleanup error', async () => {
  const route = std('createTask');
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [{ name: 'taskSubjectName', type: 'STRING', required: true }] } }) },
    { match: (method, path) => method === 'POST' && path === route,
      respond: () => ({ status: 200, body: ACCEPTED }) },
    { match: (method, path) => method === 'GET' && path.includes('/sobjects/Task/describe'),
      respond: () => describeFor('Task', [textField('Subject')]) },
    { match: (method, path) => method === 'GET' && path.includes('FROM Task WHERE Subject'),
      respond: () => ({ status: 200, body: { records: [{ Id: TASK_ID }] } }) },
    { match: (method) => method === 'DELETE', respond: () => ({ status: 204, body: null }) },
    // The record lingers after delete: absence never verifies.
    { match: (method, path) => method === 'GET' && path.endsWith(`/sobjects/Task/${TASK_ID}`),
      respond: () => ({ status: 200, body: { Id: TASK_ID } }) },
  ]);
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'task-record', request: harness.request, build: harness.build,
  });
  expect(outcome.status).toBe(200);
  expect(outcome.cleanupError).toContain('cleanup could not be verified');
  expect(outcome.contextSchema).toMatchObject({ verified: false });
});

test('unverified cleanup names the object and both statuses', async () => {
  const route = std('createTask');
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [{ name: 'taskSubjectName', type: 'STRING', required: true }] } }) },
    { match: (method, path) => method === 'POST' && path === route,
      respond: () => ({ status: 200, body: ACCEPTED }) },
    { match: (method, path) => method === 'GET' && path.includes('/sobjects/Task/describe'),
      respond: () => describeFor('Task', [textField('Subject')]) },
    { match: (method, path) => method === 'GET' && path.includes('FROM Task WHERE Subject'),
      respond: () => ({ status: 200, body: { records: [{ Id: TASK_ID }] } }) },
    { match: (method) => method === 'DELETE',
      respond: () => ({ status: 400, body: [{ errorCode: 'DELETE_FAILED', message: 'associated with cases' }] }) },
    { match: (method, path) => method === 'GET' && path.endsWith(`/sobjects/Task/${TASK_ID}`),
      respond: () => ({ status: 200, body: { Id: TASK_ID } }) },
  ]);
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'task-record', request: harness.request, build: harness.build,
  });
  expect(outcome.cleanupError).toContain('Task');
  expect(outcome.cleanupError).toContain('delete 400');
  expect(outcome.cleanupError).toContain('DELETE_FAILED');
  expect(outcome.cleanupError).toContain('associated with cases');
  expect(outcome.cleanupError).toContain('readback 200');
});

test('unresolvable required inputs fail closed and still clean owned fixtures', async () => {
  const route = std('convertRecord');
  const deleted = new Set<string>();
  let marker = '';
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [
        { name: 'sourceRecordId', type: 'STRING', required: true },
        { name: 'contextDefinitionId', type: 'STRING', required: true },
      ] } }) },
    { match: (method, path) => method === 'GET' && path.includes('FROM ContextDefinition'),
      respond: () => ({ status: 200, body: { records: [] } }) },
    { match: (method, path) => method === 'GET' && path.includes('/sobjects/Case/describe'),
      respond: () => describeFor('Case', [textField('Subject')]) },
    { match: (method, path) => method === 'POST' && path.endsWith('/sobjects/Case'),
      respond: () => ({ status: 201, body: { id: CASE_ID } }) },
    { match: (method, path) => method === 'GET' && path.includes('FROM Case WHERE Subject = '),
      respond: () => ({ status: 200, body: { records: [] } }) },
  ]);
  const request = async (path: string, method = 'GET', body?: any) => {
    if (method === 'DELETE') {
      deleted.add(path);
      harness.calls.push({ method, path, body });
      return { status: 204, ok: true, body: null };
    }
    if (method === 'GET' && path.endsWith(`/sobjects/Case/${CASE_ID}`)) {
      return deleted.has(path)
        ? { status: 404, ok: false, body: { errorCode: 'NOT_FOUND' } }
        : { status: 200, ok: true, body: { Id: CASE_ID, Subject: marker } };
    }
    return harness.request(path, method, body);
  };
  const build = async (_name: string, minted: string, values: Record<string, any>) => {
    marker = minted;
    return { values };
  };
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'record-convert', ownerUserId: USER_ID, request, build,
  });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('SKIPPED_STANDARD_RECORD_CONVERT_INPUT_UNRESOLVED');
  expect(outcome.body.setupRequirement).toContain('contextDefinitionId');
  expect(outcome.contextSchema).toMatchObject({ verified: false });
  expect(outcome.cleanupError).toBeUndefined();
  // The owned Case was still deleted with verified absence.
  expect(harness.calls.some((call) => call.method === 'DELETE' && call.path.endsWith(`/sobjects/Case/${CASE_ID}`))).toBe(true);
});

test('queue-routed fixtures are reclaimed to the execution user', async () => {
  const route = std('convertRecord');
  let marker = '';
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [
        { name: 'sourceRecordId', type: 'STRING', required: true },
        { name: 'contextDefinitionId', type: 'STRING', required: true },
      ] } }) },
    { match: (method, path) => method === 'GET' && path.includes('FROM ContextDefinition'),
      respond: () => ({ status: 200, body: { records: [] } }) },
    { match: (method, path) => method === 'GET' && path.includes('/sobjects/Case/describe'),
      respond: () => describeFor('Case', [textField('Subject')]) },
    { match: (method, path) => method === 'POST' && path.endsWith('/sobjects/Case'),
      respond: () => ({ status: 201, body: { id: CASE_ID } }) },
    { match: (method, path) => method === 'PATCH' && path.endsWith(`/sobjects/Case/${CASE_ID}`),
      respond: () => ({ status: 204, body: null }) },
  ]);
  let ownerId = QUEUE_ID;
  const request = async (path: string, method = 'GET', body?: any) => {
    if (method === 'PATCH' && path.endsWith(`/sobjects/Case/${CASE_ID}`) && typeof body?.OwnerId === 'string') {
      ownerId = body.OwnerId;
      return harness.request(path, method, body);
    }
    if (method === 'GET' && path.endsWith(`/sobjects/Case/${CASE_ID}`)) {
      return { status: 200, ok: true, body: { Id: CASE_ID, Subject: marker, OwnerId: ownerId, CreatedById: USER_ID } };
    }
    return harness.request(path, method, body);
  };
  const build = async (_name: string, minted: string, values: Record<string, any>) => {
    marker = minted;
    return { values };
  };
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'record-convert', ownerUserId: USER_ID, request, build,
  });
  const patches = harness.calls.filter((call) => call.method === 'PATCH');
  expect(patches).toHaveLength(1);
  expect(patches[0].body).toEqual({ OwnerId: USER_ID });
  // Reclaim succeeded, so the flow continued past fixtures to the (still missing) input.
  expect(outcome.body.errorCode).toBe('SKIPPED_STANDARD_RECORD_CONVERT_INPUT_UNRESOLVED');
});

test('unreclaimable queue fixtures fail before any invoke', async () => {
  const route = std('convertRecord');
  let marker = '';
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [
        { name: 'sourceRecordId', type: 'STRING', required: true },
        { name: 'contextDefinitionId', type: 'STRING', required: true },
      ] } }) },
    { match: (method, path) => method === 'GET' && path.includes('FROM ContextDefinition'),
      respond: () => ({ status: 200, body: { records: [] } }) },
    { match: (method, path) => method === 'GET' && path.includes('/sobjects/Case/describe'),
      respond: () => describeFor('Case', [textField('Subject')]) },
    { match: (method, path) => method === 'POST' && path.endsWith('/sobjects/Case'),
      respond: () => ({ status: 201, body: { id: CASE_ID } }) },
    { match: (method) => method === 'PATCH',
      respond: () => ({ status: 403, body: [{ errorCode: 'INSUFFICIENT_ACCESS' }] }) },
  ]);
  const request = async (path: string, method = 'GET', body?: any) => {
    if (method === 'GET' && path.endsWith(`/sobjects/Case/${CASE_ID}`)) {
      return { status: 200, ok: true, body: { Id: CASE_ID, Subject: marker, OwnerId: QUEUE_ID, CreatedById: USER_ID } };
    }
    return harness.request(path, method, body);
  };
  const build = async (_name: string, minted: string, values: Record<string, any>) => {
    marker = minted;
    return { values };
  };
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'record-convert', ownerUserId: USER_ID, request, build,
  });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('SKIPPED_STANDARD_RECORD_CONVERT_FIXTURE_UNAVAILABLE');
  expect(outcome.body.message).toContain('queue');
  expect(harness.calls.some((call) => call.method === 'POST' && call.path === route)).toBe(false);
});

test('sendChannelMessage mints no fixtures', () => {
  expect(skippedStandardFixtures('message-send', 'sendChannelMessage')).toEqual([]);
  expect(skippedStandardFixtures('message-send', 'sendNotificationX').map((plan) => plan.objects)).toEqual([['Contact'], ['Case']]);
});

test('survey invitations verify the invitation row and clean everything', async () => {
  const route = `${ROOT}/actions/custom/dynamicSendSurveyInvitation/case_csat_nps_survey`;
  const posts: any[] = [];
  const markers: Record<string, string> = {};
  const deleted = new Set<string>();
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [
        { name: 'recipient', type: 'STRING', required: true },
        { name: 'surveySubjectEntity', type: 'STRING', required: false },
      ] } }) },
    { match: (method, path) => method === 'GET' && path.includes('/sobjects/Contact/describe'),
      respond: () => describeFor('Contact', [textField('LastName')]) },
    { match: (method, path) => method === 'GET' && path.includes('/sobjects/Case/describe'),
      respond: () => describeFor('Case', [textField('Subject')]) },
    { match: (method, path) => method === 'POST' && path.endsWith('/sobjects/Contact'),
      respond: () => ({ status: 201, body: { id: CONTACT_ID } }) },
    { match: (method, path) => method === 'POST' && path.endsWith('/sobjects/Case'),
      respond: () => ({ status: 201, body: { id: CASE_ID } }) },
    { match: (method, path) => method === 'POST' && path === route,
      respond: (_m, _p, body) => {
        posts.push(body);
        return { status: 200, body: ACCEPTED };
      } },
    { match: (method, path) => method === 'GET' && path.includes('/sobjects/SurveyInvitation/describe'),
      respond: () => ({ status: 200, body: { name: 'SurveyInvitation', createable: true, queryable: true, deletable: true, fields: [
        { name: 'RecipientId', type: 'reference', createable: false, filterable: true },
        { name: 'SubjectId', type: 'reference', createable: false, filterable: true },
      ] } }) },
    { match: (method, path) => method === 'GET' && path.includes('FROM SurveyInvitation WHERE'),
      respond: () => ({ status: 200, body: { records: [{ Id: '0Kd000000000001EAA' }] } }) },
    { match: (method, path) => method === 'GET' && path.includes('/query?'),
      respond: () => ({ status: 200, body: { records: [] } }) },
  ]);
  const request = async (path: string, method = 'GET', body?: any) => {
    if (method === 'DELETE') {
      deleted.add(path);
      harness.calls.push({ method, path, body });
      return { status: 204, ok: true, body: null };
    }
    if (method === 'GET' && path.endsWith(`/sobjects/Contact/${CONTACT_ID}`)) {
      return deleted.has(path)
        ? { status: 404, ok: false, body: { errorCode: 'NOT_FOUND' } }
        : { status: 200, ok: true, body: { Id: CONTACT_ID, LastName: markers.Contact } };
    }
    if (method === 'GET' && path.endsWith(`/sobjects/Case/${CASE_ID}`)) {
      return deleted.has(path)
        ? { status: 404, ok: false, body: { errorCode: 'NOT_FOUND' } }
        : { status: 200, ok: true, body: { Id: CASE_ID, Subject: markers.Case } };
    }
    if (method === 'GET' && /\/sobjects\/[A-Za-z0-9_]+\/[A-Za-z0-9]{15,18}$/.test(path)) {
      return { status: 404, ok: false, body: { errorCode: 'NOT_FOUND' } };
    }
    return harness.request(path, method, body);
  };
  const build = async (name: string, marker: string, values: Record<string, any>) => {
    markers[name] = marker;
    return { values };
  };
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'survey-invitation', ownerUserId: USER_ID, request, build,
  });
  expect(posts[0].inputs[0]).toMatchObject({ recipient: CONTACT_ID, surveySubjectEntity: CASE_ID });
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema).toMatchObject({ verified: true });
  expect(outcome.cleanupError).toBeUndefined();
  expect(harness.calls.some((call) => call.method === 'DELETE' && call.path.includes('0Kd000000000001EAA'))).toBe(true);
});

test('notify-user delivery addresses the live integration user', async () => {
  const route = std('notifyUser');
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [{ name: 'userId', type: 'STRING', required: true }] } }) },
    { match: (method, path) => method === 'POST' && path === route,
      respond: (_m, _p, body) => {
        expect(body.inputs[0]).toEqual({ userId: USER_ID });
        return { status: 200, body: ACCEPTED };
      } },
  ]);
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'message-send', ownerUserId: USER_ID, request: harness.request, build: harness.build,
  });
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema).toMatchObject({ verified: true });
});

test('skipped-standard builder version stays above the reselect floor', () => {
  expect(Number.isInteger(SKIPPED_STANDARD_BUILDER_VERSION)).toBe(true);
  expect(SKIPPED_STANDARD_BUILDER_VERSION).toBeGreaterThan(125);
});

test('required fixture references seed from live lookups for case actions', async () => {
  const route = std('applyCaseClassificationRecommendations');
  const LIVE_HOURS = '01m000000000001AAA';
  const deleted = new Set<string>();
  let marker = '';
  let posted: Record<string, any> = {};
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [{ name: 'caseId', type: 'ID', required: true }] } }) },
    { match: (method, path) => method === 'POST' && path === route,
      respond: (_m, _p, body) => {
        expect(body.inputs[0]).toEqual({ caseId: CASE_ID });
        return { status: 200, body: ACCEPTED };
      } },
    { match: (method, path) => method === 'GET' && path.includes('/sobjects/Case/describe'),
      respond: () => describeFor('Case', [
        { name: 'Subject', type: 'string', createable: true, filterable: true, nillable: true, length: 255 },
        { name: 'BusinessHoursId', type: 'reference', createable: true, nillable: false, defaultedOnCreate: false, referenceTo: ['BusinessHours'] },
      ]) },
    { match: (method, path) => method === 'GET' && path.includes('FROM BusinessHours'),
      respond: () => ({ status: 200, body: { records: [{ Id: LIVE_HOURS }] } }) },
    { match: (method, path) => method === 'POST' && path.endsWith('/sobjects/Case'),
      respond: (_m, _p, body) => {
        posted = body;
        marker = body.Subject;
        return { status: 201, body: { id: CASE_ID } };
      } },
    { match: (method, path) => method === 'GET' && path.includes('/query?'),
      respond: () => ({ status: 200, body: { records: [] } }) },
  ]);
  const request = async (path: string, method = 'GET', body?: any) => {
    if (method === 'DELETE') {
      deleted.add(path);
      harness.calls.push({ method, path, body });
      return { status: 204, ok: true, body: null };
    }
    if (method === 'GET' && path.endsWith(`/sobjects/Case/${CASE_ID}`)) {
      return deleted.has(path)
        ? { status: 404, ok: false, body: { errorCode: 'NOT_FOUND' } }
        : { status: 200, ok: true, body: { Id: CASE_ID, Subject: marker } };
    }
    return harness.request(path, method, body);
  };
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'case-action', ownerUserId: USER_ID, request, build: harness.build,
  });
  // The borrowed setup row satisfies the platform FK check; the unique
  // marker still proves ownership of the created fixture.
  expect(posted.BusinessHoursId).toBe(LIVE_HOURS);
  expect(posted.Subject).toMatch(/^AS probe /);
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema).toMatchObject({ verified: true });
  expect(outcome.cleanupError).toBeUndefined();
});

test('fixture OwnerId pins to the execution identity instead of a borrowed user', async () => {
  const route = std('editVisualization');
  const VIZ_ID = '0V1000000000001EAA';
  const deleted = new Set<string>();
  let marker = '';
  let posted: Record<string, any> = {};
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [{ name: 'visualizationId', type: 'ID', required: true }] } }) },
    { match: (method, path) => method === 'POST' && path === route,
      respond: (_m, _p, body) => {
        expect(body.inputs[0]).toEqual({ visualizationId: VIZ_ID });
        return { status: 200, body: ACCEPTED };
      } },
    { match: (method, path) => method === 'GET' && path.includes('/sobjects/AnalyticsVisualization/describe'),
      respond: () => describeFor('AnalyticsVisualization', [
        { name: 'MasterLabel', type: 'string', createable: true, filterable: true, nillable: true, length: 80 },
        { name: 'OwnerId', type: 'reference', createable: true, nillable: false, defaultedOnCreate: false, referenceTo: ['User'] },
      ]) },
    { match: (method, path) => method === 'GET' && path.includes('FROM User'),
      respond: () => ({ status: 200, body: { records: [{ Id: '005000000000009AAA' }] } }) },
    { match: (method, path) => method === 'POST' && path.endsWith('/sobjects/AnalyticsVisualization'),
      respond: (_m, _p, body) => {
        posted = body;
        marker = body.MasterLabel;
        return { status: 201, body: { id: VIZ_ID } };
      } },
    { match: (method, path) => method === 'GET' && path.includes('/query?'),
      respond: () => ({ status: 200, body: { records: [] } }) },
  ]);
  const request = async (path: string, method = 'GET', body?: any) => {
    if (method === 'DELETE') {
      deleted.add(path);
      harness.calls.push({ method, path, body });
      return { status: 204, ok: true, body: null };
    }
    if (method === 'GET' && path.endsWith(`/sobjects/AnalyticsVisualization/${VIZ_ID}`)) {
      return deleted.has(path)
        ? { status: 404, ok: false, body: { errorCode: 'NOT_FOUND' } }
        : { status: 200, ok: true, body: { Id: VIZ_ID, MasterLabel: marker } };
    }
    return harness.request(path, method, body);
  };
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'visualization', ownerUserId: USER_ID, request, build: harness.build,
  });
  expect(posted.OwnerId).toBe(USER_ID);
  expect(posted.OwnerId).not.toBe('005000000000009AAA');
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema).toMatchObject({ verified: true });
  expect(outcome.cleanupError).toBeUndefined();
});

test('scalecenter window is recomputed from the live clock within platform rules', () => {
  const now = Date.parse('2026-10-06T12:00:00.000Z');
  expect(scaleCenterWindowNow(now)).toBe('2026-10-06T11:45:00.000Z/2026-10-06T12:00:00.000Z');
  const planned = planSkippedStandardArgs(skippedStandardBindingSpec('scalecenter-request', 'createScaleCenterInvReq'), [
    { name: 'dateTimeRange', type: 'STRING', required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: {} });
  expect('args' in planned).toBe(true);
  const window = (planned as { args: Record<string, unknown> }).args.dateTimeRange as string;
  const [start, end] = window.split('/');
  const spanMs = Date.parse(end) - Date.parse(start);
  expect(spanMs).toBe(15 * 60 * 1000);
  expect(Date.now() - Date.parse(start)).toBeLessThan(30 * 24 * 60 * 60 * 1000);
  expect(Date.parse(end)).toBeLessThanOrEqual(Date.now() + 60 * 1000);
});

test('member-verification discovers the live process definition name', () => {
  const discoveries = skippedStandardDiscoveries('member-verification', 'buildIdentityVerification');
  expect(discoveries.map((entry) => entry.key)).toEqual(['processDefinition']);
  const planned = planSkippedStandardArgs(skippedStandardBindingSpec('member-verification', 'buildIdentityVerification'), [
    { name: 'processDefinitionName', type: 'STRING', required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: { processDefinition: 'Live_Definition' } });
  expect(planned).toEqual({ args: { processDefinitionName: 'Live_Definition' } });
  const missing = planSkippedStandardArgs(skippedStandardBindingSpec('member-verification', 'buildIdentityVerification'), [
    { name: 'processDefinitionName', type: 'STRING', required: true },
  ], { marker: 'AS probe m', fixtures: {}, discovered: {} });
  expect(missing).toEqual({ missing: 'processDefinitionName' });
});

test('expired context namespaces match only the platform shape', () => {
  expect(contextNamespaceExpired([
    { message: "Context with id ASCTX-9ad0cad7 doesn't exist or expired.", errorCode: 'RECORD_NOT_FOUND' },
  ])).toBe(true);
  expect(contextNamespaceExpired([{ message: 'something failed', errorCode: 'RECORD_NOT_FOUND' }])).toBe(false);
  expect(contextNamespaceExpired([{ message: "Context doesn't exist or expired.", errorCode: 'INVALID_INPUT' }])).toBe(false);
  expect(contextNamespaceExpired(null)).toBe(false);
});

test('expired context namespaces fail setup-blocked with a requirement', async () => {
  const route = std('addContextRecords');
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [
        { name: 'contextId', type: 'STRING', required: true },
        { name: 'inputData', type: 'STRING', required: true },
      ] } }) },
    { match: (method, path) => method === 'POST' && path === route,
      respond: () => ({ status: 400, body: [
        { message: "Context with id ASCTX-x doesn't exist or expired.", errorCode: 'RECORD_NOT_FOUND' },
      ] }) },
  ]);
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'context-record', ownerUserId: USER_ID, request: harness.request, build: harness.build,
  });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('SKIPPED_STANDARD_CONTEXT_RECORD_SETUP_REQUIRED');
  expect(outcome.body.setupRequirement).toContain('context namespace');
  expect(outcome.contextSchema).toMatchObject({ verified: false });
});

test('native denial outcomes attach a planner-only grant family', async () => {
  const route = std('notifyUser');
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [{ name: 'userId', type: 'STRING', required: true }] } }) },
    { match: (method, path) => method === 'POST' && path === route,
      respond: () => ({ status: 400, body: [
        { message: "Looks like you don't have access to this feature. Your Salesforce admin can help with that.", errorCode: 'FEATURE_ACCESS_REQUIRED' },
      ] }) },
  ]);
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'message-send', ownerUserId: USER_ID, request: harness.request, build: harness.build,
  });
  expect(outcome.status).toBe(400);
  expect(outcome.denialGrant?.family).toBe('feature-access');
  expect(outcome.contextSchema).toMatchObject({ denialGrant: { family: 'feature-access' } });
});

test('non-denial failures attach no grant family', async () => {
  const route = std('notifyUser');
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [{ name: 'userId', type: 'STRING', required: true }] } }) },
    { match: (method, path) => method === 'POST' && path === route,
      respond: () => ({ status: 400, body: [{ message: 'entity is deleted', errorCode: 'ENTITY_IS_DELETED' }] }) },
  ]);
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'message-send', ownerUserId: USER_ID, request: harness.request, build: harness.build,
  });
  expect(outcome.status).toBe(400);
  expect(outcome.denialGrant).toBeUndefined();
  expect(outcome.contextSchema).not.toHaveProperty('denialGrant');
});

// ---------------------------------------------------------------------------
// R7 skip-exempt wave: apex shapes, dynamic twins, batch, unownable standards.
// ---------------------------------------------------------------------------

const apex = (name: string) => `${ROOT}/actions/custom/apex/${name}`;
const batch = (name: string) => `${ROOT}/actions/custom/batchJobAction/${name}`;
const dyn = (kind: string, name: string) => `${ROOT}/actions/custom/${kind}/${name}`;

test('r7 family slugs validate and terminal codes carry the family', () => {
  for (const family of ['social-publish', 'appointment-save', 'routing-verify', 'context-dynamic',
    'batch-submit', 'apex-sobject-shape', 'apex-scalar-pure', 'apex-external-callout']) {
    expect(skippedStandardFamilySlug(family)).toBe(family);
  }
  expect(skippedStandardCode('apex-scalar-pure', 'effect_dml_unownable'))
    .toBe('SKIPPED_STANDARD_APEX_SCALAR_PURE_EFFECT_DML_UNOWNABLE');
  expect(skippedStandardCode('batch-submit', 'unownable')).toBe('SKIPPED_STANDARD_BATCH_SUBMIT_UNOWNABLE');
  expect(skippedStandardCode('context-dynamic', 'input_unresolved'))
    .toBe('SKIPPED_STANDARD_CONTEXT_DYNAMIC_INPUT_UNRESOLVED');
});

test('r7 terminal refusals carry precise codes and never POST', async () => {
  const rows = [
    [std('createSocialPost'), 'social-publish', 'SKIPPED_STANDARD_SOCIAL_PUBLISH_UNOWNABLE'],
    [std('saveAppointment'), 'appointment-save', 'SKIPPED_STANDARD_APPOINTMENT_SAVE_INPUT_UNRESOLVED'],
    [std('routingAddressVerification'), 'routing-verify', 'SKIPPED_STANDARD_ROUTING_VERIFY_UNOWNABLE'],
    [batch('inv_replenishment__ReplenishInventory'), 'batch-submit', 'SKIPPED_STANDARD_BATCH_SUBMIT_UNOWNABLE'],
    [apex('pi__CreateForm'), 'apex-external-callout', 'SKIPPED_STANDARD_APEX_EXTERNAL_CALLOUT_UNOWNABLE'],
    [std('updateAssetWithActivity'), 'asset-activity', 'SKIPPED_STANDARD_ASSET_ACTIVITY_INPUT_UNRESOLVED'],
    [std('createAssetWithActivity'), 'asset-activity', 'SKIPPED_STANDARD_ASSET_ACTIVITY_INPUT_UNRESOLVED'],
  ] as const;
  for (const [route, family, code] of rows) {
    const harness = scripted([
      { match: (method, path) => method === 'GET' && path === route,
        respond: () => ({ status: 200, body: { inputs: [] } }) },
    ]);
    const outcome = await invokeSkippedStandardWithOwnedContext({
      root: ROOT, route, family, ownerUserId: USER_ID, request: harness.request, build: harness.build,
    });
    expect(outcome.status).toBe(422);
    expect(outcome.body.errorCode).toBe(code);
    expect(outcome.body.setupRequirement).toBeTruthy();
    expect(harness.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(outcome.contextSchema).toMatchObject({ verified: false, family });
    expect(outcome.cleanupError).toBeUndefined();
  }
});

test('r7 route kinds gate their families without touching existing pairs', async () => {
  const harness = scripted([]);
  const mismatches = [
    [apex('SDO_Service_BotsUpdateEmail'), 'task-record'],
    [std('createTask'), 'apex-sobject-shape'],
    [std('createTask'), 'batch-submit'],
    [std('createTask'), 'context-dynamic'],
    [batch('x'), 'task-record'],
    [dyn('buildContextDynamic', 'x'), 'task-record'],
    [apex('x'), 'context-dynamic'],
  ] as const;
  for (const [route, family] of mismatches) {
    const outcome = await invokeSkippedStandardWithOwnedContext({
      root: ROOT, route, family, request: harness.request, build: harness.build,
    });
    expect(outcome.body.errorCode).toContain('FAMILY_MISMATCH');
  }
  expect(harness.calls.length).toBe(0);
  // Existing cross-kind pairs still route: survey runs on standard routes.
  expect(skippedStandardRouteInfo(std('sendSurveyInvitation'))?.kind).toBe('standard');
});

const BUILD_OUTPUT = [{ isSuccess: true, errors: [], outputValues: {
  contextId: 'CTX00000000000000000000000001', contextMappingId: 'def/version/map', contextDefinitionId: 'def',
} }];

test('dynamic build verifies the minted namespace and deletes it', async () => {
  const route = dyn('buildContextDynamic', 'build_context_x');
  const posts: any[] = [];
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [
        { name: 'contextMappingId', type: 'STRING', required: false },
        { name: 'contextRecordData', type: null, required: false },
      ] } }) },
    { match: (method, path) => method === 'POST' && path === route,
      respond: (_m, _p, body) => {
        posts.push(body);
        return { status: 200, body: BUILD_OUTPUT };
      } },
    { match: (method, path) => method === 'POST' && path.endsWith('/actions/standard/deleteContextCache'),
      respond: () => ({ status: 200, body: ACCEPTED }) },
  ]);
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'context-dynamic', request: harness.request, build: harness.build,
  });
  expect(posts[0]).toEqual({ inputs: [{}] });
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema).toMatchObject({ verified: true, contextId: 'CTX00000000000000000000000001' });
  expect(outcome.cleanupError).toBeUndefined();
});

test('dynamic build treats never-persisted namespaces as clean', async () => {
  const route = dyn('buildContextDynamic', 'build_context_x');
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [] } }) },
    { match: (method, path) => method === 'POST' && path === route,
      respond: () => ({ status: 200, body: BUILD_OUTPUT }) },
    { match: (method, path) => method === 'POST' && path.endsWith('/actions/standard/deleteContextCache'),
      respond: () => ({ status: 400, body: [
        { message: "Context with id CTX00000000000000000000000001 doesn't exist or expired.", errorCode: 'DELETE_FAILED' },
      ] }) },
  ]);
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'context-dynamic', request: harness.request, build: harness.build,
  });
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema).toMatchObject({ verified: true });
  expect(outcome.cleanupError).toBeUndefined();
});

test('dynamic build with unverifiable cleanup flips verified false', async () => {
  const route = dyn('buildContextDynamic', 'build_context_x');
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [] } }) },
    { match: (method, path) => method === 'POST' && path === route,
      respond: () => ({ status: 200, body: BUILD_OUTPUT }) },
    { match: (method, path) => method === 'POST' && path.endsWith('/actions/standard/deleteContextCache'),
      respond: () => ({ status: 400, body: [{ message: 'boom', errorCode: 'UNKNOWN_EXCEPTION' }] }) },
  ]);
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'context-dynamic', request: harness.request, build: harness.build,
  });
  expect(outcome.status).toBe(200);
  expect(outcome.cleanupError).toContain('cleanup could not be verified');
  expect(outcome.contextSchema).toMatchObject({ verified: false });
});

test('dynamic non-build twins refuse without any POST', async () => {
  for (const kind of ['addContextRecordsDynamic', 'queryContextRecordsDynamic', 'queryContextTagsDynamic', 'updateContextAttributesDynamic']) {
    const route = dyn(kind, 'twin_x');
    const harness = scripted([
      { match: (method, path) => method === 'GET' && path === route,
        respond: () => ({ status: 200, body: { inputs: [
          { name: 'contextId', type: 'STRING', required: true },
          { name: 'contextRecordData', type: null, required: true },
        ] } }) },
    ]);
    const outcome = await invokeSkippedStandardWithOwnedContext({
      root: ROOT, route, family: 'context-dynamic', request: harness.request, build: harness.build,
    });
    expect(outcome.status).toBe(422);
    expect(outcome.body.errorCode).toBe('SKIPPED_STANDARD_CONTEXT_DYNAMIC_INPUT_UNRESOLVED');
    expect(outcome.body.setupRequirement).toContain('context-definition contract');
    expect(harness.calls.some((call) => call.method === 'POST')).toBe(false);
  }
});

test('sobject-shape updates verify the effect and prove no user side-effect', async () => {
  const route = apex('SDO_Service_BotsUpdateEmail');
  const deleted = new Set<string>();
  let marker = '';
  let postedEmail = '';
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [
        { name: 'objContact', type: 'SOBJECT', required: true, sObjectType: 'Contact' },
        { name: 'value', type: 'STRING', required: true },
      ] } }) },
    { match: (method, path) => method === 'GET' && path.includes('/sobjects/Contact/describe'),
      respond: () => describeFor('Contact', [textField('LastName'), textField('Email')]) },
    { match: (method, path) => method === 'POST' && path.endsWith('/sobjects/Contact'),
      respond: (_m, _p, body) => {
        marker = body.LastName;
        return { status: 201, body: { id: CONTACT_ID } };
      } },
    { match: (method, path) => method === 'POST' && path === route,
      respond: (_m, _p, body) => {
        const input = body.inputs[0];
        expect(input.objContact).toEqual({ attributes: { type: 'Contact' }, Id: CONTACT_ID });
        postedEmail = input.value;
        expect(postedEmail).toMatch(/^probe-[a-z0-9]+@example\.invalid$/);
        return { status: 200, body: [{ isSuccess: true, errors: [], outputValues: { output: { Id: CONTACT_ID } } }] };
      } },
    { match: (method, path) => method === 'GET' && path.includes('FROM User WHERE ContactId'),
      respond: () => ({ status: 200, body: { records: [] } }) },
    { match: (method, path) => method === 'GET' && path.includes('/query?'),
      respond: () => ({ status: 200, body: { records: [] } }) },
  ]);
  let invoked = false;
  const request = async (path: string, method = 'GET', body?: any) => {
    if (method === 'POST' && path === route) invoked = true;
    if (method === 'DELETE') {
      deleted.add(path);
      harness.calls.push({ method, path, body });
      return { status: 204, ok: true, body: null };
    }
    if (method === 'GET' && path.endsWith(`/sobjects/Contact/${CONTACT_ID}`)) {
      if (deleted.has(path)) return { status: 404, ok: false, body: { errorCode: 'NOT_FOUND' } };
      return { status: 200, ok: true, body: invoked
        ? { Id: CONTACT_ID, LastName: marker, Email: postedEmail }
        : { Id: CONTACT_ID, LastName: marker, Email: 'placeholder@example.invalid' } };
    }
    return harness.request(path, method, body);
  };
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'apex-sobject-shape', ownerUserId: USER_ID, request, build: harness.build,
  });
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema).toMatchObject({ verified: true, effectField: 'Email', userClean: true, object: 'Contact' });
  expect(outcome.cleanupError).toBeUndefined();
  expect(harness.calls.some((call) => call.method === 'DELETE' && call.path.endsWith(`/sobjects/Contact/${CONTACT_ID}`))).toBe(true);
});

test('sobject-shape without a landed effect stays unverified', async () => {
  const route = apex('SDO_Service_BotsUpdateEmail');
  const deleted = new Set<string>();
  let marker = '';
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [
        { name: 'objContact', type: 'SOBJECT', required: true, sObjectType: 'Contact' },
        { name: 'value', type: 'STRING', required: true },
      ] } }) },
    { match: (method, path) => method === 'GET' && path.includes('/sobjects/Contact/describe'),
      respond: () => describeFor('Contact', [textField('LastName')]) },
    { match: (method, path) => method === 'POST' && path.endsWith('/sobjects/Contact'),
      respond: (_m, _p, body) => {
        marker = body.LastName;
        return { status: 201, body: { id: CONTACT_ID } };
      } },
    { match: (method, path) => method === 'POST' && path === route,
      respond: () => ({ status: 200, body: ACCEPTED }) },
    { match: (method, path) => method === 'GET' && path.includes('FROM User WHERE ContactId'),
      respond: () => ({ status: 200, body: { records: [] } }) },
    { match: (method, path) => method === 'GET' && path.includes('/query?'),
      respond: () => ({ status: 200, body: { records: [] } }) },
  ]);
  const request = async (path: string, method = 'GET', body?: any) => {
    if (method === 'DELETE') {
      deleted.add(path);
      harness.calls.push({ method, path, body });
      return { status: 204, ok: true, body: null };
    }
    if (method === 'GET' && path.endsWith(`/sobjects/Contact/${CONTACT_ID}`)) {
      if (deleted.has(path)) return { status: 404, ok: false, body: { errorCode: 'NOT_FOUND' } };
      return { status: 200, ok: true, body: { Id: CONTACT_ID, LastName: marker, Email: 'placeholder@example.invalid' } };
    }
    return harness.request(path, method, body);
  };
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'apex-sobject-shape', ownerUserId: USER_ID, request, build: harness.build,
  });
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema).toMatchObject({ verified: false });
  expect(outcome.cleanupError).toBeUndefined();
});

test('sobject-shape reclaims queue-routed fixtures before invoke', async () => {
  const route = apex('SDO_Service_BotsUpdateCaseSubject');
  let marker = '';
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [
        { name: 'objCase', type: 'SOBJECT', required: true, sObjectType: 'Case' },
        { name: 'value', type: 'STRING', required: true },
      ] } }) },
    { match: (method, path) => method === 'GET' && path.includes('/sobjects/Case/describe'),
      respond: () => describeFor('Case', [textField('Subject')]) },
    { match: (method, path) => method === 'POST' && path.endsWith('/sobjects/Case'),
      respond: (_m, _p, body) => {
        marker = body.Subject;
        return { status: 201, body: { id: CASE_ID } };
      } },
    { match: (method) => method === 'PATCH',
      respond: () => ({ status: 204, body: null }) },
    { match: (method, path) => method === 'POST' && path === route,
      respond: () => ({ status: 200, body: ACCEPTED }) },
    { match: (method, path) => method === 'GET' && path.includes('/query?'),
      respond: () => ({ status: 200, body: { records: [] } }) },
  ]);
  let ownerId = QUEUE_ID;
  const request = async (path: string, method = 'GET', body?: any) => {
    if (method === 'PATCH' && path.endsWith(`/sobjects/Case/${CASE_ID}`) && typeof body?.OwnerId === 'string') {
      ownerId = body.OwnerId;
      return harness.request(path, method, body);
    }
    if (method === 'GET' && path.endsWith(`/sobjects/Case/${CASE_ID}`)) {
      return { status: 200, ok: true, body: { Id: CASE_ID, Subject: marker, OwnerId: ownerId, CreatedById: USER_ID } };
    }
    return harness.request(path, method, body);
  };
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'apex-sobject-shape', ownerUserId: USER_ID, request, build: harness.build,
  });
  const patches = harness.calls.filter((call) => call.method === 'PATCH');
  expect(patches).toHaveLength(1);
  expect(patches[0].body).toEqual({ OwnerId: USER_ID });
  expect(outcome.status).toBe(200);
  expect(outcome.body.errorCode ?? null).toBeNull();
});

test('sobject-shape refuses callout contracts and bad shapes before any fixture', async () => {
  const callout = apex('pi__CreateListMembership');
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === callout,
      respond: () => ({ status: 200, body: { inputs: [
        { name: 'businessUnitId', type: 'STRING', required: true },
        { name: 'namedCredential', type: 'STRING', required: true },
      ] } }) },
  ]);
  const refused = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route: callout, family: 'apex-sobject-shape', request: harness.request, build: harness.build,
  });
  expect(refused.status).toBe(422);
  expect(refused.body.errorCode).toBe('SKIPPED_STANDARD_APEX_SOBJECT_SHAPE_UNOWNABLE');
  expect(harness.calls.some((call) => call.method === 'POST')).toBe(false);

  const noshape = apex('SomethingElse');
  const harness2 = scripted([
    { match: (method, path) => method === 'GET' && path === noshape,
      respond: () => ({ status: 200, body: { inputs: [
        { name: 'record', type: 'SOBJECT', required: true },
      ] } }) },
  ]);
  const missed = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route: noshape, family: 'apex-sobject-shape', request: harness2.request, build: harness2.build,
  });
  expect(missed.status).toBe(422);
  expect(missed.body.errorCode).toBe('SKIPPED_STANDARD_APEX_SOBJECT_SHAPE_INPUT_UNRESOLVED');
  expect(harness2.calls.some((call) => call.method === 'POST')).toBe(false);
});

const PURE_CLASS_BODY = `public with sharing class SDO_Service_ConvertToStringCollection {
  @invocableMethod(label='Convert')
  public static List<Response> execute(List<Request> requests) {
    return new List<Response>();
  }
}`;

test('scalar-pure invokes screened bodies and requires answered outputs', async () => {
  const route = apex('SDO_Service_ConvertToStringCollection');
  const posts: any[] = [];
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [
        { name: 'delimiter', type: 'STRING', required: true },
        { name: 'initialString', type: 'STRING', required: true },
      ] } }) },
    { match: (method, path) => method === 'GET' && path.includes('FROM ApexClass'),
      respond: () => ({ status: 200, body: { records: [{ Body: PURE_CLASS_BODY }] } }) },
    { match: (method, path) => method === 'POST' && path === route,
      respond: (_m, _p, body) => {
        posts.push(body);
        return { status: 200, body: [{ isSuccess: true, errors: [], outputValues: { stringCollection: ['a', 'b'] } }] };
      } },
  ]);
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'apex-scalar-pure', request: harness.request, build: harness.build,
  });
  expect(posts[0].inputs[0].delimiter).toMatch(/^AS probe /);
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema).toMatchObject({ verified: true, outputs: ['stringCollection'] });
  expect(outcome.cleanupError).toBeUndefined();
  expect(harness.calls.some((call) => call.path.includes('/sobjects/'))).toBe(false);
});

test('scalar-pure refuses every screened effect class without invoking', async () => {
  const bodies = [
    ['update toUpdate;', 'SKIPPED_STANDARD_APEX_SCALAR_PURE_EFFECT_DML_UNOWNABLE'],
    ['Http h = new Http();', 'SKIPPED_STANDARD_APEX_SCALAR_PURE_EFFECT_CALLOUT_UNOWNABLE'],
    ['Messaging.sendEmail(m);', 'SKIPPED_STANDARD_APEX_SCALAR_PURE_EFFECT_SEND_UNOWNABLE'],
    ['System.enqueueJob(q);', 'SKIPPED_STANDARD_APEX_SCALAR_PURE_EFFECT_ASYNC_UNOWNABLE'],
    ["/* This file is generated and isn't the actual source code */", 'SKIPPED_STANDARD_APEX_SCALAR_PURE_BODY_UNVERIFIABLE'],
  ] as const;
  for (const [snippet, code] of bodies) {
    const route = apex('SomeAction');
    const harness = scripted([
      { match: (method, path) => method === 'GET' && path === route,
        respond: () => ({ status: 200, body: { inputs: [{ name: 'value', type: 'STRING', required: true }] } }) },
      { match: (method, path) => method === 'GET' && path.includes('FROM ApexClass'),
        respond: () => ({ status: 200, body: { records: [{ Body: `public class C { @InvocableMethod public static void m() { ${snippet} } }` }] } }) },
    ]);
    const outcome = await invokeSkippedStandardWithOwnedContext({
      root: ROOT, route, family: 'apex-scalar-pure', request: harness.request, build: harness.build,
    });
    expect(outcome.status).toBe(422);
    expect(outcome.body.errorCode).toBe(code);
    expect(harness.calls.some((call) => call.method === 'POST' && call.path === route)).toBe(false);
  }
});

test('scalar-pure stays unverified on empty or nested-flagged outputs', async () => {
  for (const outputValues of [{}, { isSuccess: false }]) {
    const route = apex('SDO_Service_ConvertToStringCollection');
    const harness = scripted([
      { match: (method, path) => method === 'GET' && path === route,
        respond: () => ({ status: 200, body: { inputs: [{ name: 'delimiter', type: 'STRING', required: true }] } }) },
      { match: (method, path) => method === 'GET' && path.includes('FROM ApexClass'),
        respond: () => ({ status: 200, body: { records: [{ Body: PURE_CLASS_BODY }] } }) },
      { match: (method, path) => method === 'POST' && path === route,
        respond: () => ({ status: 200, body: [{ isSuccess: true, errors: [], outputValues }] }) },
    ]);
    const outcome = await invokeSkippedStandardWithOwnedContext({
      root: ROOT, route, family: 'apex-scalar-pure', request: harness.request, build: harness.build,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.contextSchema).toMatchObject({ verified: false });
  }
});

test('r7 builder version stays above every taken version', () => {
  expect(SKIPPED_STANDARD_BUILDER_VERSION).toBeGreaterThan(137);
  expect(SKIPPED_STANDARD_BUILDER_VERSION).toBeGreaterThan(140);
  expect(SKIPPED_STANDARD_BUILDER_VERSION).toBeGreaterThan(141);
});

// ---------------------------------------------------------------------------
// ServiceAppointment engine completion + scheduling-substrate terminal.
// ---------------------------------------------------------------------------

const SA_ID = '08p000000000001EAA';
const WO_ID = '0WO000000000001EAA';
const TERR_ID = '0Hh000000000001EAA';
const TERR_FALLBACK_ID = '0Hh000000000002EAA';
const WT_ID = '08q000000000001EAA';
const POLICY_ID = 'a3M000000000001EAA';
const FSL_RES_ID = '0Hn000000000001EAA';

const refField = (name: string, referenceTo: string[]): Record<string, any> =>
  ({ name, type: 'reference', createable: true, filterable: true, nillable: true, referenceTo });
const dtField = (name: string): Record<string, any> =>
  ({ name, type: 'datetime', createable: true, filterable: true, nillable: true });
const numField = (name: string): Record<string, any> =>
  ({ name, type: 'double', createable: true, filterable: true, nillable: true });

const SA_DESCRIBE = () => describeFor('ServiceAppointment', [
  textField('Subject'), refField('ParentRecordId', ['WorkOrder']), refField('ServiceTerritoryId', ['ServiceTerritory']),
  refField('WorkTypeId', ['WorkType']), numField('Duration'), dtField('EarliestStartTime'), dtField('DueDate'),
]);

const NATIVE_SCHEDULE_REFUSAL = [{ actionName: 'scheduleServiceAppointment', isSuccess: false,
  errors: [{ statusCode: 'UNKNOWN_EXCEPTION', message: 'unable to schedule service appointment', fields: [] }],
  outputValues: null }];

function scheduleHarness(options: {
  stmRows: Array<Record<string, any>>;
  territoryRows: Array<Record<string, any>>;
  worktypeRows: Array<Record<string, any>>;
  invokeBody: any;
  invokeStatus?: number;
}) {
  const route = std('scheduleServiceAppointment');
  const posts: Array<{ path: string; body: any }> = [];
  const markers: Record<string, string> = {};
  const deleted = new Set<string>();
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [
        { name: 'serviceAppointmentId', type: 'ID', required: true },
        { name: 'schedulingPolicyId', type: 'ID', required: true },
      ] } }) },
    { match: (method, path) => method === 'POST' && path === route,
      respond: () => ({ status: options.invokeStatus ?? 200, body: options.invokeBody }) },
    { match: (method, path) => method === 'GET' && path.includes('FROM FSL__Scheduling_Policy__c'),
      respond: () => ({ status: 200, body: { records: [{ Id: POLICY_ID }] } }) },
    { match: (method, path) => method === 'GET' && path.includes('FROM ServiceResource'),
      respond: () => ({ status: 200, body: { records: [{ Id: FSL_RES_ID }] } }) },
    { match: (method, path) => method === 'GET' && path.includes('/sobjects/WorkOrder/describe'),
      respond: () => describeFor('WorkOrder', [textField('Subject')]) },
    { match: (method, path) => method === 'POST' && path.endsWith('/sobjects/WorkOrder'),
      respond: (_m, _p, body) => ({ status: 201, body: { id: WO_ID } }) },
    { match: (method, path) => method === 'GET' && path.includes('/sobjects/ServiceAppointment/describe'),
      respond: () => SA_DESCRIBE() },
    { match: (method, path) => method === 'GET' && path.includes('FROM ServiceTerritoryMember'),
      respond: () => ({ status: 200, body: { records: options.stmRows } }) },
    { match: (method, path) => method === 'GET' && path.includes('FROM ServiceTerritory LIMIT'),
      respond: () => ({ status: 200, body: { records: options.territoryRows } }) },
    { match: (method, path) => method === 'GET' && path.includes('FROM WorkType'),
      respond: () => ({ status: 200, body: { records: options.worktypeRows } }) },
    { match: (method, path) => method === 'POST' && path.endsWith('/sobjects/ServiceAppointment'),
      respond: () => ({ status: 201, body: { id: SA_ID } }) },
    { match: (method, path) => method === 'GET' && path.includes('WHERE Subject = '),
      respond: () => ({ status: 200, body: { records: [] } }) },
  ]);
  const request = async (path: string, method = 'GET', body?: any) => {
    if ((method === 'POST' && (path.endsWith('/sobjects/WorkOrder') || path.endsWith('/sobjects/ServiceAppointment'))) ||
      (method === 'POST' && path === route)) {
      posts.push({ path, body });
    }
    if (method === 'POST' && path.endsWith('/sobjects/WorkOrder')) markers.WorkOrder = body?.Subject;
    if (method === 'POST' && path.endsWith('/sobjects/ServiceAppointment')) markers.ServiceAppointment = body?.Subject;
    if (method === 'DELETE') {
      deleted.add(path);
      harness.calls.push({ method, path, body });
      return { status: 204, ok: true, body: null };
    }
    for (const [object, id] of [['WorkOrder', WO_ID], ['ServiceAppointment', SA_ID]] as const) {
      if (method === 'GET' && path.endsWith(`/sobjects/${object}/${id}`)) {
        return deleted.has(`${ROOT}/sobjects/${object}/${id}`) || deleted.has(path)
          ? { status: 404, ok: false, body: { errorCode: 'NOT_FOUND' } }
          : { status: 200, ok: true, body: { Id: id, Subject: markers[object] } };
      }
    }
    return harness.request(path, method, body);
  };
  return { route, posts, request, build: harness.build };
}

test('scheduling refusal on a grounded appointment parks with the substrate terminal', async () => {
  const harness = scheduleHarness({
    stmRows: [{ ServiceTerritoryId: TERR_ID }],
    territoryRows: [],
    worktypeRows: [{ Id: WT_ID, EstimatedDuration: 2, DurationType: 'Hours' }],
    invokeBody: NATIVE_SCHEDULE_REFUSAL,
  });
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route: harness.route, family: 'service-appointment', ownerUserId: USER_ID,
    request: harness.request, build: harness.build,
  });
  const saPost = harness.posts.find((post) => post.path.endsWith('/sobjects/ServiceAppointment'))?.body;
  expect(saPost.ServiceTerritoryId).toBe(TERR_ID);
  expect(saPost.WorkTypeId).toBe(WT_ID);
  expect(saPost.Duration).toBe(120);
  expect(Date.parse(saPost.EarliestStartTime)).toBeGreaterThan(Date.now());
  expect(Date.parse(saPost.DueDate)).toBeGreaterThan(Date.parse(saPost.EarliestStartTime));
  expect(saPost.ParentRecordId).toBe(WO_ID);
  const invokePost = harness.posts.find((post) => post.path === harness.route)?.body;
  expect(invokePost.inputs[0]).toEqual({ serviceAppointmentId: SA_ID, schedulingPolicyId: POLICY_ID });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('SKIPPED_STANDARD_SERVICE_APPOINTMENT_SCHEDULING_SUBSTRATE_UNAVAILABLE');
  expect(outcome.body.setupRequirement).toContain('schedulable FSL capacity');
  expect(outcome.cleanupError).toBeUndefined();
});

test('scheduling refusal without grounding passes through unmasked', async () => {
  const harness = scheduleHarness({
    stmRows: [],
    territoryRows: [],
    worktypeRows: [],
    invokeBody: NATIVE_SCHEDULE_REFUSAL,
  });
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route: harness.route, family: 'service-appointment',
    request: harness.request, build: harness.build,
  });
  const saPost = harness.posts.find((post) => post.path.endsWith('/sobjects/ServiceAppointment'))?.body;
  expect(saPost.ServiceTerritoryId).toBeUndefined();
  expect(saPost.Duration).toBe(60);
  expect(outcome.status).toBe(200);
  expect(Array.isArray(outcome.body)).toBe(true);
  expect(outcome.cleanupError).toBeUndefined();
});

test('minutes estimates bind as-is with the fallback territory on the success path', async () => {
  const harness = scheduleHarness({
    stmRows: [],
    territoryRows: [{ Id: TERR_FALLBACK_ID }],
    worktypeRows: [{ Id: WT_ID, EstimatedDuration: 45, DurationType: 'Minutes' }],
    invokeBody: ACCEPTED,
  });
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route: harness.route, family: 'service-appointment',
    request: harness.request, build: harness.build,
  });
  const saPost = harness.posts.find((post) => post.path.endsWith('/sobjects/ServiceAppointment'))?.body;
  expect(saPost.ServiceTerritoryId).toBe(TERR_FALLBACK_ID);
  expect(saPost.Duration).toBe(45);
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema).toMatchObject({ verified: true });
  expect(outcome.cleanupError).toBeUndefined();
});

test('notification binds channel, template, and owned recipient end user', () => {
  const planned = planSkippedStandardArgs(skippedStandardBindingSpec('notification', 'liveMessageNotification'), [
    { name: 'templateDeveloperName', type: 'STRING', required: true },
    { name: 'channelDeveloperName', type: 'STRING', required: true },
    { name: 'recipientRecordId', type: 'ID', required: false },
    { name: 'recipientPhone', type: 'PHONE', required: false },
  ], { marker: 'AS probe m', fixtures: { MessagingEndUser: '0dn000000000001AAA' }, discovered: { liveMessageTemplate: 'T', notificationChannel: 'C' } });
  expect(planned).toEqual({ args: { templateDeveloperName: 'T', channelDeveloperName: 'C', recipientRecordId: '0dn000000000001AAA', recipientPhone: '+15555550100' } });
});

test('notification prefers notification-capable channels and mints an owned end user', () => {
  const discoveries = skippedStandardDiscoveries('notification', 'liveMessageNotification');
  // Every discovered key the notification bindings reference must resolve;
  // a binding without its discovery entry misses with no failure note.
  expect(discoveries.find((entry) => entry.key === 'liveMessageTemplate')).toMatchObject({ field: 'DeveloperName' });
  const channel = discoveries.find((entry) => entry.key === 'notificationChannel');
  expect(channel).toMatchObject({ field: 'DeveloperName' });
  const queries = (channel as { queryValue: string[] }).queryValue;
  expect(queries).toHaveLength(3);
  expect(queries[0]).toContain('MessageType IN (');
  expect(queries[0]).toContain('IsActive = true');
  expect(skippedStandardFixtures('notification', 'liveMessageNotification')).toEqual([
    { objects: ['Contact'] },
    { objects: ['MessagingEndUser'], parents: { ContactId: { fixture: 'Contact' }, MessagingChannelId: { discovered: 'channelId' } } },
  ]);
});

test('discovery-query denial attaches a grant on input_unresolved', async () => {
  const route = std('assignToQueue');
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [{ name: 'queueId', type: 'STRING', required: true }] } }) },
    { match: (method, path) => path.includes('/query?'),
      respond: () => ({ status: 403, body: [{ errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY', message: 'insufficient access rights on object' }] }) },
  ]);
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'record-assignment', request: harness.request, build: harness.build,
  });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('SKIPPED_STANDARD_RECORD_ASSIGNMENT_INPUT_UNRESOLVED');
  expect(outcome.body.message).toContain('Discovery failures: [queueId:403:INSUFFICIENT_ACCESS_OR_READONLY]');
  expect(outcome.denialGrant).toMatchObject({ family: 'object-crud', objectName: 'Group' });
  expect(outcome.contextSchema).toMatchObject({ denialGrant: { family: 'object-crud', objectName: 'Group' } });
});

test('rowless discovery on a required input proposes a read grant', async () => {
  const route = std('assignToQueue');
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [{ name: 'queueId', type: 'STRING', required: true }] } }) },
    { match: (method, path) => path.includes('/query?'),
      respond: () => ({ status: 200, body: { records: [] } }) },
  ]);
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'record-assignment', request: harness.request, build: harness.build,
  });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('SKIPPED_STANDARD_RECORD_ASSIGNMENT_INPUT_UNRESOLVED');
  expect(outcome.body.message).not.toContain('Discovery failures');
  expect(outcome.denialGrant).toMatchObject({ family: 'object-crud', objectName: 'Group' });
});

test('missing-object discovery proposes no grant', async () => {
  const route = std('assignToQueue');
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [{ name: 'queueId', type: 'STRING', required: true }] } }) },
    { match: (method, path) => path.includes('/query?'),
      respond: () => ({ status: 400, body: [{ errorCode: 'INVALID_TYPE', message: "sObject type 'Group' is not supported" }] }) },
  ]);
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'record-assignment', request: harness.request, build: harness.build,
  });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('SKIPPED_STANDARD_RECORD_ASSIGNMENT_INPUT_UNRESOLVED');
  expect(outcome.body.message).toContain('Discovery failures: [queueId:400:INVALID_TYPE]');
  expect(outcome.denialGrant).toBeUndefined();
});

test('non-discovery miss proposes no grant', async () => {
  const route = std('assignToQueue');
  const harness = scripted([
    { match: (method, path) => method === 'GET' && path === route,
      respond: () => ({ status: 200, body: { inputs: [{ name: 'unboundWhimsy', type: 'STRING', required: true }] } }) },
    { match: (method, path) => path.includes('/query?'),
      respond: () => ({ status: 200, body: { records: [] } }) },
  ]);
  const outcome = await invokeSkippedStandardWithOwnedContext({
    root: ROOT, route, family: 'record-assignment', request: harness.request, build: harness.build,
  });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('SKIPPED_STANDARD_RECORD_ASSIGNMENT_INPUT_UNRESOLVED');
  expect(outcome.denialGrant).toBeUndefined();
});
