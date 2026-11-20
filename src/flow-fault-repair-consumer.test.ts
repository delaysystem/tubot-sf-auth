import { describe, expect, test } from "bun:test";
import {
  FLOW_FAULT_REPAIR_BUILDER_VERSION,
  FLOW_FAULT_REPAIR_RETRY_MS,
  FLOW_FAULT_REPAIR_STABLE_MS,
  flowFaultRepairDue,
  isFlowFaultRepairCode,
  planFlowFaultRepair,
  runFlowFaultRepairConsumer,
} from "./flow-fault-repair-consumer";
import { type ManagedFlowFault } from "./managed-flow-faults";

type Result = { status: number; ok: boolean; body: any };

const ROOT = "/services/data/v67.0";
const FLOW = "RepairNs__AgentFlow";
const ROUTE = `${ROOT}/actions/custom/flow/${FLOW}`;
const PRODUCER = "RepairNs__SendVerificationCode";
const PRODUCER_ROUTE = `${ROOT}/actions/custom/flow/${PRODUCER}`;
const CONTACT_ID = "003000000000001AAA";
const NOW = 1_800_000_000_000;

const ok = (body: unknown, status = 200): Result => ({
  status,
  ok: status >= 200 && status < 300,
  body,
});
const notFound = (): Result => ({
  status: 404,
  ok: false,
  body: [{ errorCode: "NOT_FOUND", message: "No such record" }],
});
const records = (rows: unknown[]): Result => ok({ records: rows });

const fault = (
  code: string,
  extra?: Partial<ManagedFlowFault>,
): ManagedFlowFault =>
  ({
    code: code as ManagedFlowFault["code"],
    requirement: "fixed setup requirement",
    retryable: true,
    ...extra,
  }) as ManagedFlowFault;

const build = async (
  _name: string,
  marker: string,
  values: Record<string, unknown>,
) => ({ values: { ...values, LastName: marker } });

const agentDescriptor = () => ({
  inputs: [
    { name: "customerId", type: "STRING" },
    { name: "conversationId", type: "STRING", required: false },
  ],
  outputs: [{ name: "outcome" }],
});
const producerDescriptor = () => ({
  inputs: [{ name: "email", type: "STRING" }],
  outputs: [
    { name: "verificationCode" },
    { name: "authenticationKey" },
    { name: "customerId" },
    { name: "customerType" },
  ],
});
const contactDescribe = () => ({
  name: "Contact",
  createable: true,
  queryable: true,
  deletable: true,
  fields: [
    { name: "LastName", type: "string", createable: true },
    { name: "Email", type: "email", createable: true },
  ],
});
const producerAccepted = () => [
  {
    isSuccess: true,
    errors: null,
    outputValues: [
      { name: "customerId", value: "CUST-1" },
      { name: "customerType", value: "Person" },
    ],
  },
];
const agentAccepted = () => [
  { isSuccess: true, errors: null, outputValues: { outcome: "booked" } },
];

