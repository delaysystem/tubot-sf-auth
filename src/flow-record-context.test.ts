import { describe, expect, test } from 'bun:test';
import {
  FLOW_RECORD_CONTEXT_BUILDER_VERSION,
  flowRecordCatalogCandidates,
  flowRecordCatalogSoql,
  flowRecordFixtureBlocker,
  resolveFlowRecordTarget,
} from './flow-record-context';

describe('flow-record-context', () => {
  test('forces re-probe of already-failed rows', () => {
    expect(FLOW_RECORD_CONTEXT_BUILDER_VERSION).toBeGreaterThan(102);
    expect(FLOW_RECORD_CONTEXT_BUILDER_VERSION).toBeGreaterThan(106);
    expect(FLOW_RECORD_CONTEXT_BUILDER_VERSION).toBeGreaterThan(108);
    expect(FLOW_RECORD_CONTEXT_BUILDER_VERSION).toBeGreaterThan(114);
  });

  test('collects declared types plus field-name fallbacks as candidates', () => {
    expect(flowRecordCatalogCandidates([
      { name: 'objEvent', sObjectType: 'Event' },
      { name: 'Case', sObjectType: 'Case' },
    ])).toEqual(['Event', 'objEvent', 'Case']);
    expect(flowRecordCatalogCandidates([{ name: 'Case' }])).toEqual(['Case']);
    expect(flowRecordCatalogCandidates([{ name: '9bad', sObjectType: null }])).toEqual([]);
    expect(flowRecordCatalogCandidates(null)).toEqual([]);
  });

  test('builds a bounded EntityDefinition existence query', () => {
    expect(flowRecordCatalogSoql(['Event', 'Case']))
      .toBe("SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName IN ('Event','Case')");
    expect(flowRecordCatalogSoql([])).toBeNull();
    expect(flowRecordCatalogSoql(['nope!'])).toBeNull();
  });

  test('prefers the exact sObjectType hit, then the field-name hit', () => {
    expect(resolveFlowRecordTarget(['Event', 'Case'], { name: 'objEvent', sObjectType: 'Event' })).toBe('Event');
    expect(resolveFlowRecordTarget(['Case'], { name: 'Case' })).toBe('Case');
    expect(resolveFlowRecordTarget(['Case'], { name: 'case' })).toBe('Case');
    expect(resolveFlowRecordTarget(['Account'], { name: 'objEvent', sObjectType: 'Event' })).toBeNull();
    expect(resolveFlowRecordTarget([], { name: 'Case', sObjectType: 'Case' })).toBeNull();
    expect(resolveFlowRecordTarget(null, { name: 'Case' })).toBeNull();
  });

  test('fixture preflight refuses targets that cannot complete create/readback/delete', () => {
    const ready = { createable: true, queryable: true, deletable: true, fields: [{ name: 'Name' }] };
    expect(flowRecordFixtureBlocker('ChangeRequest', ready)).toBeNull();
    // ITSM record types: minting an undeletable fixture manufactures orphan
    // residue plus a guaranteed ACTION_CLEANUP_UNVERIFIED.
    expect(flowRecordFixtureBlocker('ChangeRequest', { ...ready, deletable: false })).toContain('delete access');
    expect(flowRecordFixtureBlocker('Incident', { ...ready, deletable: false })).toContain('Incident');
    expect(flowRecordFixtureBlocker('Case', { ...ready, createable: false })).toContain('createable=false');
    expect(flowRecordFixtureBlocker('Case', { ...ready, queryable: false })).toContain('queryable=false');
    expect(flowRecordFixtureBlocker('Case', { ...ready, fields: null })).toContain('field schema');
    expect(flowRecordFixtureBlocker('Case', null)).toContain('unusable');
    expect(flowRecordFixtureBlocker('nope!', ready)).toContain('Invalid fixture object');
  });
});
