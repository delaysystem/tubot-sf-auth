/**
 * Apex effect screen + owned-shape contracts for r7 skip-exempt conversions
 * (Auth side).
 *
 * Root causes (blind-verified 2026-10-06 on the sweep org via sf CLI):
 * - Invocables taking a required SOBJECT input plus scalar companions (chatbot
 *   case/contact updaters) verb-skip with no owned path, yet the live
 *   descriptor declares the fixture object (`sObjectType`) and the live class
 *   bodies update ONLY the passed row (the Community-User leg is commented
 *   out; a post-invoke User query proves no user side-effect). Owned
 *   fixture + shaped-record invoke + effect-diff readback + verified cleanup
 *   converts them.
 * - Scalar-only invocables split three ways by live class body: a pure string
 *   splitter (no DML, synthetic invoke echoes the split, zero residue), a
 *   bulk date-shifter (`update` over queried ServiceAppointments — unownable),
 *   and managed send/callout twins whose bodies are generated stubs ("isn't
 *   the actual source code") — unverifiable, refused.
 * - External-system creators require `businessUnitId` and/or
 *   `namedCredential` (Pardot business-unit writes through a callout
 *   credential): no Salesforce-side fixture, readback, or cleanup can own
 *   the effect. Refused terminally by input contract.
 * - Scalar-pure probes bind identifier vocabulary from live rules, never the
 *   marker: `fieldsTo*` takes `Id` (the only universal field; vendors parse
 *   dynamic-SOQL lists), field-name inputs take the universal `Name`, and
 *   object-name inputs take the runner-discovered live catalog name (an
 *   undiscoverable catalog is an explicit miss, never a marker).
 * - Pure probes populate OPTIONAL scalars too: omitting them NPEs vendors
 *   that dereference the list (`{}` -> "Attempt to de-reference a null
 *   object"), and unresolvable optionals omit honestly instead of failing
 *   the plan. Address-vocabulary strings take a marker-derived CSV with a
 *   state+zip tail (vendors split on commas, then on the space).
 *
 * Generic throughout: action type + route shape + live descriptor contract
 * only. No class names, object names, org ids, aliases, or package
 * namespaces appear here. The screen is conservative: any effect keyword —
 * even in a comment — refuses, and unreadable bodies refuse. Refusal is the
 * safe direction; purity must be proven.
 */

import { resolveRequiredInputValue, type DescriptorField } from "./skipped-standards-context";

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
/** Dynamic-SOQL field-list inputs (fieldsToQuery): vendors parse a list, never a marker. */
const FIELD_LIST_PREFIX = /^fieldsTo/i;
/** Field-name inputs take the universal field (mirrors the searcher probe lane). */
const FIELD_NAME_INPUT = /field/i;
const FIELD_NAME_SUFFIX = /(?:field(?:api)?(?:name)?|analy[sz]e|storefield)$/i;
/** Object-name-valued inputs bind the runner-discovered live catalog name. */
const OBJECT_NAME_INPUTS: ReadonlySet<string> = new Set([
  "objectapiname", "sobjecttype", "searchobject", "objectname", "sobjectname", "objectdevelopername",
]);
/** Address-vocabulary inputs: vendors comma-split the string, then space-split the tail. */
const ADDRESS_NAME = /address/i;
/** Fixed state+zip tail for the address CSV (format token like `Id`/`Name`, never tenant data). */
const ADDRESS_STATE_ZIP = "MC 12345";
/** String types the address CSV applies to (vendors parse strings, never typed cells). */
const ADDRESS_STRING_TYPES: ReadonlySet<string> = new Set(["STRING", "TEXT", "TEXTAREA", "TEXTAREA_LONG"]);
const MARKER_PREFIX = "AS probe ";
const STUB_MARKER = /this file is generated|isn't the actual source code/i;
const INVOCABLE_MARKER = /@invocablemethod/i;
/** Screen bound: bodies past this are refused, never truncated-and-passed. */
const BODY_SCREEN_LIMIT = 500_000;

export type ApexEffectClass = "DML" | "CALLOUT" | "SEND" | "ASYNC";

export type ApexBodyScreen =
  | { verdict: "pure" }
  | { verdict: "refuse"; effect: ApexEffectClass | "UNVERIFIABLE"; detail: string };

