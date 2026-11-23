/**
 * Fixture-backed reads for standard read actions on rowless orgs.
 *
 * Generic mechanism, data-driven membership: when an org holds zero rows of
 * the resolved object, read actions (getRecord, getRelatedList) must NOT be
 * sent synthetic ids as a success path. Instead this lifecycle creates one
 * owned fixture carrying a unique marker, invokes the native read with the
 * fixture id plus the searcher's live-resolved arguments (objectApiName,
 * relatedListName), verifies the native response references the owned id,
 * deletes only the owned fixture, and verifies absence. No org IDs,
 * aliases, tenant names, or instance URLs appear here. No success is
 * synthesized: the native outcome passes through untouched, and unverified
 * cleanup is an explicit `cleanupError` with verification withheld.
 */

import { nativeActionSucceeded } from "./action-outcome";
import { clampVerificationWindowMs } from "./verification-window";

type Value = Record<string, unknown>;
type Result = { status: number; ok: boolean; body: any };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(value);
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

/**
 * Action members: platform vocabulary (action name to identity input).
 * getRelatedList answers list metadata that need not echo the parent id,
 * so its verification is native acceptance (the backend 400s unknown parent
 * ids, which makes acceptance meaningful); getRecord must echo the id.
 */
export const FIXTURE_READ_ACTION_SPECS: Record<string, { idInput: string; verifyIdentityInResponse: boolean }> = {
  getRecord: { idInput: "recordId", verifyIdentityInResponse: true },
  getRelatedList: { idInput: "parentRecordId", verifyIdentityInResponse: false },
};

export const FIXTURE_READ_BUILDER_VERSION = 92;

export type FixtureReadInput = {
  root: string;
  route: string;
  /** Fixture object API name resolved live by the searcher; never guessed. */
  target: string;
  /** Identity input name from the live spec map; never guessed. */
  idInput: string;
  /** Whether the native response must echo the owned identity. */
  verifyIdentityInResponse: boolean;
  /** Searcher-resolved read arguments (objectApiName, relatedListName, ...). */
  args: Value;
  verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
};

