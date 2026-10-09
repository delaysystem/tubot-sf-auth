import { expect, test } from 'bun:test';
import { planOwnedContext, type ContextSchema, type ContextField } from './owned-context-plan';
const marker: ContextField = { name: 'Name', type: 'string', createable: true, filterable: true, nameField: true, length: 80 };
const reference = (name: string, referenceTo: string[]): ContextField => ({ name, referenceTo, type: 'reference', nillable: false, createable: true });
const schema = (name: string, fields: ContextField[] = []): ContextSchema => ({ name, fields: [marker, ...fields], createable: true, queryable: true, deletable: true });
const describe = (schemas: ContextSchema[]) => async (name: string) => schemas.find(value => value.name === name);

test('required dependencies are ordered before consumers and cleanup reverses the graph', async () => {
  const result = await planOwnedContext({ roots: ['ServiceTerritory', 'WorkType'], describe: describe([
    schema('ServiceTerritory', [reference('OperatingHoursId', ['OperatingHours'])]), schema('OperatingHours'), schema('WorkType'),
  ]) });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.nodes.map(node => node.objectName)).toEqual(['OperatingHours', 'ServiceTerritory', 'WorkType']);
  expect(result.nodes[1].references).toEqual([{ field: 'OperatingHoursId', objectName: 'OperatingHours', source: 'owned' }]);
  expect(result.cleanupOrder).toEqual(['WorkType', 'ServiceTerritory', 'OperatingHours']);
});

test('retained execution actors are explicit and excluded from cleanup', async () => {
  const result = await planOwnedContext({ roots: ['ServiceResource'], retained: { User: '005000000000001AAA' }, describe: describe([
    schema('ServiceResource', [reference('RelatedRecordId', ['User'])]),
  ]) });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.nodes[0].values.RelatedRecordId).toBe('005000000000001AAA');
  expect(result.cleanupOrder).toEqual(['ServiceResource']);
});

test('arbitrary required reference overrides cannot borrow existing tenant records', async () => {
  const result = await planOwnedContext({ roots: ['Child'], values: { Child: { ParentId: '001000000000001AAA' } },
    describe: describe([schema('Child', [reference('ParentId', ['Account'])]), schema('Account')]) });
  expect(result).toMatchObject({ ok: false, issue: { code: 'OWNED_CONTEXT_REFERENCE_NOT_SCOPED', objectName: 'Child', field: 'ParentId', targets: ['Account'] } });
});

test('polymorphic references require an explicit live valid target', async () => {
  const schemas = [schema('Child', [reference('ParentId', ['Account', 'WorkOrder'])]), schema('WorkOrder')];
  expect(await planOwnedContext({ roots: ['Child'], describe: describe(schemas) })).toMatchObject({
    ok: false, issue: { code: 'OWNED_CONTEXT_REFERENCE_AMBIGUOUS', field: 'ParentId', targets: ['Account', 'WorkOrder'] },
  });
  const result = await planOwnedContext({ roots: ['Child'], referenceTargets: { 'Child.ParentId': 'WorkOrder' }, describe: describe(schemas) });
  expect(result.ok).toBe(true);
  expect(await planOwnedContext({ roots: ['Child'], referenceTargets: { 'Child.ParentId': 'Contact' }, describe: describe(schemas) })).toMatchObject({ ok: false });
});

test('FSL trigger forces a nillable SA parent onto an owned WorkOrder', async () => {
  const nillableParent = (referenceTo: string[]): ContextField =>
    ({ name: 'ParentRecordId', referenceTo, type: 'reference', nillable: true, createable: true });
  const schemas = [schema('ServiceAppointment', [nillableParent(['Account', 'WorkOrder'])]), schema('WorkOrder')];
  const forced = await planOwnedContext({ roots: ['ServiceAppointment'], describe: describe(schemas) });
  expect(forced.ok).toBe(true);
  if (!forced.ok) return;
  expect(forced.nodes.map(node => node.objectName)).toEqual(['WorkOrder', 'ServiceAppointment']);
  expect(forced.nodes[1].references).toEqual([{ field: 'ParentRecordId', objectName: 'WorkOrder', source: 'owned' }]);
  // An explicit invalid target still fails.
  expect(await planOwnedContext({ roots: ['ServiceAppointment'],
    referenceTargets: { 'ServiceAppointment.ParentRecordId': 'Contact' }, describe: describe(schemas) }))
    .toMatchObject({ ok: false });
  // No WorkOrder target offered: the force does not apply, planning proceeds.
  const skipped = await planOwnedContext({ roots: ['ServiceAppointment'],
    describe: describe([schema('ServiceAppointment', [nillableParent(['Account'])]), schema('Account')]) });
  expect(skipped.ok).toBe(true);
});

test('cyclic dependencies and missing cleanup access fail before any write', async () => {
  expect(await planOwnedContext({ roots: ['A'], describe: describe([
    schema('A', [reference('BId', ['B'])]), schema('B', [reference('AId', ['A'])]),
  ]) })).toMatchObject({ ok: false, issue: { code: 'OWNED_CONTEXT_REFERENCE_CYCLE', dependencyPath: ['A', 'B', 'A'] } });
  expect(await planOwnedContext({ roots: ['A'], describe: describe([
    schema('A', [reference('BId', ['B'])]), { ...schema('B'), deletable: false },
  ]) })).toMatchObject({ ok: false, issue: { code: 'OWNED_CONTEXT_LIFECYCLE_ACCESS_REQUIRED', dependencyPath: ['A', 'B'] } });
});

test('shared dependencies are created once and schema failures preserve precise edges', async () => {
  const result = await planOwnedContext({ roots: ['A', 'B'], describe: describe([
    schema('A', [reference('CId', ['C'])]), schema('B', [reference('CId', ['C'])]), schema('C'),
  ]) });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.nodes.map(node => node.objectName)).toEqual(['C', 'A', 'B']);
  expect(await planOwnedContext({ roots: ['A'], describe: describe([schema('A', [reference('CId', ['C'])])]) })).toMatchObject({
    ok: false, issue: { code: 'OWNED_CONTEXT_SCHEMA_UNAVAILABLE', objectName: 'C', dependencyPath: ['A', 'C'] },
  });
});

test('node bounds, ownership marker access, and malformed anchors reject explicitly', async () => {
  expect(await planOwnedContext({ roots: ['A'], maxNodes: 1, describe: describe([schema('A', [reference('BId', ['B'])]), schema('B')]) })).toMatchObject({ ok: false, issue: { code: 'OWNED_CONTEXT_GRAPH_LIMIT' } });
  expect(await planOwnedContext({ roots: ['A'], describe: describe([{ ...schema('A'), fields: [] }]) })).toMatchObject({ ok: false, issue: { code: 'OWNED_CONTEXT_MARKER_UNAVAILABLE' } });
  expect(await planOwnedContext({ roots: ['A'], retained: { User: 'bad' }, describe: describe([schema('A', [reference('UserId', ['User'])])]) })).toMatchObject({ ok: false, issue: { code: 'OWNED_CONTEXT_ANCHOR_INVALID' } });
});

test('optional/defaulted references do not invent unnecessary dependencies', async () => {
  const result = await planOwnedContext({ roots: ['A'], describe: describe([schema('A', [
    { ...reference('OptionalId', ['B']), nillable: true }, { ...reference('DefaultId', ['C']), defaultedOnCreate: true },
  ])]) });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.nodes[0].references).toEqual([]);
});
