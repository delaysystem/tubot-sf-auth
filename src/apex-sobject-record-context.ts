/**
 * Apex SOBJECT-record owned lifecycle for invocable Apex that dereferences
 * a passed record (and its parents) instead of an id.
 *
 * Root cause (blind-verified via admin CLI against the live OOA utility):
 * SDO_SCOM_OOA_Utility.updateApprovalStatus loops approvalRecords, maps
 * Cart__c to WebCart rows, and UPDATEs them. An omitted (null) record list
 * null-derefs, and a record without a live Cart__c null-derefs on the
 * missed map lookup. Only an owned approval row linked to an owned cart
 * can ever be invoked.
 *
 * Generic mechanism, data-driven membership: the caller supplies an ordered
 * fixture chain (each with live-id, fixture-link, or live-picklist values),
 * the record input name and object, and an optional business-effect
 * readback. The lifecycle mints owned fixtures carrying unique markers,
 * invokes with the full read-back record, verifies the native acceptance
 * (plus the readback when declared), deletes only owned rows, and verifies
 * absence. No org IDs, aliases, tenant names, or instance URLs appear
 * here. No success is synthesized: the native outcome passes through
 * untouched, and unverified cleanup is an explicit `cleanupError` with
 * verification withheld.
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

export type ApexSObjectRecordValueSpec =
  | { liveId: string }
  | { fixture: string }
  | { picklistFirst: true }
  | { picklistMatch: string };

export type ApexSObjectRecordFixtureSpec = {
  key: string;
  object: string;
  markerField: string;
  values?: Record<string, ApexSObjectRecordValueSpec>;
};

export type ApexSObjectRecordSpec = {
  recordInput: string;
  object: string;
  fixtures: ApexSObjectRecordFixtureSpec[];
  values: Record<string, ApexSObjectRecordValueSpec>;
  verify?: { fixture: string; field: string; equalsField: string };
};

/** Action members: platform vocabulary (action name to record chain). */
export const APEX_SOBJECT_RECORD_SPECS: Record<string, ApexSObjectRecordSpec> = {
  SDO_SCOM_OOA_Utility: {
    recordInput: "approvalRecords",
    object: "SDO_SCOM_OOA_Commerce_Approval_Requests__c",
    fixtures: [
      { key: "account", object: "Account", markerField: "Name" },
      {
        key: "cart", object: "WebCart", markerField: "Name",
        values: { WebStoreId: { liveId: "WebStore" }, AccountId: { fixture: "account" } },
      },
    ],
    values: {
      Cart__c: { fixture: "cart" },
      Type__c: { picklistFirst: true },
      Status__c: { picklistMatch: "approved" },
    },
    verify: { fixture: "cart", field: "SDO_SCOM_OOA_Credit_Override_Status__c", equalsField: "Status__c" },
  },
};

/**
 * 150 owns re-audit of apex SOBJECT-record rows (above the generic
 * apex-probe 140 stamp the members carry).
 */
export const APEX_SOBJECT_RECORD_BUILDER_VERSION = 150;

export type ApexSObjectRecordInput = {
  root: string;
  route: string;
  actionName: string;
  verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
};

type ResolvedValues = { values: Value } | { failure: Result };

