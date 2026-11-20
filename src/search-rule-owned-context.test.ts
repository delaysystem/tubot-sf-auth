import { expect, test } from 'bun:test';
import {
  SEARCH_RULE_LIFECYCLE_BUILDER_VERSION,
  invokeSearchBoostBuryRuleWithContext,
  isSearchRuleOwnedContextRoute,
  searchRuleActionName,
  searchRuleFeatureDisabled,
  searchRuleInvocationInputs,
  searchRuleVocabularyFromLiveRules,
} from './search-rule-owned-context';

test('builder version forces a re-probe of already-skipped rows', () => {
  expect(SEARCH_RULE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(81);
});

test('route matching is scoped to the standard search-rule action', () => {
  expect(searchRuleActionName('/services/data/v67.0/actions/standard/createSearchBoostBuryRule')).toBe('createSearchBoostBuryRule');
  expect(searchRuleActionName('/services/data/v67.0/actions/standard/createRecord')).toBeNull();
  expect(isSearchRuleOwnedContextRoute('/services/data/v67.0/actions/standard/createSearchBoostBuryRule', 'standard')).toBe(true);
  expect(isSearchRuleOwnedContextRoute('/services/data/v67.0/actions/standard/createSearchBoostBuryRule', 'custom')).toBe(false);
});

test('descriptor resolution requires all 9 live inputs and finds the rule-id output', () => {
  const names = ['webStoreId', 'boostBuryRuleName', 'boostBuryRuleAction', 'boostBuryRuleLevel', 'boostBuryRuleAttributeNameOrId',
    'boostBuryRuleAttributeType', 'boostBuryRuleAttributeValues', 'boostBuryRuleStartDate', 'boostBuryRuleEndDate'];
  const resolved = searchRuleInvocationInputs(names.map(name => ({ name })), [{ name: 'boostBuryRuleId' }]);
  expect('fields' in resolved && (resolved as { fields: { ruleIdOutput?: string } }).fields.ruleIdOutput).toBe('boostBuryRuleId');
  expect('failure' in searchRuleInvocationInputs(names.slice(0, 8).map(name => ({ name })), [])).toBe(true);
  expect('failure' in searchRuleInvocationInputs([{ name: 'not a field!' }], [])).toBe(true);
});

test('feature gate matches only explicit CommerceSearch disablement', () => {
  expect(searchRuleFeatureDisabled(403, [{ errorCode: 'FUNCTIONALITY_NOT_ENABLED', message: 'not enabled for this org: [CommerceSearch]' }])).toBe(true);
  expect(searchRuleFeatureDisabled(403, [{ errorCode: 'FUNCTIONALITY_NOT_ENABLED', message: 'some other feature' }])).toBe(false);
  expect(searchRuleFeatureDisabled(200, [])).toBe(false);
});

test('vocabulary derives only from complete live rules', () => {
  const live = { action: 'Boost', level: 1, attributeNameOrId: 'Color', attributeType: 'Product', attributeValues: 'Red' };
  expect(searchRuleVocabularyFromLiveRules([live])?.attributeType).toBe('Product');
  expect(searchRuleVocabularyFromLiveRules([{ action: 'Boost' }])).toBeNull();
  expect(searchRuleVocabularyFromLiveRules([])).toBeNull();
  expect(searchRuleVocabularyFromLiveRules({ rules: [live] })?.level).toBe(1);
});

const STORE_ID = '0ZE000000000001AAA';
const INPUT_NAMES = ['webStoreId', 'boostBuryRuleName', 'boostBuryRuleAction', 'boostBuryRuleLevel', 'boostBuryRuleAttributeNameOrId',
  'boostBuryRuleAttributeType', 'boostBuryRuleAttributeValues', 'boostBuryRuleStartDate', 'boostBuryRuleEndDate'];

async function run(mode = 'normal') {
  const rows = new Map<string, any>();
  const rules: any[] = [{ id: 'live-rule-1', name: 'Existing rule', action: 'Boost', level: 2,
    attributeNameOrId: 'Color', attributeType: 'Product', attributeValues: 'Red' }];
  const calls: Array<{ path: string; method: string; body: any }> = [];
  const ok = (body: any, status = 200) => ({ status, ok: status >= 200 && status < 300, body });
  const types = mode === 'type_fallback' ? ['B2B', 'B2CE'] : ['B2CE'];
  const result = await invokeSearchBoostBuryRuleWithContext({
    root: '/services/data/v67.0', route: '/services/data/v67.0/actions/standard/createSearchBoostBuryRule',
    build: async (_name, _marker, values) => ({ values }),
    request: async (path, method = 'GET', body) => {
      calls.push({ path, method, body });
      if (path.includes('/commerce/management/')) {
        if (method === 'DELETE') {
          if (mode === 'rule_delete_rejected') return ok([{ errorCode: 'UNKNOWN_EXCEPTION', message: 'Delete refused' }], 400);
          const id = path.split('/').at(-1);
          const index = rules.findIndex(r => r.id === id);
          if (index < 0) return ok([{ errorCode: 'NOT_FOUND', message: 'No such rule' }], 404);
          rules.splice(index, 1);
          return ok(null, 204);
        }
        if (mode === 'feature_disabled' || mode === 'type_fallback') {
          return ok([{ errorCode: 'FUNCTIONALITY_NOT_ENABLED', message: 'not enabled for this org: [CommerceSearch]' }], 403);
        }
        if (mode === 'vocabulary_unavailable') return ok([]);
        return ok(rules);
      }
      if (path.endsWith('/describe')) {
        return ok({ queryable: true, deletable: mode !== 'missing_cleanup', createable: true,
          fields: [{ name: 'Name', createable: true, filterable: true, length: 255 },
            { name: 'Type', createable: true, picklistValues: types.map(value => ({ active: true, value })) }] });
      }
      if (path.includes('/query?')) {
        const q = decodeURIComponent(path);
        const name = q.match(/ FROM (\w+) WHERE/)?.[1]!;
        const conditions = [...q.matchAll(/(\w+)='([^']+)'/g)];
        return ok({ records: [...rows.values()].filter(row => row.objectName === name && conditions.every(([, field, value]) => row[field] === value)).map(({ objectName, ...row }) => row) });
      }
      if (path.endsWith('/composite/batch')) {
        return ok({ results: body.batchRequests.map((v: any) => {
          const key = v.url.split('/').at(-1);
          if (v.method === 'DELETE' && mode !== 'cleanup_rejection') rows.delete(key);
          return v.method === 'GET' && rows.has(key) ? { statusCode: 200, result: rows.get(key) } : { statusCode: rows.has(key) ? 403 : v.method === 'GET' ? 404 : 204 };
        }) });
      }
      if (path.includes('/sobjects/')) {
        if (method === 'POST') {
          if (mode === 'type_fallback' && body.Type === 'B2B') return ok([{ errorCode: 'INVALID_INPUT', message: 'permission refused', fields: ['Type'] }], 400);
          rows.set(STORE_ID, { objectName: 'WebStore', Id: STORE_ID, ...body });
          return ok({ id: STORE_ID }, 201);
        }
        const row = rows.get(path.split('/').at(-1)!);
        return row ? ok(row) : ok([], 404);
      }
      if (method === 'GET') return ok({ inputs: INPUT_NAMES.map(name => ({ name, required: true })), outputs: [{ name: 'boostBuryRuleId' }] });
      if (path.endsWith('/createSearchBoostBuryRule')) {
        if (mode === 'native_rejection') return ok([{ isSuccess: false, errors: [{ statusCode: 'UNKNOWN_EXCEPTION', message: 'Specify a valid Store ID.' }], outputValues: null }]);
        if (mode === 'missing_output') return ok([{ isSuccess: true, errors: null, outputValues: {} }]);
        const args = body.inputs[0];
        rules.push({ id: 'rule-owned-1', name: args.boostBuryRuleName, action: args.boostBuryRuleAction, level: args.boostBuryRuleLevel,
          attributeNameOrId: args.boostBuryRuleAttributeNameOrId, attributeType: args.boostBuryRuleAttributeType, attributeValues: args.boostBuryRuleAttributeValues });
        return ok([{ isSuccess: true, errors: null, outputValues: { boostBuryRuleId: 'rule-owned-1' } }]);
      }
      throw Error('Unexpected request');
    },
  });
  return { result, rows, rules, calls };
}

test('enabled org verifies the owned rule by readback and removes rule plus store', async () => {
  const { result, rows, rules, calls } = await run();
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.ruleId).toBe('rule-owned-1');
  expect(result.cleanupError).toBeUndefined();
  expect(rows.size).toBe(0);
  expect(rules.some(r => r.id === 'rule-owned-1')).toBe(false);
  expect(rules.some(r => r.id === 'live-rule-1')).toBe(true);
  expect(calls.some(c => c.path.endsWith('/createSearchBoostBuryRule') && c.method === 'POST')).toBe(true);
  expect(calls.length).toBeLessThan(40);
});

