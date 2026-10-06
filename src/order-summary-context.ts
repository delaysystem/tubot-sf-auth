/**
 * Owned order-summary preview lifecycle.
 *
 * Spike (sf CLI, jq only, test1empty + test2): the `OrderSummary` type is
 * absent from global metadata in both orgs, the `changeOrderSummaryPreview`
 * action descriptor answers NOT_FOUND ("Invalid Action Type") in both orgs,
 * and the only order-family standard actions are `createReturnOrder` and
 * `returnReturnOrderItems`. `PendingOrderSummary` exists but the
 * OrderSummary/OrderDeliveryGroup/OrderProductSummary family does not, so
 * Order Management is not enabled. OrderSummary rows are minted by Order
 * Management flows, not by a submittable Order API, so no create-Order-then-
 * submit path can produce a previewable row: the submit path is
 * unsatisfiable via API and this module refuses to fabricate identities.
 *
 * The module therefore runs a capability pre-check from live metadata and
 * returns an honest setup-gated failure (ORDER_SUMMARY_SETUP_REQUIRED)
 * instead of invoking with a guessed id. When a future org does expose the
 * capability, preview runs read-only against one live OrderSummary row
 * discovered via SOQL; zero rows is a setup-gated substrate failure, never
 * an invented identity. Preview creates no fixture, so there is no cleanup
 * phase. No org id, alias, username, or URL appears here; every tenant
 * value is caller-supplied or read live.
 */

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const KEY_PREFIX = /^[A-Za-z0-9]{3}$/;
const ROUTE_TAIL = /^\/services\/data\/v\d+(?:\.\d+)?\/actions\/standard\/([A-Za-z][A-Za-z0-9_]{0,127})$/;

export const ORDER_SUMMARY_OBJECT = "OrderSummary";
export const ORDER_SUMMARY_ACTIONS = ["changeOrderSummaryPreview", "changeOrderSummarySubmit"] as const;
/** Family builder version: capability pre-check + read-only live-row preview (setup-gated, never invented). 80: link-schema narrowing terminalizes the proven-blocked zero-row shape (OrderItem lacks the delivery-group link field) instead of pending it. */
export const ORDER_SUMMARY_BUILDER_VERSION = 80;
/** Order-side link object for summary minting (documented import-table shape). */
export const ORDER_SUMMARY_LINK_OBJECT = "OrderItem";
/** Delivery-group link field `createOrderSummary` demands on the link object. */
export const ORDER_SUMMARY_LINK_FIELD = "OrderDeliveryGroupId";
export type OrderSummaryAction = (typeof ORDER_SUMMARY_ACTIONS)[number];

/** Action name from a live standard-action route tail. Null when not order-summary family. */
export function orderSummaryActionName(route: string): string | null {
  const match = typeof route === "string" ? route.match(ROUTE_TAIL) : null;
  const name = match?.[1] ?? null;
  return name !== null && (ORDER_SUMMARY_ACTIONS as readonly string[]).includes(name) ? name : null;
}

const record = (value: unknown): value is Value =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && SF_ID.test(value);

const fail = (errorCode: string, message: string, extra?: Value): Result => ({
  status: 422, ok: false, body: { errorCode, message, ...extra },
});

const nativeAccepted = (result: Result): boolean => {
  if (!result.ok || !Array.isArray(result.body) || result.body.length === 0) return false;
  return result.body.every((item) =>
    record(item) && item.isSuccess === true &&
    (item.errors === null || item.errors === undefined || (Array.isArray(item.errors) && item.errors.length === 0)) &&
    item.errorCode === undefined && item.errorMessage === undefined);
};

/** Declared descriptor input names; empty when the descriptor has no input schema. */
function descriptorInputNames(descriptor: unknown): string[] {
  if (!record(descriptor) || !Array.isArray(descriptor.inputs)) return [];
  return descriptor.inputs.filter(record).map((field) => field.name).filter((name): name is string =>
    typeof name === "string" && INPUT_NAME.test(name));
}

/**
 * Reference-ID rule for argument builders (sampleValue reference implementation).
 *
 * A live id wins; otherwise only a verified 3-char key prefix for the exact
 * object type may seed a synthetic id. Anything else yields the missing
 * field so the builder reports missingFields instead of emitting a
 * prefix-less random id that upstream prefix validation rejects. In
 * particular a null/unknown object type is unverified: the legacy
 * fully-random id never survives prefix validation, so it is missing too.
 */
