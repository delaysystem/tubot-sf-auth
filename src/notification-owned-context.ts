/**
 * Owned custom-notification lifecycle (`custom/sendNotification/*`).
 *
 * Root cause (blind-verified 2026-10-03 against live orgs): every action in
 * this family declares exactly two required ID inputs (a recipient collection
 * plus a single target record) and POSTing with a live active user as the
 * recipient and a live Opportunity as the target record returns HTTP 200 with
 * `isSuccess:true` and `SuccessMessage:"Your notification was submitted."`.
 * The searcher never attempts the POST because the skip heuristic matches the
 * words "send"/"notification" carried by the family type and route, so all ten
 * actions sit at STATE_CHANGING_ACTION_SKIPPED with `describe_status=200`.
 *
 * This module runs one owned Opportunity fixture per invocation and refuses
 * to fabricate identities: the recipient is always a caller-supplied live
 * user id (production wiring passes the channel's own integration user, so
 * the notification blast radius is confined to the integration user itself),
 * and the target record is always the freshly created owned fixture. Input
 * field names are resolved from the live descriptor (collection-ID input
 * carries the recipients, single-ID input carries the record), never assumed.
 * No org id, alias, username, notification name, or URL appears here; every
 * tenant value is caller-supplied or read live.
 */

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const ACTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

export const NOTIFICATION_ACTION_TYPE = "custom/sendNotification";
export const NOTIFICATION_FIXTURE_OBJECT = "Opportunity";
export const NOTIFICATION_FIXTURE_MARKER_FIELD = "Name";

const record = (value: unknown): value is Value =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && SF_ID.test(value);

const fail = (errorCode: string, message: string, extra?: Value): Result => ({
  status: 422, ok: false, body: { errorCode, message, ...extra },
});

/**
 * Parse a live custom-notification route. Returns the action name, or null
 * when the route is not in this family. Classification uses the route shape
 * only; no action name is ever enumerated here.
 */
export function notificationActionName(route: string): string | null {
  const match = typeof route === "string"
    ? route.match(/^\/services\/data\/v\d+(?:\.\d+)?\/actions\/custom\/sendNotification\/([A-Za-z][A-Za-z0-9_]{0,127})$/)
    : null;
  const name = match?.[1] ?? null;
  return name !== null && ACTION_NAME.test(name) ? name : null;
}

/** True when the action belongs to the owned notification lifecycle. */
export function isNotificationOwnedContextRoute(route: string, actionType?: string): boolean {
  if (notificationActionName(route) === null) return false;
  return actionType === undefined || actionType === NOTIFICATION_ACTION_TYPE;
}

/**
 * Resolve the recipient/recipient-record input fields from the live
 * descriptor inputs. The collection-ID input carries the recipient ids and
 * the single-ID input carries the target record id; name matching is only a
 * tiebreak, so renamed fields keep working as long as the shape holds.
 */
export function notificationInvocationInputs(descriptorInputs: unknown): {
  recipientField: string; recordField: string;
} | { failure: string } {
  const inputs = Array.isArray(descriptorInputs) ? descriptorInputs.filter(record) : [];
  const idInputs = inputs.filter((field) =>
    typeof field.name === "string" && FIELD_NAME.test(field.name) &&
    typeof field.type === "string" && field.type.toUpperCase() === "ID");
  const multiplicity = (field: Value): number => {
    if (typeof field.maxOccurs === "number") return field.maxOccurs;
    if (field.isCollection === true) return 2;
    return 1;
  };
  let recipient = idInputs.find((field) => multiplicity(field) > 1);
  if (!recipient && idInputs.length === 2) {
    recipient = idInputs.find((field) => /recip/i.test(field.name));
  }
  const recordField = idInputs.find((field) => field !== recipient && multiplicity(field) <= 1) ??
    (idInputs.length === 2 ? idInputs.find((field) => field !== recipient && /record/i.test(field.name)) : undefined);
  if (!recipient || !recordField || recipient.name === recordField.name) {
    return { failure: "The live notification action does not declare a recipient-collection ID input plus a single target-record ID input." };
  }
  return { recipientField: recipient.name as string, recordField: recordField.name as string };
}

