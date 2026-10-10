/**
 * Owned sObject-fixture lifecycle for generic invocable Apex (`custom/apex/*`
 * owned-context executor).
 *
 * Root cause (blind-verified 2026-10-04, PARTNERCUSTOM, live native probes):
 * invocables taking a required sObject-id input refuse every inert ID shape
 * with 400 INVALID_INPUT (`System.StringException: Invalid id`) across all
 * three inert ID classes (random-15, prefix-valid-15, checksum-valid-18);
 * the gate is existence, so only a live owned row can ever be invoked, and
 * verb-skipped twins (edit/submit) park without any owned-context path at
 * all.
 *
 * This module runs the proven shape for ANY custom/apex action with required
 * ID-typed inputs: resolve each fixture object from live metadata
 * (descriptor sObjectType/targetEntityName, else the ID-input-name stem
 * matched against the live /sobjects/ catalog), create an owned marked
 * fixture, prove it exists by readback BEFORE any invoke, POST the live id
 * with zero-value passthrough args (required BOOLEAN false, required
 * numerics 0; every optional input omitted; business strings never
 * invented), verify output ID echoes plus created-child readbacks, then
 * ordered deletion with 404 + marker-sweep verification. No class name,
 * object name, org id, alias, or URL appears here; any ambiguity refuses
 * with no apex POST.
 *
 * Extensions (blind-verified 2026-10-06, SDOSTAINLESS):
 * - platform stem aliases (cartId -> WebCart, JournalId -> TransactionJournal);
 * - object-agnostic recordId stems on address-shaped descriptors fall back to
 *   the first live address-bearing standard object with a synthetic
 *   public-place probe address (the vendor geocodes the row);
 * - required reference parents resolve to live rows before synthesis
 *   (polymorphic or rowless targets refuse with no POST);
 * - geo-query descriptors (required `*ObjApiName` + geo-hinted
 *   `*FieldApiName` strings beside the ID input) bind both names from live
 *   schema: the first universal standard object carrying a location field
 *   (blind-verified: the vendor parses the bound names and faults only on
 *   the vendor-minted event reference).
 *
 * R5 shape extensions (blind-verified 2026-10-06, SDOSTAINLESS):
 * - every required ID input resolves to its own owned fixture (inputs
 *   sharing one object share one row); unresolvable companions refuse
 *   with no POST instead of riding placeholder ids into INVALID_INPUT.
 * - fixtures on objects exposing a nillable commercial `AccountId` link
 *   bind a live Account, else mint an owned one: native commerce Apex
 *   400s FIELD_INTEGRITY_EXCEPTION (`Required field: Account ID`) on
 *   accountless carts even though the platform leaves the field nillable.
 */

import { isCompoundParent } from "./describe-marker-field";
import { commercialAccountLinkField, seedCommercialAccountLink } from "./fixture-reference-seeding";

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const ACTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const ID_SUFFIX = /Ids?$/i;
const NON_ALNUM = /[^a-z0-9]/g;
const OBJECT_SUFFIX = new Set(["c", "kav", "mdt", "b", "e", "x", "share", "history", "feed"]);
const NUMERIC_TYPES = new Set(["INTEGER", "LONG", "DOUBLE", "DECIMAL"]);
/** Platform ID-stem aliases: the stem names no live object but the platform
 * vocabulary fixes the target (Commerce cartId is always a WebCart row;
 * loyalty JournalId is always a TransactionJournal row; Field Service saID
 * is always a ServiceAppointment row; the maps summary-event id is always
 * a LiveAssetDailySummaryEvent row). Same mapping the searcher sampler
 * uses; alias hits join stem hits under the same exactly-one rule, so a
 * genuine second match stays AMBIGUOUS. */
const STEM_ALIASES: Record<string, string[]> = {
  cart: ["webcart"],
  journal: ["transactionjournal"],
  sa: ["serviceappointment"],
  sumevent: ["mapsliveassetdailysummaryevent"],
};
/** Object-agnostic ID stems: the input names a record without naming its object. */
const AGNOSTIC_STEMS = new Set(["record", "object", "sobject"]);
/** Address-vocabulary descriptor inputs (optional input/output prefixes allowed). */
const ADDRESS_INPUT = /^(?:input|output)?(street|city|state|postalcode|postal|province|country|address|latitude|longitude|zipcode|zip)/i;
/** Standard address-bearing objects for object-agnostic geocode-shaped inputs. */
const RECORD_FALLBACK_OBJECTS = ["Account", "Contact", "Lead"];
/** Public-place probe address (San Francisco financial district): synthetic
 * probe content like the fictional phones/emails, never tenant data. */
const PROBE_ADDRESS = {
  street: "1 Market Street",
  city: "San Francisco",
  state: "CA",
  postalCode: "94105",
  country: "USA",
};
/** Required `*ObjApiName` string inputs name the live object a geo query scans. */
const OBJ_API_NAME_INPUT = /objapiname$/i;
/** Required geo-hinted `*FieldApiName` string inputs name a live location field. */
const GEO_FIELD_API_NAME_INPUT = /fieldapiname$/i;
const GEO_FIELD_HINT = /geo|latlong|location|coordinate/i;
/** Universal standard objects scanned for a live location field, in order. */
const GEO_QUERY_OBJECTS = ["Account", "Contact", "Lead"];

const record = (value: unknown): value is Value =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && SF_ID.test(value);

/** Family builder version: re-probe scheduled turns when this moves. */
export const APEX_EXEC_BUILDER_VERSION = 1;

const fail = (errorCode: string, message: string, extra?: Value): Result => ({
  status: 422, ok: false, body: { errorCode, message, ...extra },
});

/**
 * Parse a live invocable-apex route. Returns the class name, or null when
 * the route is not in this family. Classification uses the route shape
 * only; no class name is ever enumerated here.
 */
