/**
 * Bounded independent evidence for opaque managed-flow execution faults.
 *
 * Branch (14) of the managed-flow-fault taxonomy
 * (`managed-flow-faults.ts`) splits an opaque UNKNOWN_EXCEPTION execution
 * fault into a retryable missing-invocable shape (14a) and a terminal
 * schema-skew shape (14b), but only on caller-supplied evidence that
 * nobody passed: every row stamped the generic code. This module supplies
 * that evidence with a handful of cached live reads, following the same
 * guarded convention as taxonomy branches (3)/(4) and (6): validated
 * evidence only, anything unvalidated falls through to the generic code.
 *
 * Evidence rules (each independently verified against live org state):
 * - missingInvocable: the referenced invocable is absent from the live
 *   Apex action descriptor (404), the ApexClass table (tooling query, zero
 *   rows), the standard action catalog, and — for dotted names — the
 *   external-service catalog. Present on any surface, or unverifiable on
 *   any surface, yields no evidence.
 * - missingSchemaField: the referenced object describes successfully and
 *   its live field list does not contain the referenced field. A failed
 *   object describe yields no evidence on purpose: objects hidden from the
 *   execution identity describe as 404, which is a permission gap, never
 *   platform skew. Fields are never filtered out of a successful describe,
 *   so absence there proves org-level skew.
 *
 * Candidates come from the failing flow's own live metadata (actionCalls
 * and apexPluginCalls for invocables; recordLookups, recordCreates,
 * recordUpdates, and recordDeletes for schema references), never from the
 * fault message: the
 * opaque sentence carries no anatomy. All reads are bounded and cached in
 * a caller-provided cache; typical cost on an opaque fault is four reads
 * (two metadata, one descriptor, one ApexClass query), worst case ten.
 *
 * Zero-hardcoding contract: no org IDs, aliases, instance URLs, tenant
 * names, or customer values appear here. Flow/object/field/invocable
 * names are caller-supplied live values validated before use. Upstream
 * messages are matched, never echoed: every emitted string is fixed
 * taxonomy text plus validated identifiers.
 */

import {
  classifyManagedFlowFault,
  type ManagedFlowFault,
  type ManagedFlowFaultInput,
} from "./managed-flow-faults";

export type FlowExecutionTransport = (
  path: string,
  method?: string,
  body?: any,
) => Promise<{ status: number; ok: boolean; body: any }>;

export type FlowMetadataReferences = {
  invocables: string[];
  schemaRefs: Array<{ objectName: string; fieldName: string }>;
};

export type FlowExecutionEvidence = {
  missingInvocable?: string;
  missingSchemaField?: { objectName: string; fieldName: string };
};

/**
 * Tri-state read cache: a missing key was never read, null was read but
 * stayed unverifiable, and a value is verified live state. Callers reuse
 * one cache per probe; metadata and catalog entries never expire inside
 * a single probe lifecycle.
 */
export type FlowExecutionEvidenceCache = {
  metadata?: Map<string, FlowMetadataReferences | null>;
  apexDescriptor?: Map<string, boolean | null>;
  apexClass?: Map<string, boolean | null>;
  standardCatalog?: Set<string> | null;
  externalServiceCatalog?: Set<string> | null;
  describes?: Map<string, Set<string> | null>;
};

/** Read bounds: opaque-fault evidence never exceeds a handful of reads. */
export const FLOW_EXECUTION_EVIDENCE_BOUNDS = {
  /** Invocable candidates extracted from flow metadata. */
  metadataInvocables: 4,
  /** Schema references extracted from flow metadata. */
  metadataSchemaRefs: 8,
  /** Invocable candidates checked against live surfaces. */
  invocablesChecked: 2,
  /** Schema references checked against live describes. */
  schemaRefsChecked: 6,
  /** Fresh object describes fetched for schema checks. */
  describesFetched: 3,
  /** Catalog entries scanned for one membership check. */
  catalogEntriesScanned: 5000,
  /** Messages/codes extracted from one invoke response. */
  signalMessages: 8,
  signalCodes: 8,
  /** Characters kept per extracted message (matching only). */
  signalTextLength: 500,
} as const;

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const CALLOUT_TOKEN =
  /^[A-Za-z][A-Za-z0-9_]{0,62}(?:\.[A-Za-z][A-Za-z0-9_]{0,62})?$/;
