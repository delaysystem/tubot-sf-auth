/**
 * Producer-backed agent-flow customer context.
 *
 * Root cause (blind-verified via the managed-flow taxonomy): scheduling and
 * field-service AI-agent flows execute with probe inputs and their own
 * error output reports the customer is unverified, the customer id
 * unresolvable, or the retrieved contextual intent empty
 * (FLOW_AGENT_CONTEXT_REQUIRED). Synthetic references never resolve agent
 * customer context; a verification-producer customer identity does.
 *
 * This module runs the automatable half of that setup: it discovers the
 * agent flow namespace's verification producer from live flow metadata,
 * mints one disposable owned Contact with an undeliverable identity, runs
 * the producer, invokes the agent flow with the real producer customer
 * identity, and sweeps the Contact with verified absence. Conversation or
 * intent inputs are bound only when the live descriptor declares them
 * optional (omitted) — a REQUIRED conversation/intent input has no owned
 * source and no new live borrowing is added here (live-borrow policy is
 * owned by another lane), so that gap fails setup-blocked with its precise
 * requirement instead of borrowing a live conversation.
 *
 * No org id, alias, username, or URL appears here; every tenant value is
 * caller-supplied or read live. Producer detection reuses the shared
 * producer-shape predicate; probe identities always use the undeliverable
 * example.invalid domain.
 */

import { personIdentityCompletion, verificationProducerInput } from "./flow-producer-context";

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const FLOW_NAME = /^[A-Za-z][A-Za-z0-9_]{1,127}$/;
const FLOW_ROUTE = /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{1,127})$/;
/** Cap: namespace producer candidates described before giving up. */
const PRODUCER_DESCRIBE_CAP = 5;
/** Cap: namespace flows listed from FlowDefinitionView. */
const PRODUCER_LIST_LIMIT = 25;

export const AGENT_CONTACT_OBJECT = "Contact";
export const AGENT_CONTACT_MARKER_FIELD = "LastName";

/** Prior verdict codes that route a custom/flow re-probe into this lifecycle. */
export const AGENT_SETUP_REPROBE_CODES = [
  "FLOW_AGENT_CONTEXT_REQUIRED",
  "FLOW_AGENT_CONVERSATION_REQUIRED",
  "FLOW_AGENT_PRODUCER_UNAVAILABLE",
] as const;

/** True when a custom/flow row re-probes through the producer-backed agent lifecycle. */
export function isAgentCustomerSetupReprobe(actionType: unknown, priorCode: unknown): boolean {
  return actionType === "custom/flow" && typeof priorCode === "string" &&
    (AGENT_SETUP_REPROBE_CODES as readonly string[]).includes(priorCode);
}

/** Flow namespace (custom/flow prefix before `__`); null when unmanaged or invalid. */
export function agentFlowNamespace(route: string): string | null {
  const name = typeof route === "string" ? route.match(FLOW_ROUTE)?.[2] : undefined;
  if (!name) return null;
  const at = name.indexOf("__");
  if (at <= 0) return null;
  const namespace = name.slice(0, at);
  return FIELD_NAME.test(namespace) ? namespace : null;
}

export type AgentCustomerShape = {
  /** Input bound to the producer customerId. */
  customerInput: string;
  /** Input bound to the producer customerType, when declared. */
  customerTypeInput?: string;
  /** Required conversation/intent inputs with no bindable source. */
  unbindableInputs: string[];
};

const CUSTOMER_INPUT = /customer/i;
const PERSON_ID_INPUT = /contact|person|account|user|member|subscriber/i;

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

/**
 * Map the live descriptor inputs to the producer-backed shape. The
 * customer input is descriptor vocabulary (`customer*`, or an id-typed
 * person input); conversation/intent inputs are recognized but never
 * bound — required ones are reported unbindable. Null when the
 * descriptor declares no customer-identity input at all.
 */
