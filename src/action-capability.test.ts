import { describe, expect, test } from 'bun:test';
import { evaluateActionCapability, permissionSetCapability, type CapabilityRequirement, type ActionCapabilityEvidence } from './action-capability';
const requirement: CapabilityRequirement = { kind: 'permission-set', name: 'LiveFeature', source: 'live-metadata' };
const scope = { teamId: 'team', orgId: 'org', channelId: 'channel', actorId: 'actor', actionRoute: '/actions/standard/liveAction', contractRevision: 'revision' };
const proof = { scope, independentlyVerified: true };
const evidence: ActionCapabilityEvidence = { scope, descriptorAvailable: true, actorActive: true, prerequisiteContractComplete: false, requirements: [] };
describe('execution capability evidence', () => {
  test('catalog exposure alone never implies execution entitlement', () => expect(evaluateActionCapability(evidence).state).toBe('unknown'));
  test('verified native execution proves this identity supports the contract', () => expect(evaluateActionCapability({ ...evidence, nativeExecution: proof }).state).toBe('supported'));
  test('verified execution does not override inactive identities or missing prerequisites', () => {
    expect(evaluateActionCapability({ ...evidence, actorActive: false, nativeExecution: proof }).state).toBe('unsupported');
    expect(evaluateActionCapability({ ...evidence, nativeExecution: proof, requirements: [{ ...requirement, state: 'unsupported', reason: 'Missing assignment' }] }).state).toBe('unsupported');
  });
  test('unknown published capabilities remain unknown even with complete contract declaration', () => expect(evaluateActionCapability({ ...evidence, prerequisiteContractComplete: true, requirements: [{ ...requirement, state: 'unknown', reason: 'Unverified' }] }).state).toBe('unknown'));
  test('unscoped evidence is rejected', () => expect(() => evaluateActionCapability({ ...evidence, scope: { ...scope, actorId: '' } })).toThrow());
  test('native proof from another tenant, channel, actor, action or revision cannot grant support', () => {
    for (const key of Object.keys(scope)) {
      expect(evaluateActionCapability({ ...evidence, nativeExecution: { ...proof, scope: { ...scope, [key]: 'other' } } }).state).toBe('unknown');
    }
  });
  test('feature entitlement is evaluated before permission assignment', () => {
    const set = { id: 'set', name: 'LiveFeature', licenseId: '0PLlicense' };
    const licenses = new Map([['0PLlicense', { id: '0PLlicense', name: 'Feature', status: 'Active', total: 2, used: 1 }]]);
    expect(permissionSetCapability(requirement, set, new Set(['set']), licenses, new Set()).prerequisite?.kind).toBe('license-assignment');
    expect(permissionSetCapability(requirement, set, new Set(), licenses, new Set(['0PLlicense'])).prerequisite?.kind).toBe('permission-set-assignment');
    expect(permissionSetCapability(requirement, set, new Set(['set']), licenses, new Set(['0PLlicense'])).state).toBe('supported');
  });
  test('exhausted, inactive and undiscovered licenses have distinct evidence', () => {
    const set = { id: 'set', name: 'LiveFeature', licenseId: '0PLlicense' };
    const exhausted = new Map([['0PLlicense', { id: '0PLlicense', name: 'Feature', status: 'Active', total: 1, used: 1 }]]);
    expect(permissionSetCapability(requirement, set, new Set(), exhausted, new Set()).prerequisite?.kind).toBe('license-capacity');
    expect(permissionSetCapability(requirement, set, new Set(), new Map(), new Set()).state).toBe('unknown');
    exhausted.get('0PLlicense')!.status = 'Disabled';
    expect(permissionSetCapability(requirement, set, new Set(), exhausted, new Set()).prerequisite?.kind).toBe('feature-enablement');
  });
  test('user-license-bound sets do not imply incompatibility from different ids', () => expect(permissionSetCapability(requirement, { id: 'set', name: 'LiveFeature', licenseId: '100userlicense' }, new Set(), new Map(), new Set()).state).toBe('unknown'));
  test('invalid capacity is unknown while unlimited feature seats permit assignment evidence', () => {
    const set = { id: 'set', name: 'LiveFeature', licenseId: '0PLlicense' };
    const licenses = new Map([['0PLlicense', { id: '0PLlicense', name: 'Feature', status: 'Active', total: NaN, used: 1 }]]);
    expect(permissionSetCapability(requirement, set, new Set(['set']), licenses, new Set(['0PLlicense'])).state).toBe('unknown');
    licenses.get('0PLlicense')!.total = -1;
    expect(permissionSetCapability(requirement, set, new Set(), licenses, new Set()).prerequisite?.kind).toBe('license-assignment');
  });
});
