import { expect, test } from 'bun:test';
import { FIXTURE_REFERENCE_TARGET_CAP, commercialAccountLinkField, requiredReferenceFields, seedCommercialAccountLink, seedRequiredReferenceValues } from './fixture-reference-seeding';

const root = '/services/data/v67.0';
const hoursId = '01m000000000001AAA', storeId = '0ZE000000000001AAA', userId = '005000000000001AAA';

const ref = (name: string, referenceTo: string[], extra: Record<string, any> = {}) => ({
  name, type: 'reference', createable: true, nillable: false, defaultedOnCreate: false, referenceTo, ...extra,
});

test('required reference fields match synthesis terms and cap polymorphic targets', () => {
  const fields = requiredReferenceFields([
    ref('BusinessHoursId', ['BusinessHours']),
    ref('RelatedRecordId', ['Account', 'Case', 'User']),
    { name: 'OwnerId', type: 'reference', createable: true, nillable: true, referenceTo: ['User'] },
    { name: 'Name', type: 'string', createable: true, nillable: false },
    ref('Defaulted__c', ['Account'], { defaultedOnCreate: true }),
    ref('1nvalid', ['Account']),
    ref('Empty__c', []),
    ref('Capped__c', Array.from({ length: 12 }, (_, i) => `Target${i}__c`)),
  ]);
  expect(fields.map(f => f.name)).toEqual(['BusinessHoursId', 'RelatedRecordId', 'Capped__c']);
  expect(fields[1].targets).toEqual(['Account', 'Case', 'User']);
  expect(fields[2].targets.length).toBe(FIXTURE_REFERENCE_TARGET_CAP);
});

test('borrows the first live id per field in describe order and dedupes shared targets', async () => {
  const queries: string[] = [];
  const request = async (path: string): Promise<any> => {
    queries.push(path);
    const objectName = decodeURIComponent(path).match(/FROM (\w+)/)?.[1];
    const rows: Record<string, any[]> = { Account: [], Case: [{ Id: '500000000000001AAA' }], BusinessHours: [{ Id: hoursId }] };
    return { status: 200, ok: true, body: { records: rows[objectName ?? ''] ?? [] } };
  };
  const seed = await seedRequiredReferenceValues(request, root, [
    ref('BusinessHoursId', ['BusinessHours']),
    ref('RelatedRecordId', ['Account', 'Case']),
    ref('SecondHours__c', ['BusinessHours']),
  ]);
  expect(seed.overrides).toEqual({ BusinessHoursId: hoursId, RelatedRecordId: '500000000000001AAA', SecondHours__c: hoursId });
  expect(seed.unresolved).toEqual([]);
  expect(seed.mintPlans).toEqual([]);
  // BusinessHours queried once despite two fields; Account miss then Case hit.
  const decoded = queries.map(q => decodeURIComponent(q));
  expect(decoded.filter(q => q.includes('FROM BusinessHours')).length).toBe(1);
  expect(queries.length).toBe(3);
});

test('single-target rowless-but-mintable fields yield mint plans with the live describe', async () => {
  const targetFields = [{ name: 'Name', type: 'string', createable: true, nillable: false }];
  const request = async (path: string): Promise<any> => {
    if (path.includes('/query?q=')) return { status: 200, ok: true, body: { records: [] } };
    if (path === root + '/sobjects/RebateProgram/describe') {
      return { status: 200, ok: true, body: { createable: true, queryable: true, deletable: true, fields: targetFields } };
    }
    throw Error('Unexpected request ' + path);
  };
  const seed = await seedRequiredReferenceValues(request, root, [ref('RebateProgramId', ['RebateProgram'])]);
  expect(seed.overrides).toEqual({});
  expect(seed.unresolved).toEqual([]);
  expect(seed.mintPlans).toEqual([{ field: 'RebateProgramId', objectName: 'RebateProgram', fields: targetFields }]);
});

test('unmintable, polymorphic-rowless, and failed lookups stay unresolved without mint plans', async () => {
  const request = async (path: string): Promise<any> => {
    if (path.includes('/query?q=')) {
      const objectName = decodeURIComponent(path).match(/FROM (\w+)/)?.[1];
      if (objectName === 'Flaky__c') return { status: 403, ok: false, body: { message: 'denied' } };
      return { status: 200, ok: true, body: { records: [] } };
    }
    if (path === root + '/sobjects/Locked__c/describe') {
      return { status: 200, ok: true, body: { createable: true, queryable: true, deletable: false, fields: [] } };
    }
    if (path === root + '/sobjects/Flaky__c/describe') {
      return { status: 403, ok: false, body: { message: 'denied' } };
    }
    throw Error('Unexpected request ' + path);
  };
  const seed = await seedRequiredReferenceValues(request, root, [
    ref('LockedId', ['Locked__c']),
    ref('PolyId', ['GoneA__c', 'GoneB__c']),
    ref('FlakyId', ['Flaky__c']),
  ]);
  expect(seed.overrides).toEqual({});
  expect(seed.mintPlans).toEqual([]);
  expect(seed.unresolved).toEqual(['LockedId', 'PolyId', 'FlakyId']);
});

