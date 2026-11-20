/**
 * Owned Advanced-Approvals substrate provisioning.
 *
 * The cancel/recall/reassign/review standard actions operate on
 * `ApprovalSubmission` (9iP) and `ApprovalWorkItem` (9jR) identities. Those
 * objects are createable=false and a classic `submit` never produces them, so
 * a lifecycle that only submits can never address the advanced actions.
 *
 * The generic provisioning path is the platform's own
 * `standard_approvals__ProcSimpleAppvl` flow action: invoked with an owned
 * record id, a live submitter user id, comments, information, and a live
 * approver username, it creates one `ApprovalSubmission` with Status
 * `InProgress` plus one `ApprovalWorkItem` with Status `Assigned` for the
 * owned record (verified live in two orgs: submission transitions to
 * Approved/Recalled/Canceled via review/recall/cancel, reassignment moves the
 * assignee while Assigned). Every tenant value below is caller-supplied or
 * read live; no org id, alias, username, or URL appears here.
 */

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

export const APPROVAL_PROVISION_FLOW_NAME = "standard_approvals__ProcSimpleAppvl";
export const APPROVAL_PROVISION_INPUTS = [
  "recordId",
  "submitter",
  "submissionComments",
  "submissionInformation",
  "firstApprover",
] as const;
export const APPROVAL_SUBMISSION_ACTIONABLE = "InProgress";
export const APPROVAL_SUBMISSION_TERMINAL = ["Approved", "Recalled", "Canceled"] as const;
export const APPROVAL_SUBMISSION_DEAD = "Errored";
export const APPROVAL_WORK_ITEM_ACTIONABLE = "Assigned";

/** Bounded settle polling for async approval propagation (review decisions flip seconds after the action returns). */
export type SettlePoll = { attempts: number; delayMs: number };
export const APPROVAL_SETTLE_POLL: SettlePoll = { attempts: 7, delayMs: 2000 };

/** Re-read until `done` passes or the poll budget is exhausted. Returns the last read. */
export async function settle<T>(
  read: () => Promise<T>, done: (value: T) => boolean, poll?: SettlePoll,
): Promise<T> {
  const attempts = poll?.attempts ?? APPROVAL_SETTLE_POLL.attempts;
  const delayMs = poll?.delayMs ?? APPROVAL_SETTLE_POLL.delayMs;
  let value = await read();
  for (let i = 1; i < attempts && !done(value); i++) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    value = await read();
  }
  return value;
}

export const provisionFlowRoute = (root: string): string =>
  `${root}/actions/custom/flow/${APPROVAL_PROVISION_FLOW_NAME}`;

export const isActionableSubmissionStatus = (status: unknown): boolean =>
  status === APPROVAL_SUBMISSION_ACTIONABLE;
export const isTerminalSubmissionStatus = (status: unknown): boolean =>
  typeof status === "string" && (APPROVAL_SUBMISSION_TERMINAL as readonly string[]).includes(status);
export const isActionableWorkItemStatus = (status: unknown): boolean =>
  status === APPROVAL_WORK_ITEM_ACTIONABLE;

const record = (value: unknown): value is Value =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && SF_ID.test(value);

const fail = (errorCode: string, message: string, extra?: Value): Result => ({
  status: 422, ok: false, body: { errorCode, message, ...extra },
});

/** Terminal guard code: approval provisioning refused on a production org. */
export const APPROVAL_PROD_GUARDED_CODE = "APPROVAL_PROD_GUARDED";

const nativeAccepted = (result: Result): boolean => {
  if (!result.ok || !Array.isArray(result.body) || result.body.length === 0) return false;
  return result.body.every((item) =>
    record(item) && item.isSuccess === true &&
    (item.errors === null || item.errors === undefined || (Array.isArray(item.errors) && item.errors.length === 0)) &&
    item.errorCode === undefined && item.errorMessage === undefined);
};

const queryRows = async (
  request: (path: string, method?: string, body?: any) => Promise<Result>,
  root: string, soql: string,
): Promise<Value[] | { failure: Result }> => {
  const response = await request(`${root}/query?q=${encodeURIComponent(soql)}`);
  if (!response.ok) return { failure: response };
  const rows = record(response.body) && Array.isArray(response.body.records)
    ? response.body.records.filter(record) : null;
  if (!rows) return { failure: fail("APPROVAL_SUBSTRATE_UNREADABLE", "The live approval substrate could not be read.") };
  return rows;
};

