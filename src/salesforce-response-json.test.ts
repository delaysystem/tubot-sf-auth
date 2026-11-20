import { describe, expect, test } from 'bun:test';
import { extractTrailingResponseDocuments, parseSalesforceResponseJson } from './salesforce-response-json';

const ENVELOPE = '[{"actionName":"tubot__CheckWeather","errors":null,"isSuccess":true,"outputValues":{"weather":"sunny"}}]';
const CORRUPT = '[{"actionName":"tubot__CheckWeather","errors":null,"isSuccess":true,"outputValues":{"weather"}}]';
const TRAILING = '[{"message":"Type cannot be serialized","errorCode":"JSON_PARSER_ERROR"}]';

describe('salesforce-response-json', () => {
  test('single document parses as before', () => {
    const body = parseSalesforceResponseJson(ENVELOPE) as Array<Record<string, unknown>>;
    expect(Array.isArray(body) && body[0]?.isSuccess).toBe(true);
    expect(extractTrailingResponseDocuments(ENVELOPE)).toEqual([]);
  });
  test('concatenated envelope plus error document yields leading envelope with trailing preserved', () => {
    const body = parseSalesforceResponseJson(ENVELOPE + TRAILING) as Array<Record<string, unknown>>;
    expect(Array.isArray(body) && body[0]?.isSuccess).toBe(true);
    expect(extractTrailingResponseDocuments(ENVELOPE + TRAILING)).toEqual(
      [[{ message: 'Type cannot be serialized', errorCode: 'JSON_PARSER_ERROR' }]]);
  });
  test('corrupt leading document stays a malformed rejection even with trailing error', () => {
    expect(parseSalesforceResponseJson(CORRUPT + TRAILING)).toMatchObject({ errorCode: 'SALESFORCE_NON_JSON_RESPONSE' });
    expect(extractTrailingResponseDocuments(CORRUPT + TRAILING)).toEqual([]);
  });
  test('trailing garbage stays a malformed rejection', () => {
    const raw = ENVELOPE + 'not-json{{{';
    expect(parseSalesforceResponseJson(raw)).toMatchObject({ errorCode: 'SALESFORCE_NON_JSON_RESPONSE' });
    expect(extractTrailingResponseDocuments(raw)).toEqual([]);
  });
  test('garbage-only stays malformed', () => {
    expect(parseSalesforceResponseJson('not json')).toMatchObject({ errorCode: 'SALESFORCE_NON_JSON_RESPONSE' });
  });
  test('empty stays null and oversize stays rejected', () => {
    expect(parseSalesforceResponseJson('')).toBeNull();
    expect(parseSalesforceResponseJson('{"a":1}', 2)).toMatchObject({ errorCode: 'SALESFORCE_RESPONSE_TOO_LARGE' });
  });
});