const EFFECT_PATTERNS: Array<{ effect: ApexEffectClass; pattern: RegExp; detail: string }> = [
  {
    effect: "DML",
    pattern: /\b(insert|update|upsert|delete|undelete|merge)\b|Database\.(insert|update|upsert|delete|undelete|merge|executeBatch|emptyRecycleBin)/i,
    detail: "database write",
  },
  {
    effect: "CALLOUT",
    pattern: /callout\s*:|\bHttp\b|HttpRequest|HttpResponse|\bContinuation\b/i,
    detail: "external HTTP callout",
  },
  {
    effect: "SEND",
    pattern: /Messaging\.|SingleEmailMessage|MassEmailMessage|sendEmail|SMSTextMessage|ConnectApi\./i,
    detail: "message transmission",
  },
  {
    effect: "ASYNC",
    pattern: /@future\b|\bQueueable\b|\bBatchable\b|\bSchedulable\b|System\.(enqueueJob|schedule|executeBatch)|EventBus\./i,
    detail: "asynchronous or platform-event execution",
  },
];

/**
 * Screens a live ApexClass body for effects. Pure ONLY when the body is a
 * readable, bounded, invocable source with zero effect keywords. SOQL reads,
 * loops, string/date math, and `Type.forName` dispatch are not effects
 * (query-only + payload-render relays are the established safe shape).
 */
export function screenApexBody(body: unknown): ApexBodyScreen {
  if (typeof body !== "string" || body.length === 0) {
    return { verdict: "refuse", effect: "UNVERIFIABLE", detail: "the live class body is missing" };
  }
  if (body.length > BODY_SCREEN_LIMIT) {
    return { verdict: "refuse", effect: "UNVERIFIABLE", detail: "the live class body exceeds the screen bound" };
  }
  if (STUB_MARKER.test(body)) {
    return {
      verdict: "refuse",
      effect: "UNVERIFIABLE",
      detail: "the live body is a generated managed stub, not the executable source",
    };
  }
  if (!INVOCABLE_MARKER.test(body)) {
    return { verdict: "refuse", effect: "UNVERIFIABLE", detail: "the live body declares no invocable entry point" };
  }
  for (const entry of EFFECT_PATTERNS) {
    if (entry.pattern.test(body)) {
      return { verdict: "refuse", effect: entry.effect, detail: `the live body performs a ${entry.detail}` };
    }
  }
  return { verdict: "pure" };
}

/**
 * Simple class name for the ApexClass lookup: the last `__`-separated
 * segment (`pi__CreateForm` -> `CreateForm`, `SDO_X` -> `SDO_X`). Null when
 * the action name is not a valid class reference.
 */
export function apexSimpleClassName(actionName: unknown): string | null {
  if (typeof actionName !== "string" || actionName.length === 0 || actionName.length > 127) return null;
  const segments = actionName.split("__");
  const simple = segments[segments.length - 1];
  if (!CLASS_NAME.test(simple)) return null;
  if (!segments.every((segment) => segment.length > 0 && CLASS_NAME.test(segment))) return null;
  return simple;
}

export type ApexDescriptorInput = DescriptorField & { sObjectType?: unknown };

const SCALAR_APEX_TYPES = new Set([
  "STRING", "TEXT", "TEXTAREA", "TEXTAREA_LONG", "EMAIL", "PHONE", "URL",
  "BOOLEAN", "DATE", "DATETIME", "TIME", "INTEGER", "INT", "LONG", "DOUBLE",
  "DECIMAL", "CURRENCY", "PERCENT", "COMBOBOX", "PICKLIST", "BASE64", "ENCRYPTEDSTRING",
]);

const validInputName = (input: unknown): input is ApexDescriptorInput =>
  !!input && typeof (input as ApexDescriptorInput).name === "string" &&
  FIELD_NAME.test((input as ApexDescriptorInput).name);

const inputType = (input: ApexDescriptorInput): string =>
  typeof input.type === "string" ? input.type.toUpperCase() : "";

/**
 * True when every declared input is scalar-typed: no ID, REFERENCE, or
 * SOBJECT input (required or optional) may ride a synthetic pure-function
 * probe. Untyped (null-type) inputs disqualify: unknown is not scalar.
 */
export function isApexScalarOnlyInputSet(inputs: unknown): boolean {
  if (!Array.isArray(inputs) || inputs.length === 0) return false;
  if (!inputs.every(validInputName)) return false;
  return (inputs as ApexDescriptorInput[]).every((input) => SCALAR_APEX_TYPES.has(inputType(input)));
}

