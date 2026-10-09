import { test, expect } from 'bun:test';
import {
  apexCompanionValue,
  apexNeedsLiveObjectName,
  apexRecordCompanionValue,
  apexSimpleClassName,
  apexSobjectShapePlan,
  contextNamespaceAbsent,
  firstQueryableObjectName,
  isApexExternalCalloutInputSet,
  isApexScalarOnlyInputSet,
  planApexScalarArgs,
  screenApexBody,
  verifyOwnedSobjectUpdate,
} from './apex-effect-screen';

const MARKER = 'AS probe 12345678-90ab-cdef-1234-567890abcdef';

const PURE_BODY = `public with sharing class SDO_Service_ConvertToStringCollection {
    @invocableMethod(label='Convert')
    public static List<Response> execute(List<Request> requests) {
        Response response = new Response();
        response.stringCollection = requests[0].initialString.split(requests[0].delimiter);
        return new List<Response>{response};
    }
}`;

test('pure bodies pass and every effect class refuses', () => {
  expect(screenApexBody(PURE_BODY)).toEqual({ verdict: 'pure' });
  expect(screenApexBody('public class X { @InvocableMethod public static void m() { update toUpdate; } }'))
    .toMatchObject({ verdict: 'refuse', effect: 'DML' });
  expect(screenApexBody('public class X { @InvocableMethod public static void m() { Database.insert(rows); } }'))
    .toMatchObject({ verdict: 'refuse', effect: 'DML' });
  expect(screenApexBody('public class X { @InvocableMethod public static void m() { Http h = new Http(); } }'))
    .toMatchObject({ verdict: 'refuse', effect: 'CALLOUT' });
  expect(screenApexBody('public class X { @InvocableMethod public static void m() { req.setEndpoint("callout:Zoom/x"); } }'))
    .toMatchObject({ verdict: 'refuse', effect: 'CALLOUT' });
  expect(screenApexBody('public class X { @InvocableMethod public static void m() { Messaging.sendEmail(mails); } }'))
    .toMatchObject({ verdict: 'refuse', effect: 'SEND' });
  expect(screenApexBody('public class X { @InvocableMethod public static void m() { System.enqueueJob(q); } }'))
    .toMatchObject({ verdict: 'refuse', effect: 'ASYNC' });
  expect(screenApexBody('public class X { @future public static void m() {} @InvocableMethod public static void n() {} }'))
    .toMatchObject({ verdict: 'refuse', effect: 'ASYNC' });
});

test('effect keywords refuse even in comments: refusal is the safe direction', () => {
  expect(screenApexBody('public class X { @InvocableMethod public static List<String> m() {\n// 5) Perform the update and capture the count\nreturn null; } }'))
    .toMatchObject({ verdict: 'refuse', effect: 'DML' });
});

test('unverifiable bodies refuse: stubs, missing, unbounded, non-invocable', () => {
  const stub = `/*\nThis file is generated and isn't the actual source code for this\nmanaged global class.\n*/\nglobal class ZoomApiRequest {\n@InvocableMethod(label='Add')\nglobal static void m() {}\n}`;
  expect(screenApexBody(stub)).toMatchObject({ verdict: 'refuse', effect: 'UNVERIFIABLE' });
  expect(screenApexBody(null)).toMatchObject({ verdict: 'refuse', effect: 'UNVERIFIABLE' });
  expect(screenApexBody('')).toMatchObject({ verdict: 'refuse', effect: 'UNVERIFIABLE' });
  expect(screenApexBody('x'.repeat(500_001))).toMatchObject({ verdict: 'refuse', effect: 'UNVERIFIABLE' });
  expect(screenApexBody('public class X { public static void helper() { return; } }'))
    .toMatchObject({ verdict: 'refuse', effect: 'UNVERIFIABLE' });
});

test('simple class names strip one namespace segment and reject junk', () => {
  expect(apexSimpleClassName('pi__CreateForm')).toBe('CreateForm');
  expect(apexSimpleClassName('SDO_Service_BotsUpdateEmail')).toBe('SDO_Service_BotsUpdateEmail');
  expect(apexSimpleClassName('a__b__C')).toBe('C');
  expect(apexSimpleClassName('bad!!name')).toBeNull();
  expect(apexSimpleClassName('pi____')).toBeNull();
  expect(apexSimpleClassName('')).toBeNull();
  expect(apexSimpleClassName(null)).toBeNull();
});

