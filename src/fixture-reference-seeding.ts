/**
 * Live foreign-key seeding for owned fixtures (F6 context resolution).
 *
 * Root cause (D1-verified 2026-10-06 on the sweep org): every Case fixture
 * fails with OWNED_CONTEXT_REQUIRED_REFERENCE_UNRESOLVED because
 * `Case.BusinessHoursId` is a required createable reference
 * (nillable=false, not defaulted) and every fixture `build` closure passes
 * an empty reference cache. Same shape for `WebCart.WebStoreId`,
 * `Swarm.RelatedRecordId` (polymorphic, 8 targets), and
 * `RebateProgramPayoutPeriod.RebateProgramId` (zero live rows).
 *
 * Policy (mirrors the two established precedents: quick-action
 * `seedLiveReferenceCache` borrows live channel/end-user FKs, and the
 * commerce lifecycle reuses a live provisioned storefront):
 * - Borrow: per required reference field, query each referenced object in
 *   describe order (`SELECT Id LIMIT 1`, capped) and bind the first live
 *   id. Borrowed rows are never written; they only satisfy platform
 *   foreign-key checks for fully owned (marked, creator=self, deletable)
 *   fixtures. The generic record-action lifecycle keeps its strict
 *   no-borrow posture (see its `cannot borrow the first existing tenant
 *   record` test): borrowing is opt-in per lifecycle via this helper, and
 *   `synthesizeRecordValues` itself performs no lookups.
 * - Mint: when no referenced target holds a live row and the field names a
 *   single mintable target (live describe: createable + queryable +
 *   deletable), return a mint plan. The CALLER mints the owned parent with
 *   its own marker and cleanup tracking (a shared helper must never create
 *   rows it cannot delete). Polymorphic fields with no live row anywhere
 *   stay unresolved: choosing among unproven targets would be invention.
 * - Anything else (query/describe failures, unreadable bodies, invalid
 *   names) stays unresolved so the caller fails honest downstream; no
 *   identity is ever synthesized or guessed.
 * - Opt-out: `allowLiveBorrow: false` disables the borrow leg entirely (no
 *   live row is read for binding). Flow probing sets this whenever the
 *   flow is not provably read-only: a mutating (or unknown) custom flow
 *   is arbitrary tenant logic, so borrowed customer identities must never
 *   ride its inputs. Mint plans still apply (owned parents), and anything
 *   else fails honest; borrowing stays allowed only for provably
 *   read-only shapes. Mint plans still apply (owned parents). Two narrow
 *   legs still apply under opt-out: org-default setup rows
 *   (`IsDefault=true`) bind (setup metadata, never customer identity),
 *   and polymorphic fields yield a mint plan for the first mintable
 *   target (owned parent, platform-validated). Anything else fails honest.
 *
 * No org id, alias, username, object name, or URL appears here; every
 * tenant value is caller-supplied or read live.
 */

type Row = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** Cap: max reference targets probed per required field (polymorphic bounds). */
export const FIXTURE_REFERENCE_TARGET_CAP = 8;

export type FixtureReferenceSeed = {
  /** Field name -> borrowed live FK id (referenced rows are never written). */
  overrides: Record<string, string>;
  /** Required reference fields left unresolved (caller fails honest). */
  unresolved: string[];
  /**
   * Reference targets whose id lookup was access-denied (not merely
   * rowless): granting the execution identity read access unblocks the
   * seed on retry. Powers denial-driven self-provisioning.
   */
  readDenied: string[];
  /**
   * Single-target fields with no live row whose target is mintable. The
   * caller mints with its own marker/cleanup; `fields` is the live target
   * describe reused for marker selection (no second describe).
   */
  mintPlans: Array<{ field: string; objectName: string; fields: Row[] }>;
};

const record = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string =>
  typeof value === "string" && SF_ID.test(value);

/**
 * Required reference fields in `synthesizeRecordValues` terms: reference
 * type, createable, nillable=false, not defaulted/calculated/auto-number,
 * with at least the name validated. Targets are validated, deduped,
 * describe-ordered, and capped.
 */