export function apexExecActionName(route: string): string | null {
  const match = typeof route === "string"
    ? route.match(/^\/services\/data\/v\d+(?:\.\d+)?\/actions\/custom\/apex\/([A-Za-z][A-Za-z0-9_]{0,127})$/)
    : null;
  const name = match?.[1] ?? null;
  return name !== null && ACTION_NAME.test(name) ? name : null;
}

/** Required ID-typed live-descriptor inputs, in descriptor order. */
export function apexExecRequiredIdInputs(descriptorInputs: unknown): string[] {
  const inputs = Array.isArray(descriptorInputs) ? descriptorInputs.filter(record) : [];
  return inputs.filter((field) =>
    field.required === true &&
    typeof field.type === "string" && field.type.toUpperCase() === "ID" &&
    typeof field.name === "string" && FIELD_NAME.test(field.name))
    .map((field) => field.name as string);
}

/** True when the live descriptor declares at least one required ID input. */
export function apexExecInputSetValid(descriptorInputs: unknown): boolean {
  return apexExecRequiredIdInputs(descriptorInputs).length >= 1;
}

/**
 * Zero-value passthrough args for every required non-ID input (BOOLEAN
 * false, numerics 0, DATE/DATETIME tomorrow UTC) plus every OPTIONAL
 * boolean (false — never omitted). All other optionals are omitted.
 * Returns null when a required input has no safe zero value (strings
 * and exotic types): business content is never invented.
 *
 * Dates bind the SAME tomorrow on every required date input: equal dates
 * are the minimal window satisfying from<=to range validation, and a
 * single-day window minimizes the rows a range-selecting vendor can see
 * (live evidence: clone/status vendors scope by the passed owned ids, so
 * the window selects owned fixtures only). Past dates are never used:
 * vendors reject elapsed windows and live history is never in range.
 *
 * Optional booleans bind false because null-hostile vendors fault on
 * omission (live evidence: a clone vendor writes an optional scheduling
 * flag straight onto the cloned row, and null 400s
 * VENDOR_DML_ROW_FAULT while false succeeds). False is the conservative
 * no-op value; optional IDs, strings, and dates still omit (identifiers
 * are never invented, content never guessed).
 */
export function apexExecStaticArgs(descriptorInputs: unknown, idInput: string | readonly string[]): Record<string, unknown> | null {
  const inputs = Array.isArray(descriptorInputs) ? descriptorInputs.filter(record) : [];
  const skipped = new Set(Array.isArray(idInput) ? idInput : [idInput]);
  const args: Record<string, unknown> = {};
  for (const field of inputs) {
    if (typeof field.name !== "string" || !FIELD_NAME.test(field.name)) return null;
    if (skipped.has(field.name)) continue;
    const type = typeof field.type === "string" ? field.type.toUpperCase() : "";
    if (field.required !== true) {
      if (type === "BOOLEAN") args[field.name] = false;
      continue;
    }
    if (type === "BOOLEAN") args[field.name] = false;
    else if (NUMERIC_TYPES.has(type)) args[field.name] = 0;
    else if (type === "DATE" || type === "DATETIME") args[field.name] = apexExecTomorrowArg(type);
    else return null;
  }
  return args;
}

/** Tomorrow UTC as a DATE (YYYY-MM-DD) or DATETIME (midnight Z) arg value. */
export function apexExecTomorrowArg(type: string): string {
  const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  return type === "DATETIME" ? `${day}T00:00:00.000Z` : day;
}

/**
 * True when the named required ID input is declared a collection
 * (isCollection or maxOccurs > 1): the invoke must bind `[fixtureId]`,
 * never the scalar, or vendors fault "Unable to convert" on List<Id>.
 */
export function apexExecIdInputIsCollection(descriptorInputs: unknown, name: string): boolean {
  const inputs = Array.isArray(descriptorInputs) ? descriptorInputs.filter(record) : [];
  const field = inputs.find((entry) => entry.name === name) as
    (Value & { isCollection?: unknown; maxOccurs?: unknown }) | undefined;
  if (!field) return false;
  return field.isCollection === true ||
    (typeof field.maxOccurs === "number" && field.maxOccurs > 1);
}

/**
 * Geo-query naming inputs: the required non-ID inputs the zero-value rule
 * cannot cover are exactly one `*ObjApiName` string plus one geo-hinted
 * `*FieldApiName` string (every other required input is boolean/numeric).
 * Returns the descriptor-cased pair, or null when the shape is not a
 * geo query. No class or object name is enumerated.
 */
export function apexExecGeoQueryInputNames(
  descriptorInputs: unknown, idInput: string | readonly string[],
): { objInput: string; fieldInput: string } | null {
  const inputs = Array.isArray(descriptorInputs) ? descriptorInputs.filter(record) : [];
  const skipped = new Set(Array.isArray(idInput) ? idInput : [idInput]);
  let objInput: string | null = null;
  let fieldInput: string | null = null;
  for (const field of inputs) {
    if (typeof field.name !== "string" || !FIELD_NAME.test(field.name)) return null;
    if (skipped.has(field.name) || field.required !== true) continue;
    const type = typeof field.type === "string" ? field.type.toUpperCase() : "";
    if (type === "BOOLEAN" || NUMERIC_TYPES.has(type)) continue;
    if (type !== "STRING" && type !== "TEXT" && type !== "TEXTAREA") return null;
    if (objInput === null && OBJ_API_NAME_INPUT.test(field.name)) { objInput = field.name; continue; }
    if (fieldInput === null && GEO_FIELD_API_NAME_INPUT.test(field.name) && GEO_FIELD_HINT.test(field.name)) {
      fieldInput = field.name; continue;
    }
    return null;
  }
  return objInput !== null && fieldInput !== null ? { objInput, fieldInput } : null;
}

