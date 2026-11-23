/**
 * Owned notification-flow email-consumer lifecycle (`custom/flow` actions that
 * loop email whatIds, e.g. the sfcma `*_Notification_Flow` family).
 *
 * Root cause (CLI-verified 2026-10-04 on partner): every member declares two
 * optional STRING collections (`mailResults`, `whatIds`) and no SOBJECT
 * input, so generic paths mint synthetic shapes the interview cannot consume
 * while the send recipient stays config-fixed (record email field or
 * creator). The surviving shape is an owned record of the object named by the
 * paired email alert's live `targetEntityName`, passed as `whatIds`, with the
 * send addressed to a non-routable fixture email (record-email alerts) or to
 * the worker's own user (creator-recipient alerts).
 *
 * Pairing is by live alert metadata, never a flow list: the executor lists
 * `{root}/actions/custom/emailAlert`, pairs alerts to this flow by namespace
 * + notification stem, and takes the fixture object from the winners'
 * `targetEntityName` (refusing when winners disagree). Recipient safety is
 * asserted in code, never assumed: every createable email-typed field on the
 * fixture is set to a unique `@example.invalid` address and read back, AND
 * the fixture `CreatedById` is asserted to equal the integration user, so
 * whichever recipient class the alert config uses (record field or creator)
 * the mail can only go nowhere-routable or to self. No alert name, object
 * name, org id, alias, username, or URL appears here; every tenant value is
 * caller-supplied or read live. No PII is persisted: contextSchema records
 * domain classes and booleans, never addresses.
 */

import { UNDELIVERABLE_DOMAIN } from "./flow-producer-context";
import { flowOutputFailureSnippet } from "./flow-fallback-contact-chain";
import {
  sweepFlowCommunicationResidue,
  type ResidueSweep,
} from "./flow-residue-sweep";
import { clampVerificationWindowMs } from "./verification-window";

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const ACTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STEM = /^[A-Za-z][A-Za-z0-9_]*$/;

const FLOW_SUFFIX = /_Notification_Flow$/;
const ALERT_SUFFIXES = [
  /_[A-Za-z][A-Za-z0-9_]*_Notification$/,
  /_Notification$/,
  /_Email_Alert$/,
];

const ALERT_SUBCATALOG_CAP = 12;
const ALERT_DESCRIPTOR_CAP = 25;

const record = (value: unknown): value is Value =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && SF_ID.test(value);

const fail = (errorCode: string, message: string, extra?: Value): Result => ({
  status: 422, ok: false, body: { errorCode, message, ...extra },
});

/**
 * Parse a live notification-flow consumer route. Returns the action name, or
 * null when the route is not a custom/flow route. Shape membership is proven
 * from the live descriptor, never here.
 */
export function notificationFlowActionName(route: string): string | null {
  const match = typeof route === "string"
    ? route.match(/^\/services\/data\/v\d+(?:\.\d+)?\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/)
    : null;
  const name = match?.[1] ?? null;
  return name !== null && ACTION_NAME.test(name) ? name : null;
}

const namespaceOf = (name: string): string =>
  name.includes("__") ? name.slice(0, name.indexOf("__")) : "";

/** Notification stem of a consumer flow name. Null when the shape is foreign. */
export function notificationFlowStem(flowName: string): string | null {
  if (!ACTION_NAME.test(flowName)) return null;
  const bare = flowName.includes("__") ? flowName.slice(flowName.indexOf("__") + 2) : flowName;
  if (!FLOW_SUFFIX.test(bare)) return null;
  const stem = bare.replace(FLOW_SUFFIX, "");
  return stem.length > 0 && STEM.test(stem) ? stem : null;
}

/** Notification stem of an email alert name. Null when the shape is foreign. */
export function notificationAlertStem(alertName: string): string | null {
  if (!ACTION_NAME.test(alertName)) return null;
  const bare = alertName.includes("__") ? alertName.slice(alertName.indexOf("__") + 2) : alertName;
  for (const suffix of ALERT_SUFFIXES) {
    if (!suffix.test(bare)) continue;
    const stem = bare.replace(suffix, "");
    return stem.length > 0 && STEM.test(stem) ? stem : null;
  }
  return null;
}

export type AlertCandidate = { name: string; targetEntityName: string };

