import { describe, expect, it } from "bun:test";
import {
  collectFlowExecutionEvidence,
  describeFieldNames,
  diagnoseFlowExecutionFault,
  extractFlowExecutionSignal,
  extractFlowMetadataReferences,
  fetchFlowMetadataReferences,
  FLOW_EXECUTION_EVIDENCE_BOUNDS,
  type FlowExecutionEvidenceCache,
  type FlowExecutionTransport,
} from "./flow-execution-evidence";

const ROOT = "/services/data/v67.0";
const OPAQUE = "An error occurred when executing a flow interview.";

type Script = (
  path: string,
  method?: string,
) => { status: number; ok: boolean; body: any } | null;

const transport = (
  scripts: Script[],
  calls: string[],
): FlowExecutionTransport => {
  const request = (async (path: string, method = "GET") => {
    calls.push(`${method} ${path.slice(0, 160)}`);
    for (const script of scripts) {
      const hit = script(path, method);
      if (hit) return hit;
    }
    throw new Error(`unstubbed ${method} ${path}`);
  }) as FlowExecutionTransport;
  return request;
};

const ok = (body: unknown = {}) => ({ status: 200, ok: true, body });
const notFound = () => ({ status: 404, ok: false, body: [] });
const denied = () => ({ status: 403, ok: false, body: [] });
const failed = () => ({ status: 500, ok: false, body: [] });

describe("extractFlowExecutionSignal", () => {
  it("extracts the opaque REST fault shape", () => {
    const signal = extractFlowExecutionSignal(400, [
      { message: OPAQUE, errorCode: "UNKNOWN_EXCEPTION" },
    ]);
    expect(signal).toMatchObject({
      status: 400,
      messages: [OPAQUE],
      codes: ["UNKNOWN_EXCEPTION"],
      envelopeSucceeded: false,
    });
    expect(signal.outputErrorMessage).toBeUndefined();
  });

  it("reads envelope errors and output error messages", () => {
    const signal = extractFlowExecutionSignal(200, [
      {
        isSuccess: false,
        errors: [{ statusCode: "UNKNOWN_EXCEPTION", message: OPAQUE }],
        outputValues: { errorMessage: "interview exploded" },
      },
    ]);
    expect(signal.messages).toContain(OPAQUE);
    expect(signal.messages).toContain("interview exploded");
    expect(signal.codes).toEqual(["UNKNOWN_EXCEPTION"]);
    expect(signal.outputErrorMessage).toBe("interview exploded");
    expect(signal.envelopeSucceeded).toBe(false);
  });

  it("flags clean success envelopes", () => {
    expect(
      extractFlowExecutionSignal(200, [{ isSuccess: true }]).envelopeSucceeded,
    ).toBe(true);
    expect(
      extractFlowExecutionSignal(200, [{ isSuccess: true, errors: [] }])
        .envelopeSucceeded,
    ).toBe(false);
    expect(
      extractFlowExecutionSignal(200, [{ isSuccess: false }]).envelopeSucceeded,
    ).toBe(false);
  });

  it("bounds and sanitizes hostile shapes", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      message: `m${index} ${"x".repeat(2000)}`,
      errorCode: index % 2 ? "UNKNOWN_EXCEPTION" : "../../etc",
    }));
    const signal = extractFlowExecutionSignal(400, many);
    expect(signal.messages).toHaveLength(
      FLOW_EXECUTION_EVIDENCE_BOUNDS.signalMessages,
    );
    expect(signal.messages.every((text) => text.length <= 500)).toBe(true);
    expect(signal.codes).toEqual(["UNKNOWN_EXCEPTION"]);
    const garbage = extractFlowExecutionSignal(400, "nope");
    expect(garbage.messages).toEqual([]);
    expect(garbage.codes).toEqual([]);
    expect(extractFlowExecutionSignal(400, null).messages).toEqual([]);
    expect(extractFlowExecutionSignal(400, [null, 42]).codes).toEqual([]);
  });
});

