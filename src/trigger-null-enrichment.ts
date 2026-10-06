/**
 * Trigger-null-tolerant fixture enrichment.
 *
 * Root cause (blind-verified live via sf CLI on the sweep org): managed
 * BeforeInsert triggers dereference relationship fields the fixture never
 * sets. A minimal ServiceAppointment insert (required datetimes only)
 * faults `FSL.TR001_Service_BeforeInsert ... System.NullPointerException`,
 * while the identical insert with a parent reference succeeds — for both
 * WorkOrder and Account parents. The same sparse mint fails the
 * flow-owned-substrate chain and the record-input flow path, and both
 * return the raw failure, so the sweep records a vendor-looking
 * CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY for what is actually an
 * input-shape gap in the owned mint.
 *
 * Policy: when a fixture insert faults with the trigger-null signature
 * (and only then — QueryException no-rows shapes are setup data, never
 * enrichable), the caller re-plans with the nillable createable reference
 * fields populated from owned mints and retries the insert once. All
 * enrichment parents are owned, marker-scoped, and caller-tracked for
 * cleanup exactly like planned nodes; anything unplannable falls back to
 * the original fault honestly. No live row is ever read for binding here:
 * enrichment targets always mint (the mutating/unknown-flow posture that
 * owned fixtures or refusal requires).
 *
 * Zero-hardcoding contract: no org IDs, aliases, tenant names, object
 * names, or field names appear here. Candidates derive strictly from the
 * live describe of the failed object plus caller-supplied planned nodes
 * and reference-target hints.
 */

export type EnrichmentField = {
  name?: unknown;
  type?: unknown;
  createable?: unknown;
  nillable?: unknown;
  defaultedOnCreate?: unknown;
  calculated?: unknown;
  autoNumber?: unknown;
  referenceTo?: unknown;
};

export type EnrichmentSchema = {
  name?: unknown;
  createable?: unknown;
  queryable?: unknown;
  deletable?: unknown;
  fields?: unknown;
};

export type EnrichmentCandidate = {
  /** Nillable reference field on the failed object to populate. */
  field: string;
  /** Owned-mint target object for the field. */
  target: string;
  /** True when the target is already planned (caller reuses its id). */
  reuse: boolean;
};

/** Cap: max polymorphic targets probed per field (mirrors the seeder cap). */
export const TRIGGER_NULL_TARGET_CAP = 8;
/** Cap: max enrichment candidates per failed insert (bounds parent mints). */
export const TRIGGER_NULL_CANDIDATE_CAP = 8;

const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

const TRIGGER_NULL_SIGNATURE =
  /execution of (?:BeforeInsert|BeforeUpdate|AfterInsert|AfterUpdate) caused by: System\.NullPointerException/;

/**
 * True when an insert outcome carries the trigger-null signature: HTTP 400
 * with CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY and a managed-trigger
 * NullPointerException. Bounded scan; never throws.
 */
export function isTriggerNullInsertFault(status: unknown, body: unknown): boolean {
  if (status !== 400) return false;
  let codeHit = false;
  let signatureHit = false;
  const scan = (value: unknown, depth: number): void => {
    if (codeHit && signatureHit) return;
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (value === "CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY") codeHit = true;
      if (TRIGGER_NULL_SIGNATURE.test(value)) signatureHit = true;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) scan(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const entry of Object.values(value as Record<string, unknown>)) scan(entry, depth + 1);
    }
  };
  try {
    scan(body, 0);
  } catch {
    return false;
  }
  return codeHit && signatureHit;
}

/**
 * Nillable reference fields eligible for enrichment: reference type,
 * createable, not required (the planner already wires nillable=false),
 * not defaulted/calculated/auto-number. Targets are validated, deduped,
 * describe-ordered, and capped. Pure; never throws.
 */