/**
 * Pair live email alerts to a consumer flow by namespace + stem. Several
 * alerts may share one stem (Customer + Partner variants) iff they agree on
 * a single target object; anything else is an explicit failure, never a guess.
 */
export function pairNotificationFlowAlerts(
  flowName: string, alerts: AlertCandidate[],
): { objectName: string; alertNames: string[] } | { failure: string } {
  const stem = notificationFlowStem(flowName);
  if (!stem) return { failure: "The flow name does not carry a notification-consumer stem." };
  const flowNs = namespaceOf(flowName);
  const winners = alerts.filter((alert) =>
    ACTION_NAME.test(alert.name) && OBJECT_NAME.test(alert.targetEntityName) &&
    namespaceOf(alert.name) === flowNs && notificationAlertStem(alert.name) === stem);
  if (!winners.length) {
    return { failure: `The live email-alert catalog exposes no ${stem} notification alert for this flow; the fixture object cannot be derived.` };
  }
  const objects = [...new Set(winners.map((winner) => winner.targetEntityName))];
  if (objects.length > 1) {
    return { failure: `The paired ${stem} alerts disagree on the fixture object (${objects.join(", ")}); the send target cannot be derived.` };
  }
  return { objectName: objects[0], alertNames: winners.map((winner) => winner.name) };
}

/** Createable email-typed fields from a live object describe. */
export function notificationFlowEmailFields(describeBody: unknown): string[] {
  if (!record(describeBody) || !Array.isArray(describeBody.fields)) return [];
  return describeBody.fields.filter(record)
    .filter((field) => typeof field.name === "string" && FIELD_NAME.test(field.name) &&
      field.createable === true && String(field.type ?? "").toLowerCase() === "email")
    .map((field) => field.name as string);
}

/**
 * Ownership marker field from a live object describe: Name, else Subject,
 * else the first wide createable filterable string. Null when ownership is
 * unprovable (the lifecycle refuses rather than mint an unmarked fixture).
 */
export function notificationFlowMarkerField(describeBody: unknown): string | null {
  if (!record(describeBody) || !Array.isArray(describeBody.fields)) return null;
  const fields = describeBody.fields.filter(record);
  const usable = (name: string): boolean => fields.some((field) =>
    field.name === name && field.createable === true && field.autoNumber !== true &&
    String(field.type ?? "").toLowerCase() !== "reference");
  if (usable("Name")) return "Name";
  if (usable("Subject")) return "Subject";
  const wide = fields.find((field) => typeof field.name === "string" && FIELD_NAME.test(field.name) &&
    field.createable === true && field.filterable === true &&
    ["string", "textarea", "combobox"].includes(String(field.type ?? "").toLowerCase()) &&
    typeof field.length === "number" && field.length >= 48 &&
    field.autoNumber !== true && field.calculated !== true);
  return typeof wide?.name === "string" ? wide.name : null;
}

/**
 * True when every email-typed value is empty or non-routable. Pure: the
 * pre-POST invariant gate, applied to built values AND to the live readback.
 */
export function recipientEmailsNonRoutable(values: Record<string, unknown>, emailFields: string[]): boolean {
  return emailFields.every((name) => {
    const value = values[name];
    if (value === null || value === undefined || value === "") return true;
    return typeof value === "string" && EMAIL.test(value) &&
      value.toLowerCase().endsWith(`@${UNDELIVERABLE_DOMAIN}`);
  });
}

const stringList = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return [];
};

/**
 * Assess the consumer invocation envelope: one Finished result whose whatIds
 * echo the owned record and whose mail results carry no failure text.
 */
