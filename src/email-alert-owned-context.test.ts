import { test, expect } from 'bun:test';
import {
  EMAIL_ALERT_BUILDER_VERSION,
  emailAlertRouteParts,
  isEmailAlertOwnedContextRoute,
  emailAlertInvocationInput,
  emailAlertSendAccepted,
  emailAlertExistenceRefused,
  emailAlertMarkerField,
  emailAlertPlatformManagedRequiredFields,
  emailAlertSeedableEmailFields,
  emailAlertEmailTypedFields,
  emailAlertRecipientsAllowable,
  emailAlertSenderProof,
  invokeEmailAlertWithContext,
} from './email-alert-owned-context';

const ROOT = '/services/data/v67.0';
const OBJECT = 'sfcma__Subscription__c';
const ALERT = 'sfcma__BillingReminder_Customer_Notification';
const ROUTE = `${ROOT}/actions/custom/emailAlert/${OBJECT}/${ALERT}`;
const SELF = '005000000000001AAA';
const OWNED_ID = 'a0T000000000001AAA';
const ALERT_ID = '0Wo000000000001AAA';

test('emailAlert routes classify by live two-segment route shape only', () => {
  expect(emailAlertRouteParts(ROUTE)).toEqual({ objectName: OBJECT, alertName: ALERT });
  expect(emailAlertRouteParts(`${ROOT}/actions/custom/emailAlert/Order/Ship_Notice`))
    .toEqual({ objectName: 'Order', alertName: 'Ship_Notice' });
  expect(emailAlertRouteParts(`${ROOT}/actions/custom/sendNotification/amount_updated`)).toBeNull();
  expect(emailAlertRouteParts(`${ROOT}/actions/standard/submit`)).toBeNull();
  expect(emailAlertRouteParts(`${ROOT}/actions/custom/flow/Some_Flow`)).toBeNull();
  expect(emailAlertRouteParts(`${ROOT}/actions/custom/apex/SomeClass`)).toBeNull();
  expect(emailAlertRouteParts('not a route')).toBeNull();
  expect(isEmailAlertOwnedContextRoute(ROUTE, 'custom/emailAlert')).toBe(true);
  expect(isEmailAlertOwnedContextRoute(ROUTE)).toBe(true);
  expect(isEmailAlertOwnedContextRoute(`${ROOT}/actions/standard/submit`, 'standard')).toBe(false);
});

test('row-id input resolves dynamically from the live descriptor', () => {
  const live = { targetEntityName: OBJECT, inputs: [{ name: 'SObjectRowId', type: 'ID', required: true, maxOccurs: 1 }] };
  expect(emailAlertInvocationInput(live, OBJECT)).toEqual({ rowIdField: 'SObjectRowId' });
  const renamed = { targetEntityName: OBJECT, inputs: [{ name: 'recordRef', type: 'id', required: true, maxOccurs: 1 }] };
  expect(emailAlertInvocationInput(renamed, OBJECT)).toEqual({ rowIdField: 'recordRef' });
  expect('failure' in emailAlertInvocationInput({ ...live, targetEntityName: 'Order' }, OBJECT)).toBe(true);
  expect('failure' in emailAlertInvocationInput({ targetEntityName: OBJECT, inputs: [] }, OBJECT)).toBe(true);
  expect('failure' in emailAlertInvocationInput({
    targetEntityName: OBJECT,
    inputs: [
      { name: 'first', type: 'ID', required: true, maxOccurs: 1 },
      { name: 'second', type: 'ID', required: true, maxOccurs: 1 },
    ],
  }, OBJECT)).toBe(true);
  expect('failure' in emailAlertInvocationInput(null, OBJECT)).toBe(true);
});

test('marker and email fields resolve from the live describe', () => {
  const fields = [
    { name: 'Name', type: 'string', createable: true },
    { name: 'Subject', type: 'string', createable: true },
    { name: 'sfcma__Email__c', type: 'email', createable: true },
    { name: 'Other_Email__c', type: 'email', createable: false },
    { name: 'Amount__c', type: 'currency', createable: true },
  ];
  expect(emailAlertMarkerField(fields)).toBe('Name');
  expect(emailAlertMarkerField(fields.filter((f) => f.name !== 'Name'))).toBe('Subject');
  expect(emailAlertMarkerField([{ name: 'Name', type: 'string', createable: false }])).toBeNull();
  expect(emailAlertMarkerField(null)).toBeNull();
  expect(emailAlertSeedableEmailFields(fields)).toEqual(['sfcma__Email__c']);
  expect(emailAlertSeedableEmailFields([{ name: 'Name', type: 'string', createable: true }])).toEqual([]);
  expect(emailAlertEmailTypedFields(fields)).toEqual(['sfcma__Email__c', 'Other_Email__c']);
});

