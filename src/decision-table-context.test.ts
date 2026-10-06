import { describe, expect, test } from "bun:test";
import {
  DECISION_TABLE_BUILDER_VERSION, decisionTableActionName, decisionTableArgs,
  invokeDecisionTableWithContext,
} from "./decision-table-context";

const ROOT = "/services/data/v67.0";
const routeFor = (name: string) => `${ROOT}/actions/custom/decisionTableAction/${name}`;
const ok = (body: any, status = 200) => ({ status, ok: status >= 200 && status < 300, body });

type Req = (path: string, method?: string, body?: any) => Promise<{ status: number; ok: boolean; body: any }>;

/** Live StandardTax_Default input vocabulary (all optional STRING/DATE). */
const standardTaxInputs = () => ([
  { name: "RateUsageType", type: "STRING", required: false, defaultValue: null, picklistValues: null, maxOccurs: 1 },
  { name: "ProductCode", type: "STRING", required: false, defaultValue: null, picklistValues: null, maxOccurs: 1 },
  { name: "ZipCode", type: "STRING", required: false, defaultValue: null, picklistValues: null, maxOccurs: 1 },
  { name: "EndDate", type: "DATE", required: false, defaultValue: null, picklistValues: null, maxOccurs: 1 },
  { name: "StartDate", type: "DATE", required: false, defaultValue: null, picklistValues: null, maxOccurs: 1 },
]);

describe("decision-table routing", () => {
  test("parses family routes and rejects other families", () => {
    expect(decisionTableActionName(routeFor("StandardTax_Default"))).toBe("StandardTax_Default");
    expect(decisionTableActionName(`${ROOT}/actions/custom/apex/SomeClass`)).toBeNull();
    expect(decisionTableActionName(`${ROOT}/actions/standard/getRecord`)).toBeNull();
  });

  test("builder version is pinned", () => {
    expect(DECISION_TABLE_BUILDER_VERSION).toBe(1);
  });
});

describe("decision-table args", () => {
  test("populates every all-optional input so the payload is never missing", () => {
    const built = decisionTableArgs(standardTaxInputs());
    expect("failure" in built).toBe(false);
    if ("failure" in built) return;
    expect(Object.keys(built.args).sort()).toEqual(
      ["EndDate", "ProductCode", "RateUsageType", "StartDate", "ZipCode"],
    );
    expect(built.args.EndDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(String(built.args.RateUsageType).length).toBeLessThanOrEqual(24);
  });

  test("prefers defaultValue, then active picklist, then type samples", () => {
    const built = decisionTableArgs([
      { name: "WithDefault", type: "STRING", required: false, defaultValue: "live-default", picklistValues: null, maxOccurs: 1 },
      { name: "WithPick", type: "STRING", required: false, defaultValue: null,
        picklistValues: [{ active: false, value: "stale" }, { active: true, value: "live-pick" }], maxOccurs: 1 },
      { name: "LowerBound", type: "DOUBLE", required: false, defaultValue: null, picklistValues: null, maxOccurs: 1 },
      { name: "Enabled", type: "BOOLEAN", required: false, defaultValue: null, picklistValues: null, maxOccurs: 1 },
    ]);
    expect("failure" in built).toBe(false);
    if ("failure" in built) return;
    expect(built.args).toMatchObject({ WithDefault: "live-default", WithPick: "live-pick", LowerBound: 0, Enabled: false });
  });

  test("wraps maxOccurs>1 values in arrays", () => {
    const built = decisionTableArgs([
      { name: "Codes", type: "STRING", required: false, defaultValue: null, picklistValues: null, maxOccurs: 2000 },
    ]);
    expect("failure" in built).toBe(false);
    if ("failure" in built) return;
    expect(Array.isArray(built.args.Codes)).toBe(true);
  });

  test("omits optional uninventable inputs but refuses required ones", () => {
    const optional = decisionTableArgs([
      { name: "RateUsageType", type: "STRING", required: false, defaultValue: null, picklistValues: null, maxOccurs: 1 },
      { name: "OwnerRef", type: "REFERENCE", required: false, defaultValue: null, picklistValues: null, maxOccurs: 1 },
    ]);
    expect("failure" in optional).toBe(false);
    if ("failure" in optional) return;
    expect(optional.args.OwnerRef).toBeUndefined();
    const required = decisionTableArgs([
      { name: "OwnerRef", type: "REFERENCE", required: true, defaultValue: null, picklistValues: null, maxOccurs: 1 },
    ]);
    expect("failure" in required).toBe(true);
  });

  test("leaves TIME unshaped: omitted when optional, refused when required", () => {
    const optional = decisionTableArgs([
      { name: "RateUsageType", type: "STRING", required: false, defaultValue: null, picklistValues: null, maxOccurs: 1 },
      { name: "AtTime", type: "TIME", required: false, defaultValue: null, picklistValues: null, maxOccurs: 1 },
    ]);
    expect("failure" in optional).toBe(false);
    if ("failure" in optional) return;
    expect(optional.args.AtTime).toBeUndefined();
    const required = decisionTableArgs([
      { name: "AtTime", type: "TIME", required: true, defaultValue: null, picklistValues: null, maxOccurs: 1 },
    ]);
    expect("failure" in required).toBe(true);
  });

  test("refuses empty descriptors and empty arg sets with no POST", () => {
    expect("failure" in decisionTableArgs([])).toBe(true);
    expect("failure" in decisionTableArgs(undefined)).toBe(true);
    expect("failure" in decisionTableArgs([
      { name: "OwnerRef", type: "REFERENCE", required: false, defaultValue: null, picklistValues: null, maxOccurs: 1 },
    ])).toBe(true);
  });
});

describe("decision-table lifecycle", () => {
  test("POSTs a non-empty payload and passes the native outcome through", async () => {
    const posts: any[] = [];
    const request: Req = async (path, method = "GET", body) => {
      if (method === "GET") return ok({ inputs: standardTaxInputs() });
      posts.push(body);
      return ok([{ actionName: "StandardTax_Default", errors: null, isSuccess: true, outputValues: {} }]);
    };
    const result = await invokeDecisionTableWithContext({ root: ROOT, route: routeFor("StandardTax_Default"), request });
    expect(result.status).toBe(200);
    expect(posts.length).toBe(1);
    expect(Object.keys(posts[0].inputs[0]).length).toBe(5);
    expect((result.contextSchema as any).verified).toBe(true);
    expect((result.contextSchema as any).inputCount).toBe(5);
  });

  test("refuses unbuildable args with no POST", async () => {
    let posted = false;
    const request: Req = async (path, method = "GET") => {
      if (method === "GET") return ok({ inputs: [] });
      posted = true;
      return ok(null, 500);
    };
    const result = await invokeDecisionTableWithContext({ root: ROOT, route: routeFor("StandardTax_Default"), request });
    expect(result.status).toBe(422);
    expect(posted).toBe(false);
    expect((result.body as any).errorCode).toBe("DECISION_TABLE_ARGS_UNBUILDABLE");
  });
});
