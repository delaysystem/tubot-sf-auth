import { test, expect } from 'bun:test';
import {
  APEX_EXEC_BUILDER_VERSION,
  apexExecAccepted,
  apexExecAddressShaped,
  apexExecGeoQueryBinding,
  apexExecGeoQueryInputNames,
  apexExecIdInputIsCollection,
  apexExecMatchObjects,
  apexExecNestedFlags,
  apexExecOutputIds,
  apexExecTomorrowArg,
  apexExecTriggerNpe400,
  apexExecTriggerParentFields,
  apexExecOwnerSeed,
  apexExecPositionSeeds,
  apexExecProbeAddressValues,
  apexExecRecordFallbackObject,
  apexExecRequiredIdInputs,
  apexExecRequiredReferences,
  apexExecStaticArgs,
  invokeApexExecWithContext,
} from './apex-exec-context';

const ROOT = '/services/data/v67.0';
const OWNER = '005000000000001AAA';
const CART_ID = '0a6000000000001AAA';
const ACCOUNT_ID = '001000000000001AAA';
const STORE_ID = '0Zu000000000001AAA';

const result = (body: any, status = 200) => ({ body, status, ok: status < 400 });

test('stem aliases resolve cart and journal platform vocabulary', () => {
  expect(apexExecMatchObjects(['Account', 'WebCart'], 'cartId')).toEqual(['WebCart']);
  expect(apexExecMatchObjects(['Account', 'TransactionJournal'], 'JournalId')).toEqual(['TransactionJournal']);
  // A genuine second match stays ambiguous: alias hits join stem hits.
  expect(apexExecMatchObjects(['Cart__c', 'WebCart'], 'cartId')).toEqual(['Cart__c', 'WebCart']);
  expect(apexExecMatchObjects(['Account', 'Contact'], 'cartId')).toEqual([]);
  expect(apexExecMatchObjects(['Account'], 'recordId')).toEqual([]);
  expect(apexExecMatchObjects(null, 'cartId')).toEqual([]);
});

test('plural Id suffix and field-service aliases resolve short stems', () => {
  expect(apexExecMatchObjects(['Account', 'ServiceAppointment'], 'serviceAppointmentIds'))
    .toEqual(['ServiceAppointment']);
  expect(apexExecMatchObjects(['Account', 'ServiceAppointment'], 'saID')).toEqual(['ServiceAppointment']);
  expect(apexExecMatchObjects(['Account', 'maps__LiveAssetDailySummaryEvent__c'], 'sumEventId'))
    .toEqual(['maps__LiveAssetDailySummaryEvent__c']);
  expect(apexExecMatchObjects(['Account', 'Contact'], 'saID')).toEqual([]);
});

test('address shape matches geocode vocabulary only', () => {
  const geocode = [
    { name: 'inputCity' }, { name: 'inputStreet' }, { name: 'outputLatitude' },
    { name: 'outputErrorMessage' }, { name: 'outputMatchLevel' }, { name: 'recordId', type: 'ID', required: true },
  ];
  expect(apexExecAddressShaped(geocode)).toBe(true);
  expect(apexExecAddressShaped([{ name: 'outputErrorMessage' }, { name: 'recordId' }])).toBe(false);
  expect(apexExecAddressShaped([{ name: 'Status' }, { name: 'recordId' }])).toBe(false);
  expect(apexExecAddressShaped([])).toBe(false);
  expect(apexExecAddressShaped(null)).toBe(false);
});

test('record fallback prefers live address-bearing standard objects', () => {
  const inputs = [{ name: 'inputCity' }, { name: 'recordId', type: 'ID', required: true }];
  expect(apexExecRecordFallbackObject(['Contact', 'Account', 'Lead'], 'recordId', inputs)).toBe('Account');
  expect(apexExecRecordFallbackObject(['Contact', 'Lead'], 'recordId', inputs)).toBe('Contact');
  expect(apexExecRecordFallbackObject(['Lead'], 'recordId', inputs)).toBe('Lead');
  expect(apexExecRecordFallbackObject(['Order'], 'recordId', inputs)).toBeNull();
  expect(apexExecRecordFallbackObject(['Account'], 'serviceOrderId', inputs)).toBeNull();
  expect(apexExecRecordFallbackObject(['Account'], 'recordId', [{ name: 'recordId' }])).toBeNull();
  expect(apexExecRecordFallbackObject(null, 'recordId', inputs)).toBeNull();
});

test('probe address uses standard field vocabulary per object', () => {
  expect(apexExecProbeAddressValues('Account')).toMatchObject({
    BillingStreet: expect.any(String), BillingCity: expect.any(String), BillingCountry: expect.any(String),
  });
  expect(apexExecProbeAddressValues('Contact')).toMatchObject({ MailingStreet: expect.any(String) });
  expect(apexExecProbeAddressValues('Lead')).toMatchObject({ Street: expect.any(String) });
  expect(apexExecProbeAddressValues('Order')).toBeNull();
});