test('marker falls back to any createable filterable string past Name/Subject', () => {
  // OrderSummary live shape: no Name/Subject; OrderNumber is the name field,
  // createable, filterable, required, length 255.
  const orderSummary = [
    { name: 'OrderNumber', type: 'string', createable: true, autoNumber: false, filterable: true, nillable: false, length: 255, nameField: true },
    { name: 'BillingCity', type: 'string', createable: true, filterable: true, nillable: true, length: 40 },
    { name: 'Description', type: 'textarea', createable: true, filterable: false, nillable: true, length: 1175 },
  ];
  expect(emailAlertMarkerField(orderSummary)).toBe('OrderNumber');
  // Without the name field, a fitting filterable field wins over the short
  // city and the unfilterable long text.
  const noName = [
    { name: 'BillingCity', type: 'string', createable: true, filterable: true, nillable: true, length: 40 },
    { name: 'PoNumber', type: 'string', createable: true, filterable: true, nillable: true, length: 80 },
    { name: 'Description', type: 'textarea', createable: true, filterable: false, nillable: true, length: 1175 },
  ];
  expect(emailAlertMarkerField(noName)).toBe('PoNumber');
  // Required beats optional at equal rank when the name field is absent.
  const requiredFirst = [
    { name: 'PoNumber', type: 'string', createable: true, filterable: true, nillable: true, length: 80 },
    { name: 'External_ID__c', type: 'string', createable: true, filterable: true, nillable: false, length: 255 },
  ];
  expect(emailAlertMarkerField(requiredFirst)).toBe('External_ID__c');
  // Auto-number, unfilterable, short, and non-createable fields never qualify.
  expect(emailAlertMarkerField([
    { name: 'Auto__c', type: 'string', createable: true, autoNumber: true, filterable: true, length: 255 },
  ])).toBeNull();
  expect(emailAlertMarkerField([
    { name: 'Notes__c', type: 'textarea', createable: true, filterable: false, length: 1000 },
  ])).toBeNull();
  expect(emailAlertMarkerField([
    { name: 'Code__c', type: 'string', createable: true, filterable: true, length: 20 },
  ])).toBeNull();
  expect(emailAlertMarkerField([
    { name: 'Name', type: 'string', createable: false, filterable: true, length: 255 },
  ])).toBeNull();
});

test('send acceptance reads the envelope only', () => {
  expect(emailAlertSendAccepted(200, [{ isSuccess: true, errors: null, outputValues: null }])).toBe(true);
  expect(emailAlertSendAccepted(200, [{ isSuccess: false, errors: [] }])).toBe(false);
  expect(emailAlertSendAccepted(400, [{ isSuccess: true, errors: [] }])).toBe(false);
  expect(emailAlertSendAccepted(200, [])).toBe(false);
  const refused = (code: string) => [{ isSuccess: false, errors: [{ statusCode: code, message: 'no' }] }];
  expect(emailAlertExistenceRefused(400, refused('INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY'))).toBe(true);
  expect(emailAlertExistenceRefused(400, refused('MISSING_RECORD'))).toBe(true);
  expect(emailAlertExistenceRefused(400, refused('REQUIRED_FIELD_MISSING'))).toBe(false);
  expect(emailAlertExistenceRefused(200, refused('MISSING_RECORD'))).toBe(false);
});

test('recipient allowlist admits only record-email, creator, owner', () => {
  expect(emailAlertRecipientsAllowable({ recipients: ['creator'] }, []))
    .toEqual({ allowable: true, recipients: ['creator'], assertEmptyFields: [] });
  expect(emailAlertRecipientsAllowable({ recipients: [{ type: 'EmailField', field: 'sfcma__Email__c' }] }, ['sfcma__Email__c']))
    .toEqual({ allowable: true, recipients: ['field:sfcma__email__c'], assertEmptyFields: [] });
  expect(emailAlertRecipientsAllowable({ recipients: ['owner'] }, []).allowable).toBe(true);
  expect(emailAlertRecipientsAllowable({ recipients: ['creator'], CcEmails: 'boss@example.com' }, []).allowable).toBe(false);
  expect(emailAlertRecipientsAllowable({ recipients: [{ type: 'user', address: 'boss@example.com' }] }, []).allowable).toBe(false);
  expect(emailAlertRecipientsAllowable({ recipients: ['sfcma__Other__c'] }, ['sfcma__Email__c']).allowable).toBe(false);
  expect(emailAlertRecipientsAllowable({ recipients: [] }, []).allowable).toBe(false);
  expect(emailAlertRecipientsAllowable({ nothing: 1 }, []).allowable).toBe(false);
  expect(emailAlertRecipientsAllowable(null, []).allowable).toBe(false);
});

