import { describe, expect, test } from 'bun:test';
import {
  ORDER_SUMMARY_ACTIONS, ORDER_SUMMARY_OBJECT, ORDER_SUMMARY_LINK_FIELD, ORDER_SUMMARY_LINK_OBJECT,
  checkOrderSummaryCapability, invokeOrderSummaryPreviewWithContext, orderSummaryActionName,
  orderSummaryLinkFieldPresent, resolveReferenceIdOrMissing,
} from './order-summary-context';

type Result = { status: number; ok: boolean; body: any };

const ROOT = '/services/data/v67.0';
const PREVIEW = `${ROOT}/actions/standard/changeOrderSummaryPreview`;
const SUBMIT = `${ROOT}/actions/standard/changeOrderSummarySubmit`;
const DESCRIBE_TYPE = `${ROOT}/sobjects/${ORDER_SUMMARY_OBJECT}/describe`;
const LIVE_ID = '9Sbxx0000001AbCEAU';

const ok = (body: unknown, status = 200): Result => ({ status, ok: status >= 200 && status < 300, body });
const notFound = (): Result => ({ status: 404, ok: false, body: [{ errorCode: 'NOT_FOUND', message: 'Invalid Action Type' }] });
const descriptor = (inputs: Array<{ name: string }>) => ({ inputs, outputs: [] });
const accepted = () => [{ actionName: 'changeOrderSummaryPreview', errors: null, isSuccess: true, outputValues: { preview: true } }];

describe('order-summary route matching', () => {
  test('matches preview and submit tails only', () => {
    expect(orderSummaryActionName(PREVIEW)).toBe('changeOrderSummaryPreview');
    expect(orderSummaryActionName(SUBMIT)).toBe('changeOrderSummarySubmit');
    expect(orderSummaryActionName(`${ROOT}/actions/standard/createReturnOrder`)).toBeNull();
    expect(orderSummaryActionName('changeOrderSummaryPreview')).toBeNull();
    expect(ORDER_SUMMARY_ACTIONS).toEqual(['changeOrderSummaryPreview', 'changeOrderSummarySubmit']);
  });
});

describe('resolveReferenceIdOrMissing', () => {
  const recordIds = { Order: '801xx0000001AbCEAU' };
  const prefixes = { Order: '801' };
  test('live id wins over synthesis', () => {
    expect(resolveReferenceIdOrMissing({ fieldName: 'orderId', objectType: 'Order', recordIds, objectKeyPrefixes: prefixes }))
      .toEqual({ id: '801xx0000001AbCEAU' });
  });
  test('verified prefix seeds prefix-correct synthesis', () => {
    expect(resolveReferenceIdOrMissing({ fieldName: 'orderId', objectType: 'Order', recordIds: {}, objectKeyPrefixes: prefixes }))
      .toEqual({ idPrefix: '801' });
  });
  test('unverified type yields missing instead of a prefix-less random id', () => {
    expect(resolveReferenceIdOrMissing({ fieldName: 'orderSummaryId', objectType: 'OrderSummary', recordIds, objectKeyPrefixes: prefixes }))
      .toEqual({ missingField: 'orderSummaryId' });
  });
  test('unknown type and malformed inputs yield missing', () => {
    expect(resolveReferenceIdOrMissing({ fieldName: 'orderSummaryId', objectType: null, recordIds, objectKeyPrefixes: prefixes }))
      .toEqual({ missingField: 'orderSummaryId' });
    expect(resolveReferenceIdOrMissing({ fieldName: 'orderSummaryId', recordIds, objectKeyPrefixes: prefixes }))
      .toEqual({ missingField: 'orderSummaryId' });
    expect(resolveReferenceIdOrMissing({ fieldName: 'orderId', objectType: 'Order', recordIds: {}, objectKeyPrefixes: { Order: 'nope-toolong' } }))
      .toEqual({ missingField: 'orderId' });
    expect(resolveReferenceIdOrMissing({ fieldName: 'orderId', objectType: 'Order', recordIds: { Order: 'bogus' }, objectKeyPrefixes: {} }))
      .toEqual({ missingField: 'orderId' });
  });
});

