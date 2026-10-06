import { test, expect } from 'bun:test';
import {
  RESEARCH_FIXTURE_MARKER_FIELD,
  RESEARCH_REPORT_OBJECT,
  RESEARCH_REQUIRED_SETUP,
  RESEARCH_SESSION_OBJECT,
  RESEARCH_SPACE_OBJECT,
  invokeResearchWithOwnedContext,
  isResearchOwnedContextRoute,
  researchActionName,
  researchInvocationInputs,
  researchRunAccepted,
  researchSubstrateFault,
  researchSubstrateStatus,
} from './research-lifecycle-context';

const ROOT = '/services/data/v67.0';
const RUN = `${ROOT}/actions/standard/knowledgeSpaceRunResearch`;
const CANCEL = `${ROOT}/actions/standard/KnowledgeSpaceDeepResearchCancel`;
const VIEW = `${ROOT}/actions/standard/knowledgeSpaceViewReport`;
const OWNED_ID = '1aG000000000001EAA';

test('research routes classify the three in-scope standard actions only', () => {
  expect(researchActionName(RUN)).toBe('knowledgeSpaceRunResearch');
  expect(researchActionName(CANCEL)).toBe('KnowledgeSpaceDeepResearchCancel');
  expect(researchActionName(VIEW)).toBe('knowledgeSpaceViewReport');
  expect(researchActionName(`${ROOT}/actions/standard/KnowledgeSpaceDeepResearchEdit`)).toBeNull();
  expect(researchActionName(`${ROOT}/actions/standard/KnowledgeSpaceKnowledgeSearch`)).toBeNull();
  expect(researchActionName(`${ROOT}/actions/standard/publishKnowledgeArticles`)).toBeNull();
  expect(researchActionName(`${ROOT}/actions/custom/flow/knowledgeSpaceViewReport`)).toBeNull();
  expect(researchActionName('not a route')).toBeNull();
  expect(isResearchOwnedContextRoute(VIEW, 'standard')).toBe(true);
  expect(isResearchOwnedContextRoute(VIEW)).toBe(true);
  expect(isResearchOwnedContextRoute(VIEW, 'custom/flow')).toBe(false);
  expect(isResearchOwnedContextRoute(`${ROOT}/actions/standard/submit`, 'standard')).toBe(false);
});

test('invocation inputs resolve dynamically from the live descriptor', () => {
  expect(researchInvocationInputs([
    { name: 'researchId', type: 'STRING', required: false },
    { name: 'deepResearchWorkflowAction', type: 'STRING', required: false },
  ])).toEqual({ researchIdField: 'researchId', workflowField: 'deepResearchWorkflowAction' });
  expect(researchInvocationInputs([
    { name: 'ResearchId', type: 'STRING', required: false },
    { name: 'PartialReport', type: 'STRING', required: false },
  ])).toEqual({ researchIdField: 'ResearchId' });
  expect(researchInvocationInputs([{ name: 'deepResearchWorkflowAction', type: 'STRING' }])).toEqual({
    failure: 'The live research action does not declare a researchId input.',
  });
  expect('failure' in researchInvocationInputs([])).toBe(true);
  expect('failure' in researchInvocationInputs(null)).toBe(true);
});

test('acceptance reads the envelope and faults match the blind-verified shapes', () => {
  expect(researchRunAccepted(200, [{ isSuccess: true, errors: [] }])).toBe(true);
  expect(researchRunAccepted(200, [{ isSuccess: true, errors: null }])).toBe(true);
  expect(researchRunAccepted(200, [{ isSuccess: false, errors: [] }])).toBe(false);
  expect(researchRunAccepted(400, [{ isSuccess: true, errors: [] }])).toBe(false);
  expect(researchRunAccepted(200, [])).toBe(false);
  // Recorded native envelopes (2026-10-03, both orgs).
  expect(researchSubstrateFault([{ isSuccess: false,
    errors: [{ message: 'Research ID not found. Unable to resolve from session or input.' }] }])).toBe(true);
  expect(researchSubstrateFault([{ isSuccess: false,
    errors: [{ message: 'Research ID is required to run a research. Please provide a researchId.' }] }])).toBe(true);
  expect(researchSubstrateFault([{ isSuccess: false,
    errors: [{ message: 'Failed to run deep research: Message: \nHTTP response code: 404' }] }])).toBe(true);
  expect(researchSubstrateFault([{ isSuccess: false,
    errors: [{ message: 'Failed to load deep research report metadata: Message: \nHTTP response code: 404' }] }])).toBe(true);
  expect(researchSubstrateFault([{ isSuccess: true, errors: [] }])).toBe(false);
  expect(researchSubstrateFault([{ isSuccess: false, errors: [{ message: 'Something unrelated broke' }] }])).toBe(false);
});

