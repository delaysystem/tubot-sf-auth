import { test, expect } from 'bun:test';
import {
  APPROVAL_PROVISION_FLOW_NAME, APPROVAL_PROVISION_INPUTS, isActionableSubmissionStatus,
  isActionableWorkItemStatus, isGuardedOrg, isTerminalSubmissionStatus, provisionApprovalSubmission,
  provisionFlowRoute, settle, sweepApprovalSubmission,
} from './approval-submission-provisioning';

const FAST_SETTLE = { attempts: 2, delayMs: 0 };

const ROOT = '/services/data/v67.0';
const OPP = '006000000000001AAA';
const OWNER = '005000000000001AAA';
const OTHER = '005000000000002AAA';
const SUB = '9iP000000000001AAA';
const ITEM = '9jR000000000001AAA';

type Opts = { flowAbsent?: boolean; flowSchemaMismatch?: boolean; invokeError?: boolean; errored?: boolean; noItem?: boolean; ambiguous?: boolean; freezeRecall?: boolean; prodOrg?: boolean; devOrg?: boolean; orgUnreadable?: boolean };
function harness(options: Opts = {}) {
  let submission: any = null, workItem: any = null;
  const posts: string[] = [];
  const success = (extra: any = {}) => ({ status: 200, ok: true, body: [{ isSuccess: true, errors: [], ...extra }] });
  const request = async (path: string, method = 'GET', body?: any): Promise<{ status: number; ok: boolean; body: any }> => {
    const result = (responseBody: any, status = 200) => ({ body: responseBody, status, ok: status < 400 });
    if (method === 'GET' && path === provisionFlowRoute(ROOT)) {
      if (options.flowAbsent) return result([{ message: 'Not found', errorCode: 'NOT_FOUND' }], 404);
      const names = options.flowSchemaMismatch ? ['recordId'] : [...APPROVAL_PROVISION_INPUTS];
      return result({ inputs: names.map((name) => ({ name })) });
    }
    if (method === 'POST' && path === provisionFlowRoute(ROOT)) {
      posts.push('provision');
      if (options.invokeError) return result([{ isSuccess: false, errors: [{ message: 'flow fault' }] }]);
      submission = { Id: options.ambiguous ? SUB : SUB, Status: options.errored ? 'Errored' : 'InProgress' };
      if (!options.noItem) workItem = { Id: ITEM, Status: 'Assigned', AssignedToId: OWNER };
      return success();
    }
    if (method === 'POST' && path === `${ROOT}/actions/standard/recallApprovalSubmission`) {
      posts.push('recall');
      if (!options.freezeRecall && submission && submission.Status === 'InProgress') submission.Status = 'Recalled';
      return success();
    }
    if (method === 'POST' && path === `${ROOT}/actions/standard/cancelApprovalSubmission`) {
      posts.push('cancel');
      if (submission && submission.Status === 'InProgress') submission.Status = 'Canceled';
      return success();
    }
    if (path.includes('/query?q=')) {
      const query = decodeURIComponent(path.split('?q=')[1]);
      if (query.includes('FROM Organization')) {
        if (options.orgUnreadable) return result([{ message: 'forbidden', errorCode: 'FORBIDDEN' }], 403);
        if (options.prodOrg) return result({ records: [{ IsSandbox: false, OrganizationType: 'Enterprise Edition' }] });
        if (options.devOrg) return result({ records: [{ IsSandbox: false, OrganizationType: 'Developer Edition' }] });
        return result({ records: [{ IsSandbox: true, OrganizationType: 'Enterprise Edition' }] });
      }
      if (query.includes('FROM User')) return result({ records: [{ Id: OWNER, Username: 'owner@example.com' }] });
      if (query.includes('FROM ApprovalSubmission')) {
        const rows = submission ? (options.ambiguous ? [submission, { ...submission, Id: '9iP000000000002AAA' }] : [submission]) : [];
        return result({ records: rows });
      }
      if (query.includes('FROM ApprovalWorkItem')) return result({ records: workItem ? [workItem] : [] });
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const provision = () => provisionApprovalSubmission({ root: ROOT, recordId: OPP, ownerId: OWNER, comments: 'probe', request });
  return { request, provision, posts: () => posts, state: () => ({ submission, workItem }) };
}

test('provision route and status predicates follow the live substrate model', () => {
  expect(provisionFlowRoute(ROOT)).toBe(`${ROOT}/actions/custom/flow/${APPROVAL_PROVISION_FLOW_NAME}`);
  expect(isActionableSubmissionStatus('InProgress')).toBe(true);
  expect(isActionableSubmissionStatus('Pending')).toBe(false);
  expect(isTerminalSubmissionStatus('Approved')).toBe(true);
  expect(isTerminalSubmissionStatus('Recalled')).toBe(true);
  expect(isTerminalSubmissionStatus('Canceled')).toBe(true);
  expect(isTerminalSubmissionStatus('InProgress')).toBe(false);
  expect(isActionableWorkItemStatus('Assigned')).toBe(true);
  expect(isActionableWorkItemStatus('Pending')).toBe(false);
});

test('provisioning verifies one InProgress submission and one Assigned workitem', async () => {
  const h = harness();
  const result = await h.provision();
  if ('failure' in result) throw new Error('Unexpected provisioning failure.');
  expect(result.submissionId).toBe(SUB);
  expect(result.workItemId).toBe(ITEM);
  expect(result.submitterId).toBe(OWNER);
  expect(result.approverUsername).toBe('owner@example.com');
  expect(result.assigneeId).toBe(OWNER);
  expect(h.posts()).toEqual(['provision']);
});

test('an absent platform flow is an explicit setup requirement', async () => {
  const h = harness({ flowAbsent: true });
  const result = await h.provision();
  if (!('failure' in result)) throw new Error('Expected a setup failure.');
  expect(result.failure.body.errorCode).toBe('APPROVAL_SUBMISSION_SETUP_REQUIRED');
  expect(h.posts()).toEqual([]);
});

test('a changed flow schema is rejected before invocation', async () => {
  const h = harness({ flowSchemaMismatch: true });
  const result = await h.provision();
  if (!('failure' in result)) throw new Error('Expected a schema failure.');
  expect(result.failure.body.errorCode).toBe('APPROVAL_PROVISION_SCHEMA_MISMATCH');
  expect(h.posts()).toEqual([]);
});

test('an errored submission is surfaced, never treated as substrate', async () => {
  const h = harness({ errored: true });
  const result = await h.provision();
  if (!('failure' in result)) throw new Error('Expected an errored failure.');
  expect(result.failure.body.errorCode).toBe('APPROVAL_SUBMISSION_ERRORED');
});

test('ambiguous or missing substrate is rejected', async () => {
  const ambiguous = await harness({ ambiguous: true }).provision();
  if (!('failure' in ambiguous)) throw new Error('Expected an ambiguity failure.');
  expect(ambiguous.failure.body.errorCode).toBe('APPROVAL_SUBMISSION_UNVERIFIED');
  const missing = await harness({ noItem: true }).provision();
  if (!('failure' in missing)) throw new Error('Expected a workitem failure.');
  expect(missing.failure.body.errorCode).toBe('APPROVAL_WORK_ITEM_UNVERIFIED');
});

test('sweep recalls an actionable submission and reports the terminal status', async () => {
  const h = harness();
  const provisioned = await h.provision();
  if ('failure' in provisioned) throw new Error('Unexpected provisioning failure.');
  const swept = await sweepApprovalSubmission({ root: ROOT, submissionId: SUB, comments: 'sweep', request: h.request, settlePoll: FAST_SETTLE });
  expect(swept.status).toBe('Recalled');
  expect(h.posts()).toEqual(['provision', 'recall']);
});

test('sweep falls back to cancel when recall leaves the submission actionable', async () => {
  const h = harness({ freezeRecall: true });
  const provisioned = await h.provision();
  if ('failure' in provisioned) throw new Error('Unexpected provisioning failure.');
  const swept = await sweepApprovalSubmission({ root: ROOT, submissionId: SUB, comments: 'sweep', request: h.request, settlePoll: FAST_SETTLE });
  expect(swept.status).toBe('Canceled');
  expect(h.posts()).toEqual(['provision', 'recall', 'cancel']);
});

test('sweep of an unknown submission reports no status without invoking', async () => {
  const h = harness();
  const swept = await sweepApprovalSubmission({ root: ROOT, submissionId: '9iP000000000009AAA', comments: 'sweep', request: h.request, settlePoll: FAST_SETTLE });
  expect(swept.status).toBeNull();
  expect(h.posts()).toEqual([]);
  expect(OTHER).not.toBe(OWNER);
});

test('settle returns the first passing read without sleeping', async () => {
  let reads = 0;
  const value = await settle(async () => (++reads, reads), (n) => n >= 2, FAST_SETTLE);
  expect(value).toBe(2);
  expect(reads).toBe(2);
});

test('settle returns the last read when the budget is exhausted', async () => {
  let reads = 0;
  const value = await settle(async () => (++reads, 'InProgress'), (s) => s !== 'InProgress', FAST_SETTLE);
  expect(value).toBe('InProgress');
  expect(reads).toBe(2);
});

test('production orgs are guarded before any provisioning POST', async () => {
  const h = harness({ prodOrg: true });
  const result = await h.provision();
  if (!('failure' in result)) throw new Error('Expected a production-guard failure.');
  expect(result.failure.body.errorCode).toBe('APPROVAL_PROD_GUARDED');
  expect(h.posts()).toEqual([]);
  expect(h.state()).toEqual({ submission: null, workItem: null });
});

test('an unreadable org flag refuses provisioning without assuming a sandbox', async () => {
  const h = harness({ orgUnreadable: true });
  const result = await h.provision();
  if (!('failure' in result)) throw new Error('Expected a substrate failure.');
  expect(result.failure.body.errorCode).toBe('APPROVAL_SUBSTRATE_UNREADABLE');
  expect(h.posts()).toEqual([]);
});

test('developer-edition orgs proceed: only non-sandbox non-developer orgs are guarded', async () => {
  expect(isGuardedOrg({ isSandbox: true, orgType: 'Enterprise Edition' })).toBe(false);
  expect(isGuardedOrg({ isSandbox: false, orgType: 'Developer Edition' })).toBe(false);
  expect(isGuardedOrg({ isSandbox: false, orgType: 'Enterprise Edition' })).toBe(true);
  expect(isGuardedOrg({ isSandbox: false, orgType: 'Unlimited Edition' })).toBe(true);
  const h = harness({ devOrg: true });
  const result = await h.provision();
  if ('failure' in result) throw new Error('Developer-edition orgs must provision.');
  expect(result.submissionId).toBe(SUB);
  expect(h.posts()).toEqual(['provision']);
});