export type ApexSobjectShapePlan = {
  sobjectInput: string;
  objectName: string;
  scalarInputs: string[];
};

/**
 * Owned-shape contract: exactly one required SOBJECT input carrying a live
 * `sObjectType` fixture object, every other required companion scalar, and
 * no ID/REFERENCE input anywhere. Anything else refuses with no POST.
 */
export function apexSobjectShapePlan(inputs: unknown): ApexSobjectShapePlan | { refuse: string } {
  if (!Array.isArray(inputs) || !inputs.every(validInputName)) return { refuse: "input_schema" };
  const fields = inputs as ApexDescriptorInput[];
  const sobjects = fields.filter((input) => inputType(input) === "SOBJECT" && input.required === true);
  if (fields.some((input) => inputType(input) === "ID" || inputType(input) === "REFERENCE")) {
    return { refuse: "identifier_input" };
  }
  if (fields.filter((input) => inputType(input) === "SOBJECT").length !== sobjects.length) {
    return { refuse: "sobject_shape" };
  }
  if (sobjects.length !== 1) return { refuse: "sobject_shape" };
  const target = sobjects[0];
  if (typeof target.sObjectType !== "string" || !CLASS_NAME.test(target.sObjectType)) {
    return { refuse: "sobject_target" };
  }
  for (const input of fields) {
    if (input === target) continue;
    if (input.required === true && !SCALAR_APEX_TYPES.has(inputType(input))) return { refuse: input.name };
  }
  return {
    sobjectInput: target.name,
    objectName: target.sObjectType,
    scalarInputs: fields.filter((input) => input !== target && input.required === true).map((input) => input.name),
  };
}

/**
 * True when a required input names an external-system business-unit key or
 * an explicit callout credential: the mutation executes outside Salesforce
 * (vendor business-unit asset writes), so no Salesforce-side fixture,
 * readback, or cleanup can own it. Matches the descriptor contract, never
 * class or package names.
 */
export function isApexExternalCalloutInputSet(inputs: unknown): boolean {
  if (!Array.isArray(inputs) || !inputs.every(validInputName)) return false;
  return (inputs as ApexDescriptorInput[]).some((input) =>
    input.required === true &&
    (input.name.toLowerCase() === "businessunitid" || input.name.toLowerCase() === "namedcredential"));
}

