import { expect, test } from 'bun:test';
import {
  isTriggerNullInsertFault,
  optionalReferenceFields,
  planTriggerNullEnrichment,
  type EnrichmentSchema,
} from './trigger-null-enrichment';

const TRIGGER_BODY = [
  {
    message:
      'FSL.TR001_Service_BeforeInsert: execution of BeforeInsert caused by: System.NullPointerException: Attempt to de-reference a null object (System Code)',
    errorCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
  },
];

test('trigger-null signature matches the managed BeforeInsert fault only', () => {
  expect(isTriggerNullInsertFault(400, TRIGGER_BODY)).toBe(true);
  expect(isTriggerNullInsertFault(200, TRIGGER_BODY)).toBe(false);
  expect(
    isTriggerNullInsertFault(400, [
      {
        message:
          'et4ae5.updateBURecord: execution of BeforeInsert caused by: System.QueryException: List has no rows for assignment to SObject (System Code)',
        errorCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
      },
    ]),
  ).toBe(false);
  expect(isTriggerNullInsertFault(400, [{ message: 'Required fields are missing: [Name]', errorCode: 'REQUIRED_FIELD_MISSING' }])).toBe(
    false,
  );
  expect(isTriggerNullInsertFault(400, null)).toBe(false);
  expect(isTriggerNullInsertFault(400, 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY')).toBe(false);
});

test('optional references exclude required, defaulted, and calculated shapes', () => {
  const fields = optionalReferenceFields([
    { name: 'ParentRecordId', type: 'reference', createable: true, nillable: true, referenceTo: ['Account', 'WorkOrder'] },
    { name: 'WorkTypeId', type: 'reference', createable: true, nillable: true, referenceTo: ['WorkType'] },
    { name: 'BusinessHoursId', type: 'reference', createable: true, nillable: false, referenceTo: ['BusinessHours'] },
    { name: 'OwnerId', type: 'reference', createable: true, nillable: true, defaultedOnCreate: true, referenceTo: ['User'] },
    { name: 'Name', type: 'string', createable: true },
    { name: 'bogus field', type: 'reference', createable: true, nillable: true, referenceTo: ['Account'] },
    { name: 'NoTargets', type: 'reference', createable: true, nillable: true, referenceTo: [] },
  ]);
  expect(fields).toEqual([
    { name: 'ParentRecordId', targets: ['Account', 'WorkOrder'] },
    { name: 'WorkTypeId', targets: ['WorkType'] },
  ]);
});

const mintableSchema = (name: string): EnrichmentSchema => ({ name, createable: true, queryable: true, deletable: true, fields: [] });
const setupSchema = (name: string): EnrichmentSchema => ({ name, createable: false, queryable: true, deletable: false, fields: [] });

test('enrichment prefers planned targets and mints the first mintable candidate', async () => {
  const candidates = await planTriggerNullEnrichment({
    objectName: 'ServiceAppointment',
    fields: [
      { name: 'ParentRecordId', type: 'reference', createable: true, nillable: true, referenceTo: ['Account', 'WorkOrder'] },
      { name: 'WorkTypeId', type: 'reference', createable: true, nillable: true, referenceTo: ['WorkType'] },
    ],
    plannedObjectNames: ['WorkOrder'],
    describe: async (name) => mintableSchema(name),
  });
  expect(candidates).toEqual([
    { field: 'ParentRecordId', target: 'WorkOrder', reuse: true },
    { field: 'WorkTypeId', target: 'WorkType', reuse: false },
  ]);
});

test('enrichment honors caller hints and skips bound and unmintable targets', async () => {
  const candidates = await planTriggerNullEnrichment({
    objectName: 'ServiceAppointment',
    fields: [
      { name: 'ParentRecordId', type: 'reference', createable: true, nillable: true, referenceTo: ['Account', 'WorkOrder'] },
      { name: 'WorkTypeId', type: 'reference', createable: true, nillable: true, referenceTo: ['WorkType'] },
      { name: 'RecordTypeId', type: 'reference', createable: true, nillable: true, referenceTo: ['RecordType'] },
    ],
    boundFields: ['WorkTypeId'],
    referenceTargets: { 'ServiceAppointment.ParentRecordId': 'WorkOrder' },
    describe: async (name) => (name === 'RecordType' ? setupSchema(name) : mintableSchema(name)),
  });
  expect(candidates).toEqual([{ field: 'ParentRecordId', target: 'WorkOrder', reuse: false }]);
});

test('enrichment never throws and returns no candidates without usable targets', async () => {
  expect(await planTriggerNullEnrichment({ objectName: 'ServiceAppointment', fields: [], describe: async () => undefined })).toEqual([]);
  expect(
    await planTriggerNullEnrichment({
      objectName: 'ServiceAppointment',
      fields: [{ name: 'RecordTypeId', type: 'reference', createable: true, nillable: true, referenceTo: ['RecordType'] }],
      describe: async () => setupSchema('RecordType'),
    }),
  ).toEqual([]);
  expect(
    await planTriggerNullEnrichment({
      objectName: 'ServiceAppointment',
      fields: [{ name: 'ParentRecordId', type: 'reference', createable: true, nillable: true, referenceTo: ['Account'] }],
      describe: async () => {
        throw new Error('describe failed');
      },
    }),
  ).toEqual([]);
  expect(await planTriggerNullEnrichment({ objectName: 'not an object!', fields: [], describe: async () => undefined })).toEqual([]);
});