/** Full lifecycle stub: producer-backed agent run with verified sweep. */
const lifecycleTransport = (hooks?: {
  posts?: Array<{ path: string; body: any }>;
  deletes?: string[];
  agentPost?: Result;
}) => {
  let marker = "";
  let readbacks = 0;
  const posts = hooks?.posts ?? [];
  const deletes = hooks?.deletes ?? [];
  const request = async (
    path: string,
    method = "GET",
    body?: any,
  ): Promise<Result> => {
    if (method === "POST") posts.push({ path, body });
    if (method === "DELETE") {
      deletes.push(path);
      return { status: 204, ok: true, body: null };
    }
    if (path === ROUTE && method === "GET") return ok(agentDescriptor());
    if (path.includes("/query?")) {
      if (path.includes("FlowDefinitionView"))
        return records([{ ApiName: PRODUCER }]);
      return ok({ totalSize: 0, records: [] });
    }
    if (path === PRODUCER_ROUTE && method === "GET")
      return ok(producerDescriptor());
    if (path === `${ROOT}/sobjects/Contact/describe`)
      return ok(contactDescribe());
    if (path === `${ROOT}/sobjects/Contact` && method === "POST")
      return ok({ id: CONTACT_ID }, 201);
    if (path === `${ROOT}/sobjects/Contact/${CONTACT_ID}` && method === "GET") {
      readbacks++;
      return readbacks === 1
        ? ok({ Id: CONTACT_ID, LastName: marker, Email: "x@example.invalid" })
        : notFound();
    }
    if (path === PRODUCER_ROUTE && method === "POST")
      return ok(producerAccepted());
    if (path === ROUTE && method === "POST")
      return hooks?.agentPost ?? ok(agentAccepted());
    return notFound();
  };
  const trackingBuild = async (
    name: string,
    m: string,
    values: Record<string, unknown>,
  ) => {
    marker = m;
    return build(name, m, values);
  };
  return { request, build: trackingBuild };
};

describe("isFlowFaultRepairCode", () => {
  test("accepts taxonomy codes and rejects anything else", () => {
    expect(isFlowFaultRepairCode("FLOW_AGENT_CONTEXT_REQUIRED")).toBe(true);
    expect(isFlowFaultRepairCode("MANAGED_FLOW_EXECUTION_FAULT")).toBe(true);
    expect(isFlowFaultRepairCode("MODEL_INFERENCE_UNAVAILABLE")).toBe(true);
    expect(isFlowFaultRepairCode("NOPE_NOT_A_CODE")).toBe(false);
    expect(isFlowFaultRepairCode(null)).toBe(false);
    expect(isFlowFaultRepairCode(undefined)).toBe(false);
    expect(isFlowFaultRepairCode(42)).toBe(false);
  });
});

