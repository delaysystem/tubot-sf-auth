/**
 * Bounded record-input resolution for `invokeFlowWithContext`.
 *
 * Root cause: the record-input branch resolved SOBJECT inputs against the
 * full `/sobjects/` catalog (6.3MB / 6796 objects on large SDO orgs,
 * blind-verified via `sf api request rest`). Any catalog-call failure
 * (60s Salesforce timeout surfaces as 504 SALESFORCE_TIMEOUT with ok:false;
 * 5xx likewise) silently emptied the match list, and the loop `break` kept
 * the default FLOW_RECORD_CONTEXT_UNAVAILABLE verdict, mislabeling
 * transient infrastructure as schema truth ("does not resolve its record
 * inputs to createable objects") for flows whose Event/Case inputs resolve
 * fine against live metadata.
 *
 * This module resolves the 1-3 record inputs against a bounded
 * EntityDefinition IN-query (kilobytes, same mechanism the searcher uses
 * for execution-identity object resolution) and preserves match semantics:
 * exact sObjectType hit first, else a case-insensitive field-name hit. A
 * failed catalog call must be passed through honestly by the caller instead
 * of falling into the schema-truth default.
 *
 * Zero-hardcoding contract: no org IDs, aliases, instance URLs, tenant
 * names, or customer values appear here. Candidate names are
 * caller-supplied live descriptor values validated before use.
 */

/** Family builder version: bounded record-input catalog + honest catalog-failure passthrough. 106: searcher routes record-input CHAIN_UNRESOLVED rows into the fixture path (mixed/mirror eligibility). 107: catalog-missed targets terminalize FLOW_RECORD_TARGET_ABSENT with one omitted-input attempt for read-only-evident flows; required fixture references seed from live lookups (first-live borrow per field) with owned-parent mints for rowless single-target references. 108: owned-creation planning retains live setup rows (BusinessHours) for unmintable reference targets instead of refusing. 109: live reference borrowing gated on provably read-only descriptors (token-aware evidence: underscore/camel-joined verbs count); mutating or unknown flows use owned mints or refuse, never live rows; identity-shaped caller scalars refused for such flows (FLOW_RECORD_LIVE_INPUT_REFUSED). 110: record-input flow rows re-audit through refinement-loop owned-substrate routing and creation-sweep/read/delete plans. 111: fixture targets preflight live create/read/delete access before minting; undeletable record types (ITSM Incident/ChangeRequest) refuse instead of minting orphan fixtures that fail cleanup verification. 112: trigger-null-tolerant fixture enrichment (a fixture insert that faults in a managed trigger retries once with nillable references populated from owned mints). 113: opt-out setup-default + poly-mint seeding; update-contract seeding; RecordTypeId null exclusion; flow-access provisioning re-audit. 114: Event slot completion + ServiceAppointment fixture recipe with live Status picklist binding re-audit SOBJECT-input flow rows. 115: record inputs ride sparse (Id + updateable only); conventional recordId rebinds to the owned fixture (malformed markers faulted Id-filtered Gets). */
export const FLOW_RECORD_CONTEXT_BUILDER_VERSION = 117;

const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

export type FlowRecordDescriptorInput = {
  name?: unknown;
  sObjectType?: unknown;
};

/**
 * Validated EntityDefinition candidate names for the record inputs:
 * declared sObjectTypes plus field names (the name fallback resolves
 * inputs like `Case` whose descriptor omits the type). Deduped, capped.
 */
export function flowRecordCatalogCandidates(inputs: unknown): string[] {
  if (!Array.isArray(inputs)) return [];
  const names: string[] = [];
  for (const field of inputs) {
    if (field === null || typeof field !== "object" || Array.isArray(field)) continue;
    const record = field as Record<string, unknown>;
    for (const value of [record.sObjectType, record.name]) {
      if (typeof value === "string" && OBJECT_NAME.test(value) && !names.includes(value)) names.push(value);
    }
    if (names.length >= 50) break;
  }
  return names.slice(0, 50);
}

/** Bounded existence query for the candidates. Null when none is valid. */
export function flowRecordCatalogSoql(candidates: string[]): string | null {
  const clean = [...new Set(candidates)].filter((name) => OBJECT_NAME.test(name)).slice(0, 50);
  if (!clean.length) return null;
  return `SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName IN (${clean.map((name) => `'${name}'`).join(",")})`;
}

/**
 * Resolve one record input against QualifiedApiName rows from the bounded
 * catalog query. Exact sObjectType hit first, else a case-insensitive
 * field-name hit (parity with the legacy full-catalog matcher). Null when
 * neither resolves: genuinely absent from the live org schema.
 */
export function resolveFlowRecordTarget(qualifiedNames: unknown, field: FlowRecordDescriptorInput): string | null {
  const names = Array.isArray(qualifiedNames)
    ? qualifiedNames.filter((name): name is string => typeof name === "string" && OBJECT_NAME.test(name))
    : [];
  if (!names.length) return null;
  const declared = typeof field?.sObjectType === "string" ? field.sObjectType : null;
  if (declared && names.includes(declared)) return declared;
  const wanted = typeof field?.name === "string" ? field.name.toLowerCase() : "";
  if (!wanted) return null;
  return names.find((name) => name.toLowerCase() === wanted) ?? null;
}

/**
 * Owned-fixture preflight over a live `/sobjects/<name>/describe` body.
 * Null when the caller may mint a disposable fixture; otherwise the exact
 * refusal reason. An uncreateable, unqueryable, or undeletable target can
 * never complete the create/readback/delete lifecycle, so minting one
 * manufactures orphan residue plus a guaranteed cleanup failure. Callers
 * check transport failure (`!ok`) separately and pass it through honestly.
 */
export function flowRecordFixtureBlocker(objectName: string, schema: unknown): string | null {
  if (typeof objectName !== "string" || !OBJECT_NAME.test(objectName)) return `Invalid fixture object '${objectName}'.`;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return `The live ${objectName} describe body is unusable; the fixture target cannot be verified.`;
  const body = schema as Record<string, unknown>;
  if (body.createable !== true || body.queryable !== true || body.deletable !== true) {
    return `Automatic ${objectName} context requires live create, read and delete access; ` +
      `createable=${String(body.createable)} queryable=${String(body.queryable)} deletable=${String(body.deletable)}.`;
  }
  if (!Array.isArray(body.fields)) return `The live ${objectName} describe exposes no field schema; fixture values cannot be built.`;
  return null;
}