const CODE_TOKEN = /^[A-Z][A-Z0-9_]{1,63}$/;
const API_ROOT = /^\/services\/data\/v\d+(?:\.\d+)?$/;

const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validName = (value: unknown): value is string =>
  typeof value === "string" && IDENTIFIER.test(value);
const validCallout = (value: unknown): value is string =>
  typeof value === "string" && CALLOUT_TOKEN.test(value);

/**
 * Invocation signal extracted from a flow-invoke response. Messages and
 * codes are bounded and sanitized for classifier matching; they are
 * never persisted, logged, or echoed into outputs.
 */
export function extractFlowExecutionSignal(
  status: number,
  body: unknown,
): Pick<
  ManagedFlowFaultInput,
  "status" | "messages" | "codes" | "outputErrorMessage" | "envelopeSucceeded"
> {
  const messages: string[] = [];
  const codes: string[] = [];
  let outputErrorMessage: string | null = null;
  const pushMessage = (value: unknown): void => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      messages.length >= FLOW_EXECUTION_EVIDENCE_BOUNDS.signalMessages
    )
      return;
    messages.push(
      value.slice(0, FLOW_EXECUTION_EVIDENCE_BOUNDS.signalTextLength),
    );
  };
  const pushCode = (value: unknown): void => {
    if (
      typeof value !== "string" ||
      !CODE_TOKEN.test(value) ||
      codes.length >= FLOW_EXECUTION_EVIDENCE_BOUNDS.signalCodes ||
      codes.includes(value)
    )
      return;
    codes.push(value);
  };
  const items = Array.isArray(body)
    ? body.slice(0, FLOW_EXECUTION_EVIDENCE_BOUNDS.signalMessages)
    : [body];
  for (const item of items) {
    if (!record(item)) continue;
    pushMessage(item.message);
    pushMessage(item.errorMessage);
    pushCode(item.errorCode);
    const nested = Array.isArray(item.errors)
      ? item.errors.slice(0, FLOW_EXECUTION_EVIDENCE_BOUNDS.signalMessages)
      : [];
    for (const entry of nested) {
      if (!record(entry)) continue;
      pushMessage(entry.message);
      pushCode(entry.statusCode);
      pushCode(entry.errorCode);
    }
    const outputs = record(item.outputValues) ? item.outputValues : null;
    if (
      outputs &&
      typeof outputs.errorMessage === "string" &&
      outputs.errorMessage.length > 0
    ) {
      if (outputErrorMessage === null)
        outputErrorMessage = outputs.errorMessage.slice(
          0,
          FLOW_EXECUTION_EVIDENCE_BOUNDS.signalTextLength,
        );
      pushMessage(outputs.errorMessage);
    }
  }
  const rows = Array.isArray(body) ? body : [];
  const envelopeSucceeded =
    rows.length > 0 &&
    rows.every(
      (row) =>
        record(row) && row.isSuccess === true && !Array.isArray(row.errors),
    );
  return {
    status,
    messages,
    codes,
    ...(outputErrorMessage !== null ? { outputErrorMessage } : {}),
    envelopeSucceeded,
  };
}

/**
 * Dependency references parsed from live Flow metadata. Only validated
 * identifier shapes are returned; anything unparseable yields no
 * candidates (safe direction: fewer candidates, generic fallthrough).
 * recordLookups/recordCreates shapes mirror the repo's proven
 * flowLookupBindings/flowCreationRecipes parsers; recordUpdates shares
 * the creation assignment shape defensively, and updates/deletes share
 * the lookup filter shape (deleted rows scope through filters only).
 */
