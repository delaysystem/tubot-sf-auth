/**
 * Owned email-alert lifecycle (`custom/emailAlert/*`).
 *
 * Root cause (blind-verified 2026-10-04 on partner): the ten
 * `*_Notification` alerts verb-skip (`notification` in MUTATING_ACTION_VERBS
 * -> unsafe_to_invoke, terminal, no owned branch) while `Mock_Email_Alert`
 * carries no mutating verb so the worker natively POSTs a synthetic
 * `{SObjectRowId}` -> 400 INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY.
 * Full 3-class inert ladders (random-15, prefix-valid-15, checksum-valid-18
 * with the algorithm validated on a live 18-char ID) refuse 400 on every
 * alert: a pure existence gate, since both sfcma objects are
 * queryable/retrieveable/createable/deletable with 0 rows. No license text
 * anywhere, so no license special-case is coded; upstream rejection is
 * preserved generically.
 *
 * This module runs one owned fixture per invocation (object resolved from
 * the live route segment and cross-checked against the descriptor
 * `targetEntityName`) and refuses to fabricate identities or recipients:
 * the send targets the freshly created owned record only, and the POST runs
 * only after the recipient-safety assertion holds (live alert recipients
 * resolve to a seeded-non-routable record email field, an email-typed
 * record field proven empty, an unset recipient lookup, the record creator,
 * or the record owner; every email value on the read-back fixture is empty
 * or `@example.invalid`; the creator is the integration user itself).
 * No org id, alias, username, alert name, object name, or URL appears here;
 * every tenant value is caller-supplied or read live.
 *
 * Recipient-container fix (CLI-verified 2026-10-06 on the sweep org): the
 * Tooling API `WorkflowAlert` retrieve carries no top-level recipient list,
 * so the old top-level-only scan refused every live alert with
 * EMAIL_ALERT_RECIPIENT_UNVERIFIED ("No recipient list was found in the live
 * alert metadata"). Recipients live in `Metadata.recipients` as
 * `{field, recipient, type}` entries; the gate now reads that container
 * (top-level keys still honored) with the same fail-closed verdicts.
 *
 * Fixture-reference fix (D1-verified 2026-10-06): Case fixtures refused with
 * OWNED_CONTEXT_REQUIRED_REFERENCE_UNRESOLVED because Case.BusinessHoursId
 * is required on the sweep org. Required reference values seed from live
 * lookups (borrowed FK ids merged into the planned seeds before the build;
 * borrowed rows are never written). Unresolved fields still fail honest
 * through the builder with the same code.
 *
 * Identity-format fix (R5 route lane, Round-4 sweep evidence): nine
 * Case/SMS alerts refused with EMAIL_ALERT_RECIPIENT_UNSAFE ("the owned
 * fixture creator is not the integration user") while the transport ran
 * as that same user. The stored identity and the live CreatedById/
 * OwnerId readback name the same user in different ID formats (15-char
 * vs 18-char) on the sweep org, so strict equality falsely refused.
 * Creator/owner compares now use the auth token-path 15-char-prefix
 * semantics; genuinely foreign creators still refuse, and refused sends
 * that evidence a denial attach the planner-only grant family.
 *
 * Platform-managed-object fix (CLI-verified 2026-10-07 on the sweep org):
 * the OrderSummary alert 400ed INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE on
 * the fixture POST. Bisection proved the fault structural, not a grant
 * gap: even the org admin faults identically on a minimal {OrderNumber}
 * insert and on the full engine-payload replica, with zero rows created.
 * The live describe shows OriginalOrderId (reference -> Order) and
 * OrderLifeCycleType required (nillable=false, not defaulted) yet
 * neither createable nor updateable, so no API caller can ever set them
 * and the platform populates them only through its managed order
 * lifecycle — never on direct sobject insert. The fixture builder
 * assumes such fields are platform-computed and omits them, which
 * guarantees the native 400 here. The lifecycle now refuses before any
 * side effect when the live describe carries required-but-unsettable
 * fields (EMAIL_ALERT_FIXTURE_UNBUILDABLE); no permission grant can
 * enable direct insert on such objects. The predicate fires on none of
 * the other alert fixture objects (Case, WebCart, et4ae5 definitions),
 * so working alerts are unaffected.
 */

import { commercialAccountLinkField, seedCommercialAccountLink, seedRequiredReferenceValues } from "./fixture-reference-seeding";
import { denialGrantForRestOutcome, type DenialGrant } from "./permission-denial-grants";
import { sameSalesforceId } from "./salesforce-id";
import { reclaimFixtureOwnerForDelete } from "./fixture-owner-reclaim";
import { clampVerificationWindowMs } from "./verification-window";

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const ACTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

export const EMAIL_ALERT_ACTION_TYPE = "custom/emailAlert";
/** Family builder version: re-probe scheduled turns when this moves. 2: cleanup-time owner reclaim to the verified creator before fixture deletes. */
export const EMAIL_ALERT_BUILDER_VERSION = 2;
/** Non-routable seed for every fixture email field (RFC 2606 `.invalid`). */
export const EMAIL_ALERT_FIXTURE_EMAIL = "action-searcher@example.invalid";
const EMAIL_DOMAIN = "@example.invalid";

