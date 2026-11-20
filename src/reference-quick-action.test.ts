import { expect, test } from "bun:test";
import { REFERENCE_QUICK_ACTION_BUILDER_VERSION, invokeReferenceQuickAction } from "./reference-quick-action";

async function probe(createChild: boolean, rejectParentRead = false, rejectCleanup = false, chatter = false, returnedRecord = false, deadRoute = false) {
  const root = "/services/data/v67.0", parentId = "a01000000000001AAA", childId = "a02000000000001AAA";
  const userId = "005000000000001AAA", executionId = "005000000000002AAA";
  const removed = new Set<string>(); let marker = "", invoked = false;
  const result = await invokeReferenceQuickAction({ root, route: `${root}/actions/custom/quickAction/Tenant_Group__c/AddMember`,
    target: "Tenant_Link__c", parent: "Tenant_Group__c", parentField: "Group__c", integrationUserId: executionId,
    ...(returnedRecord ? { outputRecordField: "createdRecord" } : {}),
    ...(chatter ? { contextInputName: "parentRecord", markerInputName: "message", markerTargetField: "Content__c", source: "salesforce_live_chatter_action" } : {}),
    fields: [{ name: "Group__c", type: "reference", referenceTo: ["Tenant_Group__c"] },
      { name: "Member__c", type: "reference", referenceTo: ["User"], createable: !chatter, nillable: false }],
    inputs: [{ name: "contextId", required: true }, { name: "Member__c", required: true }],
    build: async (_objectName, _marker, values) => ({ values }),
    request: async (path, method, body) => {
      const response = (status: number, body: any) => ({ status, ok: status >= 200 && status < 300, body });
      if (path.endsWith("Tenant_Group__c/describe")) return response(200, { createable: true, queryable: true, deletable: true,
        fields: [{ name: "Name", createable: true, filterable: true, nameField: true, type: "string", length: 40 }] });
      if (path.endsWith("Tenant_Group__c") && method === "POST") { marker = body.Name; expect(marker.length).toBeLessThanOrEqual(40); return response(201, { id: parentId }); }
      if (path.includes("/query?")) {
        const q = decodeURIComponent(path.split("q=")[1]);
        if (q.includes("FROM User")) { expect(q).toContain(`Id!='${executionId}'`); return response(200, { records: [{ Id: userId }] }); }
        expect(q).toContain(chatter ? `Group__c='${parentId}'` : `Group__c='${parentId}' AND Member__c='${userId}'`);
        return response(200, { records: createChild ? [{ Id: childId }] : [] });
      }
      if (path.includes("/actions/")) { invoked = true; expect(body.inputs[0]).toEqual(chatter ? { parentRecord: parentId, message: marker } : { contextId: parentId, Member__c: userId }); if (deadRoute) return response(404, [{ message: "The requested resource does not exist", errorCode: "NOT_FOUND" }]); return response(200, [{ isSuccess: true, errors: [], ...(returnedRecord ? { outputValues: { createdRecord: childId } } : {}) }]); }
      if (method === "DELETE") { if (rejectCleanup) return response(403, []); removed.add(path); return response(204, null); }
      if (removed.has(path)) return response(404, []);
      if (path.endsWith(parentId)) return rejectParentRead ? response(502, []) : response(200, { Id: parentId, Name: marker });
      if (path.endsWith(childId) && !createChild) return response(404, []);
      if (path.endsWith(childId)) return response(200, { Id: childId, Group__c: parentId, Member__c: userId, Content__c: marker });
      throw Error("Unexpected route");
    },
  });
  return { result, invoked, removed };
}
test("reference Quick Actions verify owned parent and child tuples without a child string marker", async () => {
  const { result, invoked, removed } = await probe(true);
  expect(invoked).toBe(true); expect(removed.size).toBe(2);
  expect(result.contextSchema).toMatchObject({ ownershipKind: "parent_reference", verified: true,
    verificationRecordIds: ["a02000000000001AAA"], expectedChanges: { Group__c: "a01000000000001AAA", Member__c: "005000000000001AAA" } });
  expect(result.cleanupError).toBeUndefined();
});
test("a successful upstream response without a real reference child remains rejected", async () => {
  const { result, removed } = await probe(false);
  expect(result.status).toBe(422); expect(result.contextSchema?.verified).toBe(false); expect(removed.size).toBe(1);
});
test("early readback failures still surface failed cleanup", async () => {
  const { result, invoked } = await probe(false, true, true);
  expect(invoked).toBe(false); expect(result.status).toBe(422); expect(result.cleanupError).toBeDefined();
});

