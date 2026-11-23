/**
 * Owned lifecycle for the platform `standard_approvals__ProcSimpleAppvl` flow
 * action ("Process Simple Approval").
 *
 * Unlike its engine-internal siblings (`RqstFlowActv`, which only produces
 * dead `Errored` submissions, and `UpdtFlowDefVer`, whose interviews error for
 * every flow-id form), this flow action is directly invocable: with an owned
 * record, a live submitter, and a live approver it creates one `InProgress`
 * `ApprovalSubmission` plus one `Assigned` `ApprovalWorkItem`, both queryable
 * and both swept by recall/cancel. The lifecycle therefore provisions the
 * owned substrate (which IS the invocation under test), verifies both rows by
 * fresh readback, sweeps the submission to a terminal state, deletes only the
 * owned record, and verifies absence. Terminal `ApprovalSubmission` rows are
 * createable=false/deletable=false, so cleanup asserts terminality, never
 * absence. No org id, alias, username, or URL appears here.
 */

import {
  APPROVAL_PROVISION_FLOW_NAME, APPROVAL_SUBMISSION_ACTIONABLE, APPROVAL_WORK_ITEM_ACTIONABLE, SettlePoll,
  isTerminalSubmissionStatus, provisionApprovalSubmission, provisionFlowRoute, sweepApprovalSubmission,
} from "./approval-submission-provisioning";
import { clampVerificationWindowMs } from "./verification-window";

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

export const APPROVAL_FLOW_OBJECT = "Opportunity";
export const APPROVAL_FLOW_MARKER_FIELD = "Name";

const record = (value: unknown): value is Value =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && SF_ID.test(value);

/** Flow action name from a live custom/flow route tail. Null when not the simple-approval flow. */
export function procSimpleApprovalActionName(route: string): string | null {
  const match = typeof route === "string"
    ? route.match(/^\/services\/data\/v\d+(?:\.\d+)?\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/)
    : null;
  return match?.[1] === APPROVAL_PROVISION_FLOW_NAME ? match[1] : null;
}

const fail = (errorCode: string, message: string, extra?: Value): Result => ({
  status: 422, ok: false, body: { errorCode, message, ...extra },
});

export type ApprovalFlowLifecycleInput = {
  root: string;
  route: string;
  verificationWindowMs?: number;
  /** Settle-poll budget for the cleanup sweep; defaults cover async propagation. */
  settlePoll?: SettlePoll;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
};

