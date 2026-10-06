import { expect, test } from "bun:test";
import { invokePricebookContext } from "./pricebook-action-context";
const parent = "006000000000001AAA", book = "01s000000000001AAA";
async function probe(mode = "success") {
  let row: any, deleted = false;
  const result = await invokePricebookContext({ root: "/services/data/v67.0", route: "/services/data/v67.0/actions/standard/choosePricebook", target: "Opportunity",
    build: async (_name, _marker, values) => ({ values }),
    request: async function execute(path, method = "GET", body):Promise<any> {
      const response = (status: number, body: any) => ({ status, ok: status >= 200 && status < 300, body });
      if(path.endsWith("/composite/batch")){const results=[];for(const op of body.batchRequests){const value=await execute("/services/data/"+op.url,op.method);results.push({statusCode:value.status,result:value.body});}return response(200,{results});}
      if (path.endsWith("/describe")) return response(200, { createable: true, queryable: true, deletable: true, fields: [{ name: "Name", nameField: true, createable: true, filterable: true, type: "string", length: 120 }, { name: "Pricebook2Id", type: "reference", referenceTo: ["Pricebook2"], createable: true, updateable: true }] });
      if (path.includes("/query?")) return response(200, { records: decodeURIComponent(path).includes("FROM Pricebook2")?[{Id:book}]:row?[{Id:parent}]:[] });
      if (path.endsWith("/sobjects/Opportunity") && method === "POST") { row = {...body,Id:parent}; return response(201, { id: parent }); }
      if (path.endsWith(`/${parent}`)) { if (method === "DELETE") { row = undefined; deleted = true; return response(204, null); } return row ? response(200, row) : response(404, null); }
      if (path.endsWith("/choosePricebook") && method === "POST") {
        expect(body.inputs[0]).toEqual({ parentEntityId: parent, pricebook2Id: "" });
        if (mode === "success") row.Pricebook2Id = null;
        return response(200, [{ isSuccess: mode !== "reject", errors: mode === "reject" ? [{ message: "rejected" }] : null }]);
      }
      return response(200, { inputs: [{ name: "parentEntityId" }, { name: "pricebook2Id" }] });
    } });
  return { result, deleted };
}
test("price-book removal verifies a real field change and deletes only the owned parent", async () => {
  const { result, deleted } = await probe();
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.expectedChanges).toEqual({ Pricebook2Id: null });
  expect(deleted).toBe(true);
});
test("price-book provider success without a field change is rejected", async () => {
  const { result, deleted } = await probe("unchanged");
  expect(result.status).toBe(422);
  expect(result.contextSchema?.verified).toBe(false);
  expect(deleted).toBe(true);
});
test("price-book business rejections remain failures and still clean the parent", async () => {
  const { result, deleted } = await probe("reject");
  expect(result.body[0].isSuccess).toBe(false);
  expect(deleted).toBe(true);
});