type HarnessOptions = {
  counts?: { sessions: number; reports: number; spaces: number };
  countsFail?: string[];
  describe?: Record<string, any> | null;
  invoke?: (args: any) => { status: number; body: any };
  deleteStuck?: boolean;
  buildMismatch?: boolean;
};
function harness(route: string, options: HarnessOptions = {}) {
  const counts = options.counts ?? { sessions: 0, reports: 0, spaces: 0 };
  let fixture: any = null;
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  const result = (body: any, status = 200) => ({ body, status, ok: status < 400 });
  const request = async (path: string, method = 'GET', body?: any) => {
    calls.push({ path, method, body });
    if (method === 'GET' && path === route) {
      return result({ inputs: [
        { name: 'researchId', type: 'STRING', required: false },
        { name: 'deepResearchWorkflowAction', type: 'STRING', required: false },
      ] });
    }
    if (path === `${ROOT}/sobjects/${RESEARCH_SESSION_OBJECT}/describe`) {
      if (options.describe === null) return result({ message: 'forbidden' }, 403);
      return result({ createable: true, deletable: true, queryable: true, fields: [{ name: 'Name' }], ...options.describe });
    }
    for (const [object, key] of [[RESEARCH_SESSION_OBJECT, 'sessions'], [RESEARCH_REPORT_OBJECT, 'reports'], [RESEARCH_SPACE_OBJECT, 'spaces']] as const) {
      if (path === `${ROOT}/query?q=${encodeURIComponent(`SELECT COUNT() FROM ${object}`)}`) {
        if (options.countsFail?.includes(object)) return result({ message: 'denied' }, 403);
        return result({ totalSize: counts[key], done: true, records: [] });
      }
    }
    if (path === `${ROOT}/sobjects/${RESEARCH_SESSION_OBJECT}` && method === 'POST') {
      fixture = { ...body, Id: OWNED_ID };
      return result({ id: OWNED_ID }, 201);
    }
    if (path === `${ROOT}/sobjects/${RESEARCH_SESSION_OBJECT}/${OWNED_ID}` && method === 'GET') {
      return fixture ? result(fixture) : result([{ errorCode: 'NOT_FOUND' }], 404);
    }
    if (path === `${ROOT}/sobjects/${RESEARCH_SESSION_OBJECT}/${OWNED_ID}` && method === 'DELETE') {
      if (!options.deleteStuck) fixture = null;
      return result(null, 204);
    }
    if (path.startsWith(`${ROOT}/query?q=`) && path.includes(encodeURIComponent(`FROM ${RESEARCH_SESSION_OBJECT} WHERE`))) {
      return result({ totalSize: fixture ? 1 : 0, done: true, records: fixture ? [{ Id: OWNED_ID }] : [] });
    }
    if (path === route && method === 'POST') {
      const invoked = options.invoke ? options.invoke(body?.inputs?.[0]) : { status: 400, body: [{ isSuccess: false, errors: [{ message: 'boom' }] }] };
      return result(invoked.body, invoked.status);
    }
    throw new Error(`unexpected call ${method} ${path}`);
  };
  const build = async (_name: string, marker: string, values: any) => ({
    values: options.buildMismatch ? { ...values, [RESEARCH_FIXTURE_MARKER_FIELD]: 'changed' } : values,
  });
  return { request, build, calls, fixture: () => fixture };
}

test('empty substrate never posts; returns setup-blocked evidence', async () => {
  const h = harness(RUN);
  const outcome = await invokeResearchWithOwnedContext({ root: ROOT, route: RUN, request: h.request, build: h.build });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('RESEARCH_SUBSTRATE_ABSENT');
  expect(outcome.body.setupRequirement).toBe(RESEARCH_REQUIRED_SETUP);
  expect(outcome.body.substrate).toEqual({ sessions: 0, reports: 0, spaces: 0 });
  expect(outcome.contextSchema).toMatchObject({ verified: false, ownedRecordId: null });
  expect(h.calls.some((call) => call.path === RUN && call.method === 'POST')).toBe(false);
  expect(h.calls.some((call) => call.path === `${ROOT}/sobjects/${RESEARCH_SESSION_OBJECT}` && call.method === 'POST')).toBe(false);
  expect(h.fixture()).toBeNull();
});

test('present substrate invokes with the owned id and classifies the native gap', async () => {
  let seen: any = null;
  const h = harness(CANCEL, {
    counts: { sessions: 2, reports: 1, spaces: 1 },
    invoke: (args) => {
      seen = args;
      return { status: 400, body: [{ isSuccess: false,
        errors: [{ message: 'Research ID not found. Unable to resolve from session or input.' }] }] };
    },
  });
  const outcome = await invokeResearchWithOwnedContext({ root: ROOT, route: CANCEL, request: h.request, build: h.build });
  expect(seen).toEqual({ researchId: OWNED_ID });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('RESEARCH_SUBSTRATE_UNRESOLVABLE');
  expect(outcome.body.setupRequirement).toBe(RESEARCH_REQUIRED_SETUP);
  expect(outcome.body.upstreamOutcome).toBeDefined();
  expect(outcome.contextSchema).toMatchObject({ verified: false, ownedRecordId: OWNED_ID });
  expect(outcome.cleanupError).toBeUndefined();
  expect(h.fixture()).toBeNull();
  expect(h.calls.some((call) => call.method === 'DELETE')).toBe(true);
});