test('scalar-only sets reject identifiers, records, and untyped inputs', () => {
  expect(isApexScalarOnlyInputSet([
    { name: 'delimiter', type: 'STRING', required: true },
    { name: 'initialString', type: 'STRING', required: true },
  ])).toBe(true);
  expect(isApexScalarOnlyInputSet([
    { name: 'valueFromFlow', type: 'STRING', required: false },
  ])).toBe(true);
  expect(isApexScalarOnlyInputSet([{ name: 'recordId', type: 'ID', required: true }])).toBe(false);
  expect(isApexScalarOnlyInputSet([{ name: 'caseObj', type: 'SOBJECT', required: true }])).toBe(false);
  expect(isApexScalarOnlyInputSet([{ name: 'maybe', type: 'SOBJECT', required: false }])).toBe(false);
  expect(isApexScalarOnlyInputSet([{ name: 'customField', type: null, required: true }])).toBe(false);
  expect(isApexScalarOnlyInputSet([])).toBe(false);
  expect(isApexScalarOnlyInputSet([{ name: 'bad!!', type: 'STRING', required: true }])).toBe(false);
  expect(isApexScalarOnlyInputSet(null)).toBe(false);
});

test('sobject-shape plans bind the descriptor-declared target only', () => {
  expect(apexSobjectShapePlan([
    { name: 'objContact', type: 'SOBJECT', required: true, sObjectType: 'Contact' },
    { name: 'value', type: 'STRING', required: true },
  ])).toEqual({ sobjectInput: 'objContact', objectName: 'Contact', scalarInputs: ['value'] });
  expect(apexSobjectShapePlan([
    { name: 'caseObj', type: 'SOBJECT', required: true, sObjectType: 'Case' },
    { name: 'caseSubject', type: 'STRING', required: true },
  ])).toEqual({ sobjectInput: 'caseObj', objectName: 'Case', scalarInputs: ['caseSubject'] });
  // Missing or invalid sObjectType refuses: the fixture object is never guessed.
  expect(apexSobjectShapePlan([
    { name: 'objContact', type: 'SOBJECT', required: true },
    { name: 'value', type: 'STRING', required: true },
  ])).toEqual({ refuse: 'sobject_target' });
  expect(apexSobjectShapePlan([
    { name: 'objContact', type: 'SOBJECT', required: true, sObjectType: 'bad!!' },
    { name: 'value', type: 'STRING', required: true },
  ])).toEqual({ refuse: 'sobject_target' });
  // Identifier companions and twin records refuse.
  expect(apexSobjectShapePlan([
    { name: 'objContact', type: 'SOBJECT', required: true, sObjectType: 'Contact' },
    { name: 'recordId', type: 'ID', required: true },
  ])).toEqual({ refuse: 'identifier_input' });
  expect(apexSobjectShapePlan([
    { name: 'a', type: 'SOBJECT', required: true, sObjectType: 'Case' },
    { name: 'b', type: 'SOBJECT', required: true, sObjectType: 'Contact' },
  ])).toEqual({ refuse: 'sobject_shape' });
  expect(apexSobjectShapePlan([
    { name: 'a', type: 'SOBJECT', required: true, sObjectType: 'Case' },
    { name: 'b', type: 'SOBJECT', required: false, sObjectType: 'Contact' },
  ])).toEqual({ refuse: 'sobject_shape' });
  expect(apexSobjectShapePlan([{ name: 'value', type: 'STRING', required: true }])).toEqual({ refuse: 'sobject_shape' });
  expect(apexSobjectShapePlan(null)).toEqual({ refuse: 'input_schema' });
});