export function agentCustomerShape(descriptorInputs: unknown): AgentCustomerShape | null {
  const inputs = Array.isArray(descriptorInputs) ? descriptorInputs.filter(record) : [];
  const named = inputs.filter((field): field is Value & { name: string } =>
    typeof field.name === "string" && FIELD_NAME.test(field.name));
  if (named.length === 0) return null;
  const idTyped = (field: Value): boolean => {
    const type = String(field.type ?? "").toUpperCase();
    return type === "ID" || type === "REFERENCE" || /id$/i.test(field.name as string);
  };
  const customer = named.find((field) => CUSTOMER_INPUT.test(field.name) && !/type$/i.test(field.name)) ??
    named.find((field) => idTyped(field) && PERSON_ID_INPUT.test(field.name));
  if (!customer) return null;
  const customerTypeInput = named.find((field) => /customertype/i.test(field.name))?.name;
  const unbindableInputs = named
    .filter((field) => field.required === true && /convers|intent/i.test(field.name))
    .map((field) => field.name);
  return { customerInput: customer.name, ...(customerTypeInput ? { customerTypeInput } : {}), unbindableInputs };
}

/** Bounded FlowDefinitionView list scoping namespace producer discovery. */
export function agentProducerListQuery(namespace: string): string | null {
  if (!FIELD_NAME.test(namespace)) return null;
  return `SELECT ApiName FROM FlowDefinitionView WHERE ApiName LIKE '${namespace}%' LIMIT ${PRODUCER_LIST_LIMIT}`;
}

/** Candidate producer flow API names from a view-list body (validated, capped). */
export function agentProducerCandidates(body: unknown): string[] {
  if (!record(body) || !Array.isArray(body.records)) return [];
  const names: string[] = [];
  for (const row of body.records.filter(record)) {
    if (typeof row.ApiName === "string" && FLOW_NAME.test(row.ApiName) && !names.includes(row.ApiName)) {
      names.push(row.ApiName);
      if (names.length >= PRODUCER_DESCRIBE_CAP) break;
    }
  }
  return names;
}

/** Producer customer identity from a producer invoke body (outputValues scan). */
export function agentProducerIdentity(body: unknown): { customerId: string; customerType?: string } | null {
  const outputs: Value[] = [];
  const visit = (node: unknown): void => {
    if (outputs.length > 0) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!record(node)) return;
    if (Array.isArray(node.outputValues)) {
      for (const entry of node.outputValues.filter(record)) outputs.push(entry);
      return;
    }
    for (const key of ["output", "result", "body", "results"]) {
      if (node[key] !== undefined && node[key] !== null) visit(node[key]);
    }
  };
  visit(body);
  const valueOf = (name: string): unknown =>
    outputs.find((entry) => String(entry.name ?? entry.key ?? "").toLowerCase() === name)?.value;
  const customerId = valueOf("customerid");
  if (typeof customerId !== "string" || customerId.length === 0) return null;
  const customerType = valueOf("customertype");
  return typeof customerType === "string" && customerType.length > 0
    ? { customerId, customerType }
    : { customerId };
}

export type AgentCustomerContextInput = {
  root: string;
  route: string;
  verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
};