export async function invokeApexSObjectRecord(input: ApexSObjectRecordInput): Promise<{
  status: number; body: any; cleanupError?: string; contextSchema?: Value;
}> {
  const { root, request } = input;
  const fail = (errorCode: string, message: string): Result =>
    ({ status: 422, ok: false, body: { errorCode, message } });
  const done = (outcome: Result, contextSchema: Value) => ({
    status: outcome.status, body: outcome.body, contextSchema,
    ...(contextSchema.cleanupError ? { cleanupError: contextSchema.cleanupError as string } : {}),
  });
  const base = { source: "salesforce_live_apex_sobject_record", action: input.actionName, verified: false };
  const spec = APEX_SOBJECT_RECORD_SPECS[input.actionName];
  if (!spec || !IDENTIFIER.test(spec.recordInput) || !IDENTIFIER.test(spec.object)) {
    return done(fail("APEX_SOBJECT_SPEC_INVALID", "A discovered apex record spec with input and object names is required."), base);
  }
  if (input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail("APEX_SOBJECT_WINDOW_INVALID", "A bounded verification window is required."), base);
  }
  const automaticSteps = [
    "Resolve the fixture chain and record input from the live action spec",
    "Create owned disposable fixtures carrying unique verifiable markers",
    "Create the owned record linked to its fixtures",
    "Invoke the native action with the full read-back record",
    "Verify the native acceptance and the declared business-effect readback",
    "Delete only owned rows and verify absence",
  ];
  const schema = { ...base, recordInput: spec.recordInput, recordObject: spec.object, automaticSteps };

  const describeFields = async (objectName: string): Promise<{ fields: Record<string, unknown>[] } | { failure: Result }> => {
    if (!IDENTIFIER.test(objectName)) {
      return { failure: fail("APEX_SOBJECT_SPEC_INVALID", "A discovered fixture object name is required.") };
    }
    const described = await request(`${root}/sobjects/${objectName}/describe`);
    if (!described.ok) return { failure: described };
    if (!record(described.body) || described.body.createable !== true || described.body.queryable !== true ||
      described.body.deletable !== true || !Array.isArray(described.body.fields)) {
      return { failure: fail("APEX_SOBJECT_PERMISSIONS_REQUIRED",
        `Automatic ${objectName} context requires live create, read and delete access.`) };
    }
    return { fields: (described.body.fields as unknown[]).filter(record) };
  };

  const picklistValues = (fields: Record<string, unknown>[], name: string): string[] | null => {
    const field = fields.find((entry) => entry.name === name);
    if (!field || !Array.isArray(field.picklistValues)) return null;
    return field.picklistValues.filter(record)
      .filter((entry) => entry.active === true && typeof entry.value === "string")
      .map((entry) => entry.value as string);
  };

  const resolveValues = async (
    fields: Record<string, unknown>[],
    values: Record<string, ApexSObjectRecordValueSpec> | undefined,
    fixtureIds: Map<string, string>,
  ): Promise<ResolvedValues> => {
    const resolved: Value = {};
    for (const [name, rule] of Object.entries(values ?? {})) {
      if (!IDENTIFIER.test(name)) {
        return { failure: fail("APEX_SOBJECT_SPEC_INVALID", "A discovered fixture field name is required.") };
      }
      const field = fields.find((entry) => entry.name === name);
      if (!field || field.createable !== true) {
        return { failure: fail("APEX_SOBJECT_FIELD_UNAVAILABLE",
          `The live schema exposes no createable ${name}; the fixture cannot carry it.`) };
      }
      if ("fixture" in rule) {
        const id = fixtureIds.get(rule.fixture);
        if (!identity(id)) {
          return { failure: fail("APEX_SOBJECT_FIXTURE_UNRESOLVED",
            `Fixture '${rule.fixture}' names no minted row; the chain order drifted.`) };
        }
        resolved[name] = id;
      } else if ("liveId" in rule) {
        if (!IDENTIFIER.test(rule.liveId)) {
          return { failure: fail("APEX_SOBJECT_SPEC_INVALID", "A discovered setup object name is required.") };
        }
        const found = await request(`${root}/query?q=${encodeURIComponent(`SELECT Id FROM ${rule.liveId} LIMIT 1`)}`);
        const row = found.ok && record(found.body) && Array.isArray(found.body.records)
          ? found.body.records.filter(record).find((entry) => identity(entry.Id)) : undefined;
        if (!row) {
          return { failure: fail("APEX_SOBJECT_LIVE_ID_REQUIRED",
            `The probe needs one live ${rule.liveId} row to link its owned fixtures; none exists. Provision the setup row, then retry.`) };
        }
        resolved[name] = row.Id;
      } else if ("picklistFirst" in rule) {
        const choices = picklistValues(fields, name);
        if (!choices || choices.length === 0) {
          return { failure: fail("APEX_SOBJECT_PICKLIST_REQUIRED",
            `The live ${name} picklist exposes no active value to bind.`) };
        }
        resolved[name] = choices[0];
      } else {
        let pattern: RegExp;
        try {
          pattern = new RegExp(rule.picklistMatch, "i");
        } catch {
          return { failure: fail("APEX_SOBJECT_SPEC_INVALID", "A compilable picklist pattern is required.") };
        }
        const choices = picklistValues(fields, name);
        const hit = choices?.find((value) => pattern.test(value));
        if (!hit) {
          return { failure: fail("APEX_SOBJECT_PICKLIST_REQUIRED",
            `The live ${name} picklist exposes no active value matching the declared contract.`) };
        }
        resolved[name] = hit;
      }
    }
    return { values: resolved };
  };

  const owned: Array<{ key: string; object: string; id: string; markerField?: string; marker?: string }> = [];
  const fixtureIds = new Map<string, string>();
  let outcome: Result = fail("APEX_SOBJECT_CONTEXT_UNAVAILABLE", "The owned apex record context could not be prepared.");
  let cleanupError: string | undefined;
  let verified = false;
  let businessVerified: boolean | undefined;
  let recordValues: Value = {};
  try {
    for (const fixture of spec.fixtures) {
      if (!IDENTIFIER.test(fixture.key) || !IDENTIFIER.test(fixture.object) || !IDENTIFIER.test(fixture.markerField)) {
        outcome = fail("APEX_SOBJECT_SPEC_INVALID", "A discovered fixture key, object, and marker field are required.");
        return done(outcome, schema);
      }
      const described = await describeFields(fixture.object);
      if ("failure" in described) {
        outcome = described.failure;
        return done(outcome, schema);
      }
      const markerSchema = described.fields.find((field) => field.name === fixture.markerField);
      const markerLength = typeof markerSchema?.length === "number" ? markerSchema.length : 80;
      if (!markerSchema || markerSchema.createable !== true || markerSchema.filterable !== true || markerLength < 24) {
        outcome = fail("APEX_SOBJECT_MARKER_UNAVAILABLE",
          `The live ${fixture.object} object exposes no writable, filterable marker field for independent verification.`);
        return done(outcome, schema);
      }
      const resolved = await resolveValues(described.fields, fixture.values, fixtureIds);
      if ("failure" in resolved) {
        outcome = resolved.failure;
        return done(outcome, schema);
      }
      const marker = `AS probe ${crypto.randomUUID()}`.slice(0, Math.min(255, Math.max(24, markerLength)));
      const built = await input.build(fixture.object, marker, { ...resolved.values, [fixture.markerField]: marker });
      if ("failure" in built) {
        outcome = built.failure;
        return done(outcome, schema);
      }
      if (built.values[fixture.markerField] !== marker) {
        outcome = fail("APEX_SOBJECT_BUILD_UNSCOPED", "The fixture builder changed a planned ownership field.");
        return done(outcome, schema);
      }
      const created = await request(`${root}/sobjects/${fixture.object}`, "POST", built.values);
      const createdId: unknown = created.body?.id ?? created.body?.Id;
      if (!created.ok || !identity(createdId)) {
        outcome = created;
        return done(outcome, schema);
      }
      owned.push({ key: fixture.key, object: fixture.object, id: createdId, markerField: fixture.markerField, marker });
      fixtureIds.set(fixture.key, createdId);
      const actual = await request(`${root}/sobjects/${fixture.object}/${createdId}`);
      if (!actual.ok || actual.body?.[fixture.markerField] !== marker) {
        outcome = fail("APEX_SOBJECT_UNVERIFIED", `The owned ${fixture.object} readback did not carry the marker.`);
        return done(outcome, schema);
      }
    }
    const described = await describeFields(spec.object);
    if ("failure" in described) {
      outcome = described.failure;
      return done(outcome, schema);
    }
    const resolved = await resolveValues(described.fields, spec.values, fixtureIds);
    if ("failure" in resolved) {
      outcome = resolved.failure;
      return done(outcome, schema);
    }
    const recordBuilt = await input.build(spec.object, `AS probe ${crypto.randomUUID()}`, resolved.values);
    if ("failure" in recordBuilt) {
      outcome = recordBuilt.failure;
      return done(outcome, schema);
    }
    recordValues = recordBuilt.values as Value;
    const created = await request(`${root}/sobjects/${spec.object}`, "POST", recordValues);
    const createdId: unknown = created.body?.id ?? created.body?.Id;
    if (!created.ok || !identity(createdId)) {
      outcome = created;
      return done(outcome, schema);
    }
    owned.push({ key: spec.recordInput, object: spec.object, id: createdId });
    const actual = await request(`${root}/sobjects/${spec.object}/${createdId}`);
    if (!actual.ok || !record(actual.body) || actual.body.Id !== createdId) {
      outcome = fail("APEX_SOBJECT_UNVERIFIED", "The owned record readback did not return the minted row.");
      return done(outcome, schema);
    }
    const invoked = await request(input.route, "POST", {
      inputs: [{ [spec.recordInput]: { ...actual.body, attributes: { type: spec.object } } }],
    });
    outcome = invoked;
    verified = nativeActionSucceeded(invoked.status, invoked.body);
    if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
    if (spec.verify && verified) {
      const target = owned.find((entry) => entry.key === spec.verify!.fixture);
      const expected = recordValues[spec.verify.equalsField];
      if (!target || expected === undefined) {
        businessVerified = false;
      } else {
        const reread = await request(`${root}/sobjects/${target.object}/${target.id}`);
        businessVerified = reread.ok && record(reread.body) && reread.body[spec.verify.field] === expected;
      }
      if (businessVerified !== true) verified = false;
    }
  } finally {
    for (const entry of owned.reverse()) {
      await request(`${root}/sobjects/${entry.object}/${entry.id}`, "DELETE");
      const check = await request(`${root}/sobjects/${entry.object}/${entry.id}`);
      if (check.status !== 404) {
        cleanupError = "Owned apex record cleanup could not be verified; the record may still exist.";
        continue;
      }
      if (entry.markerField && entry.marker) {
        const swept = await request(`${root}/query?q=${encodeURIComponent(
          `SELECT Id FROM ${entry.object} WHERE ${entry.markerField}='${entry.marker}' LIMIT 2`)}`);
        const rows = record(swept.body) && Array.isArray(swept.body.records) ? swept.body.records : null;
        if (!swept.ok || !rows || rows.length > 0) {
          cleanupError = "Owned apex record cleanup could not be verified; a marker-scoped sibling may remain.";
        }
      }
    }
  }
  return done(outcome, {
    ...schema, verified: cleanupError ? false : verified,
    ...(businessVerified !== undefined ? { businessVerified } : {}),
    ownedRecordIds: owned.map((entry) => entry.id),
    ...(cleanupError ? { cleanupError } : {}),
  });
}