test('external-callout sets match required credential markers only', () => {
  expect(isApexExternalCalloutInputSet([
    { name: 'businessUnitId', type: 'STRING', required: true },
    { name: 'campaignId', type: 'STRING', required: true },
  ])).toBe(true);
  expect(isApexExternalCalloutInputSet([
    { name: 'NamedCredential', type: 'STRING', required: true },
  ])).toBe(true);
  expect(isApexExternalCalloutInputSet([
    { name: 'businessUnitId', type: 'STRING', required: false },
  ])).toBe(false);
  expect(isApexExternalCalloutInputSet([
    { name: 'value', type: 'STRING', required: true },
  ])).toBe(false);
  expect(isApexExternalCalloutInputSet(null)).toBe(false);
});

test('companion values shape email/phone by type or platform name', () => {
  expect(apexCompanionValue({ name: 'emailAddress', type: 'EMAIL', required: true }, MARKER))
    .toBe('probe-1234567890ab@example.invalid');
  expect(apexCompanionValue({ name: 'value', type: 'STRING', required: true }, MARKER)).toBe(MARKER);
  const byName = apexCompanionValue({ name: 'contactEmail', type: 'STRING', required: true }, MARKER);
  expect(byName).toMatch(/^probe-[a-z0-9]+@example\.invalid$/);
  const phone = apexCompanionValue({ name: 'value', type: 'PHONE', required: true }, MARKER) as string;
  expect(phone).toMatch(/^\+1555\d{7}$/);
  const phoneByName = apexCompanionValue({ name: 'phoneNumber', type: 'STRING', required: true }, MARKER) as string;
  expect(phoneByName).toMatch(/^\+1555\d{7}$/);
  // Deterministic per marker.
  expect(apexCompanionValue({ name: 'value', type: 'PHONE', required: true }, MARKER)).toBe(phone);
  expect(apexCompanionValue({ name: 'flag', type: 'BOOLEAN', required: true }, MARKER)).toBe(true);
  expect(apexCompanionValue({ name: 'value', type: 'STRING', required: true }, 'junk')).toBeUndefined();
});

test('record companions take the marker-email form for generic strings', () => {
  expect(apexRecordCompanionValue({ name: 'value', type: 'STRING', required: true }, MARKER))
    .toBe('probe-1234567890ab@example.invalid');
  expect(apexRecordCompanionValue({ name: 'caseSubject', type: 'STRING', required: true }, MARKER))
    .toBe('probe-1234567890ab@example.invalid');
  const phone = apexRecordCompanionValue({ name: 'value', type: 'PHONE', required: true }, MARKER) as string;
  expect(phone).toMatch(/^\+1555\d{7}$/);
  expect(apexRecordCompanionValue({ name: 'flag', type: 'BOOLEAN', required: true }, MARKER)).toBe(true);
  expect(apexRecordCompanionValue({ name: 'value', type: 'STRING', required: true }, 'junk')).toBeUndefined();
});

test('scalar arg plans bind declared inputs only and miss honestly', () => {
  expect(planApexScalarArgs([
    { name: 'delimiter', type: 'STRING', required: true },
    { name: 'initialString', type: 'STRING', required: true },
    { name: 'optional', type: 'STRING', required: false },
  ], MARKER)).toEqual({ args: { delimiter: MARKER, initialString: MARKER, optional: MARKER } });
  expect(planApexScalarArgs([
    { name: 'requestType', type: 'PICKLIST', required: true, values: [{ value: 'A', active: true }] } as never,
  ], MARKER)).toEqual({ args: { requestType: 'A' } });
  expect(planApexScalarArgs([
    { name: 'requestType', type: 'PICKLIST', required: true },
  ], MARKER)).toEqual({ missing: 'requestType' });
  expect(planApexScalarArgs(null, MARKER)).toEqual({ missing: 'input_schema' });
  expect(planApexScalarArgs([{ name: 'x', type: 'STRING', required: true }], 'junk')).toEqual({ missing: 'x' });
});