/**
 * Live location-field binding for a geo query: the first entry (scan order)
 * whose live describe carries a location-typed field. Both names come from
 * live schema; null when no scanned object has one.
 */
export function apexExecGeoQueryBinding(
  describes: unknown,
): { objectName: string; fieldName: string } | null {
  if (!Array.isArray(describes)) return null;
  for (const entry of describes) {
    if (!record(entry) || typeof entry.objectName !== "string" || !OBJECT_NAME.test(entry.objectName)) continue;
    const fields = Array.isArray(entry.fields) ? entry.fields.filter(record) : [];
    const hit = fields.find((field) => typeof field.type === "string" && field.type.toLowerCase() === "location" &&
      typeof field.name === "string" && FIELD_NAME.test(field.name));
    if (hit) return { objectName: entry.objectName, fieldName: hit.name as string };
  }
  return null;
}

/** Normalize an ID-input name to an object stem: `serviceOrderId` -> `serviceorder`. */
export function apexExecObjectStem(idInput: string): string {
  return idInput.replace(ID_SUFFIX, "").toLowerCase().replace(NON_ALNUM, "");
}

const candidateKeys = (qualified: string): string[] => {
  const parts = qualified.split("__");
  const core = parts.length > 1 && OBJECT_SUFFIX.has(parts[parts.length - 1].toLowerCase())
    ? parts.slice(0, -1) : parts;
  const keys = [core.join("")];
  if (core.length > 1) keys.push(core.slice(1).join(""));
  return keys.map((key) => key.toLowerCase().replace(NON_ALNUM, ""));
};

/**
 * Live-catalog objects whose name matches the ID-input stem (namespace and
 * `__c`-style suffixes ignored). Platform stem aliases join the match set
 * under the same rule. The caller requires exactly one hit; zero is
 * UNRESOLVED and two-plus is AMBIGUOUS, both refusing with no POST.
 */
export function apexExecMatchObjects(catalogNames: unknown, idInput: string): string[] {
  const stem = apexExecObjectStem(idInput);
  if (!stem || !Array.isArray(catalogNames)) return [];
  const stems = [stem, ...(STEM_ALIASES[stem] ?? [])];
  const hits: string[] = [];
  for (const name of catalogNames) {
    if (typeof name !== "string" || !OBJECT_NAME.test(name)) continue;
    if (candidateKeys(name).some((key) => stems.includes(key)) && !hits.includes(name)) hits.push(name);
  }
  return hits;
}

/** True when the descriptor carries address-vocabulary inputs (geocode shape). */
export function apexExecAddressShaped(descriptorInputs: unknown): boolean {
  const inputs = Array.isArray(descriptorInputs) ? descriptorInputs.filter(record) : [];
  return inputs.some((field) => typeof field.name === "string" && ADDRESS_INPUT.test(field.name));
}

/**
 * Fixture object for object-agnostic ID inputs (record/object/sobject stems)
 * on geocode-shaped descriptors: the first live address-bearing standard
 * object in catalog order. Returns null when the stem names an object, the
 * shape is not address-like, or no fallback object is cataloged — the
 * caller keeps its UNRESOLVED refusal in all three cases.
 */
export function apexExecRecordFallbackObject(
  catalogNames: unknown, idInput: string, descriptorInputs: unknown,
): string | null {
  if (!AGNOSTIC_STEMS.has(apexExecObjectStem(idInput))) return null;
  if (!apexExecAddressShaped(descriptorInputs)) return null;
  if (!Array.isArray(catalogNames)) return null;
  const names = new Set(catalogNames.filter((name): name is string => typeof name === "string"));
  return RECORD_FALLBACK_OBJECTS.find((objectName) => names.has(objectName)) ?? null;
}

/**
 * Synthetic probe-address values for the fallback fixture object (standard
 * address field vocabulary per object). Null for objects without a known
 * standard address field set — the fixture builds without an address.
 */
export function apexExecProbeAddressValues(objectName: string): Value | null {
  const prefix = objectName === "Account" ? "Billing" : objectName === "Contact" ? "Mailing" : null;
  if (prefix !== null) {
    return {
      [`${prefix}Street`]: PROBE_ADDRESS.street,
      [`${prefix}City`]: PROBE_ADDRESS.city,
      [`${prefix}State`]: PROBE_ADDRESS.state,
      [`${prefix}PostalCode`]: PROBE_ADDRESS.postalCode,
      [`${prefix}Country`]: PROBE_ADDRESS.country,
    };
  }
  if (objectName === "Lead") {
    return {
      Street: PROBE_ADDRESS.street,
      City: PROBE_ADDRESS.city,
      State: PROBE_ADDRESS.state,
      PostalCode: PROBE_ADDRESS.postalCode,
      Country: PROBE_ADDRESS.country,
    };
  }
  return null;
}

export type ApexExecRequiredReference = { field: string; target: string };

/**
 * Required reference fields the fixture synthesis cannot fill without a
 * live parent (mirrors synthesizeRecordValues requiredness: non-nillable,
 * not defaulted, createable). Polymorphic targets (two-plus referenceTo)
 * refuse as ambiguous — the entry carries target "" so the caller fails
 * closed instead of guessing a parent object.
 */
export function apexExecRequiredReferences(fields: Value[]): ApexExecRequiredReference[] {
  const refs: ApexExecRequiredReference[] = [];
  for (const field of fields) {
    if (!record(field) || typeof field.name !== "string" || !FIELD_NAME.test(field.name)) continue;
    if (field.nillable !== false || field.defaultedOnCreate === true || field.calculated === true ||
      field.autoNumber === true || field.createable !== true) continue;
    if (typeof field.type !== "string" || field.type.toLowerCase() !== "reference") continue;
    const targets = (Array.isArray(field.referenceTo) ? field.referenceTo : [])
      .filter((name): name is string => typeof name === "string" && OBJECT_NAME.test(name));
    refs.push({ field: field.name, target: targets.length === 1 ? targets[0] : "" });
  }
  return refs;
}