export function extractFlowMetadataReferences(
  metadata: unknown,
): FlowMetadataReferences {
  const refs: FlowMetadataReferences = { invocables: [], schemaRefs: [] };
  if (!record(metadata)) return refs;
  const pushInvocable = (value: unknown): void => {
    if (
      !validCallout(value) ||
      refs.invocables.length >= FLOW_EXECUTION_EVIDENCE_BOUNDS.metadataInvocables ||
      refs.invocables.includes(value)
    )
      return;
    refs.invocables.push(value);
  };
  const pushSchemaRef = (objectName: unknown, fieldName: unknown): void => {
    if (
      !validName(objectName) ||
      !validName(fieldName) ||
      refs.schemaRefs.length >= FLOW_EXECUTION_EVIDENCE_BOUNDS.metadataSchemaRefs ||
      refs.schemaRefs.some(
        (ref) => ref.objectName === objectName && ref.fieldName === fieldName,
      )
    )
      return;
    refs.schemaRefs.push({ objectName, fieldName });
  };
  if (Array.isArray(metadata.actionCalls)) {
    for (const call of metadata.actionCalls.filter(record)) {
      if (
        typeof call.actionType === "string" &&
        call.actionType.toLowerCase() === "apex"
      )
        pushInvocable(call.actionName);
    }
  }
  if (Array.isArray(metadata.apexPluginCalls)) {
    for (const call of metadata.apexPluginCalls.filter(record))
      pushInvocable(call.apexClass);
  }
  if (Array.isArray(metadata.recordLookups)) {
    for (const lookup of metadata.recordLookups.filter(record)) {
      if (!validName(lookup.object) || !Array.isArray(lookup.filters)) continue;
      for (const filter of lookup.filters.filter(record))
        pushSchemaRef(lookup.object, filter.field);
    }
  }
  for (const key of ["recordCreates", "recordUpdates"] as const) {
    if (!Array.isArray(metadata[key])) continue;
    for (const mutation of metadata[key].filter(record)) {
      if (!validName(mutation.object)) continue;
      const assignments = Array.isArray(mutation.inputAssignments)
        ? mutation.inputAssignments.filter(record)
        : [];
      for (const assignment of assignments)
        pushSchemaRef(mutation.object, assignment.field);
      // Updates (and deletes below) scope their rows through filter
      // fields exactly like lookups do; a renamed filter column faults
      // the interview the same way a renamed lookup column does.
      if (Array.isArray(mutation.filters)) {
        for (const filter of mutation.filters.filter(record))
          pushSchemaRef(mutation.object, filter.field);
      }
    }
  }
  if (Array.isArray(metadata.recordDeletes)) {
    for (const deletion of metadata.recordDeletes.filter(record)) {
      if (!validName(deletion.object) || !Array.isArray(deletion.filters))
        continue;
      for (const filter of deletion.filters.filter(record))
        pushSchemaRef(deletion.object, filter.field);
    }
  }
  return refs;
}

const safeRequest = async (
  request: FlowExecutionTransport,
  path: string,
  method = "GET",
): Promise<{ status: number; ok: boolean; body: any } | null> => {
  try {
    const result = await request(path, method);
    if (
      !result ||
      typeof result.status !== "number" ||
      typeof result.ok !== "boolean"
    )
      return null;
    return result;
  } catch {
    return null;
  }
};

/**
 * Live references for one flow: FlowDefinition plus Flow Metadata via the
 * tooling API (two reads, cached per flow). Null when the definition is
 * ambiguous, unreadable, or the caller input is invalid — every null
 * keeps the generic stamp.
 */
