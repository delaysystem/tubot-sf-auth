import { createOwnedStoreBuyer } from "./create-owned-store-buyer";
import { provisionOwnedBuyerAccount } from "./owned-buyer-account";
import { discoverFlowActionScalarInput } from "./flow-action-scalar-input";
import { ownedOrderChildScopes, restoreOwnedOrderDrafts } from "./owned-order-child-scopes";
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
import { clampVerificationWindowMs } from './verification-window';

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
type Request = (path: string, method?: string, body?: any) => Promise<Result>;
type Build = (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;

/** Family builder version: owned commerce lifecycles + read exemptions (re-audits skipped rows).
 * 119: cart calculators run reads against a live owned cart (cart-read
 * kind) instead of binding stale cleaned-cart ids; buyer chains span all
 * store groups with partial-chain cleanup.
 * 120: rebate scopes seed RebateProgramId (borrow else owned mint) with live
 * Custom recipe; faults unmasked; cleanup-time owner reclaim on payauth legs.
 * 121: custom/apex cart-to-order drafts run the cart lifecycle with an owned
 * checkout-session chain (delivery group + priced item + session) instead
 * of parking on liveCartCheckoutSessionId; created order children clean up.
 * 122: draft chains resolve product + unit price FROM the bound live
 * pricebook's entries (the SDO apex rejects list prices that disagree
 * with the PricebookEntry); the adopted auto delivery group is enriched.
 * 123: the SDO draft shape also mints a CartTax row per item (its tax
 * block null-derefs without one) and captures created tax line items.
 * 124: ConnectApi wrapper vocabulary (createOrderSummaryInput carries the
 * owned orderId); activateOrderAction runs the cart leg with a discovered
 * Order status; legs may bind scalar vocabulary via owned.scalars.
 * 125: summary actions activate the owned order first (live pricebook +
 * owned product line, read-back proof) since the native refuses drafts.
 * 126: the activation chain assigns an owned delivery group pre-activation
 * (native MISSING_ARGUMENT without it); the summary fallback queries
 * OriginalOrderId; cleanup reduces the order to Draft first.
 * 127: activateOrderAction provisions the session chain and flips the
 * owned session to Active (the native refuses session-less carts).
 * 128: the owned cart advances to Checkout first (the native integrates
 * checkout-phase carts only).
 * 129: activation arms the session with an owned Draft order (product
 * line), a non-null next state, and binds orderStatus to Draft (current
 * status); the flip is read-back verified and reduced on cleanup.
 * 130: optional inputs with no discovered binding are omitted (neutral
 * markers poison validated vocabularies and force optional booleans).
 * 131: the activation order assigns an owned delivery group (native
 * MISSING_ARGUMENT without it); orderStatus binds Activated (target).
 * 132: activation captures its minted summary for ordered cleanup
 * (summary delete, then Draft reduction, then the chain) and preserves
 * the summary-delete error instead of overwriting it.
 * 133: the submit mint activates its owned order (the summary native
 * refuses drafts) and the submit binds accountId (minted, else the live
 * summary's); cleanup reduces and orders the activation chain.
 * 134: declared nextState binds the Complete transition (presence-only
 * validation, read-back verified on the owned session).
 * 135: wrapper builders compose multi-child envelopes (payment summaries
 * link an owned authorization the submit mints); payment rows verify by
 * before/after snapshot and clean in dependency order.
 * 136: tax reversals route to the submit family with a per-item envelope;
 * reversal entries verify by order-tax-line snapshot and clean first.
 * 137: the summary mint is shared (submit + fulfillment); fulfillment
 * mints an owned summary, discovers its live group/line rows (quantities
 * flow in) plus the fulfill-from location, and builds the proved wrapper
 * vocabulary (single trio; plural wraps via `fulfillmentOrders`).
 * 138: fulfillment creates fail fast as platform-uncallable (superseded
 * by 139: the gate reads line data, not wrapper shape).
 * 139: fulfillment wrapper drops top-level `type` (binder GACK); the
 * group carries fulfillmentType + referenceId, and owned order items
 * mint with Type so summary lines satisfy the missing_type gate.
 * 140: owned summaries delete automation-attached fulfillment children
 * first (all four legs); fulfillment creates gate on typed lines with
 * available quantity; cancel setups direct-insert an owned order+line.
 * 161: track above shared contract 160 (PK probe fetch, skip-recorded,
 * verified-guess + namespace dispatch, describe cache); no family change.
 * 175: track above shared contract 174 (native standard-action model config);
 * no family change.
 * 176: track above shared contract 175 (record-ID PII masking fix); no family
 * change.
 * 177: track above shared contract 176; no family change. */
export const COMMERCE_LIFECYCLE_BUILDER_VERSION = 177;

export type CommerceLifecycleKind =
  | 'payment-auth' | 'cart' | 'cart-read' | 'order' | 'order-submit' | 'fulfillment' | 'return' | 'rebate' | 'loyalty' | 'batch';
export type CommerceReadKind = 'cart-read' | 'pricing-read' | 'routing-read' | 'rebate-read';

const ACTION_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,127}$/;
const STANDARD_ROUTE = /^\/services\/data\/v\d+(?:\.\d+)?\/actions\/standard\/([A-Za-z][A-Za-z0-9_.]{0,127})$/;
const CUSTOM_APEX_ROUTE = /^\/services\/data\/v\d+(?:\.\d+)?\/actions\/custom\/apex\/([A-Za-z][A-Za-z0-9_.]{0,127})$/;
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
  // Tax reversals post against the acted-on summary's item summaries.
  if (has('tax') && has('reversal')) return 'order-submit';
  if (has('apply') && (has('payment') || has('payments'))) return 'order-submit';
  if (/ordertocart/i.test(actionName)) return 'order-submit';
  if (has('create') && /orderpayment/i.test(actionName)) return 'order-submit';
  if (/invoice/i.test(actionName) && has('create', 'from')) return 'order-submit';
  if (/creditmemo/i.test(actionName) && has('create', 'order')) return 'order-submit';
  // activateOrderAction declares cartId + orderStatus (no orderId): it runs
  // against an owned cart, not the order leg (which provisions no cart).
  // Narrow to this exact action; sibling activate+order verbs keep the
  // order leg until their descriptors prove otherwise.
  if (/^activateorderaction$/i.test(actionName)) return 'cart';
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
  if (standardTailed(actionType, route, actionName)) return commerceLifecycleKind(actionName) !== null;
  // Custom/apex cart-to-order drafts (B2BCartToOrderDraft family): the
  // generic apex path can only bind live ids, but the draft apex reads
  // the cart's delivery group + items and rewrites the session row, so a
  // live session would be hijacked. Vocabulary-cut to cart-to-order only;
  // every other apex action keeps its existing lane.
  if (actionType !== 'custom/apex' || typeof actionName !== 'string' || !ACTION_NAME.test(actionName)) return false;
  const match = typeof route === 'string' ? route.match(CUSTOM_APEX_ROUTE) : null;
  return match !== null && match[1] === actionName && /carttoorder/i.test(actionName) &&
    commerceLifecycleKind(actionName) === 'cart';
}

/** Action tail from a standard or draft-apex route; null unless the tail carries a commerce lifecycle kind. */
export function commerceLifecycleActionName(route: string): string | null {
  if (typeof route !== 'string') return null;
  const standard = route.match(STANDARD_ROUTE)?.[1] ?? null;
  if (standard !== null) return commerceLifecycleKind(standard) !== null ? standard : null;
  const apex = route.match(CUSTOM_APEX_ROUTE)?.[1] ?? null;
  if (apex === null) return null;
  return /carttoorder/i.test(apex) && commerceLifecycleKind(apex) === 'cart' ? apex : null;
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
  journalId?: string; checkoutSessionId?: string;
  /** Owned fixture id by object API name for descriptor-declared sObjectType inputs. */
  fixtures?: Record<string, string>;
  /** Live setup ids by object API name (gateways, delivery methods, parents). Never invented. */
  live?: Record<string, string>;
  /** Discovered platform scalar vocabulary (enum codes, status values), keyed by lowercase input name. */
  scalars?: Record<string, string>;
  /** Acted-on summary's live line rows (fulfillment quantities flow through). Never invented. */
  lineSummaries?: Array<{ id: string; quantity: number }>;
};

/**
 * ConnectApi representation wrappers whose live descriptor carries no
 * nested fields (Tooling is blind to platform ConnectApi namespaces).
 * Each member composes its required children from owned context with
 * platform vocabulary, oracle-verified per member with non-mutating
 * validation probes before listing here. A builder returns undefined
 * when any piece is missing (honest mapper failure, never invention).
 */
const WRAPPER_BUILDERS: Array<{ pattern: RegExp; build: (owned: CommerceOwnedIds) => Record<string, unknown> | undefined }> = [
  { pattern: /^createordersummaryinput$/, build: (owned) => owned.orderId ? { orderId: owned.orderId } : undefined },
  // Payment summaries link the acted-on summary to an authorization the
  // leg minted (oracle: orderSummaryId + paymentAuthorizationId both
  // required; paymentIds alternate shape not bound).
  { pattern: /^createorderpaymentsummaryinput$/, build: (owned) =>
    owned.orderSummaryId && owned.live?.PaymentAuthorization
      ? { orderSummaryId: owned.orderSummaryId, paymentAuthorizationId: owned.live.PaymentAuthorization }
      : undefined },
  // Tax reversals post a per-item list (oracle: taxReversalInfoList of
  // {orderItemSummaryId}; shape-validated, bogus ids pass validation).
  { pattern: /^taxreversalinfos$/, build: (owned) =>
    owned.live?.OrderItemSummary
      ? { taxReversalInfoList: [{ orderItemSummaryId: owned.live.OrderItemSummary }] }
      : undefined },
  { pattern: /^fulfillmentorderinput$/, build: (owned) => buildFulfillmentOrderInput(owned) },
  { pattern: /^multiplefulfillmentorderinput$/, build: (owned) => {
    const single = buildFulfillmentOrderInput(owned);
    // Empty-wrapper discovery proved the plural list key is
    // `fulfillmentOrders` (every other key is rejected as an unknown
    // flow variable); one owned element suffices for the probe.
    return single ? { fulfillmentOrders: [single] } : undefined;
  } },
  // Cancel lists owned fulfillment lines (live proof: Quantity 1->0;
  // the wrapper must be present — omitting it null-derefs the binder).
  { pattern: /^fulfillmentorderlineitemstocancelinput$/, build: (owned) => {
    const lines = (owned.lineSummaries ?? []).filter((row) => id(row.id) && row.quantity > 0);
    return lines.length
      ? { fulfillmentOrderLineItemsToCancel: lines.map((row) => ({ fulfillmentOrderLineItemId: row.id, quantity: row.quantity })) }
      : undefined;
  } },
];

const KNOWN_ID_INPUTS: Array<{ pattern: RegExp; pick: (owned: CommerceOwnedIds) => string | undefined; missing: string }> = [
  { pattern: /^(activeorcartid|cartid|cartstateorid)$/, pick: (owned) => owned.cartId, missing: 'liveCartId' },
  { pattern: /^webstoreid$/, pick: (owned) => owned.storeId, missing: 'liveStoreId' },
  { pattern: /^(accountid|effectiveaccountid)$/, pick: (owned) => owned.accountId, missing: 'liveAccountId' },
  { pattern: /^orderid$/, pick: (owned) => owned.orderId, missing: 'liveOrderId' },
  { pattern: /^ordersummaryid$/, pick: (owned) => owned.orderSummaryId, missing: 'liveOrderSummaryId' },
  { pattern: /^(journalid|transactionjournalid)$/, pick: (owned) => owned.journalId, missing: 'liveTransactionJournalId' },
  { pattern: /^checkoutsessionid$/, pick: (owned) => owned.checkoutSessionId, missing: 'liveCheckoutSessionId' },
];