describe('checkOrderSummaryCapability', () => {
  test('absent action descriptor is setup-gated with evidence', async () => {
    const seen: string[] = [];
    const request = async (path: string): Promise<Result> => { seen.push(path); return notFound(); };
    const capability = await checkOrderSummaryCapability({ root: ROOT, route: PREVIEW, request });
    expect(capability.available).toBe(false);
    if (capability.available) throw new Error('expected setup gate');
    expect(capability.result.body.errorCode).toBe('ORDER_SUMMARY_SETUP_REQUIRED');
    expect(capability.evidence).toEqual({ actionDescribed: false, typeDescribed: false, upstreamStatus: 404 });
    expect(seen).toEqual([PREVIEW]);
  });
  test('absent OrderSummary type is setup-gated after a live descriptor', async () => {
    const request = async (path: string): Promise<Result> =>
      path === PREVIEW ? ok(descriptor([{ name: 'orderSummaryId' }])) : notFound();
    const capability = await checkOrderSummaryCapability({ root: ROOT, route: PREVIEW, request });
    expect(capability.available).toBe(false);
    if (capability.available) throw new Error('expected setup gate');
    expect(capability.result.body.errorCode).toBe('ORDER_SUMMARY_SETUP_REQUIRED');
    expect(capability.result.body.setupRequirement).toContain(ORDER_SUMMARY_OBJECT);
    expect(capability.evidence).toEqual({ actionDescribed: true, typeDescribed: false, upstreamStatus: 404 });
  });
  test('present action and type clear the pre-check', async () => {
    const request = async (path: string): Promise<Result> =>
      path === PREVIEW ? ok(descriptor([{ name: 'orderSummaryId' }])) : ok({ name: ORDER_SUMMARY_OBJECT, queryable: true });
    const capability = await checkOrderSummaryCapability({ root: ROOT, route: PREVIEW, request });
    expect(capability.available).toBe(true);
    if (!capability.available) throw new Error('expected capability');
    expect(capability.action).toBe('changeOrderSummaryPreview');
  });
  test('non-family route is rejected without any request', async () => {
    let calls = 0;
    const request = async (): Promise<Result> => { calls++; return ok({}); };
    const capability = await checkOrderSummaryCapability({ root: ROOT, route: `${ROOT}/actions/standard/createReturnOrder`, request });
    expect(calls).toBe(0);
    expect(capability.available).toBe(false);
    if (capability.available) throw new Error('expected rejection');
    expect(capability.result.body.errorCode).toBe('ORDER_SUMMARY_ROUTE_INVALID');
  });
});

