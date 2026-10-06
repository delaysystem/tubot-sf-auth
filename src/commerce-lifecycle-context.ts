/**
 * Commerce owned-lifecycle contexts (Auth side).
 *
 * Converts commerce/cart/order/payment/fulfillment/return/rebate standard
 * actions from STATE_CHANGING_ACTION_SKIPPED into verified owned-lifecycle
 * probes. Classification is by Salesforce platform vocabulary (action-name
 * tokens plus standard route shape): no org IDs, aliases, tenant names,
 * instance URLs, or package namespaces appear here, and no per-action
 * payload is hardcoded -- every argument derives from the live action
 * descriptor plus live schema reads.
 *
 * Every executor requires native acceptance plus an independent readback,
 * then deletes only owned records and verifies absence. Steps that cannot
 * be verified fail explicitly with COMMERCE_* codes; destructive submits
 * refuse rather than touch live OrderSummary rows when no owned summary
 * can be minted. License blocks surface only on explicit license text.
 */
import { cleanupOwnedContext, type OwnedRecord } from './owned-context-cleanup';
import { batchDescribe, discoverProvisionedStorefront, discoverStoreBuyerGroups, provisionBuyerChain } from './commerce-provisioned-context';
import { invokePaymentAuthorizationWithContext } from './payment-auth-owned-context';
import { denialGrantForRestOutcome, type DenialGrant } from './permission-denial-grants';
import { resolveRequiredInputValue, selectAlternativeMarkerField, verifySkippedStandardReadback, type TargetField } from './skipped-standards-context';

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
type Request = (path: string, method?: string, body?: any) => Promise<Result>;
type Build = (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;

/** Family builder version: owned commerce lifecycles + read exemptions (re-audits skipped rows).
 * 119: cart calculators run reads against a live owned cart (cart-read
 * kind) instead of binding stale cleaned-cart ids; buyer chains span all
 * store groups with partial-chain cleanup. */
export const COMMERCE_LIFECYCLE_BUILDER_VERSION = 119;

export type CommerceLifecycleKind =
  | 'payment-auth' | 'cart' | 'cart-read' | 'order' | 'order-submit' | 'fulfillment' | 'return' | 'rebate' | 'loyalty' | 'batch';
export type CommerceReadKind = 'cart-read' | 'pricing-read' | 'routing-read' | 'rebate-read';

const ACTION_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,127}$/;
const STANDARD_ROUTE = /^\/services\/data\/v\d+(?:\.\d+)?\/actions\/standard\/([A-Za-z][A-Za-z0-9_.]{0,127})$/;
const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