describe("planFlowFaultRepair", () => {
  test("routes the agent-context fault to the producer-backed lifecycle", () => {
    const plan = planFlowFaultRepair(fault("FLOW_AGENT_CONTEXT_REQUIRED"));
    expect(plan?.strategy).toBe("agent-customer-context");
    expect(plan?.retryable).toBe(true);
  });

  test("routes the opaque execution fault to evidence narrowing", () => {
    const plan = planFlowFaultRepair(fault("MANAGED_FLOW_EXECUTION_FAULT"));
    expect(plan?.strategy).toBe("narrow-evidence");
    expect(plan?.retryable).toBe(true);
  });

  test("terminalizes every taxonomy-terminal code", () => {
    const terminal = [
      "FLOW_LOOKUP_SCHEMA_SKEW",
      "SUMMARIZER_BACKEND_UNAVAILABLE",
      "MANAGED_INVOCABLE_INTERNAL",
      "AGENTIC_RETRIEVAL_BACKEND_FAULT",
      "UPSTREAM_ERROR_ID_FAULT",
      "MANAGED_FLOW_INTERVIEW_START_GACK",
      "FLOW_EXECUTION_SCHEMA_SKEW",
      "MANAGED_TRIGGER_NULL_FAULT",
      "VENDOR_DML_ROW_FAULT",
      "INTEGRATION_PROCEDURE_INPUT_UNAVAILABLE",
      "VENDOR_EMPTY_RESULT_FAULT",
      "MODEL_INFERENCE_UNAVAILABLE",
      "UDD_TARGET_ENTITY_UNRESOLVABLE",
    ];
    for (const code of terminal) {
      const plan = planFlowFaultRepair(fault(code, { retryable: false }));
      expect(plan?.strategy).toBe("terminal");
      expect(plan?.code).toBe(code);
      expect(plan?.retryable).toBe(false);
    }
  });

  test("parks every setup-owned code for admin/vendor/human repair", () => {
    const setup = [
      "INVITATION_URL_PREFIX_REQUIRED",
      "FLOW_QUICK_ACTION_UNRESOLVED",
      "FLOW_ACTION_ELEMENT_UNRESOLVED",
      "FLOW_LOOKUP_FIELD_ACCESS_REQUIRED",
      "PERSON_ACCOUNTS_REQUIRED",
      "PROMPT_DATA_PROVIDER_UNAVAILABLE",
      "FLOW_RUN_PERMISSION_REQUIRED",
      "FLOW_PACKAGE_PERMISSION_REQUIRED",
      "FLOW_EXTERNAL_CALLOUT_UNAVAILABLE",
      "FLOW_EXECUTION_INVOCABLE_MISSING",
      "PACKAGE_TRIGGER_DATA_REQUIRED",
      "CALLOUT_ENDPOINT_SETUP_REQUIRED",
      "SESSION_ASSIGNMENT_REQUIRED",
      "PARDOT_DATA_ACCESS_REQUIRED",
    ];
    for (const code of setup) {
      const plan = planFlowFaultRepair(fault(code));
      expect(plan?.strategy).toBe("await-setup");
      expect(plan?.retryable).toBe(true);
    }
  });

  test("maps input-caused codes to their reshape directives", () => {
    expect(
      planFlowFaultRepair(fault("DECLARED_INPUT_SHAPE_REQUIRED")),
    ).toMatchObject({ strategy: "reshape-inputs", reshape: "declared-only" });
    expect(
      planFlowFaultRepair(fault("JSON_DOCUMENT_INPUT_REQUIRED")),
    ).toMatchObject({ strategy: "reshape-inputs", reshape: "json-document" });
    for (const code of [
      "SEGMENT_CONTEXT_REQUIRED",
      "PROMPT_SESSION_CONTEXT_REQUIRED",
      "FLOW_INPUT_IDENTIFIER_REQUIRED",
      "STRUCTURED_INPUT_VALUE_REQUIRED",
      "LIVE_INPUT_VALUE_REQUIRED",
      "DYNAMIC_QUERY_IDENTIFIER_REQUIRED",
      "ALPHANUMERIC_CONTEXT_NAME_REQUIRED",
      "SCHEMA_IDENTIFIER_VALUE_REQUIRED",
    ]) {
      expect(planFlowFaultRepair(fault(code))).toMatchObject({
        strategy: "reshape-inputs",
        reshape: "live-values",
      });
    }
  });

  test("returns null for unknown codes so pipelines keep their verdict", () => {
    expect(planFlowFaultRepair(fault("NOPE_NOT_A_CODE"))).toBeNull();
    expect(
      planFlowFaultRepair(null as unknown as ManagedFlowFault),
    ).toBeNull();
    expect(
      planFlowFaultRepair("FLOW_AGENT_CONTEXT_REQUIRED" as unknown as ManagedFlowFault),
    ).toBeNull();
  });

  test("keeps validated detail and drops anything unvalidated", () => {
    const plan = planFlowFaultRepair(
      fault("FLOW_LOOKUP_FIELD_ACCESS_REQUIRED", {
        objectName: "Asset",
        fieldName: "ProductDescription",
        invocableName: "no spaces allowed",
      }),
    );
    expect(plan?.detail).toEqual({
      objectName: "Asset",
      fieldName: "ProductDescription",
    });
    const bare = planFlowFaultRepair(fault("FLOW_RUN_PERMISSION_REQUIRED"));
    expect(bare?.detail).toBeUndefined();
  });

  test("falls back to a fixed requirement when none was recorded", () => {
    const plan = planFlowFaultRepair(
      fault("FLOW_RUN_PERMISSION_REQUIRED", { requirement: "" }),
    );
    expect(plan?.requirement).not.toBe("");
    expect(plan?.requirement).not.toContain("00D");
  });
});

