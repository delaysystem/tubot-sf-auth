/**
 * Owned invocable-Apex-relay lifecycle (`custom/apex/*` relay contract).
 *
 * Root cause (blind-verified 2026-10-04, UNSAFE2 + GATEAUDIT, live
 * Tooling-read Apex body independently confirmed): the `dispatcher` /
 * `relay` verbs in the searcher's skip heuristic terminally skip every
 * invocable relay as STATE_CHANGING_ACTION_SKIPPED, even when the
 * invocable is query-only + payload-render with no DML, no callout, and
 * no send (the "dispatch" only resolves `Type.forName` and returns a
 * success envelope; nothing is ever transmitted).
 *
 * This module runs the proven shape: an owned MessagingEndUser plus an
 * owned Ended MessagingSession (non-Ended sessions are API-unmintable),
 * a native invoke with the predefined message key only, session-
 * unchanged readback, then ordered deletion with marker-sweep
 * verification. It refuses to fabricate identities: the fixture owner is
 * always a caller-supplied live user id, the channel is read live
 * (Text preferred), and the message key resolves from the live
 * descriptor description (never custom content, never
 * `simulateFailure`). No org id, alias, class name, or URL appears here.
 */

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
import { ACTION_NAME } from "./action-route-patterns";
import { clampVerificationWindowMs } from "./verification-window";

const REQUIRED_INPUTS = new Set(["recordId", "messageChoice"]);
const OPTIONAL_INPUTS = new Set(["serviceChannel", "simulateFailure"]);

const record = (value: unknown): value is Value =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && SF_ID.test(value);

const fail = (errorCode: string, message: string, extra?: Value): Result => ({
  status: 422, ok: false, body: { errorCode, message, ...extra },
});

/**
 * Parse a live invocable-apex route. Returns the class name, or null when
 * the route is not in this family. Classification uses the route shape
 * only; no class name is ever enumerated here.
 */
export function apexRelayActionName(route: string): string | null {
  const match = typeof route === "string"
    ? route.match(/^\/services\/data\/v\d+(?:\.\d+)?\/actions\/custom\/apex\/([A-Za-z][A-Za-z0-9_]{0,127})$/)
    : null;
  const name = match?.[1] ?? null;
  return name !== null && ACTION_NAME.test(name) ? name : null;
}

/**
 * True when the descriptor inputs are exactly the relay contract: required
 * `recordId` + `messageChoice`, optional-only `serviceChannel` /
 * `simulateFailure`, nothing else. The external-callout twin
 * (`content`/`sender`/`userId`) can never match.
 */
export function apexRelayInputSetValid(descriptorInputs: unknown): boolean {
  const inputs = Array.isArray(descriptorInputs) ? descriptorInputs.filter(record) : [];
  if (!inputs.every((field) => typeof field.name === "string" && FIELD_NAME.test(field.name))) return false;
  const required = new Set(inputs.filter((field) => field.required === true).map((field) => field.name as string));
  if (required.size !== REQUIRED_INPUTS.size) return false;
  for (const name of REQUIRED_INPUTS) if (!required.has(name)) return false;
  for (const field of inputs) {
    const name = field.name as string;
    if (!REQUIRED_INPUTS.has(name) && !OPTIONAL_INPUTS.has(name)) return false;
  }
  return true;
}

/**
 * Resolve the predefined message key from the live `messageChoice`
 * description (e.g. "(Greeting, System Maintenance Notice, ...)").
 * Falls back to `Greeting` when the description carries no key list.
 * Never returns custom content.
 */
export function apexRelayMessageKey(descriptorInputs: unknown): string {
  const inputs = Array.isArray(descriptorInputs) ? descriptorInputs.filter(record) : [];
  const field = inputs.find((entry) => entry.name === "messageChoice");
  const description = typeof field?.description === "string" ? field.description : "";
  const list = description.match(/\(([^()]*)\)/);
  if (list) {
    const key = list[1].split(",").map((part) => part.trim()).find((part) => /^[A-Za-z][A-Za-z0-9 ]{0,63}$/.test(part));
    if (key) return key;
  }
  return "Greeting";
}

/** True when the envelope reports relay success with a recordId echo. */
export function apexRelayAccepted(status: number, body: unknown, sessionId: string): boolean {
  if (!(status >= 200 && status < 300) || !Array.isArray(body) || body.length !== 1) return false;
  const item = body[0];
  if (!record(item) || item.isSuccess !== true) return false;
  if (!(item.errors === null || item.errors === undefined ||
    (Array.isArray(item.errors) && item.errors.length === 0))) return false;
  const outputs = record(item.outputValues) ? item.outputValues : null;
  return outputs !== null && outputs.success === true && outputs.recordId === sessionId;
}

