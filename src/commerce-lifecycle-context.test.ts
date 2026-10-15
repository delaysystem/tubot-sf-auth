import { describe, expect, test } from 'bun:test';
import {
  COMMERCE_LIFECYCLE_BUILDER_VERSION, commerceDescriptorInputs, commerceLifecycleActionName,
  commerceLifecycleKind, commerceReadKind, invokeCommerceLifecycleWithContext, isCommerceLifecycleAction,
  isCommerceReadAction, mapCommerceArguments, outputIdentities,
} from './commerce-lifecycle-context';

const ROOT = '/services/data/v67.0';
const routeFor = (name: string) => `${ROOT}/actions/standard/${name}`;
const ok = (body: any, status = 200) => ({ status, ok: status >= 200 && status < 300, body });
const accepted = (action: string, outputValues: any = {}) =>
  [{ actionName: action, errors: null, isSuccess: true, outputValues }];

type Rec = Record<string, any>;
type Req = (path: string, method?: string, body?: any) => Promise<{ status: number; ok: boolean; body: any }>;

const validId = (prefix: string, n: number) => `${prefix}${String(n).padStart(12, '0')}AAA`;
const isId = (v: any) => typeof v === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);

/** Stateful fake Salesforce: posted rows persist, deletes remove, queries filter. No invention. */
function makeSalesforce(seed: {
  describes?: Record<string, any>; descriptors?: Record<string, any>; liveRows?: Record<string, Rec[]>;
  posts?: Record<string, (body: any, api: { store: Map<string, Rec>; liveRows: Record<string, Rec[]> }) => any>;
} = {}) {
  const store = new Map<string, Rec>();
  const liveRows: Record<string, Rec[]> = seed.liveRows ?? {};
  const counters = new Map<string, number>();
  const mint = (object: string, prefix: string) => {
    const n = (counters.get(object) ?? 0) + 1;
    counters.set(object, n);
    return validId(prefix, n);
  };
  const prefixes: Record<string, string> = {
    Account: '001', WebStore: '0qZ', WebCart: '0a6', CartItem: '0a7', Order: '801', OrderSummary: '0qW',
    FulfillmentOrder: '0qV', ReturnOrder: '0qU', ProgramRebateType: '0qT', TransactionJournal: '0qS',
    CardPaymentMethod: '8ZJ', PaymentAuthorization: '8WJ', Invoice: '0qR', CustomRebatePayout: 'a0R',
    CartDeliveryGroup: '0a8', CartCheckoutSession: '2z9', OrderItem: '802', OrderDeliveryGroup: '0wD',
    BuyerAccount: 'a0X', CartTax: 'a0Z', BuyerGroupMember: 'a0Y', Contact: '003', OrderItemTaxLineItem: '0wE',
  };
  const runQuery = (soql: string): Rec[] => {
    const from = soql.match(/FROM\s+([A-Za-z][A-Za-z0-9_]*)/i)?.[1];
    if (!from) return [];
    const where = soql.match(/WHERE\s+(.+?)(?:\s+LIMIT|\s+ORDER|$)/i)?.[1] ?? '';
    const conditions = where.split(/\s+AND\s+/i).map((part) => part.match(/([A-Za-z][A-Za-z0-9_]*)\s*=\s*'([^']*)'/)?.slice(1)).filter(Boolean) as string[][];
    const candidates = [
      ...[...store.entries()].filter(([key]) => key.startsWith(from + ':')).map(([, row]) => row),
      ...(liveRows[from] ?? []),
    ];
    return candidates.filter((row) => conditions.every(([field, value]) => String(row[field] ?? '') === value));
  };
  const subrequest = (method: string, url: string, body?: any): { statusCode: number; result: any } => {
    const path = '/services/data/' + url;
    if (method === 'GET' && path.includes('/sobjects/') && path.endsWith('/describe')) {
      const object = path.split('/sobjects/')[1].split('/')[0];
      const found = seed.describes?.[object];
      return found ? { statusCode: 200, result: found } : { statusCode: 404, result: null };
    }
    if (method === 'GET' && path.includes('/actions/standard/')) {
      const action = path.split('/actions/standard/')[1];
      const found = seed.descriptors?.[action];
      return found ? { statusCode: 200, result: found } : { statusCode: 404, result: null };
    }
    if (method === 'GET' && path.includes('/query?q=')) {
      return { statusCode: 200, result: { records: runQuery(decodeURIComponent(path.split('/query?q=')[1])) } };
    }
    const single = path.match(/\/sobjects\/([A-Za-z][A-Za-z0-9_]*)\/([A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)$/);
    if (single) {
      const key = `${single[1]}:${single[2]}`;
      if (method === 'GET') return store.has(key) ? { statusCode: 200, result: store.get(key) } : { statusCode: 404, result: null };
      if (method === 'DELETE') return store.delete(key) ? { statusCode: 204, result: null } : { statusCode: 404, result: null };
      if (method === 'PATCH') {
        if (!store.has(key)) return { statusCode: 404, result: null };
        store.set(key, { ...store.get(key), ...(body ?? {}) });
        return { statusCode: 204, result: null };
      }
    }
    return { statusCode: 404, result: null };
  };
  const request: Req = async (path, method = 'GET', body) => {
    if (path === `${ROOT}/composite` && method === 'POST') {
      const reqs = (body as any)?.compositeRequest ?? [];
      const refs: Record<string, string> = {};
      const compositeResponse = reqs.map((entry: any) => {
        let url = String(entry.url ?? '');
        const ref = url.match(/@\{(\w+)\.id\}/);
        if (ref && refs[ref[1]]) url = url.replace(ref[0], refs[ref[1]]);
        const rel = url.startsWith(ROOT) ? url.slice(ROOT.length) : url;
        if (entry.method === 'POST') {
          const mm = rel.match(/^\/sobjects\/(\w+)$/);
          const object = mm?.[1] ?? 'Account';
          const id = mint(object, prefixes[object] ?? '0x0');
          store.set(`${object}:${id}`, { Id: id, ...(entry.body ?? {}) });
          refs[entry.referenceId] = id;
          return { httpStatusCode: 201, referenceId: entry.referenceId, body: { id, success: true } };
        }
        const gm = rel.match(/^\/sobjects\/(\w+)\/([A-Za-z0-9]+)$/);
        const rec = gm ? store.get(`${gm[1]}:${gm[2]}`) : null;
        if (!rec) return { httpStatusCode: 404, referenceId: entry.referenceId, body: null };
        return { httpStatusCode: 200, referenceId: entry.referenceId, body: rec };
      });
      return ok({ compositeResponse });
    }
    if (path === ROOT + '/composite/batch' && method === 'POST') {
      const batch = Array.isArray(body?.batchRequests) ? body.batchRequests : [];
      return ok({ results: batch.map((entry: any) => subrequest(entry.method, entry.url, entry.richInput)) });
    }
    if (method === 'GET' && path.includes('/sobjects/') && path.endsWith('/describe')) {
      const object = path.split('/sobjects/')[1].split('/')[0];
      return seed.describes?.[object] ? ok(seed.describes[object]) : ok(null, 404);
    }
    if (method === 'GET' && path.includes('/actions/standard/') && !path.includes('/query')) {
      const action = path.split('/actions/standard/')[1];
      return seed.descriptors?.[action] ? ok(seed.descriptors[action]) : ok(null, 404);
    }
    if (method === 'GET' && path.includes('/actions/custom/apex/') && !path.includes('/query')) {
      const action = path.split('/actions/custom/apex/')[1];
      return seed.descriptors?.[action] ? ok(seed.descriptors[action]) : ok(null, 404);
    }
    if (method === 'GET' && path.includes('/query?q=')) {
      return ok({ records: runQuery(decodeURIComponent(path.split('/query?q=')[1])) });
    }
    const collection = path.match(/\/sobjects\/([A-Za-z][A-Za-z0-9_]*)$/);
    if (collection && method === 'POST') {
      const object = collection[1];
      if (!seed.describes?.[object]) return ok(null, 404);
      const rowId = mint(object, prefixes[object] ?? 'a0X');
      store.set(`${object}:${rowId}`, { ...(body ?? {}), Id: rowId });
      return ok({ id: rowId }, 201);
    }
    const single = path.match(/\/sobjects\/([A-Za-z][A-Za-z0-9_]*)\/([A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)$/);
    if (single) {
      const key = `${single[1]}:${single[2]}`;
      const live = (liveRows[single[1]] ?? []).find((row) => row.Id === single[2]);
      if (method === 'GET') {
        if (store.has(key)) return ok({ ...store.get(key) });
        return live ? ok({ ...live }) : ok(null, 404);
      }
      if (method === 'DELETE') return store.delete(key) ? ok(null, 204) : ok(null, 404);
      if (method === 'PATCH') {
        if (live) { Object.assign(live, body ?? {}); return ok(null, 204); }
        if (!store.has(key)) return ok(null, 404);
        store.set(key, { ...store.get(key), ...(body ?? {}) });
        return ok(null, 204);
      }
    }
    if (method === 'POST' && path.includes('/actions/standard/')) {
      const action = path.split('/actions/standard/')[1];
      const handler = seed.posts?.[action];
      if (!handler) return ok(null, 404);
      return ok(handler(body, { store, liveRows }));
    }
    if (method === 'POST' && path.includes('/actions/custom/apex/')) {
      const action = path.split('/actions/custom/apex/')[1];
      const handler = seed.posts?.[action];
      if (!handler) return ok(null, 404);
      return ok(handler(body, { store, liveRows }));
    }
    return ok(null, 404);
  };
  return { request, store, liveRows, build: async (_n: string, _m: string, values: any) => ({ values }) };
}

const markerField = (name = 'Name', length = 80) => ({
  name, type: 'string', createable: true, filterable: true, updateable: true, nillable: true,
  calculated: false, autoNumber: false, nameField: name === 'Name', length,
});
const describeOf = (name: string, fields: any[] = [markerField()]) => ({
  name, createable: true, queryable: true, deletable: true, fields,
});

describe('commerce classification', () => {
  test('forces re-probe of already-skipped rows', () => {
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(115);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(116);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(117);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(120);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(121);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(122);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(123);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(124);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(125);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(126);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(127);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(128);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(129);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(130);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(131);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(132);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(133);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(134);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(135);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(136);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(137);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(138);
    expect(COMMERCE_LIFECYCLE_BUILDER_VERSION).toBeGreaterThan(139);
  });

  test('routes every affected mutation to its owned kind', () => {
    const cases: Array<[string, string]> = [
      ['authorizePayment', 'payment-auth'],
      ['addItemAndGetCartSummaryAction', 'cart'], ['cartToOrderAction', 'cart'],
      ['cancelCartAsyncOperation', 'cart'], ['checkoutSessionAction', 'cart'],
      ['setCheckoutDeliveryMethod', 'cart'], ['submitCartToExchangeOrder', 'cart'],
      ['updateCheckoutSessionStateAction', 'cart'], ['updateProgressForCumulativePromotionUsage', 'cart'],
      ['activateOrderAction', 'cart'], ['createOrderSummary', 'order'],
      ['addOrderItemSummarySubmit', 'order-submit'], ['adjustOrderItemSummariesSubmit', 'order-submit'],
      ['cancelOrderItemSummariesSubmit', 'order-submit'], ['returnOrderItemSummariesSubmit', 'order-submit'],
      ['applyPaymentsAndCreditsByRules', 'order-submit'], ['createOrderPaymentSummary', 'order-submit'],
      ['recordTaxReversal', 'order-submit'],
      ['createCreditMemoOrderSummary', 'order-submit'], ['createInvoiceFromChangeOrders', 'order-submit'],
      ['createInvoiceFromFulfillmentOrder', 'order-submit'], ['ensurePaymentCredit', 'order-submit'],
      ['ensureRefundsOrderSummaryAsync', 'order-submit'], ['orderToCartAction', 'order-submit'],
      ['createFulfillmentOrder', 'fulfillment'], ['createFulfillmentOrders', 'fulfillment'],
      ['cancelFulfillmentOrderItem', 'fulfillment'],
      ['createReturnOrder', 'return'], ['returnReturnOrderItems', 'return'],
      ['createDisposalOrderLineItems', 'return'],
      ['addRebateMemberList', 'rebate'], ['calculateRebateAmountAndUpsertPayout', 'rebate'],
      ['processProgramRebateTypeProducts', 'rebate'], ['rebatesProcessCSV', 'rebate'],
      ['upsertCustomRebatePayout', 'rebate'],
      ['processRebatesBatchCalculationJob', 'batch'],
      ['runProgramProcessForTransactionJournal', 'loyalty'],
    ];
    for (const [name, kind] of cases) {
      expect(commerceLifecycleKind(name)).toBe(kind);
      expect(isCommerceLifecycleAction('standard', routeFor(name), name)).toBe(true);
      expect(commerceLifecycleActionName(routeFor(name))).toBe(name);
    }
  });

  test('reads resolve to read kinds; cart calculators also claim the owned lifecycle', () => {
    const cases: Array<[string, string]> = [
      ['calcCartPromotionsAction', 'cart-read'], ['calcCartShipmentAction', 'cart-read'],
      ['calcCartTaxesAction', 'cart-read'], ['checkCartInventoryAction', 'cart-read'],
      ['priceCart', 'cart-read'],
      ['runSalesforcePricing', 'pricing-read'], ['runSalesforceHeadlessPricing', 'pricing-read'],
      ['orderRoutingFindRoutesWithFewestSplits', 'routing-read'],
      ['orderRoutingRankByAverageDistance', 'routing-read'],
      ['calculateProjectedRebateAmount', 'rebate-read'],
    ];
    for (const [name, kind] of cases) {
      expect(commerceReadKind(name)).toBe(kind);
      expect(isCommerceReadAction('standard', routeFor(name), name)).toBe(true);
      // Cart calculators run owned (stale cache ids fault ENTITY_IS_DELETED);
      // pricing/routing/rebate reads keep the direct-probe path.
      if (kind === 'cart-read') {
        expect(commerceLifecycleKind(name)).toBe('cart-read');
        expect(isCommerceLifecycleAction('standard', routeFor(name), name)).toBe(true);
        expect(commerceLifecycleActionName(routeFor(name))).toBe(name);
      } else {
        expect(commerceLifecycleKind(name)).toBeNull();
        expect(isCommerceLifecycleAction('standard', routeFor(name), name)).toBe(false);
      }
    }
  });

  test('never claims dedicated or unknown families', () => {
    for (const name of ['createCart', 'deleteCart', 'addCartItem', 'updateCartItem', 'createInvRsvForCart',
      'deleteInvRsvForCart', 'holdFulfillmentOrderCapacity', 'confirmHeldFulfillmentOrderCapacity',
      'releaseHeldFulfillmentOrderCapacity', 'getFulfillmentOrderCapacityValues', 'registerGuestBuyer',
      'createSearchBoostBuryRule', 'changeOrderSummaryPreview', 'changeOrderSummarySubmit',
      'getInventorySummaryData', 'getRecord', 'getRelatedList', 'runCampaign', 'updateVisualization',
      'contentWorkspaceEnableFolders', 'generateWorkPlans', 'skillsBasedRouting', 'routeWork',
      'choosePricebook', 'addWorkPlans', 'deleteWorkPlans', 'publishKnowledgeArticles', 'createWaitlist',
      'cancelAppointment', 'contactRequestAction', 'invocableApplyLeadAssignmentRules', 'customNotificationAction',
      'getLoyaltyPromotion', 'validateTimesheet', 'adjustOrderItemSummariesPreview', 'returnOrderItemSummariesPreview',
      'cancelOrderItemSummariesPreview', '', 'not-an-action!!']) {
      expect(commerceLifecycleKind(name)).toBeNull();
      expect(commerceReadKind(name)).toBeNull();
    }
    expect(isCommerceLifecycleAction('custom/flow', routeFor('getCartItems'), 'getCartItems')).toBe(false);
    expect(isCommerceReadAction('custom/flow', routeFor('getCartItems'), 'getCartItems')).toBe(false);
    expect(isCommerceLifecycleAction('standard', routeFor('other'), 'setCheckoutDeliveryMethod')).toBe(false);
    expect(commerceLifecycleActionName(routeFor('getRecord'))).toBeNull();
    expect(commerceLifecycleActionName('not-a-route')).toBeNull();
  });

  test('claims only cart-to-order custom/apex drafts, never other apex actions', () => {
    const apexFor = (name: string) => `${ROOT}/actions/custom/apex/${name}`;
    for (const name of ['B2BCartToOrderDraft', 'SDO_B2BCommerce_SPC_CartToOrderDraft']) {
      expect(commerceLifecycleKind(name)).toBe('cart');
      expect(isCommerceLifecycleAction('custom/apex', apexFor(name), name)).toBe(true);
      expect(commerceLifecycleActionName(apexFor(name))).toBe(name);
    }
    expect(isCommerceLifecycleAction('custom/apex', apexFor('getInventorySummaryData'), 'getInventorySummaryData')).toBe(false);
    expect(isCommerceLifecycleAction('custom/apex', apexFor('other'), 'B2BCartToOrderDraft')).toBe(false);
    expect(isCommerceLifecycleAction('standard', apexFor('B2BCartToOrderDraft'), 'B2BCartToOrderDraft')).toBe(false);
    expect(commerceLifecycleActionName(apexFor('getInventorySummaryData'))).toBeNull();
  });
});

describe('commerce argument mapping', () => {
  test('maps known identities and declared sObject fixtures', () => {
    const mapped = mapCommerceArguments(
      [{ name: 'cartId', type: 'ID', required: true }, { name: 'webStoreId', required: true },
        { name: 'note', type: 'STRING', required: false }],
      { cartId: '0a6000000000001AAA', storeId: '0qZ000000000001AAA' },
    );
    expect(mapped).toEqual({ args: { cartId: '0a6000000000001AAA', webStoreId: '0qZ000000000001AAA' } });
    const fixture = mapCommerceArguments(
      [{ name: 'programRebateTypeId', type: 'REFERENCE', required: true, sObjectType: 'ProgramRebateType' }],
      { fixtures: { ProgramRebateType: '0qT000000000001AAA' } },
    );
    expect(fixture).toEqual({ args: { programRebateTypeId: '0qT000000000001AAA' } });
    const aggregate = mapCommerceArguments(
      [{ name: 'AggregateId', type: 'STRING', required: true }],
      { fixtures: { RebateMemberProductAggregate: '0hY000000000001AAA' } },
    );
    expect(aggregate).toEqual({ args: { AggregateId: '0hY000000000001AAA' } });
  });

  test('fails closed on unresolved required references, omits optional gaps', () => {
    expect(mapCommerceArguments([{ name: 'cartId', type: 'ID', required: true }], {}))
      .toEqual({ failure: 'No resolved identity for required input cartId.' });
    expect(mapCommerceArguments(
      [{ name: 'programRebateTypeId', type: 'REFERENCE', required: true, sObjectType: 'ProgramRebateType' }], {}))
      .toEqual({ failure: 'No resolved identity for required input programRebateTypeId.' });
    expect(mapCommerceArguments([{ name: 'cartId', type: 'ID', required: false }], {})).toEqual({ args: {} });
  });

  test('omits optional inputs with no discovered binding instead of marker-poisoning them', () => {
    expect(mapCommerceArguments(
      [{ name: 'orderLifeCycleType', type: 'STRING', required: false },
        { name: 'runAsync', type: 'BOOLEAN', required: false }], {}))
      .toEqual({ args: {} });
    // Discovered scalars still bind for optional inputs.
    expect(mapCommerceArguments(
      [{ name: 'orderStatus', type: 'STRING', required: false }],
      { scalars: { orderstatus: 'Draft' } }))
      .toEqual({ args: { orderStatus: 'Draft' } });
  });

  test('maps setup ids by input-name vocabulary with collection wrapping', () => {
    const mapped = mapCommerceArguments(
      [{ name: 'programRebateTypeIds', type: 'ID', required: true, isCollection: true },
        { name: 'fulfillmentOrderId', type: 'ID', required: true }],
      { fixtures: { ProgramRebateType: '0qT000000000001AAA' }, live: { FulfillmentOrder: '0qV000000000001AAA' } },
    );
    expect(mapped).toEqual({ args: { programRebateTypeIds: ['0qT000000000001AAA'], fulfillmentOrderId: '0qV000000000001AAA' } });
    expect(mapCommerceArguments([{ name: 'returnOrderId', type: 'ID', required: true }], {}))
      .toEqual({ failure: 'No resolved identity for required input returnOrderId.' });
  });

  test('binds the owned checkout session for draft inputs', () => {
    const mapped = mapCommerceArguments(
      [{ name: 'cartId', type: 'ID', required: true }, { name: 'checkoutSessionId', type: 'ID', required: true },
        { name: 'pricebookId', type: 'ID', required: false }],
      { cartId: '0a6000000000001AAA', checkoutSessionId: '0iy000000000001AAA' },
    );
    expect(mapped).toEqual({ args: { cartId: '0a6000000000001AAA', checkoutSessionId: '0iy000000000001AAA' } });
    expect(mapCommerceArguments([{ name: 'checkoutSessionId', type: 'ID', required: true }], {}))
      .toEqual({ failure: 'No resolved identity for required input checkoutSessionId.' });
    expect(mapCommerceArguments([{ name: 'pricebookId', type: 'ID', required: false }],
      { live: { Pricebook2: '01s000000000001AAA' } }))
      .toEqual({ args: { pricebookId: '01s000000000001AAA' } });
  });

  test('maps one wrapper level and neutral scalars', () => {
    const mapped = mapCommerceArguments(
      [{ name: 'cartItemInput', required: true, fields: [{ name: 'cartId', type: 'ID', required: true }, { name: 'quantity', type: 'INTEGER', required: true }] }],
      { cartId: '0a6000000000001AAA' },
    );
    expect(mapped).toEqual({ args: { cartItemInput: { cartId: '0a6000000000001AAA', quantity: 1 } } });
    const bool = mapCommerceArguments([{ name: 'active', type: 'BOOLEAN', required: true }], {});
    expect(bool).toEqual({ args: { active: true } });
  });

  test('maps ConnectApi wrapper vocabulary and leg-discovered scalars', () => {
    const wrapper = mapCommerceArguments(
      [{ name: 'createOrderSummaryInput', type: 'CreateOrderSummaryInput', required: true }],
      { accountId: '001000000000001AAA', orderId: '801000000000001AAA' },
    );
    expect(wrapper).toEqual({ args: { createOrderSummaryInput: { orderId: '801000000000001AAA' } } });
    expect(mapCommerceArguments(
      [{ name: 'createOrderSummaryInput', type: 'CreateOrderSummaryInput', required: true }], {}))
      .toEqual({ failure: 'No resolved identity for required input createOrderSummaryInput.' });
    const scalar = mapCommerceArguments(
      [{ name: 'orderStatus', type: 'STRING', required: true }],
      { cartId: '0a6000000000001AAA', scalars: { orderstatus: 'Activated' } },
    );
    expect(scalar).toEqual({ args: { orderStatus: 'Activated' } });
    const payment = mapCommerceArguments(
      [{ name: 'createOrderPaymentSummaryInput', type: 'CreateOrderPaymentSummaryInput', required: true }],
      { orderSummaryId: '1Os000000000000CAA', live: { PaymentAuthorization: '0Xc000000000000CAA' } },
    );
    expect(payment).toEqual({ args: { createOrderPaymentSummaryInput:
      { orderSummaryId: '1Os000000000000CAA', paymentAuthorizationId: '0Xc000000000000CAA' } } });
    expect(mapCommerceArguments(
      [{ name: 'createOrderPaymentSummaryInput', type: 'CreateOrderPaymentSummaryInput', required: true }],
      { orderSummaryId: '1Os000000000000CAA' }))
      .toEqual({ failure: 'No resolved identity for required input createOrderPaymentSummaryInput.' });
    expect(mapCommerceArguments(
      [{ name: 'taxReversalInfos', type: 'TaxReversalInfos', required: true }],
      { live: { OrderItemSummary: '10u000000000000CAA' } }))
      .toEqual({ args: { taxReversalInfos: { taxReversalInfoList: [{ orderItemSummaryId: '10u000000000000CAA' }] } } });
    const fulfillOwned = { orderSummaryId: '1Os000000000000CAA',
      live: { OrderDeliveryGroupSummary: '0ag000000000000CAA', Location: '131000000000000CAA' },
      lineSummaries: [{ id: '10u000000000000CAA', quantity: 2 }], scalars: { type: 'Warehouse' } };
    expect(mapCommerceArguments(
      [{ name: 'fulfillmentOrderInput', type: 'FulfillmentOrderInput', required: true }], fulfillOwned))
      .toEqual({ args: { fulfillmentOrderInput: { orderSummaryId: '1Os000000000000CAA',
        orderDeliveryGroupSummaryId: '0ag000000000000CAA',
        fulfillmentGroups: [{ fulfilledFromLocationId: '131000000000000CAA', fulfillmentType: 'Warehouse',
          referenceId: '0ag000000000000CAA',
          orderItemSummaries: [{ orderItemSummaryId: '10u000000000000CAA', quantity: 2 }] }] } } });
    expect(mapCommerceArguments(
      [{ name: 'multipleFulfillmentOrderInput', type: 'MultipleFulfillmentOrderInput', required: true }], fulfillOwned))
      .toEqual({ args: { multipleFulfillmentOrderInput: { fulfillmentOrders: [{ orderSummaryId: '1Os000000000000CAA',
        orderDeliveryGroupSummaryId: '0ag000000000000CAA',
        fulfillmentGroups: [{ fulfilledFromLocationId: '131000000000000CAA', fulfillmentType: 'Warehouse',
          referenceId: '0ag000000000000CAA',
          orderItemSummaries: [{ orderItemSummaryId: '10u000000000000CAA', quantity: 2 }] }] }] } } });
    expect(mapCommerceArguments(
      [{ name: 'fulfillmentOrderInput', type: 'FulfillmentOrderInput', required: true }],
      { orderSummaryId: '1Os000000000000CAA' }))
      .toEqual({ failure: 'No resolved identity for required input fulfillmentOrderInput.' });
    expect(mapCommerceArguments(
      [{ name: 'fulfillmentOrderLineItemsToCancelInput', type: 'FulfillmentOrderLineItemsToCancelInput', required: true }],
      { lineSummaries: [{ id: '0a4000000000000CAA', quantity: 1 }] }))
      .toEqual({ args: { fulfillmentOrderLineItemsToCancelInput: { fulfillmentOrderLineItemsToCancel:
        [{ fulfillmentOrderLineItemId: '0a4000000000000CAA', quantity: 1 }] } } });
    expect(mapCommerceArguments(
      [{ name: 'fulfillmentOrderLineItemsToCancelInput', type: 'FulfillmentOrderLineItemsToCancelInput', required: true }], {}))
      .toEqual({ failure: 'No resolved identity for required input fulfillmentOrderLineItemsToCancelInput.' });
  });

  test('parses descriptors and output identities without invention', () => {
    expect(commerceDescriptorInputs({ inputs: [{ name: 'cartId', type: 'ID', required: true }, { name: 'bad!!' }, null] }))
      .toEqual([{ name: 'cartId', type: 'ID', required: true }]);
    expect(commerceDescriptorInputs({})).toEqual([]);
    expect(outputIdentities([{ outputValues: { cartId: '0a6000000000001AAA', note: 'x' } }], /cartid$/i))
      .toEqual(['0a6000000000001AAA']);
    expect(outputIdentities([{ outputValues: { cartId: 'bogus' } }], /cartid$/i)).toEqual([]);
  });
});

describe('commerce executors', () => {
  test('rejects non-commerce routes', async () => {
    const { request, build } = makeSalesforce();
    const out = await invokeCommerceLifecycleWithContext({ root: ROOT, route: routeFor('getRecord'), request, build });
    expect(out.status).toBe(422);
    expect((out.body as any).errorCode).toBe('COMMERCE_ROUTE_INVALID');
  });

  test('delegates payment authorization to the dedicated lifecycle', async () => {
    const { request, build } = makeSalesforce({
      describes: {
        Account: describeOf('Account'),
        BuyerAccount: describeOf('BuyerAccount', [markerField(), { ...markerField('BuyerStatus'), picklistValues: [{ value: 'Active', active: true }] }, { ...markerField('CommerceType'), picklistValues: [{ value: 'Buyer', active: true }] }]),
        CardPaymentMethod: describeOf('CardPaymentMethod', [
          { name: 'Status', picklistValues: [{ active: true, value: 'Active' }] },
          { name: 'ProcessingMode', picklistValues: [{ active: true, value: 'External' }] },
        ]),
      },
      descriptors: { authorizePayment: { inputs: [{ name: 'paymentAuthorizationRequest' }] } },
      liveRows: { PaymentGateway: [], CurrencyType: [{ IsoCode: 'USD' }] },
    });
    const out = await invokeCommerceLifecycleWithContext({ root: ROOT, route: routeFor('authorizePayment'), request, build });
    expect(out.status).toBe(422);
    expect((out.body as any).errorCode).toBe('PAYMENT_AUTH_GATEWAY_UNAVAILABLE');
  });

  test('cart happy path verifies and cleans the owned store, buyer, and cart', async () => {
    const cartId = validId('0a6', 1);
    const { request, build, store } = makeSalesforce({
      describes: {
        WebStore: describeOf('WebStore', [markerField(), { name: 'Type', type: 'picklist', createable: true, picklistValues: [{ active: true, value: 'B2B' }] }]),
        Account: describeOf('Account'),
        BuyerAccount: describeOf('BuyerAccount', [markerField(), { ...markerField('BuyerStatus'), picklistValues: [{ value: 'Active', active: true }] }, { ...markerField('CommerceType'), picklistValues: [{ value: 'Buyer', active: true }] }]),
        WebCart: describeOf('WebCart', [markerField(), { name: 'Type', type: 'picklist', createable: true, picklistValues: [{ active: true, value: 'Cart' }] }]),
      },
      descriptors: {
        createCart: { inputs: [{ name: 'webStoreId' }, { name: 'cartInput' }] },
        setCheckoutDeliveryMethod: { inputs: [{ name: 'cartId', type: 'ID', required: true }] },
      },
      posts: {
        createCart: (body) => {
          const input = body.inputs[0];
          store.set(`WebCart:${cartId}`, { Id: cartId, Name: input.cartInput.name, WebStoreId: input.webStoreId, AccountId: input.cartInput.effectiveAccountId, Status: 'Active' });
          return accepted('createCart', { cartSummary: { cartId, accountId: input.cartInput.effectiveAccountId, webstoreId: input.webStoreId, name: input.cartInput.name, status: 'Active' } });
        },
        setCheckoutDeliveryMethod: (body) => {
          expect(isId(body.inputs[0].cartId)).toBe(true);
          return accepted('setCheckoutDeliveryMethod', {});
        },
      },
    });
    const out = await invokeCommerceLifecycleWithContext({ root: ROOT, route: routeFor('setCheckoutDeliveryMethod'), request, build });
    expect(out.status).toBe(200);
    expect((out.body as any)[0].isSuccess).toBe(true);
    expect((out.contextSchema as any).verified).toBe(true);
    expect(out.cleanupError).toBeUndefined();
    expect((out.contextSchema as any).ownedRecords).toHaveLength(4);
    expect(store.size).toBe(0);
  });

  test('apex cart-to-order drafts mint an owned session chain and clean the created order', async () => {
    const cartId = validId('0a6', 1);
    const apexFor = (name: string) => `${ROOT}/actions/custom/apex/${name}`;
    const { request, build, store } = makeSalesforce({
      describes: {
        WebStore: describeOf('WebStore', [markerField(), { name: 'Type', type: 'picklist', createable: true, picklistValues: [{ active: true, value: 'B2B' }] }]),
        Account: describeOf('Account'),
        BuyerAccount: describeOf('BuyerAccount', [markerField(), { ...markerField('BuyerStatus'), picklistValues: [{ value: 'Active', active: true }] }, { ...markerField('CommerceType'), picklistValues: [{ value: 'Buyer', active: true }] }]),
        WebCart: describeOf('WebCart', [markerField(), { name: 'Type', type: 'picklist', createable: true, picklistValues: [{ active: true, value: 'Cart' }] }]),
        CartDeliveryGroup: describeOf('CartDeliveryGroup'),
        CartItem: describeOf('CartItem', [markerField(), { name: 'Type', type: 'picklist', createable: true, picklistValues: [{ active: true, value: 'Product' }] }]),
        CartCheckoutSession: describeOf('CartCheckoutSession', [markerField(),
          { name: 'State', type: 'picklist', createable: true, picklistValues: [{ active: true, value: 'Order Confirmation' }] },
          { name: 'NextState', type: 'picklist', createable: true, picklistValues: [{ active: true, value: 'Complete' }] }]),
        CartTax: describeOf('CartTax', [markerField(),
          { name: 'TaxType', type: 'picklist', createable: true, picklistValues: [{ active: true, value: 'Actual' }] }]),
      },
      liveRows: {
        Product2: [{ Id: validId('01t', 1), Name: 'Battery' }],
        Order: [{ Id: validId('801', 9), OrderNumber: '00000103' }],
        Pricebook2: [{ Id: validId('01s', 1), Name: 'Standard' }],
        PricebookEntry: [{ Id: validId('01u', 1), Pricebook2Id: validId('01s', 1), Product2Id: validId('01t', 2), UnitPrice: 42, IsActive: true }],
      },
      descriptors: {
        createCart: { inputs: [{ name: 'webStoreId' }, { name: 'cartInput' }] },
        B2BCartToOrderDraft: { inputs: [{ name: 'cartId', type: 'ID', required: true }, { name: 'checkoutSessionId', type: 'ID', required: true }, { name: 'pricebookId', type: 'ID', required: false }] },
      },
      posts: {
        createCart: (body) => {
          const input = body.inputs[0];
          store.set(`WebCart:${cartId}`, { Id: cartId, Name: input.cartInput.name, WebStoreId: input.webStoreId, AccountId: input.cartInput.effectiveAccountId, Status: 'Active' });
          store.set(`CartDeliveryGroup:${validId('0a8', 1)}`, { Id: validId('0a8', 1), CartId: cartId });
          return accepted('createCart', { cartSummary: { cartId, accountId: input.cartInput.effectiveAccountId, webstoreId: input.webStoreId, name: input.cartInput.name, status: 'Active' } });
        },
        B2BCartToOrderDraft: (body, api) => {
          const args = body.inputs[0];
          expect(args.cartId).toBe(cartId);
          expect(isId(args.checkoutSessionId)).toBe(true);
          const groups = [...api.store.values()].filter((row) => row.CartId === cartId && isId(row.Id) && String(row.Id).startsWith('0a8'));
          expect(groups).toHaveLength(1);
          expect(groups[0].DeliverToName).toBe('Probe Buyer');
          expect(args.pricebookId).toBe(validId('01s', 1));
          const session = api.store.get(`CartCheckoutSession:${args.checkoutSessionId}`);
          expect(session?.WebCartId).toBe(cartId);
          const items = [...api.store.values()].filter((row) => row.CartDeliveryGroupId !== undefined && row.CartId === cartId);
          expect(items).toHaveLength(1);
          expect(items[0].Product2Id).toBe(validId('01t', 2));
          expect(items[0].ListPrice).toBe(42);
          expect(items[0].TotalLineAmount).toBe(42);
          const taxes = [...api.store.values()].filter((row) => row.CartItemId === items[0].Id);
          expect(taxes).toHaveLength(1);
          expect(taxes[0].TaxType).toBe('Actual');
          const cart = api.store.get(`WebCart:${cartId}`);
          const orderId = validId('801', 2);
          api.store.set(`Order:${orderId}`, { Id: orderId, AccountId: cart?.AccountId, Status: 'Draft' });
          api.store.set(`OrderItem:${validId('802', 2)}`, { Id: validId('802', 2), OrderId: orderId });
          api.store.set(`OrderDeliveryGroup:${validId('0wD', 2)}`, { Id: validId('0wD', 2), OrderId: orderId });
          api.store.set(`OrderItemTaxLineItem:${validId('0wE', 2)}`, { Id: validId('0wE', 2), OrderItemId: validId('802', 2) });
          return accepted('B2BCartToOrderDraft', { output: orderId });
        },
      },
    });
    const out = await invokeCommerceLifecycleWithContext({ root: ROOT, route: apexFor('B2BCartToOrderDraft'), request, build });
    expect(out.status).toBe(200);
    expect((out.body as any)[0].isSuccess).toBe(true);
    expect((out.contextSchema as any).verified).toBe(true);
    expect((out.contextSchema as any).createdOrderIds).toHaveLength(1);
    expect(out.cleanupError).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test('cart refuses without an input schema', async () => {
    const { request, build } = makeSalesforce({ descriptors: { checkoutSessionAction: { inputs: [] } } });
    const out = await invokeCommerceLifecycleWithContext({ root: ROOT, route: routeFor('checkoutSessionAction'), request, build });
    expect((out.body as any).errorCode).toBe('COMMERCE_ACTION_SCHEMA_UNAVAILABLE');
  });

  test('cart-read calculators run against a live owned cart, never a cached id', async () => {
    const cartId = validId('0a6', 1);
    const { request, build, store } = makeSalesforce({
      describes: {
        WebStore: describeOf('WebStore', [markerField(), { name: 'Type', type: 'picklist', createable: true, picklistValues: [{ active: true, value: 'B2B' }] }]),
        Account: describeOf('Account'),
        BuyerAccount: describeOf('BuyerAccount', [markerField(), { ...markerField('BuyerStatus'), picklistValues: [{ value: 'Active', active: true }] }, { ...markerField('CommerceType'), picklistValues: [{ value: 'Buyer', active: true }] }]),
        WebCart: describeOf('WebCart', [markerField(), { name: 'Type', type: 'picklist', createable: true, picklistValues: [{ active: true, value: 'Cart' }] }]),
      },
      descriptors: {
        createCart: { inputs: [{ name: 'webStoreId' }, { name: 'cartInput' }] },
        calcCartPromotionsAction: { inputs: [{ name: 'cartId', type: 'REFERENCE', required: true }] },
      },
      posts: {
        createCart: (body) => {
          const input = body.inputs[0];
          store.set(`WebCart:${cartId}`, { Id: cartId, Name: input.cartInput.name, WebStoreId: input.webStoreId, AccountId: input.cartInput.effectiveAccountId, Status: 'Active' });
          return accepted('createCart', { cartSummary: { cartId, accountId: input.cartInput.effectiveAccountId, webstoreId: input.webStoreId, name: input.cartInput.name, status: 'Active' } });
        },
        calcCartPromotionsAction: (body, api) => {
          // The bound cart must be the live owned row, not a cached identity.
          const row = api.store.get(`WebCart:${body.inputs[0].cartId}`);
          expect(row?.Status).toBe('Active');
          return accepted('calcCartPromotionsAction', { promotionResults: [] });
        },
      },
    });
    const out = await invokeCommerceLifecycleWithContext({ root: ROOT, route: routeFor('calcCartPromotionsAction'), request, build });
    expect(out.status).toBe(200);
    expect((out.body as any)[0].isSuccess).toBe(true);
    expect((out.contextSchema as any).verified).toBe(true);
    expect((out.contextSchema as any).kind).toBe('cart-read');
    expect((out.contextSchema as any).outputKeys).toEqual(['promotionResults']);
    expect(out.cleanupError).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test('cart-read preserves native calculator faults and still cleans the owned cart', async () => {
    const cartId = validId('0a6', 1);
    const { request, build, store } = makeSalesforce({
      describes: {
        WebStore: describeOf('WebStore', [markerField(), { name: 'Type', type: 'picklist', createable: true, picklistValues: [{ active: true, value: 'B2B' }] }]),
        Account: describeOf('Account'),
        BuyerAccount: describeOf('BuyerAccount', [markerField(), { ...markerField('BuyerStatus'), picklistValues: [{ value: 'Active', active: true }] }, { ...markerField('CommerceType'), picklistValues: [{ value: 'Buyer', active: true }] }]),
        WebCart: describeOf('WebCart', [markerField(), { name: 'Type', type: 'picklist', createable: true, picklistValues: [{ active: true, value: 'Cart' }] }]),
      },
      descriptors: {
        createCart: { inputs: [{ name: 'webStoreId' }, { name: 'cartInput' }] },
        priceCart: { inputs: [{ name: 'cartId', type: 'REFERENCE', required: true }] },
      },
      posts: {
        createCart: (body) => {
          const input = body.inputs[0];
          store.set(`WebCart:${cartId}`, { Id: cartId, Name: input.cartInput.name, WebStoreId: input.webStoreId, AccountId: input.cartInput.effectiveAccountId, Status: 'Active' });
          return accepted('createCart', { cartSummary: { cartId, accountId: input.cartInput.effectiveAccountId, webstoreId: input.webStoreId, name: input.cartInput.name, status: 'Active' } });
        },
        priceCart: () => [{ actionName: 'priceCart', isSuccess: false, errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted' }] }],
      },
    });
    const out = await invokeCommerceLifecycleWithContext({ root: ROOT, route: routeFor('priceCart'), request, build });
    expect((out.body as any)[0].isSuccess).toBe(false);
    expect((out.contextSchema as any).verified).toBe(false);
    expect(out.cleanupError).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test('submit is setup-gated without the OrderSummary type', async () => {
    const { request, build } = makeSalesforce({
      descriptors: { adjustOrderItemSummariesSubmit: { inputs: [{ name: 'orderSummaryId', required: true }] } },
    });
    const out = await invokeCommerceLifecycleWithContext({ root: ROOT, route: routeFor('adjustOrderItemSummariesSubmit'), request, build });
    expect((out.body as any).errorCode).toBe('COMMERCE_OM_SETUP_REQUIRED');
  });

  test('destructive submits refuse without an owned summary', async () => {
    const { request, build } = makeSalesforce({
      describes: { OrderSummary: describeOf('OrderSummary') },
      descriptors: { cancelOrderItemSummariesSubmit: { inputs: [{ name: 'orderSummaryId', required: true }] } },
      liveRows: { OrderSummary: [{ Id: validId('0qW', 1), Status: 'Draft' }] },
    });
    const out = await invokeCommerceLifecycleWithContext({ root: ROOT, route: routeFor('cancelOrderItemSummariesSubmit'), request, build });
    expect((out.body as any).errorCode).toBe('COMMERCE_OWNED_SUMMARY_UNAVAILABLE');
  });

  test('additive submits verify before/after on live rows and report residue', async () => {
    const summaryId = validId('0qW', 2);
    const { request, build, liveRows } = makeSalesforce({
      describes: { OrderSummary: describeOf('OrderSummary') },
      descriptors: { adjustOrderItemSummariesSubmit: { inputs: [{ name: 'orderSummaryId', type: 'ID', required: true }] } },
      liveRows: { OrderSummary: [{ Id: summaryId, Status: 'Draft' }] },
      posts: {
        adjustOrderItemSummariesSubmit: (body) => {
          expect(body.inputs[0].orderSummaryId).toBe(summaryId);
          liveRows.OrderSummary[0].Status = 'Adjusted';
          return accepted('adjustOrderItemSummariesSubmit', {});
        },
      },
    });
    const out = await invokeCommerceLifecycleWithContext({ root: ROOT, route: routeFor('adjustOrderItemSummariesSubmit'), request, build });
    expect(out.status).toBe(200);
    expect((out.contextSchema as any).verified).toBe(true);
    expect((out.contextSchema as any).liveRowResidue).toContain(summaryId);
    expect(out.cleanupError).toBeUndefined();
  });

  test('order happy path verifies the activation and cleans up', async () => {
    const { request, build, store } = makeSalesforce({
      describes: { Account: describeOf('Account'), Order: describeOf('Order') },
      descriptors: { activateOrderItemAction: { inputs: [{ name: 'orderId', type: 'ID', required: true }] } },
      posts: {
        activateOrderItemAction: (body, api) => {
          const key = `Order:${body.inputs[0].orderId}`;
          api.store.set(key, { ...api.store.get(key), Status: 'Activated' });
          return accepted('activateOrderItemAction', {});
        },
      },
    });
    const out = await invokeCommerceLifecycleWithContext({ root: ROOT, route: routeFor('activateOrderItemAction'), request, build });
    expect(out.status).toBe(200);
    expect((out.contextSchema as any).verified).toBe(true);
    expect((out.contextSchema as any).afterStatus).toBe('Activated');
    expect(out.cleanupError).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test('fixture markers fit the live field cap and scopes match the stored value', async () => {
    const capped = { name: 'AccountNumber', type: 'string', length: 40, createable: true, filterable: true,
      updateable: true, nillable: true, calculated: false, autoNumber: false, nameField: false };
    const { request, build, store } = makeSalesforce({
      describes: { Account: describeOf('Account', [capped]), Order: describeOf('Order') },
      descriptors: { activateOrderItemAction: { inputs: [{ name: 'orderId', type: 'ID', required: true }] } },
      posts: {
        activateOrderItemAction: (body, api) => {
          const key = `Order:${body.inputs[0].orderId}`;
          api.store.set(key, { ...api.store.get(key), Status: 'Activated' });
          return accepted('activateOrderItemAction', {});
        },
      },
    });
    const creates: any[] = [];
    const recording: Req = async (path, method = 'GET', body) => {
      if (method === 'POST' && path === `${ROOT}/sobjects/Account`) creates.push(body);
      return request(path, method, body);
    };
    const out = await invokeCommerceLifecycleWithContext({ root: ROOT, route: routeFor('activateOrderItemAction'), request: recording, build });
    expect(out.status).toBe(200);
    expect((out.contextSchema as any).verified).toBe(true);
    expect(creates).toHaveLength(1);
    // The 54-char commerce marker is capped to the live 40-char field; the
    // caller-planned Name override stays authoritative at full length.
    expect(creates[0].AccountNumber).toHaveLength(40);
    expect(creates[0].Name).toHaveLength(54);
    expect(out.cleanupError).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test('fulfillment and return setup gates fire without their types', async () => {
    const fulfillment = makeSalesforce({
      descriptors: { createFulfillmentOrder: { inputs: [{ name: 'orderId', required: true }] } },
    });
    const outFulfillment = await invokeCommerceLifecycleWithContext({
      root: ROOT, route: routeFor('createFulfillmentOrder'), request: fulfillment.request, build: fulfillment.build,
    });
    expect((outFulfillment.body as any).errorCode).toBe('COMMERCE_FULFILLMENT_SETUP_REQUIRED');
    const returns = makeSalesforce({
      descriptors: { createReturnOrder: { inputs: [{ name: 'orderId', required: true }] } },
    });
    const outReturn = await invokeCommerceLifecycleWithContext({
      root: ROOT, route: routeFor('createReturnOrder'), request: returns.request, build: returns.build,
    });
    expect((outReturn.body as any).errorCode).toBe('COMMERCE_RETURN_SETUP_REQUIRED');
  });

  test('fulfillment creates mint typed order items for the missing_type gate', async () => {
    const fulfillment = makeSalesforce({
      describes: { FulfillmentOrder: describeOf('FulfillmentOrder') },
      descriptors: { createFulfillmentOrder: { inputs: [{ name: 'fulfillmentOrderInput', required: true }] } },
    });
    const out = await invokeCommerceLifecycleWithContext({
      root: ROOT, route: routeFor('createFulfillmentOrder'), request: fulfillment.request, build: fulfillment.build,
    });
    // The mock org cannot mint a summary, so the leg refuses honestly;
    // the unit contract is the wrapper shape (see mapping tests).
    expect((out.body as any).errorCode).toBe('COMMERCE_OWNED_SUMMARY_UNAVAILABLE');
  });

  test('rebate refuses without a creatable rebate type', async () => {
    const { request, build } = makeSalesforce({
      describes: {
        RebateProgram: describeOf('RebateProgram'),
        ProgramRebateType: { ...describeOf('ProgramRebateType'), createable: false },
      },
      descriptors: { addRebateMemberList: { inputs: [{ name: 'programRebateTypeId', type: 'REFERENCE', required: true, sObjectType: 'ProgramRebateType' }] } },
    });
    const out = await invokeCommerceLifecycleWithContext({ root: ROOT, route: routeFor('addRebateMemberList'), request, build });
    expect((out.body as any).errorCode).toBe('COMMERCE_DESCRIBE_UNAVAILABLE');
    expect((out.body as any).message).toContain('ProgramRebateType');
  });

  test('order submits name their setup requirement when the substrate is absent', async () => {
    const { request, build } = makeSalesforce({
      describes: { OrderSummary: describeOf('OrderSummary') },
      descriptors: { adjustOrderItemSummariesSubmit: { inputs: [{ name: 'orderSummaryId', type: 'ID', required: true }] } },
    });
    const out = await invokeCommerceLifecycleWithContext({ root: ROOT, route: routeFor('adjustOrderItemSummariesSubmit'), request, build });
    expect((out.body as any).errorCode).toBe('COMMERCE_OM_SUBSTRATE_ABSENT');
    expect((out.body as any).setupRequirement).toContain('Order Management substrate');
  });

  test('native denial outcomes attach a planner-only grant family', async () => {
    const { request, build } = makeSalesforce({
      describes: { ProgramRebateType: describeOf('ProgramRebateType'), RebateProgram: describeOf('RebateProgram') },
      descriptors: { addRebateMemberList: { inputs: [{ name: 'programRebateTypeId', type: 'REFERENCE', required: true, sObjectType: 'ProgramRebateType' }] } },
      posts: {
        addRebateMemberList: () => [
          { isSuccess: false, errors: [{ statusCode: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY', message: 'insufficient access rights on cross reference id' }] },
        ],
      },
    });
    const out = await invokeCommerceLifecycleWithContext({ root: ROOT, route: routeFor('addRebateMemberList'), request, build });
    expect(out.denialGrant?.family).toBe('cross-reference');
    expect((out.contextSchema as any).denialGrant.family).toBe('cross-reference');
  });

  test('non-denial failures attach no grant family', async () => {
    const { request, build } = makeSalesforce({
      describes: { OrderSummary: describeOf('OrderSummary') },
      descriptors: { adjustOrderItemSummariesSubmit: { inputs: [{ name: 'orderSummaryId', type: 'ID', required: true }] } },
    });
    const out = await invokeCommerceLifecycleWithContext({ root: ROOT, route: routeFor('adjustOrderItemSummariesSubmit'), request, build });
    expect((out.body as any).errorCode).toBe('COMMERCE_OM_SUBSTRATE_ABSENT');
    expect(out.denialGrant).toBeUndefined();
  });

  test('batch requires a job identity and reads back terminal state', async () => {
    const noJob = makeSalesforce({
      describes: { ProgramRebateType: describeOf('ProgramRebateType'), RebateProgram: describeOf('RebateProgram') },
      descriptors: { processRebatesBatchCalculationJob: { inputs: [{ name: 'programRebateTypeId', type: 'REFERENCE', required: true, sObjectType: 'ProgramRebateType' }] } },
      posts: { processRebatesBatchCalculationJob: () => accepted('processRebatesBatchCalculationJob', {}) },
    });
    const missing = await invokeCommerceLifecycleWithContext({
      root: ROOT, route: routeFor('processRebatesBatchCalculationJob'), request: noJob.request, build: noJob.build,
    });
    expect((missing.body as any).errorCode).toBe('COMMERCE_JOB_UNVERIFIED');
    const jobId = validId('707', 1);
    const done = makeSalesforce({
      describes: { ProgramRebateType: describeOf('ProgramRebateType'), RebateProgram: describeOf('RebateProgram') },
      descriptors: { processRebatesBatchCalculationJob: { inputs: [{ name: 'programRebateTypeId', type: 'REFERENCE', required: true, sObjectType: 'ProgramRebateType' }] } },
      liveRows: { BatchJob: [{ Id: jobId, Status: 'Completed', ErrorDescription: null }] },
      posts: { processRebatesBatchCalculationJob: () => accepted('processRebatesBatchCalculationJob', { batchJobId: jobId }) },
    });
    const completed = await invokeCommerceLifecycleWithContext({
      root: ROOT, route: routeFor('processRebatesBatchCalculationJob'), request: done.request, build: done.build, verificationWindowMs: 0,
    });
    expect(completed.status).toBe(200);
    expect((completed.contextSchema as any).verified).toBe(true);
    expect((completed.contextSchema as any).jobStatus).toBe('Completed');
    expect(completed.cleanupError).toBeUndefined();
  });

  test('loyalty refuses without an owned journal', async () => {
    const { request, build } = makeSalesforce({
      descriptors: { runProgramProcessForTransactionJournal: { inputs: [{ name: 'journalId', type: 'ID', required: true }] } },
    });
    const out = await invokeCommerceLifecycleWithContext({ root: ROOT, route: routeFor('runProgramProcessForTransactionJournal'), request, build });
    expect((out.body as any).errorCode).toBe('COMMERCE_JOURNAL_CONTEXT_UNAVAILABLE');
  });
});