export async function fetchFlowMetadataReferences(input: {
  root: string;
  flowName: string;
  request: FlowExecutionTransport;
  cache?: FlowExecutionEvidenceCache;
}): Promise<FlowMetadataReferences | null> {
  const { root, flowName, request } = input;
  if (
    typeof root !== "string" ||
    !API_ROOT.test(root) ||
    !validName(flowName)
  )
    return null;
  const cache = input.cache ?? {};
  input.cache ??= cache;
  cache.metadata ??= new Map();
  if (cache.metadata.has(flowName)) return cache.metadata.get(flowName) ?? null;
  const local = flowName.includes("__")
    ? flowName.slice(flowName.indexOf("__") + 2)
    : flowName;
  const definition = await safeRequest(
    request,
    `${root}/tooling/query?q=${encodeURIComponent(
      `SELECT DeveloperName,NamespacePrefix,ActiveVersionId FROM FlowDefinition WHERE DeveloperName IN ('${flowName}','${local}')`,
    )}`,
  );
  const rows =
    definition?.ok && record(definition.body) && Array.isArray(definition.body.records)
      ? definition.body.records
          .filter(record)
          .filter(
            (item) =>
              (item.NamespacePrefix
                ? `${item.NamespacePrefix}__${item.DeveloperName}`
                : item.DeveloperName) === flowName,
          )
      : [];
  const versionId = rows.length === 1 ? rows[0].ActiveVersionId : null;
  if (
    typeof versionId !== "string" ||
    !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(versionId)
  ) {
    cache.metadata.set(flowName, null);
    return null;
  }
  const retrieved = await safeRequest(
    request,
    `${root}/tooling/query?q=${encodeURIComponent(
      `SELECT Metadata FROM Flow WHERE Id='${versionId}'`,
    )}`,
  );
  const metadata =
    retrieved?.ok && record(retrieved.body) && Array.isArray(retrieved.body.records)
      ? retrieved.body.records.filter(record)[0]?.Metadata
      : null;
  if (!record(metadata)) {
    cache.metadata.set(flowName, null);
    return null;
  }
  const refs = extractFlowMetadataReferences(metadata);
  cache.metadata.set(flowName, refs);
  return refs;
}

/**
 * Live field-name set from an sObject describe body, lowercase-keyed so
 * casing drift never misfires as skew. Null when the body is unusable.
 * Callers holding freshly fetched describes seed the evidence cache with
 * this for zero extra reads.
 */
export function describeFieldNames(body: unknown): Set<string> | null {
  if (!record(body) || !Array.isArray(body.fields)) return null;
  const names = new Set<string>();
  for (const field of body.fields) {
    if (record(field) && typeof field.name === "string" && field.name.length > 0)
      names.add(field.name.toLowerCase());
  }
  return names;
}

/** Catalog membership mirroring the worker's action-entry matcher: exact
 * hits plus a unique namespaced alias for bare names. */
function catalogHasName(catalog: unknown, target: string): boolean | null {
  if (!record(catalog) || !Array.isArray(catalog.actions)) return null;
  const entries = catalog.actions
    .slice(0, FLOW_EXECUTION_EVIDENCE_BOUNDS.catalogEntriesScanned)
    .filter(record);
  if (
    entries.some(
      (entry) =>
        typeof entry.name === "string" &&
        entry.name.toLowerCase() === target.toLowerCase(),
    )
  )
    return true;
  if (target.includes("__")) return false;
  const aliases = entries.filter((entry) => {
    if (typeof entry.name !== "string") return false;
    const boundary = entry.name.indexOf("__");
    return (
      boundary > 0 &&
      boundary === entry.name.lastIndexOf("__") &&
      entry.name.slice(boundary + 2).toLowerCase() === target.toLowerCase()
    );
  });
  if (aliases.length === 1) return true;
  return catalog.actions.length >
    FLOW_EXECUTION_EVIDENCE_BOUNDS.catalogEntriesScanned
    ? null
    : false;
}

/** True when the named Apex invocable descriptor is live (cached). Null
 * when unverifiable; only a 404 proves absence. */