function markerToken(marker: string): string | null {
  if (!marker.startsWith(MARKER_PREFIX)) return null;
  const token = marker.slice(MARKER_PREFIX.length).replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  return token.length >= 4 ? token : null;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Marker-shaped companion value for one required scalar input. Identifier
 * vocabulary binds live rules first: `fieldsTo*` takes `Id`, field-name
 * inputs take the universal `Name`, and object-name inputs take the
 * runner-discovered live catalog name (undefined when undiscovered, so the
 * planner reports an explicit miss). Email-shaped inputs (by type or
 * platform-vocabulary name) take a blackhole `@example.invalid` address
 * and phone-shaped inputs take a fictional `+1555` number — both
 * deterministic per marker so planning is stable and repeatable.
 * Address-vocabulary strings (after the email/phone shapes, so
 * `emailAddress` keeps its email) take a marker-derived CSV with a
 * state+zip tail. Plain strings take the marker; dates, booleans, and
 * numerics resolve from live-schema rules. Undefined when no safe value
 * exists.
 */
export function apexCompanionValue(input: ApexDescriptorInput, marker: string, live?: { objectName?: string }): unknown {
  if (!validInputName(input)) return undefined;
  const token = markerToken(marker);
  if (token === null) return undefined;
  const type = inputType(input);
  const lowerName = input.name.toLowerCase();
  if (FIELD_LIST_PREFIX.test(input.name)) return "Id";
  if (FIELD_NAME_INPUT.test(lowerName) && FIELD_NAME_SUFFIX.test(lowerName)) return "Name";
  if (OBJECT_NAME_INPUTS.has(lowerName)) {
    return typeof live?.objectName === "string" && CLASS_NAME.test(live.objectName) ? live.objectName : undefined;
  }
  const emailShaped = type === "EMAIL" || (type === "STRING" && /email|e_mail|emailaddress/.test(lowerName));
  const phoneShaped =
    type === "PHONE" || (type === "STRING" && /phone|mobile|fax|sms|telephone/.test(lowerName));
  if (emailShaped) return `probe-${token.toLowerCase()}@example.invalid`;
  if (phoneShaped) return `+1555${String(fnv1a(marker) % 10_000_000).padStart(7, "0")}`;
  if (ADDRESS_STRING_TYPES.has(type) && ADDRESS_NAME.test(input.name)) {
    return `${marker},${marker},${ADDRESS_STATE_ZIP}`;
  }
  if (type === "STRING" || type === "TEXT" || type === "TEXTAREA" || type === "TEXTAREA_LONG") return marker;
  return resolveRequiredInputValue(input, []);
}

/** True when any input binds a live catalog object name (the runner must discover one). */
export function apexNeedsLiveObjectName(inputs: unknown): boolean {
  if (!Array.isArray(inputs)) return false;
  return (inputs as ApexDescriptorInput[]).some((input) =>
    validInputName(input) &&
    OBJECT_NAME_INPUTS.has(input.name.toLowerCase()));
}

/**
 * Marker-shaped companion value for owned-RECORD updates (SOBJECT-shape
 * runner). Generic string companions take the marker EMAIL form: it is a
 * valid email, valid phone text (phone fields carry no format check), and
 * valid subject prose, so email/phone/subject updaters all accept the same
 * marker-derived value (blind-verified: the live `value` companions are
 * STRING-typed with no email/phone hint). Phone-typed or phone-named
 * inputs keep the fictional number; every other type follows the scalar
 * shaper. Undefined when no safe value exists.
 */
export function apexRecordCompanionValue(input: ApexDescriptorInput, marker: string): unknown {
  if (!validInputName(input)) return undefined;
  const token = markerToken(marker);
  if (token === null) return undefined;
  const type = inputType(input);
  const lowerName = input.name.toLowerCase();
  if (type === "PHONE" || (type === "STRING" && /phone|mobile|fax|sms|telephone/.test(lowerName))) {
    return `+1555${String(fnv1a(marker) % 10_000_000).padStart(7, "0")}`;
  }
  if (type === "STRING" || type === "TEXT" || type === "TEXTAREA" || type === "TEXTAREA_LONG" || type === "EMAIL") {
    return `probe-${token.toLowerCase()}@example.invalid`;
  }
  return apexCompanionValue(input, marker);
}

/**
 * Declared-inputs-only synthetic arguments for scalar probes. Required and
 * optional scalars both bind (omitted optionals NPE vendors that
 * dereference them); descriptor-declared picklist values bind first.
 * Unresolvable required inputs are an explicit miss; unresolvable
 * optionals omit honestly instead of failing the plan. Collections,
 * apexClass-typed shapes, and identifier/record types never ride an
 * optional (identifiers are never invented; scalar sets carry none by
 * construction, so a required one still misses honestly below).
 */
export function planApexScalarArgs(
  inputs: unknown,
  marker: string,
  live?: { objectName?: string },
): { args: Record<string, unknown> } | { missing: string } {
  if (!Array.isArray(inputs) || !inputs.every(validInputName)) return { missing: "input_schema" };
  const args: Record<string, unknown> = {};
  for (const input of inputs as ApexDescriptorInput[]) {
    const optional = input.required !== true;
    const upperType = inputType(input);
    if (optional) {
      if (upperType === "ID" || upperType === "REFERENCE" || upperType === "SOBJECT") continue;
      const shape = input as ApexDescriptorInput & { isCollection?: unknown; maxOccurs?: unknown; apexClass?: unknown };
      if (shape.isCollection === true || (typeof shape.maxOccurs === "number" && shape.maxOccurs > 1)) continue;
      if (typeof shape.apexClass === "string" && shape.apexClass.length > 0) continue;
    }
    if (upperType === "PICKLIST" || upperType === "COMBOBOX" || upperType === "MULTIPICKLIST") {
      const raw = input as ApexDescriptorInput & { values?: unknown; picklistValues?: unknown };
      const candidates = Array.isArray(raw.values) ? raw.values : Array.isArray(raw.picklistValues) ? raw.picklistValues : [];
      const choice = candidates.find((entry) =>
        (typeof entry === "string" && entry) ||
        (!!entry && typeof entry === "object" && typeof (entry as { value?: unknown }).value === "string" &&
          (entry as { value: string }).value && (entry as { active?: unknown }).active !== false));
      const value = typeof choice === "string"
        ? choice
        : choice !== undefined ? (choice as { value: string }).value : undefined;
      if (typeof value !== "string" || !value) {
        if (optional) continue;
        return { missing: input.name };
      }
      args[input.name] = value;
      continue;
    }
    const value = apexCompanionValue(input, marker, live);
    if (value === undefined) {
      if (optional) continue;
      return { missing: input.name };
    }
    args[input.name] = value;
  }
  return { args };
}

/**
 * First alphabetical queryable object from a live `/sobjects` listing
 * (mirrors the searcher catalog choice); null when none qualifies. Pure:
 * the runner fetches, this picks.
 */
export function firstQueryableObjectName(sobjects: unknown): string | null {
  if (!Array.isArray(sobjects)) return null;
  const usable = sobjects.filter((item): item is { name: string; queryable?: unknown } =>
    !!item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string" &&
    CLASS_NAME.test((item as { name: string }).name));
  const preferred = usable.filter((item) => item.queryable === true);
  const sorted = (preferred.length ? preferred : usable).map((item) => item.name).sort((a, b) => a.localeCompare(b));
  return sorted[0] ?? null;
}

export type ApexUpdateEffectProof = {
  marker: string;
  markerField: string;
  /** Fixture read BEFORE the invoke (existence gate). */
  before: Record<string, unknown> | null;
  /** Fixture read AFTER the invoke. */
  after: Record<string, unknown> | null;
  /** String scalar values passed to the invoke. */
  scalarValues: unknown[];
};

/**
 * Effect proof for owned-record updates: the fixture must keep its marker
 * AND at least one non-marker field must have CHANGED to a passed scalar
 * marker value. Presence alone never verifies — the change proves the
 * invoke caused it. Boolean/numeric scalars are excluded (they pre-exist
 * too easily); only marker-derived strings count.
 */
export function verifyOwnedSobjectUpdate(proof: ApexUpdateEffectProof): {
  verified: boolean;
  code: string | null;
  effectField: string | null;
} {
  const miss = (code: string): { verified: boolean; code: string | null; effectField: string | null } =>
    ({ verified: false, code, effectField: null });
  if (typeof proof.marker !== "string" || !proof.marker.startsWith(MARKER_PREFIX)) {
    return miss("MUTATION_MARKER_INVALID");
  }
  if (typeof proof.markerField !== "string" || !FIELD_NAME.test(proof.markerField)) {
    return miss("MUTATION_MARKER_INVALID");
  }
  if (proof.after === null || typeof proof.after !== "object") return miss("MUTATION_UPDATE_UNVERIFIED");
  if (proof.before === null || typeof proof.before !== "object") return miss("MUTATION_UPDATE_UNVERIFIED");
  if ((proof.after as Record<string, unknown>)[proof.markerField] !== proof.marker) {
    return miss("MUTATION_UPDATE_UNVERIFIED");
  }
  const scalars = (Array.isArray(proof.scalarValues) ? proof.scalarValues : [])
    .filter((value): value is string => typeof value === "string" && value.length >= 8);
  if (scalars.length === 0) return miss("MUTATION_UPDATE_UNVERIFIED");
  const before = proof.before as Record<string, unknown>;
  const after = proof.after as Record<string, unknown>;
  for (const [field, value] of Object.entries(after)) {
    if (field === proof.markerField || field === "Id") continue;
    if (typeof value !== "string" || !scalars.includes(value)) continue;
    if (before[field] === value) continue;
    return { verified: true, code: null, effectField: field };
  }
  return miss("MUTATION_UPDATE_UNVERIFIED");
}

/** True when the platform reports the namespace absent (deleted or never persisted). */
export function contextNamespaceAbsent(body: unknown): boolean {
  const texts: string[] = [];
  const codes: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || texts.length >= 8) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 8)) visit(item, depth + 1);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "message" || key === "errorMessage") && typeof entry === "string") texts.push(entry);
      if ((key === "errorCode" || key === "statusCode") && typeof entry === "string") codes.push(entry);
      if (key === "errors" || key === "outputValues") visit(entry, depth + 1);
    }
  };
  visit(body, 0);
  const absent = codes.includes("RECORD_NOT_FOUND") || codes.includes("DELETE_FAILED");
  return absent && texts.some((text) => /doesn['\u2019]t exist or expired/i.test(text));
}