export function requiredReferenceFields(fields: unknown): Array<{ name: string; targets: string[] }> {
  const list = Array.isArray(fields) ? fields.filter(record) : [];
  const out: Array<{ name: string; targets: string[] }> = [];
  for (const field of list) {
    if (typeof field.name !== "string" || !OBJECT_NAME.test(field.name)) continue;
    if (field.type !== "reference" || field.createable !== true) continue;
    if (field.nillable !== false || field.defaultedOnCreate === true ||
        field.calculated === true || field.autoNumber === true) continue;
    const targets: string[] = [];
    for (const name of Array.isArray(field.referenceTo) ? field.referenceTo : []) {
      if (typeof name !== "string" || !OBJECT_NAME.test(name)) continue;
      if (targets.includes(name)) continue;
      targets.push(name);
      if (targets.length >= FIXTURE_REFERENCE_TARGET_CAP) break;
    }
    if (targets.length === 0) continue;
    out.push({ name: field.name, targets });
  }
  return out;
}

/**
 * Nillable commercial-parent link: a createable `AccountId` reference
 * whose targets include Account (WebCart-style). Native commerce Apex
 * reads the linked account at invoke time, so fixtures on such objects
 * 400 FIELD_INTEGRITY_EXCEPTION (`Required field: Account ID`) without
 * one even though the platform leaves the field nillable. Name-only
 * platform vocabulary; the caller binds the value live (borrow, else
 * an owned mint) or refuses.
 */
export function commercialAccountLinkField(fields: unknown): { name: string } | null {
  const list = Array.isArray(fields) ? fields.filter(record) : [];
  const hit = list.find((field) =>
    field.name === "AccountId" && field.type === "reference" && field.createable === true &&
    Array.isArray(field.referenceTo) && (field.referenceTo as unknown[]).includes("Account"));
  return hit ? { name: "AccountId" } : null;
}

export type CommercialAccountLinkSeed =
  /** Borrowed live Account id (the referenced row is never written). */
  | { bound: string }
  /** No live row: the caller mints with its own marker/cleanup. */
  | { mint: { objectName: string; fields: Row[] } }
  /** Neither leg applies: the caller refuses honest. */
  | { unavailable: string };

/**
 * Bind a commercial Account link: first live Account id wins, else a
 * mint plan when Account is mintable. Pure read path: never creates,
 * updates, or deletes.
 */
export async function seedCommercialAccountLink(
  request: (path: string, method?: string, body?: any) => Promise<Result>,
  root: string,
): Promise<CommercialAccountLinkSeed> {
  if (typeof root !== "string" || !root.startsWith("/services/data/")) {
    return { unavailable: "A live API root is required." };
  }
  const lookup = await request(`${root}/query?q=${encodeURIComponent("SELECT Id FROM Account LIMIT 1")}`);
  const first = record(lookup.body) && Array.isArray(lookup.body.records)
    ? lookup.body.records.filter(record).find((row) => identity(row.Id)) : undefined;
  if (lookup.ok && first && identity(first.Id)) return { bound: first.Id };
  const described = await request(`${root}/sobjects/Account/describe`);
  const targetFields = record(described.body) && Array.isArray(described.body.fields)
    ? described.body.fields.filter(record) : null;
  if (described.ok && record(described.body) && described.body.createable === true &&
      described.body.queryable === true && described.body.deletable === true && targetFields) {
    return { mint: { objectName: "Account", fields: targetFields } };
  }
  return { unavailable: "No live Account row exists and the Account object cannot mint an owned parent." };
}

export type FixtureReferenceSeedOptions = {
  /**
   * When false, no customer row is read for binding: plain LIMIT 1
   * lookups are skipped, org-default setup rows (IsDefault=true) still
   * bind, single-target mintable fields yield mint plans, polymorphic
   * fields yield a mint plan for the first mintable target, and anything
   * else stays unresolved. Defaults to true (the owned-lifecycle
   * standard-action precedent: routing, email alerts, quick actions).
   * Flow probing passes false unless the flow is provably read-only, so
   * live customer identities never ride a mutating (or unknown) flow's
   * inputs; owned fixtures, setup defaults, or refusal only.
   */
  allowLiveBorrow?: boolean;
};

/**
 * Seed required reference values from live org discovery. One `LIMIT 1`
 * lookup per referenced object (deduped across fields sharing a target),
 * first live id wins per field; single-target rowless-but-mintable fields
 * yield mint plans. Pure read path: never creates, updates, or deletes.
 * With `allowLiveBorrow: false` the lookup leg is skipped entirely (no
 * live row is read for binding); only mint plans and unresolved fields
 * apply.
 */