async function apexDescriptorPresent(
  root: string,
  name: string,
  request: FlowExecutionTransport,
  cache: FlowExecutionEvidenceCache,
): Promise<boolean | null> {
  cache.apexDescriptor ??= new Map();
  if (cache.apexDescriptor.has(name))
    return cache.apexDescriptor.get(name) ?? null;
  const result = await safeRequest(
    request,
    `${root}/actions/custom/apex/${name}`,
  );
  let present: boolean | null = null;
  if (result) {
    if (
      result.ok &&
      record(result.body) &&
      Array.isArray(result.body.inputs) &&
      Array.isArray(result.body.outputs)
    )
      present = true;
    else if (result.status === 404) present = false;
  }
  cache.apexDescriptor.set(name, present);
  return present;
}

/** True when the ApexClass table carries the class (cached). Null when
 * the tooling query is refused or unreadable. */
async function apexClassPresent(
  root: string,
  bare: string,
  request: FlowExecutionTransport,
  cache: FlowExecutionEvidenceCache,
): Promise<boolean | null> {
  cache.apexClass ??= new Map();
  if (cache.apexClass.has(bare)) return cache.apexClass.get(bare) ?? null;
  const result = await safeRequest(
    request,
    `${root}/tooling/query?q=${encodeURIComponent(
      `SELECT Id,Name FROM ApexClass WHERE Name='${bare}' LIMIT 1`,
    )}`,
  );
  let present: boolean | null = null;
  if (result?.ok && record(result.body) && Array.isArray(result.body.records)) {
    const rows = result.body.records.filter(record);
    present = rows.some(
      (row) =>
        typeof row.Name === "string" &&
        row.Name.toLowerCase() === bare.toLowerCase(),
    );
  } else if (result?.ok) {
    present = null;
  }
  cache.apexClass.set(bare, present);
  return present;
}

async function catalogNames(
  root: string,
  scope: "standard" | "custom/externalService",
  request: FlowExecutionTransport,
  cache: FlowExecutionEvidenceCache,
): Promise<Set<string> | null | undefined> {
  const key =
    scope === "standard" ? "standardCatalog" : "externalServiceCatalog";
  const cached = cache[key];
  if (cached !== undefined) return cached;
  const result = await safeRequest(request, `${root}/actions/${scope}`);
  if (!result?.ok || !record(result.body) || !Array.isArray(result.body.actions)) {
    cache[key] = null;
    return null;
  }
  const names = new Set<string>();
  for (const entry of result.body.actions
    .slice(0, FLOW_EXECUTION_EVIDENCE_BOUNDS.catalogEntriesScanned)
    .filter(record)) {
    if (typeof entry.name === "string" && entry.name.length > 0)
      names.add(entry.name);
  }
  if (
    result.body.actions.length > FLOW_EXECUTION_EVIDENCE_BOUNDS.catalogEntriesScanned
  ) {
    cache[key] = null;
    return null;
  }
  cache[key] = names;
  return names;
}

const namesHave = (names: Set<string>, target: string): boolean =>
  catalogHasName(
    { actions: [...names].map((name) => ({ name })) },
    target,
  ) === true;

/**
 * Bounded independent evidence for branch (14). Checks the first
 * invocable candidates against the Apex descriptor, the ApexClass table,
 * the standard catalog, and (dotted names) the external-service catalog;
 * checks the first schema references against cached-or-fresh describes.
 * Every check that cannot be verified is skipped, so the result only
 * ever carries independently proven absence.
 */