test('recipient gate reads the live Metadata.recipients container', () => {
  // Live Tooling retrieve shape: no top-level list; recipients nest under
  // Metadata as {field, recipient, type} (CLI-verified 2026-10-06).
  const ownerAlert = {
    CcEmails: null, SenderType: 'CurrentUser',
    Metadata: { ccEmails: [], recipients: [{ field: null, recipient: null, type: 'owner' }], senderType: 'CurrentUser' },
  };
  expect(emailAlertRecipientsAllowable(ownerAlert, [])).toEqual({ allowable: true, recipients: ['owner'], assertEmptyFields: [] });
  const seededAlert = {
    CcEmails: null, SenderType: 'CurrentUser',
    Metadata: { ccEmails: [], recipients: [{ field: 'SuppliedEmail', recipient: null, type: 'email' }] },
  };
  expect(emailAlertRecipientsAllowable(seededAlert, ['SuppliedEmail'], ['SuppliedEmail', 'ContactEmail']))
    .toEqual({ allowable: true, recipients: ['field:suppliedemail'], assertEmptyFields: [] });
  // Unseeded email-typed field (derived ContactEmail): allowable, proven
  // empty-or-non-routable on the read-back fixture like every email value.
  const derivedAlert = {
    CcEmails: null, SenderType: 'CurrentUser',
    Metadata: { ccEmails: [], recipients: [{ field: 'ContactEmail', recipient: null, type: 'email' }] },
  };
  expect(emailAlertRecipientsAllowable(derivedAlert, ['SuppliedEmail'], ['SuppliedEmail', 'ContactEmail']))
    .toEqual({ allowable: true, recipients: ['field:contactemail:unseeded'], assertEmptyFields: [] });
  // contactLookup: allowable only with the empty-lookup assertion.
  const lookupAlert = {
    CcEmails: null, SenderType: 'CurrentUser',
    Metadata: { ccEmails: [], recipients: [{ field: 'ContactId', recipient: null, type: 'contactLookup' }] },
  };
  expect(emailAlertRecipientsAllowable(lookupAlert, ['SuppliedEmail'], ['SuppliedEmail', 'ContactEmail']))
    .toEqual({ allowable: true, recipients: ['lookup:contactid:empty'], assertEmptyFields: ['contactid'] });
  // Fail-closed denials inside the container.
  const ccAlert = {
    Metadata: { ccEmails: ['boss@example.com'], recipients: [{ field: null, recipient: null, type: 'owner' }] },
  };
  expect(emailAlertRecipientsAllowable(ccAlert, []).allowable).toBe(false);
  const namedAlert = {
    Metadata: { ccEmails: [], recipients: [{ field: null, recipient: 'Queue_Name', type: 'user' }] },
  };
  expect(emailAlertRecipientsAllowable(namedAlert, []).allowable).toBe(false);
  const roleAlert = {
    Metadata: { ccEmails: [], recipients: [{ field: null, recipient: null, type: 'role' }] },
  };
  expect(emailAlertRecipientsAllowable(roleAlert, []).allowable).toBe(false);
  const emptyAlert = { Metadata: { ccEmails: [], recipients: [] } };
  expect(emailAlertRecipientsAllowable(emptyAlert, []).allowable).toBe(false);
  const noListAlert = { CcEmails: null, SenderType: 'CurrentUser', Metadata: { ccEmails: [] } };
  const noList = emailAlertRecipientsAllowable(noListAlert, []);
  expect(noList.allowable).toBe(false);
  if (!noList.allowable) expect(noList.reason).toMatch(/No recipient list was found/);
});

test('sender proof keeps the type and masks any fixed sender address', () => {
  expect(emailAlertSenderProof({ SenderType: 'CurrentUser', Metadata: { senderType: 'CurrentUser', senderAddress: null } }))
    .toBe('CurrentUser');
  expect(emailAlertSenderProof({ Metadata: { senderType: 'OrgWideEmailAddress', senderAddress: 'alerts@example.com' } }))
    .toBe('OrgWideEmailAddress:***@example.com');
  expect(emailAlertSenderProof({ Metadata: { senderType: 'OrgWideEmailAddress', senderAddress: 'not-an-address' } }))
    .toBe('OrgWideEmailAddress');
  expect(emailAlertSenderProof({})).toBeNull();
  expect(emailAlertSenderProof(null)).toBeNull();
});

