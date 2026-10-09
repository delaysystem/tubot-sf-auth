import { classifyManagedFlowFault, type ManagedFlowFault } from './managed-flow-faults';
import { cleanupOwnedContext, type OwnedRecord, type OwnershipScope } from './owned-context-cleanup';
import { collectRestOutcomeSignal, denialGrantForRestOutcome, type DenialGrant } from './permission-denial-grants';
import { resolveRequiredInputValue, type TargetField } from './skipped-standards-context';

/**
 * Family builder version (first worker-owned version; set above every
 * in-tree family version so stale searcher rows reselect): 126 seeds the
 * owned parent/context-fixture required references (Case.BusinessHoursId,
 * FeedItem.ParentId) from live lookups so Case/FeedItem quick actions
 * re-probe past OWNED_CONTEXT_REQUIRED_REFERENCE_UNRESOLVED. 127 re-audits
 * quick actions after cleanup-time owner reclaim (drifted fixtures delete).
 * 128 re-audits with Person-Account-aware markers (self-compound Name kept
 * and preferred; LastName members never picked).
 */
export const QUICK_ACTION_BUILDER_VERSION = 128;
type Row = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const record = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(value);
const literal = (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

/**
 * Seeds required reference fields with live foreign keys (SELECT Id LIMIT 1
 * per referenced object). Referenced rows are never written; they only satisfy
 * platform foreign-key checks for owned records (MessagingChannel/EndUser for
 * an owned MessagingSession). Returns an empty map without any query when the
 * target has no required reference fields.
 */
export async function seedLiveReferenceCache(request: (path: string, method?: string, body?: any) => Promise<Result>, root: string, fields: Row[]): Promise<Map<string, string | null>> {
  const cache = new Map<string, string | null>();
  const names = new Set<string>();
  for (const field of Array.isArray(fields) ? fields : []) {
    if (!record(field) || typeof field.name !== 'string') continue;
    if (field.type !== 'reference' || field.createable !== true) continue;
    if (field.nillable !== false || field.defaultedOnCreate === true || field.calculated === true || field.autoNumber === true) continue;
    for (const name of Array.isArray(field.referenceTo) ? field.referenceTo : []) {
      if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name)) names.add(name);
    }
  }
  for (const name of names) {
    const lookup = await request(`${root}/query?q=${encodeURIComponent(`SELECT Id FROM ${name} LIMIT 1`)}`);
    const first = record(lookup.body) && Array.isArray(lookup.body.records) ? lookup.body.records.find(record) : undefined;
    if (lookup.ok && identity(first?.Id)) cache.set(name, first.Id);
  }
  return cache;
}

/**
 * Terminal learning for 404 quick-action routes (R5 route lane, Round-4
 * sweep: 22 POST-404s after 200 describes).
 * - 'describe': the definition or descriptor read 404s, so the route is
 *   not in the live catalog — mistyped or removed. Terminal with
 *   dropRoute learning: the planner drops the route, never retries it.
 * - 'invoke': the POST 404s after a 200 descriptor read, so metadata
 *   exists but no executable does — dead route (prechat and standard
 *   publisher shapes). Terminal with deadRoute learning: the planner
 *   stops re-probing the route without dropping the catalog row.
 * Callers must only pass 'invoke' after a 200 descriptor read (the auth
 * dispatcher does); otherwise a mistyped route mislearns as dead.
 * Returns null for non-404 outcomes so every other status keeps its
 * verdict untouched.
 */
export function quickActionRouteTerminal(
  outcome: { status: number }, observed: 'describe' | 'invoke',
): { status: number; body: Record<string, unknown> } | null {
  if (!outcome || outcome.status !== 404) return null;
  return observed === 'describe'
    ? { status: 404, body: { errorCode: 'QUICK_ACTION_ROUTE_UNKNOWN',
        message: 'The live quick-action catalog exposes no such route; the route is mistyped or was removed.',
        dropRoute: true, retryable: false } }
    : { status: 404, body: { errorCode: 'QUICK_ACTION_ROUTE_DEAD',
        message: 'The live action metadata exists but the invoke route has no executable; the route is dead.',
        deadRoute: true, retryable: false } };
}

