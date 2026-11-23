/**
 * Owned search-rule lifecycle context (`createSearchBoostBuryRule`).
 *
 * Root cause (blind-verified 2026-10-03 via `sf` CLI in BOTH orgs):
 * the live descriptor declares 9 required inputs (webStoreId + 8 rule
 * fields) with a `boostBuryRuleId` output, but every invocation fails
 * natively with "Specify a valid Store ID." for worker-created and
 * pre-existing stores alike, and the Commerce Search management
 * resource answers FUNCTIONALITY_NOT_ENABLED ("not currently enabled
 * for this user type or org: [CommerceSearch]") on both orgs. No
 * sObject backs the rule (no Boost/Bury object exists) and no
 * delete/update standard action exists, so readback and cleanup must
 * use the Connect `boost-bury-rules` collection. Rule-field vocabulary
 * (action/level/attribute) is undiscoverable while the feature is
 * disabled, so this module derives it ONLY from live rules read back
 * from an enabled org and never invents enum values.
 *
 * Honest lifecycle: describe the live store schema and descriptor,
 * create one owned marked store (trial over live picklist types; B2B
 * and B2C creation is refused on these orgs), probe the live rules
 * collection, return setup-blocked WITHOUT invoking when Commerce
 * Search is disabled, and otherwise invoke with declared inputs only,
 * verify the created rule by collection readback, delete the rule and
 * the store, and verify absence. No org id, alias, username, or URL
 * appears here; every tenant value is caller-supplied or read live.
 */
import { cleanupOwnedContext } from './owned-context-cleanup';
import { clampVerificationWindowMs } from './verification-window';

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const ACTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const id = (v: any): v is string => typeof v === 'string' && SF_ID.test(v);
const successful = (r: Result) =>
  r.ok && Array.isArray(r.body) && r.body.length === 1 && r.body[0]?.isSuccess === true && !r.body[0].errors?.length;

export const SEARCH_RULE_STORE_OBJECT = 'WebStore';
export const SEARCH_RULE_ACTIONS = ['createSearchBoostBuryRule'];
/** Family builder version: owned store + Connect readback lifecycle. */
export const SEARCH_RULE_LIFECYCLE_BUILDER_VERSION = 83;
/** Fixed setup requirement; no upstream or tenant values interpolated. */
export const SEARCH_RULE_REQUIRED_SETUP =
  'Enable Commerce Search for this org and store (create the Commerce Search index), then retry.';

/** Required live descriptor inputs, matched case-insensitively. */
const REQUIRED_INPUTS = [
  'webstoreid', 'boostburyrulename', 'boostburyruleaction', 'boostburyrulelevel',
  'boostburyruleattributenameorid', 'boostburyruleattributetype',
  'boostburyruleattributevalues', 'boostburyrulestartdate', 'boostburyruleenddate',
] as const;

const fail = (errorCode: string, message: string): Result => ({ status: 422, ok: false, body: { errorCode, message } });

/**
 * Parse a live search-rule route. Returns the action name, or null when
 * the route is not an in-scope standard search-rule action.
 */
export function searchRuleActionName(route: string): string | null {
  const match = typeof route === 'string'
    ? route.match(/^\/services\/data\/v\d+(?:\.\d+)?\/actions\/standard\/([A-Za-z][A-Za-z0-9_]{0,127})$/)
    : null;
  const name = match?.[1] ?? null;
  return name !== null && ACTION_NAME.test(name) && SEARCH_RULE_ACTIONS.some(a => a.toLowerCase() === name.toLowerCase()) ? name : null;
}

/** True when the action belongs to the owned search-rule lifecycle. */
export function isSearchRuleOwnedContextRoute(route: string, actionType?: string): boolean {
  if (searchRuleActionName(route) === null) return false;
  return actionType === undefined || actionType === 'standard';
}

export type SearchRuleInvocationInputs = {
  webStoreId: string; ruleName: string; ruleAction: string; ruleLevel: string;
  attributeNameOrId: string; attributeType: string; attributeValues: string;
  startDate: string; endDate: string; ruleIdOutput?: string;
};

/**
 * Resolve the 9 required inputs plus the rule-id output from the live
 * descriptor. Names match case-insensitively; no name is ever assumed.
 */
