/**
 * Verified-contact consumer chain for metadata-hidden custom Flow actions.
 *
 * Root cause (blind-verified): consumers such as ResetScrPassword take a
 * single `verifiedContactID` input documented as coming from an upstream
 * verification topic. No static fixture can supply it; the chain must run the
 * namespace verification producer first and pass its real `customerId`.
 * Probing the consumer with a synthetic ID can never succeed, and the
 * consumer sends a real delivery attempt, so the probe identity must be a
 * disposable owned Contact carrying an undeliverable `@example.invalid`
 * address (which can never reach a real recipient), with EmailMessage/Task
 * residue swept and verified absent afterwards.
 *
 * Injection style mirrors `flow-update-contract.ts`: the entrypoint (owned by
 * the parent) supplies `request` and `build`; this module owns the lifecycle.
 * Zero hardcoding: producer discovery, shapes, and values all derive from
 * live descriptors and generated UUIDs. No org IDs, aliases, or URLs here.
 */

import {
  PRODUCER_REQUIRED_OUTPUTS,
  UNDELIVERABLE_DOMAIN,
  verificationProducerInput,
} from "./flow-producer-context";
import {
  sweepFlowCommunicationResidue,
  type ResidueSweep,
} from "./flow-residue-sweep";

export type ChainRequest = (
  path: string,
  method?: string,
  body?: unknown,
) => Promise<{ status: number; ok: boolean; body: unknown }>;

export type ContactBuild = (
  values: Record<string, unknown>,
) => Promise<
  | { values: Record<string, unknown> }
  | { failure: { status: number; body: unknown } }
>;

