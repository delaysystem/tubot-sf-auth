import { test, expect } from 'bun:test';
import { invokeProcSimpleApprovalWithContext, procSimpleApprovalActionName } from './approval-flow-lifecycle';
import { APPROVAL_PROVISION_FLOW_NAME, APPROVAL_PROVISION_INPUTS } from './approval-submission-provisioning';

const ROOT = '/services/data/v67.0';
const ROUTE = `${ROOT}/actions/custom/flow/${APPROVAL_PROVISION_FLOW_NAME}`;
const OPP = '006000000000001AAA';
const OWNER = '005000000000001AAA';
const SUB = '9iP000000000001AAA';
const ITEM = '9jR000000000001AAA';

type Opts = { flowAbsent?: boolean; errored?: boolean; freezeSweep?: boolean };
function harness(options: Opts = {}) {
  let opp: any = null, submission: any = null, workItem: any = null;
  const posts: string[] = [];
  const success = (extra: any = {}) => ({ status: 200, ok: true, body: [{ isSuccess: true, errors: [], ...extra }] });
  const request = async (path: string, method = 'GET', body?: any): Promise<{ status: number; ok: boolean; body: any }> => {
    const result = (responseBody: any, status = 200) => ({ body: responseBody, status, ok: status < 400 });
    if (method === 'GET' && path === ROUTE) {
      if (options.flowAbsent) return result([{ message: 'Not found', errorCode: 'NOT_FOUND' }], 404);
      return result({ inputs: [...APPROVAL_PROVISION_INPUTS].map((name) => ({ name })) });
    }
    if (method === 'POST' && path === ROUTE) {
      posts.push('provision');
      submission = { Id: SUB, Status: options.errored ? 'Errored' : 'InProgress' };
      workItem = { Id: ITEM, Status: 'Assigned', AssignedToId: OWNER };
      return success();
    }
    if (method === 'POST' && path === `${ROOT}/actions/standard/recallApprovalSubmission`) {
      posts.push('recall');
      if (!options.freezeSweep && submission) submission.Status = 'Recalled';
      return success();
    }
    if (method === 'POST' && path === `${ROOT}/actions/standard/cancelApprovalSubmission`) {
      posts.push('cancel');
      if (!options.freezeSweep && submission) submission.Status = 'Canceled';
      return success();
    }
    if (path === `${ROOT}/sobjects/Opportunity` && method === 'POST') {
      opp = { ...body, Id: OPP, OwnerId: OWNER };
      return result({ id: opp.Id }, 201);
    }
    if (path === `${ROOT}/sobjects/Opportunity/${OPP}`) {
      if (method === 'DELETE') {
        if (submission && submission.Status === 'InProgress') return result([{ message: 'locked', errorCode: 'LOCKED' }], 400);
        opp = null; submission = null; workItem = null; return result(null, 204);
      }
      return opp ? result(opp) : result([], 404);
    }
    if (path.includes('/query?q=')) {
      const query = decodeURIComponent(path.split('?q=')[1]);
      if (query.includes('FROM Organization')) return result({ records: [{ IsSandbox: false, OrganizationType: 'Developer Edition' }] });
      if (query.includes('FROM User')) return result({ records: [{ Id: OWNER, Username: 'owner@example.com' }] });
      if (query.includes('FROM ApprovalSubmission')) return result({ records: submission ? [submission] : [] });
      if (query.includes('FROM ApprovalWorkItem')) return result({ records: workItem ? [workItem] : [] });
      if (query.includes('FROM Opportunity')) return result({ records: opp ? [opp] : [] });
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const invoke = () => invokeProcSimpleApprovalWithContext({ root: ROOT, route: ROUTE, request,
    settlePoll: { attempts: 2, delayMs: 0 }, build: async (_, __, values) => ({ values }) });
  return { invoke, posts: () => posts, state: () => ({ opp, submission, workItem }) };
}

test('route classification accepts only the simple-approval flow route', () => {
  expect(procSimpleApprovalActionName(ROUTE)).toBe(APPROVAL_PROVISION_FLOW_NAME);
  expect(procSimpleApprovalActionName(`${ROOT}/actions/custom/flow/standard_approvals__RqstFlowActv`)).toBeNull();
  expect(procSimpleApprovalActionName(`${ROOT}/actions/standard/submit`)).toBeNull();
  expect(procSimpleApprovalActionName('not a route')).toBeNull();
});

test('the flow lifecycle verifies substrate, sweeps it, and cleans the fixture', async () => {
  const h = harness();
  const result = await h.invoke();
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.approvalSubmissionId).toBe(SUB);
  expect(result.contextSchema?.approvalWorkItemId).toBe(ITEM);
  expect(result.contextSchema?.beforeStatus).toBe('InProgress');
  expect(result.contextSchema?.afterStatus).toBe('Recalled');
  expect(h.posts()).toEqual(['provision', 'recall']);
  expect(h.state().opp).toBeNull();
  expect(result.cleanupError).toBeUndefined();
});

test('an absent platform flow is a setup requirement with no residue', async () => {
  const h = harness({ flowAbsent: true });
  const result = await h.invoke();
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe('APPROVAL_SUBMISSION_SETUP_REQUIRED');
  expect(h.posts()).toEqual([]);
  expect(h.state().opp).toBeNull();
  expect(result.cleanupError).toBeUndefined();
});

test('an errored submission fails the lifecycle and still cleans the fixture', async () => {
  const h = harness({ errored: true });
  const result = await h.invoke();
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe('APPROVAL_SUBMISSION_ERRORED');
  expect(result.contextSchema?.verified).toBe(false);
  expect(h.state().opp).toBeNull();
});

test('an unsweepable submission is reported as a cleanup error', async () => {
  const h = harness({ freezeSweep: true });
  const result = await h.invoke();
  expect(result.cleanupError).toBe('Owned approval-flow submission cleanup could not be verified terminal.');
  expect(result.contextSchema?.verified).toBe(false);
});

test('an undiscovered route is rejected before any request', async () => {
  let called = false;
  const result = await invokeProcSimpleApprovalWithContext({ root: ROOT, route: `${ROOT}/actions/custom/flow/Other`,
    request: async () => { called = true; throw new Error('Must not execute'); }, build: async () => ({ values: {} }) });
  expect(result.body.errorCode).toBe('APPROVAL_FLOW_ROUTE_INVALID');
  expect(called).toBe(false);
});