export async function invokeFixtureBackedRead(input: FixtureReadInput): Promise<{
  status: number; body: any; cleanupError?: string; contextSchema?: Value;
}> {
  const { root, request } = input;
  const action = input.route.split("/").at(-1) ?? "";
  const fail = (errorCode: string, message: string, extra?: Value): Result =>
    ({ status: 422, ok: false, body: { errorCode, message, ...extra } });
  const done = (outcome: Result, contextSchema: Value) => ({
    status: outcome.status, body: outcome.body, contextSchema,
    ...(contextSchema.cleanupError ? { cleanupError: contextSchema.cleanupError as string } : {}),
  });
  if (!IDENTIFIER.test(input.target) || !IDENTIFIER.test(input.idInput) ||
      !record(input.args) || Object.keys(input.args).length > 20) {
    return done(fail("FIXTURE_READ_SCHEMA_INVALID", "A discovered fixture object, identity input, and bounded read arguments are required."), { verified: false });
  }
  if (input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail("FIXTURE_READ_WINDOW_INVALID", "A bounded verification window is required."), { verified: false });
  }
  const schema = await request(`${root}/sobjects/${input.target}/describe`);
  if (!schema.ok) return done(schema, { verified: false });
  if (!record(schema.body) || schema.body.createable !== true || schema.body.queryable !== true ||
    schema.body.deletable !== true || !Array.isArray(schema.body.fields)) {
    return done(fail("FIXTURE_READ_PERMISSIONS_REQUIRED",
      `Automatic ${input.target} context requires live create, read and delete access.`), { verified: false });
  }
  const fields = (schema.body.fields as unknown[]).filter(record);
  const markers = fields.filter((field) => field.createable === true && field.filterable === true &&
    field.type === "string" && typeof field.length === "number" && field.length >= 24 &&
    field.calculated !== true && field.autoNumber !== true);
  const markerSchema = markers.find((field) => field.nameField === true) ??
    markers.find((field) => field.name === "Name") ?? markers[0];
  const markerLength = typeof markerSchema?.length === "number" ? markerSchema.length : 0;
  if (!markerSchema || typeof markerSchema.name !== "string" || markerLength < 24) {
    return done(fail("FIXTURE_READ_MARKER_UNAVAILABLE",
      `The live ${input.target} object exposes no writable, filterable marker field for independent verification.`), { verified: false });
  }
  const markerField = markerSchema.name as string;
  const marker = `AS probe ${crypto.randomUUID()}`.slice(0, Math.min(255, Math.max(24, markerLength)));
  const automaticSteps = [
    "Resolve the fixture object and identity input from the live action spec",
    `Create an owned disposable ${input.target} carrying a unique verifiable marker`,
    `Invoke the native read with the owned ${input.target} identity`,
    "Verify the native response references the owned identity",
    "Delete only the owned fixture and verify absence",
  ];
  const base = { source: "salesforce_live_fixture_backed_read", action, targetObject: input.target, idInput: input.idInput, automaticSteps };
  let ownedId: string | undefined;
  let cleanupError: string | undefined;
  let outcome: Result = fail("FIXTURE_READ_CONTEXT_UNAVAILABLE", "The owned fixture-backed read context could not be prepared.");
  let verified = false;
  try {
    const built = await input.build(input.target, marker, { [markerField]: marker });
    if ("failure" in built) {
      outcome = built.failure;
    } else if (built.values[markerField] !== marker) {
      outcome = fail("FIXTURE_READ_BUILD_UNSCOPED", "The fixture builder changed a planned ownership field.");
    } else {
      const created = await request(`${root}/sobjects/${input.target}`, "POST", built.values);
      const createdId: unknown = created.body?.id ?? created.body?.Id;
      if (!created.ok || !identity(createdId)) {
        outcome = created;
      } else {
        ownedId = createdId;
        const actual = await request(`${root}/sobjects/${input.target}/${ownedId}`);
        if (!actual.ok || actual.body?.[markerField] !== marker) {
          outcome = fail("FIXTURE_READ_UNVERIFIED", "The owned fixture readback did not carry the marker.");
        } else {
          const invoked = await request(input.route, "POST", { inputs: [{ ...input.args, [input.idInput]: ownedId }] });
          outcome = invoked;
          verified = nativeActionSucceeded(invoked.status, invoked.body) &&
            (!input.verifyIdentityInResponse || JSON.stringify(invoked.body ?? null).includes(ownedId.slice(0, 15)));
          if (verified && input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
          if (invoked.ok && !verified) {
            outcome = fail("FIXTURE_READ_RESPONSE_UNVERIFIED", "Salesforce answered without referencing the owned fixture identity.", { upstreamOutcome: invoked.body });
          }
        }
      }
    }
  } finally {
    if (ownedId) {
      await request(`${root}/sobjects/${input.target}/${ownedId}`, "DELETE");
      const check = await request(`${root}/sobjects/${input.target}/${ownedId}`);
      if (check.status !== 404) {
        cleanupError = "Owned fixture-backed read cleanup could not be verified; the record may still exist.";
      } else {
        const swept = await request(`${root}/query?q=${encodeURIComponent(
          `SELECT Id FROM ${input.target} WHERE ${markerField}='${marker}' LIMIT 2`)}`);
        const rows = record(swept.body) && Array.isArray(swept.body.records) ? swept.body.records : null;
        if (!swept.ok || !rows || rows.length > 0) {
          cleanupError = "Owned fixture-backed read cleanup could not be verified; a marker-scoped sibling may remain.";
        }
      }
    }
  }
  return done(outcome, {
    ...base, verified: cleanupError ? false : verified, marker, markerField,
    ownedRecordId: ownedId ?? null, verificationRecordIds: ownedId ? [ownedId] : [],
    ...(cleanupError ? { cleanupError } : {}),
  });
}
