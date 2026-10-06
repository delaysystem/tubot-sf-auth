import { expect, test } from "bun:test";
import { invokeWorkPlanContext, workPlanContextObjects } from "./work-plan-context";
test("Work Plan actions require only their actual context objects", () => {
  expect(workPlanContextObjects("addWorkPlans")).toEqual(["WorkOrder", "WorkPlanTemplate", "WorkPlan"]);
  expect(workPlanContextObjects("deleteWorkPlans")).toEqual(["WorkOrder", "WorkPlanTemplate", "WorkPlan"]);
  expect(workPlanContextObjects("addWorkSteps")).toEqual(["WorkOrder", "WorkPlan", "WorkStepTemplate", "WorkStep"]);
});
async function run(action: string, lie = false, reject = false) {
  const rows = new Map<string, any>();
  let counter = 0;
  const create = (object: string, body: any) => { const id = `a00${String(++counter).padStart(12, "0")}AAA`; rows.set(id, { ...body, Id: id, object }); return id; };
  const remove = (id: string) => { rows.delete(id); for (const [child, row] of rows) if (row.ParentRecordId === id || row.WorkPlanId === id) remove(child); };
  const result = await invokeWorkPlanContext({ root: "/services/data/v67.0", route: `/services/data/v67.0/actions/standard/${action}`, build: async (_name, _marker, values) => ({ values }),
    request: async (path, method = "GET", body) => {
      const reply = (status: number, body: any) => ({ status, ok: status >= 200 && status < 300, body });
      if (path.endsWith("/describe")) { const name = path.split("/").at(-2); return reply(200, { createable: true, deletable: true, queryable: true, fields: [
        { name: name === "WorkOrder" ? "Subject" : "Name", createable: true, filterable: true, nameField: name !== "WorkOrder", type: "string", length: 255 },
        { name: "IsActive", createable: true, type: "boolean" }, { name: "ParentRecordId", referenceTo: ["WorkOrder"] }, { name: "WorkPlanId", referenceTo: ["WorkPlan"] },
      ] }); }
      if (path.includes("/query?")) { const soql = decodeURIComponent(path); const field = soql.match(/WHERE (\w+)='/)?.[1]!; const parent = soql.match(/='([^']+)'/)?.[1]; return reply(200, { records: [...rows.values()].filter(r => r[field] === parent) }); }
      if (path.includes("/sobjects/")) {
        const [name, id] = path.split("/sobjects/")[1].split("/");
        if (method === "POST") return reply(201, { id: create(name, body) });
        if (method === "DELETE") { remove(id); return reply(204, null); }
        return rows.has(id) ? reply(200, rows.get(id)) : reply(404, []);
      }
      if (method === "GET") return reply(200, { inputs: ["recordId", "workPlanTemplateIdList", "workStepTemplateIdList"].map(name => ({ name })) });
      const operation = path.split("/").at(-1)!, args = body.inputs[0];
      if (reject && operation === action) return reply(200, [{ isSuccess: false, errors: [{ message: "real action rejection" }] }]);
      let outputs: any = {};
      if (!lie && operation === "addWorkPlans") outputs.workPlanIdList = [create("WorkPlan", { ParentRecordId: args.recordId, Name: rows.get(args.workPlanTemplateIdList[0]).Name })];
      if (!lie && operation === "addWorkSteps") outputs.workStepIdList = [create("WorkStep", { WorkPlanId: args.recordId, Name: rows.get(args.workStepTemplateIdList[0]).Name })];
      if (operation === "deleteWorkPlans") { for (const [id, row] of rows) if (row.object === "WorkPlan" && row.ParentRecordId === args.recordId) remove(id); }
      return reply(200, [{ isSuccess: true, errors: null, outputValues: outputs }]);
    } });
  return { result, remaining: rows.size };
}
for (const action of ["addWorkPlans", "addWorkSteps", "deleteWorkPlans"]) test(`${action} verifies owned mutation and cleans every fixture`, async () => {
  const { result, remaining } = await run(action);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.cleanupError).toBeUndefined();
  expect(remaining).toBe(0);
});
test("Work Plan upstream success without a created child is rejected", async () => {
  const { result, remaining } = await run("addWorkPlans", true);
  expect(result.status).toBe(422);
  expect(result.contextSchema?.verified).toBe(false);
  expect(remaining).toBe(0);
});
test("HTTP 200 Work Plan rejection remains a failure and cleans fixtures", async () => {
  const { result, remaining } = await run("addWorkPlans", false, true);
  expect(result.body[0].isSuccess).toBe(false);
  expect(result.contextSchema?.verified).toBe(false);
  expect(remaining).toBe(0);
});