function wordsOf(actionName: string): Set<string> {
  return new Set(actionName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/** Families with dedicated lifecycles elsewhere; commerce classifiers must never claim them. */
const DEDICATED_FAMILY = [/invrsv/i, /capacity/i, /^(create|delete)cart$/i, /cartitem/i, /guestbuyer/i,
  /boostbury|searchboost/i, /^changeOrderSummary/i, /replenish/i, /^get[A-Z].*Inventor/i];

function standardTailed(actionType: string, route: string, actionName: string): boolean {
  if (actionType !== 'standard') return false;
  if (typeof actionName !== 'string' || !ACTION_NAME.test(actionName)) return false;
  const match = typeof route === 'string' ? route.match(STANDARD_ROUTE) : null;
  return match !== null && match[1] === actionName;
}

/**
 * Read-only commerce calculators, matched by platform vocabulary: calc*
 * computers, cart inventory checks, cart pricers, pricing runners,
 * projected-amount calculators, and order-routing find/rankers. Name-only;
 * the caller pairs it with the standard route check.
 */
export function commerceReadKind(actionName: string): CommerceReadKind | null {
  if (typeof actionName !== 'string' || !ACTION_NAME.test(actionName)) return null;
  if (DEDICATED_FAMILY.some((pattern) => pattern.test(actionName))) return null;
  if (/^calc[A-Z]/.test(actionName)) return 'cart-read';
  if (/^price/i.test(actionName) && /cart/i.test(actionName)) return 'cart-read';
  if (/pricing/i.test(actionName) && /^run/i.test(actionName)) return 'pricing-read';
  if (/calculat/i.test(actionName) && /projected/i.test(actionName)) return 'rebate-read';
  const words = wordsOf(actionName);
  if (words.has('check') && (words.has('inventory') || words.has('stock'))) return 'cart-read';
  if (words.has('order') && (words.has('routing') || words.has('route') || words.has('routes')) &&
    (words.has('find') || words.has('rank') || words.has('get'))) return 'routing-read';
  return null;
}

/** True when the side-effect skip must NOT apply (safe direct probe with declared inputs). */
export function isCommerceReadAction(actionType: string, route: string, actionName = ''): boolean {
  return standardTailed(actionType, route, actionName) && commerceReadKind(actionName) !== null;
}

/**
 * Owned-lifecycle kind by platform vocabulary. Cart calculators (calc*,
 * price*cart, cart inventory checks) resolve to 'cart-read': direct probes
 * bind record-cache ids of already-cleaned carts and fault
 * ENTITY_IS_DELETED, so reads run against a live owned cart instead.
 * Pricing runners, projected calculators, and routing find/rank keep the
 * direct-probe path (null). Name-only; the caller pairs it with the
 * standard route check.
 */
export function commerceLifecycleKind(actionName: string): CommerceLifecycleKind | null {
  if (typeof actionName !== 'string' || !ACTION_NAME.test(actionName)) return null;
  if (DEDICATED_FAMILY.some((pattern) => pattern.test(actionName))) return null;
  if (/preview$/i.test(actionName)) return null;
  const read = commerceReadKind(actionName);
  if (read !== null && read !== 'cart-read') return null;
  if (read === 'cart-read') return 'cart-read';
  const words = wordsOf(actionName);
  const has = (...tokens: string[]) => tokens.some((token) => words.has(token));
  if (has('authorize') && has('payment')) return 'payment-auth';
  if (/OrderItemSummar/i.test(actionName) && has('add', 'adjust', 'cancel', 'return', 'submit')) return 'order-submit';
  if (has('ensure') && (has('payment') || has('refund') || has('refunds'))) return 'order-submit';
  if (has('apply') && (has('payment') || has('payments'))) return 'order-submit';
  if (/ordertocart/i.test(actionName)) return 'order-submit';
  if (has('create') && /orderpayment/i.test(actionName)) return 'order-submit';
  if (/invoice/i.test(actionName) && has('create', 'from')) return 'order-submit';
  if (/creditmemo/i.test(actionName) && has('create', 'order')) return 'order-submit';
  if (has('activate') && has('order') && !/summary/i.test(actionName)) return 'order';
  if (/^create/i.test(actionName) && /ordersummary$/i.test(actionName) && !/item|payment|credit|invoice/i.test(actionName)) return 'order';
  if (has('fulfillment') && !has('capacity')) return 'fulfillment';
  if (/returnorder/i.test(actionName)) return 'return';
  if (has('disposal') && has('order')) return 'return';
  if (has('rebate') || has('rebates')) return has('batch') ? 'batch' : 'rebate';
  if (has('transaction') && has('journal')) return 'loyalty';
  if (/checkout/i.test(actionName)) return 'cart';
  if (/carttoorder/i.test(actionName)) return 'cart';
  if (has('promotion') && has('usage')) return 'cart';
  if (has('cart') && has('add', 'set', 'submit', 'update', 'checkout', 'session', 'exchange', 'cancel', 'convert', 'activate')) return 'cart';
  return null;
}

/** True when the action needs the owned commerce lifecycle. */
export function isCommerceLifecycleAction(actionType: string, route: string, actionName = ''): boolean {
  return standardTailed(actionType, route, actionName) && commerceLifecycleKind(actionName) !== null;
}

/** Action tail from a standard route; null unless the tail carries a commerce lifecycle kind. */
export function commerceLifecycleActionName(route: string): string | null {
  const match = typeof route === 'string' ? route.match(STANDARD_ROUTE) : null;
  const name = match?.[1] ?? null;
  return name !== null && commerceLifecycleKind(name) !== null ? name : null;
}

const id = (v: any): v is string => typeof v === 'string' && SF_ID.test(v);
const record = (v: unknown): v is Value => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (errorCode: string, message: string, extra?: Value): Result =>
  ({ status: 422, ok: false, body: { errorCode, message, ...extra } });

const nativeAccepted = (result: Result): boolean => {
  if (!result.ok || !Array.isArray(result.body) || result.body.length === 0) return false;
  return result.body.every((item) =>
    record(item) && item.isSuccess === true &&
    (item.errors === null || item.errors === undefined || (Array.isArray(item.errors) && item.errors.length === 0)) &&
    item.errorCode === undefined && item.errorMessage === undefined);
};

export type CommerceDescriptorInput = {
  name: string; type?: string | null; required?: boolean | null; sObjectType?: string | null;
  fields?: CommerceDescriptorInput[] | null; isCollection?: boolean | null;
};

/** Declared descriptor inputs with valid names; empty when the descriptor has no input schema. */
export function commerceDescriptorInputs(descriptor: unknown): CommerceDescriptorInput[] {
  if (!record(descriptor) || !Array.isArray(descriptor.inputs)) return [];
  const clean = (field: unknown): CommerceDescriptorInput | null => {
    if (!record(field) || typeof field.name !== 'string' || !OBJECT_NAME.test(field.name)) return null;
    return {
      name: field.name,
      ...(typeof field.type === 'string' ? { type: field.type } : {}),
      ...(typeof field.required === 'boolean' ? { required: field.required } : {}),
      ...(typeof field.sObjectType === 'string' && OBJECT_NAME.test(field.sObjectType) ? { sObjectType: field.sObjectType } : {}),
      ...(Array.isArray(field.fields) ? { fields: field.fields.map(clean).filter((entry): entry is CommerceDescriptorInput => entry !== null) } : {}),
      ...(typeof field.isCollection === 'boolean' ? { isCollection: field.isCollection } : {}),
    };
  };
  return descriptor.inputs.map(clean).filter((entry): entry is CommerceDescriptorInput => entry !== null);
}

function targetFieldsOf(schema: unknown): TargetField[] {
  if (!record(schema) || !Array.isArray(schema.fields)) return [];
  return schema.fields.filter(record).map((field) => ({
    name: String(field.name ?? ''),
    type: typeof field.type === 'string' ? field.type : null,
    createable: typeof field.createable === 'boolean' ? field.createable : null,
    filterable: typeof field.filterable === 'boolean' ? field.filterable : null,
    updateable: typeof field.updateable === 'boolean' ? field.updateable : null,
    nillable: typeof field.nillable === 'boolean' ? field.nillable : null,
    calculated: typeof field.calculated === 'boolean' ? field.calculated : null,
    autoNumber: typeof field.autoNumber === 'boolean' ? field.autoNumber : null,
    nameField: typeof field.nameField === 'boolean' ? field.nameField : null,
    length: typeof field.length === 'number' ? field.length : null,
    compoundFieldName: typeof field.compoundFieldName === 'string' ? field.compoundFieldName : null,
    referenceTo: Array.isArray(field.referenceTo) ? field.referenceTo.filter((name): name is string => typeof name === 'string') : null,
    picklistValues: Array.isArray(field.picklistValues)
      ? field.picklistValues.filter(record).map((entry) => ({ value: typeof entry.value === 'string' ? entry.value : undefined, active: entry.active === true }))
      : null,
  })).filter((field) => OBJECT_NAME.test(field.name));
}

export type CommerceOwnedIds = {
  storeId?: string; accountId?: string; cartId?: string; orderId?: string; orderSummaryId?: string;
  journalId?: string;
  /** Owned fixture id by object API name for descriptor-declared sObjectType inputs. */
  fixtures?: Record<string, string>;
  /** Live setup ids by object API name (gateways, delivery methods, parents). Never invented. */
  live?: Record<string, string>;
};

const KNOWN_ID_INPUTS: Array<{ pattern: RegExp; pick: (owned: CommerceOwnedIds) => string | undefined; missing: string }> = [
  { pattern: /^(activeorcartid|cartid|cartstateorid)$/, pick: (owned) => owned.cartId, missing: 'liveCartId' },
  { pattern: /^webstoreid$/, pick: (owned) => owned.storeId, missing: 'liveStoreId' },
  { pattern: /^(accountid|effectiveaccountid)$/, pick: (owned) => owned.accountId, missing: 'liveAccountId' },
  { pattern: /^orderid$/, pick: (owned) => owned.orderId, missing: 'liveOrderId' },
  { pattern: /^ordersummaryid$/, pick: (owned) => owned.orderSummaryId, missing: 'liveOrderSummaryId' },
  { pattern: /^(journalid|transactionjournalid)$/, pick: (owned) => owned.journalId, missing: 'liveTransactionJournalId' },
];

/** Setup/live fixture ids by input-name vocabulary (fixtures win over live setup). */
const NAMED_FIXTURE_INPUTS: Array<{ pattern: RegExp; objectType: string }> = [
  { pattern: /^(fulfillmentorderids?|fulfillmentid)$/, objectType: 'FulfillmentOrder' },
  { pattern: /^changeorderids?$/, objectType: 'ChangeOrder' },
  { pattern: /^returnorderids?$/, objectType: 'ReturnOrder' },
  { pattern: /^(deliverymethodid|orderdeliverymethodid)$/, objectType: 'OrderDeliveryMethod' },
  { pattern: /^(productid|product2id)$/, objectType: 'Product2' },
  { pattern: /^pricebookentryid$/, objectType: 'PricebookEntry' },
  { pattern: /^programrebatetypeids?$/, objectType: 'ProgramRebateType' },
  { pattern: /^(cartasyncoperationid|asyncoperationid)$/, objectType: 'CartAsyncOperation' },
];

/**
 * Maps declared descriptor inputs to owned/live identities. Reference
 * inputs without a resolved identity are explicit failures; neutral
 * scalar values come only from the shared schema resolver, and optional
 * unresolvable inputs are omitted. One nesting level is mapped for
 * wrapper objects (cartItemInput, changeInput, ...).
 */
export function mapCommerceArguments(
  descriptorInputs: CommerceDescriptorInput[],
  owned: CommerceOwnedIds,
): { args: Record<string, unknown> } | { failure: string } {
  const args: Record<string, unknown> = {};
  const failures: string[] = [];
  const mapLeaf = (input: CommerceDescriptorInput, depth: number): unknown => {
    const lower = input.name.toLowerCase();
    const known = KNOWN_ID_INPUTS.find((entry) => entry.pattern.test(lower));
    if (known) {
      const value = known.pick(owned);
      if (value === undefined) {
        if (input.required === true) failures.push(`No resolved identity for required input ${input.name}.`);
        return undefined;
      }
      return value;
    }
    if (input.sObjectType && owned.fixtures?.[input.sObjectType] !== undefined) return owned.fixtures[input.sObjectType];
    if (input.sObjectType && owned.live?.[input.sObjectType] !== undefined) return owned.live[input.sObjectType];
    const named = NAMED_FIXTURE_INPUTS.find((entry) => entry.pattern.test(lower));
    if (named) {
      const value = owned.fixtures?.[named.objectType] ?? owned.live?.[named.objectType];
      if (value === undefined) {
        if (input.required === true) failures.push(`No resolved identity for required input ${input.name}.`);
        return undefined;
      }
      return input.isCollection === true ? [value] : value;
    }
    if (input.sObjectType && /reference|^id$/i.test(input.type ?? 'reference')) {
      if (input.required === true) failures.push(`No resolved identity for required input ${input.name}.`);
      return undefined;
    }
    const nested = depth < 1 && Array.isArray(input.fields) && input.fields.length ? input.fields : null;
    if (nested) {
      const shape: Record<string, unknown> = {};
      for (const child of nested) {
        const value = mapLeaf(child, depth + 1);
        if (value !== undefined) shape[child.name] = child.isCollection === true ? [value] : value;
      }
      if (Object.keys(shape).length) return input.isCollection === true ? [shape] : shape;
      if (input.required === true) failures.push(`No resolved values for required input ${input.name}.`);
      return undefined;
    }
    if (/csv|document/i.test(input.name) && input.required === true) {
      failures.push(`No owned payload for required input ${input.name}.`);
      return undefined;
    }
    const neutral = resolveRequiredInputValue({ name: input.name, type: input.type ?? null, required: input.required ?? null }, []);
    if (neutral === undefined) {
      if (input.required === true) failures.push(`No discovered live value for required input ${input.name}.`);
      return undefined;
    }
    return input.isCollection === true ? [neutral] : neutral;
  };
  for (const input of descriptorInputs) {
    const value = mapLeaf(input, 0);
    if (value !== undefined) args[input.name] = input.isCollection === true && !Array.isArray(value) ? [value] : value;
  }
  if (failures.length) return { failure: failures[0] };
  return { args };
}

/** First-column ids from a live SOQL query; throws nothing, filters to well-formed ids. */
async function queryIds(request: Request, root: string, soql: string, field = 'Id'): Promise<string[]> {
  try {
    const result = await request(root + '/query?q=' + encodeURIComponent(soql));
    if (!result.ok || !record(result.body) || !Array.isArray(result.body.records)) return [];
    return result.body.records.filter(record).map((row) => row[field]).filter(id);
  } catch { return []; }
}

/** Single live setup row id (gateways, methods, parents); null when none exists. Never invented. */
async function discoverLiveSetupId(request: Request, root: string, objectType: string, predicate = ''): Promise<string | null> {
  if (!OBJECT_NAME.test(objectType)) return null;
  const rows = await queryIds(request, root, `SELECT Id FROM ${objectType}${predicate ? ` WHERE ${predicate}` : ''} LIMIT 1`);
  return rows.length === 1 ? rows[0] : null;
}

/** Reference field on a child schema pointing at one of the parent types; null when undiscoverable. */
function referenceFieldTo(childSchema: unknown, parentTypes: string[]): string | null {
  const lowered = new Set(parentTypes.map((name) => name.toLowerCase()));
  for (const field of targetFieldsOf(childSchema)) {
    if (field.type === 'reference' && Array.isArray(field.referenceTo) &&
      field.referenceTo.some((name) => lowered.has(name.toLowerCase())) && field.filterable === true) return field.name;
  }
  return null;
}

/** Creates one owned fixture row and reads the marker back; every gap is an explicit failure. */
async function createOwnedFixture(input: {
  request: Request; build: Build; root: string; objectType: string; marker: string; values?: Value;
  capture: (objectName: string, value: string) => void;
}): Promise<{ id: string; markerField: string; storedMarker: string } | { failure: Result }> {
  const { request, root, objectType, marker } = input;
  if (!OBJECT_NAME.test(objectType)) return { failure: fail('COMMERCE_TARGET_INVALID', 'A live fixture object name is required.') };
  const described = await request(root + '/sobjects/' + objectType + '/describe');
  if (!described.ok || !record(described.body) || described.body.createable !== true || !Array.isArray(described.body.fields)) {
    return { failure: fail('COMMERCE_DESCRIBE_UNAVAILABLE', `Live ${objectType} schema or create access is unavailable.`) };
  }
  const selection = selectAlternativeMarkerField(targetFieldsOf(described.body));
  if (!selection) return { failure: fail('COMMERCE_MARKER_UNAVAILABLE', `Owned ${objectType} records expose no writable marker field.`) };
  const markerField = selection.name;
  // The seed fits the live field cap (a 40-char AccountNumber-style field
  // 400s STRING_TOO_LONG on an over-long marker); the stored value is read
  // back from the built row so caller overrides stay authoritative and the
  // cleanup scope below always matches what the platform actually stored.
  const built = await input.build(objectType, marker,
    { [markerField]: marker.slice(0, Math.min(marker.length, selection.length)), ...(input.values ?? {}) });
  if ('failure' in built) return { failure: built.failure };
  const created = await request(root + '/sobjects/' + objectType, 'POST', built.values);
  if (!created.ok || !id(created.body?.id)) return { failure: created };
  input.capture(objectType, created.body.id);
  const reread = await request(root + '/sobjects/' + objectType + '/' + created.body.id);
  if (!reread.ok || !record(reread.body) || reread.body[markerField] !== built.values[markerField]) {
    return { failure: fail('COMMERCE_FIXTURE_UNVERIFIED', `Actual owned ${objectType} readback failed.`) };
  }
  const stored = built.values[markerField];
  return { id: created.body.id, markerField, storedMarker: typeof stored === 'string' ? stored : marker };
}

export type CommerceScope = {
  objectName: string; equals: Record<string, unknown>; ownedParents?: Array<{ field: string; objectName: string }>;
};

/** Marker-equality scope for an owned fixture. */
function markerScope(objectName: string, markerField: string, marker: string): CommerceScope {
  return { objectName, equals: { [markerField]: marker } };
}

/** Deletes owned records in dependency order and verifies absence via marker-scoped sweeps. */
async function cleanupCommerceFixtures(input: {
  request: Request; root: string; marker: string; owned: OwnedRecord[];
  order: string[]; scopes: CommerceScope[];
}): Promise<string | undefined> {
  const cleaned = await cleanupOwnedContext({
    root: input.root, request: input.request, records: input.owned, order: input.order, scopes: input.scopes,
  }).catch(() => null);
  return cleaned?.cleanupError;
}

/** Buyer-chain scopes for reuse-path provisioned storefronts (member proven via the owned buyer). */
function buyerChainScopes(marker: string, accountId?: string): CommerceScope[] {
  return [
    markerScope('BuyerAccount', 'Name', marker),
    markerScope('Contact', 'LastName', marker),
    ...(accountId ? [{ objectName: 'BuyerGroupMember', equals: { BuyerId: accountId }, ownedParents: [{ field: 'BuyerId', objectName: 'Account' }] }] : []),
  ];
}

type OwnedCart = {
  storeId: string; accountId: string; cartId: string; cartStatus?: string;
  owned: OwnedRecord[]; reusedStore: boolean; storeType?: string;
};

/**
 * Provisions an owned store, buyer, and cart. A provisioned UI-linked
 * storefront is reused when one exists (mapping kept, buyer owned); the
 * mint ladder over live store types is the fallback. Native createCart
 * must return the owned relationships or the attempt fails.
 */
async function provisionOwnedCart(input: {
  request: Request; build: Build; root: string; marker: string;
}): Promise<OwnedCart | { failure: Result }> {
  const { request, build, root, marker } = input;
  const described = await batchDescribe(request, root, ['WebStore', 'Account', 'WebCart'], ['createCart']);
  if (!described) return { failure: fail('COMMERCE_DESCRIBE_UNAVAILABLE', 'Live object and cart-creation describes could not be read.') };
  const { schemas, descriptors } = described;
  for (const name of ['WebStore', 'Account', 'WebCart']) {
    if (!schemas[name]?.queryable || !schemas[name]?.deletable || !Array.isArray(schemas[name]?.fields)) {
      return { failure: fail('COMMERCE_CONTEXT_PERMISSIONS_REQUIRED', 'Live owned Commerce records require query and cleanup access.') };
    }
  }
  if (!Array.isArray(descriptors.createCart?.inputs)) {
    return { failure: fail('COMMERCE_ACTION_SCHEMA_UNAVAILABLE', 'The native cart-creation descriptor has no input schema.') };
  }
  if (!['webStoreId', 'cartInput'].every((name) => descriptors.createCart.inputs.some((field: Value) => field?.name === name))) {
    return { failure: fail('COMMERCE_ACTION_SCHEMA_UNAVAILABLE', 'The live creation action does not publish store and cart inputs.') };
  }
  const types = schemas.WebStore.fields.find((field: Value) => field.name === 'Type' && field.createable)?.picklistValues
    ?.filter((pick: Value) => pick.active && typeof pick.value === 'string').map((pick: Value) => pick.value) ?? [];
  const cartType = schemas.WebCart.fields.find((field: Value) => field.name === 'Type')?.picklistValues
    ?.find((pick: Value) => pick.active && pick.value === 'Cart')?.value;
  if (!types.length || !cartType) return { failure: fail('COMMERCE_TYPE_UNAVAILABLE', 'Live store types and the standard Cart type are required.') };
  let provisioned: { storeId: string; groupIds: string[] } | null = null;
  const found = await discoverProvisionedStorefront(request, root);
  if (found) {
    const groupIds = await discoverStoreBuyerGroups(request, root, found.storeId);
    if (groupIds.length) provisioned = { storeId: found.storeId, groupIds };
  }
  let last = fail('COMMERCE_STOREFRONT_UNAVAILABLE', 'No live store type supported the owned cart lifecycle.');
  const attempts: Array<{ kind: 'reuse'; storeId: string; groupIds: string[] } | { kind: 'mint'; type: string }> = [
    ...(provisioned ? [{ kind: 'reuse' as const, storeId: provisioned.storeId, groupIds: provisioned.groupIds }] : []),
    ...types.map((type: string) => ({ kind: 'mint' as const, type })),
  ];
  for (const attempt of attempts) {
    const owned: OwnedRecord[] = [];
    const capture = (objectName: string, value: string) => { if (!owned.some((entry) => entry.id === value)) owned.push({ objectName, id: value }); };
    const resolved: { accountId?: string } = {};
    const attemptScopes = (): CommerceScope[] => [
      markerScope('WebStore', 'Name', marker), markerScope('Account', 'Name', marker), markerScope('WebCart', 'Name', marker),
      ...buyerChainScopes(marker, resolved.accountId),
    ];
    try {
      const outcome: OwnedCart | { failure: Result } = await (async () => {
        let storeId: string, accountId: string, storeType: string | undefined;
        if (attempt.kind === 'reuse') {
          storeId = attempt.storeId;
          const storeRead = await request(root + '/sobjects/WebStore/' + storeId);
          if (!storeRead.ok || !id(storeRead.body?.Id) || typeof storeRead.body?.Type !== 'string') {
            return { failure: fail('COMMERCE_STORE_UNVERIFIED', 'Actual provisioned store readback failed.') };
          }
          storeType = storeRead.body.Type;
          const chain = await provisionBuyerChain({ root, marker, groupIds: attempt.groupIds, request, build, capture });
          if ('failure' in chain) return { failure: chain.failure };
          accountId = chain.ids.accountId; resolved.accountId = accountId;
        } else {
          const store = await build('WebStore', marker, { Name: marker, Type: attempt.type });
          if ('failure' in store) return { failure: store.failure };
          const createdStore = await request(root + '/sobjects/WebStore', 'POST', store.values);
          if (!createdStore.ok || !id(createdStore.body?.id)) return { failure: createdStore };
          storeId = createdStore.body.id; capture('WebStore', storeId); storeType = attempt.type;
          const storeRead = await request(root + '/sobjects/WebStore/' + storeId);
          if (!storeRead.ok || storeRead.body?.Name !== marker) return { failure: fail('COMMERCE_STORE_UNVERIFIED', 'Actual owned store readback failed.') };
          const buyer = await build('Account', marker, { Name: marker });
          if ('failure' in buyer) return { failure: buyer.failure };
          const createdBuyer = await request(root + '/sobjects/Account', 'POST', buyer.values);
          if (!createdBuyer.ok || !id(createdBuyer.body?.id)) return { failure: createdBuyer };
          accountId = createdBuyer.body.id; capture('Account', accountId); resolved.accountId = accountId;
          const buyerRead = await request(root + '/sobjects/Account/' + accountId);
          if (!buyerRead.ok || buyerRead.body?.Name !== marker) return { failure: fail('COMMERCE_BUYER_UNVERIFIED', 'Actual owned buyer readback failed.') };
        }
        const created = await request(root + '/actions/standard/createCart', 'POST',
          { inputs: [{ webStoreId: storeId, cartInput: { name: marker, type: cartType, effectiveAccountId: accountId } }] });
        if (created.ok && (created.body === null || Array.isArray(created.body) && created.body.length === 0)) {
          return { failure: fail('COMMERCE_ACTION_OUTCOME_MISSING', 'Salesforce returned no native cart creation outcome; no mutation is counted as successful.') };
        }
        if (!nativeAccepted(created)) return { failure: created };
        const summary = Array.isArray(created.body) ? created.body[0]?.outputValues?.cartSummary : undefined;
        const cartId = summary?.cartId;
        if (!id(cartId) || summary?.accountId !== accountId || summary?.webstoreId !== storeId || summary?.name !== marker) {
          return { failure: fail('COMMERCE_CREATION_UNVERIFIED', 'Native creation did not return one actual cart with the owned buyer and store.') };
        }
        capture('WebCart', cartId);
        const reread = await request(root + '/sobjects/WebCart/' + cartId);
        if (!reread.ok || reread.body?.Name !== marker || reread.body?.WebStoreId !== storeId || reread.body?.AccountId !== accountId) {
          return { failure: fail('COMMERCE_CREATION_UNVERIFIED', 'Actual owned cart readback failed.') };
        }
        return { storeId, accountId, cartId, cartStatus: reread.body?.Status, owned, reusedStore: attempt.kind === 'reuse', storeType };
      })();
      if ('failure' in outcome) {
        last = outcome.failure;
        await cleanupCommerceFixtures({ request, root, marker, owned, order: ['WebCart', 'WebStore', 'Account', 'BuyerAccount', 'BuyerGroupMember', 'Contact'],
          scopes: attemptScopes() });
        if (outcome.failure.status !== 400) return outcome;
        continue;
      }
      return outcome;
    } catch {
      last = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned Commerce lifecycle could not be verified.');
      await cleanupCommerceFixtures({ request, root, marker, owned, order: ['WebCart', 'WebStore', 'Account', 'BuyerAccount', 'BuyerGroupMember', 'Contact'],
        scopes: attemptScopes() });
    }
  }
  return { failure: last };
}

/** Output identities whose keys match the vocabulary; values must be well-formed ids. */
export function outputIdentities(body: unknown, keyPattern: RegExp): string[] {
  const found: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || found.length >= 10) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 10)) visit(item, depth + 1); return; }
    if (!record(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if (keyPattern.test(key) && id(entry) && !found.includes(entry)) found.push(entry);
      else if (entry !== null && typeof entry === 'object') visit(entry, depth + 1);
    }
  };
  visit(body, 0);
  return found;
}