test("feed-style actions verify the actual marker text and parent reference", async () => {
  const { result, removed } = await probe(true, false, false, true);
  expect(result.status).toBe(200); expect(removed.size).toBe(2);
  expect(result.contextSchema).toMatchObject({ source: "salesforce_live_chatter_action", verified: true,
    changedFields: ["Group__c", "Content__c"], expectedChanges: { Group__c: "a01000000000001AAA", Content__c: expect.stringContaining("AS probe ") } });
});

test("returned child IDs require actual readback rather than an upstream success flag", async () => {
  const accepted = await probe(true, false, false, true, true);
  expect(accepted.result.contextSchema?.verified).toBe(true);
  expect(accepted.result.contextSchema?.referenceAttempts).toContainEqual(expect.objectContaining({ verificationSource: "returned_record_readback" }));
  const missing = await probe(false, false, false, true, true);
  expect(missing.result.status).toBe(422); expect(missing.result.contextSchema?.verified).toBe(false);
});

test("reference Quick Action builder version stays above the reselect floor", () => {
  expect(Number.isInteger(REFERENCE_QUICK_ACTION_BUILDER_VERSION)).toBe(true);
  expect(REFERENCE_QUICK_ACTION_BUILDER_VERSION).toBeGreaterThan(125);
});

test("owned parents seed required references from live lookups", async () => {
  const root = "/services/data/v67.0", parentId = "a01000000000001AAA", childId = "a02000000000001AAA";
  const liveHoursId = "a03000000000001AAA";
  const removed = new Set<string>(); let marker = "", invoked = false;
  const builtValues: Array<Record<string, any>> = [];
  const result = await invokeReferenceQuickAction({ root, route: `${root}/actions/custom/quickAction/Tenant_Group__c/AddMember`,
    target: "Tenant_Link__c", parent: "Tenant_Group__c", parentField: "Group__c", integrationUserId: "005000000000002AAA",
    fields: [{ name: "Group__c", type: "reference", referenceTo: ["Tenant_Group__c"] }],
    inputs: [{ name: "contextId", required: true }],
    build: async (_objectName, _marker, values) => { builtValues.push(values); return { values }; },
    request: async (path, method, body) => {
      const response = (status: number, body: any) => ({ status, ok: status >= 200 && status < 300, body });
      if (path.endsWith("Tenant_Group__c/describe")) return response(200, { createable: true, queryable: true, deletable: true,
        fields: [{ name: "Name", createable: true, filterable: true, nameField: true, type: "string", length: 40 },
          { name: "HoursId", type: "reference", createable: true, nillable: false, defaultedOnCreate: false, referenceTo: ["Tenant_Hours__c"] }] });
      if (path.endsWith("Tenant_Group__c") && method === "POST") { marker = body.Name; return response(201, { id: parentId }); }
      if (path.includes("/query?")) {
        const q = decodeURIComponent(path.split("q=")[1]);
        if (q.includes("FROM Tenant_Hours__c")) return response(200, { records: [{ Id: liveHoursId }] });
        expect(q).toContain(`Group__c='${parentId}'`);
        return response(200, { records: [{ Id: childId }] });
      }
      if (path.includes("/actions/")) { invoked = true; expect(body.inputs[0]).toEqual({ contextId: parentId }); return response(200, [{ isSuccess: true, errors: [] }]); }
      if (method === "DELETE") { removed.add(path); return response(204, null); }
      if (removed.has(path)) return response(404, []);
      if (path.endsWith(parentId)) return response(200, { Id: parentId, Name: marker });
      if (path.endsWith(childId)) return response(200, { Id: childId, Group__c: parentId });
      throw Error("Unexpected route");
    },
  });
  expect(builtValues[0].HoursId).toBe(liveHoursId);
  expect(invoked).toBe(true); expect(removed.size).toBe(2);
  expect(result.contextSchema).toMatchObject({ verified: true, verificationRecordIds: [childId] });
  expect(result.cleanupError).toBeUndefined();
});

test("invoke-404 returns dead-route learning and still cleans the owned parent", async () => {
  const { result, invoked, removed } = await probe(false, false, false, false, false, true);
  expect(invoked).toBe(true);
  expect(result.status).toBe(404);
  expect(result.body).toMatchObject({ errorCode: "QUICK_ACTION_ROUTE_DEAD", deadRoute: true, retryable: false });
  expect(result.contextSchema?.verified).toBe(false);
  expect([...removed].some((path) => path.endsWith("a01000000000001AAA"))).toBe(true);
});