const record = (value: unknown): value is Value =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && SF_ID.test(value);

const fail = (errorCode: string, message: string, extra?: Value): Result => ({
  status: 422, ok: false, body: { errorCode, message, ...extra },
});

/**
 * Fixture-setup fault: the create was blocked by a trigger querying
 * no-rows substrate (or a missing package object), not by the probe shape.
 * Returns the setup token (trigger name or package) or null.
 */
export function emailAlertFixtureSetupFault(body: unknown): string | null {
  const texts: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4) return;
    if (typeof node === "string") { if (node.length > 0 && node.length <= 500) texts.push(node); return; }
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    if (record(node)) { for (const entry of Object.values(node)) visit(entry, depth + 1); }
  };
  visit(body, 0);
  const joined = texts.join("; ");
  if (!/List has no rows for assignment to SObject|INVALID_TYPE|entity type .* does not exist/i.test(joined)) return null;
  const trigger = joined.match(/([A-Za-z][A-Za-z0-9_]*): execution of/i)?.[1]
    ?? joined.match(/trigger[: ]+([A-Za-z][A-Za-z0-9_]*)/i)?.[1];
  if (trigger) return trigger;
  const pkg = joined.match(/\b([a-z][a-z0-9]{1,15})__[A-Za-z]/)?.[1];
  return pkg ? `package:${pkg}` : "fixture-setup";
}

/**
 * Live executor identity from the OIDC userinfo endpoint (the token behind
 * this request, not the stored credential row, which can name a different
 * user). Null on any failure so callers fall back to the stored identity.
 */