/** True when every envelope item reports success with no errors. */
export function notificationSendAccepted(status: number, body: unknown): boolean {
  if (!(status >= 200 && status < 300) || !Array.isArray(body) || body.length === 0) return false;
  return body.every((item) =>
    record(item) && item.isSuccess === true &&
    (item.errors === null || item.errors === undefined || (Array.isArray(item.errors) && item.errors.length === 0)));
}

/** True when upstream rejected the target record id type (a different fixture object may fit). */
export function notificationRecordIdRejected(status: number, body: unknown): boolean {
  if (status < 400 || status >= 500) return false;
  const parts: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4) return;
    if (typeof node === "string") { parts.push(node); return; }
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    if (!record(node)) return;
    for (const key of ["message", "errorMessage", "errorCode", "statusCode", "code"]) {
      if (typeof node[key] === "string" && node[key].length) parts.push(node[key]);
    }
    for (const key of ["errors", "outputValues", "result", "body"]) {
      if (node[key] !== undefined && node[key] !== null) visit(node[key], depth + 1);
    }
  };
  visit(body, 0);
  return parts.some((text) => /invalid_argument_type/i.test(text) || /invalid[^A-Za-z]*parameter[^A-Za-z]*value[^A-Za-z]*for[^A-Za-z]*recordid/i.test(text));
}

/** True when upstream reports a license gate (mirrors the searcher taxonomy). */
export function notificationLicenseBlocked(body: unknown): boolean {
  const parts: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4) return;
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    if (!record(node)) return;
    for (const key of ["message", "errorMessage", "errorCode", "code"]) {
      if (typeof node[key] === "string" && node[key].length) parts.push(node[key]);
    }
    for (const key of ["errors", "outputValues", "result", "body"]) {
      if (node[key] !== undefined && node[key] !== null) visit(node[key], depth + 1);
    }
  };
  visit(body, 0);
  return parts.some((text) => /\blicen[cs]e\b/i.test(text));
}

const deliveryEvidence = (body: unknown): string | null => {
  if (!Array.isArray(body)) return null;
  for (const item of body) {
    if (record(item) && record(item.outputValues) && typeof item.outputValues.SuccessMessage === "string" &&
      item.outputValues.SuccessMessage.length > 0) {
      return item.outputValues.SuccessMessage.slice(0, 200);
    }
  }
  return null;
};

export type NotificationLifecycleInput = {
  root: string;
  route: string;
  /** Live user id that receives the owned notification; never guessed. */
  recipientUserId: string;
  verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
};