export type ContactChainResult = {
  status: number;
  body: unknown;
  cleanupError?: string;
  contextSchema?: unknown;
};

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const CONTACT_ID = /^003[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const ROUTE = /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/;
const PRODUCER_NAME = /send.*verification.*code/i;
const CHAINED_IDENTITY_DOC = /verif/i;
const CHAINED_IDENTITY_SUBJECT = /(?:contact|user|customer|identit|member)/i;
const MESSAGE_OUTPUT = /(?:message|prompt|notice|result|summary)$/i;
/** Mirror of the searcher soft-failure vocabulary; keep in sync. */
const FAILURE_TEXT =
  /(?:an?\s+error\s+occurred|error\b|errors\b|failed|failure|fault|couldn.?t|cannot|can.?t\b|unable\b|invalid|exception|was not|were not|not valid|no longer|missing|denied|required\b)/i;

type Field = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const fieldsOf = (value: unknown): Field[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const validName = (value: unknown): value is string =>
  typeof value === "string" && FIELD_NAME.test(value);

/** Non-null when a flow output value reports its own operation failed. */
export function flowOutputFailureSnippet(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const match = FAILURE_TEXT.exec(value);
  return match ? match[0].slice(0, 120) : null;
}

/**
 * Discover the namespace verification producer from a live
 * `/actions/custom/flow` catalog body. Returns the validated producer action
 * name, or null unless exactly one same-namespace producer exists (never
 * guessed across namespaces).
 */
export function discoverContactChainProducer(
  catalogBody: unknown,
  consumerName: string,
): string | null {
  if (!isRecord(catalogBody) || !Array.isArray(catalogBody.actions)) return null;
  const namespace = consumerName.includes("__")
    ? consumerName.slice(0, consumerName.indexOf("__"))
    : null;
  const producers = catalogBody.actions.filter(isRecord).filter(
    (entry) =>
      typeof entry.name === "string" &&
      PRODUCER_NAME.test(entry.name) &&
      (namespace
        ? entry.name.startsWith(`${namespace}__`)
        : !entry.name.includes("__")),
  );
  if (producers.length !== 1) return null;
  const name = producers[0].name;
  return typeof name === "string" && FIELD_NAME.test(name) ? name : null;
}

/** Re-derive the chained consumer input from the live consumer descriptor. */
export function chainedConsumerInput(descriptor: unknown): string | null {
  if (!isRecord(descriptor)) return null;
  const inputs = fieldsOf(descriptor.inputs);
  const outputs = fieldsOf(descriptor.outputs);
  if (inputs.length !== 1 || !Array.isArray(descriptor.inputs) || !Array.isArray(descriptor.outputs)) return null;
  const [input] = inputs;
  if (!validName(input.name) || input.type !== "STRING" || input.required === true ||
    (typeof input.maxOccurs === "number" && input.maxOccurs > 1)) {
    return null;
  }
  if (!CHAINED_IDENTITY_DOC.test(String(input.description ?? "")) ||
    !CHAINED_IDENTITY_SUBJECT.test(String(input.description ?? ""))) {
    return null;
  }
  const message = outputs.some((field) =>
    validName(field.name) && !field.name.toLowerCase().startsWith("flow__") &&
    MESSAGE_OUTPUT.test(field.name) && String(field.type ?? "STRING").toUpperCase() === "STRING");
  return message ? (input.name as string) : null;
}

function messageOutputNames(outputs: Field[]): string[] {
  return outputs
    .filter((field) =>
      validName(field.name) && !field.name.toLowerCase().startsWith("flow__") &&
      MESSAGE_OUTPUT.test(field.name) && String(field.type ?? "STRING").toUpperCase() === "STRING")
    .map((field) => field.name as string);
}

/**
 * Run the verified-contact consumer chain: disposable owned Contact, live
 * producer challenge, consumer invocation with the real customerId, residue
 * sweep, and verified cleanup. Every mutation is read back; nothing
 * probe-owned may survive.
 */
export async function invokeFlowContactChain(input: {
  root: string;
  route: string;
  request: ChainRequest;
  build: ContactBuild;
}): Promise<ContactChainResult> {
  const { root, route, request, build } = input;
  const match = typeof route === "string" ? route.match(ROUTE) : null;
  const rootOk = typeof root === "string" && new RegExp(`^/services/data/${match?.[1]}$`).test(root);
  if (!match || !rootOk) {
    return { status: 400, body: { errorCode: "FLOW_CONTACT_CHAIN_ROUTE_INVALID", message: "A discovered Flow route and matching API root are required." } };
  }
  const consumerName = match[2];
  const described = await request(route);
  if (!described.ok) return described;
  const chainedInput = chainedConsumerInput(described.body);
  if (!chainedInput) {
    return { status: 422, body: { errorCode: "FLOW_CONTACT_CHAIN_SHAPE_INVALID", message: "The live Flow is not a single verified-contact consumer with a message output." } };
  }
  const catalog = await request(`${root}/actions/custom/flow`);
  if (!catalog.ok) return catalog;
  const producerName = discoverContactChainProducer(catalog.body, consumerName);
  if (!producerName) {
    return { status: 422, body: { errorCode: "FLOW_CONTACT_CHAIN_PRODUCER_UNAVAILABLE", message: "The live Flow catalog does not expose one matching verification-challenge producer." } };
  }
  const producerRoute = `${root}/actions/custom/flow/${producerName}`;
  const producerDescribed = await request(producerRoute);
  if (!producerDescribed.ok) return producerDescribed;
  const producerBody = isRecord(producerDescribed.body) ? producerDescribed.body : null;
  const producerField = verificationProducerInput(producerBody?.inputs, producerBody?.outputs);
  if (!producerField) {
    return { status: 422, body: { errorCode: "FLOW_CONTACT_CHAIN_PRODUCER_SCHEMA_INVALID", message: "The challenge producer schema does not supply the consumer's required context." } };
  }
  const contactSchema = await request(`${root}/sobjects/Contact/describe`);
  const emailField = isRecord(contactSchema.body) && Array.isArray(contactSchema.body.fields)
    ? contactSchema.body.fields.filter(isRecord).find((field) => field.name === "Email")
    : null;
  if (!contactSchema.ok) return contactSchema;
  if (!emailField || emailField.createable !== true) {
    return { status: 403, body: { errorCode: "FLOW_CONTACT_CHAIN_PERMISSION_REQUIRED", message: "Automatic contact-chain context needs create/delete Contact access and Email write access. Run setup:context-permissions for the connected org." } };
  }
  const email = `contact-chain-${crypto.randomUUID()}@${UNDELIVERABLE_DOMAIN}`;
  const built = await build({ Email: email });
  if ("failure" in built) return built.failure;
  const created = await request(`${root}/sobjects/Contact`, "POST", built.values);
  const id = isRecord(created.body) ? created.body.id : null;
  if (!created.ok || typeof id !== "string" || !CONTACT_ID.test(id)) return created;
  let cleanupError: string | undefined;
  let residueSweep: ResidueSweep | null = null;
  let result: { status: number; body: unknown };
  try {
    const verified = await request(`${root}/sobjects/Contact/${id}`);
    if (!verified.ok || !isRecord(verified.body) || verified.body.Id !== id || verified.body.Email !== email) {
      result = { status: 422, body: { errorCode: "FLOW_CONTACT_CHAIN_FIXTURE_UNVERIFIED", message: "The disposable chain Contact failed independent readback." } };
    } else {
      const challenge = await request(producerRoute, "POST", { inputs: [{ [producerField]: email }] });
      const challengeResult = Array.isArray(challenge.body) ? challenge.body.find(isRecord) : null;
      const values = challengeResult && isRecord(challengeResult.outputValues) ? challengeResult.outputValues : null;
      if (!challenge.ok || challengeResult?.isSuccess !== true || !values ||
        (PRODUCER_REQUIRED_OUTPUTS as readonly string[]).some((name) => typeof values[name] !== "string" || !values[name])) {
        result = { status: challenge.ok ? 422 : challenge.status, body: { errorCode: "FLOW_CONTACT_CHAIN_CHALLENGE_UNAVAILABLE", message: "Salesforce did not supply a usable code and authentication context for the owned chain identity." } };
      } else {
        const customerId = values.customerId as string;
        if (!RECORD_ID.test(customerId)) {
          result = { status: 422, body: { errorCode: "FLOW_CONTACT_CHAIN_CHALLENGE_UNAVAILABLE", message: "The producer did not return a usable customer record identity." } };
        } else {
          const invocation = await request(route, "POST", { inputs: [{ [chainedInput]: customerId }] });
          result = assessConsumerInvocation(invocation.status, invocation.body,
            messageOutputNames(fieldsOf((isRecord(described.body) ? described.body.outputs : []))));
        }
      }
    }
  } finally {
    residueSweep = await sweepFlowCommunicationResidue(request, root, { contactIds: [id], emails: [email] });
    if (residueSweep.queried && !residueSweep.verified) {
      cleanupError = "Temporary chain communication residue cleanup could not be verified.";
    }
    const deleted = await request(`${root}/sobjects/Contact/${id}`, "DELETE");
    const gone = await request(`${root}/sobjects/Contact/${id}`);
    if ((!deleted.ok && deleted.status !== 404) || gone.status !== 404) {
      cleanupError = "Temporary chain Contact cleanup could not be verified.";
    }
  }
  return {
    ...result,
    contextSchema: {
      source: "salesforce_live_flow_contact_chain",
      producerRoute,
      chainedInput,
      residueSweep,
      requirement: "The consumer input carries the producer's real customerId for a disposable owned Contact. Generated identities use an undeliverable domain and are never persisted.",
    },
    ...(cleanupError ? { cleanupError } : {}),
  };
}

function assessConsumerInvocation(status: number, body: unknown, requiredOutputs: string[]): { status: number; body: unknown } {
  if (status !== 200 || !Array.isArray(body) || body.length !== 1 || !isRecord(body[0])) {
    return { status: 422, body: { errorCode: "FLOW_CONTACT_CHAIN_CONSUMER_FAILED", message: "Salesforce did not return one Flow execution result." } };
  }
  const result = body[0];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const outputValues = isRecord(result.outputValues) ? result.outputValues : {};
  if (result.isSuccess !== true || errors.length > 0 || outputValues.Flow__InterviewStatus !== "Finished") {
    const detail = errors.map((entry) => isRecord(entry) && typeof entry.message === "string" ? entry.message : null).find(Boolean)
      ?? "The consumer Flow reported failure.";
    return { status: 422, body: { errorCode: "FLOW_CONTACT_CHAIN_CONSUMER_FAILED", message: String(detail).slice(0, 300) } };
  }
  for (const [name, value] of Object.entries(outputValues)) {
    if (name === "Flow__InterviewGuid") continue;
    if (flowOutputFailureSnippet(value)) {
      return { status: 422, body: { errorCode: "FLOW_CONTACT_CHAIN_CONSUMER_FAILED", message: `The consumer Flow reported its own operation failed (${String(value).slice(0, 200)}).` } };
    }
  }
  for (const name of requiredOutputs) {
    const value = outputValues[name] ??
      outputValues[Object.keys(outputValues).find((key) => key.toLowerCase() === name.toLowerCase()) ?? ""];
    if (typeof value !== "string" || value.length === 0) {
      return { status: 422, body: { errorCode: "FLOW_CONTACT_CHAIN_CONSUMER_UNVERIFIED", message: `Required output '${name}' was not returned as a usable value.` } };
    }
  }
  return { status, body };
}