/**
 * Planner-only enrichment for a failed quick-action outcome: the grant
 * catalog maps REST denials, and the fault taxonomy maps the field
 * branch only (no flow shape is ever reclassified here). Successes and
 * non-denial failures attach nothing. Nothing is ever applied.
 */
export function quickActionFailurePlanners(outcome: { status: number; body: unknown }): {
  denialGrant?: DenialGrant; managedFlowFault?: ManagedFlowFault;
} {
  const planners: { denialGrant?: DenialGrant; managedFlowFault?: ManagedFlowFault } = {};
  const grant = denialGrantForRestOutcome(outcome.status, outcome.body);
  if (grant) planners.denialGrant = grant;
  const signal = collectRestOutcomeSignal(outcome.body);
  const fault = signal.messages.length || signal.codes.length
    ? classifyManagedFlowFault({ status: outcome.status, messages: signal.messages, codes: signal.codes })
    : null;
  if (fault && fault.code === 'FIELD_ACCESS_REQUIRED') planners.managedFlowFault = fault;
  return planners;
}

/** Every create is enclosed by marker recovery and fresh ownership-proof cleanup. */
export async function invokeOwnedQuickAction(input: {
  root: string; route: string; target: string; markerField: string; marker: string;
  global: boolean; fields: Row[]; inputs: Row[]; values?: Row;
  /** Live integration-user id; the only verified identity OwnerId may resolve to. */
  integrationUserId?: string;
  buildTarget?: (overrides: Row) => Promise<{ values: Row } | { failure: { status: number; body: any } }>;
  parent?: { objectName: string; field: string; markerField: string; marker: string; values: Row };
  /**
   * Owned context-record fixture (e.g. a FeedItem post on an owned Account)
   * for Create actions whose context object is not the target's parent.
   * contextId is the fixture id; the target is verified by its own marker.
   */
  contextFixture?: { objectName: string; values: Row; parentField?: string; markerField?: string; marker?: string };
  verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
}) {
  const { root, target, markerField, marker, request } = input;
  const allowed = new Set(input.inputs.map(field => String(field.name)));
  const args: Row = {};
  const targetLinkedToParent = !!input.parent && !input.contextFixture;
  const scopes: OwnershipScope[] = [{ objectName: target, equals: { [markerField]: marker }, ...(targetLinkedToParent ? { ownedParents: [{ field: input.parent!.field, objectName: input.parent!.objectName }] } : {}) }];
  if (input.parent) scopes.push({ objectName: input.parent.objectName, equals: { [input.parent.markerField]: input.parent.marker } });
  const candidates: OwnedRecord[] = [];
  const parentCandidates = new Set<string>();
  const expectedChanges: Row = {};
  let parentId: string | undefined, contextId: string | undefined, contextFixtureId: string | undefined;
  let createFailure: Result | undefined;
  let verified = false, recoveryError: string | undefined, cleanupError: string | undefined;
  const verifiedIds: string[] = [];
  let outcome: Result = { status: 422, ok: false, body: { errorCode: 'QUICK_ACTION_CONTEXT_UNVERIFIED', message: 'The owned Quick Action context could not be verified.' } };
  const recover = async (scope: OwnershipScope): Promise<OwnedRecord[]> => {
    // Recover every unique-marker write, including writes with the wrong parent.
    // Relationship checks belong to ownership proof, never candidate discovery.
    const clause = Object.entries(scope.equals).filter(([field]) => !(scope.ownedParents ?? []).some(parent => parent.field === field)).map(([field, value]) => `${field} = ${literal(String(value))}`).join(' AND ');
    const response = await request(`${root}/query?q=${encodeURIComponent(`SELECT Id FROM ${scope.objectName} WHERE ${clause} LIMIT 33`)}`);
    if (!response.ok || !record(response.body) || !Array.isArray(response.body.records) || response.body.records.length > 32 || response.body.done === false || response.body.records.some((row: any) => !identity(row?.Id))) {
      recoveryError = 'Quick Action owned marker recovery was incomplete; unresolved writes require investigation.';
      return [];
    }
    return response.body.records.map((row: Row) => ({ objectName: scope.objectName, id: row.Id }));
  };
  const errorTexts = (body: unknown, depth = 0): string[] => {
    if (depth > 3 || body === null || body === undefined) return [];
    if (typeof body === 'string') return body.length > 0 && body.length < 2000 ? [body] : [];
    if (Array.isArray(body)) return body.flatMap(item => errorTexts(item, depth + 1));
    if (record(body)) return Object.entries(body).flatMap(([key, child]) =>
      ['message', 'errorMessage', 'error_description', 'errors', 'error', 'details'].includes(key) ? errorTexts(child, depth + 1) : []);
    return [];
  };
  /** One enriched retry: triggers may require nullable references the
   * describe marks optional (MessagingSession ConversationId). Field labels
   * named in the native error resolve to live foreign keys; referenced rows
   * are never written. Returns the retry response, or null to keep the
   * original failure. */
  const retryWithNamedReferences = async (objectName: string, values: Row, body: unknown): Promise<Result | null> => {
    const text = errorTexts(body).join(' ').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (text.length < 6) return null;
    const schema = await request(`${root}/sobjects/${objectName}/describe`);
    if (!schema.ok || !record(schema.body) || !Array.isArray(schema.body.fields)) return null;
    const enriched = { ...values };
    let added = 0;
    for (const field of schema.body.fields.filter(record)) {
      if (typeof field.name !== 'string' || field.type !== 'reference' || field.createable !== true) continue;
      if (Object.hasOwn(enriched, field.name)) continue;
      const keys = [field.name, typeof field.label === 'string' ? field.label : '']
        .map(key => key.toLowerCase().replace(/[^a-z0-9]+/g, '')).filter(key => key.length >= 6);
      if (!keys.some(key => text.includes(key))) continue;
      const targets = (Array.isArray(field.referenceTo) ? field.referenceTo : []).filter((name): name is string =>
        typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name));
      for (const name of targets) {
        const lookup = await request(`${root}/query?q=${encodeURIComponent(`SELECT Id FROM ${name} LIMIT 1`)}`);
        const first = record(lookup.body) && Array.isArray(lookup.body.records) ? lookup.body.records.find(record) : undefined;
        if (lookup.ok && identity(first?.Id)) { enriched[field.name] = first.Id; added++; break; }
      }
    }
    if (!added) return null;
    return request(`${root}/sobjects/${objectName}`, 'POST', enriched);
  };
  const createContext = async (objectName: string, values: Row, scope: OwnershipScope): Promise<{ id: string; actual: Row } | undefined> => {
    let response = await request(`${root}/sobjects/${objectName}`, 'POST', values);
    if (!response.ok && response.status >= 400 && response.status < 500) {
      const retry = await retryWithNamedReferences(objectName, values, response.body).catch(() => null);
      if (retry) response = retry;
    }
    if (!response.ok || !identity(response.body?.id)) createFailure = response;
    if (identity(response.body?.id)) candidates.push({ objectName, id: response.body.id });
    const recovered = await recover(scope);
    candidates.push(...recovered);
    if (!response.ok || !identity(response.body?.id) || recovered.length !== 1 || recovered[0].id !== response.body.id) return;
    const read = await request(`${root}/sobjects/${objectName}/${response.body.id}`);
    if (!read.ok || !record(read.body) || read.body.Id !== response.body.id || Object.entries(scope.equals).some(([field, value]) => read.body[field] !== value)) return;
    return { id: response.body.id, actual: read.body };
  };
  const adoptCreateFailure = () => { if (createFailure) outcome = { status: createFailure.status, ok: false, body: createFailure.body }; };
  try {
    if (input.parent) {
      const parent = await createContext(input.parent.objectName, input.parent.values, scopes[1]);
      if (!parent) { adoptCreateFailure(); throw { ownedContextUnavailable: true }; }
      parentId = parent.id;
      if (!input.contextFixture) scopes[0].equals[input.parent.field] = parentId;
    }
    if (input.contextFixture) {
      // The context record (e.g. FeedItem) is a sibling fixture, not the
      // target's parent: link it to the owned parent, then address the action
      // at it. The target keeps only its own marker for verification.
      const fixture = input.contextFixture;
      const fixtureValues = { ...fixture.values };
      if (fixture.parentField) {
        if (!parentId) throw { ownedContextUnavailable: true };
        fixtureValues[fixture.parentField] = parentId;
      }
      const fixtureScope: OwnershipScope = fixture.markerField && fixture.marker !== undefined
        ? { objectName: fixture.objectName, equals: { [fixture.markerField]: fixture.marker } }
        : fixture.parentField && parentId
          ? { objectName: fixture.objectName, equals: { [fixture.parentField]: parentId } }
          : { objectName: fixture.objectName, equals: {} };
      if (!Object.keys(fixtureScope.equals).length) throw { ownedContextUnavailable: true };
      scopes.push(fixtureScope);
      const created = await createContext(fixture.objectName, fixtureValues, fixtureScope);
      if (!created) { adoptCreateFailure(); throw { ownedContextUnavailable: true }; }
      contextFixtureId = created.id;
      args.contextId = contextFixtureId;
    }
    // Build required target references only after their owned dependencies have
    // passed target readback. Never invent an Id or borrow a tenant record.
    const overrides = { [markerField]: marker, ...(targetLinkedToParent ? { [input.parent!.field]: parentId } : {}) };
    const built = input.buildTarget ? await input.buildTarget(overrides) : { values: { ...input.values, ...overrides } };
    if ('failure' in built) { outcome = { ...built.failure, ok: false }; throw { ownedContextUnavailable: true }; }
    Object.assign(args, Object.fromEntries(Object.entries(built.values).filter(([name]) => allowed.has(name))));
    if (input.contextFixture) {
      if (!contextFixtureId) throw { ownedContextUnavailable: true };
      args.contextId = contextFixtureId;
    } else if (input.parent) {
      args.contextId = parentId;
      if (allowed.has(input.parent.field)) args[input.parent.field] = parentId;
    } else if (!input.global) {
      const context = await createContext(target, built.values, scopes[0]);
      if (!context) { adoptCreateFailure(); throw { ownedContextUnavailable: true }; }
      contextId = context.id;
      args.contextId = contextId;
      for (const field of input.fields) {
        if (typeof field.name !== 'string' || !allowed.has(field.name) || field.name === markerField || field.updateable !== true) continue;
        let value: unknown;
        if (['string', 'textarea', 'combobox'].includes(String(field.type))) value = `${marker} updated`.slice(0, typeof field.length === 'number' ? field.length : 80);
        else if (field.type === 'boolean') value = context.actual[field.name] !== true;
        else if (field.type === 'picklist' && Array.isArray(field.picklistValues)) value = field.picklistValues.find((item: any) => item.active === true && item.value !== context.actual[field.name])?.value;
        else if (field.type === 'date') value = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
        if (value !== undefined) args[field.name] = expectedChanges[field.name] = value;
      }
    }
    for (const field of input.inputs) {
      if (field.required !== true || typeof field.name !== 'string' || Object.hasOwn(args, field.name)) continue;
      const schema = input.fields.find(item => item.name === field.name);
      if (schema?.type === 'picklist' && Array.isArray(schema.picklistValues)) {
        const choice = schema.picklistValues.find((item: any) => item.active === true && typeof item.value === 'string');
        if (choice) args[field.name] = choice.value;
      }
      if (!Object.hasOwn(args, field.name)) {
        // Event/task-style required inputs resolve from the live target schema
        // (picklist, boolean, date/datetime, numeric, short text). Reference
        // inputs stay unresolved: they need an owned dependency, never a guess.
        const resolved = resolveRequiredInputValue(
          { name: field.name, type: typeof field.type === 'string' ? field.type : null, required: true },
          input.fields as TargetField[]);
        if (resolved !== undefined) args[field.name] = resolved;
      }
      if (!Object.hasOwn(args, field.name) && String(field.name).toLowerCase() === 'ownerid' && identity(input.integrationUserId)) {
        // OwnerId is the platform default owner: the live integration user is a
        // verified identity, never a guessed record.
        args[field.name] = input.integrationUserId;
      }
      if (!Object.hasOwn(args, field.name)) {
        outcome = { status: 422, ok: false, body: { errorCode: 'QUICK_ACTION_REQUIRED_INPUT_UNRESOLVED', message: 'A required live action input has no verified scoped value or owned dependency.' } };
        throw { ownedContextUnavailable: true };
      }
    }
    if (allowed.has('StartDateTime') && allowed.has('EndDateTime')) {
      args.StartDateTime = new Date(Date.now() + 60_000).toISOString();
      args.EndDateTime = new Date(Date.now() + 3_660_000).toISOString();
    }
    outcome = await request(input.route, 'POST', { inputs: [args] });
    const found = await recover(scopes[0]);
    candidates.push(...found);
    verified = found.length === 1 && (!contextId || found[0].id === contextId);
    for (const candidate of found) {
      const read = await request(`${root}/sobjects/${target}/${candidate.id}`);
      const owned = read.ok && record(read.body) && read.body.Id === candidate.id && Object.entries(scopes[0].equals).every(([field, value]) => read.body[field] === value);
      if (!owned) { verified = false; continue; }
      verifiedIds.push(candidate.id);
      if (contextId && (!Object.keys(expectedChanges).length || Object.entries(expectedChanges).some(([field, value]) => read.body[field] !== value))) verified = false;
    }
    if (input.verificationWindowMs && verifiedIds.length) await new Promise(resolve => setTimeout(resolve, input.verificationWindowMs));
  } catch (error) {
    if (!record(error) || error.ownedContextUnavailable !== true) outcome = { status: 502, ok: false, body: { errorCode: 'QUICK_ACTION_EXECUTION_UNAVAILABLE', message: 'Quick Action execution failed; owned markers will still be recovered and cleaned.' } };
  } finally {
    await cleanup();
  }
  return result();

  async function cleanup() {
    for (const scope of scopes) {
      try {
        const recovered = await recover(scope);
        if (scope === scopes[1]) recovered.forEach(item => parentCandidates.add(item.id));
        candidates.push(...recovered);
      }
      catch { recoveryError = 'Quick Action owned marker recovery failed; unresolved writes require investigation.'; }
    }
    // Child-first candidate order also supports a parent and child sharing one object type.
    const ordered = [...candidates.filter(item => !parentCandidates.has(item.id)), ...candidates.filter(item => parentCandidates.has(item.id))];
    const cleaned = await cleanupOwnedContext({ root, records: ordered, scopes, order: [...new Set([target, ...(input.contextFixture ? [input.contextFixture.objectName] : []), ...(input.parent ? [input.parent.objectName] : [])])], request });
    cleanupError = [recoveryError, cleaned.cleanupError].filter(Boolean).join(' ') || undefined;
  }
  function result() {
    const terminal = quickActionRouteTerminal(outcome, 'invoke');
    const final = terminal ?? (outcome.ok && !verified ? { status: 422, body: { errorCode: 'QUICK_ACTION_MUTATION_UNVERIFIED', message: 'Salesforce returned an outcome but its actual mutation could not be independently verified.' } } : outcome);
    const planners = terminal ? {} : quickActionFailurePlanners(final);
    const contextSchema = { source: 'salesforce_live_quick_action_definition', targetObject: target, mutationKind: input.global || input.parent ? 'create' : 'update', changedFields: Object.keys(expectedChanges), ...(!input.global && !input.parent ? { expectedChanges } : {}), ...(parentId ? { parentContextRecordId: parentId, parentContextObject: input.parent!.objectName, parentField: input.parent!.field } : {}), ...(contextFixtureId ? { contextFixtureRecordId: contextFixtureId, contextFixtureObject: input.contextFixture!.objectName } : {}), markerField, verificationRecordIds: verifiedIds, verified, automaticSteps: ['Describe live action context', 'Build writable fields from live schema', 'Invoke with unique ownership markers', 'Read back actual mutations', 'Recover owned writes and prove ownership before deletion', 'Verify cleanup absence'], ...planners };
    return { ...final, contextSchema, ...planners, ...(cleanupError ? { cleanupError } : {}) };
  }
}