test('scalar companions bind identifier vocabulary from live rules', () => {
  // Dynamic-SOQL field lists take the only universal field.
  expect(apexCompanionValue({ name: 'fieldsToQuery', type: 'STRING', required: true }, MARKER)).toBe('Id');
  // Field-name inputs take the universal field.
  expect(apexCompanionValue({ name: 'fieldAPIName', type: 'STRING', required: true }, MARKER)).toBe('Name');
  expect(apexCompanionValue({ name: 'FieldToAnalyze', type: 'STRING', required: true }, MARKER)).toBe('Name');
  // Object-name inputs take the runner-discovered live name, never the marker.
  expect(apexCompanionValue({ name: 'objectApiName', type: 'STRING', required: true }, MARKER, { objectName: 'Account' }))
    .toBe('Account');
  expect(apexCompanionValue({ name: 'objectApiName', type: 'STRING', required: true }, MARKER)).toBeUndefined();
  expect(apexCompanionValue({ name: 'objectApiName', type: 'STRING', required: true }, MARKER, { objectName: 'T__nope' }))
    .toBe('T__nope');
  expect(apexCompanionValue({ name: 'objectApiName', type: 'STRING', required: true }, MARKER, { objectName: 'no spaces' }))
    .toBeUndefined();
  // Plain strings keep the marker.
  expect(apexCompanionValue({ name: 'delimiter', type: 'STRING', required: true }, MARKER)).toBe(MARKER);
});

test('address-vocabulary companions take a marker-derived CSV with a state+zip tail', () => {
  expect(apexCompanionValue({ name: 'thisAddressList', type: 'STRING', required: false }, MARKER))
    .toBe(`${MARKER},${MARKER},MC 12345`);
  expect(apexCompanionValue({ name: 'mailingAddress', type: 'TEXTAREA', required: true }, MARKER))
    .toBe(`${MARKER},${MARKER},MC 12345`);
  // Email shaping wins over the address substring: emailAddress keeps its email.
  expect(apexCompanionValue({ name: 'emailAddress', type: 'STRING', required: true }, MARKER))
    .toBe('probe-1234567890ab@example.invalid');
  // Non-string address names fall through to schema rules, never the CSV.
  expect(apexCompanionValue({ name: 'addressCount', type: 'INTEGER', required: true }, MARKER)).toBe(1);
});

test('scalar arg plans populate optionals and omit the unresolvable honestly', () => {
  // All-optional address shape: the optional binds the CSV (no longer omitted).
  expect(planApexScalarArgs([
    { name: 'thisAddressList', type: 'STRING', required: false, maxOccurs: 1 } as never,
  ], MARKER)).toEqual({ args: { thisAddressList: `${MARKER},${MARKER},MC 12345` } });
  // Unresolvable optionals omit; required gaps still miss.
  expect(planApexScalarArgs([
    { name: 'optionalObject', type: 'STRING', required: false },
    { name: 'objectApiName', type: 'STRING', required: false },
  ], MARKER)).toEqual({ args: { optionalObject: MARKER } });
  // Optional identifiers, records, collections, and complex shapes never ride.
  expect(planApexScalarArgs([
    { name: 'recordId', type: 'ID', required: false },
    { name: 'caseObj', type: 'SOBJECT', required: false, sObjectType: 'Case' },
    { name: 'values', type: 'STRING', required: false, maxOccurs: 4 } as never,
    { name: 'input', type: 'STRING', required: false, apexClass: 'Something' } as never,
    { name: 'plain', type: 'STRING', required: false },
  ], MARKER)).toEqual({ args: { plain: MARKER } });
  // Optional undescribed picklists omit; described ones bind.
  expect(planApexScalarArgs([
    { name: 'choice', type: 'PICKLIST', required: false },
    { name: 'mode', type: 'COMBOBOX', required: false, values: [{ value: 'A', active: true }] } as never,
  ], MARKER)).toEqual({ args: { mode: 'A' } });
  expect(planApexScalarArgs([
    { name: 'requestType', type: 'PICKLIST', required: true },
  ], MARKER)).toEqual({ missing: 'requestType' });
});

test('scalar arg plans carry the live object name and detect the need', () => {
  const inputs = [
    { name: 'fieldsToQuery', type: 'STRING', required: true },
    { name: 'numberOfRecords', type: 'INTEGER', required: true },
    { name: 'objectApiName', type: 'STRING', required: true },
  ];
  expect(apexNeedsLiveObjectName(inputs)).toBe(true);
  expect(apexNeedsLiveObjectName([{ name: 'objectApiName', type: 'STRING', required: false }])).toBe(true);
  expect(apexNeedsLiveObjectName([{ name: 'delimiter', type: 'STRING', required: true }])).toBe(false);
  expect(planApexScalarArgs(inputs, MARKER, { objectName: 'Account' }))
    .toEqual({ args: { fieldsToQuery: 'Id', numberOfRecords: 1, objectApiName: 'Account' } });
  expect(planApexScalarArgs(inputs, MARKER)).toEqual({ missing: 'objectApiName' });
});

