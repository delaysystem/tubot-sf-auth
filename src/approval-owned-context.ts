/**
 * Owned approval-action lifecycle.
 *
 * Two Salesforce approval frameworks share the Actions catalog but not their
 * records, and the distinction decides what can be verified:
 *
 * - Standard approvals: the `submit` invocable action creates a
 *   `ProcessInstance` (Status Pending) plus a `ProcessInstanceWorkitem` for an
 *   owned record once an active ApprovalProcess exists. Both are queryable, so
 *   submission and cleanup are independently verifiable.
 * - Flow-orchestrated approvals: `cancel`, `recall`, `reassign` and `review`
 *   act on `ApprovalSubmission` (id prefix 9iP) and `ApprovalWorkItem` (9jR)
 *   identities. Those objects are createable=false and a classic `submit`
 *   never creates them (verified: zero ApprovalSubmission rows org-wide after
 *   a successful classic submit). They ARE generically provisionable: the
 *   platform's own `standard_approvals__ProcSimpleAppvl` flow action creates
 *   one `InProgress` submission plus one `Assigned` workitem for an owned
 *   record from live submitter/approver identities (see
 *   approval-submission-provisioning.ts).
 *
 * This module therefore runs one owned Opportunity fixture per invocation,
 * provisions owned advanced-approvals substrate on demand, and refuses to
 * fabricate identities: when the platform approval flow is absent the
 * advanced actions return an explicit setup-gated failure instead of invoking
 * with a guessed id. No org id, alias, username, or URL appears here; every
 * tenant value is caller-supplied or read live.
 */

import {
  APPROVAL_PROD_GUARDED_CODE, APPROVAL_SUBMISSION_ACTIONABLE, APPROVAL_WORK_ITEM_ACTIONABLE, SettlePoll, isActionableSubmissionStatus,
  isGuardedOrg, isTerminalSubmissionStatus, provisionApprovalSubmission, readOrgGuardFacts, settle, sweepApprovalSubmission,
} from "./approval-submission-provisioning";
import { clampVerificationWindowMs } from "./verification-window";

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const DEV_NAME = /^[A-Za-z][A-Za-z0-9_]{0,37}$/;
const USERNAME = /^[^\s@]+@[^\s@]+$/;

export const APPROVAL_SUBMIT_ACTION = "submit";
export const APPROVAL_ADVANCED_ACTIONS = [
  "cancelApprovalSubmission",
  "reassignApprovalWorkItem",
  "recallApprovalSubmission",
  "reviewApprovalWorkItem",
] as const;
export type ApprovalAdvancedAction = (typeof APPROVAL_ADVANCED_ACTIONS)[number];
export const APPROVAL_FIXTURE_OBJECT = "Opportunity";
export const APPROVAL_FIXTURE_MARKER_FIELD = "Name";

const record = (value: unknown): value is Value =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && SF_ID.test(value);

/** Action name from a live standard-action route tail. Null when not approval-family. */
export function approvalActionName(route: string): string | null {
  const match = typeof route === "string" ? route.match(/^\/services\/data\/v\d+(?:\.\d+)?\/actions\/standard\/([A-Za-z][A-Za-z0-9_]{0,127})$/) : null;
  const name = match?.[1] ?? null;
  return name !== null && (name === APPROVAL_SUBMIT_ACTION || (APPROVAL_ADVANCED_ACTIONS as readonly string[]).includes(name)) ? name : null;
}

/**
 * Build deployable sfdx-format ApprovalProcess metadata from live values.
 * The approver username, developer name and label are caller-supplied (read
 * from the target org's live User/metadata context by the provisioning step);
 * nothing tenant-specific is embedded here.
 */
