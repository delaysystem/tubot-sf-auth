/** Planner-only permission-denial → grant-family catalog.
 *
 * Maps standard Salesforce denial vocabulary to the grant family a
 * provisioning planner must add to the fixture permission set. This module
 * never applies grants, never touches credentials, and never invents
 * object or permission names: families are fixed catalog keys, and the
 * only interpolated identifier is a validated sObject name. Returns null
 * when no evidenced mapping matches so the caller keeps its verdict.
 *
 * Scope is REST/actions-API denial vocabulary plus fixture-cleanup delete
 * denials: standard denial codes with anatomy, and the friendly
 * "Looks like you don't have access ..." 400 vocabulary the actions API
 * returns for feature/action/record/object gates (R5 route lane, Round-4
 * sweep evidence). Flow-run output denials, field-visibility, and
 * package-permission denials stay in the managed-flow-faults taxonomy,
 * which owns their setup requirements; this catalog never reclassifies
 * those shapes.
 *
 * Callers: `denialGrantForRestOutcome` feeds the auth REST-denial path
 * (record-action, skipped-standard engine, commerce, email-alert, and
 * quick-action failure returns attach its planner-only output), and
 * `grantFamilyForCleanupDenial` feeds the owned-context cleanup error
 * surfacing (delete-denied objects name their grant family in the
 * recorded cleanup error). Neither ever applies grants.
 *
 * Zero-hardcoding contract: no org IDs, aliases, instance URLs, tenant
 * names, or customer values appear here or in any output. Raw upstream
 * messages are matched, never echoed.
 */

export type DenialGrantInput = {
  /** HTTP status of the denied call. */
  status: number;
  /** Sanitized upstream messages already collected by the caller. */
  messages: string[];
  /** Upstream error/status codes already collected by the caller. */
  codes: string[];
};

export type GrantFamily =
  /** Object-level create/read/update/delete through the fixture permission set. */
  | "object-crud"
  /** Row-level visibility (ownership, sharing, or role hierarchy). */
  | "record-access"
  /** Access to a referenced parent or shared row. */
  | "cross-reference"
  /** Feature-level permission gate (friendly actions-API vocabulary). */
  | "feature-access"
  /** Action-level run permission gate (friendly actions-API vocabulary). */
  | "action-access"
  /** Integration/product data access gate (e.g. Pardot data reads). */
  | "package-data";

export type DenialGrant = {
  family: GrantFamily;
  /** Fixed setup text with only validated identifiers. */
  requirement: string;
  /** A matched mapping always unblocks a retry once provisioned. */
  retryable: true;
  objectName?: string;
};

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const validName = (value: unknown): value is string =>
  typeof value === "string" && IDENTIFIER.test(value);

const CODE_TOKEN = /^[A-Z][A-Z0-9_]{1,63}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const firstMatch = (texts: string[], pattern: RegExp): string | null => {
  for (const text of texts) {
    if (typeof text !== "string") continue;
    const found = text.match(pattern);
    if (found) return found[0];
  }
  return null;
};

/** Classify a standard denial into its grant family. Null when no
 * evidenced mapping matches. */