export function assessNotificationFlowInvocation(
  status: number, body: unknown, ownedId: string,
): { ok: true; mailResults: string[] } | { ok: false; code: string; message: string } {
  if (status !== 200 || !Array.isArray(body) || body.length !== 1 || !record(body[0])) {
    return { ok: false, code: "NOTIFICATION_FLOW_CONSUMER_FAILED", message: "Salesforce did not return one Flow execution result." };
  }
  const result = body[0];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const outputValues = record(result.outputValues) ? result.outputValues : {};
  if (result.isSuccess !== true || errors.length > 0 || outputValues.Flow__InterviewStatus !== "Finished") {
    const detail = errors.map((entry) => record(entry) && typeof entry.message === "string" ? entry.message : null)
      .find(Boolean) ?? "The consumer Flow reported failure.";
    return { ok: false, code: "NOTIFICATION_FLOW_CONSUMER_FAILED", message: String(detail).slice(0, 300) };
  }
  if (!stringList(outputValues.whatIds).includes(ownedId)) {
    return { ok: false, code: "NOTIFICATION_FLOW_CONSUMER_UNVERIFIED", message: "The Finished interview did not echo the owned record in whatIds." };
  }
  const mailResults = stringList(outputValues.mailResults);
  for (const line of mailResults) {
    if (flowOutputFailureSnippet(line)) {
      return { ok: false, code: "NOTIFICATION_FLOW_CONSUMER_FAILED", message: `The consumer Flow reported its own send failed (${line.slice(0, 200)}).` };
    }
  }
  return { ok: true, mailResults };
}

export type NotificationFlowLifecycleInput = {
  root: string;
  route: string;
  /** Live integration-user id; the fixture creator must equal it (self proof). */
  selfUserId: string;
  /** Live integration-user email; read live by the caller, never guessed. */
  selfEmail: string;
  verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
};