export type CommerceExecutorInput = {
  root: string; route: string; action: string; verificationWindowMs?: number;
  descriptor: unknown; marker: string; request: Request; build: Build;
};
export type CommerceOutcome = { status: number; body: any; cleanupError?: string; contextSchema?: Value; denialGrant?: DenialGrant };

/** Live product + pricebook-entry pair for the owned store; null when the substrate is absent. */
async function discoverCartProduct(request: Request, root: string, storeId: string): Promise<{ productId: string; pricebookEntryId: string } | null> {
  const pricebookId = await discoverLiveSetupId(request, root, 'WebStorePricebook', `WebStoreId='${storeId}' AND IsActive=true`);
  if (!pricebookId) return null;
  try {
    const result = await request(root + '/query?q=' + encodeURIComponent(
      `SELECT Id, Product2Id FROM PricebookEntry WHERE Pricebook2Id='${pricebookId}' AND IsActive=true LIMIT 5`));
    const rows = record(result.body) && Array.isArray(result.body.records) ? result.body.records.filter(record) : [];
    const hit = rows.find((row) => id(row.Id) && id(row.Product2Id));
    return hit ? { productId: hit.Product2Id as string, pricebookEntryId: hit.Id as string } : null;
  } catch { return null; }
}

/**
 * Cart-anchored mutations (add-item, cart-to-order, checkout session and
 * state, delivery method, exchange submit, async-op cancel, promotion
 * usage). The owned cart carries the marker; kind-specific readbacks
 * verify the actual effect before cleanup.
 */
