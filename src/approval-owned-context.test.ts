import { test, expect } from 'bun:test';
import { approvalActionName, buildApprovalProcessMetadata, invokeApprovalActionWithContext } from './approval-owned-context';
import { APPROVAL_PROVISION_INPUTS, provisionFlowRoute } from './approval-submission-provisioning';

test('approval routes classify by live route tail only', () => {
  const root = '/services/data/v67.0';
  expect(approvalActionName(`${root}/actions/standard/submit`)).toBe('submit');
  expect(approvalActionName(`${root}/actions/standard/cancelApprovalSubmission`)).toBe('cancelApprovalSubmission');
  expect(approvalActionName(`${root}/actions/standard/reassignApprovalWorkItem`)).toBe('reassignApprovalWorkItem');
  expect(approvalActionName(`${root}/actions/standard/recallApprovalSubmission`)).toBe('recallApprovalSubmission');
  expect(approvalActionName(`${root}/actions/standard/reviewApprovalWorkItem`)).toBe('reviewApprovalWorkItem');
  expect(approvalActionName(`${root}/actions/standard/createRecord`)).toBeNull();
  expect(approvalActionName(`${root}/actions/custom/flow/standard_approvals__ProcSimpleAppvl`)).toBeNull();
  expect(approvalActionName('not a route')).toBeNull();
});

test('approval process metadata embeds only caller-supplied live values', () => {
  const built = buildApprovalProcessMetadata({ developerName: 'AS_Approval_abc123', label: 'AS Approval abc123', approverUsername: 'someone@example.com' });
  if ('failure' in built) throw new Error('Unexpected metadata failure.');
  expect(built.path).toBe('approvalProcesses/Opportunity.AS_Approval_abc123.approvalProcess-meta.xml');
  expect(built.xml).toContain('<active>true</active>');
  expect(built.xml).toContain('<name>someone@example.com</name>');
  expect(built.xml).toContain('<field>Opportunity.Amount</field>');
  expect(built.xml).toContain('<finalApprovalRecordLock>false</finalApprovalRecordLock>');
  expect('failure' in buildApprovalProcessMetadata({ developerName: '00bad', label: 'x', approverUsername: 'a@b.c' })).toBe(true);
  expect('failure' in buildApprovalProcessMetadata({ developerName: 'Good_Name', label: 'x', approverUsername: 'not-a-username' })).toBe(true);
  expect('failure' in buildApprovalProcessMetadata({ developerName: 'Good_Name', label: '', approverUsername: 'a@b.c' })).toBe(true);
});