export async function invokeNotificationFlowWithContext(input: NotificationFlowLifecycleInput): Promise<{
  status: number; body: any; cleanupError?: string; contextSchema?: Value;
}> {
  const { root, request } = input;
  const action = notificationFlowActionName(input.route);
  const automaticSteps = [
    "Pair the flow to its live email alerts by namespace and notification stem",
    "Create an owned fixture of the alert target object with a non-routable email",
    "Assert every fixture email is non-routable and the creator is self, then invoke with the owned whatIds",
    "Verify the Finished interview, the owned whatIds echo, and clean mail results",
    "Sweep addressed communication residue, delete only the owned record, and verify absence",
  ];
  const base = { source: "salesforce_live_notification_flow_consumer", action, automaticSteps };
  const done = (outcome: Result, extra: Value): { status: number; body: any; cleanupError?: string; contextSchema?: Value } => ({
    status: outcome.status, body: outcome.body,
    ...(typeof extra.cleanupError === "string" ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...base, ...extra },
  });
  if (!action || !root.startsWith("/services/data/") || !input.route.startsWith(`${root}/actions/`)) {
    return done(fail("NOTIFICATION_FLOW_ACTION_INVALID", "A discovered notification-flow consumer route is required."), { verified: false, invokedUpstream: false });
  }
  if (!identity(input.selfUserId) || typeof input.selfEmail !== "string" || !EMAIL.test(input.selfEmail)) {
    return done(fail("NOTIFICATION_FLOW_SELF_INVALID", "A live integration-user identity and email are required; neither is ever guessed."), { verified: false, invokedUpstream: false });
  }
  if (input.verificationWindowMs !== undefined &&
    (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail("NOTIFICATION_FLOW_WINDOW_INVALID", "A bounded verification window is required."), { verified: false, invokedUpstream: false });
  }
  const marker = `NF probe ${crypto.randomUUID()}`;
  const fixtureEmail = `notification-flow-${crypto.randomUUID()}@${UNDELIVERABLE_DOMAIN}`;
  const owned: Array<{ objectName: string; id: string; markerField: string }> = [];
  let cleanupError: string | undefined;
  let outcome: Result = fail("NOTIFICATION_FLOW_LIFECYCLE_UNVERIFIED", "The owned notification-flow lifecycle failed; ownership-scoped cleanup still runs.");
  let verified = false;
  let invokedUpstream = false;
  let fixtureObject: string | undefined;
  let pairedAlerts: string[] = [];
  let emailFields: string[] = [];
  let markerField: string | undefined;
  let emailsProven = false;
  let creatorSelfProven = false;
  let whatIdsEchoed = false;
  let mailResultCount = 0;
  let residueSweep: ResidueSweep | null = null;
  let buildMismatch: Value | undefined;
  try {
    outcome = await (async (): Promise<Result> => {
      const descriptor = await request(input.route);
      if (!descriptor.ok) return descriptor;
      const inputs = record(descriptor.body) && Array.isArray(descriptor.body.inputs)
        ? descriptor.body.inputs.filter(record) : [];
      const outputs = record(descriptor.body) && Array.isArray(descriptor.body.outputs)
        ? descriptor.body.outputs.filter(record) : [];
      const collection = (field: Value): boolean =>
        field.isCollection === true || (typeof field.maxOccurs === "number" && field.maxOccurs > 1);
      const whatIds = inputs.find((field) => field.name === "whatIds" &&
        String(field.type ?? "").toUpperCase() === "STRING" && field.required !== true && collection(field));
      const mailResults = inputs.find((field) => field.name === "mailResults" &&
        String(field.type ?? "").toUpperCase() === "STRING" && field.required !== true && collection(field));
      if (!whatIds || !mailResults || !outputs.some((field) => field.name === "Flow__InterviewStatus")) {
        return fail("NOTIFICATION_FLOW_SHAPE_INVALID", "The live Flow is not a whatIds email consumer with a mail-results echo.");
      }
      const whatIdsField = whatIds.name as string;
      const candidates: AlertCandidate[] = [];
      const catalog = await request(`${root}/actions/custom/emailAlert`);
      const collectAlert = async (url: string): Promise<void> => {
        if (candidates.length >= ALERT_DESCRIPTOR_CAP) return;
        if (typeof url !== "string" || !url.startsWith(`${root}/actions/`)) return;
        const described = await request(url);
        if (!described.ok || !record(described.body)) return;
        const fullName = String(described.body.name ?? "");
        const alertName = fullName.includes(".") ? fullName.slice(fullName.lastIndexOf(".") + 1) : fullName;
        if (ACTION_NAME.test(alertName) && typeof described.body.targetEntityName === "string" &&
          OBJECT_NAME.test(described.body.targetEntityName)) {
          candidates.push({ name: alertName, targetEntityName: described.body.targetEntityName });
        }
      };
      if (!catalog.ok || !record(catalog.body)) {
        return fail("NOTIFICATION_FLOW_ALERT_CATALOG_UNAVAILABLE", "The live email-alert catalog could not be listed; the fixture object cannot be derived.");
      }
      if (Array.isArray(catalog.body.actions)) {
        for (const entry of catalog.body.actions.filter(record)) await collectAlert(entry.url);
      } else {
        const subs = Object.entries(catalog.body)
          .filter(([name, path]) =>
            OBJECT_NAME.test(name) && typeof path === "string" && path.startsWith(`${root}/actions/`))
          .slice(0, ALERT_SUBCATALOG_CAP);
        if (!subs.length) {
          return fail("NOTIFICATION_FLOW_ALERT_CATALOG_UNAVAILABLE", "The live email-alert catalog exposes no usable shape; the fixture object cannot be derived.");
        }
        for (const [, path] of subs) {
          const sub = await request(path);
          if (!sub.ok || !record(sub.body) || !Array.isArray(sub.body.actions)) continue;
          for (const entry of sub.body.actions.filter(record)) await collectAlert(entry.url);
        }
      }
      const paired = pairNotificationFlowAlerts(action, candidates);
      if ("failure" in paired) return fail("NOTIFICATION_FLOW_ALERT_UNPAIRED", paired.failure);
      fixtureObject = paired.objectName;
      pairedAlerts = paired.alertNames;
      const schema = await request(`${root}/sobjects/${fixtureObject}/describe`);
      if (!schema.ok || !record(schema.body) || schema.body.createable !== true ||
        schema.body.deletable !== true || schema.body.queryable !== true || !Array.isArray(schema.body.fields)) {
        return fail("NOTIFICATION_FLOW_FIXTURE_PERMISSIONS_REQUIRED",
          `Automatic notification-flow context requires live ${fixtureObject} create, read and delete access.`,
          { setupRequirement: `${fixtureObject} create/read/delete access for the execution user.` });
      }
      emailFields = notificationFlowEmailFields(schema.body);
      const markerCandidate = notificationFlowMarkerField(schema.body);
      if (!markerCandidate) {
        return fail("NOTIFICATION_FLOW_MARKER_UNAVAILABLE", `No provable ownership marker field exists on ${fixtureObject}; no unmarked fixture is minted.`);
      }
      markerField = markerCandidate;
      const built = await input.build(fixtureObject, marker,
        { [markerField]: marker, ...Object.fromEntries(emailFields.map((name) => [name, fixtureEmail])) });
      if ("failure" in built) return built.failure;
      if (built.values[markerField] !== marker || !recipientEmailsNonRoutable(built.values, emailFields)) {
        buildMismatch = { markerField, emailFields };
        return fail("NOTIFICATION_FLOW_BUILD_UNSCOPED", "The fixture builder changed a planned ownership or recipient field.");
      }
      const created = await request(`${root}/sobjects/${fixtureObject}`, "POST", built.values);
      const createdId: unknown = created.body?.id ?? created.body?.Id;
      if (!created.ok || !identity(createdId)) return created;
      owned.push({ objectName: fixtureObject, id: createdId, markerField });
      // THE INVARIANT (no POST before it passes): every fixture email is
      // non-routable AND the creator is self. Whichever recipient class the
      // alert config uses (record field or creator), the mail can only go
      // nowhere-routable or to the worker's own user.
      const actual = await request(`${root}/sobjects/${fixtureObject}/${createdId}`);
      const actualBody = record(actual.body) ? actual.body : null;
      emailsProven = !!actualBody && recipientEmailsNonRoutable(actualBody, emailFields);
      creatorSelfProven = !!actualBody && actualBody.CreatedById === input.selfUserId;
      if (!actual.ok || !actualBody || actualBody.Id !== createdId ||
        actualBody[markerField] !== marker || !emailsProven || !creatorSelfProven) {
        return fail("NOTIFICATION_FLOW_RECIPIENT_UNVERIFIED",
          "The owned fixture readback did not prove a non-routable-or-self recipient; the flow was not invoked.",
          { invariant: { markerEcho: actualBody?.[markerField] === marker, emailsNonRoutable: emailsProven, creatorIsSelf: creatorSelfProven } });
      }
      const invoked = await request(input.route, "POST", { inputs: [{ [whatIdsField]: [createdId] }] });
      invokedUpstream = true;
      const assessed = assessNotificationFlowInvocation(invoked.status, invoked.body, createdId);
      if (!assessed.ok) {
        return { ...fail(assessed.code, assessed.message, { upstreamOutcome: invoked.body }), status: invoked.status, ok: false };
      }
      whatIdsEchoed = true;
      mailResultCount = assessed.mailResults.length;
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
      verified = true;
      return invoked;
    })();
  } catch {
    verified = false;
  } finally {
    for (const entry of owned.slice().reverse()) {
      residueSweep = await sweepFlowCommunicationResidue(request, root, {
        contactIds: entry.objectName === "Contact" || entry.objectName === "Lead" ? [entry.id] : [],
        emails: [fixtureEmail],
      });
      if (residueSweep.queried && !residueSweep.verified) {
        cleanupError = "Temporary notification-flow communication residue cleanup could not be verified.";
      }
      await request(`${root}/sobjects/${entry.objectName}/${entry.id}`, "DELETE");
      const check = await request(`${root}/sobjects/${entry.objectName}/${entry.id}`);
      if (check.status !== 404) {
        cleanupError = "Owned notification-flow fixture cleanup could not be verified; the record may still exist.";
      } else {
        const swept = await request(`${root}/query?q=${encodeURIComponent(
          `SELECT Id FROM ${entry.objectName} WHERE ${entry.markerField}='${marker}' LIMIT 2`)}`);
        const rows = record(swept.body) && Array.isArray(swept.body.records) ? swept.body.records : null;
        if (!swept.ok || !rows || rows.length > 0) {
          cleanupError = "Owned notification-flow fixture cleanup could not be verified; a marker-scoped sibling may remain.";
        }
      }
    }
  }
  return done(outcome, {
    verified: cleanupError ? false : verified,
    invokedUpstream,
    marker, markerField: markerField ?? null,
    fixtureObject: fixtureObject ?? null, pairedAlerts, emailFields,
    recipientInvariant: { emailDomainClass: UNDELIVERABLE_DOMAIN, emailsNonRoutable: emailsProven, creatorIsSelf: creatorSelfProven },
    whatIdsEchoed, mailResultCount, residueSweep,
    ownedRecordId: owned[0]?.id ?? null,
    verificationRecordIds: owned.map((entry) => entry.id), ownedRecords: owned,
    ...(buildMismatch ? { buildMismatch } : {}),
    ...(cleanupError ? { cleanupError } : {}),
  });
}