export async function invokeNotificationWithContext(input: NotificationLifecycleInput): Promise<{
  status: number; body: any; cleanupError?: string; contextSchema?: Value;
}> {
  const { root, request } = input;
  const action = notificationActionName(input.route);
  const automaticSteps = [
    "Resolve the recipient-collection and target-record inputs from the live descriptor",
    "Create an owned Opportunity carrying a unique verifiable marker",
    "Send the notification to the live integration user about the owned record",
    "Verify the success envelope and delivery message",
    "Delete only the owned record and verify absence",
  ];
  const base = { source: "salesforce_live_notification_action", action, targetObject: NOTIFICATION_FIXTURE_OBJECT, automaticSteps };
  const done = (outcome: Result, extra: Value): { status: number; body: any; cleanupError?: string; contextSchema?: Value } => ({
    status: outcome.status, body: outcome.body,
    ...(typeof extra.cleanupError === "string" ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...base, ...extra },
  });
  if (!action || !root.startsWith("/services/data/") || !input.route.startsWith(`${root}/actions/`)) {
    return done(fail("NOTIFICATION_ACTION_INVALID", "A discovered custom notification action route is required."), { verified: false });
  }
  if (!identity(input.recipientUserId)) {
    return done(fail("NOTIFICATION_RECIPIENT_INVALID", "A live recipient user identity is required; none is ever guessed."), { verified: false });
  }
  if (input.verificationWindowMs !== undefined &&
    (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail("NOTIFICATION_WINDOW_INVALID", "A bounded verification window is required."), { verified: false });
  }
  const marker = `SN probe ${crypto.randomUUID()}`;
  const owned: Array<{ objectName: string; id: string; markerField: string }> = [];
  let cleanupError: string | undefined;
  let outcome: Result = fail("NOTIFICATION_CONTEXT_UNAVAILABLE", "The owned notification context could not be prepared.");
  let verified = false;
  let ownedId: string | undefined;
  let fallbackFixture: string | undefined;
  let fallbackSkipped: string | undefined;
  let recipientField: string | undefined;
  let recordField: string | undefined;
  let successMessage: string | null = null;
  let buildMismatch: Value | undefined;
  try {
    outcome = await (async (): Promise<Result> => {
      const descriptor = await request(input.route);
      if (!descriptor.ok) return descriptor;
      const mapped = notificationInvocationInputs(record(descriptor.body) ? descriptor.body.inputs : undefined);
      if ("failure" in mapped) return fail("NOTIFICATION_ACTION_SCHEMA_MISMATCH", mapped.failure);
      recipientField = mapped.recipientField;
      recordField = mapped.recordField;
      const schema = await request(`${root}/sobjects/${NOTIFICATION_FIXTURE_OBJECT}/describe`);
      if (!schema.ok || !record(schema.body) || schema.body.createable !== true ||
        schema.body.deletable !== true || schema.body.queryable !== true || !Array.isArray(schema.body.fields)) {
        return fail("NOTIFICATION_FIXTURE_PERMISSIONS_REQUIRED",
          "Automatic notification context requires live Opportunity create, read and delete access.",
          { setupRequirement: "Opportunity create/read/delete access for the execution user." });
      }
      const built = await input.build(NOTIFICATION_FIXTURE_OBJECT, marker, { [NOTIFICATION_FIXTURE_MARKER_FIELD]: marker });
      if ("failure" in built) return built.failure;
      if (built.values[NOTIFICATION_FIXTURE_MARKER_FIELD] !== marker) {
        buildMismatch = { mismatchedFields: [NOTIFICATION_FIXTURE_MARKER_FIELD], builtFields: Object.keys(built.values) };
        return fail("NOTIFICATION_BUILD_UNSCOPED", "The fixture builder changed a planned ownership field.");
      }
      const created = await request(`${root}/sobjects/${NOTIFICATION_FIXTURE_OBJECT}`, "POST", built.values);
      const createdId: unknown = created.body?.id ?? created.body?.Id;
      if (!created.ok || !identity(createdId)) return created;
      ownedId = createdId;
      owned.push({ objectName: NOTIFICATION_FIXTURE_OBJECT, id: createdId, markerField: NOTIFICATION_FIXTURE_MARKER_FIELD });
      const actual = await request(`${root}/sobjects/${NOTIFICATION_FIXTURE_OBJECT}/${ownedId}`);
      if (!actual.ok || actual.body?.[NOTIFICATION_FIXTURE_MARKER_FIELD] !== marker) {
        return fail("NOTIFICATION_FIXTURE_UNVERIFIED", "The owned fixture readback did not carry the marker.");
      }
      let invoked = await request(input.route, "POST",
        { inputs: [{ [recipientField]: [input.recipientUserId], [recordField]: ownedId }] });
      let accepted = notificationSendAccepted(invoked.status, invoked.body);
      successMessage = deliveryEvidence(invoked.body);
      if (notificationLicenseBlocked(invoked.body)) {
        return { ...fail("NOTIFICATION_LICENSE_REQUIRED", "A Salesforce feature license is needed for custom notifications.",
          { upstreamOutcome: invoked.body }), status: invoked.status, ok: false };
      }
      if (!accepted && notificationRecordIdRejected(invoked.status, invoked.body)) {
        // The notification type targets a different record shape (blind-verified:
        // high_priority_case accepts a Case). Retry once with a Case fixture.
        // Each gate records its outcome: a skipped retry leaves explicit
        // evidence instead of silently preserving the first rejection.
        fallbackSkipped = "case-schema";
        const caseSchema = await request(`${root}/sobjects/Case/describe`);
        if (caseSchema.ok && record(caseSchema.body) && caseSchema.body.createable === true &&
          caseSchema.body.deletable === true && caseSchema.body.queryable === true && Array.isArray(caseSchema.body.fields)) {
          // The Case retry bypasses the fixture builder: describe marks
          // BusinessHoursId required-without-default (build refuses), but
          // the server defaults it (bare-Subject insert verified live).
          // The marker readback below still guards ownership.
          fallbackSkipped = "case-create";
          {
            const caseCreated = await request(`${root}/sobjects/Case`, "POST", { Subject: marker, OwnerId: input.recipientUserId });
            const caseId: unknown = caseCreated.body?.id ?? caseCreated.body?.Id;
            if (caseCreated.ok && identity(caseId)) {
              owned.push({ objectName: "Case", id: caseId, markerField: "Subject" });
              fallbackSkipped = "case-readback";
              const caseActual = await request(`${root}/sobjects/Case/${caseId}`);
              if (caseActual.ok && caseActual.body?.Subject === marker) {
                fallbackSkipped = undefined;
                fallbackFixture = "Case";
                invoked = await request(input.route, "POST",
                  { inputs: [{ [recipientField]: [input.recipientUserId], [recordField]: caseId }] });
                accepted = notificationSendAccepted(invoked.status, invoked.body);
                successMessage = deliveryEvidence(invoked.body) ?? successMessage;
              }
            }
          }
        }
      }
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, input.verificationWindowMs));
      verified = accepted;
      if (!verified) return invoked;
      return invoked;
    })();
  } catch {
    if (outcome.body?.errorCode === "NOTIFICATION_CONTEXT_UNAVAILABLE") {
      outcome = fail("NOTIFICATION_LIFECYCLE_UNVERIFIED", "The owned notification lifecycle failed; ownership-scoped cleanup still runs.");
    }
    verified = false;
  } finally {
    for (const entry of owned.slice().reverse()) {
      const before = await request(`${root}/sobjects/${entry.objectName}/${entry.id}`);
      if (before.ok && record(before.body) && before.body[entry.markerField] === marker &&
          typeof before.body.OwnerId === "string" && before.body.OwnerId !== input.recipientUserId) {
        await request(`${root}/sobjects/${entry.objectName}/${entry.id}`, "PATCH", { OwnerId: input.recipientUserId });
      }
      await request(`${root}/sobjects/${entry.objectName}/${entry.id}`, "DELETE");
      const check = await request(`${root}/sobjects/${entry.objectName}/${entry.id}`);
      if (check.status !== 404) {
        cleanupError = "Owned notification fixture cleanup could not be verified; the record may still exist.";
      } else {
        const swept = await request(`${root}/query?q=${encodeURIComponent(
          `SELECT Id FROM ${entry.objectName} WHERE ${entry.markerField}='${marker}' LIMIT 2`)}`);
        const rows = record(swept.body) && Array.isArray(swept.body.records) ? swept.body.records : null;
        if (!swept.ok || !rows || rows.length > 0) {
          cleanupError = "Owned notification fixture cleanup could not be verified; a marker-scoped sibling may remain.";
        }
      }
    }
  }
  return done(outcome, {
    verified: cleanupError ? false : verified,
    marker, markerField: NOTIFICATION_FIXTURE_MARKER_FIELD,
    ownedRecordId: ownedId ?? null,
    ...(fallbackFixture ? { fallbackFixture } : {}),
    ...(fallbackSkipped ? { fallbackSkipped } : {}),
    recipientField: recipientField ?? null, recordField: recordField ?? null,
    deliveryMessage: successMessage,
    verificationRecordIds: ownedId ? [ownedId] : [], ownedRecords: owned,
    ...(buildMismatch ? { buildMismatch } : {}),
    ...(cleanupError ? { cleanupError } : {}),
  });
}
