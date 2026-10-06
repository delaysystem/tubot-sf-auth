import { test, expect } from 'bun:test';
import {
  apexCsvAccepted,
  apexCsvActionName,
  apexCsvContract,
  apexCsvInvokeArgs,
  invokeApexCsvWithContext,
} from './apex-csv-context';

const ROOT = '/services/data/v67.0';
const ROUTE = `${ROOT}/actions/custom/apex/usf3__ConvertRecordsToCSVQueueable`;
const OWNER = '005000000000001AAA';
const ACCOUNT_A = '001000000000001AAA';
const ACCOUNT_B = '001000000000002AAA';
const DOC_ID = '069000000000001AAA';
const VERSION_ID = '068000000000001AAA';

const CSV_INPUTS = [
  { name: 'documentTitle', type: 'STRING', required: true },
  { name: 'recordCollectionString', type: 'STRING', required: false },
  { name: 'objectName', type: 'STRING', required: false },
  { name: 'fieldsString', type: 'STRING', required: false },
  { name: 'documentShareType', type: 'STRING', required: false },
];
const CSV_OUTPUTS = [
  { name: 'contentDocumentId', type: 'STRING' },
  { name: 'contentVersionId', type: 'STRING' },
];

const result = (body: any, status = 200) => ({ body, status, ok: status < 400 });

test('csv routes classify by live route shape only', () => {
  expect(apexCsvActionName(ROUTE)).toBe('usf3__ConvertRecordsToCSVQueueable');
  expect(apexCsvActionName(`${ROOT}/actions/custom/apex/FutureCsvTwin`)).toBe('FutureCsvTwin');
  expect(apexCsvActionName(`${ROOT}/actions/custom/flow/SomeFlow`)).toBeNull();
  expect(apexCsvActionName('not a route')).toBeNull();
});

test('csv contract requires the title plus collection-string shape and file-id outputs', () => {
  expect(apexCsvContract(CSV_INPUTS, CSV_OUTPUTS)).toEqual({
    titleInput: 'documentTitle', collectionInput: 'recordCollectionString',
    objectInput: 'objectName', fieldsInput: 'fieldsString',
  });
  // SOBJECT-collection-only twin: unserializable over REST, must refuse.
  expect(apexCsvContract([
    { name: 'documentTitle', type: 'STRING', required: true },
    { name: 'recordCollection', type: 'SOBJECT', required: false },
  ], CSV_OUTPUTS)).toBeNull();
  // Missing title or file-id outputs: drift.
  expect(apexCsvContract([{ name: 'recordCollectionString', type: 'STRING', required: true }], CSV_OUTPUTS)).toBeNull();
  expect(apexCsvContract(CSV_INPUTS, [{ name: 'contentDocumentId', type: 'STRING' }])).toBeNull();
  // Unknown required input: unbuildable.
  expect(apexCsvContract([...CSV_INPUTS, { name: 'webhookUrl', type: 'STRING', required: true }], CSV_OUTPUTS)).toBeNull();
  expect(apexCsvContract(null, CSV_OUTPUTS)).toBeNull();
});

test('invoke args serialize record objects attributes-first', () => {
  const contract = apexCsvContract(CSV_INPUTS, CSV_OUTPUTS)!;
  const args = apexCsvInvokeArgs(contract, 'title-marker',
    [{ id: ACCOUNT_A, name: 'row a' }, { id: ACCOUNT_B, name: 'row b' }], 'Account', 'Name');
  expect(args.documentTitle).toBe('title-marker');
  expect(args.objectName).toBe('Account');
  expect(args.fieldsString).toBe('Name');
  const records = JSON.parse(args.recordCollectionString as string);
  expect(records).toHaveLength(2);
  expect(Object.keys(records[0])[0]).toBe('attributes');
  expect(records[0]).toEqual({ attributes: { type: 'Account' }, Id: ACCOUNT_A, Name: 'row a' });
});

test('csv acceptance requires the success envelope plus both minted file ids', () => {
  const ok = [{ isSuccess: true, errors: null,
    outputValues: { contentDocumentId: DOC_ID, contentVersionId: VERSION_ID } }];
  const accepted = apexCsvAccepted(200, ok);
  expect(accepted).toEqual({ accepted: true, contentDocumentId: DOC_ID, contentVersionId: VERSION_ID });
  expect(apexCsvAccepted(200, [{ isSuccess: true, errors: null,
    outputValues: { contentDocumentId: DOC_ID } }]).accepted).toBe(false);
  expect(apexCsvAccepted(200, [{ isSuccess: false, errors: [] }]).accepted).toBe(false);
  expect(apexCsvAccepted(400, ok).accepted).toBe(false);
});

