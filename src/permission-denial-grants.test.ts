import { test, expect } from 'bun:test';
import { classifyDenialGrant, denialGrantForRestOutcome, grantFamilyForCleanupDenial } from './permission-denial-grants';

const base = {
  status: 403,
  messages: [],
  codes: [] as string[],
};

test('cross-reference denials map to the referenced-row family', () => {
  const coded = classifyDenialGrant({
    ...base,
    messages: ['insufficient access rights on cross reference id: 001000000000001AAA'],
    codes: ['INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY'],
  });
  expect(coded?.family).toBe('cross-reference');
  expect(coded?.retryable).toBe(true);
  expect(coded?.requirement).not.toContain('001000000000001AAA');
  const prose = classifyDenialGrant({
    ...base,
    messages: ['insufficient access rights on cross reference id'],
    codes: ['INSUFFICIENT_ACCESS_OR_READONLY'],
  });
  expect(prose?.family).toBe('cross-reference');
});

test('object-id denials map to record access, never to object grants', () => {
  const grant = classifyDenialGrant({
    ...base,
    messages: ['insufficient access rights on object id: 001000000000001AAA'],
    codes: ['INSUFFICIENT_ACCESS_OR_READONLY'],
  });
  expect(grant?.family).toBe('record-access');
  expect(grant?.requirement).toContain('row visibility');
  expect(grant?.requirement).not.toContain('001000000000001AAA');
});

test('bare denial codes and non-denial shapes stay unclassified', () => {
  expect(classifyDenialGrant({
    ...base,
    messages: ['something failed'],
    codes: ['INSUFFICIENT_ACCESS_OR_READONLY'],
  })).toBeNull();
  expect(classifyDenialGrant({
    ...base,
    status: 400,
    messages: ['No such column \'Description\' on entity \'Account\'.'],
    codes: ['INVALID_FIELD'],
  })).toBeNull();
  expect(classifyDenialGrant({ status: 403, messages: 'nope' } as any)).toBeNull();
  expect(classifyDenialGrant({
    ...base,
    messages: ['The running user doesn\u2019t have the required access to run the flow.'],
    codes: ['UNKNOWN_EXCEPTION'],
  })).toBeNull();
});