export function resolveReferenceIdOrMissing(input: {
  fieldName: string;
  objectType?: string | null;
  recordIds: Record<string, string>;
  objectKeyPrefixes?: Record<string, string>;
}): { id: string } | { idPrefix: string } | { missingField: string } {
  const fieldName = typeof input.fieldName === "string" && INPUT_NAME.test(input.fieldName)
    ? input.fieldName : "id";
  const objectType = typeof input.objectType === "string" && OBJECT_NAME.test(input.objectType)
    ? input.objectType : null;
  const live = objectType ? input.recordIds[objectType] : undefined;
  if (typeof live === "string" && identity(live)) return { id: live };
  const prefix = objectType ? input.objectKeyPrefixes?.[objectType] : undefined;
  if (typeof prefix === "string" && KEY_PREFIX.test(prefix)) return { idPrefix: prefix };
  return { missingField: fieldName };
}

export type OrderSummaryCapabilityRequest = {
  root: string;
  route: string;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
};

export type OrderSummaryCapability =
  | { available: true; action: string; descriptor: Value; typeDescribed: boolean }
  | { available: false; action: string | null; result: Result; evidence: Value };

/**
 * Capability pre-check from live metadata only. The preview/submit family
 * needs both its action descriptor and the OrderSummary type; when either
 * is absent the org lacks Order Management setup and no invocation is
 * attempted. The failure message carries no invalid_input trigger words so
 * the verdict stays setup-gated rather than payload-blaming.
 */
export async function checkOrderSummaryCapability(input: OrderSummaryCapabilityRequest): Promise<OrderSummaryCapability> {
  const action = orderSummaryActionName(input.route);
  if (!action || !input.root.startsWith("/services/data/") || !input.route.startsWith(`${input.root}/actions/`)) {
    return {
      available: false, action,
      result: fail("ORDER_SUMMARY_ROUTE_INVALID", "A discovered standard order-summary action route is required."),
      evidence: { actionDescribed: false, typeDescribed: false },
    };
  }
  const descriptor = await input.request(input.route);
  const inputs = descriptor.ok ? descriptorInputNames(descriptor.body) : [];
  if (!descriptor.ok || !inputs.length) {
    return {
      available: false, action,
      result: fail("ORDER_SUMMARY_SETUP_REQUIRED",
        `Order Management setup is incomplete: the live org exposes no usable ${action} descriptor. Enable Order Management during org provisioning, then retry.`,
        { setupRequirement: "Order Management enabled with the order-summary action descriptor published.", upstreamStatus: descriptor.status }),
      evidence: { actionDescribed: false, typeDescribed: false, upstreamStatus: descriptor.status },
    };
  }
  const described = await input.request(`${input.root}/sobjects/${ORDER_SUMMARY_OBJECT}/describe`);
  if (!described.ok || !record(described.body) || described.body.name !== ORDER_SUMMARY_OBJECT) {
    return {
      available: false, action,
      result: fail("ORDER_SUMMARY_SETUP_REQUIRED",
        `Order Management setup is incomplete: the live org exposes no ${ORDER_SUMMARY_OBJECT} type for ${action}. Enable Order Management during org provisioning, then retry.`,
        { setupRequirement: `Order Management enabled with a queryable ${ORDER_SUMMARY_OBJECT} type.`, upstreamStatus: described.status }),
      evidence: { actionDescribed: true, typeDescribed: false, upstreamStatus: described.status },
    };
  }
  return { available: true, action, descriptor: descriptor.body as Value, typeDescribed: true };
}

export type OrderSummaryPreviewInput = {
  root: string;
  route: string;
  verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
};

/**
 * Live link-field evidence for the zero-row shape: true when the link
 * describe exposes the delivery-group field, false when a readable
 * describe proves it absent, null when the describe itself is unreadable
 * (proves nothing either way).
 */
export async function orderSummaryLinkFieldPresent(input: {
  root: string;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
}): Promise<boolean | null> {
  const described = await input.request(`${input.root}/sobjects/${ORDER_SUMMARY_LINK_OBJECT}/describe`);
  if (!described.ok || !record(described.body) || !Array.isArray(described.body.fields)) return null;
  return described.body.fields.filter(record).some((field) => field.name === ORDER_SUMMARY_LINK_FIELD);
}

/**
 * Read-only preview against one live OrderSummary row. Setup-gated when
 * the capability or every row is absent; the native call is never made
 * with an invented identity. No fixture is created, so no cleanup applies.
 */