describe('invokeOrderSummaryPreviewWithContext', () => {
  test('setup-gated paths never POST', async () => {
    const posts: string[] = [];
    const request = async (path: string, method = 'GET'): Promise<Result> => {
      if (method === 'POST') posts.push(path);
      return notFound();
    };
    const result = await invokeOrderSummaryPreviewWithContext({ root: ROOT, route: PREVIEW, request });
    expect(result.status).toBe(422);
    expect(result.body.errorCode).toBe('ORDER_SUMMARY_SETUP_REQUIRED');
    expect(posts).toEqual([]);
    expect(result.contextSchema?.verified).toBe(false);
    expect(result.contextSchema?.source).toBe('salesforce_live_order_summary_preview');
  });
  test('zero live rows is substrate-absent without invoking', async () => {
    const posts: string[] = [];
    const request = async (path: string, method = 'GET'): Promise<Result> => {
      if (method === 'POST') posts.push(path);
      if (path === PREVIEW) return ok(descriptor([{ name: 'orderSummaryId' }]));
      if (path === DESCRIBE_TYPE) return ok({ name: ORDER_SUMMARY_OBJECT, queryable: true });
      return ok({ totalSize: 0, records: [] });
    };
    const result = await invokeOrderSummaryPreviewWithContext({ root: ROOT, route: PREVIEW, request });
    expect(result.body.errorCode).toBe('ORDER_SUMMARY_SUBSTRATE_ABSENT');
    expect(posts).toEqual([]);
    expect(result.contextSchema?.capability).toEqual({ actionDescribed: true, typeDescribed: true, liveRowCount: 0 });
  });
  test('live row invokes preview with the declared input only', async () => {
    const posts: Array<{ path: string; body: any }> = [];
    const request = async (path: string, method = 'GET', body?: any): Promise<Result> => {
      if (method === 'POST') { posts.push({ path, body }); return ok(accepted()); }
      if (path === PREVIEW) return ok(descriptor([{ name: 'orderSummaryId' }]));
      if (path === DESCRIBE_TYPE) return ok({ name: ORDER_SUMMARY_OBJECT, queryable: true });
      return ok({ totalSize: 1, records: [{ Id: LIVE_ID }] });
    };
    const result = await invokeOrderSummaryPreviewWithContext({ root: ROOT, route: PREVIEW, request });
    expect(result.contextSchema?.verified).toBe(true);
    expect(posts).toEqual([{ path: PREVIEW, body: { inputs: [{ orderSummaryId: LIVE_ID }] } }]);
    expect(result.contextSchema?.verificationRecordIds).toEqual([LIVE_ID]);
  });
  test('rejected envelope preserves the upstream outcome', async () => {
    const upstream = [{ isSuccess: false, errors: [{ message: 'change validation failed' }] }];
    const request = async (path: string, method = 'GET'): Promise<Result> => {
      if (method === 'POST') return ok(upstream);
      if (path === PREVIEW) return ok(descriptor([{ name: 'orderSummaryId' }]));
      if (path === DESCRIBE_TYPE) return ok({ name: ORDER_SUMMARY_OBJECT, queryable: true });
      return ok({ totalSize: 1, records: [{ Id: LIVE_ID }] });
    };
    const result = await invokeOrderSummaryPreviewWithContext({ root: ROOT, route: PREVIEW, request });
    expect(result.body.errorCode).toBe('ORDER_SUMMARY_PREVIEW_UNVERIFIED');
    expect(result.body.upstreamOutcome).toEqual(upstream);
    expect(result.contextSchema?.verified).toBe(false);
  });
  test('descriptor without an identity input invents nothing', async () => {
    let posts = 0;
    const request = async (path: string, method = 'GET'): Promise<Result> => {
      if (method === 'POST') posts++;
      if (path === PREVIEW) return ok(descriptor([{ name: 'changePayload' }]));
      if (path === DESCRIBE_TYPE) return ok({ name: ORDER_SUMMARY_OBJECT, queryable: true });
      return ok({ totalSize: 1, records: [{ Id: LIVE_ID }] });
    };
    const result = await invokeOrderSummaryPreviewWithContext({ root: ROOT, route: PREVIEW, request });
    expect(result.body.errorCode).toBe('ORDER_SUMMARY_INPUT_UNAVAILABLE');
    expect(posts).toBe(0);
  });
  test('unbounded verification window is rejected', async () => {
    const request = async (): Promise<Result> => ok({});
    const result = await invokeOrderSummaryPreviewWithContext({ root: ROOT, route: PREVIEW, request, verificationWindowMs: 60_000 });
    expect(result.body.errorCode).toBe('ORDER_SUMMARY_WINDOW_INVALID');
  });
});

describe('orderSummaryLinkFieldPresent', () => {
  const LINK_DESCRIBE = `${ROOT}/sobjects/${ORDER_SUMMARY_LINK_OBJECT}/describe`;
  test('distinguishes present, absent, and unreadable link fields', async () => {
    const present = await orderSummaryLinkFieldPresent({
      root: ROOT, request: async (path: string) => path === LINK_DESCRIBE ? ok({ fields: [{ name: ORDER_SUMMARY_LINK_FIELD }] }) : notFound(),
    });
    expect(present).toBe(true);
    const absent = await orderSummaryLinkFieldPresent({
      root: ROOT, request: async (path: string) => path === LINK_DESCRIBE ? ok({ fields: [{ name: 'Quantity' }] }) : notFound(),
    });
    expect(absent).toBe(false);
    const unreadable = await orderSummaryLinkFieldPresent({ root: ROOT, request: async () => notFound() });
    expect(unreadable).toBeNull();
    const malformed = await orderSummaryLinkFieldPresent({
      root: ROOT, request: async (path: string) => path === LINK_DESCRIBE ? ok({ fields: null }) : notFound(),
    });
    expect(malformed).toBeNull();
  });
});

