/**
 * Owned fixture lifecycle for record-collection-to-CSV invocable Apex.
 *
 * Root cause (blind-verified 2026-10-06, live native probes): the family
 * mints a ContentDocument CSV from a record collection, so the verb skip
 * parks it forever, yet the contract is safely probed with owned rows:
 * the SOBJECT collection input is NOT serializable over REST (every map
 * shape 400s INVALID_INPUT), while the JSON-string twin input accepts a
 * JSON array of record objects with the `attributes` member FIRST
 * (verified live: success envelope plus contentDocumentId/contentVersionId,
 * CSV bytes "Name\\n<marker>\\n" fetched back, fixtures deleted after).
 *
 * This module runs that shape for ANY custom/apex action declaring it:
 * required documentTitle plus the record-collection JSON-string contract,
 * outputs carrying the minted file ids. Two owned marked Account fixtures
 * prove collection handling, the invoke passes their live ids, verification
 * reads back the returned file (title, linkage, non-empty size), then the
 * file and both fixtures delete with 404 + marker-sweep verification. No
 * class name, org id, alias, or URL appears here; contract drift refuses
 * with no apex POST.
 */

import { clampVerificationWindowMs } from "./verification-window";

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
import { ACTION_NAME } from "./action-route-patterns";

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
export function apexCsvActionName(route: string): string | null {
  const match = typeof route === "string"
    ? route.match(/^\/services\/data\/v\d+(?:\.\d+)?\/actions\/custom\/apex\/([A-Za-z][A-Za-z0-9_]{0,127})$/)
    : null;
  const name = match?.[1] ?? null;
  return name !== null && ACTION_NAME.test(name) ? name : null;
}

export type ApexCsvContract = {
  titleInput: string;
  collectionInput: string;
  objectInput: string | null;
  fieldsInput: string | null;
};

const contractField = (inputs: Value[], name: string): Value | null => {
  const field = inputs.find((entry) => entry.name === name);
  return field && typeof field.type === "string" && field.type.toUpperCase() === "STRING" ? field : null;
};

/**
 * Resolve the CSV contract from live descriptor inputs/outputs. The title
 * input is required; the collection JSON-string, object name, and fields
 * inputs send when declared. Outputs must carry the minted file ids.
 * Returns null on any drift: SOBJECT-collection-only twins refuse (the
 * platform cannot serialize that shape over REST).
 */
export function apexCsvContract(descriptorInputs: unknown, descriptorOutputs: unknown): ApexCsvContract | null {
  const inputs = Array.isArray(descriptorInputs) ? descriptorInputs.filter(record) : [];
  const outputs = Array.isArray(descriptorOutputs) ? descriptorOutputs.filter(record) : [];
  if (inputs.some((field) => typeof field.name !== "string" || !FIELD_NAME.test(field.name))) return null;
  const title = contractField(inputs, "documentTitle");
  const collection = contractField(inputs, "recordCollectionString");
  if (!title || title.required !== true || !collection) return null;
  const objectInput = contractField(inputs, "objectName");
  const fieldsInput = contractField(inputs, "fieldsString");
  const outputNames = new Set(outputs
    .filter((field) => typeof field.name === "string")
    .map((field) => field.name as string));
  if (!outputNames.has("contentDocumentId") || !outputNames.has("contentVersionId")) return null;
  for (const field of inputs) {
    if (field.required !== true) continue;
    if (!["documentTitle", "recordCollectionString", "objectName", "fieldsString"].includes(field.name as string)) return null;
  }
  return {
    titleInput: "documentTitle",
    collectionInput: "recordCollectionString",
    objectInput: objectInput ? "objectName" : null,
    fieldsInput: fieldsInput ? "fieldsString" : null,
  };
}

/**
 * Build the invoke arguments. Record objects serialize attributes-FIRST:
 * the vendor JSON-deserializes the string into SObjects and rejects any
 * other member order. Key order follows construction order.
 */
export function apexCsvInvokeArgs(
  contract: ApexCsvContract,
  title: string,
  fixtures: Array<{ id: string; name: string }>,
  objectName: string,
  fieldsValue: string,
): Record<string, unknown> {
  const records = fixtures.map((fixture) => ({
    attributes: { type: objectName },
    Id: fixture.id,
    Name: fixture.name,
  }));
  return {
    [contract.titleInput]: title,
    [contract.collectionInput]: JSON.stringify(records),
    ...(contract.objectInput ? { [contract.objectInput]: objectName } : {}),
    ...(contract.fieldsInput ? { [contract.fieldsInput]: fieldsValue } : {}),
  };
}