describe("extractFlowMetadataReferences", () => {
  const metadata = {
    actionCalls: [
      { actionName: "GetCustomerSignalsInsights", actionType: "apex" },
      { actionName: "SendEmail", actionType: "emailAlert" },
      { actionName: "lower", actionType: "APEX" },
      { actionName: "../../etc", actionType: "apex" },
      { actionName: "GetCustomerSignalsInsights", actionType: "apex" },
    ],
    apexPluginCalls: [{ apexClass: "LegacyPlugin" }, { apexClass: 42 }],
    recordLookups: [
      {
        object: "Asset",
        filters: [{ field: "ProductDescription", operator: "EqualTo" }],
      },
      { object: "Nope!!", filters: [{ field: "Id" }] },
    ],
    recordCreates: [
      { object: "Case", inputAssignments: [{ field: "Subject" }, {}] },
    ],
    recordUpdates: [{ object: "Contact", inputAssignments: [{ field: "Email" }] }],
  };

  it("collects validated invocables and schema refs only", () => {
    const refs = extractFlowMetadataReferences(metadata);
    expect(refs.invocables).toEqual([
      "GetCustomerSignalsInsights",
      "lower",
      "LegacyPlugin",
    ]);
    expect(refs.schemaRefs).toEqual([
      { objectName: "Asset", fieldName: "ProductDescription" },
      { objectName: "Case", fieldName: "Subject" },
      { objectName: "Contact", fieldName: "Email" },
    ]);
  });

  it("collects update filters and delete filters as schema refs", () => {
    const refs = extractFlowMetadataReferences({
      recordUpdates: [
        {
          object: "WorkOrder",
          inputAssignments: [{ field: "Status" }],
          filters: [{ field: "WorkOrderNumber", operator: "EqualTo" }],
        },
      ],
      recordDeletes: [
        { object: "Task", filters: [{ field: "Subject" }] },
        { object: "Task", filters: [{ field: "!!!" }] },
        { object: "Nope!!", filters: [{ field: "Id" }] },
      ],
    });
    expect(refs.schemaRefs).toEqual([
      { objectName: "WorkOrder", fieldName: "Status" },
      { objectName: "WorkOrder", fieldName: "WorkOrderNumber" },
      { objectName: "Task", fieldName: "Subject" },
    ]);
  });

  it("returns empty refs for garbage metadata", () => {
    expect(extractFlowMetadataReferences(null)).toEqual({
      invocables: [],
      schemaRefs: [],
    });
    expect(extractFlowMetadataReferences({})).toEqual({
      invocables: [],
      schemaRefs: [],
    });
    expect(extractFlowMetadataReferences("nope")).toEqual({
      invocables: [],
      schemaRefs: [],
    });
  });

  it("caps extracted candidates", () => {
    const big = {
      actionCalls: Array.from({ length: 10 }, (_, index) => ({
        actionName: `Inv${index}`,
        actionType: "apex",
      })),
      recordLookups: [
        {
          object: "Case",
          filters: Array.from({ length: 20 }, (_, index) => ({
            field: `F${index}`,
          })),
        },
      ],
    };
    const refs = extractFlowMetadataReferences(big);
    expect(refs.invocables).toHaveLength(
      FLOW_EXECUTION_EVIDENCE_BOUNDS.metadataInvocables,
    );
    expect(refs.schemaRefs).toHaveLength(
      FLOW_EXECUTION_EVIDENCE_BOUNDS.metadataSchemaRefs,
    );
  });
});

