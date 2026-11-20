type Result = { status: number; ok: boolean; body: any };
type Request = (path: string, method?: string, body?: unknown) => Promise<Result>;
const identity = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
/** Called only for a summary already proven owned by the commerce lifecycle.
 * Allocation automation can create children between discovery and deletion.
 */
export async function deleteOwnedOrderSummary(root: string, summaryId: string, request: Request): Promise<Result> {
  if (!identity(summaryId)) return { status: 422, ok: false, body: { errorCode: "OWNED_SUMMARY_ID_INVALID" } };
  const path = root + "/sobjects/OrderSummary/" + summaryId;
  let outcome: Result = { status: 422, ok: false, body: { errorCode: "OWNED_SUMMARY_CLEANUP_UNVERIFIED" } };
  for (let attempt = 0; attempt < 4; attempt++) {
    const parent = await request(path);
    if (parent.status === 404) return { status: 204, ok: true, body: null };
    if (!parent.ok) return parent;
    const children = await request(root + "/query?q=" + encodeURIComponent("SELECT Id,OrderSummaryId FROM FulfillmentOrder WHERE OrderSummaryId='" + summaryId + "' LIMIT 26"));
    if (!children.ok || !Array.isArray(children.body?.records) || children.body.records.length > 25) return { status: 422, ok: false, body: { errorCode: "OWNED_SUMMARY_CHILD_DISCOVERY_UNVERIFIED" } };
    for (const child of children.body.records) {
      if (!identity(child.Id) || child.OrderSummaryId !== summaryId) return { status: 422, ok: false, body: { errorCode: "OWNED_SUMMARY_CHILD_SCOPE_UNVERIFIED" } };
      const childPath = root + "/sobjects/FulfillmentOrder/" + child.Id;
      const gone = await request(childPath, "DELETE");
      const absent = await request(childPath);
      if (absent.status !== 404) return gone.ok ? { status: 422, ok: false, body: { errorCode: "OWNED_SUMMARY_CHILD_CLEANUP_UNVERIFIED" } } : gone;
    }
    outcome = await request(path, "DELETE");
    const absent = await request(path);
    if (absent.status === 404) return { status: 204, ok: true, body: null };
    if (!outcome.ok && ![400,409].includes(outcome.status)) return outcome;
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 500));
  }
  return outcome.ok ? { status: 422, ok: false, body: { errorCode: "OWNED_SUMMARY_ABSENCE_UNVERIFIED" } } : outcome;
}