export async function emailAlertLiveExecutorId(
  request: (path: string, method?: string, body?: unknown) => Promise<{ status: number; ok: boolean; body: any }>,
): Promise<string | null> {
  try {
    const info = await request("/services/oauth2/userinfo");
    const id = record(info.body) ? info.body.user_id : undefined;
    return identity(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Parse a live emailAlert route. Returns the object + alert names, or null
 * when the route is not in this family. Classification uses the route shape
 * only; no object or alert name is ever enumerated here.
 */
export function emailAlertRouteParts(route: string): { objectName: string; alertName: string } | null {
  const match = typeof route === "string"
    ? route.match(/^\/services\/data\/v\d+(?:\.\d+)?\/actions\/custom\/emailAlert\/([A-Za-z][A-Za-z0-9_]{0,127})\/([A-Za-z][A-Za-z0-9_]{0,127})$/)
    : null;
  if (!match || !OBJECT_NAME.test(match[1]) || !ACTION_NAME.test(match[2])) return null;
  return { objectName: match[1], alertName: match[2] };
}

/** True when the action belongs to the owned emailAlert lifecycle. */
export function isEmailAlertOwnedContextRoute(route: string, actionType?: string): boolean {
  if (emailAlertRouteParts(route) === null) return false;
  return actionType === undefined || actionType === EMAIL_ALERT_ACTION_TYPE;
}

/**
 * Resolve the record-id input from the live descriptor body and cross-check
 * the descriptor `targetEntityName` against the route object. The single-ID
 * shape carries the record id; name matching (`SObjectRowId`) is only a
 * tiebreak, so a renamed field keeps working as long as the shape holds.
 */
export function emailAlertInvocationInput(descriptorBody: unknown, routeObject: string): {
  rowIdField: string;
} | { failure: string } {
  const body = record(descriptorBody) ? descriptorBody : null;
  const inputs = body !== null && Array.isArray(body.inputs) ? body.inputs.filter(record) : [];
  const target = body !== null && typeof body.targetEntityName === "string" ? body.targetEntityName : null;
  if (target !== null && target !== routeObject) {
    return { failure: `The live emailAlert descriptor targets ${target}, not the route object ${routeObject}.` };
  }
  const idInputs = inputs.filter((field) =>
    typeof field.name === "string" && FIELD_NAME.test(field.name) &&
    typeof field.type === "string" && field.type.toUpperCase() === "ID" &&
    (typeof field.maxOccurs !== "number" || field.maxOccurs <= 1) && field.isCollection !== true);
  const required = idInputs.filter((field) => field.required === true);
  const pool = required.length > 0 ? required : idInputs;
  const row = pool.find((field) => field.name === "SObjectRowId") ?? (pool.length === 1 ? pool[0] : undefined);
  if (!row || typeof row.name !== "string") {
    return { failure: "The live emailAlert action does not declare a single record-id ID input." };
  }
  return { rowIdField: row.name };
}

/**
 * True when every envelope item reports success with no errors. Unlike the
 * notification family, emailAlert descriptors declare `outputs: []`, so no
 * delivery message is required — the accepted envelope is the evidence.
 */
export function emailAlertSendAccepted(status: number, body: unknown): boolean {
  if (!(status >= 200 && status < 300) || !Array.isArray(body) || body.length === 0) return false;
  return body.every((item) =>
    record(item) && item.isSuccess === true &&
    (item.errors === null || item.errors === undefined || (Array.isArray(item.errors) && item.errors.length === 0)));
}

/** True when upstream refused an unresolvable record id (the inert-id gate). */
export function emailAlertExistenceRefused(status: number, body: unknown): boolean {
  if (status < 400 || status >= 500 || !Array.isArray(body)) return false;
  return body.some((item) => record(item) && Array.isArray(item.errors) && item.errors.some((entry) =>
    record(entry) && (entry.statusCode === "INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY" ||
      entry.statusCode === "MISSING_RECORD")));
}

/**
 * Minimum describe length for a fallback marker field. The marker is
 * `EA probe <uuid>` (45 chars); shorter fields would truncate it and fail
 * the readback check, so they are never selected when length is known.
 */
export const EMAIL_ALERT_MARKER_MIN_LENGTH = 48;

/**
 * Marker field for the owned fixture, resolved from the live describe.
 * Name/Subject keep priority for stability; otherwise any createable,
 * filterable string/textarea the marker fits in (CLI-verified 2026-10-06:
 * OrderSummary exposes no Name/Subject but OrderNumber is createable,
 * filterable, and required, so the alert for it is probeable). Auto-number
 * fields are excluded (explicit values are rejected) as are unfilterable
 * fields (the cleanup sweep filters `WHERE <marker>='<marker>'`).
 */
export function emailAlertMarkerField(describeFields: unknown): string | null {
  const fields = Array.isArray(describeFields) ? describeFields.filter(record) : [];
  const usable = (name: string): boolean => fields.some((field) =>
    field.name === name && field.createable === true && typeof field.type === "string" &&
    (field.type === "string" || field.type === "textarea"));
  if (usable("Name")) return "Name";
  if (usable("Subject")) return "Subject";
  const rank = (field: Value): number =>
    field.nameField === true ? 0 : field.nillable === false ? 1 : 2;
  const candidates = fields
    .filter((field) =>
      typeof field.name === "string" && FIELD_NAME.test(field.name) &&
      typeof field.type === "string" &&
      (field.type === "string" || field.type === "textarea") &&
      field.createable === true && field.autoNumber !== true &&
      field.filterable !== false &&
      (typeof field.length !== "number" || field.length >= EMAIL_ALERT_MARKER_MIN_LENGTH))
    .sort((a, b) => rank(a) - rank(b));
  const winner = candidates.length > 0 ? candidates[0].name : null;
  return typeof winner === "string" ? winner : null;
}

/**
 * Required-but-unsettable fields on the live describe: required
 * (nillable=false, not defaulted, not calculated, not auto-number) yet
 * neither createable nor updateable, so no API caller can ever set them.
 * Mirrors the fixture builder's skip branch (`synthesizeRecordValues`
 * omits exactly these assuming platform computation) — but on
 * platform-managed-lifecycle objects (live evidence: OrderSummary's
 * OriginalOrderId + OrderLifeCycleType) the platform populates them
 * only through its managed lifecycle, never on direct sobject insert,
 * so any direct fixture POST is guaranteed to 400. Non-empty means the
 * alert must refuse before any side effect; no grant can fix it.
 */
export function emailAlertPlatformManagedRequiredFields(describeFields: unknown): string[] {
  const fields = Array.isArray(describeFields) ? describeFields.filter(record) : [];
  return fields.filter((field) =>
    typeof field.name === "string" && FIELD_NAME.test(field.name) &&
    field.nillable === false && field.defaultedOnCreate !== true &&
    field.calculated !== true && field.autoNumber !== true &&
    field.createable !== true && field.updateable !== true)
    .map((field) => field.name as string);
}

/** Every email-typed field on the describe, seedable or not. */
export function emailAlertEmailTypedFields(describeFields: unknown): string[] {
  const fields = Array.isArray(describeFields) ? describeFields.filter(record) : [];
  return fields.filter((field) =>
    typeof field.name === "string" && FIELD_NAME.test(field.name) &&
    typeof field.type === "string" && field.type.toLowerCase() === "email")
    .map((field) => field.name as string);
}

/** Every createable email-typed field: each is seeded non-routable. */
export function emailAlertSeedableEmailFields(describeFields: unknown): string[] {
  const fields = Array.isArray(describeFields) ? describeFields.filter(record) : [];
  return fields.filter((field) =>
    typeof field.name === "string" && FIELD_NAME.test(field.name) &&
    typeof field.type === "string" && field.type.toLowerCase() === "email" &&
    field.createable === true).map((field) => field.name as string);
}

export type EmailAlertRecipientVerdict =
  | { allowable: true; recipients: string[]; assertEmptyFields: string[] }
  | { allowable: false; reason: string };

const RECIPIENT_LIST_KEYS = new Set([
  "recipients", "emailrecipients", "targetrecipients", "targets", "recipientlist",
]);
const ALLOWABLE_RECIPIENT_TYPES = new Set(["creator", "owner"]);
const ALLOWABLE_FIELD_TYPES = new Set(["emailfield", "field", "recordemail", "record", "email"]);
const CONTACT_LOOKUP_TYPE = "contactlookup";

const normKey = (key: string): string => key.toLowerCase().replace(/[^a-z]/g, "");

const childOf = (container: unknown, key: string): unknown => {
  if (!record(container)) return undefined;
  const hit = Object.keys(container).find((name) => normKey(name) === key);
  return hit === undefined ? undefined : (container as Value)[hit];
};

const nonEmptyValue = (value: unknown): boolean => {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(nonEmptyValue);
  return value !== null && value !== undefined;
};

/**
 * Decide whether the live alert record's recipients stay inside the owned
 * safety shape.
 *
 * Live shape (CLI-verified 2026-10-06 on the sweep org): the Tooling API
 * `WorkflowAlert` retrieve carries NO top-level recipient list; recipients
 * live in the `Metadata.recipients` container as `{field, recipient, type}`
 * entries and Cc in `Metadata.ccEmails`. Top-level list keys are still
 * honored for forward compatibility. Every list found must be fully
 * allowable; anything unrecognized denies: fail closed, never send.
 *
 * Allowable entries:
 * - creator/owner: resolve to the integration user itself, proven on the
 *   read-back fixture (creator is self; owner is self when claimed).
 * - record email field (seeded): the fixture seeds it non-routable and the
 *   readback proves it.
 * - record email field (unseeded, e.g. derived ContactEmail): the builder
 *   never sets it (not createable) and the readback proves it empty or
 *   non-routable, like every other email value on the fixture.
 * - contactLookup: allowed only with an empty-lookup assertion — the
 *   recipient resolves solely through the named lookup, so the readback
 *   must prove that lookup unset before the send runs. The caller receives
 *   the field names via `assertEmptyFields`.
 *
 * Fixed addresses, named recipients, and every other recipient type deny.
 */
export function emailAlertRecipientsAllowable(
  alertRecord: unknown,
  seededEmailFields: readonly string[],
  describeEmailFields: readonly string[] = seededEmailFields,
): EmailAlertRecipientVerdict {
  if (!record(alertRecord)) return { allowable: false, reason: "The live alert metadata is missing or unreadable." };
  const seeds = new Set(seededEmailFields.map((name) => name.toLowerCase()));
  const recordEmails = new Set(describeEmailFields.map((name) => name.toLowerCase()));
  const metadata = childOf(alertRecord, "metadata");
  for (const container of [alertRecord, metadata]) {
    if (!record(container)) continue;
    for (const [key, value] of Object.entries(container)) {
      if (normKey(key) === "ccemails" && nonEmptyValue(value)) {
        return { allowable: false, reason: "The live alert carries free-text CcEmails recipients." };
      }
    }
  }
  const lists: unknown[] = [];
  for (const container of [alertRecord, metadata]) {
    if (!record(container)) continue;
    for (const [key, value] of Object.entries(container)) {
      if (RECIPIENT_LIST_KEYS.has(normKey(key))) lists.push(value);
    }
  }
  if (lists.length === 0) {
    return { allowable: false, reason: "No recipient list was found in the live alert metadata." };
  }
  const recipients: string[] = [];
  const assertEmptyFields: string[] = [];
  for (const list of lists) {
    if (!Array.isArray(list) || list.length === 0) {
      return { allowable: false, reason: "The live alert recipient list is empty or unreadable." };
    }
    for (const entry of list) {
      if (typeof entry === "string") {
        const text = entry.toLowerCase();
        const field = text.includes(".") ? text.slice(text.lastIndexOf(".") + 1) : text;
        if (text === "creator" || text === "owner") { recipients.push(text); continue; }
        if (seeds.has(field)) { recipients.push(`field:${field}`); continue; }
        if (recordEmails.has(field)) { recipients.push(`field:${field}:unseeded`); continue; }
        return { allowable: false, reason: `The live alert recipient "${entry.slice(0, 80)}" is outside the owned safety shape.` };
      }
      if (!record(entry)) {
        return { allowable: false, reason: "A live alert recipient entry is unreadable." };
      }
      const rawType = entry.type ?? entry.recipientType ?? entry.kind ?? entry.targetType;
      const type = typeof rawType === "string" ? normKey(rawType) : "";
      const rawField = entry.field ?? entry.fieldName ?? entry.emailField ?? entry.targetField;
      const fieldRef = typeof rawField === "string" ? rawField.toLowerCase() : "";
      const field = fieldRef.includes(".") ? fieldRef.slice(fieldRef.lastIndexOf(".") + 1) : fieldRef;
      const rawAddress = entry.address ?? entry.email ?? entry.emailAddress;
      if (typeof rawAddress === "string" && rawAddress.trim().length > 0) {
        return { allowable: false, reason: "The live alert carries a fixed-address recipient." };
      }
      const rawRecipient = entry.recipient ?? entry.recipientName ?? entry.targetName;
      if (typeof rawRecipient === "string" && rawRecipient.trim().length > 0) {
        return { allowable: false, reason: "The live alert names a fixed recipient the probe cannot prove." };
      }
      if (ALLOWABLE_RECIPIENT_TYPES.has(type)) { recipients.push(type); continue; }
      if (type === CONTACT_LOOKUP_TYPE && field !== "" && FIELD_NAME.test(field)) {
        recipients.push(`lookup:${field}:empty`);
        assertEmptyFields.push(field);
        continue;
      }
      if ((type === "" || ALLOWABLE_FIELD_TYPES.has(type)) && field !== "") {
        if (seeds.has(field)) { recipients.push(`field:${field}`); continue; }
        if (recordEmails.has(field)) { recipients.push(`field:${field}:unseeded`); continue; }
      }
      return { allowable: false, reason: "A live alert recipient is outside the owned safety shape (not creator, owner, a record email field, or an unset recipient lookup)." };
    }
  }
  return { allowable: true, recipients, assertEmptyFields };
}

/**
 * Sender evidence from the live alert record (top-level or Metadata): the
 * sender type plus the org-wide sender domain when one is fixed. The local
 * part is never kept: only the domain can appear in persisted evidence.
 * A fixed sender never gates the send — Salesforce enforces sender
 * verification itself and refuses honestly when it is missing.
 */
export function emailAlertSenderProof(alertRecord: unknown): string | null {
  if (!record(alertRecord)) return null;
  const metadata = childOf(alertRecord, "metadata");
  const rawType = childOf(alertRecord, "sendertype") ?? childOf(metadata, "sendertype");
  if (typeof rawType !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,64}$/.test(rawType)) return null;
  const rawAddress = childOf(alertRecord, "senderaddress") ?? childOf(metadata, "senderaddress");
  if (typeof rawAddress === "string" && rawAddress.includes("@")) {
    const domain = rawAddress.slice(rawAddress.lastIndexOf("@") + 1).toLowerCase().slice(0, 80);
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return `${rawType}:***@${domain}`;
  }
  return rawType;
}

export type EmailAlertLifecycleInput = {
  root: string;
  route: string;
  /** Live integration user id; creator/owner recipient shapes resolve to this user only. */
  selfUserId: string;
  verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any, extraHeaders?: Record<string, string>) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
};

/**
 * Owned fixtures skip Case/Lead assignment rules at insert: routed fixtures
 * land on queues the execution user cannot own, which DELETE cannot remove,
 * so every routed row ends cleanup-unverified after a successful send. The
 * header is a no-op on objects without assignment rules. Reclaim-after-
 * insert stays as defense-in-depth (flow-owned fixtures, silent reverts).
 */
export const EMAIL_ALERT_FIXTURE_CREATE_HEADERS = { "Sforce-Auto-Assign": "FALSE" };

export async function invokeEmailAlertWithContext(input: EmailAlertLifecycleInput): Promise<{
  status: number; body: any; cleanupError?: string; contextSchema?: Value; denialGrant?: DenialGrant;
}> {
  const { root, request } = input;
  const parts = emailAlertRouteParts(input.route);
  const automaticSteps = [
    "Resolve the record-id input and target object from the live descriptor",
    "Verify the live alert recipients resolve to non-routable fixture email or self",
    "Create an owned fixture carrying a unique verifiable marker and non-routable email",
    "Verify marker, non-routable email and self-creator on readback",
    "Send the alert against the owned record and verify the success envelope",
    "Delete only the owned record and verify absence",
  ];
  const base = { source: "salesforce_live_email_alert_action", action: parts?.alertName ?? null, alertName: parts?.alertName ?? null, targetObject: parts?.objectName ?? null, automaticSteps };
  const done = (outcome: Result, extra: Value): { status: number; body: any; cleanupError?: string; contextSchema?: Value; denialGrant?: DenialGrant } => ({
    status: outcome.status, body: outcome.body,
    ...(typeof extra.cleanupError === "string" ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...base, ...extra },
  });
  if (!parts || !root.startsWith("/services/data/") || !input.route.startsWith(`${root}/actions/`)) {
    return done(fail("EMAIL_ALERT_ACTION_INVALID", "A discovered custom emailAlert action route is required."), { verified: false });
  }
  if (!identity(input.selfUserId)) {
    return done(fail("EMAIL_ALERT_RECIPIENT_INVALID", "A live integration user identity is required; none is ever guessed."), { verified: false });
  }
  if (input.verificationWindowMs !== undefined &&
    (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail("EMAIL_ALERT_WINDOW_INVALID", "A bounded verification window is required."), { verified: false });
  }
  const marker = `EA probe ${crypto.randomUUID()}`;
  const owned: Array<{ objectName: string; id: string; markerField: string }> = [];
  let fixtureCreatorId: string | undefined;
  let cleanupError: string | undefined;
  let outcome: Result = fail("EMAIL_ALERT_CONTEXT_UNAVAILABLE", "The owned emailAlert context could not be prepared.");
  let verified = false;
  let ownedId: string | undefined;
  let rowIdField: string | undefined;
  let markerField: string | undefined;
  let recipientProof: string[] | undefined;
  let assertEmptyFields: string[] = [];
  let senderProof: string | null = null;
  let seededEmailFields: string[] = [];
  let buildMismatch: Value | undefined;
  try {
    outcome = await (async (): Promise<Result> => {
      const descriptor = await request(input.route);
      if (!descriptor.ok) return descriptor;
      const mapped = emailAlertInvocationInput(descriptor.body, parts.objectName);
      if ("failure" in mapped) return fail("EMAIL_ALERT_ACTION_SCHEMA_MISMATCH", mapped.failure);
      rowIdField = mapped.rowIdField;
      const schema = await request(`${root}/sobjects/${parts.objectName}/describe`);
      if (!schema.ok || !record(schema.body) || schema.body.createable !== true ||
        schema.body.deletable !== true || schema.body.queryable !== true || !Array.isArray(schema.body.fields)) {
        return fail("EMAIL_ALERT_FIXTURE_PERMISSIONS_REQUIRED",
          `Automatic emailAlert context requires live ${parts.objectName} create, read and delete access.`,
          { setupRequirement: `${parts.objectName} create/read/delete access for the execution user.` });
      }
      const unbuildable = emailAlertPlatformManagedRequiredFields(schema.body.fields);
      if (unbuildable.length > 0) {
        return fail("EMAIL_ALERT_FIXTURE_UNBUILDABLE",
          `The ${parts.objectName} fixture cannot be built by direct insert: ${unbuildable.join(", ")} ${unbuildable.length === 1 ? "is" : "are"} required but no API caller can set ${unbuildable.length === 1 ? "it" : "them"}; rows on this object are created by platform automation.`,
          { setupRequirement: `A platform-managed ${parts.objectName} creation path; no permission grant enables direct insert.`, unbuildableFields: unbuildable });
      }
      const markerOrNull = emailAlertMarkerField(schema.body.fields);
      if (!markerOrNull) {
        return fail("EMAIL_ALERT_MARKER_UNAVAILABLE",
          `The ${parts.objectName} describe exposes no marker field the integration user can set.`);
      }
      markerField = markerOrNull;
      seededEmailFields = emailAlertSeedableEmailFields(schema.body.fields);
      // Recipient gate BEFORE any side effect: no fixture exists when this refuses.
      const candidates = [...new Set([parts.alertName,
        parts.alertName.includes("__") ? parts.alertName.slice(parts.alertName.lastIndexOf("__") + 2) : parts.alertName])];
      const soql = `SELECT Id FROM WorkflowAlert WHERE DeveloperName IN (${candidates.map((n) => `'${n.replace(/'/g, "''")}'`).join(",")}) LIMIT 2`;
      const found = await request(`${root}/tooling/query?q=${encodeURIComponent(soql)}`);
      const toolingRecords = record(found.body) && Array.isArray(found.body.records) ? found.body.records : null;
      if (!found.ok || !toolingRecords || toolingRecords.length !== 1 ||
        !record(toolingRecords[0]) || typeof toolingRecords[0].Id !== "string") {
        return fail("EMAIL_ALERT_RECIPIENT_UNVERIFIED",
          "The live alert recipient metadata is missing or ambiguous; the send is refused.",
          { setupRequirement: "Retry after the live WorkflowAlert metadata is readable." });
      }
      const full = await request(`${root}/tooling/sobjects/WorkflowAlert/${toolingRecords[0].Id}`);
      if (!full.ok || !record(full.body)) {
        return fail("EMAIL_ALERT_RECIPIENT_UNVERIFIED",
          "The live alert recipient metadata could not be read; the send is refused.");
      }
      senderProof = emailAlertSenderProof(full.body);
      const verdict = emailAlertRecipientsAllowable(
        full.body, seededEmailFields, emailAlertEmailTypedFields(schema.body.fields));
      if (!verdict.allowable) {
        return fail("EMAIL_ALERT_RECIPIENT_UNVERIFIED",
          `The live alert recipients are outside the owned safety shape; the send is refused. ${verdict.reason}`);
      }
      recipientProof = verdict.recipients;
      assertEmptyFields = verdict.assertEmptyFields;
      const seeds: Value = { [markerField]: marker };
      for (const field of seededEmailFields) seeds[field] = EMAIL_ALERT_FIXTURE_EMAIL;
      // Required fixture references (Case.BusinessHoursId, WebCart.WebStoreId)
      // seed from live lookups; borrowed ids are planned seeds, so the
      // builder tamper check below still guards every ownership field.
      const refSeed = await seedRequiredReferenceValues(request, root, schema.body.fields);
      Object.assign(seeds, refSeed.overrides);
      // Nillable commercial Account links (WebCart-style) bind a live
      // Account, else mint an owned one: the native send faults
      // FIELD_INTEGRITY_EXCEPTION (`Required field: Account ID`) on
      // accountless fixtures even though the field stays nillable. The
      // recipient-safety readback below still wins over this seed.
      const accountLink = commercialAccountLinkField(schema.body.fields);
      if (accountLink !== null && seeds[accountLink.name] === undefined) {
        const link = await seedCommercialAccountLink(request, root);
        if ("bound" in link) {
          seeds[accountLink.name] = link.bound;
        } else if ("mint" in link) {
          const parentMarker = emailAlertMarkerField(link.mint.fields);
          if (!parentMarker) {
            return fail("EMAIL_ALERT_ACCOUNT_UNAVAILABLE",
              "The owned Account parent exposes no writable marker field; the send was not attempted.");
          }
          const parentBuilt = await input.build("Account", marker, { [parentMarker]: marker });
          if ("failure" in parentBuilt) return parentBuilt.failure;
          const parentCreated = await request(`${root}/sobjects/Account`, "POST", parentBuilt.values);
          const parentId: unknown = parentCreated.body?.id ?? parentCreated.body?.Id;
          if (!parentCreated.ok || !identity(parentId)) return parentCreated;
          owned.push({ objectName: "Account", id: parentId, markerField: parentMarker });
          const parentRead = await request(`${root}/sobjects/Account/${parentId}`);
          if (!parentRead.ok || !record(parentRead.body) || parentRead.body.Id !== parentId ||
            parentRead.body[parentMarker] !== marker) {
            return fail("EMAIL_ALERT_ACCOUNT_UNVERIFIED",
              "The owned Account parent readback failed; the send was not attempted.");
          }
          seeds[accountLink.name] = parentId;
        } else {
          return fail("EMAIL_ALERT_ACCOUNT_UNAVAILABLE",
            `${link.unavailable} The send was not attempted.`);
        }
      }
      const built = await input.build(parts.objectName, marker, seeds);
      if ("failure" in built) return built.failure;
      const tampered = Object.keys(seeds).filter((field) => built.values[field] !== seeds[field]);
      if (tampered.length > 0) {
        buildMismatch = { mismatchedFields: tampered, builtFields: Object.keys(built.values) };
        return fail("EMAIL_ALERT_BUILD_UNSCOPED", "The fixture builder changed a planned ownership field.");
      }
      const created = await request(`${root}/sobjects/${parts.objectName}`, "POST", built.values, EMAIL_ALERT_FIXTURE_CREATE_HEADERS);
      const createdId: unknown = created.body?.id ?? created.body?.Id;
      if (!created.ok || !identity(createdId)) {
        const setup = emailAlertFixtureSetupFault(created.body);
        if (setup !== null) {
          return fail("EMAIL_ALERT_FIXTURE_SETUP_REQUIRED",
            `The owned fixture create was blocked by org setup (${setup}); the probe shape was not evaluated.`,
            { setupRequirement: setup });
        }
        return created;
      }
      ownedId = createdId;
      owned.push({ objectName: parts.objectName, id: createdId, markerField });
      const actual = await request(`${root}/sobjects/${parts.objectName}/${ownedId}`);
      if (!actual.ok || actual.body?.[markerField] !== marker) {
        return fail("EMAIL_ALERT_FIXTURE_UNVERIFIED", "The owned fixture readback did not carry the marker.");
      }
      // Recipient-safety assertion on the read-back fixture: every email
      // value non-routable, creator is the integration user itself.
      const emailFields = (schema.body.fields as Value[]).filter((field) =>
        typeof field.type === "string" && field.type.toLowerCase() === "email" && typeof field.name === "string");
      const routable = emailFields.filter((field) =>
        typeof actual.body?.[field.name] === "string" && actual.body[field.name].length > 0 &&
        !actual.body[field.name].toLowerCase().endsWith(EMAIL_DOMAIN));
      if (routable.length > 0) {
        return fail("EMAIL_ALERT_RECIPIENT_UNSAFE",
          "The owned fixture carries a routable email value; the send is refused.",
          { routableFields: routable.map((field) => field.name) });
      }
      // contactLookup recipients resolve solely through the named lookup, so
      // the send runs only when every such lookup is unset on the fixture.
      // Field-name match is case-insensitive: verdict proofs are lowercase.
      const readbackKeys = new Map(Object.keys(actual.body ?? {}).map((name) => [name.toLowerCase(), name]));
      const setLookups = assertEmptyFields.filter((field) => {
        const actualKey = readbackKeys.get(field.toLowerCase());
        const value = actualKey === undefined ? undefined : (actual.body as Value)[actualKey];
        return value !== null && value !== undefined && value !== "";
      });
      if (setLookups.length > 0) {
        return fail("EMAIL_ALERT_RECIPIENT_UNSAFE",
          "A recipient lookup is set on the owned fixture; the send is refused.",
          { setLookups });
      }
      // Identity compares are 15/18-format tolerant (same semantics as
      // the auth token path): the stored identity and the live readback
      // name the same user in different ID formats on some orgs, and a
      // strict compare falsely refuses those owned fixtures (R4: nine
      // Case/SMS alerts refused with a matching integration user). When
      // the stored identity mismatches, the live token identity decides:
      // the credential row can name a different user than the executor,
      // and a fixture the live executor just created (unique marker
      // already matched above) is owned by construction.
      let liveExecutor: string | null | undefined;
      const liveExecutorId = async (): Promise<string | null> => {
        if (liveExecutor === undefined) liveExecutor = await emailAlertLiveExecutorId(request);
        return liveExecutor;
      };
      if (!sameSalesforceId(actual.body?.CreatedById, input.selfUserId) &&
        !sameSalesforceId(actual.body?.CreatedById, await liveExecutorId())) {
        return fail("EMAIL_ALERT_RECIPIENT_UNSAFE",
          "The owned fixture creator is not the integration user; the send is refused.");
      }
      // Reclaim an exact marker-verified fixture to its verified creator before
      // assessing owner recipients. A queue default is not a foreign recipient
      // once PATCH plus readback proves that the integration user owns it.
      const creatorId = actual.body?.CreatedById;
      if (typeof creatorId === "string") fixtureCreatorId = creatorId;
      if (typeof actual.body?.OwnerId === "string" && typeof creatorId === "string" && !sameSalesforceId(actual.body.OwnerId, creatorId)) {
        const reclaim = await request(`${root}/sobjects/${parts.objectName}/${ownedId}`, "PATCH", { OwnerId: creatorId });
        const reread = reclaim.ok ? await request(`${root}/sobjects/${parts.objectName}/${ownedId}`) : null;
        if (!reclaim.ok || !reread?.ok || !record(reread.body) || !sameSalesforceId(reread.body.OwnerId, creatorId)) {
          return fail("EMAIL_ALERT_RECLAIM_UNVERIFIED",
            `The owned ${parts.objectName} fixture could not be reclaimed to its verified creator (reclaim ${reclaim.status}); the send is refused.`);
        }
        actual.body = reread.body;
      }
      const ownerId = actual.body?.OwnerId;
      if (typeof ownerId === "string" && !sameSalesforceId(ownerId, input.selfUserId) &&
        !sameSalesforceId(ownerId, await liveExecutorId()) && recipientProof.some(entry => entry === "owner")) {
        return fail("EMAIL_ALERT_RECIPIENT_UNSAFE", "The alert resolves to an owner who is not the integration user; the send is refused.");
      }
      const invoked = await request(input.route, "POST", { inputs: [{ [rowIdField]: ownedId }] });
      verified = emailAlertSendAccepted(invoked.status, invoked.body);
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
      if (!verified) return invoked;
      return invoked;
    })();
  } catch {
    if (outcome.body?.errorCode === "EMAIL_ALERT_CONTEXT_UNAVAILABLE") {
      outcome = fail("EMAIL_ALERT_LIFECYCLE_UNVERIFIED", "The owned emailAlert lifecycle failed; ownership-scoped cleanup still runs.");
    }
    verified = false;
  } finally {
    for (const entry of owned.slice().reverse()) {
      if (typeof fixtureCreatorId === "string") {
        await reclaimFixtureOwnerForDelete({ root, objectName: entry.objectName, id: entry.id, ownerId: fixtureCreatorId, request }).catch(() => null);
      }
      await request(`${root}/sobjects/${entry.objectName}/${entry.id}`, "DELETE");
      const check = await request(`${root}/sobjects/${entry.objectName}/${entry.id}`);
      if (check.status !== 404) {
        cleanupError = "Owned emailAlert fixture cleanup could not be verified; the record may still exist.";
      } else {
        const swept = await request(`${root}/query?q=${encodeURIComponent(
          `SELECT Id FROM ${entry.objectName} WHERE ${entry.markerField}='${marker}' LIMIT 2`)}`);
        const rows = record(swept.body) && Array.isArray(swept.body.records) ? swept.body.records : null;
        if (!swept.ok || !rows || rows.length > 0) {
          cleanupError = "Owned emailAlert fixture cleanup could not be verified; a marker-scoped sibling may remain.";
        }
      }
    }
  }
  // Upstream REST denials map to planner-only grant-family requirements;
  // verified sends attach nothing. Grants are never applied here.
  const denialGrant = verified ? null : denialGrantForRestOutcome(outcome.status, outcome.body);
  const finished = done(outcome, {
    verified: cleanupError ? false : verified,
    marker, markerField: markerField ?? null,
    ownedRecordId: ownedId ?? null,
    rowIdField: rowIdField ?? null,
    seededEmailFields, recipientProof: recipientProof ?? null,
    assertEmptyFields, senderProof,
    verificationRecordIds: ownedId ? [ownedId] : [], ownedRecords: owned,
    ...(buildMismatch ? { buildMismatch } : {}),
    ...(cleanupError ? { cleanupError } : {}),
    ...(denialGrant ? { denialGrant } : {}),
  });
  return denialGrant ? { ...finished, denialGrant } : finished;
}