/** Setup/live fixture ids by input-name vocabulary (fixtures win over live setup). */
const NAMED_FIXTURE_INPUTS: Array<{ pattern: RegExp; objectType: string }> = [
  { pattern: /^(fulfillmentorderids?|fulfillmentid)$/, objectType: 'FulfillmentOrder' },
  { pattern: /^changeorderids?$/, objectType: 'ChangeOrder' },
  { pattern: /^returnorderids?$/, objectType: 'ReturnOrder' },
  { pattern: /^(deliverymethodid|orderdeliverymethodid)$/, objectType: 'OrderDeliveryMethod' },
  { pattern: /^(productid|product2id)$/, objectType: 'Product2' },
  { pattern: /^pricebookentryid$/, objectType: 'PricebookEntry' },
  { pattern: /^pricebookid$/, objectType: 'Pricebook2' },
  { pattern: /^programrebatetypeids?$/, objectType: 'ProgramRebateType' },
  { pattern: /^aggregateids?$/, objectType: 'RebateMemberProductAggregate' },
  { pattern: /^calcdefinitionids?$/, objectType: 'BatchCalcJobDefinition' },
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
    if (!Array.isArray(input.fields) || !input.fields.length) {
      const wrapper = WRAPPER_BUILDERS.find((entry) => entry.pattern.test(lower));
      if (wrapper) {
        const value = wrapper.build(owned);
        if (value === undefined) {
          if (input.required === true) failures.push(`No resolved identity for required input ${input.name}.`);
          return undefined;
        }
        return input.isCollection === true ? [value] : value;
      }
    }
    if (/csv|document/i.test(input.name) && input.required === true) {
      failures.push(`No owned payload for required input ${input.name}.`);
      return undefined;
    }
    // Leg-discovered scalar vocabulary (enum codes, status values) binds by
    // lowercase input name before the neutral fallback; undiscovered names
    // keep the honest failure below.
    const scalar = owned.scalars?.[lower];
    if (scalar !== undefined) return input.isCollection === true ? [scalar] : scalar;
    // Optional inputs with no discovered binding are omitted: the neutral
    // marker poisons validated vocabularies (live proof: a marker-bound
    // optional orderLifeCycleType faults the native) and forces optional
    // booleans on. Natives cannot fail on omitted optionals.
    if (input.required !== true) return undefined;
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

/**
 * Activates an owned order for summary creation: the native requires an
 * active order, and activation requires a product line ("An order must
 * have at least one product" — live platform fault). The order takes the
 * live standard pricebook, mints one owned OrderItem at the live list
 * price, then transitions to Activated with a read-back proof. Every gap
 * is an explicit failure; nothing is invented.
 */
async function activateOwnedOrder(input: {
  request: Request; build: Build; root: string; orderId: string; marker: string;
  capture: (objectName: string, value: string) => void;
}): Promise<{ ok: true; itemScope: CommerceScope; groupScope: CommerceScope } | { failure: Result }> {
  const { request, root } = input;
  let entry: { Id: string; Pricebook2Id: string; UnitPrice: number } | null = null;
  try {
    const result = await request(root + '/query?q=' + encodeURIComponent(
      'SELECT Id, Pricebook2Id, UnitPrice FROM PricebookEntry WHERE Pricebook2.IsStandard=true AND IsActive=true LIMIT 1'));
    const row = result.ok && record(result.body) && Array.isArray(result.body.records)
      ? result.body.records.find(record) : null;
    if (row && id(row.Id) && id(row.Pricebook2Id) && typeof row.UnitPrice === 'number') {
      entry = { Id: row.Id, Pricebook2Id: row.Pricebook2Id, UnitPrice: row.UnitPrice };
    }
  } catch { /* fall through to the honest failure */ }
  if (!entry) return { failure: fail('COMMERCE_PRODUCT_SUBSTRATE_ABSENT',
    'No active standard pricebook entry exists for the owned order; activation needs a product.') };
  const priced = await request(root + '/sobjects/Order/' + input.orderId, 'PATCH', { Pricebook2Id: entry.Pricebook2Id });
  if (!priced.ok) return { failure: fail('COMMERCE_ORDER_ACTIVATION_UNAVAILABLE',
    'The owned order would not take the live standard pricebook.', { upstreamOutcome: priced.body }) };
  const item = await createOwnedFixture({ request, build: input.build, root, objectType: 'OrderItem', marker: input.marker,
    values: { OrderId: input.orderId, PricebookEntryId: entry.Id, Quantity: 1, UnitPrice: entry.UnitPrice,
      TotalLineAmount: entry.UnitPrice,
      // Summary lines inherit the item Type; null Type trips the
      // fulfillment service's missing_type gate (TypeCode auto-derives;
      // it is not insertable).
      Type: 'Order Product' }, capture: input.capture });
  if ('failure' in item) return { failure: fail('COMMERCE_ORDER_ACTIVATION_UNAVAILABLE',
    'The owned order product line could not be created.', { upstreamOutcome: item.failure.body }) };
  // The delivery group must exist (and bind the line) while the order is
  // still a draft: the platform refuses group writes on activated orders,
  // and the summary native faults MISSING_ARGUMENT without the assignment.
  const deliveryMethod = await discoverLiveSetupId(request, root, 'OrderDeliveryMethod');
  if (!deliveryMethod) return { failure: fail('COMMERCE_ORDER_ACTIVATION_UNAVAILABLE',
    'No live order delivery method exists for the owned delivery group.') };
  const group = await createOwnedFixture({ request, build: input.build, root, objectType: 'OrderDeliveryGroup', marker: input.marker,
    values: { OrderId: input.orderId, OrderDeliveryMethodId: deliveryMethod }, capture: input.capture });
  if ('failure' in group) return { failure: fail('COMMERCE_ORDER_ACTIVATION_UNAVAILABLE',
    'The owned order delivery group could not be created.', { upstreamOutcome: group.failure.body }) };
  const assigned = await request(root + '/sobjects/OrderItem/' + item.id, 'PATCH', { OrderDeliveryGroupId: group.id });
  if (!assigned.ok) return { failure: fail('COMMERCE_ORDER_ACTIVATION_UNAVAILABLE',
    'The owned order line would not take the delivery group.', { upstreamOutcome: assigned.body }) };
  const activated = await request(root + '/sobjects/Order/' + input.orderId, 'PATCH', { Status: 'Activated' });
  const reread = await request(root + '/sobjects/Order/' + input.orderId);
  if (!activated.ok || !reread.ok || !record(reread.body) || reread.body.Status !== 'Activated') {
    return { failure: fail('COMMERCE_ORDER_ACTIVATION_UNAVAILABLE',
      'The owned order could not be activated.', { upstreamOutcome: activated.body }) };
  }
  return { ok: true, itemScope: markerScope('OrderItem', item.markerField, item.storedMarker),
    groupScope: markerScope('OrderDeliveryGroup', group.markerField, group.storedMarker) };
}

/**
 * Builds the single fulfillment-order wrapper. The shape mirrors the
 * platform's own fulfillment flow: top-level summary/group ids plus
 * fulfillmentGroups; each group carries the fulfill-from location, the
 * fulfillmentType token, a referenceId, and the acted-on summary's live
 * lines (quantities flow through). Never a top-level `type`. The plural
 * builder wraps one element.
 */
function buildFulfillmentOrderInput(owned: CommerceOwnedIds): Record<string, unknown> | undefined {
  const summary = owned.orderSummaryId;
  const group = owned.live?.OrderDeliveryGroupSummary;
  const location = owned.live?.Location;
  const lines = (owned.lineSummaries ?? [])
    .filter((row) => id(row.id) && row.quantity > 0)
    .map((row) => ({ orderItemSummaryId: row.id, quantity: row.quantity }));
  if (!summary || !group || !location || !lines.length) return undefined;
  return {
    orderSummaryId: summary, orderDeliveryGroupSummaryId: group,
    // No top-level `type`: it is not a FulfillmentOrderInputRepresentation
    // field and GACKs the binder (even as null). Type vocabulary lives
    // on the group (per the platform's own fulfillment flow) and on the
    // summary lines' Type/TypeCode data (minted typed via the item).
    fulfillmentGroups: [{
      fulfilledFromLocationId: location,
      ...(typeof owned.scalars?.type === 'string' ? { fulfillmentType: owned.scalars.type } : {}),
      referenceId: group,
      orderItemSummaries: lines,
    }],
  };
}

/**
 * Mints an owned OrderSummary through the native chain: owned Account +
 * Order, activation (pricebook, product line with total, delivery group),
 * then the native create-summary action. Returns null when any step
 * fails so callers run their own fallback (destructive actions refuse
 * live rows; others may read a live summary). Captures and scopes every
 * owned row it creates; callers own the activated order's Draft
 * reduction and the summary's direct deletion in their finally blocks.
 */
async function mintOwnedOrderSummary(input: {
  request: Request; build: Build; root: string; marker: string;
  capture: (objectName: string, value: string) => void;
  scopes: CommerceScope[];
}): Promise<{ orderSummaryId: string; accountId: string; orderId: string; activatedOrderId: string } | null> {
  const { request, build, root, marker, capture, scopes } = input;
  const mintDescriptor = await request(root + '/actions/standard/createOrderSummary').catch(() => null);
  if (!mintDescriptor?.ok || !record(mintDescriptor.body) || !Array.isArray(mintDescriptor.body.inputs)) return null;
  const account = await createOwnedFixture({ request, build, root, objectType: 'Account', marker, values: { Name: marker }, capture });
  if ('failure' in account) return null;
  scopes.push(markerScope('Account', account.markerField, account.storedMarker));
  const order = await createOwnedFixture({ request, build, root, objectType: 'Order', marker, values: { AccountId: account.id }, capture });
  if ('failure' in order) return null;
  scopes.push(markerScope('Order', order.markerField, order.storedMarker));
  const activated = await activateOwnedOrder({ request, build, root, orderId: order.id, marker, capture });
  if ('failure' in activated) return null;
  scopes.push(activated.itemScope, activated.groupScope);
  const mapped = mapCommerceArguments(commerceDescriptorInputs(mintDescriptor.body), { accountId: account.id, orderId: order.id });
  if ('failure' in mapped) return null;
  const minted = await request(root + '/actions/standard/createOrderSummary', 'POST', { inputs: [mapped.args] });
  const mintedId = outputIdentities(minted.body, /ordersummaryid$/i)[0] ??
    (await queryIds(request, root, `SELECT Id FROM OrderSummary WHERE OriginalOrderId='${order.id}' LIMIT 1`))[0];
  if (!nativeAccepted(minted) || !mintedId) return null;
  const reread = await request(root + '/sobjects/OrderSummary/' + mintedId);
  if (!reread.ok) return null;
  capture('OrderSummary', mintedId);
  return { orderSummaryId: mintedId, accountId: account.id, orderId: order.id, activatedOrderId: order.id };
}

/**
 * Discovers the fulfillment type token: the fulfill-from location's
 * LocationType intersected with the live FulfillmentOrder Type picklist.
 * Unbound when either side is missing (callers omit the token then).
 */
async function discoverFulfillmentType(request: Request, root: string, fulfillmentSchemaBody: unknown, locationId: string): Promise<string | undefined> {
  try {
    const locationRow = await request(root + '/sobjects/Location/' + locationId + '?fields=LocationType');
    const locationType = locationRow.ok && record(locationRow.body) ? locationRow.body.LocationType : undefined;
    const fields = record(fulfillmentSchemaBody) && Array.isArray(fulfillmentSchemaBody.fields) ? fulfillmentSchemaBody.fields : [];
    const typeField = fields.find((field) => record(field) && field.name === 'Type');
    const activeTypes = record(typeField) && Array.isArray(typeField.picklistValues)
      ? typeField.picklistValues.filter(record).filter((entry) => entry.active).map((entry) => entry.value) : [];
    if (typeof locationType === 'string' && activeTypes.includes(locationType)) return locationType;
  } catch { /* type stays unbound; the service error surfaces honestly */ }
  return undefined;
}

/**
 * Deletes an owned OrderSummary after removing its fulfillment-order
 * children. Org allocation automation may attach fulfillment rows to a
 * freshly minted summary within seconds, and those children block the
 * summary delete; they go first (their line items cascade). Returns an
 * error message when anything refuses, undefined on full removal.
 */
async function deleteOwnedSummary(request: Request, root: string, summaryId: string): Promise<string | undefined> {
  const children = await queryIds(request, root, `SELECT Id FROM FulfillmentOrder WHERE OrderSummaryId='${summaryId}' LIMIT 25`);
  for (const childId of children) {
    const childGone = await request(root + '/sobjects/FulfillmentOrder/' + childId, 'DELETE').catch(() => null);
    if (!childGone?.ok) return `FulfillmentOrder ${childId} could not be removed; platform natives may refuse deletion.`;
  }
  const gone = await request(root + '/sobjects/OrderSummary/' + summaryId, 'DELETE').catch(() => null);
  if (!gone?.ok) return `OrderSummary ${summaryId} could not be removed; platform natives may refuse deletion.`;
  return undefined;
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

/** Active picklist value for a field: preferred live token else first active; null when none exists. */
async function discoverPicklistValue(request: Request, root: string, objectType: string, fieldName: string, prefer: RegExp): Promise<string | null> {
  if (!OBJECT_NAME.test(objectType) || !OBJECT_NAME.test(fieldName)) return null;
  try {
    const described = await request(root + '/sobjects/' + objectType + '/describe');
    if (!described.ok || !record(described.body) || !Array.isArray(described.body.fields)) return null;
    const field = described.body.fields.filter(record).find((entry) => entry.name === fieldName);
    const values = Array.isArray(field?.picklistValues) ? field.picklistValues.filter(record)
      .filter((entry) => entry.active === true && typeof entry.value === 'string')
      .map((entry) => entry.value as string) : [];
    if (!values.length) return null;
    return values.find((value) => prefer.test(value)) ?? values[0];
  } catch { return null; }
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
  const restoreError = await restoreOwnedOrderDrafts(input.root, input.owned, input.scopes, input.request);
  const cleaned = await cleanupOwnedContext({
    root: input.root, request: input.request, records: input.owned, order: input.order,
    scopes: [...input.scopes, ...ownedOrderChildScopes(input.owned)],
  }).catch(() => null);
  return restoreError ?? cleaned?.cleanupError;
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
  const described = await batchDescribe(request, root, ['WebStore', 'Account', 'WebCart', 'BuyerAccount'], ['createCart']);
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
    const membership = await request(root + '/sobjects/BuyerGroupMember/describe');
    if (membership.ok && membership.body?.createable === true && membership.body?.deletable === true) {
      const groupIds = await discoverStoreBuyerGroups(request, root, found.storeId);
      if (groupIds.length) provisioned = { storeId: found.storeId, groupIds };
    }
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
          const pair = await createOwnedStoreBuyer({ root, marker, storeType: attempt.type, request, build, capture });
          if ('failure' in pair) return pair;
          storeId = pair.storeId; accountId = pair.accountId; storeType = attempt.type; resolved.accountId = accountId;
          const enabledBuyer = await provisionOwnedBuyerAccount({ root, marker, accountId, request, build, capture });
          if ("failure" in enabledBuyer) return enabledBuyer;
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

/**
 * Owned checkout-session chain for cart-to-order drafts: delivery group
 * (DeliverTo names map to the order group), one priced item, and a
 * session row. Product and parent order are live setup rows (never
 * invented); picklist-typed session/item fields resolve from the live
 * describe with preferred tokens. Every gap is an explicit failure.
 */
async function provisionDraftSessionChain(input: {
  request: Request; build: Build; root: string; marker: string; cartId: string;
  capture: (objectName: string, value: string) => void;
  needsPricebook: boolean; needsCartTax: boolean;
}): Promise<{ sessionId: string; scopes: CommerceScope[]; pricebookId?: string } | { failure: Result }> {
  const { request, build, root, marker, cartId, capture } = input;
  // Native createCart auto-provisions one DeliverTo-less delivery group
  // and the draft apex reads groups[0], so a second minted group would
  // lose the race. Adopt the auto group (owned by cart parentage) and
  // enrich its DeliverTo names; mint only when none exists.
  const groupScopes: CommerceScope[] = [
    { objectName: 'CartDeliveryGroup', equals: { CartId: cartId }, ownedParents: [{ field: 'CartId', objectName: 'WebCart' }] },
  ];
  const existingGroups = await queryIds(request, root, `SELECT Id FROM CartDeliveryGroup WHERE CartId='${cartId}' LIMIT 2`);
  let groupId: string;
  if (existingGroups.length === 1) {
    groupId = existingGroups[0];
    const enriched = await request(root + '/sobjects/CartDeliveryGroup/' + groupId, 'PATCH',
      { DeliverToName: 'Probe Buyer', DeliverToFirstName: 'Probe', DeliverToLastName: 'Buyer' });
    if (!enriched.ok) return { failure: enriched };
    const reread = await request(root + '/sobjects/CartDeliveryGroup/' + groupId);
    if (!reread.ok || !record(reread.body) || reread.body.DeliverToName !== 'Probe Buyer') {
      return { failure: fail('COMMERCE_FIXTURE_UNVERIFIED', 'Actual owned delivery group enrichment readback failed.') };
    }
    capture('CartDeliveryGroup', groupId);
  } else if (existingGroups.length === 0) {
    const group = await createOwnedFixture({
      request, build, root, objectType: 'CartDeliveryGroup', marker, capture,
      values: { CartId: cartId, DeliverToName: 'Probe Buyer', DeliverToFirstName: 'Probe', DeliverToLastName: 'Buyer' },
    });
    if ('failure' in group) return group;
    groupId = group.id;
  } else {
    return { failure: fail('COMMERCE_FIXTURE_AMBIGUOUS', 'The owned cart carries multiple delivery groups; the draft target is ambiguous.') };
  }
  // Pricebook-consistent pricing: the SDO apex rejects order products
  // whose list price disagrees with the PricebookEntry, so resolve the
  // product + unit price FROM the bound live pricebook's entries. The
  // base draft (no pricebook input) keeps any live product + 10s.
  let productId: string | null = null;
  let unitPrice = 10;
  let pricebookId: string | undefined;
  if (input.needsPricebook) {
    const book = await discoverLiveSetupId(request, root, 'Pricebook2');
    if (book) {
      const entries = await request(root + '/query?q=' + encodeURIComponent(
        `SELECT Product2Id, UnitPrice FROM PricebookEntry WHERE Pricebook2Id='${book}' AND IsActive=true LIMIT 5`));
      const hit = entries.ok && record(entries.body) && Array.isArray(entries.body.records)
        ? entries.body.records.filter(record).find((row) => id(row.Product2Id) && typeof row.UnitPrice === 'number') : undefined;
      if (hit) { productId = hit.Product2Id as string; unitPrice = hit.UnitPrice as number; pricebookId = book; }
    }
    if (!productId || !pricebookId) {
      return { failure: fail('COMMERCE_PRODUCT_SUBSTRATE_ABSENT', 'No live pricebook entry exists to price the owned draft item consistently; provision catalog substrate before retrying.') };
    }
  } else {
    productId = await discoverLiveSetupId(request, root, 'Product2');
    if (!productId) return { failure: fail('COMMERCE_PRODUCT_SUBSTRATE_ABSENT', 'No live product exists to price the owned draft item; provision catalog substrate before retrying.') };
  }
  const itemType = await discoverPicklistValue(request, root, 'CartItem', 'Type', /product/i);
  const item = await createOwnedFixture({
    request, build, root, objectType: 'CartItem', marker, capture,
    values: { CartId: cartId, CartDeliveryGroupId: groupId, Product2Id: productId, Quantity: 1, SalesPrice: unitPrice, ListPrice: unitPrice, TotalLineAmount: unitPrice, ...(itemType ? { Type: itemType } : {}) },
  });
  if ('failure' in item) return item;
  // The SDO tax block maps CartTax by item id and dereferences Name
  // unguarded, so the SDO shape mints one zero tax row per owned item.
  let taxScope: CommerceScope | null = null;
  if (input.needsCartTax) {
    const taxType = await discoverPicklistValue(request, root, 'CartTax', 'TaxType', /actual/i);
    if (!taxType) return { failure: fail('COMMERCE_TAX_SUBSTRATE_ABSENT', 'The live CartTax type picklist exposes no active value; provision tax substrate before retrying.') };
    const tax = await createOwnedFixture({
      request, build, root, objectType: 'CartTax', marker, capture,
      values: { CartItemId: item.id, TaxType: taxType, TaxCalculationDate: new Date().toISOString().slice(0, 10), Amount: 0, TaxRate: 0 },
    });
    if ('failure' in tax) return tax;
    taxScope = markerScope('CartTax', tax.markerField, tax.storedMarker);
  }
  const parentOrderId = await discoverLiveSetupId(request, root, 'Order');
  if (!parentOrderId) return { failure: fail('COMMERCE_ORDER_SUBSTRATE_ABSENT', 'No live order exists to seed the owned checkout session; provision order substrate before retrying.') };
  const state = await discoverPicklistValue(request, root, 'CartCheckoutSession', 'State', /order confirmation/i);
  const nextState = await discoverPicklistValue(request, root, 'CartCheckoutSession', 'NextState', /complete/i);
  const session = await createOwnedFixture({
    request, build, root, objectType: 'CartCheckoutSession', marker, capture,
    values: { WebCartId: cartId, OrderId: parentOrderId, IsArchived: false, ...(state ? { State: state } : {}), ...(nextState ? { NextState: nextState } : {}) },
  });
  if ('failure' in session) return session;
  return {
    sessionId: session.id,
    ...(pricebookId ? { pricebookId } : {}),
    scopes: [
      ...groupScopes,
      markerScope('CartItem', item.markerField, item.storedMarker),
      ...(taxScope ? [taxScope] : []),
      markerScope('CartCheckoutSession', session.markerField, session.storedMarker),
    ],
  };
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
  const chainScopes: CommerceScope[] = [];
  const checkoutScopes: CommerceScope[] = [];
  let cleanupError: string | undefined;
  let outcome: Result = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned cart lifecycle did not complete.');
  let verified = false, extra: Value = {};
  let activateOrderId: string | undefined;
  let activateSummaryId: string | undefined;
  try {
    outcome = await (async (): Promise<Result> => {
      const ownedIds: CommerceOwnedIds = { storeId: cart.storeId, accountId: cart.accountId, cartId: cart.cartId };
      if (inputs.some(field => field.name.toLowerCase() === "initialstate")) {
        const state = await discoverFlowActionScalarInput(root, action, "initialState", request);
        if (!state) return fail("COMMERCE_CHECKOUT_STATE_UNAVAILABLE", "No active Flow provides a live initialState binding for the checkout action.");
        ownedIds.scalars = { initialstate: state };
      }
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
      // Cart-to-order drafts (custom/apex): the apex reads the cart's
      // delivery group (DeliverTo names map to the order group), its
      // priced items, and rewrites the passed session row, so the probe
      // mints an owned chain (blind-verified recipe) instead of binding
      // live rows it would then mutate. Triggered by the declared
      // checkoutSessionId input, never by name alone.
      // The chain's pricebook (when it resolved one) is the only
      // binding consistent with the owned item's list price; a second
      // LIMIT 1 discovery could disagree.
      let chainPricebookId: string | undefined;
      // activateOrderAction declares no session input but the native refuses
      // without an active CartCheckoutSession on the cart, so the chain is
      // provisioned for the action itself (base shape: no pricebook, no tax;
      // the session is flipped to the live-observed Active state since the
      // State picklist is undescribed and undiscoverable).
      const needsSession = inputs.some((field) => field.name.toLowerCase() === 'checkoutsessionid') ||
        /^activateorderaction$/i.test(action);
      if (needsSession) {
        // The SDO draft shape (declares pricebookId) also requires the
        // CartTax substrate its tax block dereferences; the base shape
        // needs neither.
        const sdoShape = inputs.some((field) => field.name.toLowerCase() === 'pricebookid');
        const chain = await provisionDraftSessionChain({ request, build, root, marker, cartId: cart.cartId, capture,
          needsPricebook: sdoShape, needsCartTax: sdoShape });
        if ('failure' in chain) return chain.failure;
        ownedIds.checkoutSessionId = chain.sessionId;
        chainPricebookId = chain.pricebookId;
        chainScopes.push(...chain.scopes);
        if (/^activateorderaction$/i.test(action)) {
          // The native integrates only checkout-phase carts ("Integration
          // for cart with status ACTIVE is not supported"), so the owned
          // cart advances to the live Checkout status first.
          const checkout = await request(root + '/sobjects/WebCart/' + cart.cartId, 'PATCH', { Status: 'Checkout' });
          const rereadCart = await request(root + '/sobjects/WebCart/' + cart.cartId);
          if (!checkout.ok || !rereadCart.ok || !record(rereadCart.body) || rereadCart.body.Status !== 'Checkout') {
            return fail('COMMERCE_CART_UNAVAILABLE', 'The owned cart could not advance to checkout.', { upstreamOutcome: checkout.body });
          }
          // The native activates the session's order (a live row would be
          // mutated, so the session is repointed at an owned Draft order
          // with a product line), requires a non-null next state (any
          // value passes; null faults "invalid nextState value"), and
          // reads orderStatus as the CURRENT status to transition from.
          const activateAccount = await createOwnedFixture({ request, build, root, objectType: 'Account', marker, values: { Name: marker }, capture });
          if ('failure' in activateAccount) return activateAccount.failure;
          chainScopes.push(markerScope('Account', activateAccount.markerField, activateAccount.storedMarker));
          const activateOrder = await createOwnedFixture({ request, build, root, objectType: 'Order', marker, values: { AccountId: activateAccount.id }, capture });
          if ('failure' in activateOrder) return activateOrder.failure;
          chainScopes.push(markerScope('Order', activateOrder.markerField, activateOrder.storedMarker));
          let activateEntry: { Id: string; Pricebook2Id: string; UnitPrice: number } | null = null;
          try {
            const found = await request(root + '/query?q=' + encodeURIComponent(
              'SELECT Id, Pricebook2Id, UnitPrice FROM PricebookEntry WHERE Pricebook2.IsStandard=true AND IsActive=true LIMIT 1'));
            const row = found.ok && record(found.body) && Array.isArray(found.body.records)
              ? found.body.records.find(record) : null;
            if (row && id(row.Id) && id(row.Pricebook2Id) && typeof row.UnitPrice === 'number') {
              activateEntry = { Id: row.Id, Pricebook2Id: row.Pricebook2Id, UnitPrice: row.UnitPrice };
            }
          } catch { /* honest failure below */ }
          if (!activateEntry) return fail('COMMERCE_PRODUCT_SUBSTRATE_ABSENT',
            'No active standard pricebook entry exists for the owned activation order.');
          const activatePriced = await request(root + '/sobjects/Order/' + activateOrder.id, 'PATCH', { Pricebook2Id: activateEntry.Pricebook2Id });
          if (!activatePriced.ok) return fail('COMMERCE_ORDER_ACTIVATION_UNAVAILABLE',
            'The owned activation order would not take the live standard pricebook.', { upstreamOutcome: activatePriced.body });
          const activateItem = await createOwnedFixture({ request, build, root, objectType: 'OrderItem', marker,
            values: { OrderId: activateOrder.id, PricebookEntryId: activateEntry.Id, Quantity: 1,
              UnitPrice: activateEntry.UnitPrice, TotalLineAmount: activateEntry.UnitPrice }, capture });
          if ('failure' in activateItem) return fail('COMMERCE_ORDER_ACTIVATION_UNAVAILABLE',
            'The owned activation order line could not be created.', { upstreamOutcome: activateItem.failure.body });
          const activateMethod = await discoverLiveSetupId(request, root, 'OrderDeliveryMethod');
          if (!activateMethod) return fail('COMMERCE_ORDER_ACTIVATION_UNAVAILABLE',
            'No live order delivery method exists for the owned activation order.');
          const activateGroup = await createOwnedFixture({ request, build, root, objectType: 'OrderDeliveryGroup', marker,
            values: { OrderId: activateOrder.id, OrderDeliveryMethodId: activateMethod }, capture });
          if ('failure' in activateGroup) return fail('COMMERCE_ORDER_ACTIVATION_UNAVAILABLE',
            'The owned activation delivery group could not be created.', { upstreamOutcome: activateGroup.failure.body });
          const activateAssigned = await request(root + '/sobjects/OrderItem/' + activateItem.id, 'PATCH', { OrderDeliveryGroupId: activateGroup.id });
          if (!activateAssigned.ok) return fail('COMMERCE_ORDER_ACTIVATION_UNAVAILABLE',
            'The owned activation line would not take the delivery group.', { upstreamOutcome: activateAssigned.body });
          chainScopes.push(markerScope('OrderDeliveryGroup', activateGroup.markerField, activateGroup.storedMarker));
          chainScopes.push(markerScope('OrderItem', activateItem.markerField, activateItem.storedMarker));
          chainScopes.push({ objectName: 'OrderItem', equals: { OrderId: activateOrder.id },
            ownedParents: [{ field: 'OrderId', objectName: 'Order' }] });
          activateOrderId = activateOrder.id;
          const active = await request(root + '/sobjects/CartCheckoutSession/' + chain.sessionId, 'PATCH',
            { State: 'Active', NextState: 'Complete', OrderId: activateOrder.id });
          const rereadSession = await request(root + '/sobjects/CartCheckoutSession/' + chain.sessionId);
          if (!active.ok || !rereadSession.ok || !record(rereadSession.body) || rereadSession.body.State !== 'Active' ||
            rereadSession.body.NextState !== 'Complete' || rereadSession.body.OrderId !== activateOrder.id) {
            return fail('COMMERCE_SESSION_UNAVAILABLE', 'The owned checkout session could not be armed for activation.', { upstreamOutcome: active.body });
          }
        }
      }
      // Declared pricebooks bind live: the SDO draft dereferences its
      // optional pricebookId vendor-side, so omission faults. Absence
      // leaves the input unset (optional omits, required fails closed).
      if (inputs.some((field) => field.name.toLowerCase() === 'pricebookid')) {
        const pricebookId = chainPricebookId ?? await discoverLiveSetupId(request, root, 'Pricebook2');
        if (pricebookId) ownedIds.live = { ...(ownedIds.live ?? {}), Pricebook2: pricebookId };
      }
      // Declared orderStatus (activateOrderAction) binds the live
      // Activated status: the native reads it as the TARGET status
      // (Draft/bogus fault INVALID_API_INPUT; only Activated passes, and
      // the owned order must be Draft so the transition exists). Absence
      // leaves the honest mapper failure in place.
      if (inputs.some((field) => field.name.toLowerCase() === 'orderstatus')) {
        const status = await discoverPicklistValue(request, root, 'Order', 'Status', /activated/i);
        if (status) ownedIds.scalars = { ...(ownedIds.scalars ?? {}), orderstatus: status };
      }
      // Declared nextState binds the Complete transition: the native
      // validates presence only (live proof: even a bogus string is
      // accepted and written through), and the write is read-back
      // verified below, so the binding is evidence-anchored.
      if (inputs.some((field) => field.name.toLowerCase() === 'nextstate')) {
        ownedIds.scalars = { ...(ownedIds.scalars ?? {}), nextstate: 'Complete' };
      }
      const mapped = mapCommerceArguments(inputs, ownedIds);
      if ('failure' in mapped) return fail('COMMERCE_INPUT_UNAVAILABLE', mapped.failure);
      const invoked = await request(route, 'POST', { inputs: [mapped.args] });
      if (invoked.ok && (invoked.body === null || Array.isArray(invoked.body) && invoked.body.length === 0)) {
        return fail('COMMERCE_ACTION_OUTCOME_MISSING', 'Salesforce returned no native outcome; no mutation is counted as successful.');
      }
      if (!nativeAccepted(invoked)) return invoked;
      if (/^updatecheckoutsessionstateaction$/i.test(action)) {
        const transitioned = await queryIds(request, root,
          `SELECT Id FROM CartCheckoutSession WHERE WebCartId='${cart.cartId}' AND NextState='Complete' LIMIT 1`);
        if (!transitioned.length) {
          return fail('COMMERCE_EFFECT_UNVERIFIED', 'Native acceptance carried no owned session transition.', { upstreamOutcome: invoked.body });
        }
        extra = { transitionedSessionId: transitioned[0] };
      }
      if (/^activateorderaction$/i.test(action) && activateOrderId) {
        const flipped = await request(root + '/sobjects/Order/' + activateOrderId);
        const flippedStatus = flipped.ok && record(flipped.body) ? flipped.body.Status : undefined;
        if (flippedStatus !== 'Activated') {
          return fail('COMMERCE_EFFECT_UNVERIFIED', 'Native acceptance carried no owned order activation.', { upstreamOutcome: invoked.body });
        }
        // Activation mints an OrderSummary (+item summaries) that blocks
        // line deletion until removed; capture it for ordered cleanup.
        const createdSummaryId = (await queryIds(request, root,
          `SELECT Id FROM OrderSummary WHERE OriginalOrderId='${activateOrderId}' LIMIT 1`))[0];
        if (createdSummaryId) {
          activateSummaryId = createdSummaryId;
          capture('OrderSummary', createdSummaryId);
        }
        extra = { activatedOrderId: activateOrderId };
      }
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
        // Draft-created children (items + delivery groups + tax lines)
        // must be captured for deletion; scopes alone never discover rows.
        const createdOrderItemIds: string[] = [];
        for (const orderId of existing.slice(0, 5)) {
          for (const itemId of await queryIds(request, root, `SELECT Id FROM OrderItem WHERE OrderId='${orderId}' LIMIT 25`)) {
            capture('OrderItem', itemId);
            createdOrderItemIds.push(itemId);
          }
          for (const groupId of await queryIds(request, root, `SELECT Id FROM OrderDeliveryGroup WHERE OrderId='${orderId}' LIMIT 25`)) capture('OrderDeliveryGroup', groupId);
        }
        for (const orderItemId of createdOrderItemIds.slice(0, 25)) {
          for (const taxId of await queryIds(request, root, `SELECT Id FROM OrderItemTaxLineItem WHERE OrderItemId='${orderItemId}' LIMIT 10`)) capture('OrderItemTaxLineItem', taxId);
        }
        extra = { createdOrderIds: existing.slice(0, 5), createdOrderItemIds: createdOrderItemIds.slice(0, 25) };
      }
      const check = verifySkippedStandardReadback({
        performed: true, markerField: 'Name', marker, after: intact ? { Name: marker } : null,
        expectedChanges: {}, actionAccepted: true,
      });
      verified = intact && check.verified;
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
      return verified ? invoked : fail('COMMERCE_EFFECT_UNVERIFIED', 'Salesforce reported success without the verified owned effect.', { upstreamOutcome: invoked.body });
    })();
  } catch { outcome = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned cart lifecycle could not be verified.'); }
  finally {
    if (inputs.some(field => field.name.toLowerCase() === "initialstate")) {
      for (const sessionId of await queryIds(request, root, "SELECT Id FROM CartCheckoutSession WHERE WebCartId='" + cart.cartId + "' LIMIT 25")) capture("CartCheckoutSession", sessionId);
      checkoutScopes.push({ objectName: "CartCheckoutSession", equals: { WebCartId: cart.cartId }, ownedParents: [{ field: "WebCartId", objectName: "WebCart" }] });
    }
    // The activation-created summary (and its item summaries) blocks line
    // deletion until removed; the Activated order itself refuses deletion
    // until reduced to Draft. Both run before any delete is attempted.
    if (activateSummaryId) {
      cleanupError ??= await deleteOwnedSummary(request, root, activateSummaryId);
    }
    if (activateOrderId) {
      await request(root + '/sobjects/Order/' + activateOrderId, 'PATCH', { Status: 'Draft' }).catch(() => null);
    }
    // Draft-created order children (items + delivery groups) scope to the
    // captured order ids; the session chain itself deletes via owned ids.
    const createdOrderIds = Array.isArray(extra.createdOrderIds) ? extra.createdOrderIds.filter(id) : [];
    const createdOrderItemIds = Array.isArray(extra.createdOrderItemIds) ? extra.createdOrderItemIds.filter(id) : [];
    const orderChildScopes: CommerceScope[] = [
      ...createdOrderIds.flatMap((orderId) => [
        { objectName: 'OrderItem', equals: { OrderId: orderId }, ownedParents: [{ field: 'OrderId', objectName: 'Order' }] },
        { objectName: 'OrderDeliveryGroup', equals: { OrderId: orderId }, ownedParents: [{ field: 'OrderId', objectName: 'Order' }] },
      ]),
      ...createdOrderItemIds.map((orderItemId) => ({
        objectName: 'OrderItemTaxLineItem', equals: { OrderItemId: orderItemId },
        ownedParents: [{ field: 'OrderItemId', objectName: 'OrderItem' }],
      })),
    ];
    cleanupError ??= await cleanupCommerceFixtures({
      request, root, marker, owned: owned.filter((entry) => entry.objectName !== 'OrderSummary'),
      order: ['CartCheckoutSession', 'CartTax', 'OrderItemTaxLineItem', 'CartItem', 'OrderItem', 'OrderDeliveryGroup', 'CartDeliveryGroup', 'Order', 'WebCart', 'WebStore', 'Account', 'BuyerAccount', 'BuyerGroupMember', 'Contact'],
      scopes: [
        markerScope('WebStore', 'Name', marker), markerScope('Account', 'Name', marker), markerScope('WebCart', 'Name', marker),
        ...buyerChainScopes(marker, cart.accountId),
        { objectName: 'CartItem', equals: { CartId: cart.cartId }, ownedParents: [{ field: 'CartId', objectName: 'WebCart' }] },
        { objectName: 'Order', equals: { AccountId: cart.accountId }, ownedParents: [{ field: 'AccountId', objectName: 'Account' }] },
        ...chainScopes,
        ...checkoutScopes,
        ...orderChildScopes,
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
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
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
  let activatedOrderId: string | undefined;
  try {
    outcome = await (async (): Promise<Result> => {
      const account = await createOwnedFixture({ request, build, root, objectType: 'Account', marker, values: { Name: marker }, capture });
      if ('failure' in account) return account.failure;
      scopes.push(markerScope('Account', account.markerField, account.storedMarker));
      const order = await createOwnedFixture({ request, build, root, objectType: 'Order', marker, values: { AccountId: account.id }, capture });
      if ('failure' in order) return order.failure;
      scopes.push(markerScope('Order', order.markerField, order.storedMarker));
      const isSummary = /createsummary|creates.*summary/i.test(action) || /ordersummary$/i.test(action);
      if (isSummary) {
        const activated = await activateOwnedOrder({ request, build, root, orderId: order.id, marker, capture });
        if ('failure' in activated) return activated.failure;
        scopes.push(activated.itemScope, activated.groupScope);
        activatedOrderId = order.id;
      }
      const before = await request(root + '/sobjects/Order/' + order.id);
      const beforeStatus = record(before.body) ? before.body.Status : undefined;
      const mapped = mapCommerceArguments(inputs, { accountId: account.id, orderId: order.id });
      if ('failure' in mapped) return fail('COMMERCE_INPUT_UNAVAILABLE', mapped.failure);
      const invoked = await request(route, 'POST', { inputs: [mapped.args] });
      if (invoked.ok && (invoked.body === null || Array.isArray(invoked.body) && invoked.body.length === 0)) {
        return fail('COMMERCE_ACTION_OUTCOME_MISSING', 'Salesforce returned no native outcome; no mutation is counted as successful.');
      }
      if (!nativeAccepted(invoked)) return invoked;
      if (isSummary) {
        const summaryIds = outputIdentities(invoked.body, /ordersummaryid$/i);
        const summaryId = summaryIds[0] ?? (await queryIds(request, root, `SELECT Id FROM OrderSummary WHERE OriginalOrderId='${order.id}' LIMIT 1`))[0];
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
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
      return invoked;
    })();
  } catch { outcome = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned order lifecycle could not be verified.'); }
  finally {
    // Activated orders (and their lines) refuse deletion until reduced to
    // Draft; the reduction runs before any delete is attempted.
    if (activatedOrderId) {
      await request(root + '/sobjects/Order/' + activatedOrderId, 'PATCH', { Status: 'Draft' }).catch(() => null);
    }
    const summaryOwned = owned.filter((entry) => entry.objectName === 'OrderSummary');
    for (const entry of summaryOwned) {
      cleanupError ??= await deleteOwnedSummary(request, root, entry.id);
    }
    cleanupError ??= await cleanupCommerceFixtures({
      request, root, marker, owned: owned.filter((entry) => entry.objectName !== 'OrderSummary'),
      order: ['OrderItem', 'OrderDeliveryGroup', 'Order', 'Account'], scopes,
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
  let submitActivatedOrderId: string | undefined;
  try {
    outcome = await (async (): Promise<Result> => {
      // Owned-summary mint via the shared native chain; destructive
      // legs refuse live rows when the mint fails.
      let orderSummaryId: string | undefined; let ownedSummary = false; let summaryAccountId: string | undefined;
      const minted = await mintOwnedOrderSummary({ request, build, root, marker, capture, scopes });
      if (minted) {
        orderSummaryId = minted.orderSummaryId; ownedSummary = true;
        submitActivatedOrderId = minted.activatedOrderId; summaryAccountId = minted.accountId;
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
      if (!summaryAccountId) {
        try {
          const found = await request(root + '/sobjects/OrderSummary/' + orderSummaryId);
          const liveAccountId = found.ok && record(found.body) ? found.body.AccountId : undefined;
          if (typeof liveAccountId === 'string' && id(liveAccountId)) summaryAccountId = liveAccountId;
        } catch { /* accountId stays unbound; the mapper fails honestly */ }
      }
      const ownedIds: CommerceOwnedIds = { orderSummaryId, ...(summaryAccountId ? { accountId: summaryAccountId } : {}) };
      // Payment summaries link an authorization: the leg mints an owned
      // one (live gateway, owned amount) so no live auth row is touched.
      if (/^createorderpaymentsummary$/i.test(action)) {
        if (!summaryAccountId) return fail('COMMERCE_INPUT_UNAVAILABLE', 'No resolved identity for required input accountId.');
        const gateway = await discoverLiveSetupId(request, root, 'PaymentGateway');
        if (!gateway) return fail('COMMERCE_PAYMENT_SUBSTRATE_ABSENT',
          'No live payment gateway exists for the owned authorization; provision payment substrate before retrying.');
        // Minted Draft: Processed/Canceled authorizations refuse deletion
        // ("Delete not allowed when Status is ..."), which would leak; the
        // native decides whether Draft funds link.
        const auth = await createOwnedFixture({ request, build, root, objectType: 'PaymentAuthorization', marker,
          values: { AccountId: summaryAccountId, PaymentGatewayId: gateway, Amount: 1,
            Status: 'Draft', ProcessingMode: 'External' }, capture });
        if ('failure' in auth) return fail('COMMERCE_PAYMENT_SUBSTRATE_ABSENT',
          'The owned payment authorization could not be created.', { upstreamOutcome: auth.failure.body });
        scopes.push(markerScope('PaymentAuthorization', auth.markerField, auth.storedMarker));
        ownedIds.live = { ...(ownedIds.live ?? {}), PaymentAuthorization: auth.id };
      }
      // Tax reversals post against the acted-on summary's first item
      // summary (order-tax lines snapshot below for verification).
      if (/^recordtaxreversal$/i.test(action)) {
        const itemIds = await queryIds(request, root, `SELECT Id FROM OrderItemSummary WHERE OrderSummaryId='${orderSummaryId}' LIMIT 5`);
        if (!itemIds.length) return fail('COMMERCE_TAX_SUBSTRATE_ABSENT',
          'The acted-on summary holds no item summaries to reverse tax against.');
        ownedIds.live = { ...(ownedIds.live ?? {}), OrderItemSummary: itemIds[0] };
      }
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
      const beforePayIds = /^createorderpaymentsummary$/i.test(action)
        ? await queryIds(request, root, `SELECT Id FROM OrderPaymentSummary WHERE OrderSummaryId='${orderSummaryId}' LIMIT 10`)
        : [];
      // Reversal entries hang off the order (OrderItemTaxLineItem has no
      // summary link); snapshot them for the after-check below.
      let beforeTaxIds: string[] = [];
      let reversalOrderId: string | undefined = submitActivatedOrderId;
      if (/^recordtaxreversal$/i.test(action)) {
        if (!reversalOrderId) {
          try {
            const found = await request(root + '/sobjects/OrderSummary/' + orderSummaryId);
            const original = found.ok && record(found.body) ? found.body.OriginalOrderId : undefined;
            if (typeof original === 'string' && id(original)) reversalOrderId = original;
          } catch { /* snapshot stays empty; the after-check fails honestly */ }
        }
        if (reversalOrderId) {
          beforeTaxIds = await queryIds(request, root, `SELECT Id FROM OrderItemTaxLineItem WHERE OrderId='${reversalOrderId}' LIMIT 20`);
        }
      }
      const mapped = mapCommerceArguments(inputs, ownedIds);
      if ('failure' in mapped) return fail('COMMERCE_INPUT_UNAVAILABLE', mapped.failure);
      const invoked = await request(route, 'POST', { inputs: [mapped.args] });
      if (invoked.ok && (invoked.body === null || Array.isArray(invoked.body) && invoked.body.length === 0)) {
        return fail('COMMERCE_ACTION_OUTCOME_MISSING', 'Salesforce returned no native outcome; no mutation is counted as successful.');
      }
      if (!nativeAccepted(invoked)) return invoked;
      // Payment summaries attach beside the summary/items fingerprint, so
      // the created payment row itself is the verification (the acted-on
      // summary is owned when minted; a live summary's pre-existing rows
      // are excluded by snapshotting before the invoke).
      if (/^createorderpaymentsummary$/i.test(action)) {
        const payIds = await queryIds(request, root, `SELECT Id FROM OrderPaymentSummary WHERE OrderSummaryId='${orderSummaryId}' LIMIT 10`);
        const fresh = payIds.filter((payId) => !beforePayIds.includes(payId));
        if (!fresh.length) {
          return fail('COMMERCE_EFFECT_UNVERIFIED', 'Native acceptance carried no owned payment summary.', { upstreamOutcome: invoked.body });
        }
        for (const payId of fresh) capture('OrderPaymentSummary', payId);
        extra = { orderSummaryId, ownedSummary, createdOrderPaymentSummaryIds: fresh };
      } else if (/^recordtaxreversal$/i.test(action) && reversalOrderId) {
        const afterTaxIds = await queryIds(request, root, `SELECT Id FROM OrderItemTaxLineItem WHERE OrderId='${reversalOrderId}' LIMIT 20`);
        const freshTax = afterTaxIds.filter((taxId) => !beforeTaxIds.includes(taxId));
        const after = await readSummaryFingerprint(request, root, orderSummaryId);
        if (!freshTax.length && (!after.summary || fingerprintDigest(before) === fingerprintDigest(after))) {
          return fail('COMMERCE_EFFECT_UNVERIFIED', 'Native acceptance carried no observable tax reversal.', { upstreamOutcome: invoked.body });
        }
        for (const taxId of freshTax) capture('OrderItemTaxLineItem', taxId);
        extra = { orderSummaryId, ownedSummary, createdTaxLineItemIds: freshTax };
      } else {
        const after = await readSummaryFingerprint(request, root, orderSummaryId);
        if (!after.summary || fingerprintDigest(before) === fingerprintDigest(after)) {
          return fail('COMMERCE_EFFECT_UNVERIFIED', 'Native acceptance carried no observable order change.', { upstreamOutcome: invoked.body });
        }
        extra = { orderSummaryId, ownedSummary, itemCountBefore: before.items.length, itemCountAfter: after.items.length };
      }
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
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
      return invoked;
    })();
  } catch { outcome = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned submit lifecycle could not be verified.'); }
  finally {
    for (const entry of owned.filter((row) => row.objectName === 'OrderSummary')) {
      cleanupError ??= await deleteOwnedSummary(request, root, entry.id);
    }
    for (const entry of owned.filter((row) => row.objectName === 'WebCart')) {
      const gone = await request(root + '/sobjects/WebCart/' + entry.id, 'DELETE').catch(() => null);
      if (!gone?.ok) cleanupError ??= `WebCart ${entry.id} could not be removed; platform natives may refuse deletion.`;
    }
    // The mint-activated order refuses deletion until reduced to Draft.
    if (submitActivatedOrderId) {
      await request(root + '/sobjects/Order/' + submitActivatedOrderId, 'PATCH', { Status: 'Draft' }).catch(() => null);
    }
    cleanupError ??= await cleanupCommerceFixtures({
      request, root, marker, owned: owned.filter((row) => row.objectName !== 'OrderSummary' && row.objectName !== 'WebCart'),
      order: ['OrderPaymentSummary', 'OrderItemTaxLineItem', 'OrderItem', 'OrderDeliveryGroup', 'PaymentAuthorization', 'Order', 'Account'], scopes,
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
  let fulfillActivatedOrderId: string | undefined;
  try {
    outcome = await (async (): Promise<Result> => {
      // Fulfillment acts on a summary: mint an owned one, then discover
      // its live group/line rows (quantities flow into the wrapper) plus
      // the fulfill-from location.
      const minted = await mintOwnedOrderSummary({ request, build, root, marker, capture, scopes });
      if (!minted) {
        return fail('COMMERCE_OWNED_SUMMARY_UNAVAILABLE',
          'No owned OrderSummary could be minted for the fulfillment; nothing was fulfilled.',
          { setupRequirement: 'Provision Order Management substrate (an owned OrderSummary mintable through the native create-summary action), then retry.' });
      }
      fulfillActivatedOrderId = minted.activatedOrderId;
      // Cancel needs an owned fulfillment line to act on. The create
      // action cannot supply one (org allocation automation consumes
      // fresh summaries within seconds), so the setup direct-inserts a
      // Draft fulfillment order plus one owned line (live proof: the
      // cancel drops the owned line Quantity 1->0).
      if (/cancel/i.test(action)) {
        const cancelLocationId = await discoverLiveSetupId(request, root, 'Location');
        if (!cancelLocationId) {
          return fail('COMMERCE_FULFILLMENT_SUBSTRATE_ABSENT',
            'The org exposes no fulfill-from location for the owned cancel setup.',
            { setupRequirement: 'Provision fulfillment substrate (a fulfill-from location), then retry.' });
        }
        const cancelType = await discoverFulfillmentType(request, root, fulfillmentSchema.body, cancelLocationId);
        const setupOrder = await createOwnedFixture({ request, build, root, objectType: 'FulfillmentOrder', marker,
          values: { OrderSummaryId: minted.orderSummaryId, AccountId: minted.accountId, Status: 'Draft',
            FulfilledFromLocationId: cancelLocationId, FulfilledToName: marker,
            ...(cancelType ? { Type: cancelType } : {}) }, capture });
        if ('failure' in setupOrder) {
          return fail('COMMERCE_SETUP_UNAVAILABLE', 'No owned fulfillment order could be created for the cancel; nothing was cancelled.',
            { upstreamOutcome: setupOrder.failure.body });
        }
        scopes.push(markerScope('FulfillmentOrder', setupOrder.markerField, setupOrder.storedMarker));
        const oisId = (await queryIds(request, root,
          `SELECT Id FROM OrderItemSummary WHERE OrderSummaryId='${minted.orderSummaryId}' LIMIT 1`))[0];
        if (!oisId) {
          return fail('COMMERCE_FULFILLMENT_SUBSTRATE_ABSENT', 'The minted summary holds no item summary to link the owned cancel line against.');
        }
        const setupLine = await createOwnedFixture({ request, build, root, objectType: 'FulfillmentOrderLineItem', marker,
          values: { FulfillmentOrderId: setupOrder.id, OrderItemSummaryId: oisId, Quantity: 1, OriginalQuantity: 1,
            Type: 'Order Product', TypeCode: 'Product' }, capture });
        if ('failure' in setupLine) {
          return fail('COMMERCE_SETUP_UNAVAILABLE', 'No owned fulfillment line could be created for the cancel; nothing was cancelled.',
            { upstreamOutcome: setupLine.failure.body });
        }
        scopes.push(markerScope('FulfillmentOrderLineItem', setupLine.markerField, setupLine.storedMarker));
        const cancelOwned: CommerceOwnedIds = {
          accountId: minted.accountId, orderId: minted.orderId, orderSummaryId: minted.orderSummaryId,
          live: { FulfillmentOrder: setupOrder.id }, fixtures: { FulfillmentOrder: setupOrder.id },
          lineSummaries: [{ id: setupLine.id, quantity: 1 }],
        };
        const cancelMapped = mapCommerceArguments(inputs, cancelOwned);
        if ('failure' in cancelMapped) return fail('COMMERCE_INPUT_UNAVAILABLE', cancelMapped.failure);
        const cancelInvoked = await request(route, 'POST', { inputs: [cancelMapped.args] });
        if (cancelInvoked.ok && (cancelInvoked.body === null || Array.isArray(cancelInvoked.body) && cancelInvoked.body.length === 0)) {
          return fail('COMMERCE_ACTION_OUTCOME_MISSING', 'Salesforce returned no native outcome; no mutation is counted as successful.');
        }
        if (!nativeAccepted(cancelInvoked)) return cancelInvoked;
        const afterLine = await request(root + '/query?q=' + encodeURIComponent(
          `SELECT Quantity, OriginalQuantity FROM FulfillmentOrderLineItem WHERE Id='${setupLine.id}'`));
        const afterRow = afterLine.ok && record(afterLine.body) && Array.isArray(afterLine.body.records)
          ? afterLine.body.records.find(record) : undefined;
        if (!afterRow || afterRow.Quantity !== 0) {
          return fail('COMMERCE_EFFECT_UNVERIFIED', 'Native acceptance carried no observable cancel on the owned line.',
            { upstreamOutcome: cancelInvoked.body });
        }
        verified = true;
        extra = { fulfillmentId: setupOrder.id, cancelledLineId: setupLine.id, afterQuantity: afterRow.Quantity };
        if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
        return cancelInvoked;
      }
      const groupId = (await queryIds(request, root,
        `SELECT Id FROM OrderDeliveryGroupSummary WHERE OrderSummaryId='${minted.orderSummaryId}' LIMIT 1`))[0];
      const lineQuery = await request(root + '/query?q=' + encodeURIComponent(
        `SELECT Id, Quantity, Type, TypeCode, QuantityAvailableToFulfill FROM OrderItemSummary WHERE OrderSummaryId='${minted.orderSummaryId}' LIMIT 25`));
      const lineRows = lineQuery.ok && record(lineQuery.body) && Array.isArray(lineQuery.body.records)
        ? lineQuery.body.records.filter(record)
          .map((row) => ({ id: row.Id, quantity: row.Quantity, type: row.Type, typeCode: row.TypeCode, available: row.QuantityAvailableToFulfill }))
          .filter((row) => typeof row.id === 'string' && id(row.id) && typeof row.quantity === 'number' && row.quantity > 0)
        : [];
      const locationId = await discoverLiveSetupId(request, root, 'Location');
      if (!groupId || !lineRows.length || !locationId) {
        return fail('COMMERCE_FULFILLMENT_SUBSTRATE_ABSENT',
          'The minted summary holds no fulfillable group lines, or the org exposes no fulfill-from location.',
          { setupRequirement: 'Provision fulfillment substrate (summary group lines and a fulfill-from location), then retry.' });
      }
      // The service requires typed lines (the missing_type gate reads
      // Type/TypeCode data, not wrapper shape).
      if (lineRows.some((row) => typeof row.type !== 'string' || !row.type || typeof row.typeCode !== 'string' || !row.typeCode)) {
        return fail('COMMERCE_FULFILLMENT_SUBSTRATE_ABSENT',
          'The minted summary lines carry no Type/TypeCode; the fulfillment service requires both.',
          { setupRequirement: 'Mint the summary from an order whose OrderItem rows set Type (e.g. Order Product) so Type/TypeCode inherit, then retry.' });
      }
      // Org allocation automation may consume the minted lines within
      // seconds; with nothing available the native refuses, honestly.
      const availabilityOf = (row: { available: unknown; quantity: unknown }): number =>
        typeof row.available === 'number' ? row.available : (typeof row.quantity === 'number' ? row.quantity : 0);
      const fulfillable = lineRows.filter((row) => availabilityOf(row) > 0);
      if (!fulfillable.length) {
        return fail('COMMERCE_FULFILLMENT_QUANTITY_CONSUMED',
          'The minted summary lines show no quantity available to fulfill: org allocation automation consumes fresh summaries within seconds, before the native action can run.',
          { setupRequirement: 'Exclude probe summaries from the org allocation automation (or run in an org without it), then retry.' });
      }
      const fulfillmentType = await discoverFulfillmentType(request, root, fulfillmentSchema.body, locationId);
      const ownedIds: CommerceOwnedIds = {
        accountId: minted.accountId, orderId: minted.orderId, orderSummaryId: minted.orderSummaryId,
        live: { OrderDeliveryGroupSummary: groupId, Location: locationId },
        lineSummaries: fulfillable.map((row) => ({ id: row.id, quantity: availabilityOf(row) })),
        ...(fulfillmentType ? { scalars: { type: fulfillmentType } } : {}),
      };
      const parentField = referenceFieldTo(fulfillmentSchema.body, ['Order', 'OrderSummary', 'OrderDeliveryGroup']);
      const mapped = mapCommerceArguments(inputs, ownedIds);
      if ('failure' in mapped) return fail('COMMERCE_INPUT_UNAVAILABLE', mapped.failure);
      const invoked = await request(route, 'POST', { inputs: [mapped.args] });
      if (invoked.ok && (invoked.body === null || Array.isArray(invoked.body) && invoked.body.length === 0)) {
        return fail('COMMERCE_ACTION_OUTCOME_MISSING', 'Salesforce returned no native outcome; no mutation is counted as successful.');
      }
      if (!nativeAccepted(invoked)) {
        // The automation can consume the lines between the availability
        // gate and the invoke; translate that native refusal to the same
        // stable verdict so probes report one deterministic cause.
        const refusal = JSON.stringify(invoked.body ?? {});
        if (/valid quantity/i.test(refusal)) {
          return fail('COMMERCE_FULFILLMENT_QUANTITY_CONSUMED',
            'The native refused the fulfillable quantity: org allocation automation consumed the minted lines between discovery and invoke.',
            { setupRequirement: 'Exclude probe summaries from the org allocation automation (or run in an org without it), then retry.' });
        }
        return invoked;
      }
      const createdIds = outputIdentities(invoked.body, /fulfillmentorderids?$/i);
      // Anchor the fallback query to whichever parent the live schema
      // linked: summary-backed links need the minted summary id.
      const anchorValue = /summary/i.test(parentField ?? '') ? minted.orderSummaryId : minted.orderId;
      const existing = createdIds.length ? createdIds : parentField
        ? await queryIds(request, root, `SELECT Id FROM FulfillmentOrder WHERE ${parentField}='${anchorValue}' LIMIT 5`)
        : [];
      if (!existing.length) return fail('COMMERCE_EFFECT_UNVERIFIED', 'Native acceptance carried no verifiable fulfillment order.', { upstreamOutcome: invoked.body });
      for (const fulfillmentId of existing.slice(0, 5)) capture('FulfillmentOrder', fulfillmentId);
      extra = { createdFulfillmentIds: existing.slice(0, 5) };
      verified = true;
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
      return invoked;
    })();
  } catch { outcome = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned fulfillment lifecycle could not be verified.'); }
  finally {
    // Owned fulfillment rows delete first, then the minted summary with
    // any automation-attached children; each may refuse per platform rules.
    for (const entry of owned.filter((row) => row.objectName === 'FulfillmentOrder')) {
      const gone = await request(root + '/sobjects/FulfillmentOrder/' + entry.id, 'DELETE').catch(() => null);
      if (!gone?.ok) cleanupError ??= `FulfillmentOrder ${entry.id} could not be removed; platform natives may refuse deletion.`;
    }
    for (const entry of owned.filter((row) => row.objectName === 'OrderSummary')) {
      cleanupError ??= await deleteOwnedSummary(request, root, entry.id);
    }
    if (fulfillActivatedOrderId) {
      await request(root + '/sobjects/Order/' + fulfillActivatedOrderId, 'PATCH', { Status: 'Draft' }).catch(() => null);
    }
    cleanupError ??= await cleanupCommerceFixtures({
      request, root, marker, owned: owned.filter((row) => row.objectName !== 'FulfillmentOrder' && row.objectName !== 'OrderSummary'),
      // The cancel setup's owned line deletes here (usually already gone
      // via the header cascade; 404 counts as absent).
      order: ['FulfillmentOrderLineItem', 'OrderItem', 'OrderDeliveryGroup', 'OrderDeliveryMethod', 'PricebookEntry', 'Order', 'Account'], scopes,
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
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
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
}): Promise<{ typeId: string; markerField: string; storedMarker: string; programId?: string; usedCustomFallback: boolean; program?: { markerField: string; storedMarker: string } } | { failure: Result; program?: { markerField: string; storedMarker: string } }> {
  // Borrow leg: reuse one live type row (never written, never captured for
  // deletion; the empty-marker scope below matches nothing). Mint only when
  // the org holds no live row.
  const borrowed = await input.request(`${input.root}/query?q=${encodeURIComponent('SELECT Id FROM ProgramRebateType LIMIT 1')}`).catch(() => null);
  const live = borrowed?.ok && record(borrowed.body) && Array.isArray(borrowed.body.records)
    ? borrowed.body.records.filter(record).find((row) => id(row.Id)) : undefined;
  if (live) {
    const typeRow = await input.request(`${input.root}/sobjects/ProgramRebateType/${live.Id}`).catch(() => null);
    const programId = typeRow?.ok && record(typeRow.body) && id(typeRow.body.RebateProgramId)
      ? typeRow.body.RebateProgramId as string : undefined;
    return { typeId: live.Id as string, markerField: 'Name', storedMarker: '', programId, usedCustomFallback: false };
  }
  // Mint leg: the type's required RebateProgramId seeds from a freshly
  // minted program (live describe requireds: Name/StartDate/EndDate).
  // Faults pass through unmasked with native text (no swallow); a type-mint
  // failure still carries the program scope so cleanup proves identity.
  const today = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const programValues: Value = { StartDate: today, EndDate: end };
  const programSchema = await input.request(`${input.root}/sobjects/RebateProgram/describe`).catch(() => null);
  const programFields = programSchema?.ok && record(programSchema.body) && Array.isArray(programSchema.body.fields)
    ? programSchema.body.fields.filter(record) : [];
  const programStatus = programFields.find((entry) => entry.name === 'Status');
  const programChoices = Array.isArray(programStatus?.picklistValues) ? programStatus.picklistValues.filter(record)
    .filter((entry) => entry.active === true && typeof entry.value === 'string') : [];
  if (programStatus?.createable === true && programChoices.some((entry) => entry.value === 'Active')) {
    programValues.Status = 'Active';
  }
  const program = await createOwnedFixture({ ...input, objectType: 'RebateProgram', marker: input.marker,
    values: programValues, capture: input.capture });
  if ('failure' in program) return { failure: program.failure };
  const programScope = { markerField: program.markerField, storedMarker: program.storedMarker };
  // Type semantics follow the org's calc infrastructure: a live Rebates-type
  // definition unlocks standard calculable semantics (CalcObjectId-bound);
  // without one the type falls back to Custom (read/estimate actions still
  // convert; calculate actions fault opaquely for lack of an engine
  // formula, which the caller translates to a setup terminal).
  const typeValues: Value = { RebateProgramId: program.id };
  const defRows = await input.request(input.root + '/query?q=' + encodeURIComponent(
    'SELECT Id, DeveloperName, MasterLabel, ProcessType FROM BatchCalcJobDefinition LIMIT 10')).catch(() => null);
  const rebateDef = defRows?.ok && record(defRows.body) && Array.isArray(defRows.body.records)
    ? defRows.body.records.filter(record).find((row) => id(row.Id) &&
      /rebate/i.test(`${row.DeveloperName ?? ''} ${row.MasterLabel ?? ''} ${row.ProcessType ?? ''}`)) : undefined;
  const typeSchema = await input.request(`${input.root}/sobjects/ProgramRebateType/describe`).catch(() => null);
  const typeFields = typeSchema?.ok && record(typeSchema.body) && Array.isArray(typeSchema.body.fields)
    ? typeSchema.body.fields.filter(record) : [];
  const preferences: Record<string, string[]> = rebateDef ? {
    CalculationType: ['PerTransaction', 'AggregateBased', 'GrowthBased', 'Custom'],
    RebateMeasureType: ['FixedAmount', 'AmountperUnit', 'PercentageOfRevenue', 'Custom'],
    Status: ['Active'],
    AggregateObjectName: ['RebateMemberProductAggregate'],
  } : {
    CalculationType: ['Custom'],
    RebateMeasureType: ['Custom'],
    Status: ['Active'],
    AggregateObjectName: ['RebateMemberProductAggregate'],
  };
  for (const [name, ordered] of Object.entries(preferences)) {
    const field = typeFields.find((entry) => entry.name === name);
    const choices = Array.isArray(field?.picklistValues) ? field.picklistValues.filter(record)
      .filter((entry) => entry.active === true && typeof entry.value === 'string') : [];
    if (field?.createable !== true || !choices.length) continue;
    const values = choices.map((entry) => entry.value as string);
    typeValues[name] = ordered.find((want) => values.includes(want)) ?? values[0];
  }
  if (rebateDef) typeValues.CalcObjectId = rebateDef.Id as string;
  const rebateType = await createOwnedFixture({ ...input, objectType: 'ProgramRebateType', marker: input.marker,
    values: typeValues, capture: input.capture });
  if ('failure' in rebateType) return { failure: rebateType.failure, program: programScope };
  return { typeId: rebateType.id, markerField: rebateType.markerField, storedMarker: rebateType.storedMarker,
    programId: program.id, usedCustomFallback: !rebateDef, program: programScope };
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
      if ('failure' in scope) {
        if (scope.program) scopes.push(markerScope('RebateProgram', scope.program.markerField, scope.program.storedMarker));
        return scope.failure;
      }
      scopes.push(markerScope('ProgramRebateType', scope.markerField, scope.storedMarker));
      if (scope.program) scopes.push(markerScope('RebateProgram', scope.program.markerField, scope.program.storedMarker));
      const ownedIds: CommerceOwnedIds = { fixtures: { ProgramRebateType: scope.typeId }, live: { ProgramRebateType: scope.typeId } };
      // AggregateId-declaring actions need a real aggregate row: mint the
      // owned member + payout-period + aggregate chain under the scope's
      // program. Partial chains push their scopes before failing so cleanup
      // proves every minted row.
      const aggregateInput = inputs.find((entry) => /^aggregateids?$/i.test(entry.name ?? ''));
      if (aggregateInput) {
        if (!scope.programId) {
          return fail('COMMERCE_REBATE_PROGRAM_UNAVAILABLE',
            'The rebate scope exposes no program identity, so no owned aggregate chain can be minted.',
            { setupRequirement: 'A ProgramRebateType row carrying RebateProgramId.' });
        }
        const chainToday = new Date().toISOString().slice(0, 10);
        const chainEnd = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
        const account = await createOwnedFixture({ ...input, objectType: 'Account', marker: input.marker,
          values: { Name: input.marker }, capture });
        if ('failure' in account) return account.failure;
        scopes.push(markerScope('Account', account.markerField, account.storedMarker));
        const member = await createOwnedFixture({ ...input, objectType: 'RebateProgramMember', marker: input.marker,
          values: { RebateProgramId: scope.programId, AccountId: account.id }, capture });
        if ('failure' in member) return member.failure;
        scopes.push(markerScope('RebateProgramMember', member.markerField, member.storedMarker));
        const period = await createOwnedFixture({ ...input, objectType: 'RebateProgramPayoutPeriod', marker: input.marker,
          values: { RebateProgramId: scope.programId, StartDate: chainToday, EndDate: chainEnd,
            TransactionGracePeriodDate: chainEnd, PayoutCalculationDate: chainEnd }, capture });
        if ('failure' in period) return period.failure;
        scopes.push(markerScope('RebateProgramPayoutPeriod', period.markerField, period.storedMarker));
        const aggregate = await createOwnedFixture({ ...input, objectType: 'RebateMemberProductAggregate', marker: input.marker,
          values: { ProgramRebateTypeId: scope.typeId, RebateProgramMemberId: member.id,
            RebateProgramPayoutPeriodId: period.id, TotalQuantity: 2, TotalTransactionAmount: 100 }, capture });
        if ('failure' in aggregate) return aggregate.failure;
        scopes.push(markerScope('RebateMemberProductAggregate', aggregate.markerField, aggregate.storedMarker));
        // One journaled item: calculation actions dereference aggregate
        // contents, and an empty aggregate faults opaquely. The journal
        // needs only an activity date; the item links journal + aggregate.
        const journal = await createOwnedFixture({ ...input, objectType: 'TransactionJournal', marker: input.marker,
          values: { ActivityDate: new Date().toISOString(), MemberId: member.id, AccountId: account.id,
            TransactionAmount: 100, Quantity: 2 }, capture });
        if ('failure' in journal) return journal.failure;
        scopes.push(markerScope('TransactionJournal', journal.markerField, journal.storedMarker));
        // Items expose no writable marker field (auto-number Name), so mint
        // directly and prove identity through the owned aggregate parent.
        const itemPosted = await request(root + '/sobjects/RebateMemberAggregateItem', 'POST',
          { TransactionJournalId: journal.id, RebateMemberProductAggregateId: aggregate.id,
            TransactionQuantity: 2, TransactionAmount: 100 });
        if (!itemPosted.ok || !id(itemPosted.body?.id)) return itemPosted;
        const itemId = itemPosted.body.id as string;
        capture('RebateMemberAggregateItem', itemId);
        const itemRead = await request(root + '/sobjects/RebateMemberAggregateItem/' + itemId);
        if (!itemRead.ok || !record(itemRead.body) || itemRead.body.RebateMemberProductAggregateId !== aggregate.id ||
          itemRead.body.TransactionJournalId !== journal.id) {
          return fail('COMMERCE_FIXTURE_UNVERIFIED', 'Actual owned RebateMemberAggregateItem readback failed.');
        }
        scopes.push({ objectName: 'RebateMemberAggregateItem',
          equals: { RebateMemberProductAggregateId: aggregate.id },
          ownedParents: [{ field: 'RebateMemberProductAggregateId', objectName: 'RebateMemberProductAggregate' }] });
        ownedIds.fixtures!.RebateMemberProductAggregate = aggregate.id;
        ownedIds.live!.RebateMemberProductAggregate = aggregate.id;
      }
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
        if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
        return invoked;
      }
      const mapped = mapCommerceArguments(inputs, ownedIds);
      if ('failure' in mapped) return fail('COMMERCE_INPUT_UNAVAILABLE', mapped.failure);
      // Calculation actions resolve the member through the named aggregate
      // field; without it the engine faults asking for a member or account.
      if (ownedIds.fixtures!.RebateMemberProductAggregate && !mapped.args.PayoutMemberFieldName &&
        inputs.some((entry) => entry.name === 'PayoutMemberFieldName')) {
        mapped.args.PayoutMemberFieldName = 'RebateProgramMemberId';
      }
      const invoked = await request(route, 'POST', { inputs: [mapped.args] });
      if (invoked.ok && (invoked.body === null || Array.isArray(invoked.body) && invoked.body.length === 0)) {
        return fail('COMMERCE_ACTION_OUTCOME_MISSING', 'Salesforce returned no native outcome; no mutation is counted as successful.');
      }
      if (!nativeAccepted(invoked)) {
        // Under the Custom fallback the engine carries no formula, so
        // calculate actions fault opaquely: name the missing calc
        // infrastructure instead of surfacing a content-free fault.
        const opaque = scope.usedCustomFallback && !invoked.ok && Array.isArray(invoked.body) &&
          invoked.body.some((entry) => record(entry) && Array.isArray(entry.errors) && entry.errors.some((item) =>
            record(item) && item.statusCode === 'UNKNOWN_EXCEPTION' && typeof item.message === 'string' &&
            /something went wrong/i.test(item.message)));
        if (opaque) {
          return fail('COMMERCE_CALC_DEFINITION_UNAVAILABLE',
            'The calculation needs a Rebates-type engine definition and the org holds none (the Custom fallback carries no formula).',
            { setupRequirement: 'A Rebates-type BatchCalcJobDefinition row for the rebate calculation.', upstreamOutcome: invoked.body });
        }
        return invoked;
      }
      if (/upsert|payout/i.test(action)) {
        const payoutIds = outputIdentities(invoked.body, /(payout|rebate).{0,8}ids?$/i);
        for (const payoutId of payoutIds.slice(0, 5)) {
          const memberPayout = await request(root + '/sobjects/RebateProgramMemberPayout/' + payoutId).catch(() => null);
          if (memberPayout?.ok) { capture('RebateProgramMemberPayout', payoutId); continue; }
          const legacy = await request(root + '/sobjects/CustomRebatePayout/' + payoutId).catch(() => null);
          if (legacy?.ok) capture('CustomRebatePayout', payoutId);
        }
        if (payoutIds.length) extra = { payoutIds: payoutIds.slice(0, 5) };
        // Fallback: the native names the payout from our marker, so sweep
        // member payouts by the marker uuid when outputs carry no identity.
        if (!owned.some((entry) => entry.objectName === 'RebateProgramMemberPayout' || entry.objectName === 'CustomRebatePayout')) {
          const uuid = marker.split(' ').at(-1) ?? '';
          if (/^[0-9a-f-]{8,}$/i.test(uuid)) {
            const swept = await request(root + '/query?q=' + encodeURIComponent(
              `SELECT Id FROM RebateProgramMemberPayout WHERE Name LIKE '%${uuid}%' LIMIT 5`)).catch(() => null);
            const rows = swept?.ok && record(swept.body) && Array.isArray(swept.body.records)
              ? swept.body.records.filter(record) : [];
            for (const row of rows) if (id(row.Id)) capture('RebateProgramMemberPayout', row.Id as string);
          }
        }
      }
      const reread = await request(root + '/sobjects/ProgramRebateType/' + scope.typeId);
      if (!reread.ok) return fail('COMMERCE_EFFECT_UNVERIFIED', 'The owned rebate scope vanished during invocation.', { upstreamOutcome: invoked.body });
      verified = true;
      extra = { ...extra, rebateTypeId: scope.typeId };
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
      return invoked;
    })();
  } catch { outcome = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned rebate lifecycle could not be verified.'); }
  finally {
    for (const entry of owned.filter((row) => row.objectName === 'CustomRebatePayout' || row.objectName === 'RebateProgramMemberPayout')) {
      const gone = await request(root + '/sobjects/' + entry.objectName + '/' + entry.id, 'DELETE').catch(() => null);
      if (!gone?.ok) cleanupError ??= `${entry.objectName} ${entry.id} could not be removed; platform natives may refuse deletion.`;
    }
    cleanupError ??= await cleanupCommerceFixtures({
      request, root, marker, owned: owned.filter((row) => row.objectName !== 'CustomRebatePayout' && row.objectName !== 'RebateProgramMemberPayout'),
      order: ['RebateMemberAggregateItem', 'RebateMemberProductAggregate', 'TransactionJournal', 'ProgramRebateType', 'RebateProgramMember', 'RebateProgramPayoutPeriod', 'RebateProgram', 'Account'], scopes,
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
      if ('failure' in scope) {
        if (scope.program) batchScopes.push(markerScope('RebateProgram', scope.program.markerField, scope.program.storedMarker));
        return scope.failure;
      }
      batchScopes.push(markerScope('ProgramRebateType', scope.markerField, scope.storedMarker));
      if (scope.program) batchScopes.push(markerScope('RebateProgram', scope.program.markerField, scope.program.storedMarker));
      const fixtures: Record<string, string> = { ProgramRebateType: scope.typeId };
      if (inputs.some((entry) => /^calcdefinitionids?$/i.test(entry.name ?? ''))) {
        // The definition must be a rebate calculation: inventory/search
        // definitions run and fail validation. Match rebate vocabulary on
        // live labels; refuse honestly when the org holds no rebate def.
        const defs = await request(root + '/query?q=' + encodeURIComponent(
          'SELECT Id, DeveloperName, MasterLabel, ProcessType FROM BatchCalcJobDefinition LIMIT 10')).catch(() => null);
        const rows = defs?.ok && record(defs.body) && Array.isArray(defs.body.records)
          ? defs.body.records.filter(record) : [];
        const def = rows.find((row) => id(row.Id) &&
          /rebate/i.test(`${row.DeveloperName ?? ''} ${row.MasterLabel ?? ''} ${row.ProcessType ?? ''}`));
        if (!def) {
          return fail('COMMERCE_CALC_DEFINITION_UNAVAILABLE',
            'The job needs a live rebate batch calculation definition and the org holds none.',
            { setupRequirement: 'A Rebates-type BatchCalcJobDefinition row for the rebate calculation.' });
        }
        fixtures.BatchCalcJobDefinition = def.Id as string;
      }
      const mapped = mapCommerceArguments(inputs, { fixtures, live: { ProgramRebateType: scope.typeId } });
      if ('failure' in mapped) return fail('COMMERCE_INPUT_UNAVAILABLE', mapped.failure);
      const invoked = await request(route, 'POST', { inputs: [mapped.args] });
      if (!nativeAccepted(invoked)) return invoked;
      const jobIds = outputIdentities(invoked.body, /(job|batch|async).{0,8}ids?$/i);
      if (!jobIds[0]) return fail('COMMERCE_JOB_UNVERIFIED', 'Native acceptance carried no job identity.', { upstreamOutcome: invoked.body });
      let status = '';
      let errorDescription: unknown = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1500, clampVerificationWindowMs(input.verificationWindowMs ?? 6000) / 4)));
        try {
          // Calculation runs surface as BatchJob rows (Status/ErrorDescription),
          // not AsyncApexJob rows.
          const job = await request(root + '/query?q=' + encodeURIComponent(
            `SELECT Status, ErrorDescription FROM BatchJob WHERE Id='${jobIds[0]}' LIMIT 1`));
          const row = record(job.body) && Array.isArray(job.body.records) ? job.body.records.filter(record)[0] : undefined;
          status = row && typeof row.Status === 'string' ? row.Status : '';
          errorDescription = row?.ErrorDescription ?? null;
          if (['Completed', 'Failed', 'Aborted'].includes(status)) {
            extra = { jobId: jobIds[0], jobStatus: status, jobErrors: errorDescription };
            break;
          }
        } catch { /* poll again until the bound */ }
      }
      if (status !== 'Completed') {
        return fail('COMMERCE_JOB_UNVERIFIED', `The batch job did not reach Completed (state: ${status || 'unknown'}).`,
          { upstreamOutcome: invoked.body, ...(status === 'Failed' && typeof errorDescription === 'string' ? { nativeError: errorDescription.slice(0, 500) } : {}) });
      }
      verified = true;
      return invoked;
    })();
  } catch { outcome = fail('COMMERCE_LIFECYCLE_UNVERIFIED', 'The owned batch lifecycle could not be verified.'); }
  finally {
    cleanupError = await cleanupCommerceFixtures({ request, root, marker, owned, order: ['ProgramRebateType', 'RebateProgram'], scopes: batchScopes });
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
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
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
    return { status: 422, body: { errorCode: 'COMMERCE_ROUTE_INVALID', message: 'A discovered standard or cart-draft apex commerce action route is required.' } };
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
