/**
 * Owned dual-asset lifecycle for standard actions that link two distinct
 * asset rows (replaceAsset).
 *
 * Root cause (blind-verified via admin CLI against the live action): the
 * probe binds one live Asset id per object plus a synthetic for the
 * mis-resolved relatedAssetId, and the backend rejects the synthetic as
 * "We couldn't find ReplacementAssetId". Binding the same live id twice
 * faults "the same asset". Only two distinct live Asset rows convert,
 * and every conversion mints an AssetRelationship, so the probe mints
 * two owned assets, verifies the created relationship by readback, then
 * deletes the relationship and both assets and verifies absence.
 *
 * Generic mechanism, data-driven membership: the caller supplies the two
 * id input names; the lifecycle mints owned assets carrying unique
 * markers against one live parent account, invokes, verifies the native
 * acceptance plus the relationship readback, deletes only owned rows,
 * and verifies absence. No org IDs, aliases, tenant names, or instance
 * URLs appear here. No success is synthesized: the native outcome passes
 * through untouched, and unverified cleanup is an explicit
 * `cleanupError` with verification withheld.
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

export type AssetReplaceSpec = { idInput: string; relatedInput: string };

/** Action members: platform vocabulary (action name to dual-id inputs). */
export const ASSET_REPLACE_SPECS: Record<string, AssetReplaceSpec> = {
  replaceAsset: { idInput: "assetId", relatedInput: "relatedAssetId" },
};

/** 151 owns re-audit of asset dual-id rows (above the generic 85 stamp the members carry). */
export const ASSET_REPLACE_BUILDER_VERSION = 151;

export type AssetReplaceInput = {
  root: string;
  route: string;
  actionName: string;
  verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
};