describe('link-schema narrowing', () => {
  const LINK_DESCRIBE = `${ROOT}/sobjects/${ORDER_SUMMARY_LINK_OBJECT}/describe`;
  const zeroRows = (linkFields: unknown) => async (path: string, method = 'GET'): Promise<Result> => {
    if (method === 'POST') throw new Error('narrowing must never invoke');
    if (path === PREVIEW) return ok(descriptor([{ name: 'orderSummaryId' }]));
    if (path === DESCRIBE_TYPE) return ok({ name: ORDER_SUMMARY_OBJECT, queryable: true });
    if (path === LINK_DESCRIBE) {
      return linkFields === null ? notFound() : ok({ name: ORDER_SUMMARY_LINK_OBJECT, fields: linkFields });
    }
    return ok({ totalSize: 0, records: [] });
  };
  test('absent link field terminalizes the zero-row shape', async () => {
    const result = await invokeOrderSummaryPreviewWithContext({ root: ROOT, route: PREVIEW, request: zeroRows([{ name: 'Quantity' }]) });
    expect(result.body.errorCode).toBe('ORDER_SUMMARY_LINK_SCHEMA_ABSENT');
    expect(result.body.message).toContain(ORDER_SUMMARY_LINK_FIELD);
    expect(result.body.setupRequirement).toContain(`${ORDER_SUMMARY_LINK_OBJECT}.${ORDER_SUMMARY_LINK_FIELD}`);
    expect(result.contextSchema?.capability).toEqual({ actionDescribed: true, typeDescribed: true, liveRowCount: 0, linkFieldPresent: false });
  });
  test('present link field keeps the mint path pending', async () => {
    const result = await invokeOrderSummaryPreviewWithContext({ root: ROOT, route: PREVIEW, request: zeroRows([{ name: ORDER_SUMMARY_LINK_FIELD }]) });
    expect(result.body.errorCode).toBe('ORDER_SUMMARY_SUBSTRATE_ABSENT');
    expect(result.contextSchema?.capability).toEqual({ actionDescribed: true, typeDescribed: true, liveRowCount: 0, linkFieldPresent: true });
  });
  test('unreadable describe proves nothing and stays pending', async () => {
    const result = await invokeOrderSummaryPreviewWithContext({ root: ROOT, route: PREVIEW, request: zeroRows(null) });
    expect(result.body.errorCode).toBe('ORDER_SUMMARY_SUBSTRATE_ABSENT');
    expect(result.contextSchema?.capability).toEqual({ actionDescribed: true, typeDescribed: true, liveRowCount: 0 });
  });
});

describe('setup-gate message hygiene', () => {
  // Mirrors the postDiagnostic trigger cascade in 1action-searcher/src/index.ts:
  // setup-gated verdicts must not carry invalid_input trigger words, or the
  // honest setup code degrades to payload blame before the parent maps it.
  const INVALID_INPUT = /invalid|malformed|required|mandatory input|illegal value|not valid|expected|unrecognized token|argument .* is null/i;
  test('setup messages avoid invalid_input triggers', async () => {
    const request = async (path: string): Promise<Result> =>
      path === PREVIEW ? ok(descriptor([{ name: 'orderSummaryId' }])) : notFound();
    const noType = await invokeOrderSummaryPreviewWithContext({ root: ROOT, route: PREVIEW, request });
    expect(noType.body.message).not.toMatch(INVALID_INPUT);
    const noAction = await invokeOrderSummaryPreviewWithContext({
      root: ROOT, route: PREVIEW, request: async () => notFound(),
    });
    expect(noAction.body.message).not.toMatch(INVALID_INPUT);
    const noLink = await invokeOrderSummaryPreviewWithContext({
      root: ROOT, route: PREVIEW,
      request: async (path: string) => {
        if (path === PREVIEW) return ok(descriptor([{ name: 'orderSummaryId' }]));
        if (path === DESCRIBE_TYPE) return ok({ name: ORDER_SUMMARY_OBJECT, queryable: true });
        if (path === `${ROOT}/sobjects/${ORDER_SUMMARY_LINK_OBJECT}/describe`) return ok({ fields: [{ name: 'Quantity' }] });
        return ok({ totalSize: 0, records: [] });
      },
    });
    expect(noLink.body.errorCode).toBe('ORDER_SUMMARY_LINK_SCHEMA_ABSENT');
    expect(noLink.body.message).not.toMatch(INVALID_INPUT);
  });
});