export async function seedRequiredReferenceValues(
  request: (path: string, method?: string, body?: any) => Promise<Result>,
  root: string,
  fields: unknown,
  options?: FixtureReferenceSeedOptions,
): Promise<FixtureReferenceSeed> {
  const seed: FixtureReferenceSeed = { overrides: {}, unresolved: [], readDenied: [], mintPlans: [] };
  const borrow = options?.allowLiveBorrow !== false;
  const markDenied = (objectName: string, lookup: Result): void => {
    if (lookup.ok || seed.readDenied.includes(objectName)) return;
    // 403 is always a read denial; a 400 is one only with an access code
    // (a malformed default-filter on objects without IsDefault is not).
    if (lookup.status === 403) { seed.readDenied.push(objectName); return; }
    if (lookup.status !== 400) return;
    const items = Array.isArray(lookup.body) ? lookup.body : [lookup.body];
    const denied = items.some((item) => record(item) &&
      (item.errorCode === "INSUFFICIENT_ACCESS_OR_READONLY" || item.errorCode === "INSUFFICIENT_ACCESS"));
    if (denied) seed.readDenied.push(objectName);
  };
  const liveIds = new Map<string, string | null>();
  const liveId = async (objectName: string): Promise<string | null> => {
    if (!borrow) return null;
    if (liveIds.has(objectName)) return liveIds.get(objectName) ?? null;
    let found: string | null = null;
    const lookup = await request(`${root}/query?q=${encodeURIComponent(`SELECT Id FROM ${objectName} LIMIT 1`)}`);
    const first = record(lookup.body) && Array.isArray(lookup.body.records)
      ? lookup.body.records.filter(record).find((row) => identity(row.Id)) : undefined;
    if (lookup.ok && first && identity(first.Id)) found = first.Id;
    else markDenied(objectName, lookup);
    liveIds.set(objectName, found);
    return found;
  };
  const defaultIds = new Map<string, string | null>();
  const defaultId = async (objectName: string): Promise<string | null> => {
    if (borrow) return null;
    if (defaultIds.has(objectName)) return defaultIds.get(objectName) ?? null;
    let found: string | null = null;
    const lookup = await request(`${root}/query?q=${encodeURIComponent(`SELECT Id FROM ${objectName} WHERE IsDefault=true LIMIT 1`)}`);
    const first = record(lookup.body) && Array.isArray(lookup.body.records)
      ? lookup.body.records.filter(record).find((row) => identity(row.Id)) : undefined;
    if (lookup.ok && first && identity(first.Id)) found = first.Id;
    else markDenied(objectName, lookup);
    defaultIds.set(objectName, found);
    return found;
  };
  for (const field of requiredReferenceFields(fields)) {
    let bound: string | null = null;
    for (const target of field.targets) {
      const id = await liveId(target);
      if (id !== null) { bound = id; break; }
    }
    if (!borrow && bound === null) {
      for (const target of field.targets) {
        const id = await defaultId(target);
        if (id !== null) { bound = id; break; }
      }
    }
    if (bound !== null) {
      seed.overrides[field.name] = bound;
      continue;
    }
    // No live row in any target: under opt-out every target is a mint
    // candidate (first mintable wins); with borrow only single-target
    // fields yield mint plans; anything else stays unresolved (fail
    // honest downstream).
    const mintTargets = borrow ? (field.targets.length === 1 ? field.targets : []) : field.targets;
    for (const target of mintTargets) {
      const described = await request(`${root}/sobjects/${target}/describe`);
      const targetFields = record(described.body) && Array.isArray(described.body.fields)
        ? described.body.fields.filter(record) : null;
      if (described.ok && record(described.body) && described.body.createable === true &&
          described.body.queryable === true && described.body.deletable === true && targetFields) {
        seed.mintPlans.push({ field: field.name, objectName: target, fields: targetFields });
        break;
      }
    }
    if (mintTargets.length && seed.mintPlans.some((plan) => plan.field === field.name)) continue;
    seed.unresolved.push(field.name);
  }
  return seed;
}
