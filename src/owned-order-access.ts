type Result = { status: number; ok: boolean; body: any };
type Request = (path: string, method?: string, body?: unknown) => Promise<Result>;
const rows = (r: Result): any[] => r.ok && Array.isArray(r.body?.records) ? r.body.records : [];
const identity = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);

/** The owned summary chain must be able to restore Draft before deleting it. */
export async function provisionOwnedOrderAccess(root: string, request: Request): Promise<string[]> {
  const missing: string[] = [];
  const set = await request(root + "/query?q=" + encodeURIComponent("SELECT Id,PermissionsEditActivatedOrders FROM PermissionSet WHERE Name='ActionSearcher_Context_Fixtures' LIMIT 1"));
  const permission = rows(set)[0];
  if (!identity(permission?.Id)) return ["ActionSearcher_Context_Fixtures permission set"];
  if (permission.PermissionsEditActivatedOrders !== true) {
    const written = await request(root + "/sobjects/PermissionSet/" + permission.Id, "PATCH", { PermissionsActivateOrder: true, PermissionsEditActivatedOrders: true });
    const verified = written.ok ? await request(root + "/query?q=" + encodeURIComponent("SELECT Id,PermissionsEditActivatedOrders FROM PermissionSet WHERE Id='" + permission.Id + "'")) : written;
    if (rows(verified)[0]?.PermissionsEditActivatedOrders !== true) missing.push("PermissionsEditActivatedOrders");
  }
  for (const [objectName, fieldName] of [["Order", "Status"], ["OrderItem", "OrderDeliveryGroupId"]]) {
    const schema = await request(root + "/sobjects/" + objectName + "/describe");
    if (!schema.ok || !Array.isArray(schema.body?.fields)) { missing.push(objectName + " describe access"); continue; }
    if (schema.body.fields.some((f: any) => f.name === fieldName && f.updateable === true)) continue;
    const field = objectName + "." + fieldName;
    const found = await request(root + "/query?q=" + encodeURIComponent("SELECT Id,PermissionsRead,PermissionsEdit FROM FieldPermissions WHERE ParentId='" + permission.Id + "' AND Field='" + field + "' LIMIT 1"));
    if (!found.ok) { missing.push(field + " edit access"); continue; }
    const current = rows(found)[0];
    const written = identity(current?.Id)
      ? await request(root + "/sobjects/FieldPermissions/" + current.Id, "PATCH", { PermissionsRead: true, PermissionsEdit: true })
      : await request(root + "/sobjects/FieldPermissions", "POST", { ParentId: permission.Id, SobjectType: objectName, Field: field, PermissionsRead: true, PermissionsEdit: true });
    const verified = written.ok ? await request(root + "/query?q=" + encodeURIComponent("SELECT Id,PermissionsRead,PermissionsEdit FROM FieldPermissions WHERE ParentId='" + permission.Id + "' AND Field='" + field + "' LIMIT 1")) : written;
    if (rows(verified)[0]?.PermissionsEdit !== true) missing.push(field + " edit access");
  }
  for (const objectName of ["OrderSummary", "FulfillmentOrder"]) {
    const tooling = root + "/tooling";
    const schema = await request(root + "/sobjects/" + objectName + "/describe");
    if (schema.ok && schema.body?.deletable === true) continue;
    const found = await request(tooling + "/query?q=" + encodeURIComponent("SELECT Id,PermissionsRead,PermissionsDelete FROM ObjectPermissions WHERE ParentId='" + permission.Id + "' AND SobjectType='" + objectName + "' LIMIT 1"));
    if (!found.ok) { missing.push(objectName + " delete access"); continue; }
    const current = rows(found)[0];
    const written = identity(current?.Id)
      ? await request(tooling + "/sobjects/ObjectPermissions/" + current.Id, "PATCH", { PermissionsRead: true, PermissionsEdit: true, PermissionsDelete: true })
      : await request(tooling + "/sobjects/ObjectPermissions", "POST", { ParentId: permission.Id, SobjectType: objectName, PermissionsRead: true, PermissionsEdit: true, PermissionsDelete: true });
    const verified = written.ok ? await request(tooling + "/query?q=" + encodeURIComponent("SELECT Id,PermissionsDelete FROM ObjectPermissions WHERE ParentId='" + permission.Id + "' AND SobjectType='" + objectName + "' LIMIT 1")) : written;
    if (rows(verified)[0]?.PermissionsDelete !== true) missing.push(objectName + " delete access (HTTP " + written.status + ": " + String((Array.isArray(written.body) ? written.body[0] : written.body)?.message ?? "grant readback failed").slice(0, 240) + ")");
  }
  return missing;
}