test('required references mirror synthesis requiredness and fail polymorphic closed', () => {
  const fields = [
    { name: 'WebStoreId', type: 'reference', nillable: false, createable: true, referenceTo: ['WebStore'] },
    { name: 'AccountId', type: 'reference', nillable: false, createable: true, referenceTo: ['Account'] },
    { name: 'ParentId', type: 'reference', nillable: false, createable: true, referenceTo: ['Account', 'Contact'] },
    { name: 'OwnerId', type: 'reference', nillable: false, defaultedOnCreate: true, createable: true, referenceTo: ['User'] },
    { name: 'Name', type: 'string', nillable: false, createable: true },
    { name: 'Status', type: 'picklist', nillable: true, createable: true },
  ];
  expect(apexExecRequiredReferences(fields)).toEqual([
    { field: 'WebStoreId', target: 'WebStore' },
    { field: 'AccountId', target: 'Account' },
    { field: 'ParentId', target: '' },
  ]);
  expect(apexExecRequiredReferences([])).toEqual([]);
});

test('static args and acceptance keep legacy semantics', () => {
  expect(apexExecRequiredIdInputs([{ name: 'cartId', type: 'ID', required: true }])).toEqual(['cartId']);
  expect(apexExecStaticArgs([
    { name: 'cartId', type: 'ID', required: true },
    { name: 'dryRun', type: 'BOOLEAN', required: true },
    { name: 'retries', type: 'INTEGER', required: true },
    { name: 'note', type: 'STRING', required: false },
  ], 'cartId')).toEqual({ dryRun: false, retries: 0 });
  expect(apexExecStaticArgs([{ name: 'cartId', type: 'ID', required: true },
    { name: 'note', type: 'STRING', required: true }], 'cartId')).toBeNull();
  const ok = [{ isSuccess: true, errors: null, outputValues: { id: CART_ID } }];
  expect(apexExecAccepted(200, ok).accepted).toBe(true);
  expect(apexExecNestedFlags({ id: CART_ID })).toBe(false);
  expect(apexExecOutputIds({ id: CART_ID })).toEqual([CART_ID]);
});