test('first queryable object mirrors the searcher catalog choice', () => {
  expect(firstQueryableObjectName([
    { name: 'AIApplication', queryable: true },
    { name: 'AcceptedEventRelation', queryable: true },
    { name: 'Account', queryable: true },
  ])).toBe('AcceptedEventRelation');
  expect(firstQueryableObjectName([{ name: 'AIUpdateRecordEvent', queryable: false }])).toBe('AIUpdateRecordEvent');
  expect(firstQueryableObjectName([{ name: 'not an object', queryable: true }])).toBeNull();
  expect(firstQueryableObjectName(null)).toBeNull();
});

test('update-effect proof requires marker intact plus a changed scalar field', () => {
  const email = 'probe-1234567890ab@example.invalid';
  const ok = verifyOwnedSobjectUpdate({
    marker: MARKER,
    markerField: 'LastName',
    before: { Id: '003000000000001AAA', LastName: MARKER, Email: 'placeholder@example.invalid' },
    after: { Id: '003000000000001AAA', LastName: MARKER, Email: email },
    scalarValues: [email],
  });
  expect(ok).toEqual({ verified: true, code: null, effectField: 'Email' });
  // Marker broken: unverified.
  expect(verifyOwnedSobjectUpdate({
    marker: MARKER, markerField: 'LastName',
    before: { LastName: MARKER }, after: { LastName: 'other', Email: email }, scalarValues: [email],
  }).verified).toBe(false);
  // Value present but unchanged: unverified (no proof the invoke caused it).
  expect(verifyOwnedSobjectUpdate({
    marker: MARKER, markerField: 'LastName',
    before: { LastName: MARKER, Email: email }, after: { LastName: MARKER, Email: email }, scalarValues: [email],
  })).toMatchObject({ verified: false, code: 'MUTATION_UPDATE_UNVERIFIED' });
  // No scalar landed: unverified.
  expect(verifyOwnedSobjectUpdate({
    marker: MARKER, markerField: 'LastName',
    before: { LastName: MARKER, Email: 'placeholder@example.invalid' },
    after: { LastName: MARKER, Email: 'placeholder@example.invalid' },
    scalarValues: [email],
  }).verified).toBe(false);
  // Marker field itself never counts as the effect.
  expect(verifyOwnedSobjectUpdate({
    marker: MARKER, markerField: 'LastName',
    before: { LastName: 'x' }, after: { LastName: MARKER }, scalarValues: [MARKER],
  }).verified).toBe(false);
  expect(verifyOwnedSobjectUpdate({
    marker: 'junk', markerField: 'LastName', before: {}, after: {}, scalarValues: [],
  })).toMatchObject({ verified: false, code: 'MUTATION_MARKER_INVALID' });
  expect(verifyOwnedSobjectUpdate({
    marker: MARKER, markerField: 'LastName', before: {}, after: null, scalarValues: [MARKER],
  }).verified).toBe(false);
});

test('absent namespaces match delete-failed and record-not-found shapes', () => {
  expect(contextNamespaceAbsent([
    { message: "Context with id X doesn't exist or expired.", errorCode: 'DELETE_FAILED' },
  ])).toBe(true);
  expect(contextNamespaceAbsent([
    { message: "Context with id X doesn't exist or expired.", errorCode: 'RECORD_NOT_FOUND' },
  ])).toBe(true);
  expect(contextNamespaceAbsent([{ message: 'other failure', errorCode: 'DELETE_FAILED' }])).toBe(false);
  expect(contextNamespaceAbsent([{ message: "Context doesn't exist or expired.", errorCode: 'INVALID_INPUT' }])).toBe(false);
  expect(contextNamespaceAbsent(null)).toBe(false);
});
