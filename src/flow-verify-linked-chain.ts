/**
 * Output-linked verification-code chain for custom Flow consumers.
 *
 * Root cause (blind-verified on FldSvcAiAgents__VerifyCode): the consumer
 * takes the emailed challenge code plus the producer's customerId,
 * customerType, and authenticationKey. Synthetic codes fault the interview
 * (UNKNOWN_EXCEPTION, never a clean mismatch), so no static fixture can
 * satisfy it. Unlike inbox-chain producers (which mask `verificationCode`
 * as "xxxxxx"), linked producers RETURN the real code in their outputs, so
 * the chain runs the namespace producer against a disposable owned Contact
 * and passes the real outputs through — no receivable inbox involved.
 *
 * Partition from the inbox chain (`flow-verification-code-chain.ts`): that
 * shape requires 2-6 all-STRING inputs. This shape requires a BOOLEAN
 * input (guest/enable flags) alongside the code/id/key STRING inputs, so
 * the two chains never claim the same descriptor. Contact lifecycle,
 * residue sweep, and verified-absence cleanup mirror the inbox chain.
 *
 * Codes live in memory only, are never logged or persisted, and the
 * disposable Contact plus any communication residue is swept and verified
 * absent. Producer discovery, shapes, and values derive from live
 * descriptors; no org IDs, aliases, or tenant values here.
 */