async function runCartLifecycle(input: CommerceExecutorInput): Promise<CommerceOutcome> {
  const { request, build, root, route, action, marker } = input;
  const baseContext = {
    source: 'salesforce_live_commerce_cart_action', kind: 'cart' as const, action,
    automaticSteps: ['Provision an owned store, buyer, and cart', 'Invoke the native action against the owned cart',
      'Read back the actual effect from the target', 'Delete only owned records and verify absence'],
  };
  const done = (outcome: Result, extra: Value): CommerceOutcome => ({
    status: outcome.status, body: outcome.body, ...(typeof extra.cleanupError === 'string' ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...baseContext, ...extra },
  });
  const inputs = commerceDescriptorInputs(input.descriptor);
  if (!inputs.length) {
    return done(fail('COMMERCE_ACTION_SCHEMA_UNAVAILABLE', 'The native descriptor has no input schema.'), { verified: false });
  }
  const cart = await provisionOwnedCart({ request, build, root, marker });
  if ('failure' in cart) return done(cart.failure, { verified: false });
  const owned: OwnedRecord[] = [...cart.owned];
  const capture = (objectName: string, value: string) => { if (!owned.some((entry) => entry.id === value)) owned.push({ objectName, id: value }); };
  let cleanupError: string | undefined;
  let outcome: Result = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned cart lifecycle did not complete.');
  let verified = false, extra: Value = {};
  try {
    outcome = await (async (): Promise<Result> => {
      const ownedIds: CommerceOwnedIds = { storeId: cart.storeId, accountId: cart.accountId, cartId: cart.cartId };
      if (/add/i.test(action) && /item/i.test(action)) {
        const product = await discoverCartProduct(request, root, cart.storeId);
        if (!product) return fail('COMMERCE_PRODUCT_SUBSTRATE_ABSENT',
          'No live pricebook entry exists for the owned store; provision catalog substrate before retrying.');
        ownedIds.fixtures = { Product2: product.productId, PricebookEntry: product.pricebookEntryId };
        ownedIds.live = { Product2: product.productId, PricebookEntry: product.pricebookEntryId };
      }
      if (/delivery/i.test(action)) {
        const method = await discoverLiveSetupId(request, root, 'OrderDeliveryMethod');
        if (method) ownedIds.live = { ...(ownedIds.live ?? {}), OrderDeliveryMethod: method };
      }
      if (/cancel/i.test(action) && /async|operation/i.test(action)) {
        const op = await discoverLiveSetupId(request, root, 'CartAsyncOperation', `CartId='${cart.cartId}'`);
        if (!op) return fail('COMMERCE_ASYNC_OP_UNAVAILABLE',
          'No live async operation exists for the owned cart; nothing was cancelled.');
        ownedIds.live = { ...(ownedIds.live ?? {}), CartAsyncOperation: op };
      }
      const mapped = mapCommerceArguments(inputs, ownedIds);
      if ('failure' in mapped) return fail('COMMERCE_INPUT_UNAVAILABLE', mapped.failure);
      const invoked = await request(route, 'POST', { inputs: [mapped.args] });
      if (invoked.ok && (invoked.body === null || Array.isArray(invoked.body) && invoked.body.length === 0)) {
        return fail('COMMERCE_ACTION_OUTCOME_MISSING', 'Salesforce returned no native outcome; no mutation is counted as successful.');
      }
      if (!nativeAccepted(invoked)) return invoked;
      const reread = await request(root + '/sobjects/WebCart/' + cart.cartId);
      const intact = reread.ok && record(reread.body) && reread.body.Name === marker;
      if (/add/i.test(action) && /item/i.test(action)) {
        const items = await queryIds(request, root, `SELECT Id FROM CartItem WHERE CartId='${cart.cartId}' LIMIT 5`);
        if (!items.length) return fail('COMMERCE_EFFECT_UNVERIFIED', 'Native acceptance carried no owned cart item.', { upstreamOutcome: invoked.body });
        for (const item of items) capture('CartItem', item);
        extra = { cartItemIds: items };
      } else if (/toorder/i.test(action)) {
        const orderIds = outputIdentities(invoked.body, /order(summary)?id$/i);
        const existing = orderIds.length ? orderIds : await queryIds(request, root, `SELECT Id FROM Order WHERE AccountId='${cart.accountId}' LIMIT 5`);
        if (!existing.length) return fail('COMMERCE_EFFECT_UNVERIFIED', 'Native acceptance carried no verifiable order.', { upstreamOutcome: invoked.body });
        for (const orderId of existing.slice(0, 5)) capture('Order', orderId);
        extra = { createdOrderIds: existing.slice(0, 5) };
      }
      const check = verifySkippedStandardReadback({
        performed: true, markerField: 'Name', marker, after: intact ? { Name: marker } : null,
        expectedChanges: {}, actionAccepted: true,
      });
      verified = intact && check.verified;
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, input.verificationWindowMs));
      return verified ? invoked : fail('COMMERCE_EFFECT_UNVERIFIED', 'Salesforce reported success without the verified owned effect.', { upstreamOutcome: invoked.body });
    })();
  } catch { outcome = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned cart lifecycle could not be verified.'); }
  finally {
    cleanupError = await cleanupCommerceFixtures({
      request, root, marker, owned,
      order: ['CartItem', 'Order', 'WebCart', 'WebStore', 'Account', 'BuyerAccount', 'BuyerGroupMember', 'Contact'],
      scopes: [
        markerScope('WebStore', 'Name', marker), markerScope('Account', 'Name', marker), markerScope('WebCart', 'Name', marker),
        ...buyerChainScopes(marker, cart.accountId),
        { objectName: 'CartItem', equals: { CartId: cart.cartId }, ownedParents: [{ field: 'CartId', objectName: 'WebCart' }] },
        { objectName: 'Order', equals: { AccountId: cart.accountId }, ownedParents: [{ field: 'AccountId', objectName: 'Account' }] },
      ],
    });
  }
  return done(outcome, { verified: cleanupError ? false : verified, marker, storeId: cart.storeId, accountId: cart.accountId,
    cartId: cart.cartId, reusedStore: cart.reusedStore, storeType: cart.storeType, ownedRecords: owned,
    verificationRecordIds: [cart.cartId], ...extra, ...(cleanupError ? { cleanupError } : {}) });
}

/**
 * Cart-anchored calculators (calc*, price*cart, cart inventory checks). A
 * direct probe binds whatever cart id the record cache holds — usually an
 * already-cleaned fixture — and Salesforce faults ENTITY_IS_DELETED, so
 * the read runs against a live owned cart instead. Verification is native
 * acceptance over the owned cart (a stale id would 400) plus an intact
 * cart reread proving the read mutated nothing; output keys are evidence.
 */
async function runCartReadLifecycle(input: CommerceExecutorInput): Promise<CommerceOutcome> {
  const { request, build, root, route, action, marker } = input;
  const baseContext = {
    source: 'salesforce_live_commerce_cart_read_action', kind: 'cart-read' as const, action,
    automaticSteps: ['Provision an owned store, buyer, and cart', 'Invoke the native calculator against the owned cart',
      'Verify acceptance over the live cart and an intact reread', 'Delete only owned records and verify absence'],
  };
  const done = (outcome: Result, extra: Value): CommerceOutcome => ({
    status: outcome.status, body: outcome.body, ...(typeof extra.cleanupError === 'string' ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...baseContext, ...extra },
  });
  const inputs = commerceDescriptorInputs(input.descriptor);
  if (!inputs.length) {
    return done(fail('COMMERCE_ACTION_SCHEMA_UNAVAILABLE', 'The native descriptor has no input schema.'), { verified: false });
  }
  const cart = await provisionOwnedCart({ request, build, root, marker });
  if ('failure' in cart) return done(cart.failure, { verified: false });
  const owned: OwnedRecord[] = [...cart.owned];
  let cleanupError: string | undefined;
  let outcome: Result = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned cart-read lifecycle did not complete.');
  let verified = false, outputKeys: string[] = [];
  try {
    outcome = await (async (): Promise<Result> => {
      const mapped = mapCommerceArguments(inputs, { storeId: cart.storeId, accountId: cart.accountId, cartId: cart.cartId });
      if ('failure' in mapped) return fail('COMMERCE_INPUT_UNAVAILABLE', mapped.failure);
      const invoked = await request(route, 'POST', { inputs: [mapped.args] });
      if (invoked.ok && (invoked.body === null || Array.isArray(invoked.body) && invoked.body.length === 0)) {
        return fail('COMMERCE_ACTION_OUTCOME_MISSING', 'Salesforce returned no native outcome; nothing is counted as verified.');
      }
      if (!nativeAccepted(invoked)) return invoked;
      const first = Array.isArray(invoked.body) ? invoked.body[0] : null;
      outputKeys = record(first?.outputValues) ? Object.keys(first.outputValues).filter((key) => OBJECT_NAME.test(key)) : [];
      const reread = await request(root + '/sobjects/WebCart/' + cart.cartId);
      const intact = reread.ok && record(reread.body) && reread.body.Name === marker &&
        reread.body.WebStoreId === cart.storeId && reread.body.AccountId === cart.accountId;
      verified = intact;
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, input.verificationWindowMs));
      return verified ? invoked : fail('COMMERCE_EFFECT_UNVERIFIED', 'Salesforce reported success without the intact owned cart.', { upstreamOutcome: invoked.body });
    })();
  } catch { outcome = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned cart-read lifecycle could not be verified.'); }
  finally {
    cleanupError = await cleanupCommerceFixtures({
      request, root, marker, owned,
      order: ['WebCart', 'WebStore', 'Account', 'BuyerAccount', 'BuyerGroupMember', 'Contact'],
      scopes: [
        markerScope('WebStore', 'Name', marker), markerScope('Account', 'Name', marker), markerScope('WebCart', 'Name', marker),
        ...buyerChainScopes(marker, cart.accountId),
      ],
    });
  }
  return done(outcome, { verified: cleanupError ? false : verified, marker, storeId: cart.storeId, accountId: cart.accountId,
    cartId: cart.cartId, reusedStore: cart.reusedStore, storeType: cart.storeType, ownedRecords: owned,
    verificationRecordIds: [cart.cartId], outputKeys, ...(cleanupError ? { cleanupError } : {}) });
}

/**
 * Order-anchored mutations (activate, create-summary). An owned Account
 * plus Order anchors the invocation; the actual order state or summary
 * child is read back before cleanup.
 */
