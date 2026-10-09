type OwnedRecord = { objectName: string; id: string };
type Scope = { objectName: string; equals: Record<string, unknown>; ownedParents?: Array<{ field: string; objectName: string }> };

/** Keep child proof available when setup faults before it returns its scopes.
 * The cleanup engine still requires a fresh read and proven parent marker.
 */
export function ownedOrderChildScopes(records: OwnedRecord[]): Scope[] {
  return records.filter(row => row.objectName === "Order" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(row.id))
    .flatMap(row => ["OrderItem", "OrderDeliveryGroup"].map(objectName => ({
      objectName, equals: { OrderId: row.id }, ownedParents: [{ field: "OrderId", objectName: "Order" }],
    })));
}

type Result = { status: number; ok: boolean; body: any };
/** Summary deletion must precede deactivation. Re-read the exact owned marker
 * before changing status; unknown orders receive no write authority.
 */
export async function restoreOwnedOrderDrafts(root: string, records: OwnedRecord[], scopes: Scope[], request: (path: string, method?: string, body?: any) => Promise<Result>): Promise<string | undefined> {
  for (const row of records.filter(row => row.objectName === "Order" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(row.id))) {
    const path = root + "/sobjects/Order/" + row.id;
    const read = await request(path);
    if (!read.ok || read.body?.Status !== "Activated") continue;
    const proven = scopes.some(scope => scope.objectName === "Order" && !scope.ownedParents?.length && Object.keys(scope.equals).length > 0 &&
      Object.entries(scope.equals).every(([field, value]) => read.body[field] === value));
    if (!proven) continue;
    const changed = await request(path, "PATCH", { Status: "Draft" });
    const verified = changed.ok ? await request(path) : changed;
    if (!verified.ok || verified.body?.Status !== "Draft") return "The marker-verified owned Order could not be restored to Draft before cleanup (HTTP " + changed.status + ").";
  }
  return undefined;
}