export function optionalReferenceFields(
  fields: unknown,
): Array<{ name: string; targets: string[] }> {
  const out: Array<{ name: string; targets: string[] }> = [];
  try {
    const list = Array.isArray(fields) ? fields : [];
    for (const field of list) {
      if (field === null || typeof field !== "object" || Array.isArray(field)) continue;
      const row = field as Record<string, unknown>;
      if (typeof row.name !== "string" || !OBJECT_NAME.test(row.name)) continue;
      if (row.type !== "reference" || row.createable !== true) continue;
      if (
        row.nillable === false ||
        row.defaultedOnCreate === true ||
        row.calculated === true ||
        row.autoNumber === true
      )
        continue;
      const targets: string[] = [];
      const refs = Array.isArray(row.referenceTo) ? row.referenceTo : [];
      for (const name of refs) {
        if (typeof name !== "string" || !OBJECT_NAME.test(name)) continue;
        if (targets.includes(name)) continue;
        targets.push(name);
        if (targets.length >= TRIGGER_NULL_TARGET_CAP) break;
      }
      if (targets.length === 0) continue;
      out.push({ name: row.name, targets });
    }
  } catch {
    return [];
  }
  return out;
}

export type TriggerNullEnrichmentInput = {
  /** Failed object name (scopes reference-target hints). */
  objectName: string;
  /** Live describe fields of the failed object. */
  fields: unknown;
  /** Already-planned owned nodes whose ids the caller reuses. */
  plannedObjectNames?: string[];
  /** Already-bound fields on the failed row (skipped). */
  boundFields?: string[];
  /** Caller `${object}.${field}` -> target hints for polymorphic fields. */
  referenceTargets?: Record<string, string>;
  /** Live describe reader (caller cache preferred). */
  describe: (objectName: string) => Promise<EnrichmentSchema | undefined>;
};

const mintable = (schema: EnrichmentSchema | undefined): boolean =>
  !!schema &&
  schema.createable === true &&
  schema.queryable === true &&
  schema.deletable === true;

/**
 * Ordered enrichment candidates for a trigger-null insert failure:
 * every nillable createable reference field bound to an owned-mint
 * target (already-planned targets reuse, never re-mint). Single-target
 * fields resolve directly; polymorphic fields take the caller hint when
 * it names a listed target, else the first describe-ordered target that
 * is already planned or owned-mintable. Fields with no usable target are
 * skipped, never guessed. Read-only; never throws (returns [] when
 * nothing enrichable resolves).
 */
export async function planTriggerNullEnrichment(
  input: TriggerNullEnrichmentInput,
): Promise<EnrichmentCandidate[]> {
  const candidates: EnrichmentCandidate[] = [];
  try {
    if (!input || typeof input.objectName !== "string" || !OBJECT_NAME.test(input.objectName)) return [];
    if (typeof input.describe !== "function") return [];
    const planned = new Set(
      (Array.isArray(input.plannedObjectNames) ? input.plannedObjectNames : []).filter(
        (name): name is string => typeof name === "string" && OBJECT_NAME.test(name),
      ),
    );
    const bound = new Set(
      (Array.isArray(input.boundFields) ? input.boundFields : []).filter(
        (name): name is string => typeof name === "string" && OBJECT_NAME.test(name),
      ),
    );
    for (const field of optionalReferenceFields(input.fields)) {
      if (candidates.length >= TRIGGER_NULL_CANDIDATE_CAP) break;
      if (bound.has(field.name)) continue;
      const hint = input.referenceTargets?.[`${input.objectName}.${field.name}`];
      const hinted = typeof hint === "string" && field.targets.includes(hint) ? hint : null;
      const ordered = hinted
        ? [hinted, ...field.targets.filter((name) => name !== hinted)]
        : field.targets;
      let chosen: EnrichmentCandidate | null = null;
      for (const target of ordered) {
        if (planned.has(target)) {
          chosen = { field: field.name, target, reuse: true };
          break;
        }
      }
      if (!chosen) {
        for (const target of ordered) {
          let schema: EnrichmentSchema | undefined;
          try {
            schema = await input.describe(target);
          } catch {
            continue;
          }
          if (mintable(schema)) {
            chosen = { field: field.name, target, reuse: false };
            break;
          }
        }
      }
      if (chosen) candidates.push(chosen);
    }
  } catch {
    return [];
  }
  return candidates;
}