async function runOrderLifecycle(input: CommerceExecutorInput): Promise<CommerceOutcome> {
  const { request, build, root, route, action, marker } = input;
  const baseContext = {
    source: 'salesforce_live_commerce_order_action', kind: 'order' as const, action,
    automaticSteps: ['Create an owned account and order', 'Invoke the native action against the owned order',
      'Read back the actual effect from the target', 'Delete only owned records and verify absence'],
  };
  const done = (outcome: Result, extra: Value): CommerceOutcome => ({
    status: outcome.status, body: outcome.body, ...(typeof extra.cleanupError === 'string' ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...baseContext, ...extra },
  });
  const inputs = commerceDescriptorInputs(input.descriptor);
  if (!inputs.length) {
    return done(fail('COMMERCE_ACTION_SCHEMA_UNAVAILABLE', 'The native descriptor has no input schema.'), { verified: false });
  }
  const owned: OwnedRecord[] = [];
  const capture = (objectName: string, value: string) => { if (!owned.some((entry) => entry.id === value)) owned.push({ objectName, id: value }); };
  const scopes: CommerceScope[] = [];
  let cleanupError: string | undefined;
  let outcome: Result = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned order lifecycle did not complete.');
  let verified = false, extra: Value = {};
  try {
    outcome = await (async (): Promise<Result> => {
      const account = await createOwnedFixture({ request, build, root, objectType: 'Account', marker, values: { Name: marker }, capture });
      if ('failure' in account) return account.failure;
      scopes.push(markerScope('Account', account.markerField, account.storedMarker));
      const order = await createOwnedFixture({ request, build, root, objectType: 'Order', marker, values: { AccountId: account.id }, capture });
      if ('failure' in order) return order.failure;
      scopes.push(markerScope('Order', order.markerField, order.storedMarker));
      const before = await request(root + '/sobjects/Order/' + order.id);
      const beforeStatus = record(before.body) ? before.body.Status : undefined;
      const mapped = mapCommerceArguments(inputs, { accountId: account.id, orderId: order.id });
      if ('failure' in mapped) return fail('COMMERCE_INPUT_UNAVAILABLE', mapped.failure);
      const invoked = await request(route, 'POST', { inputs: [mapped.args] });
      if (invoked.ok && (invoked.body === null || Array.isArray(invoked.body) && invoked.body.length === 0)) {
        return fail('COMMERCE_ACTION_OUTCOME_MISSING', 'Salesforce returned no native outcome; no mutation is counted as successful.');
      }
      if (!nativeAccepted(invoked)) return invoked;
      if (/createsummary|creates.*summary/i.test(action) || /ordersummary$/i.test(action)) {
        const summaryIds = outputIdentities(invoked.body, /ordersummaryid$/i);
        const summaryId = summaryIds[0] ?? (await queryIds(request, root, `SELECT Id FROM OrderSummary WHERE OrderId='${order.id}' LIMIT 1`))[0];
        if (!summaryId) return fail('COMMERCE_EFFECT_UNVERIFIED', 'Native acceptance carried no verifiable order summary.', { upstreamOutcome: invoked.body });
        capture('OrderSummary', summaryId);
        extra = { createdOrderSummaryId: summaryId };
      } else {
        const after = await request(root + '/sobjects/Order/' + order.id);
        const afterStatus = record(after.body) ? after.body.Status : undefined;
        if (!after.ok || afterStatus === beforeStatus) {
          return fail('COMMERCE_EFFECT_UNVERIFIED', 'Native acceptance carried no observable order change.', { upstreamOutcome: invoked.body });
        }
        extra = { beforeStatus, afterStatus };
      }
      verified = true;
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, input.verificationWindowMs));
      return invoked;
    })();
  } catch { outcome = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned order lifecycle could not be verified.'); }
  finally {
    const summaryOwned = owned.filter((entry) => entry.objectName === 'OrderSummary');
    for (const entry of summaryOwned) {
      const gone = await request(root + '/sobjects/OrderSummary/' + entry.id, 'DELETE').catch(() => null);
      if (!gone?.ok) cleanupError ??= `OrderSummary ${entry.id} could not be removed; platform natives may refuse deletion.`;
    }
    cleanupError ??= await cleanupCommerceFixtures({
      request, root, marker, owned: owned.filter((entry) => entry.objectName !== 'OrderSummary'),
      order: ['Order', 'Account'], scopes,
    });
  }
  return done(outcome, { verified: cleanupError ? false : verified, marker, ownedRecords: owned,
    verificationRecordIds: owned.map((entry) => entry.id).slice(0, 5), ...extra, ...(cleanupError ? { cleanupError } : {}) });
}

/** Live OrderSummary fingerprint (row + item children) for before/after comparison. */
async function readSummaryFingerprint(request: Request, root: string, orderSummaryId: string): Promise<{ summary: Value | null; items: Value[] }> {
  const summary = await request(root + '/sobjects/OrderSummary/' + orderSummaryId).catch(() => null);
  let items: Value[] = [];
  try {
    const result = await request(root + '/query?q=' + encodeURIComponent(
      `SELECT Id, Quantity, UnitPrice, Status FROM OrderItemSummary WHERE OrderSummaryId='${orderSummaryId}' LIMIT 25`));
    if (result.ok && record(result.body) && Array.isArray(result.body.records)) items = result.body.records.filter(record);
  } catch { /* children unreadable; the summary row still anchors verification */ }
  return { summary: summary?.ok && record(summary.body) ? summary.body : null, items };
}

function fingerprintDigest(print: { summary: Value | null; items: Value[] }): string {
  return JSON.stringify({ summary: print.summary, items: print.items });
}

/**
 * Order-summary submits (item add/adjust/cancel/return, ensures, payment
 * applies, payment summaries, invoices, credit memos, order-to-cart). An
 * owned summary is minted from an owned order whenever the native
 * create-summary action allows it; destructive submits refuse rather than
 * touch live rows, while reversible submits verify before/after and
 * restore scalar adjustments on live rows.
 */
async function runSubmitLifecycle(input: CommerceExecutorInput): Promise<CommerceOutcome> {
  const { request, build, root, route, action, marker } = input;
  const baseContext = {
    source: 'salesforce_live_commerce_order_submit_action', kind: 'order-submit' as const, action,
    automaticSteps: ['Describe the live submit action and OrderSummary type', 'Mint an owned summary or refuse destructive submits',
      'Invoke the submit with declared inputs only', 'Read back the actual order state', 'Restore or report residue, then clean owned records'],
  };
  const done = (outcome: Result, extra: Value): CommerceOutcome => ({
    status: outcome.status, body: outcome.body, ...(typeof extra.cleanupError === 'string' ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...baseContext, ...extra },
  });
  const inputs = commerceDescriptorInputs(input.descriptor);
  if (!inputs.length) {
    return done(fail('COMMERCE_ACTION_SCHEMA_UNAVAILABLE', 'The native descriptor has no input schema.'), { verified: false });
  }
  const described = await request(root + '/sobjects/OrderSummary/describe');
  if (!described.ok || !record(described.body) || described.body.name !== 'OrderSummary') {
    return done(fail('COMMERCE_OM_SETUP_REQUIRED',
      'Order Management setup is incomplete: the live org exposes no OrderSummary type. Enable Order Management during org provisioning, then retry.',
      { setupRequirement: 'Enable Order Management during org provisioning so the live org exposes a queryable OrderSummary type, then retry.' }),
      { verified: false, capability: { actionDescribed: true, typeDescribed: false } });
  }
  const destructive = /(cancel|return|delete|remove)/i.test(action);
  const owned: OwnedRecord[] = [];
  const capture = (objectName: string, value: string) => { if (!owned.some((entry) => entry.id === value)) owned.push({ objectName, id: value }); };
  const scopes: CommerceScope[] = [];
  let cleanupError: string | undefined;
  let outcome: Result = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned submit lifecycle did not complete.');
  let verified = false, extra: Value = {};
  try {
    outcome = await (async (): Promise<Result> => {
      // Owned-summary mint: owned Account + Order, then the native
      // create-summary action. Live rows are never fabricated.
      let orderSummaryId: string | undefined; let ownedSummary = false;
      const mintDescriptor = await request(root + '/actions/standard/createOrderSummary').catch(() => null);
      if (mintDescriptor?.ok && record(mintDescriptor.body) && Array.isArray(mintDescriptor.body.inputs)) {
        const account = await createOwnedFixture({ request, build, root, objectType: 'Account', marker, values: { Name: marker }, capture });
        if (!('failure' in account)) {
          scopes.push(markerScope('Account', account.markerField, account.storedMarker));
          const order = await createOwnedFixture({ request, build, root, objectType: 'Order', marker, values: { AccountId: account.id }, capture });
          if (!('failure' in order)) {
            scopes.push(markerScope('Order', order.markerField, order.storedMarker));
            const mintInputs = commerceDescriptorInputs(mintDescriptor.body);
            const mapped = mapCommerceArguments(mintInputs, { accountId: account.id, orderId: order.id });
            if (!('failure' in mapped)) {
              const minted = await request(root + '/actions/standard/createOrderSummary', 'POST', { inputs: [mapped.args] });
              const mintedId = outputIdentities(minted.body, /ordersummaryid$/i)[0];
              if (nativeAccepted(minted) && mintedId) {
                const reread = await request(root + '/sobjects/OrderSummary/' + mintedId);
                if (reread.ok) { orderSummaryId = mintedId; ownedSummary = true; capture('OrderSummary', mintedId); }
              }
            }
          }
        }
      }
      if (!orderSummaryId) {
        if (destructive) {
          return fail('COMMERCE_OWNED_SUMMARY_UNAVAILABLE',
            'No owned OrderSummary could be minted, and destructive submits never touch live order rows. Provision Order Management substrate, then retry.',
            { setupRequirement: 'Provision Order Management substrate (an owned OrderSummary mintable through the native create-summary action), then retry.' });
        }
        const live = await queryIds(request, root, 'SELECT Id FROM OrderSummary LIMIT 1');
        if (!live.length) {
          return fail('COMMERCE_OM_SUBSTRATE_ABSENT',
            'The live org holds no OrderSummary row for the submit, and such rows are minted by Order Management flows rather than direct creation. Provision Order Management substrate, then retry.',
            { setupRequirement: 'Provision Order Management substrate (OrderSummary rows minted by Order Management flows) during org provisioning, then retry.' });
        }
        orderSummaryId = live[0];
      }
      const ownedIds: CommerceOwnedIds = { orderSummaryId };
      if (/invoice/i.test(action)) {
        const fulfillmentParent = await discoverLiveSetupId(request, root, 'FulfillmentOrder');
        const changeParent = fulfillmentParent ? null : await discoverLiveSetupId(request, root, 'ChangeOrder');
        if (fulfillmentParent) ownedIds.live = { FulfillmentOrder: fulfillmentParent };
        else if (changeParent) ownedIds.live = { ChangeOrder: changeParent };
        else if (!ownedSummary) {
          return fail('COMMERCE_PARENT_UNAVAILABLE', 'No live fulfillment or change order exists for the invoice; nothing was created.');
        }
      }
      const before = await readSummaryFingerprint(request, root, orderSummaryId);
      const mapped = mapCommerceArguments(inputs, ownedIds);
      if ('failure' in mapped) return fail('COMMERCE_INPUT_UNAVAILABLE', mapped.failure);
      const invoked = await request(route, 'POST', { inputs: [mapped.args] });
      if (invoked.ok && (invoked.body === null || Array.isArray(invoked.body) && invoked.body.length === 0)) {
        return fail('COMMERCE_ACTION_OUTCOME_MISSING', 'Salesforce returned no native outcome; no mutation is counted as successful.');
      }
      if (!nativeAccepted(invoked)) return invoked;
      const after = await readSummaryFingerprint(request, root, orderSummaryId);
      if (!after.summary || fingerprintDigest(before) === fingerprintDigest(after)) {
        return fail('COMMERCE_EFFECT_UNVERIFIED', 'Native acceptance carried no observable order change.', { upstreamOutcome: invoked.body });
      }
      extra = { orderSummaryId, ownedSummary, itemCountBefore: before.items.length, itemCountAfter: after.items.length };
      if (/ordertocart/i.test(action)) {
        const cartIds = outputIdentities(invoked.body, /cartid$/i);
        if (cartIds[0]) {
          capture('WebCart', cartIds[0]);
          extra = { ...extra, createdCartId: cartIds[0] };
        }
      }
      // Live-row submits are additive-only by construction (destructive
      // verbs refuse above without an owned summary); the verified change
      // stands on the live row and is reported as residue below.
      if (!ownedSummary) {
        extra = { ...extra, liveRowResidue: `Verified ${action} change stands on live OrderSummary ${orderSummaryId}; no compensating shape is declared.` };
      }
      verified = true;
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, input.verificationWindowMs));
      return invoked;
    })();
  } catch { outcome = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned submit lifecycle could not be verified.'); }
  finally {
    for (const entry of owned.filter((row) => row.objectName === 'OrderSummary' || row.objectName === 'WebCart')) {
      const gone = await request(root + '/sobjects/' + entry.objectName + '/' + entry.id, 'DELETE').catch(() => null);
      if (!gone?.ok) cleanupError ??= `${entry.objectName} ${entry.id} could not be removed; platform natives may refuse deletion.`;
    }
    cleanupError ??= await cleanupCommerceFixtures({
      request, root, marker, owned: owned.filter((row) => row.objectName !== 'OrderSummary' && row.objectName !== 'WebCart'),
      order: ['Order', 'Account'], scopes,
    });
  }
  return done(outcome, { verified: cleanupError ? false : verified, marker, ownedRecords: owned,
    verificationRecordIds: extra.orderSummaryId ? [extra.orderSummaryId as string] : [], ...extra, ...(cleanupError ? { cleanupError } : {}) });
}

