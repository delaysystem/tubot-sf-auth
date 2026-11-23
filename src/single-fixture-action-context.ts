/**
 * Single-fixture owned lifecycle for standard actions that operate on one
 * owned record addressed by a single identity input (runCampaign,
 * contentWorkspaceEnableFolders, updateVisualization, and future members).
 *
 * Generic mechanism, data-driven membership: the caller supplies the fixture
 * object, the identity input name, and the marker field. The lifecycle
 * creates one owned fixture carrying a unique marker, invokes the native
 * action with the fixture id, verifies the native acceptance, deletes only
 * the owned fixture, and verifies absence. No org IDs, aliases, tenant
 * names, or instance URLs appear here. No success is synthesized: the
 * native outcome passes through untouched, and unverified cleanup is an
 * explicit `cleanupError` with verification withheld.
 */

import { nativeActionSucceeded } from "./action-outcome";
import { seedRequiredReferenceValues } from "./fixture-reference-seeding";
import { clampVerificationWindowMs } from "./verification-window";

type Value = Record<string, unknown>;
type Result = { status: number; ok: boolean; body: any };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(value);
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

/** Action members: platform vocabulary (action name to fixture object, identity input, marker field). */
export const SINGLE_FIXTURE_ACTION_SPECS: Record<string, { object: string; idInput: string; markerField: string }> = {
  runCampaign: { object: "Campaign", idInput: "campaignId", markerField: "Name" },
  contentWorkspaceEnableFolders: { object: "ContentWorkspace", idInput: "Id", markerField: "Name" },
  updateVisualization: { object: "AnalyticsVisualization", idInput: "visualizationId", markerField: "MasterLabel" },
  generateWorkPlans: { object: "WorkOrder", idInput: "recordId", markerField: "Subject" },
};

/**
 * 88 seeds required fixture references from live lookups (borrowed rows are
 * never written) so resolvable references bind and genuinely unresolvable
 * ones refuse honest through the builder as before. Above the stranded 87
 * stamp so single-fixture rows re-audit.
 */
export const SINGLE_FIXTURE_BUILDER_VERSION = 88;

export type SingleFixtureInput = {
  root: string;
  route: string;
  /** Fixture object API name from the live spec map; never guessed. */
  target: string;
  /** Identity input name from the live spec map; never guessed. */
  idInput: string;
  markerField: string;
  /** Live integration-user id; used only when the fixture object requires an explicit OwnerId. */
  ownerId?: string;
  verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
};