/**
 * True only for a genuinely accepted action envelope: HTTP success, a
 * single outcome, `isSuccess` true, empty errors, and no envelope-level
 * error code, message, or bad response code. Nested business flags inside
 * `outputValues` are NOT judged here; `apexExecNestedFlags` reports them
 * and the lifecycle requires a verified readback before they can pass
 * (same rule as the outcome-normalization apex discriminator).
 */
export function apexExecAccepted(status: number, body: unknown): { accepted: boolean; outputValues: Value | null } {
  const miss = { accepted: false, outputValues: null };
  if (!(status >= 200 && status < 300) || !Array.isArray(body) || body.length !== 1) return miss;
  const item = body[0];
  if (!record(item) || item.isSuccess !== true) return miss;
  if (!(item.errors === null || item.errors === undefined ||
    (Array.isArray(item.errors) && item.errors.length === 0))) return miss;
  if ((typeof item.errorCode === "string" && item.errorCode !== "") ||
    (typeof item.errorMessage === "string" && item.errorMessage !== "")) return miss;
  if (typeof item.responseCode === "number" && (!Number.isInteger(item.responseCode) ||
    item.responseCode < 200 || item.responseCode >= 300)) return miss;
  return { accepted: true, outputValues: record(item.outputValues) ? item.outputValues : null };
}

/** Bounded scan for nested business rejection flags inside the payload. */
export function apexExecNestedFlags(outputValues: unknown): boolean {
  let visited = 0;
  let flagged = false;
  const walk = (value: unknown, depth: number): void => {
    if (flagged || depth > 12 || ++visited > 256) return;
    if (Array.isArray(value)) { for (const entry of value) walk(entry, depth + 1); return; }
    if (!record(value)) return;
    if (value.isSuccess === false || value.isVerified === false) { flagged = true; return; }
    const errors = value.errors;
    if (errors !== null && errors !== undefined && (!Array.isArray(errors) || errors.length > 0)) { flagged = true; return; }
    if ((typeof value.errorCode === "string" && value.errorCode !== "") ||
      (typeof value.errorMessage === "string" && value.errorMessage !== "")) { flagged = true; return; }
    if (typeof value.responseCode === "number" && (!Number.isInteger(value.responseCode) ||
      value.responseCode < 200 || value.responseCode >= 300)) { flagged = true; return; }
    for (const key of Object.keys(value)) {
      if (flagged) break;
      const child = value[key];
      if (Array.isArray(child) || record(child)) walk(child, depth + 1);
    }
  };
  walk(outputValues, 0);
  return flagged;
}

/**
 * Distinct well-formed IDs among the top-level output values, including
 * one-level arrays (clone-style vendors return `clonedIds: [id, ...]`).
 * Callers read-verify each hit before treating it as an owned child, so
 * echoed live ids never delete blindly; deeper nesting stays out of scope.
 */
export function apexExecOutputIds(outputValues: unknown): string[] {
  if (!record(outputValues)) return [];
  const ids: string[] = [];
  const take = (value: unknown): void => {
    if (typeof value === "string" && SF_ID.test(value) && !ids.includes(value)) ids.push(value);
  };
  for (const key of Object.keys(outputValues)) {
    const value = outputValues[key];
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, 200)) take(entry);
    } else take(value);
  }
  return ids;
}

/**
 * True when a fixture POST failed the way managed before-insert triggers
 * fail on sparse fixtures: HTTP 400 carrying a null dereference (live
 * evidence: `FSL.TR001_Service_BeforeInsert ... System.NullPointerException:
 * Attempt to de-reference a null object` on a parentless ServiceAppointment).
 * A 400 creates no row, so exactly one parent-bound retry is safe.
 */
export function apexExecTriggerNpe400(result: { status: number; body: unknown }): boolean {
  if (result.status !== 400) return false;
  let text = "";
  try { text = JSON.stringify(result.body ?? ""); } catch { return false; }
  return /NullPointerException|de-reference a null object/i.test(text);
}

/**
 * Nillable creator-settable parent references (`ParentRecordId`
 * vocabulary) on the live describe, with their reference targets in
 * describe order. Managed triggers dereference these on insert even
 * though the platform leaves them nillable; binding a live parent row
 * satisfies the trigger without writing the borrowed row.
 */
export function apexExecTriggerParentFields(fields: Value[]): Array<{ field: string; targets: string[] }> {
  const found: Array<{ field: string; targets: string[] }> = [];
  for (const entry of fields) {
    if (!record(entry) || typeof entry.name !== "string" || !FIELD_NAME.test(entry.name)) continue;
    if (entry.name.toLowerCase() !== "parentrecordid") continue;
    if (entry.nillable === false || entry.createable !== true) continue;
    if (typeof entry.type !== "string" || entry.type.toLowerCase() !== "reference") continue;
    const targets = (Array.isArray(entry.referenceTo) ? entry.referenceTo : [])
      .filter((name): name is string => typeof name === "string" && OBJECT_NAME.test(name));
    if (targets.length > 0) found.push({ field: entry.name, targets });
  }
  return found;
}

/**
 * Owner seed for fixture inserts: `{ OwnerId }` only when the live
 * describe carries the field. Ownerless objects (live evidence:
 * maps__LiveAssetDailySummaryEvent__c has no OwnerId column) 400 the
 * whole insert when the seed is present.
 */
export function apexExecOwnerSeed(fields: Value[], ownerUserId: string): Value {
  const hasOwner = fields.some((entry) =>
    record(entry) && entry.name === "OwnerId");
  return hasOwner ? { OwnerId: ownerUserId } : {};
}