describe("flowFaultRepairDue", () => {
  const current = FLOW_FAULT_REPAIR_BUILDER_VERSION;

  test("builder-stale rows always pass, like the searcher predicate", () => {
    expect(flowFaultRepairDue({})).toBe(true);
    expect(
      flowFaultRepairDue({
        builderVersion: current - 1,
        lastAttemptAt: NOW,
        now: NOW,
      }),
    ).toBe(true);
    expect(
      flowFaultRepairDue({
        builderVersion: current,
        lastAttemptAt: null,
        now: NOW,
      }),
    ).toBe(true);
    expect(
      flowFaultRepairDue({
        builderVersion: current,
        lastAttemptAt: Number.NaN,
        now: NOW,
      }),
    ).toBe(true);
  });

  test("fresh repeats wait 24h before the next attempt", () => {
    const fresh = {
      builderVersion: current,
      lastAttemptAt: NOW - 60_000,
      repeatCount: 1,
      now: NOW,
    };
    expect(flowFaultRepairDue(fresh)).toBe(false);
    expect(
      flowFaultRepairDue({
        ...fresh,
        lastAttemptAt: NOW - FLOW_FAULT_REPAIR_RETRY_MS - 1,
      }),
    ).toBe(true);
    expect(
      flowFaultRepairDue({
        ...fresh,
        lastAttemptAt: NOW - FLOW_FAULT_REPAIR_RETRY_MS + 1,
      }),
    ).toBe(false);
  });

  test("twice-repeated codes settle onto the 7d stable window", () => {
    const stable = {
      builderVersion: current,
      lastAttemptAt: NOW - FLOW_FAULT_REPAIR_RETRY_MS - 1,
      repeatCount: 2,
      now: NOW,
    };
    expect(flowFaultRepairDue(stable)).toBe(false);
    expect(
      flowFaultRepairDue({
        ...stable,
        lastAttemptAt: NOW - FLOW_FAULT_REPAIR_STABLE_MS - 1,
      }),
    ).toBe(true);
    expect(
      flowFaultRepairDue({ ...stable, repeatCount: 5 }),
    ).toBe(false);
  });
});

describe("runFlowFaultRepairConsumer fallthrough", () => {
  test("unknown codes return null without touching the org", async () => {
    let calls = 0;
    const request = async (): Promise<Result> => {
      calls++;
      return notFound();
    };
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("NOPE_NOT_A_CODE"),
      root: ROOT,
      route: ROUTE,
      request,
    });
    expect(outcome).toBeNull();
    expect(calls).toBe(0);
  });

  test("terminal faults record terminally with no reads", async () => {
    let calls = 0;
    const request = async (): Promise<Result> => {
      calls++;
      return notFound();
    };
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("MODEL_INFERENCE_UNAVAILABLE", { retryable: false }),
      root: ROOT,
      route: ROUTE,
      request,
    });
    expect(outcome).toMatchObject({
      disposition: "terminal",
      attempts: 0,
      fault: { code: "MODEL_INFERENCE_UNAVAILABLE" },
    });
    expect(calls).toBe(0);
  });

  test("gated repairs park without touching the org", async () => {
    let calls = 0;
    const request = async (): Promise<Result> => {
      calls++;
      return notFound();
    };
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("FLOW_AGENT_CONTEXT_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request,
      build,
      gating: {
        builderVersion: FLOW_FAULT_REPAIR_BUILDER_VERSION,
        lastAttemptAt: NOW - 60_000,
        repeatCount: 0,
      },
      now: () => NOW,
    });
    expect(outcome).toMatchObject({
      disposition: "parked",
      gated: true,
      attempts: 0,
    });
    expect(calls).toBe(0);
  });

  test("invalid roots and transports park without reads", async () => {
    let calls = 0;
    const request = async (): Promise<Result> => {
      calls++;
      return notFound();
    };
    const badRoot = await runFlowFaultRepairConsumer({
      fault: fault("FLOW_RUN_PERMISSION_REQUIRED"),
      root: "https://example.invalid",
      route: ROUTE,
      request,
      priorArgs: { recordId: "500000000000001AAA" },
    });
    expect(badRoot?.disposition).toBe("parked");
    expect(badRoot?.attempts).toBe(0);
    const noTransport = await runFlowFaultRepairConsumer({
      fault: fault("FLOW_RUN_PERMISSION_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request: null as unknown as (path: string) => Promise<Result>,
      priorArgs: { recordId: "500000000000001AAA" },
    });
    expect(noTransport?.disposition).toBe("parked");
    expect(noTransport?.attempts).toBe(0);
    expect(calls).toBe(0);
  });

  test("a malformed route fails its single probe and parks", async () => {
    const request = async (): Promise<Result> => notFound();
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("FLOW_RUN_PERMISSION_REQUIRED"),
      root: ROOT,
      route: "not-a-route",
      request,
      priorArgs: { recordId: "500000000000001AAA" },
    });
    expect(outcome?.disposition).toBe("parked");
    expect(outcome?.attempts).toBe(1);
  });

  test("agent repairs without a builder park before any read", async () => {
    let calls = 0;
    const request = async (): Promise<Result> => {
      calls++;
      return notFound();
    };
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("FLOW_AGENT_CONTEXT_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request,
    });
    expect(outcome?.disposition).toBe("parked");
    expect(calls).toBe(0);
  });
});

