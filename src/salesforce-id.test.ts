import { test, expect } from 'bun:test';
import { sameSalesforceId } from './salesforce-id';

test('same Salesforce user in 15- and 18-char formats compares equal', () => {
  expect(sameSalesforceId('005000000000001', '005000000000001AAA')).toBe(true);
  expect(sameSalesforceId('005000000000001AAA', '005000000000001')).toBe(true);
  expect(sameSalesforceId('005000000000001AAA', '005000000000001AAA')).toBe(true);
});

test('different users and malformed ids never compare equal', () => {
  expect(sameSalesforceId('005000000000001AAA', '005000000000002AAA')).toBe(false);
  // Same 15-char prefix with a differing checksum suffix still matches: the
  // checksum is not validated, mirroring the auth token-path semantics.
  expect(sameSalesforceId('005000000000001AAA', '005000000000001AAB')).toBe(true);
  expect(sameSalesforceId('005000000000001AAA', 'not-an-id')).toBe(false);
  expect(sameSalesforceId('not-an-id', '005000000000001AAA')).toBe(false);
  expect(sameSalesforceId(undefined, '005000000000001AAA')).toBe(false);
  expect(sameSalesforceId(null, null)).toBe(false);
});
