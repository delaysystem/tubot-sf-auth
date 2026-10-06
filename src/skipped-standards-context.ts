/**
 * Skipped-standards owned-context helpers (Auth side).
 *
 * Root causes addressed generically (no per-org or per-tenant values):
 * - QUICK_ACTION_MARKER_UNAVAILABLE: targets such as group/messaging
 *   objects expose no 48-char writable Name marker. This module selects a
 *   relaxed alternative marker (writable + filterable text, >= 24 chars)
 *   so ownership stays provable without inventing schema.
 * - QUICK_ACTION_REQUIRED_INPUT_UNRESOLVED: event/task-style required
 *   inputs (picklist, boolean, date/datetime/time, numerics, email,
 *   base64, short text) have no scoped value. Resolution draws ONLY from
 *   the live target schema supplied by the caller; reference/ID inputs
 *   are never synthesized.
 * - QUICK_ACTION_FIXTURE_TYPE_UNSUPPORTED (feed-item tasks): a FeedItem
 *   task derives from an existing live parent record instead of global
 *   creation. Every plan requires a caller-supplied live record id and a
 *   live schema that verifies the parent reference.
 * - COMMERCE/CART_ACTION_OUTCOME_MISSING: cart reads/mutations returning
 *   HTTP 200 with no outcome stay failures; an administrator probe only
 *   annotates an execution-user context difference, never substitutes.
 *
 * No org IDs, aliases, tenant names, instance URLs, or package namespaces
 * appear here. No success is synthesized. License blocks are reported ONLY
 * on explicit license text in the upstream body.
 */

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const SALESFORCE_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const MARKER_PREFIX = "AS probe ";

export type TargetField = {
  name: string;
  type?: string | null;
  createable?: boolean | null;
  filterable?: boolean | null;
  updateable?: boolean | null;
  nillable?: boolean | null;
  calculated?: boolean | null;
  autoNumber?: boolean | null;
  nameField?: boolean | null;
  length?: number | null;
  compoundFieldName?: string | null;
  referenceTo?: string[] | null;
  picklistValues?: Array<{ value?: string; active?: boolean }> | null;
};

export type DescriptorField = {
  name: string;
  type?: string | null;
  required?: boolean | null;
};

export type MarkerSelection = { name: string; length: number };

/** Relaxed marker selection for targets with no 48-char Name field. */
export function selectAlternativeMarkerField(fields: TargetField[]): MarkerSelection | null {
  if (!Array.isArray(fields)) return null;
  const candidates = fields.filter(
    (f) =>
      f &&
      typeof f.name === "string" &&
      FIELD_NAME.test(f.name) &&
      f.createable === true &&
      f.filterable === true &&
      (f.type === "string" || f.type === "textarea") &&
      typeof f.length === "number" &&
      f.length >= 24 &&
      f.calculated !== true &&
      f.autoNumber !== true &&
      !f.compoundFieldName,
  );
  if (!candidates.length) return null;
  const picked =
    candidates.find((f) => f.nameField === true) ??
    candidates.find((f) => f.nillable === false) ??
    candidates[0];
  return { name: picked.name, length: picked.length as number };
}

/** Unique ownership marker bounded to the selected field length. */
export function newSkippedStandardsMarker(maxLength = 80): string {
  const marker = `${MARKER_PREFIX}${crypto.randomUUID()}`;
  return marker.slice(0, Math.max(24, Math.min(255, maxLength)));
}

/**
 * Resolves a required action input from the live target schema. Returns
 * undefined when no safe scoped value exists (caller records
 * QUICK_ACTION_REQUIRED_INPUT_UNRESOLVED). Reference/ID inputs are never
 * synthesized: they need an owned dependency the caller supplies.
 */