describe("agent-customer-context repair", () => {
  test("converts through the producer identity and sweeps the fixture", async () => {
    const posts: Array<{ path: string; body: any }> = [];
    const deletes: string[] = [];
    const { request, build: trackingBuild } = lifecycleTransport({
      posts,
      deletes,
    });
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("FLOW_AGENT_CONTEXT_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request,
      build: trackingBuild,
    });
    expect(outcome).toMatchObject({
      disposition: "repaired",
      fault: null,
      attempts: 1,
    });
    expect(outcome?.repairedBody).toEqual(agentAccepted());
    // The owned Contact is created, bound through the producer, invoked
    // with, then deleted and verified absent: no residue escapes.
    expect(posts.filter((entry) => entry.path === `${ROOT}/sobjects/Contact`)).toHaveLength(1);
    const agentPost = posts.find((entry) => entry.path === ROUTE);
    expect(agentPost?.body).toEqual({ inputs: [{ customerId: "CUST-1" }] });
    expect(deletes).toEqual([`${ROOT}/sobjects/Contact/${CONTACT_ID}`]);
  });

  test("lifecycle setup failures park with the precise failure code", async () => {
    const request = async (path: string, method = "GET"): Promise<Result> => {
      if (path === ROUTE) {
        return ok({
          inputs: [
            { name: "customerId", type: "STRING" },
            { name: "conversationId", type: "STRING", required: true },
          ],
          outputs: [{ name: "outcome" }],
        });
      }
      return notFound();
    };
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("FLOW_AGENT_CONTEXT_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request,
      build,
    });
    expect(outcome).toMatchObject({
      disposition: "parked",
      attempts: 1,
      lifecycleCode: "FLOW_AGENT_CONVERSATION_REQUIRED",
      fault: { code: "FLOW_AGENT_CONTEXT_REQUIRED" },
    });
  });

  test("a terminal re-diagnosis after the lifecycle terminalizes", async () => {
    const { request, build: trackingBuild } = lifecycleTransport({
      agentPost: {
        status: 500,
        ok: false,
        body: [
          {
            message: "Something went wrong. Gack ID: 1-2345 (6789)",
            errorCode: "UNKNOWN_EXCEPTION",
          },
        ],
      },
    });
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("FLOW_AGENT_CONTEXT_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request,
      build: trackingBuild,
    });
    expect(outcome).toMatchObject({
      disposition: "terminal",
      attempts: 1,
      fault: { code: "UPSTREAM_ERROR_ID_FAULT" },
    });
  });

  test("transport explosions park instead of throwing", async () => {
    const request = async (): Promise<Result> => {
      throw new Error("upstream exploded");
    };
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("FLOW_AGENT_CONTEXT_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request,
      build,
    });
    expect(outcome?.disposition).toBe("parked");
    expect(outcome?.attempts).toBe(1);
  });
});