export function searchRuleInvocationInputs(descriptorInputs: unknown, descriptorOutputs: unknown):
  | { fields: SearchRuleInvocationInputs } | { failure: string } {
  const inputs = Array.isArray(descriptorInputs) ? descriptorInputs : [];
  const byLower = new Map<string, string>();
  for (const field of inputs) {
    if (field && typeof field === 'object' && typeof (field as Value).name === 'string' && FIELD_NAME.test((field as Value).name)) {
      byLower.set((field as Value).name.toLowerCase(), (field as Value).name);
    }
  }
  const missing = REQUIRED_INPUTS.filter(name => !byLower.has(name));
  if (missing.length || byLower.size !== inputs.filter(f => f && typeof f === 'object').length) {
    if (missing.length) return { failure: `The live search-rule descriptor does not declare required inputs: ${missing.join(', ')}.` };
    return { failure: 'The live search-rule descriptor exposes an invalid input name.' };
  }
  const get = (name: (typeof REQUIRED_INPUTS)[number]) => byLower.get(name)!;
  const outputs = Array.isArray(descriptorOutputs) ? descriptorOutputs : [];
  const ruleIdOutput = outputs.find(f => f && typeof f === 'object' && typeof (f as Value).name === 'string'
    && (f as Value).name.toLowerCase() === 'boostburyruleid') as Value | undefined;
  return {
    fields: {
      webStoreId: get('webstoreid'), ruleName: get('boostburyrulename'), ruleAction: get('boostburyruleaction'),
      ruleLevel: get('boostburyrulelevel'), attributeNameOrId: get('boostburyruleattributenameorid'),
      attributeType: get('boostburyruleattributetype'), attributeValues: get('boostburyruleattributevalues'),
      startDate: get('boostburyrulestartdate'), endDate: get('boostburyruleenddate'),
      ...(ruleIdOutput ? { ruleIdOutput: ruleIdOutput.name as string } : {}),
    },
  };
}

/** True when upstream reports the CommerceSearch feature gate. */
export function searchRuleFeatureDisabled(status: number, body: unknown): boolean {
  const texts: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4 || texts.length > 16) return;
    if (typeof node === 'string') { if (node) texts.push(node); return; }
    if (Array.isArray(node)) { for (const item of node.slice(0, 10)) visit(item, depth + 1); return; }
    if (node === null || typeof node !== 'object') return;
    for (const key of ['message', 'errorCode', 'statusCode']) {
      const entry = (node as Value)[key];
      if (typeof entry === 'string' && entry) texts.push(entry);
    }
  };
  visit(body, 0);
  void status;
  return texts.some(t => /FUNCTIONALITY_NOT_ENABLED/.test(t)) && texts.some(t => /CommerceSearch/.test(t));
}

type RuleVocabulary = { action: string; level: number; attributeNameOrId: string; attributeType: string; attributeValues: string };

/**
 * Derive rule-field vocabulary ONLY from live rules read back from the
 * org. Returns null when no live rule carries a complete set, so the
 * caller fails explicitly instead of inventing enum values.
 */
export function searchRuleVocabularyFromLiveRules(body: unknown): RuleVocabulary | null {
  const list = Array.isArray(body) ? body : (body !== null && typeof body === 'object' && Array.isArray((body as Value).rules) ? (body as Value).rules : null);
  if (!Array.isArray(list)) return null;
  for (const rule of list.slice(0, 25)) {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) continue;
    const lower: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rule as Value)) lower[String(key).toLowerCase()] = value;
    const pick = (...names: string[]): string | undefined => {
      for (const name of names) {
        const value = lower[name];
        if (typeof value === 'string' && value) return value;
      }
      return undefined;
    };
    const levelRaw = lower['boostburylevel'] ?? lower['level'];
    const candidate = {
      action: pick('boostburyruleaction', 'action'),
      level: typeof levelRaw === 'number' && Number.isInteger(levelRaw) ? levelRaw : undefined,
      attributeNameOrId: pick('boostburyruleattributenameorid', 'attributenameorid', 'attributename'),
      attributeType: pick('boostburyruleattributetype', 'attributetype'),
      attributeValues: pick('boostburyruleattributevalues', 'attributevalues'),
    };
    if (candidate.action && candidate.level !== undefined && candidate.attributeNameOrId && candidate.attributeType && candidate.attributeValues) {
      return candidate as RuleVocabulary;
    }
  }
  return null;
}

/** True when the live rules collection contains the owned rule. */
function collectionContainsRule(body: unknown, ruleId: string, marker: string): boolean {
  const list = Array.isArray(body) ? body : (body !== null && typeof body === 'object' && Array.isArray((body as Value).rules) ? (body as Value).rules : []);
  return (list as Value[]).some(rule => rule !== null && typeof rule === 'object' && !Array.isArray(rule) &&
    Object.values(rule).some(value => value === ruleId) &&
    Object.values(rule).some(value => value === marker));
}

