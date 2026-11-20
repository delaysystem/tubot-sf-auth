import { describe, expect, it } from "bun:test";
import {
  sweepFlowCommunicationResidue,
  type SweepRequest,
} from "./flow-residue-sweep";

const ok = (body: unknown = {}) => ({ status: 200, ok: true, body });

describe("sweepFlowCommunicationResidue", () => {
  it("deletes only exact fixture-owned rows and verifies absence", async () => {
    const calls: Array<{ path: string; method?: string }> = [];
    let tasks = [{ Id: "00Tg50000001AAA" }];
    let emails = [{ Id: "02sg50000001AAA" }];
    const request: SweepRequest = async (path, method) => {
      calls.push({ path, method });
      if (path.includes("/query?")) {
        const soql = decodeURIComponent(path.split("q=")[1]);
        if (soql.includes("FROM Task ")) return ok({ records: tasks });
        if (soql.includes("FROM EmailMessage ")) return ok({ records: emails });
        return { status: 400, ok: false, body: {} };
      }
      if (method === "DELETE") {
        if (path.endsWith("00Tg50000001AAA")) tasks = [];
        if (path.endsWith("02sg50000001AAA")) emails = [];
        return { status: 204, ok: true, body: null };
      }
      return { status: 400, ok: false, body: {} };
    };
    const sweep = await sweepFlowCommunicationResidue(request, "/services/data/v67.0", {
      contactIds: ["003g50000001AAA"],
      emails: ["flow-probe-uuid@example.invalid"],
    });
    expect(sweep).toEqual({ queried: true, deleted: 2, verified: true });
    const queryPaths = calls.filter((call) => call.path.includes("/query?"));
    expect(queryPaths.length).toBe(4);
    // Exact-match only: no LIKE, no name matching, exact fixture values only.
    for (const call of queryPaths) {
      expect(call.path).not.toContain("LIKE");
      expect(call.path).not.toContain("Action Searcher");
    }
    expect(queryPaths[0].path).toContain(encodeURIComponent("'003g50000001AAA'"));
    expect(queryPaths[1].path).toContain("flow-probe-uuid%40example.invalid");
  });
  it("reports unverified when a witnessed row cannot be removed", async () => {
    const request: SweepRequest = async (path, method) => {
      if (path.includes("/query?")) return ok({ records: [{ Id: "02sg50000001AAA" }] });
      if (method === "DELETE") return { status: 403, ok: false, body: {} };
      return { status: 400, ok: false, body: {} };
    };
    const sweep = await sweepFlowCommunicationResidue(request, "/services/data/v67.0", {
      contactIds: [],
      emails: ["flow-probe-uuid@example.invalid"],
    });
    expect(sweep).toEqual({ queried: true, deleted: 0, verified: false });
  });
  it("reports unqueried when the execution identity cannot query, without failing", async () => {
    const request: SweepRequest = async () => ({ status: 403, ok: false, body: {} });
    const sweep = await sweepFlowCommunicationResidue(request, "/services/data/v67.0", {
      contactIds: ["003g50000001AAA"],
      emails: [],
    });
    expect(sweep).toEqual({ queried: false, deleted: 0, verified: false });
  });
  it("ignores values it did not generate and no-ops when empty", async () => {
    let calls = 0;
    const request: SweepRequest = async () => {
      calls += 1;
      return ok({ records: [] });
    };
    const sweep = await sweepFlowCommunicationResidue(request, "/services/data/v67.0", {
      contactIds: ["not-an-id", "003g50000001AAA"],
      emails: ["not-an-email"],
    });
    expect(sweep).toEqual({ queried: true, deleted: 0, verified: true });
    // One Task query + one Task recheck; the invalid email is never queried.
    expect(calls).toBe(2);
  });
});