test('static args bind equal-tomorrow dates; collections and id arrays', () => {
  const args = apexExecStaticArgs([
    { name: 'serviceAppointmentIds', type: 'ID', required: true, maxOccurs: 2000 },
    { name: 'fromDate', type: 'DATE', required: true },
    { name: 'toDate', type: 'DATE', required: true },
    { name: 'runAt', type: 'DATETIME', required: true },
    { name: 'shouldSchedule', type: 'BOOLEAN', required: false },
    { name: 'note', type: 'STRING', required: false },
    { name: 'policyId', type: 'ID', required: false },
  ], 'serviceAppointmentIds') as Record<string, string>;
  expect(args.fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(args.toDate).toBe(args.fromDate);
  expect(args.runAt).toBe(`${args.fromDate}T00:00:00.000Z`);
  expect(args.shouldSchedule).toBe(false);
  expect('note' in args).toBe(false);
  expect('policyId' in args).toBe(false);
  expect(apexExecTomorrowArg('DATE')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(apexExecIdInputIsCollection([
    { name: 'serviceAppointmentIds', type: 'ID', required: true, maxOccurs: 2000 },
    { name: 'territoryId', type: 'ID', required: true },
  ], 'serviceAppointmentIds')).toBe(true);
  expect(apexExecIdInputIsCollection([
    { name: 'territoryId', type: 'ID', required: true },
  ], 'territoryId')).toBe(false);
  expect(apexExecIdInputIsCollection([], 'missing')).toBe(false);
  const cloneId = '08p000000000001AAA';
  expect(apexExecOutputIds({ clonedServiceAppointmentIds: [cloneId], id: CART_ID }))
    .toEqual([cloneId, CART_ID]);
  expect(apexExecOutputIds({ nested: { id: CART_ID } })).toEqual([]);
});

test('trigger-NPE retry matches managed before-insert dereferences only', () => {
  const npe = [{ message: 'FSL.TR001_Service_BeforeInsert: execution of BeforeInsert caused by: System.NullPointerException: Attempt to de-reference a null object', errorCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY' }];
  expect(apexExecTriggerNpe400({ status: 400, body: npe })).toBe(true);
  expect(apexExecTriggerNpe400({ status: 400, body: [{ message: 'Required fields are missing', errorCode: 'REQUIRED_FIELD_MISSING' }] })).toBe(false);
  expect(apexExecTriggerNpe400({ status: 200, body: npe })).toBe(false);
  expect(apexExecTriggerNpe400({ status: 400, body: null })).toBe(false);
});

test('position seeds bind createable components, skip the rest', () => {
  expect(apexExecPositionSeeds([
    { name: 'maps__Position__c', type: 'location' },
    { name: 'maps__Position__Latitude__s', type: 'double', createable: true },
    { name: 'maps__Position__Longitude__s', type: 'double', createable: true },
    { name: 'Name', type: 'string' },
  ])).toEqual({ maps__Position__Latitude__s: 37.7749, maps__Position__Longitude__s: -122.4194 });
  expect(apexExecPositionSeeds([
    { name: 'maps__Position__c', type: 'location' },
    { name: 'maps__Position__Latitude__s', type: 'double', createable: false },
    { name: 'maps__Position__Longitude__s', type: 'double', createable: true },
  ])).toEqual({});
  expect(apexExecPositionSeeds([{ name: 'Name', type: 'string' }])).toEqual({});
  expect(apexExecPositionSeeds([])).toEqual({});
});

test('owner seed follows the live describe, never assumed', () => {
  const owner = '005000000000001AAA';
  expect(apexExecOwnerSeed([{ name: 'OwnerId', type: 'reference' }], owner)).toEqual({ OwnerId: owner });
  expect(apexExecOwnerSeed([{ name: 'Name', type: 'string' }], owner)).toEqual({});
  expect(apexExecOwnerSeed([], owner)).toEqual({});
});

test('trigger-parent fields find nillable ParentRecordId references only', () => {
  const fields = [
    { name: 'ParentRecordId', type: 'reference', nillable: true, createable: true, referenceTo: ['Account', 'WorkOrder'] },
    { name: 'ServiceTerritoryId', type: 'reference', nillable: true, createable: true, referenceTo: ['ServiceTerritory'] },
    { name: 'OwnerId', type: 'reference', nillable: false, createable: true, referenceTo: ['User'] },
    { name: 'Subject', type: 'string', nillable: true, createable: true },
  ];
  expect(apexExecTriggerParentFields(fields)).toEqual([
    { field: 'ParentRecordId', targets: ['Account', 'WorkOrder'] },
  ]);
  expect(apexExecTriggerParentFields([])).toEqual([]);
});

type HarnessOptions = {
  inputs?: any[];
  catalog?: string[];
  describe?: any;
  parents?: Record<string, string | null>;
  invoke?: any;
  /** Object name whose first POST fails with a trigger-NPE 400 (retry path). */
  npeFirstPost?: string;
};
function harness(route: string, options: HarnessOptions = {}) {
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  let fixture: any = null;
  let fixtureId = CART_ID;
  const postCounts = new Map<string, number>();
  const defaultDescribe = {
    createable: true, deletable: true, queryable: true,
    fields: [{ name: 'Name', type: 'string', length: 80, createable: true, filterable: true }],
  };
  const rawDescribe = options.describe ?? defaultDescribe;
  // A describe WITH fields applies to every object; without, it maps names.
  const describeFor = (name: string) => ('fields' in rawDescribe ? rawDescribe : (rawDescribe[name] ?? defaultDescribe));
  const request = async (path: string, method = 'GET', body?: any) => {
    calls.push({ path, method, body });
    if (method === 'GET' && path === route) return result({ inputs: options.inputs ?? [] });
    if (path === `${ROOT}/sobjects/`) {
      return result({ sobjects: (options.catalog ?? ['Account', 'WebCart']).map((name) => ({ name })) });
    }
    const describeMatch = path.match(new RegExp(`^${ROOT.replace(/\//g, '\\/')}/sobjects/([A-Za-z][A-Za-z0-9_]+)/describe$`));
    if (method === 'GET' && describeMatch) return result(describeFor(describeMatch[1]));
    if (path.startsWith(`${ROOT}/query?q=`)) {
      const soql = decodeURIComponent(path.slice(`${ROOT}/query?q=`.length));
      if (soql.startsWith('SELECT COUNT()')) return result({ totalSize: 0 });
      const from = soql.match(/FROM ([A-Za-z][A-Za-z0-9_]+)/)?.[1] ?? '';
      const id = options.parents?.[from];
      if (from === fixtureObjectName() && soql.includes('WHERE')) return result({ records: [] });
      return result({ records: typeof id === 'string' ? [{ Id: id }] : [] });
    }
    const objectMatch = path.match(new RegExp(`^${ROOT.replace(/\//g, '\\/')}/sobjects/([A-Za-z][A-Za-z0-9_]+)$`));
    if (method === 'POST' && objectMatch) {
      const seen = (postCounts.get(objectMatch[1]) ?? 0) + 1;
      postCounts.set(objectMatch[1], seen);
      if (options.npeFirstPost === objectMatch[1] && seen === 1) {
        return result([{ message: 'TR001_X: execution of BeforeInsert caused by: System.NullPointerException: Attempt to de-reference a null object', errorCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY' }], 400);
      }
      fixtureId = objectMatch[1] === 'Account' ? ACCOUNT_ID : CART_ID;
      fixture = { ...body, Id: fixtureId };
      return result({ id: fixtureId }, 201);
    }
    const rowMatch = path.match(new RegExp(`^${ROOT.replace(/\//g, '\\/')}/sobjects/([A-Za-z][A-Za-z0-9_]+)/([A-Za-z0-9]+)$`));
    if (rowMatch) {
      if (method === 'DELETE') { fixture = null; return result(null, 204); }
      return fixture && rowMatch[2] === fixtureId ? result(fixture) : result([], 404);
    }
    if (method === 'POST' && path === route) return result(options.invoke ?? []);
    throw new Error(`unexpected call ${method} ${path}`);
  };
  const builds: Array<{ name: string; marker: string; values: any }> = [];
  const build = async (name: string, marker: string, values: any) => {
    builds.push({ name, marker, values });
    return { values };
  };
  const fixtureObjectName = () => builds[0]?.name ?? 'WebCart';
  return { request, build, calls, builds };
}

const CART_ROUTE = `${ROOT}/actions/custom/apex/OMSOrderEntry__AuthorizeTokenizedPayment`;
const CART_INPUTS = [{ name: 'cartId', type: 'ID', required: true }];
const WEB_CART_DESCRIBE = {
  createable: true, deletable: true, queryable: true,
  fields: [
    { name: 'Name', type: 'string', length: 80, createable: true, filterable: true },
    { name: 'OwnerId', type: 'reference', nillable: false, createable: false, referenceTo: ['User'] },
    { name: 'WebStoreId', type: 'reference', nillable: false, createable: true, referenceTo: ['WebStore'] },
    { name: 'AccountId', type: 'reference', nillable: false, createable: true, referenceTo: ['Account'] },
  ],
};

test('cart alias resolves WebCart and seeds live parents before synthesis', async () => {
  const h = harness(CART_ROUTE, { inputs: CART_INPUTS, describe: WEB_CART_DESCRIBE,
    parents: { WebStore: STORE_ID, Account: ACCOUNT_ID },
    invoke: [{ isSuccess: true, errors: null, outputValues: {} }] });
  const outcome = await invokeApexExecWithContext({ root: ROOT, route: CART_ROUTE,
    ownerUserId: OWNER, request: h.request, build: h.build });
  expect(outcome.status).toBe(200);
  expect(h.builds).toHaveLength(1);
  expect(h.builds[0].name).toBe('WebCart');
  expect(h.builds[0].values).toMatchObject({ WebStoreId: STORE_ID, AccountId: ACCOUNT_ID, OwnerId: OWNER });
  const posted = h.calls.find((call) => call.method === 'POST' && call.path === CART_ROUTE);
  expect(posted?.body).toEqual({ inputs: [{ cartId: CART_ID }] });
  expect(outcome.contextSchema?.fixtureObject).toBe('WebCart');
});

test('rowless parents refuse with no fixture and no apex POST', async () => {
  const h = harness(CART_ROUTE, { inputs: CART_INPUTS, describe: WEB_CART_DESCRIBE,
    parents: { WebStore: null, Account: ACCOUNT_ID } });
  const outcome = await invokeApexExecWithContext({ root: ROOT, route: CART_ROUTE,
    ownerUserId: OWNER, request: h.request, build: h.build });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('APEX_EXEC_PARENT_ROWLESS');
  expect(h.builds).toHaveLength(0);
  expect(h.calls.some((call) => call.method === 'POST' && call.path === CART_ROUTE)).toBe(false);
});

test('polymorphic required parents refuse as ambiguous', async () => {
  const h = harness(CART_ROUTE, { inputs: CART_INPUTS,
    describe: { createable: true, deletable: true, queryable: true, fields: [
      { name: 'Name', type: 'string', length: 80, createable: true, filterable: true },
      { name: 'ParentId', type: 'reference', nillable: false, createable: true, referenceTo: ['Account', 'Contact'] },
    ] } });
  const outcome = await invokeApexExecWithContext({ root: ROOT, route: CART_ROUTE,
    ownerUserId: OWNER, request: h.request, build: h.build });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('APEX_EXEC_PARENT_AMBIGUOUS');
  expect(h.calls.some((call) => call.method === 'POST' && call.path === CART_ROUTE)).toBe(false);
});

test('rowless single-target parents mint one owned row, child cleaned first', async () => {
  const route = `${ROOT}/actions/custom/apex/NS__TicketAction`;
  const h = harness(route, {
    inputs: [{ name: 'ticketId', type: 'ID', required: true }],
    catalog: ['Account', 'Ticket__c'],
    describe: {
      Ticket__c: { createable: true, deletable: true, queryable: true, fields: [
        { name: 'Name', type: 'string', length: 80, createable: true, filterable: true },
        { name: 'SummaryRef__c', type: 'reference', nillable: false, createable: true, referenceTo: ['Summary__c'] },
      ] },
      Summary__c: { createable: true, deletable: true, queryable: true, fields: [
        { name: 'Name', type: 'string', length: 80, createable: true, filterable: true },
      ] },
    },
    invoke: [{ isSuccess: true, errors: null, outputValues: {} }],
  });
  const outcome = await invokeApexExecWithContext({ root: ROOT, route,
    ownerUserId: OWNER, request: h.request, build: h.build });
  expect(outcome.status).toBe(200);
  expect(h.builds).toHaveLength(2);
  expect(h.builds[0].name).toBe('Summary__c');
  expect(h.builds[0].values.Name).toMatch(/^AE [0-9a-f]{12}$/);
  expect(h.builds[1].name).toBe('Ticket__c');
  expect(h.builds[1].values.SummaryRef__c).toBe(CART_ID);
  const deletes = h.calls.filter((call) => call.method === 'DELETE').map((call) => call.path);
  expect(deletes).toEqual([
    `${ROOT}/sobjects/Ticket__c/${CART_ID}`,
    `${ROOT}/sobjects/Summary__c/${CART_ID}`,
  ]);
  expect(outcome.cleanupError).toBeUndefined();
});

test('trigger-NPE fixture retries once with a live parent bound', async () => {
  const route = `${ROOT}/actions/custom/apex/NS__TicketQuery`;
  const h = harness(route, {
    inputs: [{ name: 'ticketId', type: 'ID', required: true }],
    catalog: ['Account', 'Ticket__c'],
    describe: { createable: true, deletable: true, queryable: true, fields: [
      { name: 'Name', type: 'string', length: 80, createable: true, filterable: true },
      { name: 'ParentRecordId', type: 'reference', nillable: true, createable: true, referenceTo: ['Account'] },
    ] },
    parents: { Account: ACCOUNT_ID },
    npeFirstPost: 'Ticket__c',
    invoke: [{ isSuccess: true, errors: null, outputValues: {} }],
  });
  const outcome = await invokeApexExecWithContext({ root: ROOT, route,
    ownerUserId: OWNER, request: h.request, build: h.build });
  expect(outcome.status).toBe(200);
  const posts = h.calls.filter((call) => call.method === 'POST' && call.path === `${ROOT}/sobjects/Ticket__c`);
  expect(posts).toHaveLength(2);
  expect(posts[0].body.ParentRecordId).toBeUndefined();
  expect(posts[1].body.ParentRecordId).toBe(ACCOUNT_ID);
  expect(outcome.cleanupError).toBeUndefined();
});

const GEO_ROUTE = `${ROOT}/actions/custom/apex/maps__GeocodeRecordInvocable`;
const GEO_INPUTS = [
  { name: 'inputCity', type: 'STRING', required: false },
  { name: 'inputStreet', type: 'STRING', required: false },
  { name: 'outputLatitude', type: 'STRING', required: false },
  { name: 'recordId', type: 'ID', required: true },
];
const ACCOUNT_DESCRIBE = {
  createable: true, deletable: true, queryable: true,
  fields: [
    { name: 'Name', type: 'string', length: 80, createable: true, filterable: true },
    { name: 'BillingStreet', type: 'textarea', nillable: true, createable: true },
  ],
};

test('object-agnostic geocode shape falls back to an addressed Account fixture', async () => {
  const h = harness(GEO_ROUTE, { inputs: GEO_INPUTS, catalog: ['Account', 'Contact'],
    describe: ACCOUNT_DESCRIBE,
    invoke: [{ isSuccess: true, errors: null, outputValues: { Success: true, errorMessage: null } }] });
  const outcome = await invokeApexExecWithContext({ root: ROOT, route: GEO_ROUTE,
    ownerUserId: OWNER, request: h.request, build: h.build });
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema?.fixtureObject).toBe('Account');
  expect(h.builds[0].values).toMatchObject({
    BillingStreet: expect.any(String), BillingCity: expect.any(String), BillingPostalCode: expect.any(String),
  });
  const posted = h.calls.find((call) => call.method === 'POST' && call.path === GEO_ROUTE);
  expect(posted?.body).toEqual({ inputs: [{ recordId: ACCOUNT_ID }] });
});

test('geo-query naming pair matches ApiName vocabulary only', () => {
  const geo = [
    { name: 'latLongGeoFieldApiName', type: 'STRING', required: true },
    { name: 'queryObjApiName', type: 'STRING', required: true },
    { name: 'sumEventId', type: 'ID', required: true },
  ];
  expect(apexExecGeoQueryInputNames(geo, 'sumEventId'))
    .toEqual({ objInput: 'queryObjApiName', fieldInput: 'latLongGeoFieldApiName' });
  // Boolean/numeric required inputs ride along as zero values.
  expect(apexExecGeoQueryInputNames(
    [...geo, { name: 'maxResults', type: 'INTEGER', required: true }], 'sumEventId'))
    .toEqual({ objInput: 'queryObjApiName', fieldInput: 'latLongGeoFieldApiName' });
  // A third naming string, an ungeohinted field, or a missing pair refuses.
  expect(apexExecGeoQueryInputNames(
    [...geo, { name: 'label', type: 'STRING', required: true }], 'sumEventId')).toBeNull();
  expect(apexExecGeoQueryInputNames([
    { name: 'ownerFieldApiName', type: 'STRING', required: true },
    { name: 'queryObjApiName', type: 'STRING', required: true },
    { name: 'sumEventId', type: 'ID', required: true },
  ], 'sumEventId')).toBeNull();
  expect(apexExecGeoQueryInputNames([
    { name: 'queryObjApiName', type: 'STRING', required: true },
    { name: 'sumEventId', type: 'ID', required: true },
  ], 'sumEventId')).toBeNull();
  expect(apexExecGeoQueryInputNames('nope', 'sumEventId')).toBeNull();
});

test('geo-query binding takes the first live location field in scan order', () => {
  const account = { objectName: 'Account', fields: [{ name: 'Name', type: 'string' }] };
  const contact = { objectName: 'Contact', fields: [
    { name: 'MailingAddress', type: 'address' },
    { name: 'HomeGeo__c', type: 'location' },
  ] };
  expect(apexExecGeoQueryBinding([account, contact])).toEqual({ objectName: 'Contact', fieldName: 'HomeGeo__c' });
  expect(apexExecGeoQueryBinding([account])).toBeNull();
  expect(apexExecGeoQueryBinding([null, { objectName: 'Bad Name!', fields: [] }])).toBeNull();
  expect(apexExecGeoQueryBinding(null)).toBeNull();
});

const GEO_QUERY_ROUTE = `${ROOT}/actions/custom/apex/maps__LiveGetClosestRecordInvocable`;
const GEO_QUERY_INPUTS = [
  { name: 'latLongGeoFieldApiName', type: 'STRING', required: true },
  { name: 'queryObjApiName', type: 'STRING', required: true },
  { name: 'sumEventId', type: 'ID', required: true },
];
const LOCATION_DESCRIBE = {
  createable: true, deletable: true, queryable: true,
  fields: [
    { name: 'Name', type: 'string', length: 80, createable: true, filterable: true },
    { name: 'SDO_SFS_ShippingGeo__c', type: 'location', custom: true, nillable: true },
  ],
};

test('geo-query args bind live, then the vendor-minted reference stays unresolved', async () => {
  const h = harness(GEO_QUERY_ROUTE, { inputs: GEO_QUERY_INPUTS, catalog: ['Account', 'Contact'],
    describe: LOCATION_DESCRIBE });
  const outcome = await invokeApexExecWithContext({ root: ROOT, route: GEO_QUERY_ROUTE,
    ownerUserId: OWNER, request: h.request, build: h.build });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('APEX_EXEC_OBJECT_UNRESOLVED');
  expect(outcome.body.message).toContain('sumEventId');
  // The naming strings bound from live schema (describes fetched); the apex POST never ran.
  expect(h.calls.some((call) => call.path === `${ROOT}/sobjects/Account/describe`)).toBe(true);
  expect(h.calls.some((call) => call.method === 'POST' && call.path === GEO_QUERY_ROUTE)).toBe(false);
});

test('geo-query invokes with bound names when the event object exists', async () => {
  const h = harness(GEO_QUERY_ROUTE, { inputs: GEO_QUERY_INPUTS, catalog: ['Account', 'SumEvent__c'],
    describe: LOCATION_DESCRIBE,
    invoke: [{ isSuccess: true, errors: null, outputValues: {} }] });
  const outcome = await invokeApexExecWithContext({ root: ROOT, route: GEO_QUERY_ROUTE,
    ownerUserId: OWNER, request: h.request, build: h.build });
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema?.fixtureObject).toBe('SumEvent__c');
  const posted = h.calls.find((call) => call.method === 'POST' && call.path === GEO_QUERY_ROUTE);
  expect(posted?.body).toEqual({ inputs: [{
    queryObjApiName: 'Account', latLongGeoFieldApiName: 'SDO_SFS_ShippingGeo__c', sumEventId: CART_ID,
  }] });
});

test('geo-query foreign hits verify; other lanes fail unadopted ids', async () => {
  const foreign = '001000000000001AAA';
  const geo = harness(GEO_QUERY_ROUTE, { inputs: GEO_QUERY_INPUTS, catalog: ['Account', 'SumEvent__c'],
    describe: LOCATION_DESCRIBE,
    invoke: [{ isSuccess: true, errors: null, outputValues: { distanceKM: 1.78, objId: foreign } }] });
  const geoOutcome = await invokeApexExecWithContext({ root: ROOT, route: GEO_QUERY_ROUTE,
    ownerUserId: OWNER, request: geo.request, build: geo.build });
  expect(geoOutcome.status).toBe(200);
  expect(geoOutcome.contextSchema?.verified).toBe(true);
  expect(geoOutcome.cleanupError).toBeUndefined();
  // Non-query lane: the same foreign id is an unverified side effect.
  const plain = harness(CART_ROUTE, { inputs: CART_INPUTS, describe: WEB_CART_DESCRIBE,
    parents: { WebStore: STORE_ID, Account: ACCOUNT_ID },
    invoke: [{ isSuccess: true, errors: null, outputValues: { objId: foreign } }] });
  const plainOutcome = await invokeApexExecWithContext({ root: ROOT, route: CART_ROUTE,
    ownerUserId: OWNER, request: plain.request, build: plain.build });
  expect(plainOutcome.status).toBe(200);
  expect(plainOutcome.contextSchema?.verified).toBe(false);
});

test('builder version is pinned', () => {
  expect(APEX_EXEC_BUILDER_VERSION).toBe(1);
});

test('static args skip every required id input', () => {
  const inputs = [
    { name: 'cartId', type: 'ID', required: true },
    { name: 'checkoutSessionId', type: 'ID', required: true },
    { name: 'dedupe', type: 'BOOLEAN', required: true },
  ];
  expect(apexExecStaticArgs(inputs, ['cartId', 'checkoutSessionId'])).toEqual({ dedupe: false });
  expect(apexExecStaticArgs(inputs, 'cartId')).toBeNull();
});

/** Live WebCart shape: AccountId nillable, polymorphic, createable. */
const LIVE_WEB_CART_DESCRIBE = {
  createable: true, deletable: true, queryable: true,
  fields: [
    { name: 'Name', type: 'string', length: 80, createable: true, filterable: true },
    { name: 'WebStoreId', type: 'reference', nillable: false, createable: true, referenceTo: ['WebStore'] },
    { name: 'AccountId', type: 'reference', nillable: true, createable: true,
      referenceTo: ['Account', 'GuestBuyerProfile', 'User'] },
  ],
};

test('nillable commercial AccountId borrows a live Account before synthesis', async () => {
  const h = harness(CART_ROUTE, { inputs: CART_INPUTS, describe: LIVE_WEB_CART_DESCRIBE,
    parents: { WebStore: STORE_ID, Account: ACCOUNT_ID },
    invoke: [{ isSuccess: true, errors: null, outputValues: {} }] });
  const outcome = await invokeApexExecWithContext({ root: ROOT, route: CART_ROUTE,
    ownerUserId: OWNER, request: h.request, build: h.build });
  expect(outcome.status).toBe(200);
  expect(h.builds).toHaveLength(1);
  expect(h.builds[0].values).toMatchObject({ WebStoreId: STORE_ID, AccountId: ACCOUNT_ID });
  const posted = h.calls.find((call) => call.method === 'POST' && call.path === CART_ROUTE);
  expect(posted?.body).toEqual({ inputs: [{ cartId: CART_ID }] });
});

test('rowless orgs mint an owned Account parent for the commercial link', async () => {
  const h = harness(CART_ROUTE, { inputs: CART_INPUTS, describe: LIVE_WEB_CART_DESCRIBE,
    parents: { WebStore: STORE_ID },
    invoke: [{ isSuccess: true, errors: null, outputValues: {} }] });
  const outcome = await invokeApexExecWithContext({ root: ROOT, route: CART_ROUTE,
    ownerUserId: OWNER, request: h.request, build: h.build });
  expect(outcome.status).toBe(200);
  expect(h.builds).toHaveLength(2);
  expect(h.builds[0].name).toBe('Account');
  expect(h.builds[1].name).toBe('WebCart');
  expect(h.builds[1].values.AccountId).toBe(ACCOUNT_ID);
  const deletes = h.calls.filter((call) => call.method === 'DELETE').map((call) => call.path);
  expect(deletes).toContain(`${ROOT}/sobjects/WebCart/${CART_ID}`);
  expect(deletes).toContain(`${ROOT}/sobjects/Account/${ACCOUNT_ID}`);
  // Child deletes before the minted parent.
  expect(deletes.indexOf(`${ROOT}/sobjects/WebCart/${CART_ID}`))
    .toBeLessThan(deletes.indexOf(`${ROOT}/sobjects/Account/${ACCOUNT_ID}`));
});

test('every required id input provisions a fixture and rides the invoke', async () => {
  const inputs = [
    { name: 'cartId', type: 'ID', required: true },
    { name: 'orderId', type: 'ID', required: true, sObjectType: 'Order' },
  ];
  const h = harness(CART_ROUTE, { inputs, describe: WEB_CART_DESCRIBE,
    parents: { WebStore: STORE_ID, Account: ACCOUNT_ID },
    invoke: [{ isSuccess: true, errors: null, outputValues: {} }] });
  const outcome = await invokeApexExecWithContext({ root: ROOT, route: CART_ROUTE,
    ownerUserId: OWNER, request: h.request, build: h.build });
  expect(outcome.status).toBe(200);
  expect(h.builds.map((b) => b.name)).toEqual(['WebCart', 'Order']);
  const posted = h.calls.find((call) => call.method === 'POST' && call.path === CART_ROUTE);
  expect(posted?.body).toEqual({ inputs: [{ cartId: CART_ID, orderId: CART_ID }] });
  expect(outcome.contextSchema?.idValues).toEqual({ cartId: CART_ID, orderId: CART_ID });
  expect(outcome.contextSchema?.fixtureObjects).toEqual(['WebCart', 'Order']);
});

test('inputs sharing one object share its fixture row', async () => {
  const inputs = [
    { name: 'cartId', type: 'ID', required: true },
    { name: 'sourceCartId', type: 'ID', required: true, sObjectType: 'WebCart' },
  ];
  const h = harness(CART_ROUTE, { inputs, describe: WEB_CART_DESCRIBE,
    parents: { WebStore: STORE_ID, Account: ACCOUNT_ID },
    invoke: [{ isSuccess: true, errors: null, outputValues: {} }] });
  const outcome = await invokeApexExecWithContext({ root: ROOT, route: CART_ROUTE,
    ownerUserId: OWNER, request: h.request, build: h.build });
  expect(outcome.status).toBe(200);
  expect(h.builds).toHaveLength(1);
  const posted = h.calls.find((call) => call.method === 'POST' && call.path === CART_ROUTE);
  expect(posted?.body).toEqual({ inputs: [{ cartId: CART_ID, sourceCartId: CART_ID }] });
});

test('an unresolvable companion id refuses with no fixture and no apex POST', async () => {
  const inputs = [
    { name: 'cartId', type: 'ID', required: true },
    { name: 'checkoutSessionId', type: 'ID', required: true },
  ];
  const h = harness(CART_ROUTE, { inputs, describe: WEB_CART_DESCRIBE, catalog: ['Account', 'WebCart'] });
  const outcome = await invokeApexExecWithContext({ root: ROOT, route: CART_ROUTE,
    ownerUserId: OWNER, request: h.request, build: h.build });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('APEX_EXEC_OBJECT_UNRESOLVED');
  expect(outcome.body.message).toContain('checkoutSessionId');
  expect(h.builds).toHaveLength(0);
  expect(h.calls.some((call) => call.method === 'POST' && call.path === CART_ROUTE)).toBe(false);
});

test('live geocode descriptor shape invokes with the fallback record id', async () => {
  const fullInputs = [
    'inputCity', 'inputCountry', 'inputPostalCode', 'inputState', 'inputStreet',
    'outputCity', 'outputCountry', 'outputErrorMessage', 'outputFullAddress',
    'outputLatitude', 'outputLongitude', 'outputMatchLevel', 'outputPostalCode',
    'outputRelevance', 'outputState', 'outputStreet',
  ].map((name) => ({ name, type: 'STRING', required: false, sObjectType: null, maxOccurs: 1 }));
  fullInputs.push({ name: 'recordId', type: 'ID', required: true, sObjectType: null, maxOccurs: 1 } as any);
  const h = harness(GEO_ROUTE, { inputs: fullInputs, catalog: ['Account', 'Contact'],
    describe: ACCOUNT_DESCRIBE,
    invoke: [{ isSuccess: true, errors: null, outputValues: {} }] });
  const outcome = await invokeApexExecWithContext({ root: ROOT, route: GEO_ROUTE,
    ownerUserId: OWNER, request: h.request, build: h.build });
  expect(outcome.status).toBe(200);
  const posted = h.calls.find((call) => call.method === 'POST' && call.path === GEO_ROUTE);
  expect(posted?.body).toEqual({ inputs: [{ recordId: ACCOUNT_ID }] });
});

test('record fallback stays unresolved without address shape or fallback object', async () => {
  const plain = harness(GEO_ROUTE, { inputs: [{ name: 'recordId', type: 'ID', required: true }],
    catalog: ['Account'] });
  const noShape = await invokeApexExecWithContext({ root: ROOT, route: GEO_ROUTE,
    ownerUserId: OWNER, request: plain.request, build: plain.build });
  expect(noShape.status).toBe(422);
  expect(noShape.body.errorCode).toBe('APEX_EXEC_OBJECT_UNRESOLVED');
  const rowless = harness(GEO_ROUTE, { inputs: GEO_INPUTS, catalog: ['Order'] });
  const noFallback = await invokeApexExecWithContext({ root: ROOT, route: GEO_ROUTE,
    ownerUserId: OWNER, request: rowless.request, build: rowless.build });
  expect(noFallback.status).toBe(422);
  expect(noFallback.body.errorCode).toBe('APEX_EXEC_OBJECT_UNRESOLVED');
});