/** Search boost/bury rule creation operates only on an owned marked store. */
export async function invokeSearchBoostBuryRuleWithContext(input: {
  root: string; route: string; verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
}): Promise<{ status: number; body: any; cleanupError?: string; contextSchema?: Value }> {
  const { root, request } = input;
  const action = searchRuleActionName(input.route);
  if (!action) return fail('SEARCH_RULE_ACTION_INVALID', 'A supported discovered search-rule route is required.');
  const storeSchema = await request(root + '/sobjects/' + SEARCH_RULE_STORE_OBJECT + '/describe');
  if (!storeSchema.ok) return storeSchema;
  if (!storeSchema.body?.queryable || !storeSchema.body?.deletable || !storeSchema.body?.createable || !Array.isArray(storeSchema.body?.fields)) {
    return fail('SEARCH_RULE_CONTEXT_PERMISSIONS_REQUIRED', 'Live owned search-rule fixtures require store create, query, and cleanup access.');
  }
  const descriptor = await request(root + '/actions/standard/' + action);
  if (!descriptor.ok) return descriptor;
  const resolved = searchRuleInvocationInputs(descriptor.body?.inputs, descriptor.body?.outputs);
  if ('failure' in resolved) return fail('SEARCH_RULE_ACTION_SCHEMA_UNAVAILABLE', resolved.failure);
  const fields = resolved.fields;
  const nameField = storeSchema.body.fields.find((f: Value) => f.name === 'Name');
  if (!nameField?.createable || !nameField?.filterable || !(typeof nameField.length === 'number' && nameField.length >= 48)) {
    return fail('SEARCH_RULE_MARKER_UNAVAILABLE', 'Owned store fixtures require a writable, queryable Name marker.');
  }
  const types = storeSchema.body.fields
    .find((f: Value) => f.name === 'Type' && f.createable)?.picklistValues
    ?.filter((p: Value) => p.active && typeof p.value === 'string').map((p: Value) => p.value) ?? [];
  if (!types.length) return fail('SEARCH_RULE_TYPE_UNAVAILABLE', 'Live store types are required.');
  let last = fail('SEARCH_RULE_CONTEXT_UNAVAILABLE', 'No live store type supported search-rule verification.');
  for (const type of types) {
    const marker = 'AS searchrule ' + crypto.randomUUID();
    const owned: Array<{ objectName: string; id: string }> = [];
    let storeId: string | undefined, ruleId: string | undefined;
    let verified = false, cleanupError: string | undefined, attemptedStore = false;
    let nativeEvidence: Value | undefined, setupBlocked = false;
    const rulesPath = () => root + '/commerce/management/webstores/' + storeId + '/search/boost-bury-rules';
    const findStore = async () => {
      const result = await request(root + '/query?q=' + encodeURIComponent(`SELECT Id,Name FROM WebStore WHERE Name='${marker}' LIMIT 3`));
      if (!result.ok || !Array.isArray(result.body?.records) || result.body.records.length >= 3) throw Error('Owned search-rule store discovery could not be verified.');
      for (const row of result.body.records) {
        if (!id(row.Id) || row.Name !== marker) throw Error('Owned search-rule store marker mismatch.');
        if (!owned.some(v => v.id === row.Id)) owned.push({ objectName: 'WebStore', id: row.Id });
      }
    };
    let outcome: Result = last;
    try {
      outcome = await (async () => {
        const store = await input.build('WebStore', marker, { Name: marker, Type: type });
        if ('failure' in store) return store.failure;
        attemptedStore = true;
        const createdStore = await request(root + '/sobjects/WebStore', 'POST', store.values);
        if (!createdStore.ok || !id(createdStore.body?.id)) return createdStore;
        storeId = createdStore.body.id;
        owned.push({ objectName: 'WebStore', id: storeId! });
        const storeRead = await request(root + '/sobjects/WebStore/' + storeId);
        if (!storeRead.ok || storeRead.body?.Name !== marker || storeRead.body?.Type !== type) {
          return fail('SEARCH_RULE_STORE_UNVERIFIED', 'Actual owned store readback failed.');
        }
        const rules = await request(rulesPath());
        nativeEvidence = {
          rulesStatus: rules.status, rulesBodyKind: rules.body === null ? 'null' : Array.isArray(rules.body) ? 'array' : typeof rules.body,
          featureDisabled: searchRuleFeatureDisabled(rules.status, rules.body),
        };
        if (searchRuleFeatureDisabled(rules.status, rules.body)) {
          setupBlocked = true;
          return {
            status: 422, ok: false,
            body: {
              errorCode: 'SEARCH_RULE_SETUP_REQUIRED', message: SEARCH_RULE_REQUIRED_SETUP,
              requirement: SEARCH_RULE_REQUIRED_SETUP, nativeEvidence,
            },
          };
        }
        if (!rules.ok) return rules;
        const vocabulary = searchRuleVocabularyFromLiveRules(rules.body);
        if (!vocabulary) return fail('SEARCH_RULE_VOCABULARY_UNAVAILABLE', 'No live boost/bury rule carries a complete rule-field vocabulary; enum values are never invented.');
        const start = new Date(Date.now() + 3_600_000).toISOString();
        const end = new Date(Date.now() + 7 * 86_400_000).toISOString();
        const created = await request(input.route, 'POST', {
          inputs: [{
            [fields.webStoreId]: storeId, [fields.ruleName]: marker, [fields.ruleAction]: vocabulary.action,
            [fields.ruleLevel]: vocabulary.level, [fields.attributeNameOrId]: vocabulary.attributeNameOrId,
            [fields.attributeType]: vocabulary.attributeType, [fields.attributeValues]: vocabulary.attributeValues,
            [fields.startDate]: start, [fields.endDate]: end,
          }],
        });
        nativeEvidence = {
          ...nativeEvidence, status: created.status,
          bodyKind: created.body === null ? 'null' : Array.isArray(created.body) ? 'array' : typeof created.body,
          outcomeCount: Array.isArray(created.body) ? created.body.length : null,
          successFlags: Array.isArray(created.body) ? created.body.map((v: Value) => v?.isSuccess === true) : [],
        };
        if (created.ok && (created.body === null || Array.isArray(created.body) && created.body.length === 0)) {
          return fail('SEARCH_RULE_ACTION_OUTCOME_MISSING', 'Salesforce returned no native rule outcome for the owned store; no mutation is counted as successful.');
        }
        if (!successful(created)) return created;
        const output = created.body[0].outputValues;
        const declared = fields.ruleIdOutput !== undefined ? output?.[fields.ruleIdOutput] : undefined;
        const discovered = typeof declared === 'string' && declared
          ? declared
          : (output && typeof output === 'object' ? Object.values(output).find(v => typeof v === 'string' && v) as string | undefined : undefined);
        if (!discovered) return fail('SEARCH_RULE_RULE_UNVERIFIED', 'Native rule creation returned no rule identifier for the owned store.');
        ruleId = discovered;
        const readback = await request(rulesPath());
        if (!readback.ok || !collectionContainsRule(readback.body, ruleId, marker)) {
          return fail('SEARCH_RULE_RULE_UNVERIFIED', 'The owned rule could not be read back from the live rules collection.');
        }
        verified = true;
        if (input.verificationWindowMs) await new Promise(resolve => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
        return created;
      })();
    } catch { outcome = fail('SEARCH_RULE_LIFECYCLE_UNVERIFIED', 'The owned search-rule lifecycle could not be verified.'); }
    finally {
      try {
        if (attemptedStore) await findStore();
        if (ruleId && storeId) {
          const removed = await request(rulesPath() + '/' + ruleId, 'DELETE');
          if (!removed.ok) {
            cleanupError = 'Owned search-rule cleanup failed: the live rule could not be deleted.';
          } else {
            const reread = await request(rulesPath());
            if (!reread.ok || collectionContainsRule(reread.body, ruleId, marker)) {
              cleanupError = 'Owned search-rule cleanup could not be independently read back.';
            }
          }
        }
      } catch { cleanupError = 'Owned search-rule cleanup could not be independently read back.'; }
      const cleaned = await cleanupOwnedContext({
        root, request, records: owned, order: ['WebStore'],
        scopes: [{ objectName: 'WebStore', equals: { Name: marker } }],
      });
      cleanupError ??= cleaned.cleanupError;
      owned.splice(0, owned.length, ...cleaned.ownedRecords);
    }
    const result = {
      status: outcome.status, body: outcome.body, cleanupError,
      contextSchema: {
        source: 'salesforce_live_native_search_rule_action', objects: [storeSchema.body], descriptor: descriptor.body,
        marker, storeType: type, storeId, ruleId, ownedRecords: owned, verified, nativeEvidence, setupBlocked,
        ...(setupBlocked ? { requiredSetup: SEARCH_RULE_REQUIRED_SETUP } : {}),
        verificationRecordIds: ruleId ? [ruleId] : [],
        automaticSteps: ['Read live native descriptor and owned store schema', 'Create and read back an owned marked store',
          'Probe the live boost/bury rules collection for the CommerceSearch gate',
          'Invoke native createSearchBoostBuryRule with declared inputs only and verify the rule by collection readback',
          'Delete the owned rule and store and independently verify absence'],
      },
    };
    if (verified || cleanupError || setupBlocked) return result;
    last = outcome;
    // CARTREGRESS: fall through store types on client validation refusals
    // (HTTP 400 from the store mint OR the native call — e.g. B2C refuses
    // plain buyers while B2CE converts). Per-attempt cleanup already ran
    // in `finally`. Return immediately only on verified/cleanupError/non-400.
    if (outcome.status !== 400) return result;
  }
  return { status: last.status, body: last.body };
}
