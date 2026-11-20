import { describe, expect, it } from "bun:test";
import {
  invokeRemainderBookingFlow,
  remainderScalarForField,
} from "./remainder-booking-flow-context";

type Result = { status: number; ok: boolean; body: any };

const ok = (body: any): Result => ({ status: 200, ok: true, body });
const created = (id: string): Result => ({ status: 201, ok: true, body: { id } });
const gone: Result = { status: 404, ok: false, body: null };

const CONTACT_ID = "003g50000000001AAA";
const SESSION_ID = "a08g50000000001AAA";
const BOOKING_ID = "a04g50000000001AAA";
const VERSION_ID = "301g50000000001AAA";

const bookingMetadata = () => ({
  variables: [
    { name: "contactId", dataType: "String", isInput: true },
    { name: "numberOfGuests", dataType: "Number", isInput: true },
    { name: "sessionId", dataType: "String", isInput: true },
  ],
  recordCreates: [{
    object: "Booking__c",
    inputAssignments: [
      { field: "Contact__c", value: { elementReference: "contactId" } },
      { field: "Number_of_Guests__c", value: { elementReference: "numberOfGuests" } },
      { field: "Session__c", value: { elementReference: "sessionId" } },
    ],
  }],
});

const bookingFields = () => [
  { name: "Contact__c", type: "reference", referenceTo: ["Contact"] },
  { name: "Number_of_Guests__c", type: "double" },
  { name: "Session__c", type: "reference", referenceTo: ["Session__c"] },
];

const contactFields = () => [
  { name: "LastName", type: "string", createable: true, filterable: true, length: 80, nameField: true },
  { name: "Email", type: "email", createable: true },
];

const sessionFields = () => [
  { name: "Name", type: "string", createable: false, autoNumber: true, nameField: true },
  { name: "Date__c", type: "date", createable: true },
];

function harness(options: {
  children?: any[];
  fixtureReadback?: (objectName: string, id: string, values: Record<string, unknown>) => any;
  invoke?: Result;
  deleteStatus?: number;
  metadata?: any;
  targetFields?: any[];
} = {}) {
  const calls: Array<{ path: string; method: string }> = [];
  const stored = new Map<string, Record<string, unknown>>();
  const request = async (path: string, method = "GET", body?: any): Promise<Result> => {
    calls.push({ path, method });
    const root = "/services/data/v67.0";
    if (path === `${root}/actions/custom/flow/Create_Booking` && method === "GET") {
      return ok({ inputs: [
        { name: "contactId", type: "STRING" }, { name: "numberOfGuests", type: "DOUBLE" }, { name: "sessionId", type: "STRING" },
      ] });
    }
    if (path.startsWith(`${root}/tooling/query`) && path.includes("FlowDefinition")) {
      return ok({ records: [{ DeveloperName: "Create_Booking", NamespacePrefix: null, ActiveVersionId: VERSION_ID }] });
    }
    if (path.startsWith(`${root}/tooling/query`) && path.includes("SELECT%20Metadata")) {
      return ok({ records: [{ Metadata: options.metadata ?? bookingMetadata() }] });
    }
    if (path === `${root}/sobjects/Booking__c/describe`) {
      return ok({ createable: true, queryable: true, deletable: true, fields: options.targetFields ?? bookingFields() });
    }
    if (path === `${root}/sobjects/Contact/describe`) {
      return ok({ createable: true, queryable: true, deletable: true, fields: contactFields() });
    }
    if (path === `${root}/sobjects/Session__c/describe`) {
      return ok({ createable: true, queryable: true, deletable: true, fields: sessionFields() });
    }
    if (method === "POST" && path === `${root}/sobjects/Contact`) {
      stored.set(`Contact/${CONTACT_ID}`, body);
      return created(CONTACT_ID);
    }
    if (method === "POST" && path === `${root}/sobjects/Session__c`) {
      stored.set(`Session__c/${SESSION_ID}`, body);
      return created(SESSION_ID);
    }
    if (method === "GET" && (path === `${root}/sobjects/Contact/${CONTACT_ID}` ||
        path === `${root}/sobjects/Session__c/${SESSION_ID}`)) {
      const key = path.slice(`${root}/sobjects/`.length);
      const values = stored.get(key);
      if (!values) return gone;
      const [objectName, id] = key.split("/");
      if (options.fixtureReadback) return ok(options.fixtureReadback(objectName, id, values));
      return ok({ Id: id, ...values });
    }
    if (method === "POST" && path === `${root}/actions/custom/flow/Create_Booking`) {
      return options.invoke ?? ok([{ isSuccess: true, errors: [],
        outputValues: { createdBooking: { Id: BOOKING_ID } } }]);
    }
    if (method === "GET" && path.startsWith(`${root}/query`)) {
      if (path.includes("Booking__c")) {
        return ok({ records: options.children ?? [{ Id: BOOKING_ID,
          Contact__c: CONTACT_ID, Session__c: SESSION_ID, Number_of_Guests__c: 2 }] });
      }
      return ok({ records: [] });
    }
    if (method === "DELETE") {
      if (options.deleteStatus === 404) return gone;
      stored.delete(path.slice(`${root}/sobjects/`.length));
      return { status: 204, ok: true, body: null };
    }
    if (method === "GET" && path.includes("/sobjects/")) return gone;
    throw new Error(`unexpected ${method} ${path}`);
  };
  const build = async (_name: string, _marker: string, values: Record<string, unknown>) => ({ values });
  return { calls, request, build, stored };
}