type HarnessOptions = { submitError?: string; freezeTransition?: boolean; flowAbsent?: boolean; erroredProvision?: boolean; noOtherUser?: boolean; slowTransition?: boolean; prodOrg?: boolean };
function harness(action: string, options: HarnessOptions = {}) {
  const root = '/services/data/v67.0';
  const route = `${root}/actions/standard/${action}`;
  const provisionRoute = provisionFlowRoute(root);
  let opp: any = null, instance: any = null, submission: any = null, workItem: any = null;
  let invoked = false, flipped = false, lastArgs: any = null, verifyReads = 0;
  const posts: string[] = [];
  const queries: string[] = [];
  const owner = '005000000000001AAA';
  const otherUser = '005000000000002AAA';
  const inputs: Record<string, string[]> = {
    submit: ['objectId'],
    cancelApprovalSubmission: ['approvalSubmissionId', 'comments'],
    recallApprovalSubmission: ['approvalSubmissionId', 'comments'],
    reassignApprovalWorkItem: ['approvalWorkItemId', 'assigneeId', 'comments'],
    reviewApprovalWorkItem: ['approvalWorkItemId', 'approvalDecision', 'comments'],
  };
  const success = (extra: any = {}) => ({ status: 200, ok: true, body: [{ isSuccess: true, errors: [], ...extra }] });
  const request = async (path: string, method = 'GET', body?: any): Promise<{ status: number; ok: boolean; body: any }> => {
    const result = (responseBody: any, status = 200) => ({ body: responseBody, status, ok: status < 400 });
    if (method === 'GET' && path === route) return result({ inputs: (inputs[action] ?? []).map((name) => ({ name })) });
    if (method === 'GET' && path === provisionRoute) {
      if (options.flowAbsent) return result([{ message: 'Not found', errorCode: 'NOT_FOUND' }], 404);
      return result({ inputs: [...APPROVAL_PROVISION_INPUTS].map((name) => ({ name })) });
    }
    if (method === 'POST' && path === provisionRoute) {
      posts.push('provision');
      submission = { Id: '9iP000000000001AAA', Status: options.erroredProvision ? 'Errored' : 'InProgress' };
      workItem = { Id: '9jR000000000001AAA', Status: 'Assigned', AssignedToId: owner };
      return success();
    }
    if (path === `${root}/sobjects/Opportunity` && method === 'POST') {
      opp = { ...body, Id: '006000000000001AAA', OwnerId: owner };
      return result({ id: opp.Id }, 201);
    }
    if (path === `${root}/sobjects/Opportunity/006000000000001AAA`) {
      if (method === 'DELETE') {
        if (instance && instance.Status === 'Pending') return result([{ message: 'Record is locked for approval', errorCode: 'UNABLE_TO_DELETE' }], 400);
        if (submission && submission.Status === 'InProgress') return result([{ message: 'Record is locked for approval', errorCode: 'UNABLE_TO_DELETE' }], 400);
        opp = null; instance = null; submission = null; workItem = null; return result(null, 204);
      }
      return opp ? result(opp) : result([], 404);
    }
    if (method === 'POST' && path === `${root}/process/approvals`) {
      posts.push('recall');
      const call = body?.requests?.[0];
      if (instance && call?.actionType === 'Recall' && call?.contextId === instance.Id) instance.Status = 'Recalled';
      return success();
    }
    if (method === 'POST' && path === `${root}/actions/standard/submit`) {
      posts.push('submit');
      if (options.submitError) return result([{ isSuccess: false, errors: [{ message: options.submitError }] }]);
      instance = { Id: '04g000000000001AAA', Status: 'Pending' };
      return success({ outputValues: { instanceId: instance.Id, instanceStatus: 'Pending' } });
    }
    const flip = () => {
      // Live terminal labels: cancel uses Canceled (one L).
      if (action === 'cancelApprovalSubmission') submission.Status = 'Canceled';
      if (action === 'recallApprovalSubmission') submission.Status = 'Recalled';
      if (action === 'reassignApprovalWorkItem') { workItem.AssignedToId = lastArgs.assigneeId; }
      if (action === 'reviewApprovalWorkItem') { workItem.Status = 'Approved'; submission.Status = 'Approved'; }
    };
    if (method === 'POST' && path === route && action !== 'submit') {
      posts.push(action);
      invoked = true;
      lastArgs = body.inputs[0];
      if (!options.freezeTransition && !options.slowTransition) flip();
      return success();
    }
    if (method === 'POST' && path === `${root}/actions/standard/recallApprovalSubmission` && action !== 'recallApprovalSubmission') {
      posts.push('sweep-recall');
      if (submission && submission.Status === 'InProgress') submission.Status = 'Recalled';
      return success();
    }
    if (method === 'POST' && path === `${root}/actions/standard/cancelApprovalSubmission` && action !== 'cancelApprovalSubmission') {
      posts.push('sweep-cancel');
      if (submission && submission.Status === 'InProgress') submission.Status = 'Canceled';
      return success();
    }
    // Slow transitions land between the first and second post-invoke read.
    const maybeFlip = () => {
      if (!options.slowTransition || !invoked || flipped) return;
      verifyReads++;
      if (verifyReads >= 2) { flipped = true; flip(); }
    };
    if (path.includes('/query?q=')) {
      const query = decodeURIComponent(path.split('?q=')[1]);
      queries.push(query);
      if (query.includes('FROM Organization')) return result({ records: [options.prodOrg
        ? { IsSandbox: false, OrganizationType: 'Enterprise Edition' }
        : { IsSandbox: false, OrganizationType: 'Developer Edition' }] });
      if (query.includes('FROM ProcessInstance')) return result({ records: instance ? [instance] : [] });
      if (query.includes('FROM ApprovalSubmission')) {
        maybeFlip();
        return result({ records: submission ? [submission] : [] });
      }
      if (query.includes('FROM ApprovalWorkItem')) {
        maybeFlip();
        return result({ records: workItem ? [workItem] : [] });
      }
      if (query.includes('FROM User')) {
        if (query.includes(`WHERE Id='${owner}'`)) return result({ records: [{ Id: owner, Username: 'owner@example.com', UserType: 'Standard' }] });
        return result({ records: options.noOtherUser ? [] : [{ Id: otherUser, UserType: 'Standard' }] });
      }
      if (query.includes('FROM Opportunity')) return result({ records: opp ? [opp] : [] });
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const invoke = (extra: any = {}) => invokeApprovalActionWithContext({ root, route, request,
    settlePoll: { attempts: 2, delayMs: 0 }, build: async (_, __, values) => ({ values }), ...extra });
  const state = () => ({ opp, instance, submission, workItem, posts });
  return { root, route, request, invoke, state, owner, otherUser, queries };
}

test('submit verifies a Pending ProcessInstance and cleans the owned fixture', async () => {
  const h = harness('submit');
  const result = await h.invoke();
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.processInstanceId).toBe('04g000000000001AAA');
  expect(result.contextSchema?.verificationRecordIds).toHaveLength(1);
  expect(h.state().opp).toBeNull();
  expect(h.state().instance).toBeNull();
  expect(result.cleanupError).toBeUndefined();
});

test('cleanup recalls the pending instance so the locked fixture deletes', async () => {
  const h = harness('submit');
  const result = await h.invoke();
  expect(h.state().posts).toEqual(['submit', 'recall']);
  expect(h.state().opp).toBeNull();
  expect(result.cleanupError).toBeUndefined();
  expect(result.contextSchema?.verified).toBe(true);
});

test('submit without an active process is an explicit setup requirement', async () => {
  const h = harness('submit', { submitError: 'No active approval process found for Opportunity.' });
  const result = await h.invoke();
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe('APPROVAL_PROCESS_SETUP_REQUIRED');
  expect(h.state().opp).toBeNull();
});

test('submit and advanced actions are guarded on production orgs', async () => {
  const submitted = harness('submit', { prodOrg: true });
  const submitResult = await submitted.invoke();
  expect(submitResult.status).toBe(422);
  expect(submitResult.body.errorCode).toBe('APPROVAL_PROD_GUARDED');
  expect(submitted.state().posts).toEqual([]);
  expect(submitted.state().opp).toBeNull();
  const cancelled = harness('cancelApprovalSubmission', { prodOrg: true });
  const cancelResult = await cancelled.invoke();
  expect(cancelResult.status).toBe(422);
  expect(cancelResult.body.errorCode).toBe('APPROVAL_PROD_GUARDED');
  expect(cancelled.state().posts).toEqual([]);
  expect(cancelled.state().opp).toBeNull();
});

test('cancel without the platform flow never invokes with a fabricated identity', async () => {
  const h = harness('cancelApprovalSubmission', { flowAbsent: true });
  const result = await h.invoke();
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe('APPROVAL_SUBMISSION_SETUP_REQUIRED');
  expect(h.state().posts).toEqual([]);
  expect(h.state().opp).toBeNull();
  expect(result.cleanupError).toBeUndefined();
});

test('cancel provisions substrate, verifies the terminal state, and cleans owned state', async () => {
  const h = harness('cancelApprovalSubmission');
  const result = await h.invoke();
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.beforeStatus).toBe('InProgress');
  expect(result.contextSchema?.afterStatus).toBe('Canceled');
  expect(h.state().posts).toEqual(['provision', 'cancelApprovalSubmission']);
  expect(h.state().opp).toBeNull();
  expect(result.cleanupError).toBeUndefined();
});

