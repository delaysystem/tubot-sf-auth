import { describe, expect, test } from "bun:test";
import { isCompoundParent, isNameMarkerField, isSelfCompoundName } from "./describe-marker-field";

// Live sdostainless Account describe shape (Person Accounts enabled):
// Name is self-compound; LastName/FirstName are nameField members that the
// platform rejects on business-record inserts ("bad field names").
const personAccountFields = [
  { name: "Name", nameField: true, compoundFieldName: "Name", type: "string", createable: true, filterable: true, length: 255 },
  { name: "LastName", nameField: true, compoundFieldName: "Name", type: "string", createable: true, filterable: true, length: 80 },
  { name: "FirstName", nameField: true, compoundFieldName: "Name", type: "string", createable: true, filterable: true, length: 40 },
  { name: "BillingCity", nameField: false, compoundFieldName: "BillingAddress", type: "string", createable: true, filterable: true, length: 40 },
  { name: "BillingAddress", nameField: false, compoundFieldName: null, type: "address", createable: false, filterable: false },
];
const normalAccountFields = [
  { name: "Name", nameField: true, compoundFieldName: null, type: "string", createable: true, filterable: true, length: 255 },
  { name: "BillingCity", nameField: false, compoundFieldName: "BillingAddress", type: "string", createable: true, filterable: true, length: 40 },
];
const contactFields = [
  { name: "LastName", nameField: true, compoundFieldName: null, type: "string", createable: true, filterable: true, length: 80 },
  { name: "FirstName", nameField: false, compoundFieldName: null, type: "string", createable: true, filterable: true, length: 40 },
];

describe("describe-marker-field", () => {
  test("self-compound Name is detected", () => {
    expect(isSelfCompoundName(personAccountFields[0])).toBe(true);
    expect(isSelfCompoundName(normalAccountFields[0])).toBe(false);
    expect(isSelfCompoundName(personAccountFields[1])).toBe(false);
    expect(isSelfCompoundName(null)).toBe(false);
    expect(isSelfCompoundName(undefined)).toBe(false);
  });

  test("self-compound Name is not a compound parent; real parents are", () => {
    expect(isCompoundParent(personAccountFields, personAccountFields[0])).toBe(false);
    expect(isCompoundParent(normalAccountFields, normalAccountFields[0])).toBe(false);
    expect(isCompoundParent(personAccountFields, personAccountFields[4])).toBe(true);
    expect(isCompoundParent(personAccountFields, personAccountFields[1])).toBe(false);
  });

  test("name marker accepts standalone and self-compound names, never members", () => {
    expect(isNameMarkerField(normalAccountFields[0])).toBe(true);
    expect(isNameMarkerField(personAccountFields[0])).toBe(true);
    expect(isNameMarkerField(contactFields[0])).toBe(true);
    expect(isNameMarkerField(personAccountFields[1])).toBe(false);
    expect(isNameMarkerField(personAccountFields[2])).toBe(false);
    expect(isNameMarkerField(personAccountFields[3])).toBe(false);
    expect(isNameMarkerField(null)).toBe(false);
  });

  test("Person-Account marker chain picks Name, never LastName", () => {
    // Mirrors the reference-quick-action parent selection after the fix:
    // string candidates minus compound parents, name marker first.
    const candidates = personAccountFields.filter(f =>
      f.type === "string" && f.createable === true && f.filterable === true &&
      (f.length as number) >= 24 && !isCompoundParent(personAccountFields, f));
    expect(candidates.map(f => f.name)).toContain("Name");
    const marker = candidates.find(isNameMarkerField) ??
      candidates.find(f => (f as { nillable?: boolean }).nillable === false) ?? candidates[0];
    expect(marker?.name).toBe("Name");
  });

  test("normal-org and Contact chains are unchanged", () => {
    const account = normalAccountFields.filter(f =>
      f.type === "string" && !isCompoundParent(normalAccountFields, f));
    expect(account.find(isNameMarkerField)?.name).toBe("Name");
    const contact = contactFields.filter(f =>
      f.type === "string" && !isCompoundParent(contactFields, f));
    expect(contact.find(isNameMarkerField)?.name).toBe("LastName");
  });
});
