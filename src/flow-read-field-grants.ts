const FIXTURE_PERMSET_NAME = "ActionSearcher_Context_Fixtures";
type ProvisionRequest = (path: string, method?: string, body?: unknown) => Promise<{ status: number; ok: boolean; body: unknown }>;
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(v);
const rows = (body: unknown): Record<string, any>[] => record(body) && Array.isArray(body.records) ? body.records.filter(record) : [];
/** Only fields explicitly queried by metadata-proven query-only Flows are eligible. */
export function flowReadFields(metadata: unknown): Array<{ objectName: string; fieldName: string }> {
  if (!record(metadata) || !Array.isArray(metadata.recordLookups)) return [];
  const result: Array<{ objectName: string; fieldName: string }> = [];
  for (const lookup of metadata.recordLookups.filter(record)) {
    if (!identifier(lookup.object) || !Array.isArray(lookup.queriedFields)) continue;
    for (const fieldName of lookup.queriedFields) if (identifier(fieldName) && /__c$/.test(fieldName))
      result.push({ objectName: lookup.object, fieldName });
  }
  return result.slice(0, 24);
}
export async function provisionFlowReadFields(root: string, fields: unknown, request: ProvisionRequest): Promise<{ missing: string[]; granted: string[] }> {
  const outcome = { missing: [] as string[], granted: [] as string[] };
  if (!Array.isArray(fields)) return outcome;
  for (const entry of fields.filter(record).slice(0, 24)) {
    if (!identifier(entry.objectName) || !identifier(entry.fieldName) || !/__c$/.test(entry.fieldName)) continue;
    const field = `${entry.objectName}.${entry.fieldName}`;
    const schema = await request(`${root}/sobjects/${entry.objectName}/describe`);
    if (!schema.ok || !record(schema.body) || !Array.isArray(schema.body.fields)) { outcome.missing.push(field); continue; }
    if (schema.body.fields.some((item: unknown) => record(item) && item.name === entry.fieldName)) continue;
    const set = await request(`${root}/query?q=${encodeURIComponent(`SELECT Id FROM PermissionSet WHERE Name='${FIXTURE_PERMSET_NAME}' LIMIT 1`)}`);
    const parentId = rows(set.body)[0]?.Id;
    if (!set.ok || typeof parentId !== "string" || !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(parentId)) { outcome.missing.push(field); continue; }
    const existing = await request(`${root}/query?q=${encodeURIComponent(`SELECT Id,PermissionsRead FROM FieldPermissions WHERE ParentId='${parentId}' AND Field='${field}' LIMIT 1`)}`);
    if (!existing.ok) { outcome.missing.push(field); continue; }
    const permission = rows(existing.body)[0];
    const write = permission?.PermissionsRead === true ? existing : typeof permission?.Id === "string"
      ? await request(`${root}/sobjects/FieldPermissions/${permission.Id}`, "PATCH", { PermissionsRead: true })
      : await request(`${root}/sobjects/FieldPermissions`, "POST", { ParentId: parentId, SobjectType: entry.objectName, Field: field, PermissionsRead: true, PermissionsEdit: false });
    const verified = write.ok ? await request(`${root}/query?q=${encodeURIComponent(`SELECT Id,PermissionsRead FROM FieldPermissions WHERE ParentId='${parentId}' AND Field='${field}' LIMIT 1`)}`) : write;
    if (verified.ok && rows(verified.body)[0]?.PermissionsRead === true) outcome.granted.push(field);
    else outcome.missing.push(field);
  }
  return outcome;
}
