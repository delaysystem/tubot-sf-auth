import { describe, expect, it } from "bun:test";
import {
  chainedConsumerInput,
  discoverContactChainProducer,
  flowOutputFailureSnippet,
  invokeFlowContactChain,
  type ChainRequest,
} from "./flow-fallback-contact-chain";

const ROOT = "/services/data/v67.0";
const ROUTE = `${ROOT}/actions/custom/flow/SvcCopilotTmpl__ResetScrPassword`;

/** Live shapes transcribed from the target orgs via the Salesforce CLI. */
const CONSUMER = {
  inputs: [{ name: "verifiedContactID", type: "STRING", required: false, maxOccurs: 1, description: "Get verified contact ID from verification topic." }],
  outputs: [{ name: "outcomeMessage", type: "STRING" }, { name: "Flow__InterviewStatus", type: "PICKLIST" }, { name: "Flow__InterviewGuid", type: "STRING" }],
};
const PRODUCER = {
  inputs: [{ name: "customerToVerify", type: "STRING", required: false, maxOccurs: 1 }],
  outputs: [{ name: "verificationCode" }, { name: "customerId" }, { name: "customerType" }, { name: "authenticationKey" }, { name: "verificationMessage" }],
};
const CATALOG = { actions: [{ name: "SvcCopilotTmpl__SendVerificationCode", url: `${ROOT}/actions/custom/flow/SvcCopilotTmpl__SendVerificationCode` }, { name: "SvcCopilotTmpl__VerifyCode" }] };
const CONTACT_DESCRIBE = { fields: [{ name: "Email", type: "email", createable: true }] };

const ok = (body: unknown = {}) => ({ status: 200, ok: true, body });

describe("discoverContactChainProducer", () => {
  it("finds the same-namespace producer and rejects ambiguity", () => {
    expect(discoverContactChainProducer(CATALOG, "SvcCopilotTmpl__ResetScrPassword")).toBe("SvcCopilotTmpl__SendVerificationCode");
    expect(discoverContactChainProducer(CATALOG, "other__Consumer")).toBeNull();
    expect(discoverContactChainProducer({ actions: [] }, "SvcCopilotTmpl__ResetScrPassword")).toBeNull();
    expect(discoverContactChainProducer({}, "SvcCopilotTmpl__ResetScrPassword")).toBeNull();
  });
});

describe("chainedConsumerInput", () => {
  it("accepts the verified-contact consumer and rejects other shapes", () => {
    expect(chainedConsumerInput(CONSUMER)).toBe("verifiedContactID");
    expect(chainedConsumerInput({ inputs: [], outputs: CONSUMER.outputs })).toBeNull();
    expect(chainedConsumerInput({ inputs: [{ name: "orderNumber", type: "STRING", description: "An order number." }], outputs: CONSUMER.outputs })).toBeNull();
  });
});

describe("flowOutputFailureSnippet", () => {
  it("mirrors the searcher soft-failure vocabulary", () => {
    expect(flowOutputFailureSnippet("A password reset has been sent")).toBeNull();
    expect(flowOutputFailureSnippet("An error occurred while updating the CI.")).not.toBeNull();
  });
});

