import { expect, test } from 'bun:test';
import {
  buildFeedItemTaskFixture,
  classifySkippedStandardFault,
  newSkippedStandardsMarker,
  resolveRequiredInputValue,
  selectAlternativeMarkerField,
  verifySkippedStandardReadback,
} from './skipped-standards-context';

const accountId = '001000000000001AAA';

test('alternative marker prefers name field then relaxes length to 24', () => {
  const fields = [
    { name: 'Description', type: 'textarea', createable: true, filterable: true, length: 32 },
    { name: 'Name', type: 'string', createable: true, filterable: true, length: 80, nameField: true },
  ];
  expect(selectAlternativeMarkerField(fields)?.name).toBe('Name');
  expect(selectAlternativeMarkerField([{ name: 'Name', type: 'string', createable: true, filterable: false, length: 80 }])).toBeNull();
  expect(selectAlternativeMarkerField([])).toBeNull();
});

test('required inputs resolve from live schema; references never synthesize', () => {
  expect(resolveRequiredInputValue({ name: 'Status', type: 'STRING' }, [
    { name: 'Status', type: 'picklist', picklistValues: [{ value: 'New', active: true }] },
  ])).toBe('New');
  expect(resolveRequiredInputValue({ name: 'IsActive', type: 'BOOLEAN' }, [])).toBe(true);
  expect(resolveRequiredInputValue({ name: 'WhatId', type: 'REFERENCE' }, [])).toBeUndefined();
  expect(resolveRequiredInputValue({ name: 'OwnerId', type: 'ID' }, [])).toBeUndefined();
  const marker = resolveRequiredInputValue({ name: 'Subject', type: 'STRING' }, []) as string;
  expect(typeof marker === 'string' && marker.startsWith('AS probe ')).toBe(true);
});

test('required inputs cover email, time, base64, and encrypted text wire formats', () => {
  const email = resolveRequiredInputValue({ name: 'Email', type: 'EMAIL' }, [
    { name: 'Email', type: 'email', length: 80 },
  ]) as string;
  expect(/@example\.invalid$/.test(email)).toBe(true);
  expect(email.length).toBeLessThanOrEqual(80);
  expect(resolveRequiredInputValue({ name: 'Email', type: 'EMAIL' }, [
    { name: 'Email', type: 'email', length: 10 },
  ])).toBeUndefined();
  const time = resolveRequiredInputValue({ name: 'StartTime', type: 'TIME' }, []) as string;
  expect(/^\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time)).toBe(true);
  expect(resolveRequiredInputValue({ name: 'Payload', type: 'BASE64' }, [
    { name: 'Payload', type: 'base64', length: 1024 },
  ])).toBe('QWN0aW9uUHJvYmU=');
  expect(resolveRequiredInputValue({ name: 'Payload', type: 'BASE64' }, [
    { name: 'Payload', type: 'base64', length: 4 },
  ])).toBeUndefined();
  const secret = resolveRequiredInputValue({ name: 'TaxId', type: 'ENCRYPTEDSTRING' }, []) as string;
  expect(typeof secret === 'string' && secret.startsWith('AS probe ')).toBe(true);
});

test('feed-item task derives from a live parent; gaps stay explicit', () => {
  const ok = buildFeedItemTaskFixture({
    targetObject: 'FeedItem',
    contextObject: 'Account',
    parentRecordId: accountId,
    targetFields: [{ name: 'ParentId', type: 'reference', referenceTo: ['Account'] }],
  });
  expect(ok.ok).toBe(true);
  if (ok.ok) {
    expect(ok.plan).toMatchObject({ kind: 'parent-record-derived', parentObject: 'Account', parentRecordId: accountId });
    expect(ok.plan.verified).toBe(false);
  }
  expect(buildFeedItemTaskFixture({ targetObject: 'FeedItem', parentRecordId: accountId }).ok).toBe(false);
  expect(buildFeedItemTaskFixture({ targetObject: 'FeedItem', contextObject: 'Account' }).ok).toBe(false);
  const mismatch = buildFeedItemTaskFixture({
    targetObject: 'FeedItem',
    contextObject: 'Account',
    parentRecordId: accountId,
    targetFields: [{ name: 'ParentId', type: 'reference', referenceTo: ['Contact'] }],
  });
  expect(mismatch.ok).toBe(false);
});

test('readback requires marker, changes, and relationship', () => {
  const marker = newSkippedStandardsMarker(80);
  expect(verifySkippedStandardReadback({
    performed: true, markerField: 'Subject', marker, actionAccepted: true,
    after: { Subject: marker }, expectedChanges: {},
  }).verified).toBe(true);
  expect(verifySkippedStandardReadback({
    performed: true, markerField: 'Subject', marker, actionAccepted: true,
    after: { Subject: 'wrong' }, expectedChanges: {},
  }).code).toBe('MUTATION_CREATE_UNVERIFIED');
  expect(verifySkippedStandardReadback({
    performed: true, markerField: 'Subject', marker, actionAccepted: true,
    after: { Subject: marker, WhatId: accountId }, expectedChanges: {},
    expectedParent: { field: 'WhatId', id: accountId },
  }).verified).toBe(true);
  expect(verifySkippedStandardReadback({
    performed: true, markerField: 'Subject', marker, actionAccepted: false,
    after: { Subject: marker }, expectedChanges: {},
  }).verified).toBe(false);
});

test('faults report license only on explicit text; empty outcomes stay missing', () => {
  expect(classifySkippedStandardFault(200, []).code).toBe('SKIPPED_STANDARD_OUTCOME_MISSING');
  expect(classifySkippedStandardFault(200, {}).category).toBe('outcome_missing');
  const license = classifySkippedStandardFault(400, [{ message: 'Requires a Marketing license' }]);
  expect(license.category).toBe('license_required');
  expect(classifySkippedStandardFault(400, [{ message: 'No such column' }]).category).toBe('http_error');
});