import { agentOutputEntries } from "./agent-customer-context";
import {
  discoverContactChainProducer,
  flowOutputFailureSnippet,
  type ChainRequest,
  type ContactBuild,
  type ContactChainResult,
} from "./flow-fallback-contact-chain";
import {
  sweepFlowCommunicationResidue,
} from "./flow-residue-sweep";

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const CONTACT_ID = /^003[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const ROUTE = /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/custom\/flow\/([A-Za-z][A-Za-z0-9_]{0,127})$/;
const ROUTE_VERB = /verif|confirm|valid/i;
const CODE_INPUT = /(?:verification|verify|auth|otp|one.?time|pass.?code|customer.?code|confirm|challenge).*(?:code|pin|token|key)?|(?:code|otp|pin)$/i;
const ID_INPUT = /(?:customer.?id|user.?id|contact.?id|person.?id|identity.?id|verified.?contact.?id)$/i;
const TYPE_INPUT = /(?:customer.?type|user.?type|contact.?type|id.?type|identity.?type)$/i;
const KEY_INPUT = /(?:authentication.?key|auth.?key|session.?key|challenge.?key|request.?id|correlation.?id)$/i;
const EMAIL_INPUT = /email/i;
const GUEST_INPUT = /guest|enable/i;
const MESSAGE_OUTPUT = /(?:message|prompt|notice|result|summary)$/i;
const VERIFIED_OUTPUT = /^(?:is.?verified|verified|verification.?status|success)$/i;

type Field = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const fieldsOf = (value: unknown): Field[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

export type VerifyLinkedConsumerShape = {
  codeInput: string;
  idInput: string;
  keyInput: string;
  typeInput?: string;
  emailInput?: string;
  guestInput?: string;
};

/**
 * Re-derive the output-linked consumer shape from the live consumer
 * descriptor. Requires 2-7 optional single inputs (STRING or BOOLEAN)
 * including code/id/key STRING inputs, at least one BOOLEAN input (the
 * inbox-chain partition), and a verification or message output. Null when
 * the shape does not match (never guessed).
 */
export function verifyLinkedConsumerShape(descriptor: unknown, route: string): VerifyLinkedConsumerShape | null {
  if (!isRecord(descriptor)) return null;
  if (typeof route !== "string" || !ROUTE_VERB.test(route.split("/").at(-1) ?? "")) return null;
  const inputs = fieldsOf(descriptor.inputs);
  const outputs = fieldsOf(descriptor.outputs);
  if (!Array.isArray(descriptor.inputs) || !Array.isArray(descriptor.outputs)) return null;
  if (inputs.length < 2 || inputs.length > 7) return null;
  let booleans = 0;
  for (const field of inputs) {
    if (typeof field.name !== "string" || !FIELD_NAME.test(field.name)) return null;
    const type = String(field.type ?? "").toUpperCase();
    if ((type !== "STRING" && type !== "BOOLEAN") || field.required === true) return null;
    if (typeof field.maxOccurs === "number" && field.maxOccurs > 1) return null;
    if (type === "BOOLEAN") booleans += 1;
  }
  if (booleans < 1) return null;
  const strings = inputs.filter((field) => String(field.type ?? "").toUpperCase() === "STRING");
  const byName = (re: RegExp): Field | undefined => strings.find((f) => re.test(String(f.name)));
  const code = strings.find((f) => CODE_INPUT.test(String(f.name)) && !KEY_INPUT.test(String(f.name)));
  const id = byName(ID_INPUT);
  const key = byName(KEY_INPUT);
  if (!code || !id || !key) return null;
  const verified = outputs.some((f) =>
    typeof f.name === "string" && VERIFIED_OUTPUT.test(f.name) && !f.name.toLowerCase().startsWith("flow__"));
  const message = outputs.some((f) =>
    typeof f.name === "string" && !f.name.toLowerCase().startsWith("flow__") &&
    MESSAGE_OUTPUT.test(f.name) && String(f.type ?? "STRING").toUpperCase() === "STRING");
  if (!verified && !message) return null;
  const shape: VerifyLinkedConsumerShape = { codeInput: code.name as string, idInput: id.name as string, keyInput: key.name as string };
  const typeInput = byName(TYPE_INPUT);
  const emailInput = byName(EMAIL_INPUT);
  const guestInput = inputs.find((f) => String(f.type ?? "").toUpperCase() === "BOOLEAN" && GUEST_INPUT.test(String(f.name)));
  if (typeInput) shape.typeInput = typeInput.name as string;
  if (emailInput) shape.emailInput = emailInput.name as string;
  if (guestInput) shape.guestInput = guestInput.name as string;
  return shape;
}

export type VerifyLinkedProducerShape = {
  emailInput: string;
  guestInput?: string;
};

/**
 * Producer shape: outputs carry the linked-challenge triple
 * (verificationCode, authenticationKey, customerId) plus a customer-type
 * output under either conventional name, and every input is optional with
 * an email/user STRING input for the owned identity.
 */
export function verifyLinkedProducerShape(descriptor: unknown): VerifyLinkedProducerShape | null {
  if (!isRecord(descriptor)) return null;
  const inputs = fieldsOf(descriptor.inputs);
  const outputs = fieldsOf(descriptor.outputs);
  if (!Array.isArray(descriptor.inputs) || !Array.isArray(descriptor.outputs)) return null;
  const names = new Set(outputs.map((entry) => entry.name).filter((name): name is string => typeof name === "string"));
  if (!["verificationCode", "authenticationKey", "customerId"].every((name) => names.has(name))) return null;
  if (!["customerType", "customerIdType"].some((name) => names.has(name))) return null;
  for (const field of inputs) {
    if (typeof field.name !== "string" || !FIELD_NAME.test(field.name)) return null;
    if (field.required === true) return null;
    if (typeof field.maxOccurs === "number" && field.maxOccurs > 1) return null;
  }
  const emailInput = inputs.find((field) => String(field.type ?? "").toUpperCase() === "STRING" &&
    /(?:user|email)/i.test(String(field.name)));
  if (!emailInput) return null;
  const shape: VerifyLinkedProducerShape = { emailInput: emailInput.name as string };
  const guestInput = inputs.find((field) => String(field.type ?? "").toUpperCase() === "BOOLEAN" &&
    GUEST_INPUT.test(String(field.name)));
  if (guestInput) shape.guestInput = guestInput.name as string;
  return shape;
}

/**
 * Searcher dispatch predicate over stored inputs: custom Flow route verb
 * plus stored code/id/key input names and a stored BOOLEAN input. The Auth
 * entrypoint re-validates the live descriptor before executing (stored
 * inputs are never trusted for shape).
 */
export function needsVerifyLinkedChain(actionType: unknown, route: unknown, inputs: unknown): boolean {
  if (actionType !== "custom/flow" || typeof route !== "string") return false;
  if (!ROUTE_VERB.test(route.split("/").at(-1) ?? "")) return false;
  const fields = fieldsOf(inputs);
  if (fields.length < 2 || fields.length > 7) return false;
  const strings = fields.filter((field) => String(field.type ?? "").toUpperCase() === "STRING" &&
    typeof field.name === "string");
  const hasBoolean = fields.some((field) => String(field.type ?? "").toUpperCase() === "BOOLEAN");
  if (!hasBoolean) return false;
  const code = strings.some((field) => CODE_INPUT.test(field.name as string) && !KEY_INPUT.test(field.name as string));
  const id = strings.some((field) => ID_INPUT.test(field.name as string));
  const key = strings.some((field) => KEY_INPUT.test(field.name as string));
  return code && id && key;
}

export async function invokeFlowVerifyLinkedChain(input: {
  root: string;
  route: string;
  request: ChainRequest;
  build: ContactBuild;
}): Promise<ContactChainResult & { contextSchema?: Record<string, unknown> }> {
  const { root, route, request, build } = input;
  const match = typeof route === "string" ? route.match(ROUTE) : null;
  const rootOk = typeof root === "string" && new RegExp(`^/services/data/${match?.[1]}$`).test(root);
  if (!match || !rootOk) {
    return { status: 400, body: { errorCode: "FLOW_VERIFY_LINKED_ROUTE_INVALID", message: "A discovered Flow route and matching API root are required." } };
  }
  const consumerName = match[2];
  const automaticSteps = [
    "Validate the live consumer descriptor against the linked-challenge shape",
    "Discover the namespace send-side producer returning the real code outputs",
    "Create a disposable owned Contact with an undeliverable identity",
    "Run the producer and pass its real code, key, and customer outputs to the consumer",
    "Delete only the owned Contact and verify absence",
  ];
  const done = (outcome: { status: number; body: unknown }, extra: Record<string, unknown>):
    ContactChainResult & { contextSchema?: Record<string, unknown> } => ({
    status: outcome.status, body: outcome.body,
    ...(typeof extra.cleanupError === "string" ? { cleanupError: extra.cleanupError } : {}),
    contextSchema: {
      source: "salesforce_live_flow_verify_linked_chain", action: consumerName, automaticSteps, ...extra,
    },
  });
  const described = await request(route);
  if (!described.ok) return done(described, { verified: false });
  const shape = verifyLinkedConsumerShape(described.body, route);
  if (!shape) {
    return done({ status: 422, body: { errorCode: "FLOW_VERIFY_LINKED_SHAPE_INVALID", message: "The live Flow is not an output-linked verification consumer with code, identity, and key inputs." } }, { verified: false });
  }
  const catalog = await request(`${root}/actions/custom/flow`);
  if (!catalog.ok) return done(catalog, { verified: false });
  const producerName = discoverContactChainProducer(catalog.body, consumerName);
  if (!producerName) {
    return done({ status: 422, body: { errorCode: "FLOW_VERIFY_LINKED_PRODUCER_UNAVAILABLE", message: "The live Flow catalog does not expose one matching send-side challenge producer." } }, { verified: false });
  }
  const producerRoute = `${root}/actions/custom/flow/${producerName}`;
  const producerDescribed = await request(producerRoute);
  if (!producerDescribed.ok) return done(producerDescribed, { verified: false });
  const producerShape = verifyLinkedProducerShape(producerDescribed.body);
  if (!producerShape) {
    return done({ status: 422, body: { errorCode: "FLOW_VERIFY_LINKED_PRODUCER_SCHEMA_INVALID", message: "The send-side producer does not return the linked challenge outputs for the owned identity." } }, { verified: false });
  }
  const contactSchema = await request(`${root}/sobjects/Contact/describe`);
  if (!contactSchema.ok) return done(contactSchema, { verified: false });
  const contactBody = isRecord(contactSchema.body) ? contactSchema.body : null;
  const emailField = contactBody && Array.isArray(contactBody.fields)
    ? contactBody.fields.filter(isRecord).find((field) => field.name === "Email")
    : null;
  if (!contactBody || !emailField || emailField.createable !== true || contactBody.createable !== true ||
    contactBody.queryable !== true || contactBody.deletable !== true) {
    return done({ status: 403, body: { errorCode: "FLOW_VERIFY_LINKED_PERMISSION_REQUIRED", message: "Automatic linked-chain context needs create/read/delete Contact access and Email write access." } }, { verified: false });
  }
  const ownedEmail = `verify-linked-${crypto.randomUUID()}@example.invalid`;
  const built = await build({ Email: ownedEmail });
  if ("failure" in built) return done(built.failure, { verified: false });
  const created = await request(`${root}/sobjects/Contact`, "POST", built.values);
  const id = isRecord(created.body) ? (created.body.id ?? created.body.Id) : null;
  if (!created.ok || typeof id !== "string" || !CONTACT_ID.test(id)) return done(created, { verified: false });
  let cleanupError: string | undefined;
  let result: { status: number; body: unknown };
  let verified = false;
  try {
    const actual = await request(`${root}/sobjects/Contact/${id}`);
    if (!actual.ok || !isRecord(actual.body) || actual.body.Id !== id || actual.body.Email !== ownedEmail) {
      result = { status: 422, body: { errorCode: "FLOW_VERIFY_LINKED_FIXTURE_UNVERIFIED", message: "The disposable chain Contact failed independent readback." } };
    } else {
      const producerArgs: Record<string, unknown> = { [producerShape.emailInput]: ownedEmail };
      if (producerShape.guestInput) producerArgs[producerShape.guestInput] = false;
      const challenge = await request(producerRoute, "POST", { inputs: [producerArgs] });
      const challengeResult = Array.isArray(challenge.body) ? challenge.body.find(isRecord) : null;
      const values = challengeResult ? Object.fromEntries(agentOutputEntries(challengeResult).map((entry) =>
        [String(entry.name ?? entry.key ?? ""), entry.value])) : null;
      const code = values?.[shape.codeInput];
      const key = shape.keyInput ? values?.[shape.keyInput] : undefined;
      const customerId = values?.[shape.idInput];
      if (!challenge.ok || challengeResult?.isSuccess !== true || !values ||
        typeof code !== "string" || !code || typeof key !== "string" || !key ||
        typeof customerId !== "string" || !RECORD_ID.test(customerId)) {
        result = { status: challenge.ok ? 422 : challenge.status, body: { errorCode: "FLOW_VERIFY_LINKED_CHALLENGE_UNAVAILABLE", message: "Salesforce did not supply a usable linked challenge context for the owned chain identity." } };
      } else if (customerId !== id) {
        result = { status: 422, body: { errorCode: "FLOW_VERIFY_LINKED_CHALLENGE_MISMATCH", message: "The producer resolved a different identity than the owned chain Contact; the challenge was not issued for the disposable identity." } };
      } else {
        const args: Record<string, unknown> = { [shape.codeInput]: code, [shape.idInput]: customerId, [shape.keyInput]: key };
        if (shape.typeInput && typeof values[shape.typeInput] === "string") args[shape.typeInput] = values[shape.typeInput];
        if (shape.emailInput) args[shape.emailInput] = ownedEmail;
        if (shape.guestInput) {
          const guestOut = values[shape.guestInput];
          args[shape.guestInput] = typeof guestOut === "boolean" ? guestOut : false;
        }
        const invocation = await request(route, "POST", { inputs: [args] });
        result = assessLinkedVerifyInvocation(invocation.status, invocation.body);
        verified = result.status === 200;
      }
    }
  } finally {
    const residueSweep = await sweepFlowCommunicationResidue(request, root, { contactIds: [id], emails: [ownedEmail] });
    if (residueSweep.queried && !residueSweep.verified) {
      cleanupError = "Temporary chain communication residue cleanup could not be verified.";
    }
    const deleted = await request(`${root}/sobjects/Contact/${id}`, "DELETE");
    const gone = await request(`${root}/sobjects/Contact/${id}`);
    if ((!deleted.ok && deleted.status !== 404) || gone.status !== 404) {
      cleanupError = "Temporary chain Contact cleanup could not be verified.";
    }
  }
  return done(result, {
    verified: cleanupError ? false : verified,
    producerRoute,
    codeInput: shape.codeInput,
    idInput: shape.idInput,
    requirement: "The consumer inputs carry the producer's real code, key, and customer outputs for a disposable owned Contact. Codes live in memory only and are never persisted.",
  });
}

function assessLinkedVerifyInvocation(status: number, body: unknown): { status: number; body: unknown } {
  if (status !== 200 || !Array.isArray(body) || body.length !== 1 || !isRecord(body[0])) {
    return { status: 422, body: { errorCode: "FLOW_VERIFY_LINKED_CONSUMER_FAILED", message: "Salesforce did not return one Flow execution result." } };
  }
  const result = body[0];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const outputValues = isRecord(result.outputValues) ? result.outputValues : {};
  if (result.isSuccess !== true || errors.length > 0 || outputValues.Flow__InterviewStatus !== "Finished") {
    const detail = errors.map((entry) => isRecord(entry) && typeof entry.message === "string" ? entry.message : null).find(Boolean)
      ?? "The consumer Flow reported failure.";
    return { status: 422, body: { errorCode: "FLOW_VERIFY_LINKED_CONSUMER_FAILED", message: String(detail).slice(0, 300) } };
  }
  for (const [name, value] of Object.entries(outputValues)) {
    if (name === "Flow__InterviewGuid") continue;
    if (flowOutputFailureSnippet(value)) {
      return { status: 422, body: { errorCode: "FLOW_VERIFY_LINKED_CONSUMER_FAILED", message: "The consumer Flow reported its own operation failed." } };
    }
  }
  const verifiedEntry = Object.entries(outputValues).find(([name]) => VERIFIED_OUTPUT.test(name));
  if (verifiedEntry && verifiedEntry[1] !== true && String(verifiedEntry[1]).toLowerCase() !== "true") {
    return { status: 422, body: { errorCode: "FLOW_VERIFY_LINKED_CONSUMER_UNVERIFIED", message: "The consumer Flow did not report a verified identity." } };
  }
  return { status, body };
}