describe("narrow-evidence repair", () => {
  const definition = () =>
    records([
      {
        DeveloperName: FLOW,
        NamespacePrefix: null,
        ActiveVersionId: "301000000000001AAA",
      },
    ]);

  test("proven missing invocables park with the narrowed code", async () => {
    const request = async (path: string): Promise<Result> => {
      if (path.includes("/tooling/query") && path.includes("FlowDefinition"))
        return definition();
      if (path.includes("/tooling/query") && path.includes("SELECT%20Metadata"))
        return records([
          {
            Metadata: {
              actionCalls: [{ actionName: "MissingHelper", actionType: "apex" }],
            },
          },
        ]);
      if (path === `${ROOT}/actions/custom/apex/MissingHelper`) return notFound();
      if (path.includes("ApexClass")) return records([]);
      if (path === `${ROOT}/actions/standard`) return ok({ actions: [] });
      return notFound();
    };
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("MANAGED_FLOW_EXECUTION_FAULT"),
      root: ROOT,
      route: ROUTE,
      request,
    });
    expect(outcome).toMatchObject({
      disposition: "parked",
      attempts: 0,
      fault: {
        code: "FLOW_EXECUTION_INVOCABLE_MISSING",
        invocableName: "MissingHelper",
      },
    });
  });

  test("proven schema skew terminalizes", async () => {
    const request = async (path: string): Promise<Result> => {
      if (path.includes("/tooling/query") && path.includes("FlowDefinition"))
        return definition();
      if (path.includes("/tooling/query") && path.includes("SELECT%20Metadata"))
        return records([
          {
            Metadata: {
              recordLookups: [
                {
                  object: "Asset",
                  filters: [{ field: "ProductDescription", operator: "EqualTo" }],
                },
              ],
            },
          },
        ]);
      if (path.endsWith("/sobjects/Asset/describe"))
        return ok({ name: "Asset", fields: [{ name: "Id" }, { name: "Name" }] });
      return notFound();
    };
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("MANAGED_FLOW_EXECUTION_FAULT"),
      root: ROOT,
      route: ROUTE,
      request,
    });
    expect(outcome).toMatchObject({
      disposition: "terminal",
      attempts: 0,
      fault: {
        code: "FLOW_EXECUTION_SCHEMA_SKEW",
        objectName: "Asset",
        fieldName: "ProductDescription",
      },
    });
  });

  test("absent references keep the generic park without extra reads", async () => {
    const calls: string[] = [];
    const request = async (path: string): Promise<Result> => {
      calls.push(path);
      if (path.includes("/tooling/query") && path.includes("FlowDefinition"))
        return definition();
      if (path.includes("/tooling/query") && path.includes("SELECT%20Metadata"))
        return records([{ Metadata: {} }]);
      return notFound();
    };
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("MANAGED_FLOW_EXECUTION_FAULT"),
      root: ROOT,
      route: ROUTE,
      request,
    });
    expect(outcome).toMatchObject({
      disposition: "parked",
      fault: { code: "MANAGED_FLOW_EXECUTION_FAULT" },
    });
    expect(
      calls.some((call) => call.includes("ApexClass") || call.includes("/describe")),
    ).toBe(false);
  });

  test("non-flow routes park without reads", async () => {
    let calls = 0;
    const request = async (): Promise<Result> => {
      calls++;
      return notFound();
    };
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("MANAGED_FLOW_EXECUTION_FAULT"),
      root: ROOT,
      route: `${ROOT}/actions/standard/changeOrderSummaryPreview`,
      request,
    });
    expect(outcome?.disposition).toBe("parked");
    expect(calls).toBe(0);
  });
});