const activePicklist = (fields: Value[], name: string): string[] => {
  const field = fields.find((entry) => record(entry) && entry.name === name);
  const values = record(field) && Array.isArray(field.picklistValues) ? field.picklistValues : [];
  return values.filter((entry) => record(entry) && entry.active === true && typeof entry.value === "string")
    .map((entry) => entry.value as string);
};

export type ApexRelayLifecycleInput = {
  root: string;
  route: string;
  /** Live user id owning the fixtures; never guessed. */
  ownerUserId: string;
  verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
};

export async function invokeApexRelayWithContext(input: ApexRelayLifecycleInput): Promise<{
  status: number; body: any; cleanupError?: string; contextSchema?: Value;
}> {
  const { root, request } = input;
  const action = apexRelayActionName(input.route);
  const automaticSteps = [
    "Resolve the recordId and messageChoice inputs from the live descriptor",
    "Create an owned Ended MessagingSession fixture with a fictional end-user key",
    "Invoke with the predefined key and verify the success envelope",
    "Verify the session is unchanged, delete owned fixtures, verify absence",
  ];
  const base = { source: "salesforce_live_apex_relay_action", action, automaticSteps };
  const done = (outcome: Result, extra: Value): { status: number; body: any; cleanupError?: string; contextSchema?: Value } => ({
    status: outcome.status, body: outcome.body,
    ...(typeof extra.cleanupError === "string" ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...base, ...extra },
  });
  if (!action || !root.startsWith("/services/data/") || !input.route.startsWith(`${root}/actions/`)) {
    return done(fail("APEX_RELAY_ACTION_INVALID", "A discovered invocable apex relay route is required."), { verified: false });
  }
  if (!identity(input.ownerUserId)) {
    return done(fail("APEX_RELAY_OWNER_INVALID", "A live fixture-owner user identity is required; none is ever guessed."), { verified: false });
  }
  if (input.verificationWindowMs !== undefined &&
    (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail("APEX_RELAY_WINDOW_INVALID", "A bounded verification window is required."), { verified: false });
  }
  const marker = `AR relay ${crypto.randomUUID()}`;
  const owned: Array<{ objectName: string; id: string; markerField: string | null }> = [];
  let cleanupError: string | undefined;
  let outcome: Result = fail("APEX_RELAY_CONTEXT_UNAVAILABLE", "The owned relay context could not be prepared.");
  let verified = false;
  let sessionId: string | undefined;
  let endUserId: string | undefined;
  let messageKey = "Greeting";
  let sessionUnchanged: boolean | null = null;
  try {
    outcome = await (async (): Promise<Result> => {
      const descriptor = await request(input.route);
      if (!descriptor.ok) return descriptor;
      const descriptorInputs = record(descriptor.body) ? descriptor.body.inputs : undefined;
      if (!apexRelayInputSetValid(descriptorInputs)) {
        return fail("APEX_RELAY_ACTION_SCHEMA_MISMATCH",
          "The live descriptor does not declare exactly the relay input contract; the native call was not attempted.");
      }
      messageKey = apexRelayMessageKey(descriptorInputs);
      const channels = await request(`${root}/query?q=${encodeURIComponent(
        "SELECT Id, MessageType FROM MessagingChannel WHERE IsActive=true LIMIT 20")}`);
      const rows = channels.ok && record(channels.body) && Array.isArray(channels.body.records)
        ? channels.body.records.filter(record) : [];
      const usable = rows.filter((row) => identity(row.Id) && typeof row.MessageType === "string");
      if (!usable.length) {
        return fail("APEX_RELAY_SUBSTRATE_ABSENT", "No active MessagingChannel exists for the owned fixtures.");
      }
      const channel = usable.find((row) => row.MessageType === "Text") ?? usable[0];
      for (const name of ["MessagingEndUser", "MessagingSession"]) {
        const schema = await request(`${root}/sobjects/${name}/describe`);
        if (!schema.ok || !record(schema.body) || schema.body.createable !== true ||
          schema.body.deletable !== true || schema.body.queryable !== true || !Array.isArray(schema.body.fields)) {
          return fail("APEX_RELAY_FIXTURE_PERMISSIONS_REQUIRED",
            `Automatic relay context requires live ${name} create, read and delete access.`);
        }
        if (name === "MessagingEndUser") {
          const types = activePicklist(schema.body.fields, "MessageType");
          const messageType = types.includes(channel.MessageType as string) ? channel.MessageType : types[0];
          if (typeof messageType !== "string" || !messageType) {
            return fail("APEX_RELAY_SUBSTRATE_ABSENT", "No usable MessagingEndUser MessageType picklist value exists.");
          }
          const digits = `${Date.now()}`.slice(-4) + String(Math.floor(Math.random() * 1000)).padStart(3, "0");
          const built = await input.build(name, marker, { OwnerId: input.ownerUserId, Name: marker,
            MessagingChannelId: channel.Id, MessageType: messageType,
            MessagingPlatformKey: `+1555${digits}`, HasInitialResponseSent: false });
          if ("failure" in built) return built.failure;
          const created = await request(`${root}/sobjects/${name}`, "POST", built.values);
          const createdId: unknown = created.body?.id ?? created.body?.Id;
          if (!created.ok || !identity(createdId)) return created;
          endUserId = createdId;
          owned.push({ objectName: name, id: createdId, markerField: "Name" });
          const actual = await request(`${root}/sobjects/${name}/${endUserId}`);
          if (!actual.ok || actual.body?.Name !== marker) {
            return fail("APEX_RELAY_FIXTURE_UNVERIFIED", "The owned end-user fixture readback did not carry the marker.");
          }
        } else {
          const origins = activePicklist(schema.body.fields, "Origin");
          const origin = origins.includes("AgentInitiated") ? "AgentInitiated" : origins[0];
          if (typeof origin !== "string" || !origin) {
            return fail("APEX_RELAY_SUBSTRATE_ABSENT", "No usable MessagingSession Origin picklist value exists.");
          }
          const built = await input.build(name, marker, { OwnerId: input.ownerUserId,
            MessagingChannelId: channel.Id, MessagingEndUserId: endUserId, Status: "Ended", Origin: origin });
          if ("failure" in built) return built.failure;
          const created = await request(`${root}/sobjects/${name}`, "POST", built.values);
          const createdId: unknown = created.body?.id ?? created.body?.Id;
          if (!created.ok || !identity(createdId)) return created;
          sessionId = createdId;
          owned.push({ objectName: name, id: createdId, markerField: null });
        }
      }
      const invoked = await request(input.route, "POST",
        { inputs: [{ recordId: sessionId, messageChoice: messageKey }] });
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
      const accepted = sessionId !== undefined && apexRelayAccepted(invoked.status, invoked.body, sessionId);
      const readback = sessionId === undefined ? null : await request(
        `${root}/query?q=${encodeURIComponent(`SELECT Status FROM MessagingSession WHERE Id='${sessionId}'`)}`);
      const readbackRows = readback !== null && readback.ok && record(readback.body) && Array.isArray(readback.body.records)
        ? readback.body.records.filter(record) : [];
      sessionUnchanged = readbackRows.length === 1 && readbackRows[0].Status === "Ended";
      verified = accepted && sessionUnchanged;
      if (!verified) return invoked;
      return invoked;
    })();
  } catch {
    if (outcome.body?.errorCode === "APEX_RELAY_CONTEXT_UNAVAILABLE") {
      outcome = fail("APEX_RELAY_LIFECYCLE_UNVERIFIED", "The owned relay lifecycle failed; ownership-scoped cleanup still runs.");
    }
    verified = false;
  } finally {
    for (const entry of owned.slice().reverse()) {
      await request(`${root}/sobjects/${entry.objectName}/${entry.id}`, "DELETE");
      const check = await request(`${root}/sobjects/${entry.objectName}/${entry.id}`);
      if (check.status !== 404) {
        cleanupError = "Owned relay fixture cleanup could not be verified; the record may still exist.";
      } else if (entry.markerField !== null) {
        const swept = await request(`${root}/query?q=${encodeURIComponent(
          `SELECT Id FROM ${entry.objectName} WHERE ${entry.markerField}='${marker}' LIMIT 2`)}`);
        const rows = record(swept.body) && Array.isArray(swept.body.records) ? swept.body.records : null;
        if (!swept.ok || !rows || rows.length > 0) {
          cleanupError = "Owned relay fixture cleanup could not be verified; a marker-scoped sibling may remain.";
        }
      }
    }
  }
  return done(outcome, {
    verified: cleanupError ? false : verified,
    marker, sessionId: sessionId ?? null, endUserId: endUserId ?? null,
    messageKey, sessionUnchanged,
    verificationRecordIds: sessionId ? [sessionId] : [], ownedRecords: owned,
    ...(cleanupError ? { cleanupError } : {}),
  });
}
