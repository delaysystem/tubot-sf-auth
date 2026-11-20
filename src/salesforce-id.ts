/** Salesforce ID comparison shared by owned-context lifecycles.
 *
 * Root cause (R5 route lane, Round-4 sweep evidence): stored integration
 * identities and live `CreatedById`/`OwnerId`/`UserId` readbacks name the
 * same user in different ID formats (15-char case-sensitive vs 18-char
 * suffix), so strict string equality falsely refuses owned fixtures as
 * foreign-owned. The auth token path (`sameSalesforceId` in index.ts)
 * already compares 15-char prefixes; lifecycles must use the same
 * semantics or they disagree with the identity the transport verified.
 *
 * No org IDs, aliases, instance URLs, tenant names, or customer values
 * appear here; both inputs are caller-supplied live values.
 */

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** True when both values are well-formed Salesforce IDs naming the same
 * record (15-char prefix equality; the 18-char suffix is checksum). */
export function sameSalesforceId(actual: unknown, expected: unknown): boolean {
  return (
    typeof actual === "string" &&
    typeof expected === "string" &&
    SF_ID.test(actual) &&
    SF_ID.test(expected) &&
    actual.slice(0, 15) === expected.slice(0, 15)
  );
}