/**
 * Invokes a native setup action (same API root) with descriptor-mapped
 * owned arguments. Used to chain prerequisites the target needs, e.g.
 * create-fulfillment before cancel-item. Returns output identities.
 */
async function invokeNativeSetup(input: {
  request: Request; root: string; actionName: string; owned: CommerceOwnedIds;
}): Promise<{ accepted: true; body: unknown } | { accepted: false; result: Result }> {
  const { request, root, actionName, owned } = input;
  const route = root + '/actions/standard/' + actionName;
  const descriptor = await request(route).catch(() => null);
  if (!descriptor?.ok || !record(descriptor.body)) return { accepted: false, result: descriptor ?? fail('COMMERCE_SETUP_UNAVAILABLE', `Live ${actionName} descriptor is unavailable.`) };
  const mapped = mapCommerceArguments(commerceDescriptorInputs(descriptor.body), owned);
  if ('failure' in mapped) return { accepted: false, result: fail('COMMERCE_SETUP_UNAVAILABLE', mapped.failure) };
  const invoked = await request(route, 'POST', { inputs: [mapped.args] });
  if (!nativeAccepted(invoked)) return { accepted: false, result: invoked };
  return { accepted: true, body: invoked.body };
}

/**
 * Fulfillment mutations (create single/plural, cancel item). An owned
 * Account plus Order anchors creation; cancel chains a native create
 * first so the cancelled item is always owned. Children are discovered
 * via live reference fields, never assumed.
 */
async function runFulfillmentLifecycle(input: CommerceExecutorInput): Promise<CommerceOutcome> {
  const { request, build, root, route, action, marker } = input;
  const baseContext = {
    source: 'salesforce_live_commerce_fulfillment_action', kind: 'fulfillment' as const, action,
    automaticSteps: ['Create an owned account and order', 'Invoke the native action against the owned order',
      'Read back the actual fulfillment state', 'Delete only owned records and verify absence'],
  };
  const done = (outcome: Result, extra: Value): CommerceOutcome => ({
    status: outcome.status, body: outcome.body, ...(typeof extra.cleanupError === 'string' ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...baseContext, ...extra },
  });
  const inputs = commerceDescriptorInputs(input.descriptor);
  if (!inputs.length) {
    return done(fail('COMMERCE_ACTION_SCHEMA_UNAVAILABLE', 'The native descriptor has no input schema.'), { verified: false });
  }
  const fulfillmentSchema = await request(root + '/sobjects/FulfillmentOrder/describe');
  if (!fulfillmentSchema.ok || !record(fulfillmentSchema.body) || !Array.isArray(fulfillmentSchema.body.fields)) {
    return done(fail('COMMERCE_FULFILLMENT_SETUP_REQUIRED',
      'Fulfillment setup is incomplete: the live org exposes no FulfillmentOrder type. Provision fulfillment substrate, then retry.',
      { setupRequirement: 'Provision fulfillment substrate during org provisioning so the live org exposes a FulfillmentOrder type, then retry.' }),
      { verified: false });
  }
  const owned: OwnedRecord[] = [];
  const capture = (objectName: string, value: string) => { if (!owned.some((entry) => entry.id === value)) owned.push({ objectName, id: value }); };
  const scopes: CommerceScope[] = [];
  let cleanupError: string | undefined;
  let outcome: Result = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned fulfillment lifecycle did not complete.');
  let verified = false, extra: Value = {};
  try {
    outcome = await (async (): Promise<Result> => {
      const account = await createOwnedFixture({ request, build, root, objectType: 'Account', marker, values: { Name: marker }, capture });
      if ('failure' in account) return account.failure;
      scopes.push(markerScope('Account', account.markerField, account.storedMarker));
      const order = await createOwnedFixture({ request, build, root, objectType: 'Order', marker, values: { AccountId: account.id }, capture });
      if ('failure' in order) return order.failure;
      scopes.push(markerScope('Order', order.markerField, order.storedMarker));
      const ownedIds: CommerceOwnedIds = { accountId: account.id, orderId: order.id };
      const parentField = referenceFieldTo(fulfillmentSchema.body, ['Order', 'OrderSummary', 'OrderDeliveryGroup']);
      if (/cancel/i.test(action)) {
        const setup = await invokeNativeSetup({ request, root, actionName: 'createFulfillmentOrder', owned: ownedIds });
        if (!setup.accepted) {
          return fail('COMMERCE_SETUP_UNAVAILABLE', 'No owned fulfillment order could be created for the cancel; nothing was cancelled.',
            { upstreamStatus: setup.result.status });
        }
        const createdIds = outputIdentities(setup.body, /fulfillmentorderid$/i);
        const fulfillmentId = createdIds[0] ?? (parentField
          ? (await queryIds(request, root, `SELECT Id FROM FulfillmentOrder WHERE ${parentField}='${order.id}' LIMIT 1`))[0]
          : undefined);
        if (!fulfillmentId) return fail('COMMERCE_SETUP_UNVERIFIED', 'The setup fulfillment order could not be read back.');
        capture('FulfillmentOrder', fulfillmentId);
        ownedIds.live = { FulfillmentOrder: fulfillmentId };
        ownedIds.fixtures = { FulfillmentOrder: fulfillmentId };
      }
      const mapped = mapCommerceArguments(inputs, ownedIds);
      if ('failure' in mapped) return fail('COMMERCE_INPUT_UNAVAILABLE', mapped.failure);
      const invoked = await request(route, 'POST', { inputs: [mapped.args] });
      if (invoked.ok && (invoked.body === null || Array.isArray(invoked.body) && invoked.body.length === 0)) {
        return fail('COMMERCE_ACTION_OUTCOME_MISSING', 'Salesforce returned no native outcome; no mutation is counted as successful.');
      }
      if (!nativeAccepted(invoked)) return invoked;
      if (/cancel/i.test(action)) {
        const fulfillmentId = ownedIds.live?.FulfillmentOrder as string;
        const after = await request(root + '/sobjects/FulfillmentOrder/' + fulfillmentId);
        const status = record(after.body) ? String(after.body.Status ?? after.body.StatusCategory ?? '') : '';
        if (!after.ok && after.status !== 404 && !/cancel/i.test(status)) {
          return fail('COMMERCE_EFFECT_UNVERIFIED', 'Native acceptance carried no observable cancel.', { upstreamOutcome: invoked.body });
        }
        extra = { fulfillmentId, afterStatus: status || (after.status === 404 ? 'absent' : 'unknown') };
      } else {
        const createdIds = outputIdentities(invoked.body, /fulfillmentorderids?$/i);
        const existing = createdIds.length ? createdIds : parentField
          ? await queryIds(request, root, `SELECT Id FROM FulfillmentOrder WHERE ${parentField}='${order.id}' LIMIT 5`)
          : [];
        if (!existing.length) return fail('COMMERCE_EFFECT_UNVERIFIED', 'Native acceptance carried no verifiable fulfillment order.', { upstreamOutcome: invoked.body });
        for (const fulfillmentId of existing.slice(0, 5)) capture('FulfillmentOrder', fulfillmentId);
        extra = { createdFulfillmentIds: existing.slice(0, 5) };
      }
      verified = true;
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, input.verificationWindowMs));
      return invoked;
    })();
  } catch { outcome = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned fulfillment lifecycle could not be verified.'); }
  finally {
    for (const entry of owned.filter((row) => row.objectName === 'FulfillmentOrder')) {
      const gone = await request(root + '/sobjects/FulfillmentOrder/' + entry.id, 'DELETE').catch(() => null);
      if (!gone?.ok) cleanupError ??= `FulfillmentOrder ${entry.id} could not be removed; platform natives may refuse deletion.`;
    }
    cleanupError ??= await cleanupCommerceFixtures({
      request, root, marker, owned: owned.filter((row) => row.objectName !== 'FulfillmentOrder'),
      order: ['Order', 'Account'], scopes,
    });
  }
  return done(outcome, { verified: cleanupError ? false : verified, marker, ownedRecords: owned,
    verificationRecordIds: owned.map((entry) => entry.id).slice(0, 5), ...extra, ...(cleanupError ? { cleanupError } : {}) });
}

/**
 * Return mutations (create return, return items, disposal lines). An
 * owned Account plus Order anchors creation; item/disposal targets chain
 * a native create-return first so every returned line is owned.
 */
