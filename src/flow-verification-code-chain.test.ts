import { afterEach, describe, expect, it } from "bun:test";
import {
  invokeFlowVerificationCodeChain,
  mailslurpInbox,
  verificationConsumerShape,
  type DisposableInbox,
} from "./flow-verification-code-chain";
import type { ChainRequest } from "./flow-fallback-contact-chain";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const ROOT = "/services/data/v67.0";
const ROUTE = `${ROOT}/actions/custom/flow/SvcCopilotTmpl__VerifyCode`;

/** Live shapes transcribed from the target orgs via the Salesforce CLI. */
const CONSUMER = {
  inputs: [
    { name: "customerCode", type: "STRING", required: false, maxOccurs: 1, description: "Stores the user-provided verification code that's passed into the flow." },
    { name: "customerId", type: "STRING", required: false, maxOccurs: 1, description: "Stores the UserId or ContactID of the User" },
    { name: "customerType", type: "STRING", required: false, maxOccurs: 1, description: "Stores the Id type whether it is User or Contact" },
    { name: "authenticationKey", type: "STRING", required: false, maxOccurs: 1, description: "" },
  ],
  outputs: [{ name: "isVerified", type: "BOOLEAN" }, { name: "messageAfterVerification", type: "STRING" }, { name: "Flow__InterviewStatus", type: "PICKLIST" }, { name: "Flow__InterviewGuid", type: "STRING" }],
};
const PRODUCER = {
  inputs: [{ name: "customerToVerify", type: "STRING", required: false, maxOccurs: 1 }],
  outputs: [{ name: "verificationCode" }, { name: "customerId" }, { name: "customerType" }, { name: "authenticationKey" }, { name: "verificationMessage" }],
};
const CATALOG = { actions: [{ name: "SvcCopilotTmpl__SendVerificationCode" }, { name: "SvcCopilotTmpl__VerifyCode" }] };
const CONTACT_DESCRIBE = { fields: [{ name: "Email", type: "email", createable: true }] };

const ok = (body: unknown = {}) => ({ status: 200, ok: true, body });

describe("verificationConsumerShape", () => {
  it("accepts the verify-code consumer and rejects other shapes", () => {
    expect(verificationConsumerShape(CONSUMER, ROUTE)).toEqual({
      codeInput: "customerCode", idInput: "customerId", typeInput: "customerType", keyInput: "authenticationKey",
    });
    expect(verificationConsumerShape({ inputs: [], outputs: CONSUMER.outputs }, ROUTE)).toBeNull();
    expect(verificationConsumerShape(CONSUMER, `${ROOT}/actions/custom/flow/SvcCopilotTmpl__CloseCase`)).toBeNull();
    expect(verificationConsumerShape({
      inputs: [{ name: "orderNumber", type: "STRING" }, { name: "customerId", type: "STRING" }],
      outputs: CONSUMER.outputs,
    }, ROUTE)).toBeNull();
  });
});