export type OrgGuardFacts = { isSandbox: boolean; orgType: string };

/**
 * Live org-guard facts from the Organization row. Null when the row is
 * unreadable — the caller must refuse to provision rather than assume a
 * disposable org.
 */
export async function readOrgGuardFacts(
  request: (path: string, method?: string, body?: any) => Promise<Result>,
  root: string,
): Promise<OrgGuardFacts | null> {
  const rows = await queryRows(request, root, "SELECT IsSandbox, OrganizationType FROM Organization LIMIT 1");
  if ("failure" in rows || rows.length !== 1) return null;
  const facts = rows[0];
  if (typeof facts.IsSandbox !== "boolean" || typeof facts.OrganizationType !== "string") return null;
  return { isSandbox: facts.IsSandbox, orgType: facts.OrganizationType };
}

/**
 * True when approval provisioning must be refused on the org. Sandboxes and
 * Developer Edition orgs are disposable, so they proceed; every other
 * non-sandbox org (production, trial production) is guarded. Trial status is
 * deliberately NOT a proceed signal: production orgs can carry a trial date.
 */
export function isGuardedOrg(facts: OrgGuardFacts): boolean {
  if (facts.isSandbox) return false;
  return !/developer/i.test(facts.orgType);
}

export type ProvisionedSubmission = {
  submissionId: string;
  workItemId: string;
  submitterId: string;
  approverUsername: string;
  assigneeId: string | null;
  outcome: unknown;
};

export async function provisionApprovalSubmission(input: {
  root: string;
  /** Owned record the submission is created for. */
  recordId: string;
  /** Execution-user id that owns the record (read back from the live record). */
  ownerId: string;
  comments: string;
  information?: string;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
}): Promise<ProvisionedSubmission | { failure: Result }> {
  const { root, request } = input;
  if (!root.startsWith("/services/data/") || !identity(input.recordId) || !identity(input.ownerId)) {
    return { failure: fail("APPROVAL_PROVISION_IDENTITY_INVALID", "Live record and owner identities are required.") };
  }
  // Production guard: ApprovalSubmission rows are permanent (createable=false,
  // deletable=false), so provisioning never runs on a guarded org. Both the
  // standard advanced actions and the ProcSimpleAppvl flow route funnel
  // through here, so one check covers every provisioning path.
  const facts = await readOrgGuardFacts(request, root);
  if (facts === null) {
    return { failure: fail("APPROVAL_SUBSTRATE_UNREADABLE", "The live org guard facts could not be read; approval provisioning is refused without them.") };
  }
  if (isGuardedOrg(facts)) {
    return { failure: fail(APPROVAL_PROD_GUARDED_CODE, "Approval submission provisioning is disabled on production orgs: ApprovalSubmission rows are permanent and cannot be deleted.") };
  }
  if (typeof input.comments !== "string" || !input.comments.trim() || input.comments.length > 200) {
    return { failure: fail("APPROVAL_PROVISION_COMMENTS_INVALID", "Bounded submission comments are required.") };
  }
  const users = await queryRows(request, root,
    `SELECT Id,Username FROM User WHERE Id='${input.ownerId}' LIMIT 1`);
  if ("failure" in users) return users;
  const approverUsername = users.length === 1 ? users[0].Username : undefined;
  if (users.length !== 1 || typeof approverUsername !== "string" ||
    !approverUsername.trim() || approverUsername.length > 80) {
    return { failure: fail("APPROVAL_APPROVER_UNAVAILABLE", "No live username is available for the owned record owner.") };
  }
  const route = provisionFlowRoute(root);
  const descriptor = await request(route);
  if (!descriptor.ok) {
    return descriptor.status === 404
      ? { failure: { ...fail("APPROVAL_SUBMISSION_SETUP_REQUIRED",
        "The live platform approval flow is absent, so no owned ApprovalSubmission can be provisioned.",
        { setupRequirement: `An invocable ${APPROVAL_PROVISION_FLOW_NAME} flow action in the target org.` }), status: 422, ok: false } }
      : { failure: descriptor };
  }
  const inputs = record(descriptor.body) && Array.isArray(descriptor.body.inputs)
    ? descriptor.body.inputs.filter(record).map((field) => field.name) : [];
  if (APPROVAL_PROVISION_INPUTS.some((name) => !inputs.includes(name))) {
    return { failure: fail("APPROVAL_PROVISION_SCHEMA_MISMATCH", "The live platform approval flow does not declare its required inputs.") };
  }
  const invoked = await request(route, "POST", { inputs: [{
    recordId: input.recordId, submitter: input.ownerId,
    submissionComments: input.comments, submissionInformation: input.information ?? input.comments,
    firstApprover: approverUsername,
  }] });
  if (!nativeAccepted(invoked)) return { failure: invoked };
  const submissions = await queryRows(request, root,
    `SELECT Id,Status FROM ApprovalSubmission WHERE RelatedRecordId='${input.recordId}' LIMIT 2`);
  if ("failure" in submissions) return submissions;
  if (submissions.length !== 1 || !identity(submissions[0].Id)) {
    return { failure: fail("APPROVAL_SUBMISSION_UNVERIFIED",
      "No single ApprovalSubmission was verified for the owned record.", { upstreamOutcome: invoked.body }) };
  }
  if (submissions[0].Status === APPROVAL_SUBMISSION_DEAD) {
    return { failure: fail("APPROVAL_SUBMISSION_ERRORED",
      "The platform approval flow errored instead of producing actionable substrate.", { upstreamOutcome: invoked.body }) };
  }
  if (!isActionableSubmissionStatus(submissions[0].Status)) {
    return { failure: fail("APPROVAL_SUBMISSION_UNVERIFIED",
      "The owned ApprovalSubmission is not in an actionable state.", { upstreamOutcome: invoked.body }) };
  }
  const submissionId = submissions[0].Id as string;
  const items = await queryRows(request, root,
    `SELECT Id,Status,AssignedToId FROM ApprovalWorkItem WHERE ApprovalSubmissionId='${submissionId}' LIMIT 2`);
  if ("failure" in items) return items;
  if (items.length !== 1 || !identity(items[0].Id) || !isActionableWorkItemStatus(items[0].Status)) {
    return { failure: fail("APPROVAL_WORK_ITEM_UNVERIFIED",
      "No single actionable ApprovalWorkItem was verified for the owned submission.", { upstreamOutcome: invoked.body }) };
  }
  const assignee = items[0].AssignedToId;
  return {
    submissionId, workItemId: items[0].Id as string,
    submitterId: input.ownerId, approverUsername,
    assigneeId: typeof assignee === "string" && identity(assignee) ? assignee : null,
    outcome: invoked.body,
  };
}