async function runReturnLifecycle(input: CommerceExecutorInput): Promise<CommerceOutcome> {
  const { request, build, root, route, action, marker } = input;
  const baseContext = {
    source: 'salesforce_live_commerce_return_action', kind: 'return' as const, action,
    automaticSteps: ['Create an owned account and order', 'Invoke the native action against the owned order',
      'Read back the actual return state', 'Delete only owned records and verify absence'],
  };
  const done = (outcome: Result, extra: Value): CommerceOutcome => ({
    status: outcome.status, body: outcome.body, ...(typeof extra.cleanupError === 'string' ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...baseContext, ...extra },
  });
  const inputs = commerceDescriptorInputs(input.descriptor);
  if (!inputs.length) {
    return done(fail('COMMERCE_ACTION_SCHEMA_UNAVAILABLE', 'The native descriptor has no input schema.'), { verified: false });
  }
  const returnSchema = await request(root + '/sobjects/ReturnOrder/describe');
  if (!returnSchema.ok || !record(returnSchema.body) || !Array.isArray(returnSchema.body.fields)) {
    return done(fail('COMMERCE_RETURN_SETUP_REQUIRED',
      'Return setup is incomplete: the live org exposes no ReturnOrder type. Provision return substrate, then retry.',
      { setupRequirement: 'Provision return substrate during org provisioning so the live org exposes a ReturnOrder type, then retry.' }),
      { verified: false });
  }
  const owned: OwnedRecord[] = [];
  const capture = (objectName: string, value: string) => { if (!owned.some((entry) => entry.id === value)) owned.push({ objectName, id: value }); };
  const scopes: CommerceScope[] = [];
  let cleanupError: string | undefined;
  let outcome: Result = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned return lifecycle did not complete.');
  let verified = false, extra: Value = {};
  try {
    outcome = await (async (): Promise<Result> => {
      const account = await createOwnedFixture({ request, build, root, objectType: 'Account', marker, values: { Name: marker }, capture });
      if ('failure' in account) return account.failure;
      scopes.push(markerScope('Account', account.markerField, account.storedMarker));
      const order = await createOwnedFixture({ request, build, root, objectType: 'Order', marker, values: { AccountId: account.id }, capture });
      if ('failure' in order) return order.failure;
      scopes.push(markerScope('Order', order.markerField, order.storedMarker));
      const ownedIds: CommerceOwnedIds = { accountId: account.id, orderId: order.id };
      const parentField = referenceFieldTo(returnSchema.body, ['Order', 'OrderSummary']);
      const needsSetup = !/^create/i.test(action);
      if (needsSetup) {
        const setup = await invokeNativeSetup({ request, root, actionName: 'createReturnOrder', owned: ownedIds });
        if (!setup.accepted) {
          return fail('COMMERCE_SETUP_UNAVAILABLE', 'No owned return order could be created for the target; nothing was returned.',
            { upstreamStatus: setup.result.status });
        }
        const createdIds = outputIdentities(setup.body, /returnorderid$/i);
        const returnId = createdIds[0] ?? (parentField
          ? (await queryIds(request, root, `SELECT Id FROM ReturnOrder WHERE ${parentField}='${order.id}' LIMIT 1`))[0]
          : undefined);
        if (!returnId) return fail('COMMERCE_SETUP_UNVERIFIED', 'The setup return order could not be read back.');
        capture('ReturnOrder', returnId);
        ownedIds.live = { ReturnOrder: returnId };
        ownedIds.fixtures = { ReturnOrder: returnId };
      }
      const mapped = mapCommerceArguments(inputs, ownedIds);
      if ('failure' in mapped) return fail('COMMERCE_INPUT_UNAVAILABLE', mapped.failure);
      const invoked = await request(route, 'POST', { inputs: [mapped.args] });
      if (invoked.ok && (invoked.body === null || Array.isArray(invoked.body) && invoked.body.length === 0)) {
        return fail('COMMERCE_ACTION_OUTCOME_MISSING', 'Salesforce returned no native outcome; no mutation is counted as successful.');
      }
      if (!nativeAccepted(invoked)) return invoked;
      const createdIds = outputIdentities(invoked.body, /returnorder(lineitem|item)?ids?$/i);
      const existing = createdIds.length ? createdIds : parentField && !needsSetup
        ? await queryIds(request, root, `SELECT Id FROM ReturnOrder WHERE ${parentField}='${order.id}' LIMIT 5`)
        : Object.values(ownedIds.live ?? {});
      if (!existing.length) return fail('COMMERCE_EFFECT_UNVERIFIED', 'Native acceptance carried no verifiable return.', { upstreamOutcome: invoked.body });
      for (const returnId of existing.slice(0, 5)) capture('ReturnOrder', returnId);
      extra = { createdReturnIds: existing.slice(0, 5) };
      verified = true;
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, input.verificationWindowMs));
      return invoked;
    })();
  } catch { outcome = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned return lifecycle could not be verified.'); }
  finally {
    for (const entry of owned.filter((row) => row.objectName === 'ReturnOrder')) {
      const gone = await request(root + '/sobjects/ReturnOrder/' + entry.id, 'DELETE').catch(() => null);
      if (!gone?.ok) cleanupError ??= `ReturnOrder ${entry.id} could not be removed; platform natives may refuse deletion.`;
    }
    cleanupError ??= await cleanupCommerceFixtures({
      request, root, marker, owned: owned.filter((row) => row.objectName !== 'ReturnOrder'),
      order: ['Order', 'Account'], scopes,
    });
  }
  return done(outcome, { verified: cleanupError ? false : verified, marker, ownedRecords: owned,
    verificationRecordIds: owned.map((entry) => entry.id).slice(0, 5), ...extra, ...(cleanupError ? { cleanupError } : {}) });
}

/** Owned rebate-type fixture for rebate/batch scopes; failure when the type is undescribable. */
async function provisionRebateScope(input: {
  request: Request; build: Build; root: string; marker: string;
  capture: (objectName: string, value: string) => void;
}): Promise<{ typeId: string; markerField: string; storedMarker: string } | { failure: Result }> {
  const rebateType = await createOwnedFixture({ ...input, objectType: 'ProgramRebateType', marker: input.marker, capture: input.capture });
  if ('failure' in rebateType) {
    return { failure: fail('COMMERCE_REBATE_SCOPE_UNAVAILABLE',
      'No owned rebate scope could be provisioned; the live org exposes no creatable ProgramRebateType. Provision rebate substrate, then retry.',
      { setupRequirement: 'Provision rebate substrate during org provisioning so the live org exposes a creatable ProgramRebateType, then retry.' }) };
  }
  return { typeId: rebateType.id, markerField: rebateType.markerField, storedMarker: rebateType.storedMarker };
}

/**
 * Rebate mutations (member lists, amount calculation + payout upsert,
 * type-product processing, CSV processing, custom payout upserts). An
 * owned rebate-type fixture scopes the invocation; CSV payloads are
 * built from the owned fixture's live fields, never invented.
 */
async function runRebateLifecycle(input: CommerceExecutorInput): Promise<CommerceOutcome> {
  const { request, build, root, route, action, marker } = input;
  const baseContext = {
    source: 'salesforce_live_commerce_rebate_action', kind: 'rebate' as const, action,
    automaticSteps: ['Provision an owned rebate scope', 'Invoke the native action against the owned scope',
      'Read back the actual rebate state', 'Delete only owned records and verify absence'],
  };
  const done = (outcome: Result, extra: Value): CommerceOutcome => ({
    status: outcome.status, body: outcome.body, ...(typeof extra.cleanupError === 'string' ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...baseContext, ...extra },
  });
  const inputs = commerceDescriptorInputs(input.descriptor);
  if (!inputs.length) {
    return done(fail('COMMERCE_ACTION_SCHEMA_UNAVAILABLE', 'The native descriptor has no input schema.'), { verified: false });
  }
  const owned: OwnedRecord[] = [];
  const capture = (objectName: string, value: string) => { if (!owned.some((entry) => entry.id === value)) owned.push({ objectName, id: value }); };
  const scopes: CommerceScope[] = [];
  let cleanupError: string | undefined;
  let outcome: Result = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned rebate lifecycle did not complete.');
  let verified = false, extra: Value = {};
  try {
    outcome = await (async (): Promise<Result> => {
      const scope = await provisionRebateScope({ request, build, root, marker, capture });
      if ('failure' in scope) return scope.failure;
      scopes.push(markerScope('ProgramRebateType', scope.markerField, scope.storedMarker));
      const ownedIds: CommerceOwnedIds = { fixtures: { ProgramRebateType: scope.typeId }, live: { ProgramRebateType: scope.typeId } };
      if (/csv/i.test(action)) {
        const described = await request(root + '/sobjects/ProgramRebateType/describe');
        const fields = targetFieldsOf(described.ok ? described.body : null)
          .filter((field) => field.createable === true && (field.type === 'string' || field.type === 'textarea' || field.type === 'reference'))
          .map((field) => field.name).slice(0, 12);
        if (!fields.length) return fail('COMMERCE_CSV_SCHEMA_UNAVAILABLE', 'No live rebate fields exist to build an owned CSV payload.');
        const csv = fields.join(',') + '\n' + fields.map((name) => name === 'Id' ? scope.typeId : marker.slice(0, 40)).join(',');
        const csvInput = inputs.find((entry) => /csv|data|content|document|payload/i.test(entry.name) && entry.required === true)
          ?? inputs.find((entry) => /csv|data|content|document|payload/i.test(entry.name));
        if (!csvInput) return fail('COMMERCE_INPUT_UNAVAILABLE', 'The live descriptor declares no usable CSV input.');
        const mapped = mapCommerceArguments(inputs.filter((entry) => entry.name !== csvInput.name), ownedIds);
        if ('failure' in mapped) return fail('COMMERCE_INPUT_UNAVAILABLE', mapped.failure);
        const invoked = await request(route, 'POST', { inputs: [{ ...mapped.args, [csvInput.name]: csv }] });
        if (!nativeAccepted(invoked)) return invoked;
        verified = true;
        extra = { rebateTypeId: scope.typeId, csvColumns: fields };
        if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, input.verificationWindowMs));
        return invoked;
      }
      const mapped = mapCommerceArguments(inputs, ownedIds);
      if ('failure' in mapped) return fail('COMMERCE_INPUT_UNAVAILABLE', mapped.failure);
      const invoked = await request(route, 'POST', { inputs: [mapped.args] });
      if (invoked.ok && (invoked.body === null || Array.isArray(invoked.body) && invoked.body.length === 0)) {
        return fail('COMMERCE_ACTION_OUTCOME_MISSING', 'Salesforce returned no native outcome; no mutation is counted as successful.');
      }
      if (!nativeAccepted(invoked)) return invoked;
      if (/upsert|payout/i.test(action)) {
        const payoutIds = outputIdentities(invoked.body, /(payout|rebate).{0,8}ids?$/i);
        if (payoutIds[0]) {
          const reread = await request(root + '/sobjects/CustomRebatePayout/' + payoutIds[0]).catch(() => null);
          if (reread?.ok) capture('CustomRebatePayout', payoutIds[0]);
          extra = { payoutIds: payoutIds.slice(0, 5) };
        }
      }
      const reread = await request(root + '/sobjects/ProgramRebateType/' + scope.typeId);
      if (!reread.ok) return fail('COMMERCE_EFFECT_UNVERIFIED', 'The owned rebate scope vanished during invocation.', { upstreamOutcome: invoked.body });
      verified = true;
      extra = { ...extra, rebateTypeId: scope.typeId };
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, input.verificationWindowMs));
      return invoked;
    })();
  } catch { outcome = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned rebate lifecycle could not be verified.'); }
  finally {
    for (const entry of owned.filter((row) => row.objectName === 'CustomRebatePayout')) {
      const gone = await request(root + '/sobjects/CustomRebatePayout/' + entry.id, 'DELETE').catch(() => null);
      if (!gone?.ok) cleanupError ??= `CustomRebatePayout ${entry.id} could not be removed; platform natives may refuse deletion.`;
    }
    cleanupError ??= await cleanupCommerceFixtures({
      request, root, marker, owned: owned.filter((row) => row.objectName !== 'CustomRebatePayout'),
      order: ['ProgramRebateType'], scopes,
    });
  }
  return done(outcome, { verified: cleanupError ? false : verified, marker, ownedRecords: owned,
    verificationRecordIds: owned.map((entry) => entry.id).slice(0, 5), ...extra, ...(cleanupError ? { cleanupError } : {}) });
}