describe("invokeFlowVerificationCodeChain", () => {
  const contactId = "003g50000001AAAAAQ";
  const setup = (consumerValues: Record<string, unknown>, code: string | null = "841733") => {
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    let contact: Record<string, unknown> | null = null;
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
      if (path === `${ROOT}/sobjects/Contact/${contactId}` && method === "DELETE") {
        contact = null;
        return ok({});
      }
      if (path === `${ROOT}/actions/custom/flow/SvcCopilotTmpl__SendVerificationCode` && method === "POST") {
        return ok([{ isSuccess: true, errors: null, outputValues: { verificationCode: "xxxxxx", customerId: contactId, customerType: "Contact", authenticationKey: "key" } }]);
      }
      if (path === ROUTE && method === "POST") {
        return ok([{ isSuccess: true, errors: null, outputValues: consumerValues }]);
      }
      if (path.includes("/query?")) return ok({ records: [] });
      return { status: 500, ok: false, body: {} };
    };
    const inbox: DisposableInbox = {
      address: async () => ({ email: "probe@example.com", token: "token" }),
      check: async () => code,
    };
    return { calls, request, inbox };
  };

  it("chains producer, inbox code, and consumer with verified cleanup", async () => {
    const { calls, request, inbox } = setup({ isVerified: true, messageAfterVerification: "Your verification was successful!", Flow__InterviewStatus: "Finished", Flow__InterviewGuid: "g" });
    const result = await invokeFlowVerificationCodeChain({ root: ROOT, route: ROUTE, request, build: async (values) => ({ values }), inbox });
    expect(result.status).toBe(200);
    expect(result.cleanupError).toBeUndefined();
    const consumerCall = calls.find((c) => c.path === ROUTE && c.method === "POST");
    const args = (consumerCall?.body as { inputs: Array<Record<string, unknown>> }).inputs[0];
    expect(args).toEqual({ customerCode: "841733", customerId: contactId, customerType: "Contact", authenticationKey: "key" });
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("refuses when no code is delivered and still cleans the contact", async () => {
    const { calls, request, inbox } = setup({ isVerified: true, Flow__InterviewStatus: "Finished" }, null);
    const result = await invokeFlowVerificationCodeChain({ root: ROOT, route: ROUTE, request, build: async (values) => ({ values }), inbox, poll: { attempts: 2, intervalMs: 0 } });
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body)).toContain("FLOW_VERIFY_CHAIN_CODE_UNDELIVERED");
    expect(calls.some((c) => c.path === ROUTE && c.method === "POST")).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("fast-fails a lost seed-mail session instead of burning the window", async () => {
    const { request } = setup({ isVerified: true, Flow__InterviewStatus: "Finished" });
    let reads = 0;
    const inbox: DisposableInbox = {
      address: async () => ({ email: "probe@example.com", token: "token" }),
      check: async () => { reads++; return null; },
      lastMailCount: () => 0,
      expectsSeedMail: true,
    };
    const result = await invokeFlowVerificationCodeChain({ root: ROOT, route: ROUTE, request, build: async (values) => ({ values }), inbox, poll: { attempts: 24, intervalMs: 0 } });
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body)).toContain("FLOW_VERIFY_CHAIN_INBOX_UNREACHABLE");
    expect(reads).toBe(4);
  });

  it("keeps polling past 20 attempts when the inbox shows mail", async () => {
    const { request } = setup({ isVerified: true, Flow__InterviewStatus: "Finished" });
    let reads = 0;
    const inbox: DisposableInbox = {
      address: async () => ({ email: "probe@example.com", token: "token" }),
      check: async () => { reads++; return reads >= 22 ? "841733" : null; },
      lastMailCount: () => 1,
    };
    const result = await invokeFlowVerificationCodeChain({ root: ROOT, route: ROUTE, request, build: async (values) => ({ values }), inbox, poll: { attempts: 24, intervalMs: 0 } });
    expect(result.status).toBe(200);
    expect(reads).toBe(22);
  });

  it("refuses when the producer resolves a different identity", async () => {
    const contactId = "003g50000001AAAAAQ";
    const calls: string[] = [];
    const request = (async (path: string, method = "GET", body?: unknown) => {
      calls.push(`${method} ${path}`);
      if (path === ROUTE && method === "GET") return ok(CONSUMER);
      if (path === `${ROOT}/actions/custom/flow` && method === "GET") return ok(CATALOG);
      if (path === `${ROOT}/actions/custom/flow/SvcCopilotTmpl__SendVerificationCode` && method === "GET") return ok(PRODUCER);
      if (path === `${ROOT}/sobjects/Contact/describe`) return ok(CONTACT_DESCRIBE);
      if (path === `${ROOT}/sobjects/Contact` && method === "POST") return ok({ id: contactId });
      if (path === `${ROOT}/sobjects/Contact/${contactId}` && method === "GET") {
        return ok({ Id: contactId, Email: (body as Record<string, unknown> | undefined)?.Email ?? "probe@example.com" });
      }
      if (path === `${ROOT}/sobjects/Contact/${contactId}` && method === "DELETE") return ok({});
      if (path === `${ROOT}/actions/custom/flow/SvcCopilotTmpl__SendVerificationCode` && method === "POST") {
        return ok([{ isSuccess: true, errors: null, outputValues: { verificationCode: "xxxxxx", customerId: "003g50000009ZZZZZQ", customerType: "Contact", authenticationKey: "key" } }]);
      }
      if (path.includes("/query?")) return ok({ records: [] });
      return { status: 500, ok: false, body: {} };
    }) as ChainRequest;
    const inbox: DisposableInbox = { address: async () => ({ email: "probe@example.com", token: "tokentokentoken" }), check: async () => "123456" };
    const result = await invokeFlowVerificationCodeChain({ root: ROOT, route: ROUTE, request, build: async (values) => ({ values }), inbox });
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body)).toContain("FLOW_VERIFY_CHAIN_CHALLENGE_MISMATCH");
    expect(calls.some((c) => c === `POST ${ROUTE}`)).toBe(false);
  });

  it("rejects an unverified consumer outcome", async () => {
    const { request, inbox } = setup({ isVerified: false, messageAfterVerification: "done", Flow__InterviewStatus: "Finished", Flow__InterviewGuid: "g" });
    const result = await invokeFlowVerificationCodeChain({ root: ROOT, route: ROUTE, request, build: async (values) => ({ values }), inbox });
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body)).toContain("FLOW_VERIFY_CHAIN_CONSUMER_UNVERIFIED");
  });
});