/**
 * Probe-coordinate seeds for createable geolocation compounds: geo-query
 * vendors interpolate the fixture's position into SOQL, and a null
 * position faults `unexpected token: 'null'` (live evidence: maps
 * closest-record). Each compound seeds via its Latitude/Longitude
 * component doubles (compounds themselves are never createable);
 * components missing or uncreateable are skipped. The point is San
 * Francisco (proven live): Null Island (0,0) faults this vendor class
 * instead (`unexpected token: 'E'` — its SOQL templating chokes on
 * zero), so obviously-synthetic loses to actually-working.
 */
export function apexExecPositionSeeds(fields: Value[]): Value {
  const seeds: Value = {};
  const byName = new Map<string, Value>();
  for (const entry of fields) {
    if (record(entry) && typeof entry.name === "string") byName.set(entry.name, entry);
  }
  for (const entry of fields) {
    if (!record(entry) || typeof entry.name !== "string" || typeof entry.type !== "string") continue;
    if (entry.type.toLowerCase() !== "location" || !entry.name.endsWith("__c")) continue;
    const stem = entry.name.slice(0, -"__c".length);
    const lat = byName.get(`${stem}__Latitude__s`);
    const lon = byName.get(`${stem}__Longitude__s`);
    if (!record(lat) || lat.createable !== true || !record(lon) || lon.createable !== true) continue;
    seeds[`${stem}__Latitude__s`] = 37.7749;
    seeds[`${stem}__Longitude__s`] = -122.4194;
  }
  return seeds;
}

const markerFieldFor = (fields: Value[]): string | null => {
  const pick = fields.find((entry) => record(entry) && entry.createable === true && entry.filterable === true &&
    (entry.type === "string" || entry.type === "combobox") && typeof entry.length === "number" && entry.length >= 48 &&
    entry.calculated !== true && entry.autoNumber !== true && typeof entry.name === "string" &&
    !isCompoundParent(fields, entry));
  return pick && typeof pick.name === "string" ? pick.name : null;
};

export type ApexExecLifecycleInput = {
  root: string;
  route: string;
  /** Live user id owning the fixtures; never guessed. */
  ownerUserId: string;
  verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
};