test('recall verifies the terminal state', async () => {
  const h = harness('recallApprovalSubmission');
  const result = await h.invoke();
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.afterStatus).toBe('Recalled');
  expect(h.state().posts).toEqual(['provision', 'recallApprovalSubmission']);
  expect(h.state().opp).toBeNull();
});

test('reassign verifies the new assignee while still assigned', async () => {
  const h = harness('reassignApprovalWorkItem');
  const result = await h.invoke({ reassignUserId: '005000000000002AAA' });
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.assigneeAfter).toBe('005000000000002AAA');
  expect(h.state().opp).toBeNull();
});

test('reassign without a target discovers a live Standard user', async () => {
  const h = harness('reassignApprovalWorkItem');
  const result = await h.invoke();
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.assigneeAfter).toBe(h.otherUser);
  const discovery = h.queries.find((q) => q.includes('FROM User') && q.includes('IsActive'));
  expect(discovery).toContain("UserType='Standard'");
  expect(discovery).toContain(`Id!='${h.owner}'`);
  expect(h.state().opp).toBeNull();
});

test('reassign to the current assignee falls back to another live user', async () => {
  const h = harness('reassignApprovalWorkItem');
  const result = await h.invoke({ reassignUserId: h.owner });
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.assigneeAfter).toBe(h.otherUser);
  expect(result.contextSchema?.requestedAssignee).toBe(h.owner);
  expect(h.state().posts).toContain('reassignApprovalWorkItem');
  expect(h.state().opp).toBeNull();
});