describe("reshape-inputs repair", () => {
  test("declared-only strips the wrapper and re-probes declared inputs", async () => {
    const probed: Array<Record<string, unknown>> = [];
    const request = async (path: string, method = "GET"): Promise<Result> => {
      if (path === ROUTE && method === "GET") {
        return ok({
          inputs: [{ name: "recordId", type: "ID" }],
          outputs: [{ name: "outcome" }],
        });
      }
      return notFound();
    };
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("DECLARED_INPUT_SHAPE_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request,
      priorArgs: { recordId: "500000000000001AAA", attributes: { type: "X" } },
      probe: async (args) => {
        probed.push(args);
        return ok([{ isSuccess: true, outputValues: { outcome: "ok" } }]);
      },
    });
    expect(outcome).toMatchObject({ disposition: "repaired", attempts: 1 });
    expect(probed).toEqual([{ recordId: "500000000000001AAA" }]);
  });

  test("declared-only parks when nothing would change", async () => {
    let probes = 0;
    const request = async (path: string, method = "GET"): Promise<Result> => {
      if (path === ROUTE && method === "GET") {
        return ok({
          inputs: [{ name: "recordId", type: "ID" }],
          outputs: [{ name: "outcome" }],
        });
      }
      return notFound();
    };
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("DECLARED_INPUT_SHAPE_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request,
      priorArgs: { recordId: "500000000000001AAA" },
      probe: async () => {
        probes++;
        return ok([{ isSuccess: true }]);
      },
    });
    expect(outcome?.disposition).toBe("parked");
    expect(outcome?.attempts).toBe(0);
    expect(probes).toBe(0);
  });

  test("json-document wraps bare tokens on JSON-documented inputs", async () => {
    const probed: Array<Record<string, unknown>> = [];
    const request = async (path: string, method = "GET"): Promise<Result> => {
      if (path === ROUTE && method === "GET") {
        return ok({
          inputs: [
            {
              name: "payload",
              type: "STRING",
              description: "A JSON document describing the request.",
            },
            { name: "plain", type: "STRING" },
          ],
          outputs: [{ name: "outcome" }],
        });
      }
      return notFound();
    };
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("JSON_DOCUMENT_INPUT_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request,
      priorArgs: { payload: "bare-token", plain: "untouched" },
      probe: async (args) => {
        probed.push(args);
        return ok([{ isSuccess: true, outputValues: { outcome: "ok" } }]);
      },
    });
    expect(outcome).toMatchObject({ disposition: "repaired", attempts: 1 });
    expect(probed).toEqual([{ payload: '"bare-token"', plain: "untouched" }]);
  });

  test("json-document parks when every value already parses", async () => {
    let probes = 0;
    const request = async (path: string, method = "GET"): Promise<Result> => {
      if (path === ROUTE && method === "GET") {
        return ok({
          inputs: [
            {
              name: "payload",
              type: "STRING",
              description: "A JSON document describing the request.",
            },
          ],
          outputs: [{ name: "outcome" }],
        });
      }
      return notFound();
    };
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("JSON_DOCUMENT_INPUT_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request,
      priorArgs: { payload: '{"already":"json"}' },
      probe: async () => {
        probes++;
        return ok([{ isSuccess: true }]);
      },
    });
    expect(outcome?.disposition).toBe("parked");
    expect(probes).toBe(0);
  });

  test("live-values parks with the directive for searcher discovery", async () => {
    let calls = 0;
    const request = async (): Promise<Result> => {
      calls++;
      return notFound();
    };
    for (const code of ["LIVE_INPUT_VALUE_REQUIRED", "FLOW_INPUT_IDENTIFIER_REQUIRED"]) {
      const outcome = await runFlowFaultRepairConsumer({
        fault: fault(code),
        root: ROOT,
        route: ROUTE,
        request,
        priorArgs: { recordId: "500000000000001AAA" },
      });
      expect(outcome).toMatchObject({
        disposition: "parked",
        reshapeDirective: "live-values",
        attempts: 0,
      });
    }
    // One descriptor read per code to rule out scalar re-probe; no POST.
    expect(calls).toBe(2);
  });

  test("reshapes without prior args park before the descriptor read", async () => {
    let calls = 0;
    const request = async (): Promise<Result> => {
      calls++;
      return notFound();
    };
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("DECLARED_INPUT_SHAPE_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request,
    });
    expect(outcome?.disposition).toBe("parked");
    expect(calls).toBe(0);
  });
});