export async function invokeApexExecWithContext(input: ApexExecLifecycleInput): Promise<{
  status: number; body: any; cleanupError?: string; contextSchema?: Value;
}> {
  const { root, request } = input;
  // One parent-bound fixture retry after a trigger-NPE 400: bind the
  // first live parent row per ParentRecordId-style field (describe
  // target order; borrowed rows are never written) and POST once.
  // Null when no parent field or live row applies — the caller keeps
  // the original failure. The retry outcome (success or failure)
  // replaces the original attempt as the later evidence.
  const createWithTriggerParents = async (
    target: string, fields: Value[], values: Value,
  ): Promise<{ status: number; ok: boolean; body: any } | null> => {
    const parents = apexExecTriggerParentFields(fields);
    if (parents.length === 0) return null;
    const seeds: Value = {};
    for (const parent of parents) {
      let bound: string | null = null;
      for (const candidate of parent.targets) {
        const probe = await request(`${root}/query?q=${encodeURIComponent(`SELECT Id FROM ${candidate} ORDER BY Id LIMIT 1`)}`);
        const hit: unknown = record(probe.body) && Array.isArray(probe.body.records)
          ? probe.body.records.filter(record).map((row) => row.Id).find(identity)
          : undefined;
        if (probe.ok && identity(hit)) { bound = hit; break; }
      }
      if (bound === null) return null;
      seeds[parent.field] = bound;
    }
    return request(`${root}/sobjects/${target}`, "POST", { ...values, ...seeds });
  };
  // Mint one owned parent row for a rowless required reference (depth
  // exactly one): describe must show createable + deletable + zero
  // required references of its own. The mint joins `owned` BEFORE the
  // child fixture, so reverse-order cleanup deletes the child first.
  // Null when unmintable — the caller keeps its rowless refusal.
  const mintOwnedParent = async (objectName: string): Promise<string | null> => {
    const schema = await request(`${root}/sobjects/${objectName}/describe`);
    if (!schema.ok || !record(schema.body) || schema.body.createable !== true ||
      schema.body.deletable !== true || !Array.isArray(schema.body.fields)) return null;
    const parentFields = (schema.body.fields as unknown[]).filter(record);
    if (apexExecRequiredReferences(parentFields).length > 0) return null;
    const parentMarkerField = markerFieldFor(parentFields);
    const seeds: Value = {
      ...apexExecOwnerSeed(parentFields, input.ownerUserId),
      ...(parentMarkerField !== null ? { [parentMarkerField]: marker } : {}),
    };
    const parentBuilt = await input.build(objectName, marker, seeds);
    if ("failure" in parentBuilt) return null;
    const parentCreated = await request(`${root}/sobjects/${objectName}`, "POST", parentBuilt.values);
    const parentId: unknown = parentCreated.body?.id ?? parentCreated.body?.Id;
    if (!parentCreated.ok || !identity(parentId)) return null;
    owned.push({ objectName, id: parentId, markerField: parentMarkerField });
    const parentRead = await request(`${root}/sobjects/${objectName}/${parentId}`);
    if (!parentRead.ok || !record(parentRead.body) || parentRead.body.Id !== parentId ||
      (parentMarkerField !== null && parentRead.body[parentMarkerField] !== marker)) return null;
    return parentId;
  };
  const resolveGeoQueryBinding = async (): Promise<{ objectName: string; fieldName: string } | null> => {
    const describes: unknown[] = [];
    for (const objectName of GEO_QUERY_OBJECTS) {
      const schema = await request(`${root}/sobjects/${objectName}/describe`);
      describes.push(record(schema.body) ? { objectName, fields: schema.body.fields } : null);
    }
    return apexExecGeoQueryBinding(describes);
  };
  const action = apexExecActionName(input.route);
  const automaticSteps = [
    "Resolve the single required ID input and fixture object from live metadata",
    "Create an owned marked fixture and prove it exists before any invoke",
    "Invoke with the live fixture id plus zero-value passthrough args",
    "Verify output echoes, delete owned rows, verify absence",
  ];
  const base = { source: "salesforce_live_apex_exec_action", action, automaticSteps };
  const done = (outcome: Result, extra: Value): { status: number; body: any; cleanupError?: string; contextSchema?: Value } => ({
    status: outcome.status, body: outcome.body,
    ...(typeof extra.cleanupError === "string" ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...base, ...extra },
  });
  if (!action || !root.startsWith("/services/data/") || !input.route.startsWith(`${root}/actions/`)) {
    return done(fail("APEX_EXEC_ACTION_INVALID", "A discovered invocable apex route is required."), { verified: false });
  }
  if (!identity(input.ownerUserId)) {
    return done(fail("APEX_EXEC_OWNER_INVALID", "A live fixture-owner user identity is required; none is ever guessed."), { verified: false });
  }
  if (input.verificationWindowMs !== undefined &&
    (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail("APEX_EXEC_WINDOW_INVALID", "A bounded verification window is required."), { verified: false });
  }
  // Short ownership marker (15 chars): marker fields carry hidden
  // validations below their describe length (live evidence:
  // ServiceTerritory.Name describes 255 but the platform rejects >40
  // when User Territory Sharing is enabled), so the 44-char form 400s
  // fixtures that length checks would pass. 12 hex chars stay unique;
  // the AE prefix keeps probe residue identifiable.
  const marker = `AE ${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const owned: Array<{ objectName: string; id: string; markerField: string | null }> = [];
  let cleanupError: string | undefined;
  let outcome: Result = fail("APEX_EXEC_CONTEXT_UNAVAILABLE", "The owned apex execution context could not be prepared.");
  let verified = false;
  let fixtureObject: string | null = null;
  let idInput = "";
  let staticArgs: Record<string, unknown> = {};
  let fixtureId: string | undefined;
  let idValues: Record<string, string | string[]> = {};
  let fixtureObjects: string[] = [];
  let childIds: string[] = [];
  let echoFound = false;
  let fixtureOk = false;
  let childrenOk = true;
  let nested = false;
  let sideEffectVerified = false;
  let invokeRan = false;
  let countBefore: number | null = null;
  let countAfter: number | null = null;
  try {
    outcome = await (async (): Promise<Result> => {
      const descriptor = await request(input.route);
      if (!descriptor.ok) return descriptor;
      const body = record(descriptor.body) ? descriptor.body : null;
      const descriptorInputs = body ? body.inputs : undefined;
      const idInputs = apexExecRequiredIdInputs(descriptorInputs);
      if (!idInputs.length) {
        return fail("APEX_EXEC_ACTION_SCHEMA_MISMATCH",
          "The live descriptor declares no required ID input; the native call was not attempted.");
      }
      idInput = idInputs[0];
      const args = apexExecStaticArgs(descriptorInputs, idInputs);
      if (args === null) {
        // Geo-query rescue: the naming strings bind from live schema (both
        // names proved live by describe); anything else keeps the refusal.
        const geo = apexExecGeoQueryInputNames(descriptorInputs, idInputs);
        const binding = geo === null ? null : await resolveGeoQueryBinding();
        if (geo === null || binding === null) {
          return fail("APEX_EXEC_ARGS_UNBUILDABLE",
            "A required non-ID input has no safe zero value; business content is never invented and the native call was not attempted.");
        }
        const zeros: Record<string, unknown> = {};
        for (const field of (Array.isArray(descriptorInputs) ? descriptorInputs.filter(record) : [])) {
          if (idInputs.includes(field.name as string) || field.name === geo.objInput || field.name === geo.fieldInput || field.required !== true) continue;
          const type = typeof field.type === "string" ? field.type.toUpperCase() : "";
          if (type === "BOOLEAN") zeros[field.name as string] = false;
          else if (NUMERIC_TYPES.has(type)) zeros[field.name as string] = 0;
        }
        staticArgs = { ...zeros, [geo.objInput]: binding.objectName, [geo.fieldInput]: binding.fieldName };
      } else staticArgs = args;
      // Every required ID input resolves to exactly one fixture object
      // (declared sObjectType, else the stem matched against the live
      // catalog, else the address-shaped record fallback). The catalog
      // fetches once; any unresolvable companion refuses with no POST.
      const liveInputs = Array.isArray(descriptorInputs) ? descriptorInputs.filter(record) : [];
      let catalogNames: string[] | null = null;
      const plan: Array<{ input: string; objectName: string; fallback: boolean }> = [];
      for (const name of idInputs) {
        const idField = liveInputs.find((field) => field.name === name);
        const declared = typeof idField?.sObjectType === "string" && OBJECT_NAME.test(idField.sObjectType)
          ? idField.sObjectType
          : (body !== null && typeof body.targetEntityName === "string" && OBJECT_NAME.test(body.targetEntityName)
            ? body.targetEntityName : null);
        if (declared !== null) {
          plan.push({ input: name, objectName: declared, fallback: false });
          continue;
        }
        if (catalogNames === null) {
          const catalog = await request(`${root}/sobjects/`);
          if (!catalog.ok || !record(catalog.body) || !Array.isArray(catalog.body.sobjects)) return catalog;
          catalogNames = catalog.body.sobjects.filter(record).map((entry) => entry.name);
        }
        const matches = apexExecMatchObjects(catalogNames, name);
        if (matches.length > 1) {
          return fail("APEX_EXEC_OBJECT_AMBIGUOUS",
            `The ${name} input matches ${matches.length} live sObjects; the native call was not attempted.`,
            { matches: matches.slice(0, 3) });
        }
        if (matches.length === 1) {
          plan.push({ input: name, objectName: matches[0], fallback: false });
          continue;
        }
        const fallback = apexExecRecordFallbackObject(catalogNames, name, descriptorInputs);
        if (fallback === null) {
          return fail("APEX_EXEC_OBJECT_UNRESOLVED",
            `No live sObject matches the ${name} input; the native call was not attempted.`);
        }
        plan.push({ input: name, objectName: fallback, fallback: true });
      }
      fixtureObject = plan[0].objectName;
      try {
        const counted = await request(`${root}/query?q=${encodeURIComponent(`SELECT COUNT() FROM ${fixtureObject}`)}`);
        countBefore = counted.ok && record(counted.body) && typeof counted.body.totalSize === "number"
          ? counted.body.totalSize : null;
      } catch { countBefore = null; }
      // One owned fixture per distinct object; inputs sharing an object
      // share its row. Parents and the commercial Account link bind before
      // synthesis, and every invoked id passes the existence gate below.
      idValues = {};
      fixtureObjects = [];
      const fixtureIds: string[] = [];
      const provisioned = new Map<string, string>();
      for (const entry of plan) {
        if (provisioned.has(entry.objectName)) {
          idValues[entry.input] = provisioned.get(entry.objectName) as string;
          continue;
        }
        const target = entry.objectName;
        const schema = await request(`${root}/sobjects/${target}/describe`);
        if (!schema.ok || !record(schema.body) || schema.body.createable !== true ||
          schema.body.deletable !== true || schema.body.queryable !== true || !Array.isArray(schema.body.fields)) {
          return fail("APEX_EXEC_FIXTURE_PERMISSIONS_REQUIRED",
            `Automatic apex execution requires live ${target} create, read and delete access.`);
        }
        const fields = (schema.body.fields as unknown[]).filter(record);
        const markerField = markerFieldFor(fields);
        const seedValues: Value = {
          ...apexExecOwnerSeed(fields, input.ownerUserId),
          ...(markerField !== null ? { [markerField]: marker } : {}),
          // Geo-query vendors read the fixture's own position; anything
          // else leaves coordinates unset (never invent location data the
          // vendor does not dereference).
          ...(apexExecGeoQueryInputNames(descriptorInputs, idInputs) !== null
            ? apexExecPositionSeeds(fields) : {}),
        };
        // Required-reference parents resolve to live rows; rowless
        // single-target parents mint one owned row (depth exactly one:
        // mintable means createable + deletable + zero required
        // references of its own, else the rowless refusal below stands).
        // Ambiguous (polymorphic) targets refuse with no POST.
        let parentFailed: Result | null = null;
        for (const ref of apexExecRequiredReferences(fields)) {
          if (ref.target === "") {
            parentFailed = fail("APEX_EXEC_PARENT_AMBIGUOUS",
              `The temporary ${target}.${ref.field} needs one explicit parent object; the native call was not attempted.`);
            break;
          }
          const parent = await request(`${root}/query?q=${encodeURIComponent(
            `SELECT Id FROM ${ref.target} ORDER BY Id LIMIT 1`)}`);
          const parentId: unknown = record(parent.body) && Array.isArray(parent.body.records)
            ? parent.body.records.filter(record).map((row) => row.Id).find(identity)
            : undefined;
          if (parent.ok && identity(parentId)) {
            seedValues[ref.field] = parentId;
            continue;
          }
          const minted = await mintOwnedParent(ref.target);
          if (minted === null) {
            parentFailed = fail("APEX_EXEC_PARENT_ROWLESS",
              `No live ${ref.target} row backs the required ${target}.${ref.field}, and no owned parent is mintable; the native call was not attempted.`);
            break;
          }
          seedValues[ref.field] = minted;
        }
        if (parentFailed !== null) return parentFailed;
        // Nillable commercial Account links (WebCart-style) bind a live
        // Account, else mint an owned one: native commerce Apex faults
        // on accountless fixtures even though the field stays nillable.
        if (seedValues.AccountId === undefined && commercialAccountLinkField(fields) !== null) {
          const link = await seedCommercialAccountLink(request, root);
          if ("bound" in link) {
            seedValues.AccountId = link.bound;
          } else if ("mint" in link) {
            const parentMarkerField = markerFieldFor(link.mint.fields.filter(record));
            if (parentMarkerField === null) {
              return fail("APEX_EXEC_ACCOUNT_UNAVAILABLE",
                "The owned Account parent exposes no writable marker field; the native call was not attempted.");
            }
            const parentBuilt = await input.build("Account", marker,
              { OwnerId: input.ownerUserId, [parentMarkerField]: marker });
            if ("failure" in parentBuilt) return parentBuilt.failure;
            const parentCreated = await request(`${root}/sobjects/Account`, "POST", parentBuilt.values);
            const parentId: unknown = parentCreated.body?.id ?? parentCreated.body?.Id;
            if (!parentCreated.ok || !identity(parentId)) return parentCreated;
            owned.push({ objectName: "Account", id: parentId, markerField: parentMarkerField });
            const parentRead = await request(`${root}/sobjects/Account/${parentId}`);
            if (!parentRead.ok || !record(parentRead.body) || parentRead.body.Id !== parentId ||
              parentRead.body[parentMarkerField] !== marker) {
              return fail("APEX_EXEC_ACCOUNT_UNVERIFIED",
                "The owned Account parent readback failed; the native call was not attempted.");
            }
            seedValues.AccountId = parentId;
          } else {
            return fail("APEX_EXEC_ACCOUNT_UNAVAILABLE",
              `${link.unavailable} The native call was not attempted.`);
          }
        }
        // Geocode-shaped record fallbacks need a real address: the vendor
        // geocodes the fixture row, and an empty address yields no coordinates.
        const probeAddress = entry.fallback ? apexExecProbeAddressValues(target) : null;
        const built = await input.build(target, marker,
          probeAddress !== null ? { ...seedValues, ...probeAddress } : seedValues);
        if ("failure" in built) return built.failure;
        let created = await request(`${root}/sobjects/${target}`, "POST", built.values);
        if ((!created.ok || !identity(created.body?.id ?? created.body?.Id)) && apexExecTriggerNpe400(created)) {
          const rescued = await createWithTriggerParents(target, fields, built.values);
          if (rescued !== null) created = rescued;
        }
        const createdId: unknown = created.body?.id ?? created.body?.Id;
        if (!created.ok || !identity(createdId)) return created;
        owned.push({ objectName: target, id: createdId, markerField });
        // Existence gate: an invoked id is proven live here. Any inert
        // shape refuses before the apex POST below.
        const gated = await request(`${root}/sobjects/${target}/${createdId}`);
        if (!gated.ok || !record(gated.body) || gated.body.Id !== createdId ||
          (markerField !== null && gated.body[markerField] !== marker)) {
          return fail("APEX_EXEC_FIXTURE_UNVERIFIED", "The owned fixture readback did not prove a live row; the native call was not attempted.");
        }
        provisioned.set(target, createdId);
        idValues[entry.input] = createdId;
        fixtureIds.push(createdId);
        fixtureObjects.push(target);
      }
      fixtureId = fixtureIds[0];
      for (const name of idInputs) {
        if (apexExecIdInputIsCollection(descriptorInputs, name) && identity(idValues[name])) {
          idValues[name] = [idValues[name]];
        }
      }
      const invoked = await request(input.route, "POST", { inputs: [{ ...staticArgs, ...idValues }] });
      invokeRan = true;
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, input.verificationWindowMs));
      const acceptance = apexExecAccepted(invoked.status, invoked.body);
      const outputIds = acceptance.accepted ? apexExecOutputIds(acceptance.outputValues) : [];
      echoFound = fixtureIds.some((id) => outputIds.includes(id));
      childIds = outputIds.filter((id) => !fixtureIds.includes(id));
      fixtureOk = true;
      for (let index = 0; index < fixtureIds.length; index++) {
        const reread = await request(`${root}/sobjects/${fixtureObjects[index]}/${fixtureIds[index]}`);
        if (!reread.ok || !record(reread.body) || reread.body.Id !== fixtureIds[index]) fixtureOk = false;
      }
      // Geo-query vendors return FOREIGN live ids (the found record),
      // which are query hits, not side effects: they verify nothing and
      // fail nothing. Every other lane keeps the conservative rule (an
      // unadopted output id is an unverified side effect) — foreign
      // creates outside a query lane stay failing, never silent.
      const geoQuery = apexExecGeoQueryInputNames(descriptorInputs, idInputs) !== null;
      for (const child of childIds) {
        let hit: string | null = null;
        for (const objectName of fixtureObjects) {
          const childRead = await request(`${root}/sobjects/${objectName}/${child}`);
          if (childRead.ok && record(childRead.body) && childRead.body.Id === child) { hit = objectName; break; }
        }
        if (hit === null) { if (!geoQuery) childrenOk = false; }
        else owned.push({ objectName: hit, id: child, markerField: null });
      }
      nested = acceptance.outputValues !== null && apexExecNestedFlags(acceptance.outputValues);
      sideEffectVerified = fixtureOk && childrenOk && (echoFound || childIds.length > 0);
      verified = acceptance.accepted && fixtureOk && childrenOk && (!nested || sideEffectVerified);
      return invoked;
    })();
  } catch {
    if (outcome.body?.errorCode === "APEX_EXEC_CONTEXT_UNAVAILABLE") {
      outcome = fail("APEX_EXEC_LIFECYCLE_UNVERIFIED", "The owned apex lifecycle failed; ownership-scoped cleanup still runs.");
    }
    verified = false;
  } finally {
    for (const entry of owned.slice().reverse()) {
      await request(`${root}/sobjects/${entry.objectName}/${entry.id}`, "DELETE");
      const check = await request(`${root}/sobjects/${entry.objectName}/${entry.id}`);
      if (check.status !== 404) {
        cleanupError = "Owned apex fixture cleanup could not be verified; the record may still exist.";
      } else if (entry.markerField !== null) {
        const swept = await request(`${root}/query?q=${encodeURIComponent(
          `SELECT Id FROM ${entry.objectName} WHERE ${entry.markerField}='${marker}' LIMIT 2`)}`);
        const rows = record(swept.body) && Array.isArray(swept.body.records) ? swept.body.records : null;
        if (!swept.ok || !rows || rows.length > 0) {
          cleanupError = "Owned apex fixture cleanup could not be verified; a marker-scoped sibling may remain.";
        }
      }
    }
    try {
      if (fixtureObject !== null) {
        const counted = await request(`${root}/query?q=${encodeURIComponent(`SELECT COUNT() FROM ${fixtureObject}`)}`);
        countAfter = counted.ok && record(counted.body) && typeof counted.body.totalSize === "number"
          ? counted.body.totalSize : null;
      }
    } catch { countAfter = null; }
  }
  return done(outcome, {
    verified: cleanupError ? false : verified,
    marker, fixtureObject, idInput, staticArgs,
    fixtureId: fixtureId ?? null, echoFound, childIds,
    idValues, fixtureObjects,
    fixtureReadbackOk: invokeRan ? fixtureOk : null,
    childrenReadbackOk: invokeRan ? childrenOk : null,
    nestedFlags: invokeRan ? nested : null,
    countBefore, countAfter,
    apexReadback: { performed: invokeRan, sideEffectVerified: invokeRan && sideEffectVerified },
    verificationRecordIds: fixtureId ? [fixtureId, ...childIds] : [], ownedRecords: owned,
    ...(cleanupError ? { cleanupError } : {}),
  });
}
