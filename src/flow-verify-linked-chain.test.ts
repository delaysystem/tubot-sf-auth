import { describe, expect, it } from "bun:test";
import {
  invokeFlowVerifyLinkedChain,
  needsVerifyLinkedChain,
  verifyLinkedConsumerShape,
  verifyLinkedProducerShape,
} from "./flow-verify-linked-chain";
import type { ChainRequest } from "./flow-fallback-contact-chain";

const ROOT = "/services/data/v67.0";
const ROUTE = `${ROOT}/actions/custom/flow/FldSvcAiAgents__VerifyCode`;
const PRODUCER_ROUTE = `${ROOT}/actions/custom/flow/FldSvcAiAgents__SendVerificationCode`;

/** Live shapes transcribed from the sdostainless org via the Salesforce CLI. */
const CONSUMER = {
  description: "Compares the code entered by the customer with the code emailed to the customer.",
  inputs: [
    { name: "verificationCode", type: "STRING", required: false, maxOccurs: 1 },
    { name: "customerId", type: "STRING", required: false, maxOccurs: 1 },
    { name: "customerIdType", type: "STRING", required: false, maxOccurs: 1 },
    { name: "authenticationKey", type: "STRING", required: false, maxOccurs: 1 },
    { name: "emailToVerify", type: "STRING", required: false, maxOccurs: 1 },
    { name: "isGuestUser", type: "BOOLEAN", required: false, maxOccurs: 1 },
  ],
  outputs: [
    { name: "isVerified", type: "BOOLEAN" },
    { name: "messageAfterVerification", type: "STRING" },
    { name: "Flow__InterviewStatus", type: "PICKLIST" },
    { name: "Flow__InterviewGuid", type: "STRING" },
  ],
};
const PRODUCER = {
  inputs: [
    { name: "enableGuestUser", type: "BOOLEAN", required: false, maxOccurs: 1 },
    { name: "incomingPhoneNumber", type: "STRING", required: false, maxOccurs: 1 },
    { name: "userToVerify", type: "STRING", required: false, maxOccurs: 1 },
  ],
  outputs: [
    { name: "authenticationKey" }, { name: "customerId" }, { name: "customerIdType" },
    { name: "emailToVerify" }, { name: "isGuestUser" }, { name: "verificationCode" },
  ],
};
const CATALOG = { actions: [{ name: "FldSvcAiAgents__SendVerificationCode" }, { name: "FldSvcAiAgents__VerifyCode" }] };
const CONTACT_DESCRIBE = { createable: true, queryable: true, deletable: true, fields: [{ name: "Email", type: "email", createable: true }] };

const ok = (body: unknown = {}) => ({ status: 200, ok: true, body });

describe("verifyLinkedConsumerShape", () => {
  it("accepts the linked consumer and rejects other shapes", () => {
    expect(verifyLinkedConsumerShape(CONSUMER, ROUTE)).toEqual({
      codeInput: "verificationCode", idInput: "customerId", keyInput: "authenticationKey",
      typeInput: "customerIdType", emailInput: "emailToVerify", guestInput: "isGuestUser",
    });
    // No boolean input: the inbox-chain partition, never this chain.
    expect(verifyLinkedConsumerShape({
      ...CONSUMER,
      inputs: CONSUMER.inputs.filter((field) => field.type === "STRING"),
    }, ROUTE)).toBeNull();
    // No key input: not a linked challenge.
    expect(verifyLinkedConsumerShape({
      ...CONSUMER,
      inputs: CONSUMER.inputs.filter((field) => field.name !== "authenticationKey"),
    }, ROUTE)).toBeNull();
    expect(verifyLinkedConsumerShape(CONSUMER, `${ROOT}/actions/custom/flow/FldSvcAiAgents__CloseCase`)).toBeNull();
  });
});

describe("verifyLinkedProducerShape", () => {
  it("accepts the send-side producer under either type-output name", () => {
    expect(verifyLinkedProducerShape(PRODUCER)).toEqual({ emailInput: "userToVerify", guestInput: "enableGuestUser" });
    expect(verifyLinkedProducerShape({
      inputs: PRODUCER.inputs,
      outputs: [{ name: "verificationCode" }, { name: "authenticationKey" }, { name: "customerId" }, { name: "customerType" }],
    })).toEqual({ emailInput: "userToVerify", guestInput: "enableGuestUser" });
    expect(verifyLinkedProducerShape({
      inputs: PRODUCER.inputs,
      outputs: [{ name: "verificationCode" }, { name: "customerId" }],
    })).toBeNull();
    expect(verifyLinkedProducerShape({
      inputs: [{ name: "userToVerify", type: "STRING", required: true, maxOccurs: 1 }],
      outputs: PRODUCER.outputs,
    })).toBeNull();
  });
});