export function resolveRequiredInputValue(
  input: DescriptorField,
  targetFields: TargetField[],
): unknown {
  if (!input || typeof input.name !== "string" || !FIELD_NAME.test(input.name)) return undefined;
  const schema = (Array.isArray(targetFields) ? targetFields : []).find(
    (f) => f && f.name.toLowerCase() === input.name.toLowerCase(),
  );
  const lowerType = String(schema?.type ?? input.type ?? "").toLowerCase();
  if (lowerType === "reference" || lowerType === "id") return undefined;
  if (lowerType === "picklist" || lowerType === "combobox") {
    const choice = schema?.picklistValues?.find((v) => v && v.active === true && typeof v.value === "string");
    return choice?.value;
  }
  if (lowerType === "boolean") return true;
  if (lowerType === "date") return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  if (lowerType === "datetime") return new Date(Date.now() + 3_600_000).toISOString();
  if (lowerType === "time") return `${new Date().toISOString().slice(11, 23)}Z`;
  if (lowerType === "integer" || lowerType === "int" || lowerType === "double" || lowerType === "currency" || lowerType === "percent") return 1;
  // Encrypted-string wire format is plain text (the platform encrypts
  // server-side), so it shares the text branch; base64 carries a short
  // fixed probe payload that must fit the live length.
  if (lowerType === "base64") {
    const payload = "QWN0aW9uUHJvYmU=";
    const length = typeof schema?.length === "number" ? schema.length : 80;
    return length >= payload.length ? payload : undefined;
  }
  if (lowerType === "email") {
    const address = `probe-${crypto.randomUUID()}@example.invalid`;
    const length = typeof schema?.length === "number" ? schema.length : 80;
    return length >= address.length ? address : undefined;
  }
  if (lowerType === "string" || lowerType === "textarea" || lowerType === "encryptedstring" || lowerType === "phone" || lowerType === "url") {
    const length = typeof schema?.length === "number" ? schema.length : 80;
    return newSkippedStandardsMarker(Math.min(length, 80));
  }
  if (input.name.toLowerCase().includes("subject") || input.name.toLowerCase().includes("name")) {
    return newSkippedStandardsMarker(80);
  }
  return undefined;
}

export type FeedItemFixturePlan = {
  kind: "parent-record-derived";
  targetObject: string;
  parentObject: string;
  parentField: string;
  parentRecordId: string;
  verified: false;
};

export type FeedItemFixtureResolution =
  | { ok: true; plan: FeedItemFixturePlan }
  | { ok: false; code: string; message: string };

/**
 * Generic parent-derived fixture for feed-item quick-action targets.
 * Requires a caller-supplied live parent record id and a live target
 * schema verifying the parent reference; otherwise an explicit failure.
 */
export function buildFeedItemTaskFixture(input: {
  targetObject: string;
  contextObject?: string;
  parentField?: string;
  parentRecordId?: string;
  targetFields?: TargetField[];
}): FeedItemFixtureResolution {
  const fail = (code: string, message: string): FeedItemFixtureResolution => ({ ok: false, code, message });
  const target = input.targetObject;
  if (typeof target !== "string" || !FIELD_NAME.test(target)) {
    return fail("QUICK_ACTION_TARGET_SCHEMA_UNAVAILABLE", "The live Quick Action descriptor did not declare a usable target object.");
  }
  const context = typeof input.contextObject === "string" && FIELD_NAME.test(input.contextObject) ? input.contextObject : undefined;
  if (!context) {
    return fail(
      "QUICK_ACTION_FIXTURE_TYPE_UNSUPPORTED",
      "The live action needs a context lifecycle beyond global creation, owned updates, or creation with a declared parent reference.",
    );
  }
  if (typeof input.parentRecordId !== "string" || !SALESFORCE_ID.test(input.parentRecordId)) {
    return fail(
      "QUICK_ACTION_PARENT_CONTEXT_UNAVAILABLE",
      `No existing live ${context} record is available for independent verification.`,
    );
  }
  const fields = (Array.isArray(input.targetFields) ? input.targetFields : []).filter(
    (f): f is TargetField => !!f && typeof f.name === "string" && FIELD_NAME.test(f.name),
  );
  let parentField: TargetField | undefined;
  if (input.parentField !== undefined) {
    if (!FIELD_NAME.test(input.parentField)) {
      return fail("QUICK_ACTION_PARENT_SCHEMA_MISMATCH", "The live parent field does not reference the discovered context object.");
    }
    parentField = fields.find((f) => f.name.toLowerCase() === (input.parentField as string).toLowerCase());
    const ok =
      parentField?.type === "reference" &&
      Array.isArray(parentField.referenceTo) &&
      parentField.referenceTo.some((n) => String(n).toLowerCase() === context.toLowerCase());
    if (!ok) return fail("QUICK_ACTION_PARENT_SCHEMA_MISMATCH", "The live parent field does not reference the discovered context object.");
  } else {
    const candidates = fields.filter(
      (f) =>
        f.type === "reference" &&
        Array.isArray(f.referenceTo) &&
        f.referenceTo.some((n) => String(n).toLowerCase() === context.toLowerCase()),
    );
    parentField = candidates.find((f) => f.name.toLowerCase() === "parentid") ?? candidates[0];
    if (!parentField) return fail("QUICK_ACTION_PARENT_SCHEMA_MISMATCH", "The live parent field does not reference the discovered context object.");
  }
  if (!parentField) return fail("QUICK_ACTION_PARENT_SCHEMA_MISMATCH", "The live parent field does not reference the discovered context object.");
  return {
    ok: true,
    plan: {
      kind: "parent-record-derived",
      targetObject: target,
      parentObject: context,
      parentField: parentField.name,
      parentRecordId: input.parentRecordId,
      verified: false,
    },
  };
}

