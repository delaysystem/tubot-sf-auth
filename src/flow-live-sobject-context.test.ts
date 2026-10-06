import { describe, expect, it } from "vitest";
import { FLOW_LIVE_SOBJECT_SPECS, invokeFlowLiveSObject, type LiveSObjectTransport } from "./flow-live-sobject-context";

const DESCRIPTOR = { inputs: [{ name: "objectToSummarize", type: "SOBJECT", required: false }] };

function transport(overrides: { descriptor?: unknown; rows?: Array<Record<string, unknown>>; invoked?: unknown }): LiveSObjectTransport {
  return async (path: string, method = "GET") => {
    if (method === "GET" && path.includes("/actions/")) return { status: 200, ok: true, body: overrides.descriptor ?? DESCRIPTOR };
    if (method === "GET") return { status: 200, ok: true, body: { records: overrides.rows ?? [] } };
    return { status: 200, ok: true, body: overrides.invoked ?? [] };
  };
}

describe("flow-live-sobject-context", () => {
  it("registers the tscp flow spec", () => {
    expect(FLOW_LIVE_SOBJECT_SPECS["conv_copilot_ms__GetTscpMsgSes"]).toEqual({
      input: "objectToSummarize", sobject: "MessagingSession",
      children: [{ object: "ConversationEntry", parentField: "ConversationId" }],
    });
  });

  it("prefers substrate rows carrying the child payload", async () => {
    const queries: string[] = [];
    const request: LiveSObjectTransport = async (path: string, method = "GET") => {
      if (method === "GET" && path.includes("/query?")) queries.push(decodeURIComponent(path.split("/query?q=")[1]));
      if (path.includes("/actions/")) return { status: 200, ok: true, body: DESCRIPTOR };
      return { status: 200, ok: true, body: { records: [] } };
    };
    await invokeFlowLiveSObject({ root: "/services/data/v67.0",
      route: "/services/data/v67.0/actions/custom/flow/conv_copilot_ms__GetTscpMsgSes",
      actionName: "conv_copilot_ms__GetTscpMsgSes", request });
    expect(queries[0]).toBe("SELECT Id FROM MessagingSession WHERE Id IN (SELECT ConversationId FROM ConversationEntry) LIMIT 1");
  });

  it("refuses unknown flows without posting", async () => {
    let posts = 0;
    const request: LiveSObjectTransport = async (_p, m = "GET") => {
      if (m === "POST") posts++;
      return { status: 200, ok: true, body: {} };
    };
    const result = await invokeFlowLiveSObject({ root: "/services/data/v67.0",
      route: "/services/data/v67.0/actions/custom/flow/Other", actionName: "Other", request });
    expect(result.status).toBe(422);
    expect(posts).toBe(0);
  });

  it("refuses when the descriptor omits the input", async () => {
    const result = await invokeFlowLiveSObject({ root: "/services/data/v67.0",
      route: "/services/data/v67.0/actions/custom/flow/conv_copilot_ms__GetTscpMsgSes",
      actionName: "conv_copilot_ms__GetTscpMsgSes", request: transport({ descriptor: { inputs: [] } }) });
    expect(result.status).toBe(422);
    expect((result.body as { errorCode: string }).errorCode).toBe("FLOW_SOBJECT_INPUT_UNDECLARED");
  });

  it("refuses without posting when substrate is absent", async () => {
    let posts = 0;
    const request: LiveSObjectTransport = async (path: string, method = "GET") => {
      if (method === "POST") posts++;
      if (path.includes("/actions/")) return { status: 200, ok: true, body: DESCRIPTOR };
      return { status: 200, ok: true, body: { records: [] } };
    };
    const result = await invokeFlowLiveSObject({ root: "/services/data/v67.0",
      route: "/services/data/v67.0/actions/custom/flow/conv_copilot_ms__GetTscpMsgSes",
      actionName: "conv_copilot_ms__GetTscpMsgSes", request });
    expect(result.status).toBe(422);
    expect(posts).toBe(0);
  });

  it("posts the live sObject and verifies Finished", async () => {
    let posted: unknown;
    const request: LiveSObjectTransport = async (path: string, method = "GET", body?: unknown) => {
      if (method === "POST") {
        posted = body;
        return { status: 200, ok: true, body: [{ isSuccess: true, errors: null,
          outputValues: { Flow__InterviewStatus: "Finished" } }] };
      }
      if (path.includes("/actions/")) return { status: 200, ok: true, body: DESCRIPTOR };
      return { status: 200, ok: true, body: { records: [{ Id: "0Mwg5000001z5gXCAQ" }] } };
    };
    const result = await invokeFlowLiveSObject({ root: "/services/data/v67.0",
      route: "/services/data/v67.0/actions/custom/flow/conv_copilot_ms__GetTscpMsgSes",
      actionName: "conv_copilot_ms__GetTscpMsgSes", request });
    expect(result.status).toBe(200);
    expect(posted).toEqual({ inputs: [{ objectToSummarize: {
      attributes: { type: "MessagingSession" }, Id: "0Mwg5000001z5gXCAQ" } }] });
    expect(result.contextSchema.verified).toBe(true);
  });

  it("falls through to a bare live row when the child join is empty", async () => {
    const queries: string[] = [];
    let posted: unknown;
    const request: LiveSObjectTransport = async (path: string, method = "GET", body?: unknown) => {
      if (method === "POST") {
        posted = body;
        return { status: 200, ok: true, body: [{ isSuccess: true, errors: null,
          outputValues: { Flow__InterviewStatus: "Finished" } }] };
      }
      if (path.includes("/actions/")) return { status: 200, ok: true, body: DESCRIPTOR };
      const soql = decodeURIComponent(path.split("/query?q=")[1]);
      queries.push(soql);
      const linked = soql.includes("IN (SELECT");
      return { status: 200, ok: true, body: { records: linked ? [] : [{ Id: "0Mwg5000001z5gXCAQ" }] } };
    };
    const result = await invokeFlowLiveSObject({ root: "/services/data/v67.0",
      route: "/services/data/v67.0/actions/custom/flow/conv_copilot_ms__GetTscpMsgSes",
      actionName: "conv_copilot_ms__GetTscpMsgSes", request });
    expect(result.status).toBe(200);
    expect(queries).toEqual([
      "SELECT Id FROM MessagingSession WHERE Id IN (SELECT ConversationId FROM ConversationEntry) LIMIT 1",
      "SELECT Id FROM MessagingSession LIMIT 1",
    ]);
    expect(posted).toEqual({ inputs: [{ objectToSummarize: {
      attributes: { type: "MessagingSession" }, Id: "0Mwg5000001z5gXCAQ" } }] });
    expect(result.contextSchema.substrate).toBe("bare-row");
  });

  it("skips the bare query when the child join hits", async () => {
    const queries: string[] = [];
    const request: LiveSObjectTransport = async (path: string, method = "GET") => {
      if (method === "POST") return { status: 200, ok: true, body: [{ isSuccess: true, errors: null,
        outputValues: { Flow__InterviewStatus: "Finished" } }] };
      if (path.includes("/actions/")) return { status: 200, ok: true, body: DESCRIPTOR };
      queries.push(decodeURIComponent(path.split("/query?q=")[1]));
      return { status: 200, ok: true, body: { records: [{ Id: "0Mwg5000001z5gXCAQ" }] } };
    };
    const result = await invokeFlowLiveSObject({ root: "/services/data/v67.0",
      route: "/services/data/v67.0/actions/custom/flow/conv_copilot_ms__GetTscpMsgSes",
      actionName: "conv_copilot_ms__GetTscpMsgSes", request });
    expect(result.status).toBe(200);
    expect(queries).toHaveLength(1);
    expect(result.contextSchema.substrate).toBe("child-linked");
  });

  it("rejects unfinished interviews", async () => {
    const result = await invokeFlowLiveSObject({ root: "/services/data/v67.0",
      route: "/services/data/v67.0/actions/custom/flow/conv_copilot_ms__GetTscpMsgSes",
      actionName: "conv_copilot_ms__GetTscpMsgSes",
      request: transport({ rows: [{ Id: "0Mwg5000001z5gXCAQ" }],
        invoked: [{ isSuccess: false, errors: [{ message: "boom" }] }] }) });
    expect(result.status).toBe(422);
  });
});