describe("needsVerifyLinkedChain", () => {
  it("routes verify consumers with boolean flags from stored inputs", () => {
    expect(needsVerifyLinkedChain("custom/flow", ROUTE, CONSUMER.inputs)).toBe(true);
    expect(needsVerifyLinkedChain("custom/flow", ROUTE, CONSUMER.inputs.filter((field) => field.type === "STRING"))).toBe(false);
    expect(needsVerifyLinkedChain("standard", ROUTE, CONSUMER.inputs)).toBe(false);
    expect(needsVerifyLinkedChain("custom/flow", `${ROOT}/actions/custom/flow/FldSvcAiAgents__CloseCase`, CONSUMER.inputs)).toBe(false);
  });
});

describe("invokeFlowVerifyLinkedChain", () => {
  const contactId = "003g50000001AAAAAQ";
  const producerOutputs = (overrides: Record<string, unknown> = {}) => ({
    verificationCode: "096803", authenticationKey: "key-1", customerId: contactId,
    customerIdType: "Contact", emailToVerify: null, isGuestUser: false, ...overrides,
  });
  const setup = (consumerValues: Record<string, unknown>, challengeOutputs?: Record<string, unknown>) => {
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    let contact: Record<string, unknown> | null = null;
    const request: ChainRequest = async (path, method = "GET", body) => {
      calls.push({ path, method, body });
      if (path === ROUTE && method === "GET") return ok(CONSUMER);
      if (path === `${ROOT}/actions/custom/flow` && method === "GET") return ok(CATALOG);
      if (path === PRODUCER_ROUTE && method === "GET") return ok(PRODUCER);
      if (path === `${ROOT}/sobjects/Contact/describe`) return ok(CONTACT_DESCRIBE);
      if (path === `${ROOT}/sobjects/Contact` && method === "POST") {
        const values = body as Record<string, unknown>;
        contact = { Id: contactId, Email: values.Email };
        return ok({ id: contactId });
      }
      if (path === `${ROOT}/sobjects/Contact/${contactId}` && method === "GET") {
        return contact ? ok(contact) : { status: 404, ok: false, body: {} };
      }
      if (path === `${ROOT}/sobjects/Contact/${contactId}` && method === "DELETE") {
        contact = null;
        return ok({});
      }
      if (path === PRODUCER_ROUTE && method === "POST") {
        return ok([{ isSuccess: true, errors: null, outputValues: challengeOutputs ?? producerOutputs() }]);
      }
      if (path === ROUTE && method === "POST") {
        return ok([{ isSuccess: true, errors: null, outputValues: consumerValues }]);
      }
      if (path.includes("/query?")) return ok({ records: [] });
      return { status: 500, ok: false, body: {} };
    };
    return { calls, request };
  };

  it("chains producer outputs into the consumer with verified cleanup", async () => {
    const { calls, request } = setup({ isVerified: true, messageAfterVerification: "Your verification was successful!", Flow__InterviewStatus: "Finished", Flow__InterviewGuid: "g" });
    const result = await invokeFlowVerifyLinkedChain({ root: ROOT, route: ROUTE, request, build: async (values) => ({ values }) });
    expect(result.status).toBe(200);
    expect(result.cleanupError).toBeUndefined();
    expect((result.contextSchema as Record<string, unknown>).verified).toBe(true);
    const producerCall = calls.find((c) => c.path === PRODUCER_ROUTE && c.method === "POST");
    const producerArgs = (producerCall?.body as { inputs: Array<Record<string, unknown>> }).inputs[0];
    expect(producerArgs.userToVerify).toMatch(/@example\.invalid$/);
    expect(producerArgs.enableGuestUser).toBe(false);
    const consumerCall = calls.find((c) => c.path === ROUTE && c.method === "POST");
    const args = (consumerCall?.body as { inputs: Array<Record<string, unknown>> }).inputs[0];
    expect(args).toEqual({
      verificationCode: "096803", customerId: contactId, customerIdType: "Contact",
      authenticationKey: "key-1", emailToVerify: producerArgs.userToVerify, isGuestUser: false,
    });
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("refuses when the producer resolves a different identity", async () => {
    const { calls, request } = setup({ isVerified: true, Flow__InterviewStatus: "Finished" },
      producerOutputs({ customerId: "003g50000009ZZZZZQ" }));
    const result = await invokeFlowVerifyLinkedChain({ root: ROOT, route: ROUTE, request, build: async (values) => ({ values }) });
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body)).toContain("FLOW_VERIFY_LINKED_CHALLENGE_MISMATCH");
    expect(calls.some((c) => c.path === ROUTE && c.method === "POST")).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("rejects an unverified consumer outcome", async () => {
    const { request } = setup({ isVerified: false, messageAfterVerification: "done", Flow__InterviewStatus: "Finished", Flow__InterviewGuid: "g" });
    const result = await invokeFlowVerifyLinkedChain({ root: ROOT, route: ROUTE, request, build: async (values) => ({ values }) });
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body)).toContain("FLOW_VERIFY_LINKED_CONSUMER_UNVERIFIED");
  });
});