test('reassign is a noop only when no other live user exists', async () => {
  const h = harness('reassignApprovalWorkItem', { noOtherUser: true });
  const result = await h.invoke({ reassignUserId: h.owner });
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe('APPROVAL_REASSIGN_NOOP');
  expect(h.state().posts).not.toContain('reassignApprovalWorkItem');
  expect(h.state().opp).toBeNull();
});

test('review verifies approval of the owned submission', async () => {
  const h = harness('reviewApprovalWorkItem');
  const result = await h.invoke();
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.afterStatus).toBe('Approved');
  expect(h.state().opp).toBeNull();
});

test('a slow approval transition settles instead of failing', async () => {
  const h = harness('reviewApprovalWorkItem', { slowTransition: true });
  const result = await h.invoke();
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.afterStatus).toBe('Approved');
  expect(h.state().opp).toBeNull();
  expect(result.cleanupError).toBeUndefined();
});

test('a slow reassignment settles instead of failing', async () => {
  const h = harness('reassignApprovalWorkItem', { slowTransition: true });
  const result = await h.invoke({ reassignUserId: h.otherUser });
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.assigneeAfter).toBe(h.otherUser);
  expect(h.state().opp).toBeNull();
});

test('native success without a transition is rejected and swept', async () => {
  const h = harness('cancelApprovalSubmission', { freezeTransition: true });
  const result = await h.invoke();
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe('APPROVAL_TRANSITION_UNVERIFIED');
  expect(h.state().posts).toEqual(['provision', 'cancelApprovalSubmission', 'sweep-recall']);
  expect(h.state().opp).toBeNull();
  expect(result.cleanupError).toBeUndefined();
});

test('an errored provisioning run fails without invoking the action', async () => {
  const h = harness('reviewApprovalWorkItem', { erroredProvision: true });
  const result = await h.invoke();
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe('APPROVAL_SUBMISSION_ERRORED');
  expect(h.state().posts).toEqual(['provision']);
  expect(h.state().opp).toBeNull();
});

test('fixture readback mismatch never submits', async () => {
  const h = harness('submit');
  const request = async (path: string, method = 'GET', body?: any) => {
    const result = await h.request(path, method, body);
    if (method === 'GET' && path.endsWith('/006000000000001AAA') && result.ok) {
      return { ...result, body: { ...result.body, Name: 'tampered' } };
    }
    return result;
  };
  const result = await invokeApprovalActionWithContext({ root: h.root, route: h.route, request, build: async (_, __, values) => ({ values }) });
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe('APPROVAL_FIXTURE_UNVERIFIED');
  expect(h.state().posts).toEqual([]);
});

test('a builder that changes ownership fields is rejected', async () => {
  const h = harness('submit');
  const result = await invokeApprovalActionWithContext({ root: h.root, route: h.route, request: h.request, build: async () => ({ values: { Name: 'other', Amount: 2 } }) });
  expect(result.body.errorCode).toBe('APPROVAL_BUILD_UNSCOPED');
  expect(result.contextSchema).toMatchObject({ buildMismatch: { mismatchedFields: ['Name', 'Amount'], builtFields: ['Name', 'Amount'] } });
});

test('an undiscovered route is rejected before any request', async () => {
  let called = false;
  const result = await invokeApprovalActionWithContext({ root: '/services/data/v67.0', route: '/services/data/v67.0/actions/standard/createRecord',
    request: async () => { called = true; throw new Error('Must not execute'); }, build: async () => ({ values: {} }) });
  expect(result.body.errorCode).toBe('APPROVAL_ACTION_INVALID');
  expect(called).toBe(false);
});