describe("fetchFlowMetadataReferences", () => {
  const VERSION = "301000000000000AAA";
  const scripts: Script[] = [
    (path) =>
      path.includes("/tooling/query") && path.includes("FlowDefinition")
        ? ok({
            records: [
              {
                DeveloperName: "t__Close",
                NamespacePrefix: null,
                ActiveVersionId: VERSION,
              },
            ],
          })
        : null,
    (path) =>
      path.includes("/tooling/query") && path.includes("SELECT%20Metadata")
        ? ok({
            records: [
              {
                Metadata: {
                  actionCalls: [
                    { actionName: "Helper", actionType: "apex" },
                  ],
                  recordLookups: [],
                },
              },
            ],
          })
        : null,
  ];

  it("fetches definition plus metadata once, then serves cache", async () => {
    const calls: string[] = [];
    const cache: FlowExecutionEvidenceCache = {};
    const request = transport(scripts, calls);
    const first = await fetchFlowMetadataReferences({
      root: ROOT,
      flowName: "t__Close",
      request,
      cache,
    });
    expect(first).toEqual({ invocables: ["Helper"], schemaRefs: [] });
    expect(calls).toHaveLength(2);
    const second = await fetchFlowMetadataReferences({
      root: ROOT,
      flowName: "t__Close",
      request,
      cache,
    });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(2);
  });

  it("stays unverifiable without reads on invalid input", async () => {
    const calls: string[] = [];
    const request = transport(scripts, calls);
    expect(
      await fetchFlowMetadataReferences({
        root: ROOT,
        flowName: "../../etc",
        request,
      }),
    ).toBeNull();
    expect(
      await fetchFlowMetadataReferences({
        root: "/bogus",
        flowName: "t__Close",
        request,
      }),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it("caches ambiguity and transport failures as unverifiable", async () => {
    const ambiguous: Script[] = [
      (path) =>
        path.includes("FlowDefinition")
          ? ok({ records: [{ DeveloperName: "Other" }] })
          : null,
    ];
    const calls: string[] = [];
    const cache: FlowExecutionEvidenceCache = {};
    const request = transport(ambiguous, calls);
    expect(
      await fetchFlowMetadataReferences({
        root: ROOT,
        flowName: "t__Close",
        request,
        cache,
      }),
    ).toBeNull();
    expect(calls).toHaveLength(1);
    expect(
      await fetchFlowMetadataReferences({
        root: ROOT,
        flowName: "t__Close",
        request,
        cache,
      }),
    ).toBeNull();
    expect(calls).toHaveLength(1);
    const refusing = transport(
      [
        (path) =>
          path.includes("FlowDefinition") ? denied() : null,
      ],
      calls,
    );
    expect(
      await fetchFlowMetadataReferences({
        root: ROOT,
        flowName: "Other__Flow",
        request: refusing,
        cache,
      }),
    ).toBeNull();
  });
});

describe("describeFieldNames", () => {
  it("lowercases live field names and rejects garbage", () => {
    expect(
      describeFieldNames({ fields: [{ name: "Subject" }, { name: 42 }, null] }),
    ).toEqual(new Set(["subject"]));
    expect(describeFieldNames(null)).toBeNull();
    expect(describeFieldNames({})).toBeNull();
    expect(describeFieldNames({ fields: "nope" })).toBeNull();
  });
});

describe("collectFlowExecutionEvidence invocables", () => {
  const APEX = `${ROOT}/actions/custom/apex/GetCustomerSignalsInsights`;
  const descriptor = { inputs: [], outputs: [] };
  const apexHit = (path: string) =>
    path.includes("FROM%20ApexClass") || path.includes("FROM ApexClass")
      ? ok({ records: [{ Id: "01p000000000000AAA", Name: "GetCustomerSignalsInsights" }] })
      : null;
  const apexMiss = (path: string) =>
    path.includes("FROM%20ApexClass") || path.includes("FROM ApexClass")
      ? ok({ records: [] })
      : null;
  const emptyCatalogs: Script[] = [
    (path) => path === `${ROOT}/actions/standard` ? ok({ actions: [] }) : null,
    (path) =>
      path === `${ROOT}/actions/custom/externalService`
        ? ok({ actions: [] })
        : null,
  ];

  it("proves a missing invocable absent from every surface", async () => {
    const calls: string[] = [];
    const request = transport(
      [
        (path) => (path === APEX ? notFound() : null),
        apexMiss,
        ...emptyCatalogs,
      ],
      calls,
    );
    const evidence = await collectFlowExecutionEvidence({
      root: ROOT,
      request,
      invocables: ["GetCustomerSignalsInsights"],
    });
    expect(evidence.missingInvocable).toBe("GetCustomerSignalsInsights");
    expect(calls).toHaveLength(3);
  });

  it("withholds evidence when any surface exposes the invocable", async () => {
    const viaDescriptor = transport(
      [(path) => (path === APEX ? ok(descriptor) : null)],
      [],
    );
    expect(
      await collectFlowExecutionEvidence({
        root: ROOT,
        request: viaDescriptor,
        invocables: ["GetCustomerSignalsInsights"],
      }),
    ).toEqual({});
    const viaTable = transport(
      [(path) => (path === APEX ? notFound() : null), apexHit],
      [],
    );
    expect(
      await collectFlowExecutionEvidence({
        root: ROOT,
        request: viaTable,
        invocables: ["GetCustomerSignalsInsights"],
      }),
    ).toEqual({});
    const viaStandard = transport(
      [
        (path) => (path === APEX ? notFound() : null),
        apexMiss,
        (path) =>
          path === `${ROOT}/actions/standard`
            ? ok({ actions: [{ name: "GetCustomerSignalsInsights" }] })
            : null,
      ],
      [],
    );
    expect(
      await collectFlowExecutionEvidence({
        root: ROOT,
        request: viaStandard,
        invocables: ["GetCustomerSignalsInsights"],
      }),
    ).toEqual({});
  });

  it("withholds evidence when any surface is unverifiable", async () => {
    for (const scripts of [
      [(path: string) => (path === APEX ? failed() : null)],
      [(path: string) => (path === APEX ? notFound() : null),
        (path: string) => (path.includes("ApexClass") ? denied() : null)],
      [(path: string) => (path === APEX ? notFound() : null), apexMiss,
        (path: string) => (path === `${ROOT}/actions/standard` ? failed() : null)],
      [(path: string) => (path === APEX ? ok({ bogus: true }) : null)],
    ]) {
      const request = transport(scripts as Script[], []);
      expect(
        await collectFlowExecutionEvidence({
          root: ROOT,
          request,
          invocables: ["GetCustomerSignalsInsights"],
        }),
      ).toEqual({});
    }
  });

  it("checks dotted names against the external-service catalog", async () => {
    const dotted = `${ROOT}/actions/custom/apex/Servicenow.GetUsers`;
    const externalHit = transport(
      [
        (path) => (path === dotted ? notFound() : null),
        (path) => (path.includes("ApexClass") ? ok({ records: [] }) : null),
        (path) =>
          path === `${ROOT}/actions/standard` ? ok({ actions: [] }) : null,
        (path) =>
          path === `${ROOT}/actions/custom/externalService`
            ? ok({ actions: [{ name: "Servicenow.GetUsers" }] })
            : null,
      ],
      [],
    );
    expect(
      await collectFlowExecutionEvidence({
        root: ROOT,
        request: externalHit,
        invocables: ["Servicenow.GetUsers"],
      }),
    ).toEqual({});
    const externalMiss = transport(
      [
        (path) => (path === dotted ? notFound() : null),
        (path) => (path.includes("ApexClass") ? ok({ records: [] }) : null),
        ...emptyCatalogs,
      ],
      [],
    );
    expect(
      (
        await collectFlowExecutionEvidence({
          root: ROOT,
          request: externalMiss,
          invocables: ["Servicenow.GetUsers"],
        })
      ).missingInvocable,
    ).toBe("Servicenow.GetUsers");
  });

  it("skips invalid names without reads and caps candidates", async () => {
    const calls: string[] = [];
    const request = transport(
      [(path) => (path.includes("/actions/") ? notFound() : null), apexMiss, ...emptyCatalogs],
      calls,
    );
    expect(
      await collectFlowExecutionEvidence({
        root: ROOT,
        request,
        invocables: ["../../etc", "", 42, null],
      }),
    ).toEqual({});
    expect(calls).toEqual([]);
    // Every candidate present via the class table keeps the scan running
    // into the cap instead of stopping on the first missing name.
    const cappedCalls: string[] = [];
    const capped = transport(
      [
        (path) => (path.includes("/actions/custom/apex/") ? notFound() : null),
        (path) => {
          if (!path.includes("ApexClass")) return null;
          const name =
            decodeURIComponent(path).match(/Name='([^']+)'/)?.[1] ?? "One";
          return ok({ records: [{ Id: "01p000000000000AAA", Name: name }] });
        },
      ],
      cappedCalls,
    );
    const many = ["One", "Two", "Three", "Four"];
    await collectFlowExecutionEvidence({ root: ROOT, request: capped, invocables: many });
    const descriptorReads = cappedCalls.filter((call) =>
      call.includes("/actions/custom/apex/"),
    );
    expect(descriptorReads).toHaveLength(
      FLOW_EXECUTION_EVIDENCE_BOUNDS.invocablesChecked,
    );
  });

  it("reuses cached reads across calls", async () => {
    const calls: string[] = [];
    const cache: FlowExecutionEvidenceCache = {};
    const request = transport(
      [(path) => (path === APEX ? notFound() : null), apexMiss, ...emptyCatalogs],
      calls,
    );
    await collectFlowExecutionEvidence({
      root: ROOT,
      request,
      invocables: ["GetCustomerSignalsInsights"],
      cache,
    });
    expect(calls).toHaveLength(3);
    await collectFlowExecutionEvidence({
      root: ROOT,
      request,
      invocables: ["GetCustomerSignalsInsights"],
      cache,
    });
    expect(calls).toHaveLength(3);
  });
});

describe("collectFlowExecutionEvidence schema refs", () => {
  const assetWithout = {
    name: "Asset",
    fields: [{ name: "Id" }, { name: "Name" }],
  };
  const assetWith = {
    name: "Asset",
    fields: [{ name: "Id" }, { name: "ProductDescription" }],
  };
  const ref = { objectName: "Asset", fieldName: "ProductDescription" };

  it("proves skew when the live describe lacks the field", async () => {
    const calls: string[] = [];
    const request = transport(
      [(path) => (path.endsWith("/sobjects/Asset/describe") ? ok(assetWithout) : null)],
      calls,
    );
    const evidence = await collectFlowExecutionEvidence({
      root: ROOT,
      request,
      schemaRefs: [ref],
    });
    expect(evidence.missingSchemaField).toEqual(ref);
    expect(calls).toHaveLength(1);
  });

  it("withholds skew when the field or describe is present", async () => {
    const present = transport(
      [(path) => (path.endsWith("/sobjects/Asset/describe") ? ok(assetWith) : null)],
      [],
    );
    expect(
      await collectFlowExecutionEvidence({ root: ROOT, request: present, schemaRefs: [ref] }),
    ).toEqual({});
    const cased = transport(
      [
        (path) =>
          path.endsWith("/sobjects/Asset/describe")
            ? ok({ name: "Asset", fields: [{ name: "productdescription" }] })
            : null,
      ],
      [],
    );
    expect(
      await collectFlowExecutionEvidence({ root: ROOT, request: cased, schemaRefs: [ref] }),
    ).toEqual({});
  });

  it("never calls a failed object describe skew", async () => {
    for (const responder of [notFound, denied, failed]) {
      const request = transport(
        [(path) => (path.endsWith("/sobjects/Asset/describe") ? responder() : null)],
        [],
      );
      expect(
        await collectFlowExecutionEvidence({ root: ROOT, request, schemaRefs: [ref] }),
      ).toEqual({});
    }
  });

  it("reuses seeded describes and caps fresh ones", async () => {
    const seeded: FlowExecutionEvidenceCache = {
      describes: new Map([["Asset", new Set(["id", "name"])]]),
    };
    const calls: string[] = [];
    const request = transport([], calls);
    const evidence = await collectFlowExecutionEvidence({
      root: ROOT,
      request,
      schemaRefs: [ref],
      cache: seeded,
    });
    expect(evidence.missingSchemaField).toEqual(ref);
    expect(calls).toEqual([]);
    const freshCalls: string[] = [];
    const fresh = transport(
      [(path) => (path.endsWith("/describe") ? ok(assetWith) : null)],
      freshCalls,
    );
    const refs = ["A", "B", "C", "D"].map((objectName) => ({
      objectName,
      fieldName: "ProductDescription",
    }));
    expect(
      await collectFlowExecutionEvidence({ root: ROOT, request: fresh, schemaRefs: refs }),
    ).toEqual({});
    expect(
      freshCalls.filter((call) => call.includes("/describe")),
    ).toHaveLength(FLOW_EXECUTION_EVIDENCE_BOUNDS.describesFetched);
  });

  it("skips invalid refs and roots without reads", async () => {
    const calls: string[] = [];
    const request = transport(
      [(path) => (path.endsWith("/describe") ? ok(assetWithout) : null)],
      calls,
    );
    expect(
      await collectFlowExecutionEvidence({
        root: ROOT,
        request,
        schemaRefs: [{ objectName: "Asset", fieldName: "not a field" }, null, 42],
      }),
    ).toEqual({});
    expect(
      await collectFlowExecutionEvidence({
        root: "/bogus",
        request,
        schemaRefs: [ref],
      }),
    ).toEqual({});
    expect(calls).toEqual([]);
  });
});

describe("diagnoseFlowExecutionFault", () => {
  const opaque = (body: unknown, status = 400) => ({ status, body });

  it("narrows opaque faults with validated evidence", () => {
    const invocable = diagnoseFlowExecutionFault({
      ...opaque([{ message: OPAQUE, errorCode: "UNKNOWN_EXCEPTION" }]),
      evidence: { missingInvocable: "GetCustomerSignalsInsights" },
    });
    expect(invocable?.code).toBe("FLOW_EXECUTION_INVOCABLE_MISSING");
    expect(invocable?.retryable).toBe(true);
    const skew = diagnoseFlowExecutionFault({
      ...opaque([{ message: OPAQUE, errorCode: "UNKNOWN_EXCEPTION" }]),
      evidence: {
        missingSchemaField: { objectName: "Asset", fieldName: "ProductDescription" },
      },
    });
    expect(skew?.code).toBe("FLOW_EXECUTION_SCHEMA_SKEW");
    expect(skew?.retryable).toBe(false);
  });

  it("falls through to generic without evidence", () => {
    const fault = diagnoseFlowExecutionFault(
      opaque([{ message: OPAQUE, errorCode: "UNKNOWN_EXCEPTION" }]),
    );
    expect(fault?.code).toBe("MANAGED_FLOW_EXECUTION_FAULT");
    expect(fault?.retryable).toBe(true);
    expect(fault?.requirement).not.toContain("executing a flow interview");
  });

  it("falls through to generic on invalid evidence", () => {
    for (const evidence of [
      { missingInvocable: "../../etc" },
      { missingInvocable: 42 },
      { missingSchemaField: { objectName: "Asset", fieldName: "not a field" } },
      { missingSchemaField: null },
      null,
      "nope",
    ]) {
      const fault = diagnoseFlowExecutionFault({
        ...opaque([{ message: OPAQUE, errorCode: "UNKNOWN_EXCEPTION" }]),
        evidence: evidence as never,
      });
      expect(fault?.code).toBe("MANAGED_FLOW_EXECUTION_FAULT");
    }
  });

  it("stays unclassified without the opaque shape, even with evidence", () => {
    expect(
      diagnoseFlowExecutionFault({
        ...opaque([{ message: "Something else.", errorCode: "UNKNOWN_EXCEPTION" }]),
        evidence: { missingInvocable: "GetCustomerSignalsInsights" },
      }),
    ).toBeNull();
    expect(
      diagnoseFlowExecutionFault({
        ...opaque([{ message: OPAQUE, errorCode: "INVALID_INPUT" }]),
        evidence: { missingInvocable: "GetCustomerSignalsInsights" },
      }),
    ).toBeNull();
    expect(diagnoseFlowExecutionFault(opaque(null))).toBeNull();
  });
});