export async function invokeProcSimpleApprovalWithContext(input: ApprovalFlowLifecycleInput): Promise<{
  status: number; body: any; cleanupError?: string; contextSchema?: Value;
}> {
  const { root, request } = input;
  const action = procSimpleApprovalActionName(input.route);
  const automaticSteps = [
    "Create an owned Opportunity carrying a unique verifiable marker",
    "Invoke the platform simple-approval flow against the live record",
    "Verify one InProgress ApprovalSubmission and one Assigned ApprovalWorkItem",
    "Sweep the owned submission to a terminal state",
    "Delete only the owned record and verify absence",
  ];
  const base = { source: "salesforce_live_approval_flow", action, targetObject: APPROVAL_FLOW_OBJECT, automaticSteps };
  const done = (outcome: Result, extra: Value): { status: number; body: any; cleanupError?: string; contextSchema?: Value } => ({
    status: outcome.status, body: outcome.body,
    ...(typeof extra.cleanupError === "string" ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...base, ...extra },
  });
  if (!action || !root.startsWith("/services/data/") || input.route !== provisionFlowRoute(root)) {
    return done(fail("APPROVAL_FLOW_ROUTE_INVALID", "A discovered platform simple-approval flow route is required."), { verified: false });
  }
  if (input.verificationWindowMs !== undefined &&
    (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail("APPROVAL_FLOW_WINDOW_INVALID", "A bounded verification window is required."), { verified: false });
  }
  const marker = `AS probe ${crypto.randomUUID()}`;
  const owned: Array<{ objectName: string; id: string }> = [];
  let cleanupError: string | undefined;
  let outcome: Result = fail("APPROVAL_FLOW_CONTEXT_UNAVAILABLE", "The owned approval-flow context could not be prepared.");
  let verified = false;
  let ownedId: string | undefined;
  let submissionId: string | undefined;
  let workItemId: string | undefined;
  let afterStatus: string | undefined;
  try {
    outcome = await (async (): Promise<Result> => {
      const built = await input.build(APPROVAL_FLOW_OBJECT, marker, { [APPROVAL_FLOW_MARKER_FIELD]: marker, Amount: 1 });
      if ("failure" in built) return built.failure;
      const planned = { [APPROVAL_FLOW_MARKER_FIELD]: marker, Amount: 1 };
      const mismatched = Object.entries(planned).filter(([field, value]) => built.values[field] !== value).map(([field]) => field);
      if (mismatched.length) {
        return fail("APPROVAL_FLOW_BUILD_UNSCOPED", "The fixture builder changed a planned ownership field.");
      }
      const created = await request(`${root}/sobjects/${APPROVAL_FLOW_OBJECT}`, "POST", built.values);
      const createdId: unknown = created.body?.id;
      if (!created.ok || !identity(createdId)) return created;
      ownedId = createdId;
      owned.push({ objectName: APPROVAL_FLOW_OBJECT, id: createdId });
      const actual = await request(`${root}/sobjects/${APPROVAL_FLOW_OBJECT}/${ownedId}`);
      const ownerId: unknown = actual.body?.OwnerId;
      if (!actual.ok || actual.body?.[APPROVAL_FLOW_MARKER_FIELD] !== marker || !identity(ownerId)) {
        return fail("APPROVAL_FLOW_FIXTURE_UNVERIFIED", "The owned fixture readback did not carry the marker and a live owner.");
      }
      const provisioned = await provisionApprovalSubmission({
        root, recordId: ownedId, ownerId, comments: marker, request,
      });
      if ("failure" in provisioned) return provisioned.failure;
      submissionId = provisioned.submissionId;
      workItemId = provisioned.workItemId;
      verified = true;
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
      return { status: 200, ok: true, body: provisioned.outcome };
    })();
  } catch {
    if (outcome.body?.errorCode === "APPROVAL_FLOW_CONTEXT_UNAVAILABLE") {
      outcome = fail("APPROVAL_FLOW_LIFECYCLE_UNVERIFIED", "The owned approval-flow lifecycle failed; ownership-scoped cleanup still runs.");
    }
    verified = false;
  } finally {
    if (ownedId) {
      if (submissionId) {
        const swept = await sweepApprovalSubmission({ root, submissionId, comments: marker, request, settlePoll: input.settlePoll });
        afterStatus = swept.status ?? undefined;
        if (afterStatus !== null && afterStatus !== undefined && !isTerminalSubmissionStatus(afterStatus)) {
          cleanupError = "Owned approval-flow submission cleanup could not be verified terminal.";
        }
      }
      if (!cleanupError) {
        await request(`${root}/sobjects/${APPROVAL_FLOW_OBJECT}/${ownedId}`, "DELETE");
        const check = await request(`${root}/sobjects/${APPROVAL_FLOW_OBJECT}/${ownedId}`);
        if (check.status !== 404) {
          cleanupError = "Owned approval-flow fixture cleanup could not be verified; the record may still exist.";
        } else {
          const swept = await request(`${root}/query?q=${encodeURIComponent(
            `SELECT Id FROM ${APPROVAL_FLOW_OBJECT} WHERE ${APPROVAL_FLOW_MARKER_FIELD}='${marker}' LIMIT 2`)}`);
          const rows = record(swept.body) && Array.isArray(swept.body.records) ? swept.body.records : null;
          if (!swept.ok || !rows || rows.length > 0) {
            cleanupError = "Owned approval-flow fixture cleanup could not be verified; a marker-scoped sibling may remain.";
          }
        }
      }
    }
  }
  return done(outcome, {
    verified: cleanupError ? false : verified,
    marker, markerField: APPROVAL_FLOW_MARKER_FIELD,
    ownedRecordId: ownedId ?? null,
    approvalSubmissionId: submissionId ?? null, approvalWorkItemId: workItemId ?? null,
    beforeStatus: submissionId ? APPROVAL_SUBMISSION_ACTIONABLE : null,
    workItemStatus: workItemId ? APPROVAL_WORK_ITEM_ACTIONABLE : null,
    afterStatus: afterStatus ?? null,
    verificationRecordIds: ownedId ? [ownedId] : [], ownedRecords: owned,
    ...(cleanupError ? { cleanupError } : {}),
  });
}