test('view passes the workflow action and a native success verifies', async () => {
  let seen: any = null;
  const h = harness(VIEW, {
    counts: { sessions: 1, reports: -1, spaces: -1 },
    invoke: (args) => {
      seen = args;
      return { status: 200, body: [{ isSuccess: true, errors: [], outputValues: { viewReportResponse: 'ok' } }] };
    },
  });
  const outcome = await invokeResearchWithOwnedContext({ root: ROOT, route: VIEW, request: h.request, build: h.build });
  expect(seen).toEqual({ researchId: OWNED_ID, deepResearchWorkflowAction: 'VIEW_REPORT' });
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema).toMatchObject({ verified: true, ownedRecordId: OWNED_ID });
  expect(h.fixture()).toBeNull();
});

test('unrecognized native outcomes are preserved, never upgraded', async () => {
  const h = harness(RUN, {
    counts: { sessions: 1, reports: 0, spaces: 0 },
    invoke: () => ({ status: 500, body: [{ isSuccess: false, errors: [{ message: 'Something unrelated broke' }] }] }),
  });
  const outcome = await invokeResearchWithOwnedContext({ root: ROOT, route: RUN, request: h.request, build: h.build });
  expect(outcome.status).toBe(500);
  expect(outcome.body).toEqual([{ isSuccess: false, errors: [{ message: 'Something unrelated broke' }] }]);
  expect(outcome.contextSchema).toMatchObject({ verified: false });
  expect(h.fixture()).toBeNull();
});

test('missing fixture permissions and unreadable substrate fail before any write', async () => {
  const denied = harness(RUN, { describe: { createable: false } });
  const deniedOutcome = await invokeResearchWithOwnedContext({ root: ROOT, route: RUN, request: denied.request, build: denied.build });
  expect(deniedOutcome.body.errorCode).toBe('RESEARCH_FIXTURE_PERMISSIONS_REQUIRED');
  expect(denied.fixture()).toBeNull();
  const unreadable = harness(RUN, { countsFail: [RESEARCH_SESSION_OBJECT] });
  const unreadableOutcome = await invokeResearchWithOwnedContext({ root: ROOT, route: RUN, request: unreadable.request, build: unreadable.build });
  expect(unreadableOutcome.body.errorCode).toBe('RESEARCH_SUBSTRATE_UNREADABLE');
  expect(unreadable.fixture()).toBeNull();
  expect(denied.calls.some((call) => call.method === 'POST')).toBe(false);
  expect(unreadable.calls.some((call) => call.method === 'POST')).toBe(false);
});

test('report and space counts are best-effort evidence', async () => {
  const h = harness(RUN, { counts: { sessions: 0, reports: 0, spaces: 0 }, countsFail: [RESEARCH_REPORT_OBJECT, RESEARCH_SPACE_OBJECT] });
  const status = await researchSubstrateStatus({ root: ROOT, request: h.request });
  expect(status).toEqual({ sessions: 0, reports: -1, spaces: -1 });
  const blocked = harness(RUN, { countsFail: [RESEARCH_SESSION_OBJECT] });
  expect(await researchSubstrateStatus({ root: ROOT, request: blocked.request })).toEqual({
    failure: 'The live research session substrate could not be read; execution-user read access is required.',
  });
});

test('stuck cleanup is reported and unverified', async () => {
  const h = harness(CANCEL, {
    counts: { sessions: 1, reports: 0, spaces: 0 },
    deleteStuck: true,
    invoke: () => ({ status: 200, body: [{ isSuccess: true, errors: [] }] }),
  });
  const outcome = await invokeResearchWithOwnedContext({ root: ROOT, route: CANCEL, request: h.request, build: h.build });
  expect(outcome.cleanupError).toContain('cleanup could not be verified');
  expect(outcome.contextSchema).toMatchObject({ verified: false });
  expect(h.fixture()).not.toBeNull();
});

test('invalid routes, windows, and builder drift fail closed', async () => {
  const h = harness(RUN);
  const badRoute = await invokeResearchWithOwnedContext({ root: ROOT, route: `${ROOT}/actions/standard/submit`, request: h.request, build: h.build });
  expect(badRoute.body.errorCode).toBe('RESEARCH_ACTION_INVALID');
  const badWindow = await invokeResearchWithOwnedContext({ root: ROOT, route: RUN, verificationWindowMs: 99_999, request: h.request, build: h.build });
  expect(badWindow.body.errorCode).toBe('RESEARCH_WINDOW_INVALID');
  const drifted = harness(RUN, { counts: { sessions: 1, reports: 0, spaces: 0 }, buildMismatch: true });
  const driftedOutcome = await invokeResearchWithOwnedContext({ root: ROOT, route: RUN, request: drifted.request, build: drifted.build });
  expect(driftedOutcome.body.errorCode).toBe('RESEARCH_BUILD_UNSCOPED');
  expect(drifted.fixture()).toBeNull();
});