/**
 * Rebate batch-calculation jobs. The owned rebate-type fixture scopes
 * the job; the native outcome must carry a job identity whose terminal
 * state is read back from AsyncApexJob within a bounded poll.
 */
async function runBatchLifecycle(input: CommerceExecutorInput): Promise<CommerceOutcome> {
  const { request, build, root, route, action, marker } = input;
  const baseContext = {
    source: 'salesforce_live_commerce_rebate_batch_action', kind: 'batch' as const, action,
    automaticSteps: ['Provision an owned rebate scope', 'Submit the native batch calculation job',
      'Read back the terminal job state', 'Delete only owned records and verify absence'],
  };
  const done = (outcome: Result, extra: Value): CommerceOutcome => ({
    status: outcome.status, body: outcome.body, ...(typeof extra.cleanupError === 'string' ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...baseContext, ...extra },
  });
  const inputs = commerceDescriptorInputs(input.descriptor);
  if (!inputs.length) {
    return done(fail('COMMERCE_ACTION_SCHEMA_UNAVAILABLE', 'The native descriptor has no input schema.'), { verified: false });
  }
  const owned: OwnedRecord[] = [];
  const capture = (objectName: string, value: string) => { if (!owned.some((entry) => entry.id === value)) owned.push({ objectName, id: value }); };
  let cleanupError: string | undefined;
  const batchScopes: CommerceScope[] = [];
  let outcome: Result = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned batch lifecycle did not complete.');
  let verified = false, extra: Value = {};
  try {
    outcome = await (async (): Promise<Result> => {
      const scope = await provisionRebateScope({ request, build, root, marker, capture });
      if ('failure' in scope) return scope.failure;
      batchScopes.push(markerScope('ProgramRebateType', scope.markerField, scope.storedMarker));
      const mapped = mapCommerceArguments(inputs, { fixtures: { ProgramRebateType: scope.typeId }, live: { ProgramRebateType: scope.typeId } });
      if ('failure' in mapped) return fail('COMMERCE_INPUT_UNAVAILABLE', mapped.failure);
      const invoked = await request(route, 'POST', { inputs: [mapped.args] });
      if (!nativeAccepted(invoked)) return invoked;
      const jobIds = outputIdentities(invoked.body, /(job|batch|async).{0,8}ids?$/i);
      if (!jobIds[0]) return fail('COMMERCE_JOB_UNVERIFIED', 'Native acceptance carried no job identity.', { upstreamOutcome: invoked.body });
      let status = '';
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1500, (input.verificationWindowMs ?? 6000) / 4)));
        try {
          const job = await request(root + '/query?q=' + encodeURIComponent(
            `SELECT Status, NumberOfErrors FROM AsyncApexJob WHERE Id='${jobIds[0]}' LIMIT 1`));
          const row = record(job.body) && Array.isArray(job.body.records) ? job.body.records.filter(record)[0] : undefined;
          status = row && typeof row.Status === 'string' ? row.Status : '';
          if (['Completed', 'Failed', 'Aborted'].includes(status)) {
            extra = { jobId: jobIds[0], jobStatus: status, jobErrors: row?.NumberOfErrors ?? null };
            break;
          }
        } catch { /* poll again until the bound */ }
      }
      if (status !== 'Completed') {
        return fail('COMMERCE_JOB_UNVERIFIED', `The batch job did not reach Completed (state: ${status || 'unknown'}).`, { upstreamOutcome: invoked.body });
      }
      verified = true;
      return invoked;
    })();
  } catch { outcome = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned batch lifecycle could not be verified.'); }
  finally {
    cleanupError = await cleanupCommerceFixtures({ request, root, marker, owned, order: ['ProgramRebateType'], scopes: batchScopes });
  }
  return done(outcome, { verified: cleanupError ? false : verified, marker, ownedRecords: owned,
    verificationRecordIds: owned.map((entry) => entry.id).slice(0, 5), ...extra, ...(cleanupError ? { cleanupError } : {}) });
}

/**
 * Loyalty program-process runs against a transaction journal. An owned
 * journal fixture anchors the run when the live schema allows one;
 * otherwise the run refuses instead of executing against a live journal.
 */
async function runLoyaltyLifecycle(input: CommerceExecutorInput): Promise<CommerceOutcome> {
  const { request, build, root, route, action, marker } = input;
  const baseContext = {
    source: 'salesforce_live_commerce_loyalty_action', kind: 'loyalty' as const, action,
    automaticSteps: ['Create an owned transaction journal', 'Invoke the native program run against the owned journal',
      'Read back the actual journal state', 'Delete only owned records and verify absence'],
  };
  const done = (outcome: Result, extra: Value): CommerceOutcome => ({
    status: outcome.status, body: outcome.body, ...(typeof extra.cleanupError === 'string' ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...baseContext, ...extra },
  });
  const inputs = commerceDescriptorInputs(input.descriptor);
  if (!inputs.length) {
    return done(fail('COMMERCE_ACTION_SCHEMA_UNAVAILABLE', 'The native descriptor has no input schema.'), { verified: false });
  }
  const owned: OwnedRecord[] = [];
  const capture = (objectName: string, value: string) => { if (!owned.some((entry) => entry.id === value)) owned.push({ objectName, id: value }); };
  const journalScopes: CommerceScope[] = [];
  let cleanupError: string | undefined;
  let outcome: Result = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned loyalty lifecycle did not complete.');
  let verified = false, extra: Value = {};
  try {
    outcome = await (async (): Promise<Result> => {
      const journal = await createOwnedFixture({ request, build, root, objectType: 'TransactionJournal', marker, capture });
      if ('failure' in journal) {
        return fail('COMMERCE_JOURNAL_CONTEXT_UNAVAILABLE',
          'No owned transaction journal could be provisioned, and program runs never execute against live journals. Provision loyalty substrate, then retry.',
          { setupRequirement: 'Provision loyalty substrate during org provisioning so an owned transaction journal can be created, then retry.' });
      }
      journalScopes.push(markerScope('TransactionJournal', journal.markerField, journal.storedMarker));
      const before = await request(root + '/sobjects/TransactionJournal/' + journal.id);
      const beforeStatus = record(before.body) ? before.body.Status : undefined;
      const mapped = mapCommerceArguments(inputs, { journalId: journal.id });
      if ('failure' in mapped) return fail('COMMERCE_INPUT_UNAVAILABLE', mapped.failure);
      const invoked = await request(route, 'POST', { inputs: [mapped.args] });
      if (invoked.ok && (invoked.body === null || Array.isArray(invoked.body) && invoked.body.length === 0)) {
        return fail('COMMERCE_ACTION_OUTCOME_MISSING', 'Salesforce returned no native outcome; no mutation is counted as successful.');
      }
      if (!nativeAccepted(invoked)) return invoked;
      const after = await request(root + '/sobjects/TransactionJournal/' + journal.id);
      const afterStatus = record(after.body) ? after.body.Status : undefined;
      if (!after.ok || afterStatus === beforeStatus) {
        return fail('COMMERCE_EFFECT_UNVERIFIED', 'Native acceptance carried no observable journal change.', { upstreamOutcome: invoked.body });
      }
      verified = true;
      extra = { journalId: journal.id, beforeStatus, afterStatus };
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, input.verificationWindowMs));
      return invoked;
    })();
  } catch { outcome = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned loyalty lifecycle could not be verified.'); }
  finally {
    cleanupError = await cleanupCommerceFixtures({ request, root, marker, owned, order: ['TransactionJournal'], scopes: journalScopes });
  }
  return done(outcome, { verified: cleanupError ? false : verified, marker, ownedRecords: owned,
    verificationRecordIds: owned.map((entry) => entry.id).slice(0, 5), ...extra, ...(cleanupError ? { cleanupError } : {}) });
}

export type CommerceLifecycleRequest = {
  root: string; route: string; verificationWindowMs?: number;
  request: Request; build: Build;
};

/**
 * Owned commerce lifecycle dispatch. Payment authorization reuses its
 * dedicated lifecycle; every other kind provisions owned fixtures,
 * invokes with declared inputs only, requires readback, and cleans up.
 */
export async function invokeCommerceLifecycleWithContext(input: CommerceLifecycleRequest): Promise<CommerceOutcome> {
  const action = commerceLifecycleActionName(input.route);
  if (!action || !input.root.startsWith('/services/data/') || !input.route.startsWith(`${input.root}/actions/`)) {
    return { status: 422, body: { errorCode: 'COMMERCE_ROUTE_INVALID', message: 'A discovered standard commerce action route is required.' } };
  }
  const kind = commerceLifecycleKind(action);
  if (kind === 'payment-auth') {
    return invokePaymentAuthorizationWithContext({
      root: input.root, route: input.route, verificationWindowMs: input.verificationWindowMs,
      request: input.request, build: input.build,
    });
  }
  if (input.verificationWindowMs !== undefined &&
    (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return { status: 422, body: { errorCode: 'COMMERCE_WINDOW_INVALID', message: 'A bounded verification window is required.' } };
  }
  const descriptor = await input.request(input.route);
  if (!descriptor.ok || !record(descriptor.body)) return { status: descriptor.status, body: descriptor.body };
  const marker = 'AS probe commerce ' + crypto.randomUUID();
  const executor: CommerceExecutorInput = {
    root: input.root, route: input.route, action, verificationWindowMs: input.verificationWindowMs,
    descriptor: descriptor.body, marker, request: input.request, build: input.build,
  };
  const finished = await (async (): Promise<CommerceOutcome> => {
    switch (kind) {
      case 'cart': return runCartLifecycle(executor);
      case 'cart-read': return runCartReadLifecycle(executor);
      case 'order': return runOrderLifecycle(executor);
      case 'order-submit': return runSubmitLifecycle(executor);
      case 'fulfillment': return runFulfillmentLifecycle(executor);
      case 'return': return runReturnLifecycle(executor);
      case 'rebate': return runRebateLifecycle(executor);
      case 'batch': return runBatchLifecycle(executor);
      case 'loyalty': return runLoyaltyLifecycle(executor);
      default: return { status: 422, body: { errorCode: 'COMMERCE_KIND_UNAVAILABLE', message: 'No owned commerce lifecycle covers the discovered action.' } };
    }
  })();
  // Upstream REST denials map to planner-only grant-family requirements;
  // non-denial outcomes (successes included) attach nothing. Grants are
  // never applied here.
  const probe: Result = { status: finished.status, ok: finished.status >= 200 && finished.status < 300, body: finished.body };
  const denialGrant = nativeAccepted(probe) ? null : denialGrantForRestOutcome(finished.status, finished.body);
  if (!denialGrant) return finished;
  return {
    ...finished,
    denialGrant,
    contextSchema: { ...(finished.contextSchema ?? {}), denialGrant },
  };
}