export async function invokeSingleFixtureAction(input: SingleFixtureInput): Promise<{
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
  if (!IDENTIFIER.test(input.target) || !IDENTIFIER.test(input.idInput) || !IDENTIFIER.test(input.markerField)) {
    return done(fail("SINGLE_FIXTURE_SCHEMA_INVALID", "A discovered fixture object, identity input, and marker field are required."), { verified: false });
  }
  if (input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail("SINGLE_FIXTURE_WINDOW_INVALID", "A bounded verification window is required."), { verified: false });
  }
  const schema = await request(`${root}/sobjects/${input.target}/describe`);
  if (!schema.ok) return done(schema, { verified: false });
  if (!record(schema.body) || schema.body.createable !== true || schema.body.queryable !== true ||
    schema.body.deletable !== true || !Array.isArray(schema.body.fields)) {
    return done(fail("SINGLE_FIXTURE_PERMISSIONS_REQUIRED",
      `Automatic ${input.target} context requires live create, read and delete access.`), { verified: false });
  }
  const fields = (schema.body.fields as unknown[]).filter(record);
  const markerSchema = fields.find((field) => field.name === input.markerField);
  const markerLength = typeof markerSchema?.length === "number" ? markerSchema.length : 80;
  if (!markerSchema || markerSchema.createable !== true || markerSchema.filterable !== true || markerLength < 24) {
    return done(fail("SINGLE_FIXTURE_MARKER_UNAVAILABLE",
      `The live ${input.target} object exposes no writable, filterable marker field for independent verification.`), { verified: false });
  }
  const marker = `AS probe ${crypto.randomUUID()}`.slice(0, Math.min(255, Math.max(24, markerLength)));
  const automaticSteps = [
    "Resolve the fixture object and identity input from the live action spec",
    `Create an owned disposable ${input.target} carrying a unique verifiable marker`,
    `Invoke the native action with the owned ${input.target} identity`,
    "Verify the native acceptance envelope",
    "Delete only the owned fixture and verify absence",
  ];
  const base = { source: "salesforce_live_single_fixture_action", action, targetObject: input.target, idInput: input.idInput, automaticSteps };
  let ownedId: string | undefined;
  let cleanupError: string | undefined;
  let outcome: Result = fail("SINGLE_FIXTURE_CONTEXT_UNAVAILABLE", "The owned single-fixture context could not be prepared.");
  let verified = false;
  const ownerField = fields.find((field) => field.name === "OwnerId" && field.type === "reference");
  const ownerValues = ownerField && identity(input.ownerId) ? { OwnerId: input.ownerId } : {};
  // Required fixture references seed from live lookups (borrowed rows are
  // never written); unresolved fields fail honest through the builder as
  // before. Native platform actions only: this lifecycle never invokes
  // tenant flows, so the borrow leg stays allowed. The unique marker and
  // the verified OwnerId pin stay authoritative over borrowed live ids.
  const refSeed = await seedRequiredReferenceValues(request, root, fields);
  try {
    const built = await input.build(input.target, marker, { ...refSeed.overrides, [input.markerField]: marker, ...ownerValues });
    if ("failure" in built) {
      outcome = built.failure;
    } else if (built.values[input.markerField] !== marker) {
      outcome = fail("SINGLE_FIXTURE_BUILD_UNSCOPED", "The fixture builder changed a planned ownership field.");
    } else {
      const created = await request(`${root}/sobjects/${input.target}`, "POST", built.values);
      const createdId: unknown = created.body?.id ?? created.body?.Id;
      if (!created.ok || !identity(createdId)) {
        outcome = created;
      } else {
        ownedId = createdId;
        const actual = await request(`${root}/sobjects/${input.target}/${ownedId}`);
        if (!actual.ok || actual.body?.[input.markerField] !== marker) {
          outcome = fail("SINGLE_FIXTURE_UNVERIFIED", "The owned fixture readback did not carry the marker.");
        } else {
          const invoked = await request(input.route, "POST", { inputs: [{ [input.idInput]: ownedId }] });
          outcome = invoked;
          verified = nativeActionSucceeded(invoked.status, invoked.body);
          if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
        }
      }
    }
  } finally {
    if (ownedId) {
      await request(`${root}/sobjects/${input.target}/${ownedId}`, "DELETE");
      const check = await request(`${root}/sobjects/${input.target}/${ownedId}`);
      if (check.status !== 404) {
        cleanupError = "Owned single-fixture cleanup could not be verified; the record may still exist.";
      } else {
        const swept = await request(`${root}/query?q=${encodeURIComponent(
          `SELECT Id FROM ${input.target} WHERE ${input.markerField}='${marker}' LIMIT 2`)}`);
        const rows = record(swept.body) && Array.isArray(swept.body.records) ? swept.body.records : null;
        if (!swept.ok || !rows || rows.length > 0) {
          cleanupError = "Owned single-fixture cleanup could not be verified; a marker-scoped sibling may remain.";
        }
      }
    }
  }
  return done(outcome, {
    ...base, verified: cleanupError ? false : verified, marker, markerField: input.markerField,
    ownedRecordId: ownedId ?? null, verificationRecordIds: ownedId ? [ownedId] : [],
    ...(cleanupError ? { cleanupError } : {}),
  });
}