export function classifyDenialGrant(
  input: DenialGrantInput,
): DenialGrant | null {
  if (!input || !Array.isArray(input.messages) || !Array.isArray(input.codes))
    return null;
  const texts = input.messages.filter((v) => typeof v === "string");
  const codes = input.codes.filter((v) => typeof v === "string");

  // (1) Cross-reference denial. The standard code names the missing row
  // access explicitly; the anatomy guard keeps bare-code matches honest.
  if (
    codes.includes("INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY") ||
    (codes.includes("INSUFFICIENT_ACCESS_OR_READONLY") &&
      firstMatch(texts, /insufficient access rights on cross reference id/i))
  ) {
    return {
      family: "cross-reference",
      requirement:
        "Give the execution identity access to the referenced parent or shared record " +
        "(ownership, sharing, or role hierarchy) through fixture provisioning, then retry.",
      retryable: true,
    };
  }

  // (2) Record-level denial. The object-id anatomy distinguishes row
  // visibility from object permissions; a bare code stays unclassified
  // because the two need different grants.
  if (
    codes.includes("INSUFFICIENT_ACCESS_OR_READONLY") &&
    firstMatch(texts, /insufficient access rights on object id/i)
  ) {
    return {
      family: "record-access",
      requirement:
        "Give the execution identity visibility into the denied record (ownership, sharing, " +
        "or role hierarchy) through fixture provisioning, then retry. An object-level grant " +
        "does not fix row visibility.",
      retryable: true,
    };
  }

  // (3) Friendly record gate. The actions API names the record level
  // explicitly ("this record"), which is the same row-visibility anatomy
  // as (2): an object-level grant does not fix it.
  if (
    firstMatch(texts, /looks like you don['\u2019]t have access to this record/i)
  ) {
    return {
      family: "record-access",
      requirement:
        "Give the execution identity visibility into the denied record (ownership, sharing, " +
        "or role hierarchy) through fixture provisioning, then retry. An object-level grant " +
        "does not fix row visibility.",
      retryable: true,
    };
  }

  // (4) Friendly object gate. The actions API names the gated object
  // ("the <name> object"); the name is interpolated only when it is a
  // usable identifier, otherwise the requirement stays generic.
  {
    const gated = texts
      .map((text) =>
        /looks like you don['\u2019]t have access to the (.+?) object/i.exec(
          text,
        )?.[1]?.trim(),
      )
      .find((value): value is string => typeof value === "string");
    if (gated !== undefined) {
      const named = validName(gated) ? gated : null;
      return {
        family: "object-crud",
        requirement: named
          ? `Grant the execution identity read access to the ${named} object through the fixture ` +
            "permission set during org provisioning, then retry."
          : "Grant the execution identity read access to the gated object through the fixture " +
            "permission set during org provisioning, then retry.",
        retryable: true,
        ...(named ? { objectName: named } : {}),
      };
    }
  }

  // (5) Friendly feature gate. The actions API names no permission; the
  // fixture permission set must carry the feature access the action
  // requires (an admin resolves the exact permission during provisioning).
  if (
    firstMatch(texts, /looks like you don['\u2019]t have access to this feature/i)
  ) {
    return {
      family: "feature-access",
      requirement:
        "Grant the execution identity access to the gated feature (the feature permission " +
        "the action requires) through the fixture permission set during org provisioning, " +
        "then retry.",
      retryable: true,
    };
  }

  // (6) Friendly action gate. Same shape as (5) at action level: the
  // execution identity may not run the action itself.
  if (
    firstMatch(texts, /looks like you don['\u2019]t have access to this action/i)
  ) {
    return {
      family: "action-access",
      requirement:
        "Grant the execution identity access to run the gated action through the fixture " +
        "permission set during org provisioning, then retry.",
      retryable: true,
    };
  }

  // (7) Integration-data gate. The platform names the product data the
  // caller may not read ("You need access to <product> data ..."); the
  // product token is interpolated only when identifier-valid.
  {
    const product = texts
      .map((text) =>
        /you need access to ([A-Za-z][A-Za-z0-9_. ]{0,40}?) data to/i.exec(
          text,
        )?.[1]?.trim(),
      )
      .find((value): value is string => typeof value === "string");
    if (product !== undefined) {
      const named = validName(product) ? product : null;
      return {
        family: "package-data",
        requirement: named
          ? `Grant the execution identity access to ${named} data through the fixture ` +
            "permission set during org provisioning, then retry."
          : "Grant the execution identity access to the integration data the action reads " +
            "through the fixture permission set during org provisioning, then retry.",
        retryable: true,
      };
    }
  }

  // (8) CSV-convert access clause. The convert permission is the grantable
  // part; the same message also carries input-shape clauses (valid
  // document id, target API name, insert/upsert operation) that the
  // engine's bindings supply or refuse closed, never this catalog.
  if (
    firstMatch(
      texts,
      /couldn['\u2019]t convert the records from the uploaded csv file because you don['\u2019]t have the required access/i,
    )
  ) {
    return {
      family: "feature-access",
      requirement:
        "Grant the execution identity CSV-convert access (received-document read plus " +
        "target-object create) through the fixture permission set during org provisioning, " +
        "then retry with live document, target, and operation inputs.",
      retryable: true,
    };
  }

  return null;
}

export type RestOutcomeSignal = {
  /** Bounded sanitized upstream messages (matched, never echoed). */
  messages: string[];
  /** Bounded validated upstream codes. */
  codes: string[];
};

/** Bounded message/code extraction shared by the grant catalog and the
 * quick-action failure planners. Pure: no reads, no logging. */
export function collectRestOutcomeSignal(body: unknown): RestOutcomeSignal {
  const messages: string[] = [];
  const codes: string[] = [];
  const pushMessage = (value: unknown): void => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      messages.length >= 8
    )
      return;
    messages.push(value.slice(0, 500));
  };
  const pushCode = (value: unknown): void => {
    if (
      typeof value !== "string" ||
      !CODE_TOKEN.test(value) ||
      codes.length >= 8 ||
      codes.includes(value)
    )
      return;
    codes.push(value);
  };
  const items = Array.isArray(body) ? body.slice(0, 8) : [body];
  for (const item of items) {
    if (!record(item)) continue;
    pushMessage(item.message);
    pushCode(item.errorCode);
    const nested = Array.isArray(item.errors) ? item.errors.slice(0, 8) : [];
    for (const entry of nested) {
      if (!record(entry)) continue;
      pushMessage(entry.message);
      pushCode(entry.statusCode);
      pushCode(entry.errorCode);
    }
  }
  return { messages, codes };
}

/** Map one REST outcome to its grant family. Null when the response is
 * not an evidenced denial shape. Pure planner output: returned grants
 * are requirements text, never applied. Extracted messages/codes are
 * bounded and matched, never echoed. */
export function denialGrantForRestOutcome(
  status: number,
  body: unknown,
): DenialGrant | null {
  if (!Number.isInteger(status)) return null;
  const { messages, codes } = collectRestOutcomeSignal(body);
  if (messages.length === 0 && codes.length === 0) return null;
  return classifyDenialGrant({ status, messages, codes });
}

/** Grant family for a fixture-cleanup delete denial on a validated object.
 * Planner input only; null when the object name is not a usable identifier. */
export function grantFamilyForCleanupDenial(
  objectName: unknown,
): DenialGrant | null {
  if (!validName(objectName)) return null;
  return {
    family: "object-crud",
    requirement:
      `Grant the execution identity ${objectName} delete access through the fixture ` +
      "permission set during org provisioning, then retry.",
    retryable: true,
    objectName,
  };
}

/** Record-access note for unreclaimable drifted-owner deletes. An object grant does not fix drift. */
export function grantFamilyForCleanupDrift(objectName: unknown): DenialGrant | null {
  if (!validName(objectName)) return null;
  return {
    family: "record-access",
    requirement:
      `The owned ${objectName} fixture was reassigned away from the execution identity by org automation (assignment rules, flows, or queue routing) ` +
      "and ownership could not be reclaimed before deletion. Exclude owned-fixture markers from reassignment automation through fixture provisioning, then retry.",
    retryable: true,
    objectName,
  };
}
