import { test, expect } from 'bun:test';
import {
  SKIPPED_STANDARD_BUILDER_VERSION,
  contextNamespaceExpired,
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

test('route parsing accepts standard and survey/matrix custom routes only', () => {
  expect(skippedStandardRouteInfo(std('createTask'))).toEqual({ kind: 'standard', apiVersion: 'v67.0', action: 'createTask' });
  expect(skippedStandardRouteInfo(`${ROOT}/actions/custom/dynamicSendSurveyInvitation/case_csat_nps_survey`)).toEqual({
    kind: 'custom', apiVersion: 'v67.0', action: 'case_csat_nps_survey', customKind: 'dynamicSendSurveyInvitation',
  });
  expect(skippedStandardRouteInfo(`${ROOT}/actions/custom/runDecisionMatrix/SDO_Service_Cirrus_Locations`)).toEqual({
    kind: 'custom', apiVersion: 'v67.0', action: 'SDO_Service_Cirrus_Locations', customKind: 'runDecisionMatrix',
  });
  expect(skippedStandardRouteInfo(`${ROOT}/actions/custom/flow/Send_Survey`)).toBeNull();
  expect(skippedStandardRouteInfo(`${ROOT}/actions/custom/apex/Something`)).toBeNull();
  expect(skippedStandardRouteInfo(`${ROOT}/actions/custom/quickAction/Case/Create_Task`)).toBeNull();
  expect(skippedStandardRouteInfo(`${ROOT}/actions/custom/sendNotification/deal_won`)).toBeNull();
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
  const channel = skippedStandardDiscoveries('notification', 'liveMessageNotification').find((entry) => entry.key === 'notificationChannel');
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