test('disabled CommerceSearch returns setup-blocked without invoking and cleans the owned store', async () => {
  const { result, rows, calls } = await run('feature_disabled');
  expect(result.body.errorCode).toBe('SEARCH_RULE_SETUP_REQUIRED');
  expect(result.contextSchema?.setupBlocked).toBe(true);
  expect(result.contextSchema?.verified).toBe(false);
  expect(rows.size).toBe(0);
  expect(calls.some(c => c.path.endsWith('/createSearchBoostBuryRule') && c.method === 'POST')).toBe(false);
});

test('empty live rules fail vocabulary explicitly while cleaning owned writes', async () => {
  const { result, rows, calls } = await run('vocabulary_unavailable');
  expect(result.body.errorCode).toBe('SEARCH_RULE_VOCABULARY_UNAVAILABLE');
  expect(rows.size).toBe(0);
  expect(calls.some(c => c.path.endsWith('/createSearchBoostBuryRule') && c.method === 'POST')).toBe(false);
});

test('native rejection is preserved and owned writes are cleaned', async () => {
  const { result, rows } = await run('native_rejection');
  expect(result.body[0].isSuccess).toBe(false);
  expect(result.contextSchema?.verified).toBe(false);
  expect(rows.size).toBe(0);
});

test('native success without a rule identifier is rejected while cleaning owned writes', async () => {
  const { result, rows } = await run('missing_output');
  expect(result.body.errorCode).toBe('SEARCH_RULE_RULE_UNVERIFIED');
  expect(rows.size).toBe(0);
});

test('refused rule deletion stays explicit with verified creation', async () => {
  const { result, rows } = await run('rule_delete_rejected');
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.cleanupError).toContain('rule');
  expect(rows.size).toBe(0);
});

test('missing cleanup access prevents all mutations', async () => {
  const { result, calls } = await run('missing_cleanup');
  expect(result.body.errorCode).toBe('SEARCH_RULE_CONTEXT_PERMISSIONS_REQUIRED');
  expect(calls.some(c => c.method === 'POST')).toBe(false);
});

test('refused store type falls through to the next live type', async () => {
  const { result, rows } = await run('type_fallback');
  expect(result.body.errorCode).toBe('SEARCH_RULE_SETUP_REQUIRED');
  expect(result.contextSchema?.storeType).toBe('B2CE');
  expect(rows.size).toBe(0);
});
