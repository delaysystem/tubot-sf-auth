import { expect, test } from "bun:test";
import { flowLookupBindings, flowFixtureValue } from "./action-flow-context";
test("Flow lookup recipes use input-variable filters from any tenant definition", () => {
  expect(flowLookupBindings({variables:[{name:"arbitraryInput",isInput:true},{name:"internalOnly",isInput:false}],
    recordLookups:[{object:"TenantPerson__c",filters:[{field:"LookupKey__c",operator:"EqualTo",value:{elementReference:"arbitraryInput"}},
      {field:"Internal__c",operator:"EqualTo",value:{elementReference:"internalOnly"}}]}]}))
    .toEqual([{objectName:"TenantPerson__c",fieldName:"LookupKey__c",inputName:"arbitraryInput"}]);
  expect(flowLookupBindings({variables:[],recordLookups:[{object:"bad/path",filters:[]}]})).toEqual([]);
});
test("fixture values obey accessible live field definitions", () => {
  expect(flowFixtureValue({type:"email",createable:true},"abc")).toBe("action-probe-abc@example.invalid");
  expect(flowFixtureValue({type:"string",createable:true,length:8},"abc")).toBe("ActionPr");
  expect(flowFixtureValue({type:"string",createable:false},"abc")).toBeUndefined();
  expect(flowFixtureValue({type:"reference",createable:true},"abc")).toBeUndefined();
  expect(flowFixtureValue({type:"phone",createable:true},"abc")).toBe("+15550100123");
  expect(flowFixtureValue({type:"url",createable:true},"abc")).toBe("https://example.invalid/action-searcher");
  expect(flowFixtureValue({type:"time",createable:true},"abc")).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(flowFixtureValue({type:"base64",createable:true},"abc")).toBe("QWN0aW9uUHJvYmU=");
  expect(flowFixtureValue({type:"encryptedstring",createable:true,length:8},"abc")).toBe("ActionPr");
  expect(flowFixtureValue({type:"combobox",createable:true,picklistValues:[{active:true,value:"Online"},{active:false,value:"Stale"}]},"abc")).toBe("Online");
  expect(flowFixtureValue({type:"combobox",createable:true,length:8},"abc")).toBe("ActionPr");
});