test('REST cross-reference denials yield the referenced-row family', () => {
  const grant = denialGrantForRestOutcome(400, [
    { message: 'insufficient access rights on cross reference id: 001000000000001AAA', errorCode: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY' },
  ]);
  expect(grant?.family).toBe('cross-reference');
  expect(grant?.retryable).toBe(true);
  expect(grant?.requirement).not.toContain('001000000000001AAA');
  const envelope = denialGrantForRestOutcome(200, [
    { isSuccess: false, errors: [{ statusCode: 'INSUFFICIENT_ACCESS_OR_READONLY', message: 'insufficient access rights on cross reference id' }] },
  ]);
  expect(envelope?.family).toBe('cross-reference');
});

test('REST object-id denials yield record access, never object grants', () => {
  const grant = denialGrantForRestOutcome(403, [
    { message: 'insufficient access rights on object id: 001000000000001AAA', errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY' },
  ]);
  expect(grant?.family).toBe('record-access');
  expect(grant?.requirement).toContain('row visibility');
});

test('REST outcomes without denial anatomy yield no grant', () => {
  expect(denialGrantForRestOutcome(403, [
    { message: 'something failed', errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY' },
  ])).toBeNull();
  expect(denialGrantForRestOutcome(400, [
    { message: 'Required fields are missing', errorCode: 'REQUIRED_FIELD_MISSING' },
  ])).toBeNull();
  expect(denialGrantForRestOutcome(200, [{ isSuccess: true }])).toBeNull();
  expect(denialGrantForRestOutcome(403, null)).toBeNull();
  expect(denialGrantForRestOutcome(403, 'nope')).toBeNull();
  expect(denialGrantForRestOutcome(Number.NaN, [])).toBeNull();
  expect(denialGrantForRestOutcome(403, [{ message: 42, errorCode: '../../etc' }])).toBeNull();
});

test('friendly feature and action gates map to their grant families', () => {
  const feature = classifyDenialGrant({
    ...base,
    status: 400,
    messages: ["Looks like you don't have access to this feature. Your Salesforce admin can help with that."],
    codes: [],
  });
  expect(feature?.family).toBe('feature-access');
  expect(feature?.retryable).toBe(true);
  expect(feature?.requirement).toContain('gated feature');
  const curly = classifyDenialGrant({
    ...base,
    status: 400,
    messages: ["Looks like you don\u2019t have access to this feature."],
    codes: [],
  });
  expect(curly?.family).toBe('feature-access');
  const action = classifyDenialGrant({
    ...base,
    status: 400,
    messages: ["Looks like you don't have access to this action. Your Salesforce admin can help with that."],
    codes: [],
  });
  expect(action?.family).toBe('action-access');
  expect(action?.retryable).toBe(true);
});

test('friendly record gate maps to record access, never to object grants', () => {
  const grant = classifyDenialGrant({
    ...base,
    status: 400,
    messages: ["Looks like you don't have access to this record. Your Salesforce admin can help with that."],
    codes: [],
  });
  expect(grant?.family).toBe('record-access');
  expect(grant?.requirement).toContain('row visibility');
});

test('friendly object gate names the object only when identifier-valid', () => {
  const named = classifyDenialGrant({
    ...base,
    status: 400,
    messages: ["Looks like you don't have access to the Case object. Your Salesforce admin can help with that."],
    codes: [],
  });
  expect(named?.family).toBe('object-crud');
  expect(named?.objectName).toBe('Case');
  expect(named?.requirement).toContain('Case');
  const generic = classifyDenialGrant({
    ...base,
    status: 400,
    messages: ["Looks like you don't have access to the order item object."],
    codes: [],
  });
  expect(generic?.family).toBe('object-crud');
  expect(generic?.objectName).toBeUndefined();
  expect(generic?.requirement).not.toContain('order item');
});

test('integration-data gate names the product only when identifier-valid', () => {
  const pardot = classifyDenialGrant({
    ...base,
    status: 400,
    messages: ['You need access to Pardot data to view lists. Contact your admin for help.'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(pardot?.family).toBe('package-data');
  expect(pardot?.requirement).toContain('Pardot');
  expect(pardot?.retryable).toBe(true);
});

test('csv-convert access clause maps to feature access without echoing inputs', () => {
  const grant = denialGrantForRestOutcome(400, [
    { message: 'We couldn\u2019t convert the records from the uploaded CSV file because you don\u2019t have the required access. Your Salesforce admin can help with that.; Specify a valid ID for the received document record.', errorCode: 'CSV_CONVERT_ACCESS_REQUIRED' },
  ]);
  expect(grant?.family).toBe('feature-access');
  expect(grant?.requirement).toContain('CSV-convert');
  expect(grant?.requirement).not.toContain('received document record');
});

test('REST friendly 400s yield grants; bare codes still stay unclassified', () => {
  const feature = denialGrantForRestOutcome(400, [
    { message: "Looks like you don't have access to this feature. Your Salesforce admin can help with that.", errorCode: 'FEATURE_ACCESS_REQUIRED' },
  ]);
  expect(feature?.family).toBe('feature-access');
  expect(denialGrantForRestOutcome(400, [{ message: 'INSUFFICIENT_USER_ACCESS', errorCode: 'INSUFFICIENT_USER_ACCESS' }])).toBeNull();
  expect(denialGrantForRestOutcome(400, [{ message: 'entity is deleted', errorCode: 'ENTITY_IS_DELETED' }])).toBeNull();
});

test('cleanup delete denials map to object crud with a validated name only', () => {
  const grant = grantFamilyForCleanupDenial('WebCart');
  expect(grant?.family).toBe('object-crud');
  expect(grant?.objectName).toBe('WebCart');
  expect(grant?.requirement).toContain('WebCart delete access');
  expect(grantFamilyForCleanupDenial('../../etc')).toBeNull();
  expect(grantFamilyForCleanupDenial('')).toBeNull();
  expect(grantFamilyForCleanupDenial(undefined)).toBeNull();
});