export async function invokeAssetReplace(input: AssetReplaceInput): Promise<{
  status: number; body: any; cleanupError?: string; contextSchema?: Value;
}> {
  const { root, request } = input;
  const fail = (errorCode: string, message: string): Result =>
    ({ status: 422, ok: false, body: { errorCode, message } });
  const done = (outcome: Result, contextSchema: Value) => ({
    status: outcome.status, body: outcome.body, contextSchema,
    ...(contextSchema.cleanupError ? { cleanupError: contextSchema.cleanupError as string } : {}),
  });
  const base = { source: "salesforce_live_asset_replace", action: input.actionName, verified: false };
  const spec = ASSET_REPLACE_SPECS[input.actionName];
  if (!spec || !IDENTIFIER.test(spec.idInput) || !IDENTIFIER.test(spec.relatedInput)) {
    return done(fail("ASSET_REPLACE_SPEC_INVALID", "A discovered asset replace spec with two id input names is required."), base);
  }
  if (input.verificationWindowMs !== undefined && (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail("ASSET_REPLACE_WINDOW_INVALID", "A bounded verification window is required."), base);
  }
  const automaticSteps = [
    "Resolve one live parent account for the owned assets",
    "Create two owned disposable assets carrying unique verifiable markers",
    "Invoke the native action with the two owned asset ids",
    "Verify the native acceptance and the created relationship readback",
    "Delete the relationship and both owned assets and verify absence",
  ];
  const schema = { ...base, idInput: spec.idInput, relatedInput: spec.relatedInput, automaticSteps };

  const owned: Array<{ object: string; id: string; markerField?: string; marker?: string }> = [];
  let outcome: Result = fail("ASSET_REPLACE_CONTEXT_UNAVAILABLE", "The owned asset replace context could not be prepared.");
  let cleanupError: string | undefined;
  let verified = false;
  let relationshipVerified: boolean | undefined;
  try {
    const described = await request(`${root}/sobjects/Asset/describe`);
    if (!described.ok || !record(described.body) || described.body.createable !== true ||
      described.body.queryable !== true || described.body.deletable !== true || !Array.isArray(described.body.fields)) {
      outcome = fail("ASSET_REPLACE_PERMISSIONS_REQUIRED", "Automatic asset context requires live create, read and delete access.");
      return done(outcome, schema);
    }
    const fields = (described.body.fields as unknown[]).filter(record);
    const accountField = fields.find((field) => field.name === "AccountId");
    if (!accountField || accountField.createable !== true) {
      outcome = fail("ASSET_REPLACE_FIELD_UNAVAILABLE", "The live schema exposes no createable AccountId; the fixtures cannot link a parent.");
      return done(outcome, schema);
    }
    const parent = await request(`${root}/query?q=${encodeURIComponent("SELECT Id FROM Account LIMIT 1")}`);
    const parentRow = parent.ok && record(parent.body) && Array.isArray(parent.body.records)
      ? parent.body.records.filter(record).find((entry) => identity(entry.Id)) : undefined;
    if (!parentRow) {
      outcome = fail("ASSET_REPLACE_SETUP_REQUIRED", "The probe needs one live Account row to parent its owned assets; none exists. Provision the setup row, then retry.");
      return done(outcome, schema);
    }
    const parentId = parentRow.Id as string;
    const assetIds: string[] = [];
    for (const label of ["a", "b"]) {
      const marker = `AS probe asset ${label} ${crypto.randomUUID()}`.slice(0, 80);
      const built = await input.build("Asset", marker, { Name: marker, AccountId: parentId });
      if ("failure" in built) {
        outcome = built.failure;
        return done(outcome, schema);
      }
      if (built.values.Name !== marker) {
        outcome = fail("ASSET_REPLACE_BUILD_UNSCOPED", "The fixture builder changed a planned ownership field.");
        return done(outcome, schema);
      }
      const created = await request(`${root}/sobjects/Asset`, "POST", built.values);
      const createdId: unknown = created.body?.id ?? created.body?.Id;
      if (!created.ok || !identity(createdId)) {
        outcome = created;
        return done(outcome, schema);
      }
      owned.push({ object: "Asset", id: createdId, markerField: "Name", marker });
      assetIds.push(createdId);
      const actual = await request(`${root}/sobjects/Asset/${createdId}`);
      if (!actual.ok || actual.body?.Name !== marker) {
        outcome = fail("ASSET_REPLACE_UNVERIFIED", "The owned asset readback did not carry the marker.");
        return done(outcome, schema);
      }
    }
    const invoked = await request(input.route, "POST", {
      inputs: [{ [spec.idInput]: assetIds[0], [spec.relatedInput]: assetIds[1] }],
    });
    outcome = invoked;
    verified = nativeActionSucceeded(invoked.status, invoked.body);
    if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
    if (verified) {
      const readback = await request(`${root}/query?q=${encodeURIComponent(
        `SELECT Id FROM AssetRelationship WHERE AssetId='${assetIds[0]}' AND RelatedAssetId='${assetIds[1]}' LIMIT 1`)}`);
      const hit = readback.ok && record(readback.body) && Array.isArray(readback.body.records)
        ? readback.body.records.filter(record).find((entry) => identity(entry.Id)) : undefined;
      relationshipVerified = hit !== undefined;
      if (!hit) {
        verified = false;
      } else {
        owned.push({ object: "AssetRelationship", id: hit.Id as string });
      }
    }
  } finally {
    for (const entry of owned.reverse()) {
      await request(`${root}/sobjects/${entry.object}/${entry.id}`, "DELETE");
      const check = await request(`${root}/sobjects/${entry.object}/${entry.id}`);
      if (check.status !== 404) {
        cleanupError = "Owned asset replace cleanup could not be verified; the record may still exist.";
        continue;
      }
      if (entry.markerField && entry.marker) {
        const swept = await request(`${root}/query?q=${encodeURIComponent(
          `SELECT Id FROM ${entry.object} WHERE ${entry.markerField}='${entry.marker}' LIMIT 2`)}`);
        const rows = record(swept.body) && Array.isArray(swept.body.records) ? swept.body.records : null;
        if (!swept.ok || !rows || rows.length > 0) {
          cleanupError = "Owned asset replace cleanup could not be verified; a marker-scoped sibling may remain.";
        }
      }
    }
  }
  return done(outcome, {
    ...schema, verified: cleanupError ? false : verified,
    ...(relationshipVerified !== undefined ? { relationshipVerified } : {}),
    ownedRecordIds: owned.map((entry) => entry.id),
    ...(cleanupError ? { cleanupError } : {}),
  });
}
