import { afterEach, describe, expect, test } from "bun:test";
import { synthesizeRecordValues } from "./index";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// Person-Account org describe shape (live sdostainless): Account.Name is
// nillable in the describe but REQUIRED at runtime for business records.
const personAccountSchema = {
  fields: [
    { name: "Name", type: "string", length: 255, nillable: true, defaultedOnCreate: false, createable: true, filterable: true, updateable: true, nameField: true, compoundFieldName: "Name", calculated: false, autoNumber: false },
    { name: "LastName", type: "string", length: 80, nillable: true, defaultedOnCreate: false, createable: true, filterable: true, updateable: true, nameField: true, compoundFieldName: "Name", calculated: false, autoNumber: false },
    { name: "AccountNumber", type: "string", length: 40, nillable: true, defaultedOnCreate: false, createable: true, filterable: true, updateable: true, nameField: false, compoundFieldName: null, calculated: false, autoNumber: false },
    { name: "RecordTypeId", type: "reference", length: 18, nillable: true, defaultedOnCreate: false, createable: true, filterable: true, updateable: true, nameField: false, compoundFieldName: null, calculated: false, autoNumber: false },
  ],
  recordTypeInfos: [
    { recordTypeId: "012gL000006Qiy9QAC", name: "Business", master: false, available: true, defaultRecordTypeMapping: true },
  ],
};

describe("synthesizeRecordValues identity names", () => {
  test("populates nillable self-compound Name, never Person members", async () => {
    globalThis.fetch = (() => { throw new Error("network must not be used"); }) as unknown as typeof fetch;
    const built = await synthesizeRecordValues({} as never, {} as never, "/services/data/v67.0",
      "Account", "AS probe marker", { AccountNumber: "AS probe marker" }, new Map(), personAccountSchema);
    if ("failure" in built) throw new Error(`unexpected failure: ${JSON.stringify(built.failure)}`);
    expect(typeof built.values.Name).toBe("string");
    expect(String(built.values.Name).length).toBeGreaterThan(0);
    expect("LastName" in built.values).toBe(false);
    expect(built.values.AccountNumber).toBe("AS probe marker");
    expect(built.values.RecordTypeId).toBe("012gL000006Qiy9QAC");
  });

  test("omits RecordTypeId where the live object has no such column", async () => {
    globalThis.fetch = (() => { throw new Error("network must not be used"); }) as unknown as typeof fetch;
    // Live Asset shape: a Master recordTypeInfos entry exists, but the
    // object exposes no RecordTypeId field and rejects the column.
    const assetSchema = {
      fields: [
        { name: "Name", type: "string", length: 255, nillable: false, defaultedOnCreate: false, createable: true, filterable: true, updateable: true, nameField: true, compoundFieldName: null, calculated: false, autoNumber: false },
      ],
      recordTypeInfos: [
        { recordTypeId: "012000000000000AAA", name: "Master", master: true, available: true, defaultRecordTypeMapping: true },
      ],
    };
    const built = await synthesizeRecordValues({} as never, {} as never, "/services/data/v67.0",
      "Asset", "AS probe marker", {}, new Map(), assetSchema);
    if ("failure" in built) throw new Error(`unexpected failure: ${JSON.stringify(built.failure)}`);
    expect("RecordTypeId" in built.values).toBe(false);
    expect(typeof built.values.Name).toBe("string");
  });

  test("omits RecordTypeId when only Master describes as default", async () => {
    globalThis.fetch = (() => { throw new Error("network must not be used"); }) as unknown as typeof fetch;
    // Live Opportunity shape for users without an assigned type: real
    // types are available but not default, Master is the default.
    // Sending the Master placeholder 400s; omitting resolves Master.
    const oppSchema = {
      fields: [
        { name: "Name", type: "string", length: 255, nillable: false, defaultedOnCreate: false, createable: true, filterable: true, updateable: true, nameField: true, compoundFieldName: null, calculated: false, autoNumber: false },
        { name: "RecordTypeId", type: "reference", length: 18, nillable: true, defaultedOnCreate: false, createable: true, filterable: true, updateable: true, nameField: false, compoundFieldName: null, calculated: false, autoNumber: false },
      ],
      recordTypeInfos: [
        { recordTypeId: "012gL000006Qiy3QAC", name: "Simple", master: false, available: true, defaultRecordTypeMapping: false },
        { recordTypeId: "012000000000000AAA", name: "Master", master: true, available: true, defaultRecordTypeMapping: true },
      ],
    };
    const built = await synthesizeRecordValues({} as never, {} as never, "/services/data/v67.0",
      "Opportunity", "AS probe marker", {}, new Map(), oppSchema);
    if ("failure" in built) throw new Error(`unexpected failure: ${JSON.stringify(built.failure)}`);
    expect("RecordTypeId" in built.values).toBe(false);
  });

  test("required names keep their existing behavior", async () => {
    globalThis.fetch = (() => { throw new Error("network must not be used"); }) as unknown as typeof fetch;
    const schema = {
      fields: [
        { name: "Name", type: "string", length: 255, nillable: false, defaultedOnCreate: false, createable: true, filterable: true, updateable: true, nameField: true, compoundFieldName: null, calculated: false, autoNumber: false },
      ],
      recordTypeInfos: [],
    };
    const built = await synthesizeRecordValues({} as never, {} as never, "/services/data/v67.0",
      "Account", "AS probe marker", {}, new Map(), schema);
    if ("failure" in built) throw new Error(`unexpected failure: ${JSON.stringify(built.failure)}`);
    expect(String(built.values.Name).startsWith("AS probe marker")).toBe(true);
  });

  test("non-createable nillable names stay omitted without failing", async () => {
    globalThis.fetch = (() => { throw new Error("network must not be used"); }) as unknown as typeof fetch;
    const schema = {
      fields: [
        { name: "Name", type: "string", length: 255, nillable: true, defaultedOnCreate: false, createable: false, filterable: true, updateable: true, nameField: true, compoundFieldName: null, calculated: false, autoNumber: false },
      ],
      recordTypeInfos: [],
    };
    const built = await synthesizeRecordValues({} as never, {} as never, "/services/data/v67.0",
      "Widget", "AS probe marker", {}, new Map(), schema);
    if ("failure" in built) throw new Error(`unexpected failure: ${JSON.stringify(built.failure)}`);
    expect("Name" in built.values).toBe(false);
  });
});