export async function collectFlowExecutionEvidence(input: {
  root: string;
  request: FlowExecutionTransport;
  invocables?: unknown;
  schemaRefs?: unknown;
  cache?: FlowExecutionEvidenceCache;
}): Promise<FlowExecutionEvidence> {
  const evidence: FlowExecutionEvidence = {};
  const { root, request } = input;
  if (typeof root !== "string" || !API_ROOT.test(root)) return evidence;
  const cache = input.cache ?? {};
  input.cache ??= cache;
  const invocables = Array.isArray(input.invocables)
    ? input.invocables
        .filter(validCallout)
        .filter((name, index, all) => all.indexOf(name) === index)
        .slice(0, FLOW_EXECUTION_EVIDENCE_BOUNDS.invocablesChecked)
    : [];
  for (const name of invocables) {
    if (evidence.missingInvocable) break;
    const bare = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
    if (!validName(bare)) continue;
    const descriptor = await apexDescriptorPresent(root, name, request, cache);
    if (descriptor === true) continue;
    if (descriptor === null) continue;
    const tabled = await apexClassPresent(root, bare, request, cache);
    if (tabled !== false) continue;
    const standard = await catalogNames(root, "standard", request, cache);
    if (standard === undefined || standard === null) continue;
    if (namesHave(standard, name) || namesHave(standard, bare)) continue;
    if (name.includes(".")) {
      const external = await catalogNames(
        root,
        "custom/externalService",
        request,
        cache,
      );
      if (external === undefined || external === null) continue;
      if (namesHave(external, name)) continue;
    }
    evidence.missingInvocable = name;
  }
  const refs = Array.isArray(input.schemaRefs)
    ? input.schemaRefs
        .filter(
          (
            ref,
          ): ref is { objectName: string; fieldName: string } =>
            record(ref) &&
            validName(ref.objectName) &&
            validName(ref.fieldName),
        )
        .filter(
          (ref, index, all) =>
            all.findIndex(
              (other) =>
                other.objectName === ref.objectName &&
                other.fieldName === ref.fieldName,
            ) === index,
        )
        .slice(0, FLOW_EXECUTION_EVIDENCE_BOUNDS.schemaRefsChecked)
    : [];
  cache.describes ??= new Map();
  let freshDescribes = 0;
  for (const ref of refs) {
    if (evidence.missingSchemaField) break;
    let fields = cache.describes.get(ref.objectName);
    if (fields === undefined) {
      if (freshDescribes >= FLOW_EXECUTION_EVIDENCE_BOUNDS.describesFetched)
        continue;
      freshDescribes += 1;
      const schema = await safeRequest(
        request,
        `${root}/sobjects/${ref.objectName}/describe`,
      );
      fields = schema?.ok ? describeFieldNames(schema.body) : null;
      cache.describes.set(ref.objectName, fields ?? null);
    }
    if (!fields) continue;
    if (!fields.has(ref.fieldName.toLowerCase()))
      evidence.missingSchemaField = {
        objectName: ref.objectName,
        fieldName: ref.fieldName,
      };
  }
  return evidence;
}

/**
 * Classify one flow-invoke outcome with optional branch-(14) evidence.
 * Pure: no reads, no logging. Invalid evidence falls through to the
 * generic code exactly like absent evidence (the taxonomy validates).
 */
export function diagnoseFlowExecutionFault(input: {
  status: number;
  body: unknown;
  evidence?: FlowExecutionEvidence | null;
}): ManagedFlowFault | null {
  const signal = extractFlowExecutionSignal(input.status, input.body);
  const evidence = record(input.evidence) ? input.evidence : {};
  return classifyManagedFlowFault({
    status: signal.status,
    messages: signal.messages,
    codes: signal.codes,
    ...(signal.outputErrorMessage !== undefined
      ? { outputErrorMessage: signal.outputErrorMessage }
      : {}),
    envelopeSucceeded: signal.envelopeSucceeded,
    ...(typeof (evidence as FlowExecutionEvidence).missingInvocable === "string"
      ? {
          missingInvocable: (evidence as FlowExecutionEvidence)
            .missingInvocable as string,
        }
      : {}),
    ...(record((evidence as FlowExecutionEvidence).missingSchemaField)
      ? {
          missingSchemaField: (
            evidence as FlowExecutionEvidence
          ).missingSchemaField as { objectName: string; fieldName: string },
        }
      : {}),
  });
}