describe("await-setup re-probe", () => {
  test("an applied fix converts on re-probe", async () => {
    const request = async (): Promise<Result> => notFound();
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("FLOW_RUN_PERMISSION_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request,
      priorArgs: { recordId: "500000000000001AAA" },
      probe: async (args) => {
        expect(args).toEqual({ recordId: "500000000000001AAA" });
        return ok([{ isSuccess: true, outputValues: { outcome: "ok" } }]);
      },
    });
    expect(outcome).toMatchObject({
      disposition: "repaired",
      fault: null,
      attempts: 1,
    });
  });

  test("a repeated fault re-parks with the newest diagnosis", async () => {
    const request = async (): Promise<Result> => notFound();
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("FLOW_RUN_PERMISSION_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request,
      priorArgs: { recordId: "500000000000001AAA" },
      probe: async () => ({
        status: 400,
        ok: false,
        body: [
          {
            message: "This user doesn't have the required access to run the flow.",
            errorCode: "INSUFFICIENT_ACCESS",
          },
        ],
      }),
    });
    expect(outcome).toMatchObject({
      disposition: "reprobed",
      attempts: 1,
      fault: { code: "FLOW_RUN_PERMISSION_REQUIRED" },
    });
  });

  test("a fresh terminal diagnosis on re-probe terminalizes", async () => {
    const request = async (): Promise<Result> => notFound();
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("FLOW_RUN_PERMISSION_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request,
      priorArgs: { recordId: "500000000000001AAA" },
      probe: async () => ({
        status: 500,
        ok: false,
        body: [
          {
            message: "Inference failed for model: predictor-v1",
            errorCode: "UNKNOWN_EXCEPTION",
          },
        ],
      }),
    });
    expect(outcome).toMatchObject({
      disposition: "terminal",
      attempts: 1,
      fault: { code: "MODEL_INFERENCE_UNAVAILABLE" },
    });
  });

  test("missing prior args park without probing", async () => {
    let probes = 0;
    const request = async (): Promise<Result> => notFound();
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("FLOW_RUN_PERMISSION_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request,
      probe: async () => {
        probes++;
        return ok([{ isSuccess: true }]);
      },
    });
    expect(outcome?.disposition).toBe("parked");
    expect(probes).toBe(0);
  });

  test("probe explosions park with the attempt spent", async () => {
    const request = async (): Promise<Result> => notFound();
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("FLOW_RUN_PERMISSION_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request,
      priorArgs: { recordId: "500000000000001AAA" },
      probe: async () => {
        throw new Error("upstream exploded");
      },
    });
    expect(outcome).toMatchObject({ disposition: "parked", attempts: 1 });
  });

  test("the default probe POSTs shaped args to the flow route", async () => {
    const posts: Array<{ path: string; body: any }> = [];
    const request = async (
      path: string,
      method = "GET",
      body?: any,
    ): Promise<Result> => {
      if (method === "POST") {
        posts.push({ path, body });
        return ok([{ isSuccess: true, outputValues: { outcome: "ok" } }]);
      }
      return notFound();
    };
    const outcome = await runFlowFaultRepairConsumer({
      fault: fault("FLOW_PACKAGE_PERMISSION_REQUIRED"),
      root: ROOT,
      route: ROUTE,
      request,
      priorArgs: { recordId: "500000000000001AAA", "bad key!": "dropped" },
    });
    expect(outcome?.disposition).toBe("repaired");
    expect(posts).toEqual([
      {
        path: ROUTE,
        body: { inputs: [{ recordId: "500000000000001AAA" }] },
      },
    ]);
  });
});
