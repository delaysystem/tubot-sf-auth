import { expect, test } from "bun:test";
import { invokeSessionPermissionContext } from "./session-permission-context";
const ps = "0PS000000000001AAA", assignment = "0Pa000000000001AAA", activation = "0Pa000000000002AAA", session = "0Ak000000000001AAA", user = "005000000000001AAA";
async function run(action: string, lie = false, reject = false, cleanupReject = false) {
  let permission: any, assigned: any, active = false;
  const calls: string[] = [];
  const result = await invokeSessionPermissionContext({ root: "/services/data/v67.0", route: `/services/data/v67.0/actions/standard/${action}`, userId: user,
    request: async (path, method = "GET", body) => {
      const reply = (status: number, body: any) => ({ status, ok: status >= 200 && status < 300, body });
      if (path.endsWith("/describe")) return reply(200, { createable: true, deletable: true, queryable: true, fields: ["Name", "Label", "HasActivationRequired"].map(name => ({ name, createable: true })) });
      if (path.includes("/query?")) return reply(200, { records: active ? [{ Id: activation, PermissionSetId: ps, AuthSessionId: session, UserId: user }] : [] });
      if (path.endsWith("/sobjects/PermissionSet") && method === "POST") { permission = body; return reply(201, { id: ps }); }
      if (path.endsWith("/sobjects/PermissionSetAssignment") && method === "POST") { assigned = body; return reply(201, { id: assignment }); }
      if (path.endsWith(`/${ps}`)) { if (method === "DELETE") { permission = undefined; return reply(204, null); } return permission ? reply(200, permission) : reply(404, []); }
      if (path.endsWith(`/${assignment}`)) { if (method === "DELETE") { assigned = undefined; return reply(204, null); } return assigned ? reply(200, assigned) : reply(404, []); }
      if (method === "GET") return reply(200, { inputs: [{ name: "PermSetName" }] });
      const operation = path.split("/").at(-1)!;
      calls.push(operation);
      if (reject && operation === action || cleanupReject && operation === "deactivateSessionPermSet") return reply(200, [{ isSuccess: false, errors: [{ message: "actual rejection" }] }]);
      if (!lie) active = operation === "activateSessionPermSet";
      return reply(200, [{ isSuccess: true, errors: null }]);
    } });
  return { result, calls, removed: !permission && !assigned, active };
}
for (const action of ["activateSessionPermSet", "deactivateSessionPermSet"]) test(`${action} verifies session state and cleans owned permissions`, async () => {
  const { result, removed, active } = await run(action);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.cleanupError).toBeUndefined();
  expect(removed).toBe(true);
  expect(active).toBe(false);
});
test("activation without a stored activation is rejected and cleaned", async () => {
  const { result, removed } = await run("activateSessionPermSet", true);
  expect(result.contextSchema?.verified).toBe(false);
  expect(result.status).toBe(422);
  expect(removed).toBe(true);
});
test("HTTP 200 session rejection stays a failure and cleans fixtures", async () => {
  const { result, removed } = await run("activateSessionPermSet", false, true);
  expect(result.body[0].isSuccess).toBe(false);
  expect(result.contextSchema?.verified).toBe(false);
  expect(removed).toBe(true);
});
test("failed deactivation cleanup is exposed", async () => {
  const { result } = await run("activateSessionPermSet", false, false, true);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.cleanupError).toContain("activation cleanup failed");
});