/** True for a genuinely accepted action envelope with minted file ids. */
export function apexCsvAccepted(status: number, body: unknown): {
  accepted: boolean; contentDocumentId: string | null; contentVersionId: string | null;
} {
  const miss = { accepted: false, contentDocumentId: null, contentVersionId: null };
  if (!(status >= 200 && status < 300) || !Array.isArray(body) || body.length !== 1) return miss;
  const item = body[0];
  if (!record(item) || item.isSuccess !== true) return miss;
  if (!(item.errors === null || item.errors === undefined ||
    (Array.isArray(item.errors) && item.errors.length === 0))) return miss;
  const outputValues = record(item.outputValues) ? item.outputValues : null;
  const contentDocumentId = outputValues && identity(outputValues.contentDocumentId)
    ? outputValues.contentDocumentId as string : null;
  const contentVersionId = outputValues && identity(outputValues.contentVersionId)
    ? outputValues.contentVersionId as string : null;
  if (!contentDocumentId || !contentVersionId) return miss;
  return { accepted: true, contentDocumentId, contentVersionId };
}

export type ApexCsvLifecycleInput = {
  root: string;
  route: string;
  /** Live user id owning the fixtures; never guessed. */
  ownerUserId: string;
  verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
};

export async function invokeApexCsvWithContext(input: ApexCsvLifecycleInput): Promise<{
  status: number; body: any; cleanupError?: string; contextSchema?: Value;
}> {
  const { root, request } = input;
  const action = apexCsvActionName(input.route);
  const automaticSteps = [
    "Resolve the record-collection CSV contract from the live descriptor",
    "Create two owned marked Account fixtures and prove both exist",
    "Invoke with the owned collection and verify the minted file readback",
    "Delete the file and owned rows, verify absence",
  ];
  const base = { source: "salesforce_live_apex_csv_action", action, automaticSteps };
  const done = (outcome: Result, extra: Value): { status: number; body: any; cleanupError?: string; contextSchema?: Value } => ({
    status: outcome.status, body: outcome.body,
    ...(typeof extra.cleanupError === "string" ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...base, ...extra },
  });
  if (!action || !root.startsWith("/services/data/") || !input.route.startsWith(`${root}/actions/`)) {
    return done(fail("APEX_CSV_ACTION_INVALID", "A discovered invocable apex route is required."), { verified: false });
  }
  if (!identity(input.ownerUserId)) {
    return done(fail("APEX_CSV_OWNER_INVALID", "A live fixture-owner user identity is required; none is ever guessed."), { verified: false });
  }
  if (input.verificationWindowMs !== undefined &&
    (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail("APEX_CSV_WINDOW_INVALID", "A bounded verification window is required."), { verified: false });
  }
  const marker = `AE csv ${crypto.randomUUID()}`;
  const title = `${marker} file`;
  const owned: Array<{ objectName: string; id: string; markerField: string | null; markerValue?: string }> = [];
  let cleanupError: string | undefined;
  let outcome: Result = fail("APEX_CSV_CONTEXT_UNAVAILABLE", "The owned apex CSV context could not be prepared.");
  let verified = false;
  let fixtureIds: string[] = [];
  let contentDocumentId: string | null = null;
  let contentVersionId: string | null = null;
  let fileVerified = false;
  let invokeRan = false;
  try {
    outcome = await (async (): Promise<Result> => {
      const descriptor = await request(input.route);
      if (!descriptor.ok) return descriptor;
      const body = record(descriptor.body) ? descriptor.body : null;
      const contract = apexCsvContract(body?.inputs, body?.outputs);
      if (!contract) {
        return fail("APEX_CSV_CONTRACT_UNSUPPORTED",
          "The live descriptor does not declare the record-collection CSV contract; the native call was not attempted.");
      }
      const fixtures: Array<{ id: string; name: string }> = [];
      for (let index = 0; index < 2; index++) {
        const name = `${marker} row ${index}`;
        const built = await input.build("Account", marker, { OwnerId: input.ownerUserId, Name: name });
        if ("failure" in built) return built.failure;
        const created = await request(`${root}/sobjects/Account`, "POST", built.values);
        const createdId: unknown = created.body?.id ?? created.body?.Id;
        if (!created.ok || !identity(createdId)) return created;
        fixtures.push({ id: createdId, name });
        owned.push({ objectName: "Account", id: createdId, markerField: "Name", markerValue: name });
      }
      fixtureIds = fixtures.map((fixture) => fixture.id);
      for (const fixture of fixtures) {
        const gated = await request(`${root}/sobjects/Account/${fixture.id}`);
        if (!gated.ok || !record(gated.body) || gated.body.Id !== fixture.id ||
          gated.body.Name !== fixture.name) {
          return fail("APEX_CSV_FIXTURE_UNVERIFIED", "An owned fixture readback did not prove a live row; the native call was not attempted.");
        }
      }
      const invoked = await request(input.route, "POST", {
        inputs: [apexCsvInvokeArgs(contract, title, fixtures, "Account", "Name")],
      });
      invokeRan = true;
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
      const acceptance = apexCsvAccepted(invoked.status, invoked.body);
      contentDocumentId = acceptance.contentDocumentId;
      contentVersionId = acceptance.contentVersionId;
      if (acceptance.accepted && contentDocumentId && contentVersionId) {
        const version = await request(`${root}/sobjects/ContentVersion/${contentVersionId}`);
        const versionBody = version.ok && record(version.body) ? version.body : null;
        const document = await request(`${root}/sobjects/ContentDocument/${contentDocumentId}`);
        const documentBody = document.ok && record(document.body) ? document.body : null;
        fileVerified = versionBody !== null && documentBody !== null &&
          versionBody.ContentDocumentId === contentDocumentId &&
          typeof documentBody.Title === "string" && documentBody.Title === title &&
          typeof versionBody.ContentSize === "number" && versionBody.ContentSize > 0;
        owned.push({ objectName: "ContentDocument", id: contentDocumentId, markerField: null });
      }
      verified = acceptance.accepted && fileVerified;
      return invoked;
    })();
  } catch {
    if (outcome.body?.errorCode === "APEX_CSV_CONTEXT_UNAVAILABLE") {
      outcome = fail("APEX_CSV_LIFECYCLE_UNVERIFIED", "The owned apex CSV lifecycle failed; ownership-scoped cleanup still runs.");
    }
    verified = false;
  } finally {
    for (const entry of owned.slice().reverse()) {
      await request(`${root}/sobjects/${entry.objectName}/${entry.id}`, "DELETE");
      const check = await request(`${root}/sobjects/${entry.objectName}/${entry.id}`);
      if (check.status !== 404) {
        cleanupError = "Owned apex CSV cleanup could not be verified; a record may still exist.";
      } else if (entry.markerField !== null && typeof entry.markerValue === "string") {
        const swept = await request(`${root}/query?q=${encodeURIComponent(
          `SELECT Id FROM ${entry.objectName} WHERE ${entry.markerField}='${entry.markerValue}' LIMIT 2`)}`);
        const rows = record(swept.body) && Array.isArray(swept.body.records) ? swept.body.records : null;
        if (!swept.ok || !rows || rows.length > 0) {
          cleanupError = "Owned apex CSV cleanup could not be verified; a marker-scoped sibling may remain.";
        }
      }
    }
    if (contentDocumentId !== null) {
      const swept = await request(`${root}/query?q=${encodeURIComponent(
        `SELECT Id FROM ContentDocument WHERE Title='${title}' LIMIT 2`)}`);
      const rows = record(swept.body) && Array.isArray(swept.body.records) ? swept.body.records : null;
      if (!swept.ok || !rows || rows.length > 0) {
        cleanupError = "Owned apex CSV cleanup could not be verified; the minted file may still exist.";
      }
    }
  }
  return done(outcome, {
    verified: cleanupError ? false : verified,
    marker, title, fixtureIds, contentDocumentId, contentVersionId,
    fileReadbackOk: invokeRan ? fileVerified : null,
    verificationRecordIds: contentDocumentId ? [contentDocumentId, ...fixtureIds] : [...fixtureIds],
    ownedRecords: owned,
    ...(cleanupError ? { cleanupError } : {}),
  });
}