/**
 * Best-effort sweep of an owned submission toward a terminal state: recall
 * first, cancel when recall leaves it actionable. Never throws; the caller
 * re-reads the returned status to decide cleanup verification.
 */
export async function sweepApprovalSubmission(input: {
  root: string;
  submissionId: string;
  comments: string;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  settlePoll?: SettlePoll;
}): Promise<{ status: string | null }> {
  const { root, request } = input;
  const readStatus = async (): Promise<string | null> => {
    const current = await queryRows(request, root,
      `SELECT Id,Status FROM ApprovalSubmission WHERE Id='${input.submissionId}' LIMIT 1`);
    if ("failure" in current || current.length !== 1) return null;
    return typeof current[0].Status === "string" ? current[0].Status : null;
  };
  const settled = (status: string | null): boolean => status !== null && !isActionableSubmissionStatus(status);
  const terminalize = async (): Promise<string | null> => {
    if (!identity(input.submissionId) || !root.startsWith("/services/data/")) return null;
    try {
      const first = await readStatus();
      if (first === null) return null;
      if (settled(first)) return first;
      await request(`${root}/actions/standard/recallApprovalSubmission`, "POST",
        { inputs: [{ approvalSubmissionId: input.submissionId, comments: input.comments }] });
      const recallStatus = await settle(readStatus, settled, input.settlePoll);
      if (settled(recallStatus)) return recallStatus;
      await request(`${root}/actions/standard/cancelApprovalSubmission`, "POST",
        { inputs: [{ approvalSubmissionId: input.submissionId, comments: input.comments }] });
      return await settle(readStatus, settled, input.settlePoll);
    } catch {
      return null;
    }
  };
  return { status: await terminalize() };
}