export async function invokeOrderSummaryPreviewWithContext(input: OrderSummaryPreviewInput): Promise<{
  status: number; body: any; contextSchema?: Value;
}> {
  const base = {
    source: "salesforce_live_order_summary_preview",
    targetObject: ORDER_SUMMARY_OBJECT,
    automaticSteps: [
      "Describe the live order-summary action and OrderSummary type",
      "Refuse setup-gated when Order Management is absent instead of inventing an identity",
      "Discover one live OrderSummary row via SOQL",
      "Invoke preview read-only with declared inputs only",
    ],
  };
  const done = (outcome: Result, extra: Value): { status: number; body: any; contextSchema?: Value } => ({
    status: outcome.status, body: outcome.body, contextSchema: { ...base, ...extra },
  });
  if (input.verificationWindowMs !== undefined &&
    (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail("ORDER_SUMMARY_WINDOW_INVALID", "A bounded verification window is required."), { verified: false });
  }
  const capability = await checkOrderSummaryCapability(input);
  if (!capability.available) {
    return done(capability.result, { action: capability.action, verified: false, capability: capability.evidence });
  }
  const inputs = descriptorInputNames(capability.descriptor);
  const idInput = inputs.find((name) => name.toLowerCase() === "ordersummaryid")
    ?? inputs.find((name) => /id$/i.test(name));
  if (!idInput) {
    return done(fail("ORDER_SUMMARY_INPUT_UNAVAILABLE",
      "The live order-summary descriptor declares no identity input; no value will be invented.",
      { declaredInputs: inputs.slice(0, 25) }),
      { action: capability.action, verified: false, capability: { actionDescribed: true, typeDescribed: true } });
  }
  const found = await input.request(`${input.root}/query?q=${encodeURIComponent(
    `SELECT Id FROM ${ORDER_SUMMARY_OBJECT} LIMIT 1`)}`);
  const rows = record(found.body) && Array.isArray(found.body.records) ? found.body.records.filter(record) : [];
  if (!found.ok || rows.length !== 1 || !identity(rows[0].Id)) {
    // Link-schema narrowing: no API-reachable Order can satisfy
    // createOrderSummary while the live link describe lacks the
    // delivery-group field (deterministic MISSING_ARGUMENT refusal,
    // verified across orgs), so that shape terminalizes with its precise
    // requirement. A present field (or an unreadable describe, which
    // proves nothing) keeps the row pending: the mint path stays open.
    const linkField = await orderSummaryLinkFieldPresent(input);
    if (linkField === false) {
      return done(fail("ORDER_SUMMARY_LINK_SCHEMA_ABSENT",
        `Order Management substrate cannot be minted: the live ${ORDER_SUMMARY_LINK_OBJECT} describe exposes no ` +
        `${ORDER_SUMMARY_LINK_FIELD} field, and no API-reachable Order satisfies createOrderSummary without it. ` +
        "Retry when the platform schema exposes the link field.",
        { setupRequirement: `A live ${ORDER_SUMMARY_LINK_OBJECT}.${ORDER_SUMMARY_LINK_FIELD} link field in the platform schema.` }),
        {
          action: capability.action, verified: false,
          capability: { actionDescribed: true, typeDescribed: true, liveRowCount: found.ok ? rows.length : null, linkFieldPresent: false },
        });
    }
    return done(fail("ORDER_SUMMARY_SUBSTRATE_ABSENT",
      `Order Management setup is incomplete: the live org holds no ${ORDER_SUMMARY_OBJECT} row for ${capability.action}, and such rows are minted by Order Management flows rather than direct creation. Provision Order Management substrate during org provisioning, then retry.`,
      { setupRequirement: `One live ${ORDER_SUMMARY_OBJECT} row minted by Order Management flows.` }),
      {
        action: capability.action, verified: false,
        capability: { actionDescribed: true, typeDescribed: true, liveRowCount: found.ok ? rows.length : null, ...(linkField === true ? { linkFieldPresent: true } : {}) },
      });
  }
  const orderSummaryId = rows[0].Id as string;
  const invoked = await input.request(input.route, "POST", { inputs: [{ [idInput]: orderSummaryId }] });
  const verified = nativeAccepted(invoked);
  if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, input.verificationWindowMs));
  return done(verified ? invoked : fail("ORDER_SUMMARY_PREVIEW_UNVERIFIED",
    "Salesforce ended the order-summary preview without a verified accepted envelope.",
    { upstreamOutcome: invoked.body }), {
    action: capability.action, verified,
    orderSummaryId, verificationRecordIds: [orderSummaryId],
    capability: { actionDescribed: true, typeDescribed: true, liveRowCount: 1 },
  });
}
