import { expect, test } from "bun:test";
import { flowCreationRecipes } from "./flow-creation-context";
const variables = [{ name: "parentId", isInput: true }, { name: "amount", isInput: true }];
test("creation recipe follows live assignments rather than action or org names", () => {
  expect(flowCreationRecipes({ variables, recordCreates: [{ object: "Tenant_Child__c", inputAssignments: [
    { field: "Parent__c", value: { elementReference: "parentId" } }, { field: "Value__c", value: { elementReference: "amount" } }] }] }))
    .toEqual([{ objectName: "Tenant_Child__c", fields: [{ field: "Parent__c", inputName: "parentId" }, { field: "Value__c", inputName: "amount" }] }]);
});
test("collection creation follows the actual loop and record assembly", () => {
  expect(flowCreationRecipes({ variables: [{ name: "parents", isInput: true, isCollection: true },
    { name: "children", objectType: "Tenant_Child__c", isCollection: true }],
    loops: [{ name: "CurrentParent", collectionReference: "parents" }],
    assignments: [{ assignmentItems: [{ assignToReference: "children", operator: "Add", value: { elementReference: "child" } },
      { assignToReference: "child.Parent__c", operator: "Assign", value: { elementReference: "CurrentParent.Id" } }] }],
    recordCreates: [{ inputReference: "children" }] })).toEqual([{ objectName: "Tenant_Child__c",
      fields: [{ field: "Parent__c", inputName: "parents", inputField: "Id", collection: true }] }]);
});
test("unresolved assignment chains and additional mutations remain explicit", () => {
  expect(flowCreationRecipes({ variables, recordCreates: [{ object: "Tenant_Child__c", inputAssignments: [{ field: "Value__c", value: { elementReference: "unknownFormula" } }] }] })).toEqual([]);
  expect(flowCreationRecipes({ variables, recordCreates: [], recordUpdates: [{}] })).toEqual([]);
});