const route = "/services/data/v67.0/actions/custom/flow/Create_Booking";

describe("invokeRemainderBookingFlow", () => {
  it("runs the proven owned lifecycle and verifies exactly one child", async () => {
    const h = harness();
    const result = await invokeRemainderBookingFlow({
      root: "/services/data/v67.0", route, request: h.request, build: h.build,
    });
    expect(result.status).toBe(200);
    expect(result.cleanupError).toBeUndefined();
    const schema = result.contextSchema as Record<string, any>;
    expect(schema.verified).toBe(true);
    expect(schema.createdRecordId).toBe(BOOKING_ID);
    expect(schema.verificationRecordIds).toEqual([BOOKING_ID]);
    const invoked = h.calls.find(call =>
      call.path === route && call.method === "POST");
    expect(invoked).toBeDefined();
    const readback = h.calls.find(call =>
      call.method === "GET" && call.path.includes("/query?") && decodeURIComponent(call.path).includes("FROM Booking__c"));
    expect(readback).toBeDefined();
    expect(decodeURIComponent(readback!.path)).toContain("Number_of_Guests__c");
  });

  it("rejects non-flow routes without Salesforce writes", async () => {
    const h = harness();
    const result = await invokeRemainderBookingFlow({
      root: "/services/data/v67.0",
      route: "/services/data/v67.0/actions/standard/createCart",
      request: h.request, build: h.build,
    });
    expect(result.status).toBe(422);
    expect(h.calls).toEqual([]);
  });

  it("refuses flows without exactly one record creation", async () => {
    const h = harness({ metadata: { variables: [], recordCreates: [] } });
    const result = await invokeRemainderBookingFlow({
      root: "/services/data/v67.0", route, request: h.request, build: h.build,
    });
    expect(result.status).toBe(422);
    expect((result.body as any).errorCode).toBe("REMAINDER_BOOKING_SHAPE_UNSUPPORTED");
  });

  it("names the missing live field instead of failing opaquely", async () => {
    const h = harness({ targetFields: [
      { name: "Contact__c", type: "reference", referenceTo: ["Contact"] },
      { name: "Session__c", type: "reference", referenceTo: ["Session__c"] },
    ] });
    const result = await invokeRemainderBookingFlow({
      root: "/services/data/v67.0", route, request: h.request, build: h.build,
    });
    expect(result.status).toBe(422);
    expect((result.body as any).errorCode).toBe("REMAINDER_BOOKING_FIELD_UNAVAILABLE");
    expect((result.body as any).missingFields).toEqual(["Number_of_Guests__c"]);
  });

  it("rejects unverified fixture readback", async () => {
    const h = harness({
      fixtureReadback: (objectName, id) => ({ Id: id, LastName: "wrong marker" }),
    });
    const result = await invokeRemainderBookingFlow({
      root: "/services/data/v67.0", route, request: h.request, build: h.build,
    });
    expect(result.status).toBe(422);
    expect((result.body as any).errorCode).toBe("REMAINDER_BOOKING_FIXTURE_UNVERIFIED");
  });

  it("rejects native success without exactly one owned child", async () => {
    const h = harness({ children: [] });
    const result = await invokeRemainderBookingFlow({
      root: "/services/data/v67.0", route, request: h.request, build: h.build,
    });
    expect(result.status).toBe(422);
    expect((result.body as any).errorCode).toBe("REMAINDER_BOOKING_MUTATION_UNVERIFIED");
    expect((result.contextSchema as any).verified).toBe(false);
  });

  it("rejects scalar values that do not match the owned child", async () => {
    const h = harness({ children: [{ Id: BOOKING_ID,
      Contact__c: CONTACT_ID, Session__c: SESSION_ID, Number_of_Guests__c: 99 }] });
    const result = await invokeRemainderBookingFlow({
      root: "/services/data/v67.0", route, request: h.request, build: h.build,
    });
    expect((result.body as any).errorCode).toBe("REMAINDER_BOOKING_MUTATION_UNVERIFIED");
  });

  it("reports unverified cleanup and withholds verification", async () => {
    const h = harness({ deleteStatus: 404 });
    const result = await invokeRemainderBookingFlow({
      root: "/services/data/v67.0", route, request: h.request, build: h.build,
    });
    expect(result.cleanupError).toBeDefined();
    expect((result.contextSchema as any).verified).toBe(false);
  });
});

describe("remainderScalarForField", () => {
  it("synthesizes live-typed scalars and refuses unknown types", () => {
    expect(remainderScalarForField({ type: "double" }, "m")).toBe(2);
    expect(remainderScalarForField({ type: "boolean" }, "m")).toBe(false);
    expect(remainderScalarForField({ type: "date" }, "m")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(remainderScalarForField({ type: "email" }, "m")).toContain("@example.invalid");
    expect(remainderScalarForField({ type: "string", length: 80 }, "marker")).toBe("marker");
    expect(remainderScalarForField({ type: "string", length: 2 }, "marker")).toBeUndefined();
    expect(remainderScalarForField({ type: "time" }, "m")).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(remainderScalarForField({ type: "base64" }, "m")).toBe("QWN0aW9uUHJvYmU=");
    expect(remainderScalarForField({ type: "encryptedstring", length: 80 }, "marker")).toBe("marker");
    expect(remainderScalarForField({ type: "reference" }, "m")).toBeUndefined();
  });
});