export type SkippedStandardReadback = {
  performed: boolean;
  markerField: string;
  marker: string;
  after: Record<string, unknown> | null;
  expectedChanges: Record<string, unknown>;
  expectedParent?: { field: string; id: string };
  actionAccepted: boolean;
};

/**
 * Actual-effect readback for skipped-standards lifecycles. Native success
 * alone never verifies: the owned record must carry the marker and every
 * expected change, plus any required relationship.
 */
export function verifySkippedStandardReadback(input: SkippedStandardReadback): { verified: boolean; code: string | null } {
  if (typeof input.marker !== "string" || !input.marker.startsWith(MARKER_PREFIX)) {
    return { verified: false, code: "MUTATION_MARKER_INVALID" };
  }
  if (typeof input.markerField !== "string" || !FIELD_NAME.test(input.markerField)) {
    return { verified: false, code: "MUTATION_MARKER_INVALID" };
  }
  if (input.expectedParent !== undefined) {
    if (!FIELD_NAME.test(input.expectedParent.field) || !SALESFORCE_ID.test(input.expectedParent.id)) {
      return { verified: false, code: "MUTATION_RELATIONSHIP_INVALID" };
    }
    const actual = input.after?.[input.expectedParent.field];
    if (actual !== undefined && actual !== input.expectedParent.id) {
      return { verified: false, code: "MUTATION_RELATIONSHIP_MISMATCH" };
    }
    if (!input.actionAccepted || input.after === null || input.after[input.markerField] !== input.marker) {
      return { verified: false, code: "MUTATION_RELATIONSHIP_UNVERIFIED" };
    }
    if (actual === undefined) return { verified: false, code: "MUTATION_RELATIONSHIP_UNVERIFIED" };
    return { verified: true, code: null };
  }
  if (!input.actionAccepted || input.after === null) return { verified: false, code: "MUTATION_CREATE_UNVERIFIED" };
  for (const [field, value] of Object.entries(input.expectedChanges)) {
    if (input.after[field] !== value) return { verified: false, code: "MUTATION_CREATE_UNVERIFIED" };
  }
  if (input.after[input.markerField] !== input.marker) return { verified: false, code: "MUTATION_CREATE_UNVERIFIED" };
  return { verified: true, code: null };
}

function collectFaultText(value: unknown, out: string[], depth: number): void {
  if (depth > 6 || out.length > 32) return;
  if (typeof value === "string") {
    if (value.trim()) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collectFaultText(item, out, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const key of ["message", "errorMessage", "error_description", "primaryMessage"]) {
      const entry = (value as Record<string, unknown>)[key];
      if (typeof entry === "string") collectFaultText(entry, out, depth + 1);
    }
    for (const key of ["errors", "error", "details", "result", "body", "outputValues"]) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined && entry !== null) collectFaultText(entry, out, depth + 1);
    }
  }
}

/**
 * Fault classifier for skipped-standards outcomes. A license block is
 * returned ONLY on explicit license text; empty HTTP 200 outcomes stay
 * outcome-missing failures and never become successes.
 */
export function classifySkippedStandardFault(
  status: number,
  body: unknown,
): { category: string; code: string; message: string } {
  const texts: string[] = [];
  collectFaultText(body, texts, 0);
  const combined = texts.join("; ").slice(0, 320) || `Salesforce returned HTTP ${status}`;
  if (/\blicen[cs]e\b/i.test(combined)) {
    const feature =
      combined.match(/(?:requires?|needs?)\s+(?:an?\s+)?([A-Za-z][A-Za-z0-9 ()_-]{1,80}?)\s+licen[cs]e/i)?.[1] ??
      combined.match(/([A-Za-z][A-Za-z0-9 ()_-]{1,80}?)\s+licen[cs]e\s+(?:is required|is needed|not available|not enabled)/i)?.[1];
    return { category: "license_required", code: "LICENSE_REQUIRED", message: `${(feature?.trim() || "Salesforce feature") as string} license is needed` };
  }
  const httpOk = Number.isInteger(status) && status >= 200 && status < 300;
  const emptyOutcome =
    (Array.isArray(body) && body.length === 0) ||
    (body !== null && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0) ||
    body === null ||
    body === undefined ||
    body === "";
  if (httpOk && emptyOutcome) {
    return {
      category: "outcome_missing",
      code: "SKIPPED_STANDARD_OUTCOME_MISSING",
      message: `The call returned HTTP ${status} without a native action outcome; no mutation is counted as successful.`,
    };
  }
  return {
    category: status >= 400 ? "http_error" : "action_rejected",
    code: "SKIPPED_STANDARD_REJECTED",
    message: combined,
  };
}