describe("mailslurpInbox", () => {
  const stubFetch = (routes: Record<string, unknown>) => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
      const url = new URL(String(input));
      seen.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const body = routes[url.pathname];
      if (body === undefined) return new Response("{}", { status: 404 });
      if (body === null) return new Response(null, { status: 204 });
      return Response.json(body);
    }) as typeof fetch;
    return seen;
  };

  it("mints, reads the code from the excerpt, and releases the inbox", async () => {
    const seen = stubFetch({
      "/inboxes": { id: "inbox-id-1", emailAddress: "probe@mailslurp.test" },
      "/emails": { content: [{ id: "email-1", subject: "Your Chatbot Verification Code", bodyExcerpt: "verify your email address: 527337", textExcerpt: "", from: "email@00d.test.sfcustomeremail.com" }] },
    });
    const inbox = mailslurpInbox("test-key-ok");
    const slot = await inbox.address();
    expect(slot).toEqual({ email: "probe@mailslurp.test", token: "inbox-id-1" });
    expect(await inbox.check("inbox-id-1")).toBe("527337");
    expect(inbox.lastMailCount?.()).toBe(1);
    expect(inbox.lastMailFingerprint?.()).toContain("00d.test.[id].com");
    expect(inbox.lastMailFingerprint?.()).not.toContain("sfcustomeremail");
    expect(inbox.lastMailFingerprint?.()).not.toMatch(/\d{4}/);
    await inbox.release?.("inbox-id-1");
    expect(seen).toContain("DELETE /inboxes/inbox-id-1");
  });

  it("falls back to the full body when excerpts carry no code", async () => {
    stubFetch({
      "/inboxes": { id: "inbox-id-2", emailAddress: "probe@mailslurp.test" },
      "/emails": { content: [{ id: "email-9", subject: "Code inside", bodyExcerpt: "see body", textExcerpt: "", from: "a@b.test" }] },
      "/emails/email-9": { subject: "Code inside", body: "your code is 482516 ok" },
    });
    const inbox = mailslurpInbox("test-key-ok");
    expect(await inbox.check("inbox-id-2")).toBe("482516");
  });

  it("returns null when the inbox is empty or unreachable shapes shift", async () => {
    stubFetch({ "/emails": { content: [] } });
    const inbox = mailslurpInbox("test-key-ok");
    expect(await inbox.check("inbox-id-3")).toBeNull();
    expect(inbox.lastMailCount?.()).toBe(0);
  });
});