type HarnessOptions = { inputs?: any[]; outputs?: any[]; dropFixture?: boolean; dropFile?: boolean };
function harness(options: HarnessOptions = {}) {
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  const accounts = new Map<string, any>();
  let created = 0;
  let document: any = null;
  let version: any = null;
  const request = async (path: string, method = 'GET', body?: any) => {
    calls.push({ path, method, body });
    if (method === 'GET' && path === ROUTE) {
      return result({ inputs: options.inputs ?? CSV_INPUTS, outputs: options.outputs ?? CSV_OUTPUTS });
    }
    if (method === 'POST' && path === `${ROOT}/sobjects/Account`) {
      created += 1;
      const id = created === 1 ? ACCOUNT_A : ACCOUNT_B;
      accounts.set(id, { ...body, Id: id });
      return result({ id }, 201);
    }
    const accountRow = path.match(/\/sobjects\/Account\/([A-Za-z0-9]+)$/);
    if (accountRow) {
      if (method === 'DELETE') {
        if (!options.dropFixture) accounts.delete(accountRow[1]);
        return result(null, 204);
      }
      const row = accounts.get(accountRow[1]);
      return row ? result(row) : result([], 404);
    }
    if (method === 'POST' && path === ROUTE) {
      const inputs = body?.inputs?.[0] ?? {};
      document = { Id: DOC_ID, Title: inputs.documentTitle };
      version = { Id: VERSION_ID, ContentDocumentId: DOC_ID, ContentSize: 24 };
      return result([{ isSuccess: true, errors: null,
        outputValues: { contentDocumentId: DOC_ID, contentVersionId: VERSION_ID } }]);
    }
    if (path === `${ROOT}/sobjects/ContentVersion/${VERSION_ID}`) return version ? result(version) : result([], 404);
    if (path === `${ROOT}/sobjects/ContentDocument/${DOC_ID}`) {
      if (method === 'DELETE') {
        if (!options.dropFile) { document = null; version = null; }
        return result(null, 204);
      }
      return document ? result(document) : result([], 404);
    }
    if (path.startsWith(`${ROOT}/query?q=`)) return result({ records: [] });
    throw new Error(`unexpected call ${method} ${path}`);
  };
  const build = async (_name: string, _marker: string, values: any) => ({ values });
  return { request, build, calls };
}

test('owned csv lifecycle invokes with owned rows and verifies file readback plus cleanup', async () => {
  const h = harness();
  const outcome = await invokeApexCsvWithContext({ root: ROOT, route: ROUTE,
    ownerUserId: OWNER, request: h.request, build: h.build });
  expect(outcome.status).toBe(200);
  expect(outcome.body[0].isSuccess).toBe(true);
  expect(outcome.contextSchema?.verified).toBe(true);
  expect(outcome.contextSchema?.fileReadbackOk).toBe(true);
  expect(outcome.contextSchema?.contentDocumentId).toBe(DOC_ID);
  expect(outcome.contextSchema?.fixtureIds).toEqual([ACCOUNT_A, ACCOUNT_B]);
  expect(outcome.cleanupError).toBeUndefined();
  const posted = h.calls.find((call) => call.method === 'POST' && call.path === ROUTE);
  const records = JSON.parse(posted?.body.inputs[0].recordCollectionString as string);
  expect(records.map((entry: any) => entry.Id).sort()).toEqual([ACCOUNT_A, ACCOUNT_B].sort());
  // File deletes before fixtures (reverse ownership order), absence verified.
  const deletes = h.calls.filter((call) => call.method === 'DELETE').map((call) => call.path);
  expect(deletes[0]).toBe(`${ROOT}/sobjects/ContentDocument/${DOC_ID}`);
  expect(h.calls.some((call) => call.path.includes('ContentDocument%20WHERE%20Title') ||
    call.path.includes('ContentDocument WHERE Title'))).toBe(true);
});

test('csv drift refuses with no fixture and no apex POST', async () => {
  const h = harness({ inputs: [
    { name: 'documentTitle', type: 'STRING', required: true },
    { name: 'recordCollection', type: 'SOBJECT', required: false },
  ] });
  const outcome = await invokeApexCsvWithContext({ root: ROOT, route: ROUTE,
    ownerUserId: OWNER, request: h.request, build: h.build });
  expect(outcome.status).toBe(422);
  expect(outcome.body.errorCode).toBe('APEX_CSV_CONTRACT_UNSUPPORTED');
  expect(h.calls.some((call) => call.method === 'POST')).toBe(false);
});

test('csv file stuck after delete reports cleanup failure without success', async () => {
  const h = harness({ dropFile: true });
  const outcome = await invokeApexCsvWithContext({ root: ROOT, route: ROUTE,
    ownerUserId: OWNER, request: h.request, build: h.build });
  expect(typeof outcome.cleanupError).toBe('string');
  expect(outcome.contextSchema?.verified).toBe(false);
});