export function buildApprovalProcessMetadata(input: {
  developerName: string;
  label: string;
  approverUsername: string;
  entryField?: string;
  entryOperation?: string;
  entryValue?: string;
}): { path: string; xml: string } | { failure: string } {
  const entryField = input.entryField ?? "Opportunity.Amount";
  const entryOperation = input.entryOperation ?? "greaterThan";
  const entryValue = input.entryValue ?? "0";
  if (!DEV_NAME.test(input.developerName)) return { failure: "A valid approval process developer name is required." };
  if (typeof input.label !== "string" || !input.label.trim() || input.label.length > 80) {
    return { failure: "A bounded approval process label is required." };
  }
  if (!USERNAME.test(input.approverUsername) || input.approverUsername.length > 80) {
    return { failure: "A live approver username is required." };
  }
  // Entry criteria reference the live object field; the fixture satisfies it with Amount=1.
  if (!/^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/.test(entryField)) {
    return { failure: "A live object.field entry criterion is required." };
  }
  if (!/^[A-Za-z]+$/.test(entryOperation)) return { failure: "A live entry criterion operation is required." };
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <allowRecall>true</allowRecall>
    <allowedSubmitters>
        <type>owner</type>
    </allowedSubmitters>
    <approvalStep>
        <allowDelegate>false</allowDelegate>
        <assignedApprover>
            <approver>
                <name>${input.approverUsername}</name>
                <type>user</type>
            </approver>
            <whenMultipleApprovers>FirstResponse</whenMultipleApprovers>
        </assignedApprover>
        <label>AS Step</label>
        <name>AS_Step</name>
    </approvalStep>
    <enableMobileDeviceAccess>true</enableMobileDeviceAccess>
    <entryCriteria>
        <criteriaItems>
            <field>${entryField}</field>
            <operation>${entryOperation}</operation>
            <value>${entryValue}</value>
        </criteriaItems>
    </entryCriteria>
    <finalApprovalRecordLock>false</finalApprovalRecordLock>
    <finalRejectionRecordLock>false</finalRejectionRecordLock>
    <label>${input.label}</label>
    <recordEditability>AdminOrCurrentApprover</recordEditability>
    <showApprovalHistory>true</showApprovalHistory>
</ApprovalProcess>
`;
  return { path: `approvalProcesses/Opportunity.${input.developerName}.approvalProcess-meta.xml`, xml };
}

const fail = (errorCode: string, message: string, extra?: Value): Result => ({
  status: 422, ok: false, body: { errorCode, message, ...extra },
});

const nativeAccepted = (result: Result): boolean => {
  if (!result.ok || !Array.isArray(result.body) || result.body.length === 0) return false;
  return result.body.every((item) =>
    record(item) && item.isSuccess === true &&
    (item.errors === null || item.errors === undefined || (Array.isArray(item.errors) && item.errors.length === 0)) &&
    item.errorCode === undefined && item.errorMessage === undefined);
};

const errorText = (body: unknown): string => {
  const parts: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4) return;
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    if (!record(node)) return;
    for (const key of ["message", "errorCode"]) {
      if (typeof node[key] === "string" && node[key].length) parts.push(node[key]);
    }
    for (const key of ["errors", "outputValues", "result", "body"]) {
      if (node[key] !== undefined && node[key] !== null) visit(node[key], depth + 1);
    }
  };
  visit(body, 0);
  return parts.join("; ").slice(0, 500);
};

export type ApprovalLifecycleInput = {
  root: string;
  route: string;
  verificationWindowMs?: number;
  /** Settle-poll budget for async approval propagation; defaults cover the observed multi-second flip. */
  settlePoll?: SettlePoll;
  /** Assignee for reassign; otherwise the first live active Standard user distinct from the current assignee. */
  reassignUserId?: string;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
};

export async function invokeApprovalActionWithContext(input: ApprovalLifecycleInput): Promise<{
  status: number; body: any; cleanupError?: string; contextSchema?: Value;
}> {
  const { root, request } = input;
  const action = approvalActionName(input.route);
  const advancedRoute = action !== null && action !== APPROVAL_SUBMIT_ACTION;
  const automaticSteps = advancedRoute ? [
    "Create an owned Opportunity carrying a unique verifiable marker",
    "Provision one owned ApprovalSubmission via the live platform approval flow",
    "Invoke the approval action against the live submission identity",
    "Verify the state transition by fresh target readback",
    "Sweep the owned submission to a terminal state",
    "Delete only the owned record and verify absence",
  ] : [
    "Provision one owned active Opportunity approval process from live metadata",
    "Create an owned Opportunity carrying a unique verifiable marker",
    "Submit the owned record and verify a Pending ProcessInstance",
    "Invoke the approval action against the live submission identity",
    "Verify the state transition by fresh target readback",
    "Delete only the owned record and verify absence",
  ];
  const base = { source: "salesforce_live_approval_action", action, targetObject: APPROVAL_FIXTURE_OBJECT, automaticSteps };
  const done = (outcome: Result, extra: Value): { status: number; body: any; cleanupError?: string; contextSchema?: Value } => ({
    status: outcome.status, body: outcome.body,
    ...(typeof extra.cleanupError === "string" ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...base, ...extra },
  });
  if (!action || !root.startsWith("/services/data/") || !input.route.startsWith(`${root}/actions/`)) {
    return done(fail("APPROVAL_ACTION_INVALID", "A discovered standard approval action route is required."), { verified: false });
  }
  if (input.verificationWindowMs !== undefined &&
    (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail("APPROVAL_WINDOW_INVALID", "A bounded verification window is required."), { verified: false });
  }
  if (input.settlePoll !== undefined &&
    (!Number.isInteger(input.settlePoll.attempts) || input.settlePoll.attempts < 1 || input.settlePoll.attempts > 10 ||
      !Number.isInteger(input.settlePoll.delayMs) || input.settlePoll.delayMs < 0 || input.settlePoll.delayMs > 5000)) {
    return done(fail("APPROVAL_SETTLE_INVALID", "A bounded settle-poll budget is required."), { verified: false });
  }
  if (input.reassignUserId !== undefined && !identity(input.reassignUserId)) {
    return done(fail("APPROVAL_REASSIGN_IDENTITY_INVALID", "A live user identity is required for reassignment."), { verified: false });
  }
  const requiredInputs: Record<string, string[]> = {
    submit: ["objectId"],
    cancelApprovalSubmission: ["approvalSubmissionId"],
    recallApprovalSubmission: ["approvalSubmissionId"],
    reassignApprovalWorkItem: ["approvalWorkItemId", "assigneeId"],
    reviewApprovalWorkItem: ["approvalWorkItemId", "approvalDecision"],
  };
  const marker = `AS probe ${crypto.randomUUID()}`;
  const owned: Array<{ objectName: string; id: string }> = [];
  let cleanupError: string | undefined;
  let outcome: Result = fail("APPROVAL_CONTEXT_UNAVAILABLE", "The owned approval context could not be prepared.");
  let verified = false;
  let ownedId: string | undefined;
  let instanceId: string | undefined;
  let submissionId: string | undefined;
  let workItemId: string | undefined;
  let beforeStatus: string | undefined;
  let requestedAssignee: string | undefined;
  let buildMismatch: Value | undefined;
  let afterStatus: string | undefined;
  let assigneeBefore: string | undefined;
  let assigneeAfter: string | undefined;
  try {
    outcome = await (async (): Promise<Result> => {
      const descriptor = await request(input.route);
      if (!descriptor.ok) return descriptor;
      const inputs = record(descriptor.body) && Array.isArray(descriptor.body.inputs)
        ? descriptor.body.inputs.filter(record).map((field) => field.name) : [];
      if (requiredInputs[action].some((name) => !inputs.includes(name))) {
        return fail("APPROVAL_ACTION_SCHEMA_MISMATCH", "The live approval action does not declare its required inputs.");
      }
      const built = await input.build(APPROVAL_FIXTURE_OBJECT, marker, { [APPROVAL_FIXTURE_MARKER_FIELD]: marker, Amount: 1 });
      if ("failure" in built) return built.failure;
      const planned = { [APPROVAL_FIXTURE_MARKER_FIELD]: marker, Amount: 1 };
      const mismatched = Object.entries(planned).filter(([field, value]) => built.values[field] !== value).map(([field]) => field);
      if (mismatched.length) {
        buildMismatch = { mismatchedFields: mismatched, builtFields: Object.keys(built.values) };
        return fail("APPROVAL_BUILD_UNSCOPED", "The fixture builder changed a planned ownership field.");
      }
      const created = await request(`${root}/sobjects/${APPROVAL_FIXTURE_OBJECT}`, "POST", built.values);
      const createdId: unknown = created.body?.id;
      if (!created.ok || !identity(createdId)) return created;
      ownedId = createdId;
      owned.push({ objectName: APPROVAL_FIXTURE_OBJECT, id: createdId });
      const actual = await request(`${root}/sobjects/${APPROVAL_FIXTURE_OBJECT}/${ownedId}`);
      if (!actual.ok || actual.body?.[APPROVAL_FIXTURE_MARKER_FIELD] !== marker) {
        return fail("APPROVAL_FIXTURE_UNVERIFIED", "The owned fixture readback did not carry the marker.");
      }
      if (action === APPROVAL_SUBMIT_ACTION) {
        // Production guard: a classic submit mints permanent ProcessInstance
        // rows, so it never runs on a guarded org (mirrors the
        // submission-provisioning guard covering the advanced actions).
        const facts = await readOrgGuardFacts(request, root);
        if (facts === null) {
          return fail("APPROVAL_SUBSTRATE_UNREADABLE", "The live org guard facts could not be read; approval submit is refused without them.");
        }
        if (isGuardedOrg(facts)) {
          return fail(APPROVAL_PROD_GUARDED_CODE, "Classic approval submit is disabled on production orgs: ProcessInstance rows are permanent and cannot be deleted.");
        }
        const submitted = await request(`${root}/actions/standard/submit`, "POST", { inputs: [{ objectId: ownedId }] });
        if (!nativeAccepted(submitted)) {
          if (/no[^A-Za-z]*active[^A-Za-z]*approval|no applicable approval|approval process[^A-Za-z]*not found/i.test(errorText(submitted.body))) {
            return { ...fail("APPROVAL_PROCESS_SETUP_REQUIRED",
              "No active ApprovalProcess accepts the owned record. Provision one owned Opportunity approval process from live metadata, then retry.",
              { setupRequirement: "One active owned Opportunity ApprovalProcess deployed from live metadata.", upstreamOutcome: submitted.body }), status: 422, ok: false };
          }
          return submitted;
        }
        const instances = await request(`${root}/query?q=${encodeURIComponent(
          `SELECT Id,Status FROM ProcessInstance WHERE TargetObjectId='${ownedId}' LIMIT 2`)}`);
        const instanceRows = record(instances.body) && Array.isArray(instances.body.records) ? instances.body.records.filter(record) : [];
        if (!instances.ok || instanceRows.length !== 1 || instanceRows[0].Status !== "Pending" || !identity(instanceRows[0].Id)) {
          return fail("APPROVAL_SUBMISSION_UNVERIFIED",
            "No single Pending ProcessInstance was verified for the owned submitted record.", { upstreamOutcome: submitted.body });
        }
        instanceId = instanceRows[0].Id as string;
        verified = true;
        if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
        return submitted;
      }
      // Advanced actions address flow-orchestrated substrate, which a classic
      // submit never creates, so provision it directly from live identities.
      // A classic submit here would only lock the owned record.
      const owner: unknown = actual.body?.OwnerId;
      if (!identity(owner)) {
        return fail("APPROVAL_OWNER_UNAVAILABLE", "The owned fixture readback exposed no live owner identity.");
      }
      const provisioned = await provisionApprovalSubmission({ root, recordId: ownedId, ownerId: owner, comments: marker, request });
      if ("failure" in provisioned) return provisioned.failure;
      submissionId = provisioned.submissionId;
      workItemId = provisioned.workItemId;
      beforeStatus = APPROVAL_SUBMISSION_ACTIONABLE;
      assigneeBefore = provisioned.assigneeId ?? undefined;
      let args: Value;
      if (action === "cancelApprovalSubmission" || action === "recallApprovalSubmission") {
        args = { approvalSubmissionId: submissionId, comments: marker };
      } else if (action === "reassignApprovalWorkItem") {
        let assignee = input.reassignUserId;
        if (assignee !== undefined && assignee === assigneeBefore) {
          // The channel default can equal the live assignee; fall back to
          // another live active user instead of failing a verifiable move.
          requestedAssignee = assignee;
          assignee = undefined;
        }
        if (!assignee) {
          // Standard users only: Automated Process, integration, and guest
          // identities are active but cannot be assigned approval steps.
          const users = await request(`${root}/query?q=${encodeURIComponent(
            `SELECT Id FROM User WHERE IsActive=true AND UserType='Standard' AND Id!='${assigneeBefore ?? ""}' LIMIT 1`)}`);
          const userRows = record(users.body) && Array.isArray(users.body.records) ? users.body.records.filter(record) : [];
          if (!users.ok || userRows.length !== 1 || !identity(userRows[0].Id)) {
            return requestedAssignee === undefined
              ? fail("APPROVAL_REASSIGN_TARGET_UNAVAILABLE", "No live active Standard user distinct from the current assignee is available.")
              : fail("APPROVAL_REASSIGN_NOOP", "Reassignment requires a user distinct from the current assignee, and no other live active Standard user exists.");
          }
          assignee = userRows[0].Id as string;
        }
        args = { approvalWorkItemId: workItemId, assigneeId: assignee, comments: marker };
      } else {
        args = { approvalWorkItemId: workItemId, approvalDecision: "Approve", comments: marker };
      }
      const invoked = await request(input.route, "POST", { inputs: [args] });
      const accepted = nativeAccepted(invoked);
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
      if (action === "reassignApprovalWorkItem") {
        const readItem = async (): Promise<Value[] | null> => {
          const reread = await request(`${root}/query?q=${encodeURIComponent(
            `SELECT Id,Status,AssignedToId FROM ApprovalWorkItem WHERE Id='${workItemId}' LIMIT 1`)}`);
          return record(reread.body) && Array.isArray(reread.body.records) ? reread.body.records.filter(record) : null;
        };
        const rows = await settle(readItem,
          (found) => found !== null && found.length === 1 && found[0].AssignedToId !== assigneeBefore,
          input.settlePoll) ?? [];
        assigneeAfter = rows.length === 1 && typeof rows[0].AssignedToId === "string" ? rows[0].AssignedToId : undefined;
        verified = accepted && rows.length === 1 && rows[0].Status === APPROVAL_WORK_ITEM_ACTIONABLE && assigneeAfter === args.assigneeId && assigneeAfter !== assigneeBefore;
        if (!verified) {
          return accepted
            ? fail("APPROVAL_REASSIGN_UNVERIFIED", "Salesforce reported success without the verified owned reassignment.", { upstreamOutcome: invoked.body })
            : invoked;
        }
        return invoked;
      }
      const readSubmission = async (): Promise<Value[] | null> => {
        const reread = await request(`${root}/query?q=${encodeURIComponent(
          `SELECT Id,Status FROM ApprovalSubmission WHERE Id='${submissionId}' LIMIT 1`)}`);
        return record(reread.body) && Array.isArray(reread.body.records) ? reread.body.records.filter(record) : null;
      };
      // Approval decisions propagate asynchronously (observed multi-second
      // flip after a successful review), so settle before judging.
      const rows = await settle(readSubmission,
        (found) => found !== null && found.length === 1 && !isActionableSubmissionStatus(found[0].Status),
        input.settlePoll) ?? [];
      afterStatus = rows.length === 1 && typeof rows[0].Status === "string" ? rows[0].Status : undefined;
      verified = accepted && rows.length === 1 && beforeStatus === APPROVAL_SUBMISSION_ACTIONABLE && isTerminalSubmissionStatus(afterStatus);
      if (!verified) {
        return accepted
          ? fail("APPROVAL_TRANSITION_UNVERIFIED", "Salesforce reported success without a verified terminal state on the owned submission.", { upstreamOutcome: invoked.body })
          : invoked;
      }
      return invoked;
    })();
  } catch {
    if (outcome.body?.errorCode === "APPROVAL_CONTEXT_UNAVAILABLE") {
      outcome = fail("APPROVAL_LIFECYCLE_UNVERIFIED", "The owned approval lifecycle failed; ownership-scoped cleanup still runs.");
    }
    verified = false;
  } finally {
    if (ownedId) {
      // An actionable submission locks the owned record; terminalize it
      // first so the fixture delete can succeed. The downstream checks stay
      // authoritative: ProcessInstance rows vanish with the record, while
      // ApprovalSubmission rows persist by platform design and must be
      // terminal instead of absent.
      if (instanceId) {
        await request(`${root}/process/approvals`, "POST",
          { requests: [{ actionType: "Recall", contextId: instanceId, comments: "owned fixture cleanup" }] });
      }
      let sweptStatus: string | null = null;
      if (submissionId) {
        sweptStatus = (await sweepApprovalSubmission({ root, submissionId, comments: marker, request, settlePoll: input.settlePoll })).status;
      }
      await request(`${root}/sobjects/${APPROVAL_FIXTURE_OBJECT}/${ownedId}`, "DELETE");
      const check = await request(`${root}/sobjects/${APPROVAL_FIXTURE_OBJECT}/${ownedId}`);
      if (check.status !== 404) {
        cleanupError = "Owned approval fixture cleanup could not be verified; the record may still exist.";
      } else {
        const swept = await request(`${root}/query?q=${encodeURIComponent(
          `SELECT Id FROM ${APPROVAL_FIXTURE_OBJECT} WHERE ${APPROVAL_FIXTURE_MARKER_FIELD}='${marker}' LIMIT 2`)}`);
        const rows = record(swept.body) && Array.isArray(swept.body.records) ? swept.body.records : null;
        if (!swept.ok || !rows || rows.length > 0) {
          cleanupError = "Owned approval fixture cleanup could not be verified; a marker-scoped sibling may remain.";
        } else if (submissionId) {
          if (!isTerminalSubmissionStatus(sweptStatus)) {
            cleanupError = "Owned approval submission state could not be verified terminal after fixture cleanup.";
          }
        } else {
          const lingering = await request(`${root}/query?q=${encodeURIComponent(
            `SELECT Id FROM ProcessInstance WHERE TargetObjectId='${ownedId}' LIMIT 1`)}`);
          const lingeringRows = record(lingering.body) && Array.isArray(lingering.body.records) ? lingering.body.records : null;
          if (!lingering.ok || !lingeringRows || lingeringRows.length > 0) {
            cleanupError = "Owned approval submission state could not be verified absent after fixture cleanup.";
          }
        }
      }
    }
  }
  return done(outcome, {
    verified: cleanupError ? false : verified,
    marker, markerField: APPROVAL_FIXTURE_MARKER_FIELD,
    ownedRecordId: ownedId ?? null, processInstanceId: instanceId ?? null,
    approvalSubmissionId: submissionId ?? null, approvalWorkItemId: workItemId ?? null,
    beforeStatus: beforeStatus ?? null, afterStatus: afterStatus ?? null,
    assigneeBefore: assigneeBefore ?? null, assigneeAfter: assigneeAfter ?? null,
    verificationRecordIds: ownedId ? [ownedId] : [], ownedRecords: owned,
    ...(requestedAssignee ? { requestedAssignee } : {}),
    ...(buildMismatch ? { buildMismatch } : {}),
    ...(cleanupError ? { cleanupError } : {}),
  });
}