export async function invokeAgentFlowWithProducerContext(input: AgentCustomerContextInput): Promise<{
  status: number; body: any; cleanupError?: string; contextSchema?: Value;
}> {
  const { root, request } = input;
  const match = typeof input.route === "string" ? input.route.match(FLOW_ROUTE) : null;
  const action = match?.[2] ?? null;
  const automaticSteps = [
    "Map the live agent descriptor to its customer-identity input",
    "Discover the namespace verification producer from live flow metadata",
    "Create a disposable owned Contact with an undeliverable identity",
    "Run the producer and invoke the agent flow with the producer customer identity",
    "Delete only the owned Contact and verify absence",
  ];
  const base = { source: "salesforce_live_agent_customer_context", action, targetObject: AGENT_CONTACT_OBJECT, automaticSteps };
  const done = (outcome: Result, extra: Value): { status: number; body: any; cleanupError?: string; contextSchema?: Value } => ({
    status: outcome.status, body: outcome.body,
    ...(typeof extra.cleanupError === "string" ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: { ...base, ...extra },
  });
  if (!action || !root.startsWith("/services/data/") || !input.route.startsWith(`${root}/actions/`)) {
    return done(fail("FLOW_AGENT_ROUTE_INVALID", "A discovered custom agent-flow route is required."), { verified: false });
  }
  if (input.verificationWindowMs !== undefined &&
    (!Number.isInteger(input.verificationWindowMs) || input.verificationWindowMs < 0 || input.verificationWindowMs > 15_000)) {
    return done(fail("FLOW_AGENT_WINDOW_INVALID", "A bounded verification window is required."), { verified: false });
  }
  const marker = `AC probe ${crypto.randomUUID()}`;
  let cleanupError: string | undefined;
  let outcome: Result = fail("FLOW_AGENT_CONTEXT_UNAVAILABLE", "The producer-backed agent context could not be prepared.");
  let verified = false;
  let ownedId: string | undefined;
  let producerRoute: string | undefined;
  try {
    outcome = await (async (): Promise<Result> => {
      const descriptor = await request(input.route);
      if (!descriptor.ok) return descriptor;
      const shape = agentCustomerShape(record(descriptor.body) ? descriptor.body.inputs : undefined);
      if (!shape) {
        return fail("FLOW_AGENT_PRODUCER_UNAVAILABLE",
          "The live agent descriptor declares no customer-identity input, so the producer identity cannot bind.",
          { setupRequirement: "An agent-flow descriptor declaring a customer-identity input for the producer identity." });
      }
      if (shape.unbindableInputs.length > 0) {
        return fail("FLOW_AGENT_CONVERSATION_REQUIRED",
          `The agent flow requires conversation context (${shape.unbindableInputs.slice(0, 5).join(", ")}) ` +
          "with no owned or borrow-approved source; the producer customer identity alone cannot satisfy it.",
          { setupRequirement: "An owned messaging conversation (or a live-borrow-approved live conversation) carrying contextual intent.", unbindableInputs: shape.unbindableInputs.slice(0, 10) });
      }
      const namespace = agentFlowNamespace(input.route);
      const listQuery = namespace ? agentProducerListQuery(namespace) : null;
      if (!listQuery) {
        return fail("FLOW_AGENT_PRODUCER_UNAVAILABLE",
          "The agent flow carries no namespace, so no verification-producer scope can be discovered.",
          { setupRequirement: "A namespaced agent flow whose package ships a verification producer." });
      }
      const listed = await request(`${root}/query?q=${encodeURIComponent(listQuery)}`);
      if (!listed.ok) return listed;
      let producerInput: string | null = null;
      for (const candidate of agentProducerCandidates(listed.body)) {
        const candidateRoute = `${root}/actions/custom/flow/${candidate}`;
        const described = await request(candidateRoute);
        if (!described.ok || !record(described.body)) continue;
        const found = verificationProducerInput(described.body.inputs, described.body.outputs);
        if (found) {
          producerInput = found;
          producerRoute = candidateRoute;
          break;
        }
      }
      if (!producerInput || !producerRoute) {
        return fail("FLOW_AGENT_PRODUCER_UNAVAILABLE",
          "No verification producer resolves in the agent flow's namespace.",
          { setupRequirement: "Provision the feature's verification-producer flow in this org, then retry." });
      }
      const schema = await request(`${root}/sobjects/${AGENT_CONTACT_OBJECT}/describe`);
      const contactFields = record(schema.body) && Array.isArray(schema.body.fields)
        ? schema.body.fields.filter(record) : null;
      if (!schema.ok || !record(schema.body) || schema.body.createable !== true ||
        schema.body.queryable !== true || schema.body.deletable !== true || !contactFields) {
        return fail("FLOW_AGENT_FIXTURE_PERMISSIONS_REQUIRED",
          "Automatic agent context requires live Contact create, read and delete access.",
          { setupRequirement: "Contact create/read/delete access for the execution user." });
      }
      const built = await input.build(AGENT_CONTACT_OBJECT, marker, { [AGENT_CONTACT_MARKER_FIELD]: marker });
      if ("failure" in built) return built.failure;
      if (built.values[AGENT_CONTACT_MARKER_FIELD] !== marker) {
        return fail("FLOW_AGENT_BUILD_UNSCOPED", "The fixture builder changed a planned ownership field.");
      }
      const values = personIdentityCompletion(
        contactFields.map((field) => ({ name: field.name, type: field.type, createable: field.createable })),
        built.values);
      if (typeof values.Email !== "string" || !values.Email.includes("@")) {
        return fail("FLOW_AGENT_IDENTITY_UNAVAILABLE",
          "The live Contact schema exposes no createable Email field for the producer identity.",
          { setupRequirement: "A createable Contact Email field for the producer identity." });
      }
      const created = await request(`${root}/sobjects/${AGENT_CONTACT_OBJECT}`, "POST", values);
      const createdId: unknown = created.body?.id ?? created.body?.Id;
      if (!created.ok || !identity(createdId)) return created;
      ownedId = createdId;
      const actual = await request(`${root}/sobjects/${AGENT_CONTACT_OBJECT}/${ownedId}`);
      if (!actual.ok || actual.body?.[AGENT_CONTACT_MARKER_FIELD] !== marker) {
        return fail("FLOW_AGENT_FIXTURE_UNVERIFIED", "The owned fixture readback did not carry the marker.");
      }
      const produced = await request(producerRoute, "POST", { inputs: [{ [producerInput]: values.Email }] });
      const producerIdentity = agentProducerIdentity(produced.body);
      if (!produced.ok || !producerIdentity) {
        return fail("FLOW_AGENT_PRODUCER_UNAVAILABLE",
          "The namespace verification producer returned no customer identity for the owned Contact.",
          { setupRequirement: "A verification producer that mints customer identities for probe contacts.", upstreamOutcome: produced.body });
      }
      const args: Value = { [shape.customerInput]: producerIdentity.customerId };
      if (shape.customerTypeInput && producerIdentity.customerType) {
        args[shape.customerTypeInput] = producerIdentity.customerType;
      }
      const invoked = await request(input.route, "POST", { inputs: [args] });
      if (input.verificationWindowMs) await new Promise((resolve) => setTimeout(resolve, input.verificationWindowMs));
      if (nativeAccepted(invoked)) {
        verified = true;
        return invoked;
      }
      return invoked;
    })();
  } catch {
    if (outcome.body?.errorCode === "FLOW_AGENT_CONTEXT_UNAVAILABLE") {
      outcome = fail("FLOW_AGENT_LIFECYCLE_UNVERIFIED", "The producer-backed agent lifecycle failed; ownership-scoped cleanup still runs.");
    }
    verified = false;
  } finally {
    if (ownedId) {
      await request(`${root}/sobjects/${AGENT_CONTACT_OBJECT}/${ownedId}`, "DELETE");
      const check = await request(`${root}/sobjects/${AGENT_CONTACT_OBJECT}/${ownedId}`);
      if (check.status !== 404) {
        cleanupError = "Owned agent fixture cleanup could not be verified; the record may still exist.";
      } else {
        const swept = await request(`${root}/query?q=${encodeURIComponent(
          `SELECT Id FROM ${AGENT_CONTACT_OBJECT} WHERE ${AGENT_CONTACT_MARKER_FIELD}='${marker}' LIMIT 2`)}`);
        const rows = record(swept.body) && Array.isArray(swept.body.records) ? swept.body.records : null;
        if (!swept.ok || !rows || rows.length > 0) {
          cleanupError = "Owned agent fixture cleanup could not be verified; a marker-scoped sibling may remain.";
        }
      }
    }
  }
  return done(outcome, {
    verified: cleanupError ? false : verified,
    marker, markerField: AGENT_CONTACT_MARKER_FIELD,
    ownedRecordId: ownedId ?? null,
    producerRoute: producerRoute ?? null,
    verificationRecordIds: ownedId ? [ownedId] : [],
    ...(cleanupError ? { cleanupError } : {}),
  });
}
