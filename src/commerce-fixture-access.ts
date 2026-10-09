type Result = { status: number; ok: boolean; body: any };
/** Commerce grants these protected object families through integrator system
 * permissions rather than individual ObjectPermissions rows.
 */
export async function provisionCommerceFixtureAccess(root: string, request: (path: string, method?: string, body?: unknown) => Promise<Result>): Promise<string[]> {
  const fields = ["PermissionsB2BCommerceIntegrator", "PermissionsCommerceEntitlementIntegrator"];
  const query = root + "/query?q=" + encodeURIComponent("SELECT Id," + fields.join(",") + " FROM PermissionSet WHERE Name='ActionSearcher_Context_Fixtures' LIMIT 1");
  const found = await request(query);
  const row = found.ok && Array.isArray(found.body?.records) ? found.body.records[0] : null;
  if (typeof row?.Id !== "string" || !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(row.Id)) return fields;
  const missing = fields.filter(field => row[field] !== true);
  if (!missing.length) return [];
  const changed = await request(root + "/sobjects/PermissionSet/" + row.Id, "PATCH", Object.fromEntries(missing.map(field => [field, true])));
  if (!changed.ok) return missing;
  const verified = await request(query);
  const actual = verified.ok && Array.isArray(verified.body?.records) ? verified.body.records[0] : null;
  return fields.filter(field => actual?.[field] !== true);
}