test('allowLiveBorrow:false reads no live row yet still mints single-target parents', async () => {
  const queries: string[] = [];
  const targetFields = [{ name: 'Name', type: 'string', createable: true, nillable: false }];
  const request = async (path: string): Promise<any> => {
    queries.push(path);
    if (path.includes('/query?q=')) {
      const soql = decodeURIComponent(path);
      // Org-default setup rows bind under opt-out; plain customer rows never do.
      if (soql.includes('IsDefault=true')) return { status: 200, ok: true, body: { records: [] } };
      return { status: 200, ok: true, body: { records: [{ Id: '001000000000001AAA' }] } };
    }
    if (path === root + '/sobjects/Mintable__c/describe') {
      return { status: 200, ok: true, body: { createable: true, queryable: true, deletable: true, fields: targetFields } };
    }
    if (path === root + '/sobjects/GoneA__c/describe' || path === root + '/sobjects/GoneB__c/describe') {
      return { status: 200, ok: true, body: { createable: false, queryable: true, deletable: true, fields: [] } };
    }
    throw Error('Unexpected request ' + path);
  };
  const seed = await seedRequiredReferenceValues(request, root, [
    ref('MintableId', ['Mintable__c']),
    ref('PolyId', ['GoneA__c', 'GoneB__c']),
  ], { allowLiveBorrow: false });
  expect(seed.overrides).toEqual({});
  expect(seed.mintPlans).toEqual([{ field: 'MintableId', objectName: 'Mintable__c', fields: targetFields }]);
  expect(seed.unresolved).toEqual(['PolyId']);
  // Setup-default lookups + mint-target describes only: no customer row bound.
  expect(queries.filter((q) => q.includes('/query?q=')).every((q) => decodeURIComponent(q).includes('IsDefault=true'))).toBe(true);
  expect(queries).toHaveLength(6);
});

test('names access-denied lookup targets for self-provisioning, never malformed filters', async () => {
  const request = async (path: string): Promise<any> => {
    const decoded = decodeURIComponent(path);
    if (decoded.includes('FROM BusinessHours')) {
      return { status: 403, ok: false, body: [{ errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY' }] };
    }
    if (decoded.includes('FROM NoDefault__c')) {
      return { status: 400, ok: false, body: [{ errorCode: 'INVALID_FIELD', message: 'No such column IsDefault' }] };
    }
    if (path.endsWith('/describe')) return { status: 200, ok: true, body: { createable: false, queryable: true, fields: [] } };
    throw Error('Unexpected request ' + path);
  };
  const seed = await seedRequiredReferenceValues(request, root, [
    ref('BusinessHoursId', ['BusinessHours']),
    ref('OtherId', ['NoDefault__c']),
  ], { allowLiveBorrow: false });
  expect(seed.readDenied).toEqual(['BusinessHours']);
  expect(seed.unresolved.sort()).toEqual(['BusinessHoursId', 'OtherId']);
});

test('runs no query without required references', async () => {
  let calls = 0;
  const seed = await seedRequiredReferenceValues(async () => { calls++; return { status: 200, ok: true, body: {} }; }, root, [
    { name: 'Name', type: 'string', createable: true, nillable: false },
  ]);
  expect(seed).toEqual({ overrides: {}, unresolved: [], readDenied: [], mintPlans: [] });
  expect(calls).toBe(0);
});

test('commercial Account link matches createable nillable AccountId only', () => {
  const live = { name: 'AccountId', type: 'reference', nillable: true, createable: true,
    referenceTo: ['Account', 'GuestBuyerProfile', 'User'] };
  expect(commercialAccountLinkField([live])).toEqual({ name: 'AccountId' });
  expect(commercialAccountLinkField([{ ...live, createable: false }])).toBeNull();
  expect(commercialAccountLinkField([{ ...live, referenceTo: ['User'] }])).toBeNull();
  expect(commercialAccountLinkField([{ name: 'ParentId', type: 'reference', createable: true, referenceTo: ['Account'] }])).toBeNull();
  expect(commercialAccountLinkField([{ name: 'Name', type: 'string' }])).toBeNull();
  expect(commercialAccountLinkField(null)).toBeNull();
});

test('commercial Account link borrows live, else mints, else stays unavailable', async () => {
  const accountId = '001000000000001AAA';
  const borrowed = await seedCommercialAccountLink(async (path: string) => {
    expect(decodeURIComponent(path)).toContain('SELECT Id FROM Account LIMIT 1');
    return { status: 200, ok: true, body: { records: [{ Id: accountId }] } };
  }, root);
  expect(borrowed).toEqual({ bound: accountId });

  const targetFields = [{ name: 'Name', type: 'string', createable: true, nillable: false }];
  const calls: string[] = [];
  const minted = await seedCommercialAccountLink(async (path: string) => {
    calls.push(path);
    if (path.includes('/query?')) return { status: 200, ok: true, body: { records: [] } };
    return { status: 200, ok: true, body: { createable: true, queryable: true, deletable: true, fields: targetFields } };
  }, root);
  expect(minted).toEqual({ mint: { objectName: 'Account', fields: targetFields } });
  expect(calls.length).toBe(2);

  const missing = await seedCommercialAccountLink(async (path: string) => {
    if (path.includes('/query?')) return { status: 200, ok: true, body: { records: [] } };
    return { status: 404, ok: false, body: null };
  }, root);
  expect('unavailable' in missing).toBe(true);
});