describe("invokeFlowContactChain", () => {
  const contactId = "003g50000001AAAAAQ";
  const setup = (consumerValues: Record<string, unknown>) => {
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    let contact: Record<string, unknown> | null = null;
    let emails: Array<{ Id: string }> = [];
    const request: ChainRequest = async (path, method = "GET", body) => {
      calls.push({ path, method, body });
      if (path === ROUTE && method === "GET") return ok(CONSUMER);
      if (path === `${ROOT}/actions/custom/flow` && method === "GET") return ok(CATALOG);
      if (path === `${ROOT}/actions/custom/flow/SvcCopilotTmpl__SendVerificationCode` && method === "GET") return ok(PRODUCER);
      if (path === `${ROOT}/sobjects/Contact/describe`) return ok(CONTACT_DESCRIBE);
      if (path === `${ROOT}/sobjects/Contact` && method === "POST") {
        const values = body as Record<string, unknown>;
        contact = { Id: contactId, Email: values.Email };
        return ok({ id: contactId });
      }
      if (path === `${ROOT}/sobjects/Contact/${contactId}` && method === "GET") {
        return contact ? ok(contact) : { status: 404, ok: false, body: {} };
      }
      if (path === `${ROOT}/actions/custom/flow/SvcCopilotTmpl__SendVerificationCode` && method === "POST") {
        return ok([{ isSuccess: true, errors: null, outputValues: { verificationCode: "123456", customerId: contactId, customerType: "Contact", authenticationKey: "key" } }]);
      }
      if (path === ROUTE && method === "POST") {
        emails = [{ Id: "02sg50000001AAAAAQ" }];
        return ok([{ isSuccess: true, errors: null, outputValues: consumerValues }]);
      }
      if (path.includes("/query?")) {
        const soql = decodeURIComponent(path.split("q=")[1]);
        if (soql.includes("FROM Task ")) return ok({ records: [] });
        if (soql.includes("FROM EmailMessage ")) return ok({ records: emails });
        return { status: 400, ok: false, body: {} };
      }
      if (method === "DELETE" && path.endsWith("02sg50000001AAAAAQ")) { emails = []; return { status: 204, ok: true, body: null }; }
      if (path === `${ROOT}/sobjects/Contact/${contactId}` && method === "DELETE") { contact = null; return { status: 204, ok: true, body: null }; }
      return { status: 400, ok: false, body: {} };
    };
    return { calls, request };
  };
  const build = async (values: Record<string, unknown>) => ({ values: { LastName: "probe", ...values } });

  it("chains producer to consumer, sweeps residue, and cleans the fixture", async () => {
    const { calls, request } = setup({ outcomeMessage: "A password reset has been sent", Flow__InterviewStatus: "Finished", Flow__InterviewGuid: "g" });
    const result = await invokeFlowContactChain({ root: ROOT, route: ROUTE, request, build });
    expect(result.status).toBe(200);
    expect(result.cleanupError).toBeUndefined();
    expect(result.contextSchema).toMatchObject({ source: "salesforce_live_flow_contact_chain", chainedInput: "verifiedContactID" });
    const consumerPost = calls.find((call) => call.path === ROUTE && call.method === "POST");
    expect(consumerPost?.body).toEqual({ inputs: [{ verifiedContactID: contactId }] });
    const producerPost = calls.find((call) => call.path.endsWith("SvcCopilotTmpl__SendVerificationCode") && call.method === "POST");
    const identity = (producerPost?.body as { inputs: Array<Record<string, string>> }).inputs[0].customerToVerify;
    expect(identity).toMatch(/^contact-chain-.*@example\.invalid$/);
    // Residue sweep ran against exact fixture values and verified absence.
    expect(calls.some((call) => call.path.includes(encodeURIComponent(identity)))).toBe(true);
  });

  it("fails closed and still cleans up when the consumer reports failure", async () => {
    const { request } = setup({ outcomeMessage: "An error occurred while sending.", Flow__InterviewStatus: "Finished", Flow__InterviewGuid: "g" });
    const result = await invokeFlowContactChain({ root: ROOT, route: ROUTE, request, build });
    expect(result.status).toBe(422);
    expect(result.cleanupError).toBeUndefined();
    expect((result.body as { errorCode: string }).errorCode).toBe("FLOW_CONTACT_CHAIN_CONSUMER_FAILED");
  });

  it("rejects invalid routes without touching org state", async () => {
    let touched = false;
    const request: ChainRequest = async () => { touched = true; return ok({}); };
    const result = await invokeFlowContactChain({ root: ROOT, route: `${ROOT}/actions/custom/apex/x`, request, build });
    expect(result.status).toBe(400);
    expect(touched).toBe(false);
  });
});
