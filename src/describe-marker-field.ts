/**
 * Person-Account-aware ownership-marker selection over live describe fields.
 *
 * Root cause (live evidence, sdostainless): a Person-Account-enabled org
 * describes Account.Name as SELF-compound (`compoundFieldName === "Name"`)
 * with FirstName/LastName members that are invalid on business-record
 * inserts. Marker code that excluded every compound parent dropped Name,
 * and `nameField && !compoundFieldName` finds then landed on LastName,
 * failing fixture creation with "bad field names on insert/update call:
 * LastName". The compound parent of a real compound (BillingAddress) is
 * never string-typed, so a string marker candidate is excludable as a
 * compound parent only when it is NOT self-compound.
 */

export type DescribeMarkerField = {
  name?: unknown;
  nameField?: unknown;
  compoundFieldName?: unknown;
};

/** Self-compound Name: writable and readable; the preferred marker where present. */
export const isSelfCompoundName = (field: DescribeMarkerField | null | undefined): boolean =>
  !!field && typeof field.name === "string" && field.compoundFieldName === field.name;

/**
 * True when another member claims `field` as its compound (a pure compound
 * parent such as BillingAddress, unwritable as a scalar). Self-compound
 * Name is excluded: it is a member of its own compound and writable.
 */
export const isCompoundParent = (
  fields: readonly unknown[], field: DescribeMarkerField | null | undefined,
): boolean => {
  if (!field || typeof field.name !== "string" || isSelfCompoundName(field)) return false;
  return fields.some(other => !!other && typeof other === "object" &&
    (other as DescribeMarkerField).compoundFieldName === field.name);
};

/**
 * Preferred name marker: a real name field, standalone (normal orgs, or
 * Contact/Lead LastName) or self-compound (Person-Account Account.Name).
 * Compound MEMBERS (Person-Account LastName/FirstName) never qualify.
 */
export const isNameMarkerField = (field: DescribeMarkerField | null | undefined): boolean =>
  !!field && field.nameField === true && (!field.compoundFieldName || isSelfCompoundName(field));

/**
 * Person-Contact-mapped fields (`__pc` suffix): valid only on Person
 * Account record types. Fixtures are business/Master, so these columns
 * are never set, nulled, or picked as markers — even explicit nulls 400
 * "bad field names" on business inserts (live evidence: 52 mirrored
 * fields on Person-Account orgs). Platform vocabulary (documented
 * suffix), never org data.
 */
export const isPersonContactField = (field: DescribeMarkerField | null | undefined): boolean =>
  !!field && typeof field.name === "string" && field.name.endsWith("__pc");