type HarnessOptions = {
  customerShape?: boolean; buildMismatch?: boolean; deleteStuck?: boolean;
  routableEmail?: boolean; creatorMismatch?: boolean; recipientShape?: unknown;
  setLookup?: boolean; accountLink?: boolean; liveAccountId?: string;
  selfUserId?: string; creatorId?: string; sendDenial?: boolean;
  executorId?: string | null; ownerId?: string; reclaimReverts?: boolean;
  describeFields?: any[];
};
const PARENT_ID = '001000000000002AAA';
const QUEUE_ID = '00G000000000001EAA';
function harness(options: HarnessOptions = {}) {
  const objectName = options.customerShape ? 'sfcma__Customer__c' : OBJECT;
  const route = `${ROOT}/actions/custom/emailAlert/${objectName}/${options.customerShape ? 'sfcma__Mock_Email_Alert' : ALERT}`;
  let fixture: any = null;
  let parent: any = null;
  const calls: Array<{ path: string; method: string; body?: any; headers?: any }> = [];
  const posts: string[] = [];
  const result = (body: any, status = 200) => ({ body, status, ok: status < 400 });
  const request = async (path: string, method = 'GET', body?: any, headers?: any) => {
    calls.push({ path, method, body, headers });
    if (method === 'GET' && path === route) {
      return result({ targetEntityName: objectName, inputs: [{ name: 'SObjectRowId', type: 'ID', required: true, maxOccurs: 1 }] });
    }
    if (path === `${ROOT}/sobjects/Account/describe`) {
      return result({ createable: true, deletable: true, queryable: true, fields: [
        { name: 'Name', type: 'string', createable: true, filterable: true, length: 255 },
      ] });
    }
    if (path === `${ROOT}/sobjects/Account` && method === 'POST') {
      posts.push('account');
      parent = { ...body, Id: PARENT_ID };
      return result({ id: PARENT_ID }, 201);
    }
    if (path === `${ROOT}/sobjects/Account/${PARENT_ID}`) {
      if (method === 'DELETE') {
        if (!options.deleteStuck) parent = null;
        return result(null, 204);
      }
      return parent ? result(parent) : result([], 404);
    }
    if (path === `${ROOT}/sobjects/${objectName}/describe`) {
      const fields = options.describeFields ?? (options.customerShape
        ? [{ name: 'Name', type: 'string', createable: true }]
        : [{ name: 'Name', type: 'string', createable: true }, { name: 'sfcma__Email__c', type: 'email', createable: true }]);
      if (options.accountLink) fields.push({ name: 'AccountId', type: 'reference', nillable: true, createable: true, referenceTo: ['Account'] });
      return result({ createable: true, deletable: true, queryable: true, fields });
    }
    if (path.startsWith(`${ROOT}/tooling/query`)) return result({ records: [{ Id: ALERT_ID }] });
    if (path === `${ROOT}/tooling/sobjects/WorkflowAlert/${ALERT_ID}`) {
      if (options.recipientShape !== undefined) return result(options.recipientShape);
      return options.customerShape ? result({ recipients: ['creator'] })
        : result({ recipients: [{ type: 'EmailField', field: 'sfcma__Email__c' }] });
    }
    if (path === `${ROOT}/sobjects/${objectName}` && method === 'POST') {
      posts.push('fixture');
      fixture = {
        ...body, Id: OWNED_ID,
        CreatedById: options.creatorId ?? (options.creatorMismatch ? '005000000000009AAA' : SELF),
        OwnerId: options.ownerId ?? options.creatorId ?? SELF,
      };
      if (options.routableEmail) fixture.sfcma__Email__c = 'real@example.com';
      if (options.setLookup) fixture.ContactId = '003000000000001AAA';
      return result({ id: OWNED_ID }, 201);
    }
    if (path === `${ROOT}/sobjects/${objectName}/${OWNED_ID}`) {
      if (method === 'DELETE') {
        if (!options.deleteStuck) fixture = null;
        return result(null, 204);
      }
      if (method === 'PATCH') {
        // Org automation can 204-accept an ownership PATCH and silently
        // revert it; the revert shape keeps the queue owner on re-read.
        if (!options.reclaimReverts && fixture && typeof body?.OwnerId === 'string') fixture.OwnerId = body.OwnerId;
        return result(null, 204);
      }
      return fixture ? result(fixture) : result([], 404);
    }
    if (path.startsWith(`${ROOT}/query?q=`)) {
      const soql = decodeURIComponent(path.slice(`${ROOT}/query?q=`.length));
      if (soql.includes('FROM Account') && !soql.includes('WHERE')) {
        return result({ records: options.liveAccountId ? [{ Id: options.liveAccountId }] : [] });
      }
      return result({ records: fixture ? [fixture] : [] });
    }
    if (method === 'POST' && path === route) {
      posts.push('send');
      if (options.sendDenial) {
        return result([{ message: 'insufficient access rights on cross reference id', errorCode: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY' }], 400);
      }
      return result([{ isSuccess: true, errors: null }]);
    }
    if (path === '/services/oauth2/userinfo') {
      if (options.executorId === null) return result({ error: 'forbidden' }, 403);
      return result({ user_id: options.executorId ?? SELF });
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const invoke = () => invokeEmailAlertWithContext({
    root: ROOT, route, selfUserId: options.selfUserId ?? SELF, request,
    build: async (_name, _marker, values) => options.buildMismatch
      ? { values: { ...values, sfcma__Email__c: 'tampered@example.com' } }
      : { values },
  });
  return { invoke, posts: () => posts, calls: () => calls, state: () => ({ fixture }) };
}

test('owned lifecycle seeds non-routable email and verifies self-creator', async () => {
  const h = harness();
  const result = await h.invoke();
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.ownedRecordId).toBe(OWNED_ID);
  const send = h.calls().find((c) => c.method === 'POST' && c.path === ROUTE);
  expect(send?.body).toEqual({ inputs: [{ SObjectRowId: OWNED_ID }] });
  expect(result.contextSchema?.seededEmailFields).toEqual(['sfcma__Email__c']);
  expect(result.contextSchema?.recipientProof).toEqual(['field:sfcma__email__c']);
  expect(h.posts()).toEqual(['fixture', 'send']);
  expect(h.state().fixture).toBeNull();
  expect(result.cleanupError).toBeUndefined();
});

test('creator-shape lifecycle converts with no email fields', async () => {
  const h = harness({ customerShape: true });
  const result = await h.invoke();
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(h.posts()).toEqual(['fixture', 'send']);
  expect(h.state().fixture).toBeNull();
  expect(result.cleanupError).toBeUndefined();
});

test('recipient-unsafe fixture refuses before the send but still cleans up', async () => {
  for (const options of [{ routableEmail: true }, { creatorMismatch: true }]) {
    const h = harness(options as HarnessOptions);
    const result = await h.invoke();
    expect(result.status).toBe(422);
    expect(result.body.errorCode).toBe('EMAIL_ALERT_RECIPIENT_UNSAFE');
    expect(h.posts()).toEqual(['fixture']);
    expect(h.state().fixture).toBeNull();
    expect(result.contextSchema?.verified).toBe(false);
  }
});

test('same user in 15- and 18-char formats passes the creator check', async () => {
  const h = harness({ selfUserId: '005000000000001', creatorId: '005000000000001AAA' });
  const result = await h.invoke();
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(h.posts()).toEqual(['fixture', 'send']);
  expect(h.state().fixture).toBeNull();
});

test('live executor identity decides when the stored identity mismatches', async () => {
  // Stored row names the admin, live token runs as the creator: converts.
  const h = harness({ selfUserId: '005000000000001AAA', creatorId: '005000000000009AAA', executorId: '005000000000009AAA' });
  const result = await h.invoke();
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(h.posts()).toEqual(['fixture', 'send']);
  expect(h.calls().some((c) => c.path === '/services/oauth2/userinfo')).toBe(true);
});

test('foreign creators still refuse when userinfo disagrees or fails', async () => {
  for (const options of [
    { selfUserId: '005000000000001AAA', creatorId: '005000000000009AAA', executorId: '005000000000001AAA' },
    { selfUserId: '005000000000001AAA', creatorId: '005000000000009AAA', executorId: null },
  ]) {
    const h = harness(options as HarnessOptions);
    const result = await h.invoke();
    expect(result.status).toBe(422);
    expect(result.body.errorCode).toBe('EMAIL_ALERT_RECIPIENT_UNSAFE');
    expect(h.posts()).toEqual(['fixture']);
    expect(h.state().fixture).toBeNull();
  }
});

test('matching stored identity skips the userinfo call', async () => {
  const h = harness();
  const result = await h.invoke();
  expect(result.status).toBe(200);
  expect(h.calls().some((c) => c.path === '/services/oauth2/userinfo')).toBe(false);
});

test('refused sends that evidence a denial attach the grant family', async () => {
  const h = harness({ sendDenial: true });
  const result = await h.invoke();
  expect(result.status).toBe(400);
  expect(result.contextSchema?.verified).toBe(false);
  expect(result.denialGrant?.family).toBe('cross-reference');
  expect(result.contextSchema?.denialGrant).toMatchObject({ family: 'cross-reference' });
  expect(h.state().fixture).toBeNull();
});

test('unverified recipients refuse before any fixture exists', async () => {
  const h = harness({ recipientShape: { recipients: [{ type: 'user', address: 'boss@example.com' }] } });
  const result = await h.invoke();
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe('EMAIL_ALERT_RECIPIENT_UNVERIFIED');
  expect(h.posts()).toEqual([]);
});

test('Metadata-container owner alert converts with sender evidence', async () => {
  const h = harness({
    recipientShape: {
      CcEmails: null, SenderType: 'CurrentUser',
      Metadata: {
        ccEmails: [], senderType: 'CurrentUser', senderAddress: null,
        recipients: [{ field: null, recipient: null, type: 'owner' }],
      },
    },
  });
  const result = await h.invoke();
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.recipientProof).toEqual(['owner']);
  expect(result.contextSchema?.assertEmptyFields).toEqual([]);
  expect(result.contextSchema?.senderProof).toBe('CurrentUser');
  expect(h.posts()).toEqual(['fixture', 'send']);
  expect(h.state().fixture).toBeNull();
});

test('contactLookup alert converts only when the lookup stays unset', async () => {
  const recipientShape = {
    CcEmails: null, SenderType: 'CurrentUser',
    Metadata: {
      ccEmails: [],
      recipients: [{ field: 'ContactId', recipient: null, type: 'contactLookup' }],
    },
  };
  const clean = harness({ recipientShape });
  const converted = await clean.invoke();
  expect(converted.status).toBe(200);
  expect(converted.contextSchema?.verified).toBe(true);
  expect(converted.contextSchema?.recipientProof).toEqual(['lookup:contactid:empty']);
  expect(converted.contextSchema?.assertEmptyFields).toEqual(['contactid']);
  expect(clean.posts()).toEqual(['fixture', 'send']);
  expect(clean.state().fixture).toBeNull();
  const dirty = harness({ recipientShape, setLookup: true });
  const refused = await dirty.invoke();
  expect(refused.status).toBe(422);
  expect(refused.body.errorCode).toBe('EMAIL_ALERT_RECIPIENT_UNSAFE');
  expect(dirty.posts()).toEqual(['fixture']);
  expect(dirty.state().fixture).toBeNull();
  expect(refused.contextSchema?.verified).toBe(false);
});

test('stuck fixture surfaces a cleanup error and drops verification', async () => {
  const h = harness({ deleteStuck: true });
  const result = await h.invoke();
  expect(typeof result.cleanupError).toBe('string');
  expect(result.contextSchema?.verified).toBe(false);
});

test('required Case reference borrows a live id the probe never writes', async () => {
  const hoursId = '01m000000000001AAA';
  const objectName = 'Case';
  const route = `${ROOT}/actions/custom/emailAlert/${objectName}/Case_Auto_Response`;
  let fixture: any = null;
  const writes: string[] = [];
  const posts: string[] = [];
  const result = (body: any, status = 200) => ({ body, status, ok: status < 400 });
  const request = async (path: string, method = 'GET', body?: any) => {
    if (method !== 'GET') writes.push(`${method} ${path.split('?')[0]}`);
    if (method === 'GET' && path === route) {
      return result({ targetEntityName: objectName, inputs: [{ name: 'SObjectRowId', type: 'ID', required: true, maxOccurs: 1 }] });
    }
    if (path === `${ROOT}/sobjects/${objectName}/describe`) {
      return result({ createable: true, deletable: true, queryable: true, fields: [
        { name: 'Subject', type: 'string', createable: true, filterable: true, length: 80 },
        { name: 'ContactEmail', type: 'email', createable: false },
        { name: 'BusinessHoursId', type: 'reference', createable: true, nillable: false, defaultedOnCreate: false, referenceTo: ['BusinessHours'] },
      ] });
    }
    if (path.startsWith(`${ROOT}/tooling/query`)) return result({ records: [{ Id: ALERT_ID }] });
    if (path === `${ROOT}/tooling/sobjects/WorkflowAlert/${ALERT_ID}`) return result({ Metadata: { recipients: [{ type: 'creator' }] } });
    if (path.startsWith(`${ROOT}/query?q=`)) {
      const query = decodeURIComponent(path);
      if (query.includes('FROM BusinessHours')) return result({ records: [{ Id: hoursId }] });
      return result({ records: fixture ? [fixture] : [] });
    }
    if (path === `${ROOT}/sobjects/${objectName}` && method === 'POST') {
      posts.push('fixture');
      expect(body.BusinessHoursId).toBe(hoursId);
      fixture = { ...body, Id: OWNED_ID, CreatedById: SELF, OwnerId: SELF };
      return result({ id: OWNED_ID }, 201);
    }
    if (path === `${ROOT}/sobjects/${objectName}/${OWNED_ID}`) {
      if (method === 'DELETE') { fixture = null; return result(null, 204); }
      return fixture ? result(fixture) : result([], 404);
    }
    if (method === 'POST' && path === route) {
      posts.push('send');
      return result([{ isSuccess: true, errors: null }]);
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const outcome = await invokeEmailAlertWithContext({
    root: ROOT, route, selfUserId: SELF, request, build: async (_n, _m, values) => ({ values }),
  });
  expect(outcome.status).toBe(200);
  expect(outcome.contextSchema?.verified).toBe(true);
  expect(posts).toEqual(['fixture', 'send']);
  expect(fixture).toBeNull();
  expect(outcome.cleanupError).toBeUndefined();
  // The borrowed BusinessHours row is read for its id and never written.
  expect(writes.filter(w => w.includes('BusinessHours'))).toEqual([]);
  expect(writes.sort()).toEqual([
    `DELETE ${ROOT}/sobjects/${objectName}/${OWNED_ID}`,
    `POST ${route}`,
    `POST ${ROOT}/sobjects/${objectName}`,
  ]);
});

test('no identity is ever fabricated', async () => {
  const badSelf = await invokeEmailAlertWithContext({
    root: ROOT, route: ROUTE, selfUserId: 'not-an-id',
    request: async () => { throw new Error('Must not execute'); }, build: async (_n, _m, values) => ({ values }),
  });
  expect(badSelf.body.errorCode).toBe('EMAIL_ALERT_RECIPIENT_INVALID');
  const badRoute = await invokeEmailAlertWithContext({
    root: ROOT, route: `${ROOT}/actions/standard/submit`, selfUserId: SELF,
    request: async () => { throw new Error('Must not execute'); }, build: async (_n, _m, values) => ({ values }),
  });
  expect(badRoute.body.errorCode).toBe('EMAIL_ALERT_ACTION_INVALID');
  const mismatch = await harness({ buildMismatch: true }).invoke();
  expect(mismatch.body.errorCode).toBe('EMAIL_ALERT_BUILD_UNSCOPED');
});

test('builder version is pinned', () => {
  expect(EMAIL_ALERT_BUILDER_VERSION).toBe(2);
});

const OWNER_RECIPIENTS = {
  CcEmails: null, SenderType: 'CurrentUser',
  Metadata: { ccEmails: [], senderType: 'CurrentUser', senderAddress: null,
    recipients: [{ field: null, recipient: null, type: 'owner' }] },
};

test('commercial Account link borrows a live Account for the send', async () => {
  const liveAccountId = '001000000000009AAA';
  const h = harness({ accountLink: true, liveAccountId, recipientShape: OWNER_RECIPIENTS });
  const result = await h.invoke();
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(h.posts()).toEqual(['fixture', 'send']);
  const created = h.calls().find((c) => c.method === 'POST' && c.path === `${ROOT}/sobjects/${OBJECT}`);
  expect(created?.body.AccountId).toBe(liveAccountId);
  expect(result.cleanupError).toBeUndefined();
});

test('rowless orgs mint an owned Account parent for the send', async () => {
  const h = harness({ accountLink: true, recipientShape: OWNER_RECIPIENTS });
  const result = await h.invoke();
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  expect(h.posts()).toEqual(['account', 'fixture', 'send']);
  const created = h.calls().find((c) => c.method === 'POST' && c.path === `${ROOT}/sobjects/${OBJECT}`);
  expect(created?.body.AccountId).toBe(PARENT_ID);
  const deletes = h.calls().filter((c) => c.method === 'DELETE').map((c) => c.path);
  expect(deletes).toContain(`${ROOT}/sobjects/${OBJECT}/${OWNED_ID}`);
  expect(deletes).toContain(`${ROOT}/sobjects/Account/${PARENT_ID}`);
  expect(result.cleanupError).toBeUndefined();
});

test('queue-routed fixture is reclaimed to the creator before the send', async () => {
  const h = harness({ ownerId: QUEUE_ID });
  const result = await h.invoke();
  expect(result.status).toBe(200);
  expect(result.contextSchema?.verified).toBe(true);
  const patch = h.calls().find((c) => c.method === 'PATCH');
  expect(patch?.path).toBe(`${ROOT}/sobjects/${OBJECT}/${OWNED_ID}`);
  expect(patch?.body).toEqual({ OwnerId: SELF });
  expect(h.posts()).toEqual(['fixture', 'send']);
  expect(result.cleanupError).toBeUndefined();
});

test('silently reverted reclaim refuses the send honestly', async () => {
  const h = harness({ ownerId: QUEUE_ID, reclaimReverts: true });
  const result = await h.invoke();
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe('EMAIL_ALERT_RECLAIM_UNVERIFIED');
  expect(h.posts()).toEqual(['fixture']);
  expect(result.cleanupError).toBeUndefined();
});

test('fixture insert skips assignment rules so cleanup stays owned', async () => {
  const h = harness();
  const result = await h.invoke();
  expect(result.status).toBe(200);
  const created = h.calls().find((c) => c.method === 'POST' && c.path === `${ROOT}/sobjects/${OBJECT}`);
  expect(created?.headers).toEqual({ 'Sforce-Auto-Assign': 'FALSE' });
});

test('platform-managed required fields name only required-but-unsettable fields', () => {
  // Live OrderSummary shape (CLI-verified 2026-10-07): OriginalOrderId and
  // OrderLifeCycleType are required yet neither createable nor updateable.
  const orderSummary = [
    { name: 'OrderNumber', type: 'string', createable: true, nillable: false, defaultedOnCreate: false, filterable: true, length: 255 },
    { name: 'OriginalOrderId', type: 'reference', createable: false, updateable: false, nillable: false, defaultedOnCreate: false, referenceTo: ['Order'] },
    { name: 'OrderLifeCycleType', type: 'picklist', createable: false, updateable: false, nillable: false, defaultedOnCreate: false },
    { name: 'OwnerId', type: 'reference', createable: true, nillable: false, defaultedOnCreate: true, referenceTo: ['User'] },
    { name: 'BillingEmailAddress', type: 'email', createable: true, nillable: true },
  ];
  expect(emailAlertPlatformManagedRequiredFields(orderSummary)).toEqual(['OriginalOrderId', 'OrderLifeCycleType']);
  // Defaulted, calculated, auto-number, createable, and updateable-only
  // fields never qualify; ordinary fixture objects come back empty.
  const ordinary = [
    { name: 'Name', type: 'string', createable: true, nillable: false, defaultedOnCreate: false },
    { name: 'OwnerId', type: 'reference', createable: true, nillable: false, defaultedOnCreate: true, referenceTo: ['User'] },
    { name: 'CaseNumber', type: 'string', createable: false, updateable: false, nillable: false, autoNumber: true },
    { name: 'Derived__c', type: 'string', createable: false, updateable: false, nillable: false, calculated: true },
    { name: 'SettableLater__c', type: 'reference', createable: false, updateable: true, nillable: false, referenceTo: ['Account'] },
  ];
  expect(emailAlertPlatformManagedRequiredFields(ordinary)).toEqual([]);
  expect(emailAlertPlatformManagedRequiredFields(null)).toEqual([]);
});

test('platform-managed fixture object refuses before any side effect', async () => {
  const h = harness({
    describeFields: [
      { name: 'OrderNumber', type: 'string', createable: true, nillable: false, defaultedOnCreate: false, filterable: true, length: 255, nameField: true },
      { name: 'BillingEmailAddress', type: 'email', createable: true, nillable: true },
      { name: 'OriginalOrderId', type: 'reference', createable: false, updateable: false, nillable: false, defaultedOnCreate: false, referenceTo: ['Order'] },
      { name: 'OrderLifeCycleType', type: 'picklist', createable: false, updateable: false, nillable: false, defaultedOnCreate: false },
    ],
  });
  const result = await h.invoke();
  expect(result.status).toBe(422);
  expect(result.body.errorCode).toBe('EMAIL_ALERT_FIXTURE_UNBUILDABLE');
  expect(result.body.unbuildableFields).toEqual(['OriginalOrderId', 'OrderLifeCycleType']);
  expect(result.body.setupRequirement).toMatch(/no permission grant enables direct insert/);
  expect(h.posts()).toEqual([]);
  expect(result.contextSchema?.verified).toBe(false);
  expect(result.contextSchema?.ownedRecordId).toBeNull();
  expect(result.cleanupError).toBeUndefined();
});
