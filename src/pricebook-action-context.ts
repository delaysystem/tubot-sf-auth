import { cleanupOwnedContext, type OwnedRecord } from './owned-context-cleanup';
type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const record = (v: any): v is Value => v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v: any): v is string => typeof v === "string" && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
export async function invokePricebookContext(input: {
  root: string; route: string; target: string; verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
}): Promise<{ status: number; body: any; contextSchema?: Value; cleanupError?: string }> {
  const { root, request, target } = input;
  const fail = (code: string, message: string) => ({ status: 422, body: { errorCode: code, message } });
  const descriptor = await request(input.route);
  if (!descriptor.ok) return descriptor;
  if (!Array.isArray(descriptor.body?.inputs) || !["parentEntityId", "pricebook2Id"].every(name => descriptor.body.inputs.some((v: Value) => v.name === name)))
    return fail("PRICEBOOK_ACTION_SCHEMA_MISMATCH", "The live action does not declare its parent and price-book inputs.");
  const schema = await request(`${root}/sobjects/${target}/describe`);
  if (!schema.ok) return schema;
  const fields = Array.isArray(schema.body?.fields) ? schema.body.fields.filter(record) : [];
  const relation = fields.find((f: Value) => f.name === "Pricebook2Id" && f.type === "reference" && f.referenceTo?.includes("Pricebook2"));
  if (!relation || !relation.createable || !relation.updateable || !schema.body.createable || !schema.body.queryable || !schema.body.deletable)
    return { status: 403, body: { errorCode: "PRICEBOOK_FIXTURE_PERMISSIONS_REQUIRED", message: "The live parent needs create/read/delete access and writable Pricebook2Id context." } };
  const markerField = fields.find((f: Value) => f.nameField && f.createable && f.filterable && f.type === "string" && f.length >= 48);
  if (!markerField) return fail("PRICEBOOK_MARKER_UNAVAILABLE", "The live parent has no queryable ownership name.");
  const catalog = await request(`${root}/query?q=${encodeURIComponent("SELECT Id FROM Pricebook2 LIMIT 1")}`);
  const book = catalog.ok && Array.isArray(catalog.body?.records) ? catalog.body.records[0]?.Id : undefined;
  if (!id(book)) return { ...fail("PRICEBOOK_CONTEXT_UNAVAILABLE", "A live readable price book is required to prepare the disposable parent."), ...(catalog.ok ? {} : { status: catalog.status, body: catalog.body }) };
  const marker = `AS probe ${crypto.randomUUID()}`;
  const built = await input.build(target, marker, { [markerField.name]: marker, Pricebook2Id: book });
  if ("failure" in built) return built.failure;
  let ownedId: string | undefined, verified = false, cleanupError: string | undefined;
  const candidates:OwnedRecord[]=[];
  let outcome: { status: number; body: any } = fail("PRICEBOOK_CONTEXT_UNVERIFIED", "The owned price-book parent failed verification.");
  try {
    outcome = await (async () => {
      const created = await request(`${root}/sobjects/${target}`, "POST", built.values);
      if (!created.ok || !id(created.body?.id)) return created;
      ownedId = created.body.id;
      candidates.push({objectName:target,id:ownedId!});
      const before = await request(`${root}/sobjects/${target}/${ownedId}`);
      if (!before.ok || before.body?.[markerField.name] !== marker || before.body?.Pricebook2Id !== book) return fail("PRICEBOOK_CONTEXT_UNVERIFIED", "The actual owned parent does not have the selected price book.");
      if (input.verificationWindowMs) await new Promise(resolve => setTimeout(resolve, input.verificationWindowMs));
      const invoked = await request(input.route, "POST", { inputs: [{ parentEntityId: ownedId, pricebook2Id: "" }] });
      const after = await request(`${root}/sobjects/${target}/${ownedId}`);
      verified = after.ok && after.body?.[markerField.name] === marker && after.body?.Pricebook2Id === null;
      if (verified && input.verificationWindowMs) await new Promise(resolve => setTimeout(resolve, input.verificationWindowMs));
      const accepted = invoked.ok && Array.isArray(invoked.body) && invoked.body.length && invoked.body.every((v: Value) => v.isSuccess === true && (!v.errors?.length));
      return accepted && !verified ? { ...fail("PRICEBOOK_MUTATION_UNVERIFIED", "Salesforce reported success without removing the actual owned parent's price book."), body: { errorCode: "PRICEBOOK_MUTATION_UNVERIFIED", message: "The owned parent price-book removal was not verified.", upstreamOutcome: invoked.body } } : invoked;
    })();
  } finally {
    try {
      const found=await request(root+'/query?q='+encodeURIComponent(`SELECT Id FROM ${target} WHERE ${markerField.name}='${marker}' LIMIT 2`));
      if(!found.ok||!Array.isArray(found.body?.records)||found.body.records.length>1||found.body.records.some((row:Value)=>!id(row.Id)))cleanupError='Owned price-book parent recovery could not be verified.';
      else for(const row of found.body.records)candidates.push({objectName:target,id:row.Id});
    }catch{cleanupError='Owned price-book parent recovery could not be verified.';}
    const cleaned=await cleanupOwnedContext({root,request,records:candidates,scopes:[{objectName:target,equals:{[markerField.name]:marker}}],order:[target]});
    cleanupError ??= cleaned.cleanupError;
    candidates.splice(0,candidates.length,...cleaned.ownedRecords);
  }
  return { ...outcome, ...(cleanupError ? { cleanupError } : {}), contextSchema: { source: "salesforce_live_record_action", targetObject: target,
    fields, markerField: markerField.name, mutationKind: "update", changedFields: ["Pricebook2Id"], initialChanges: { Pricebook2Id: book }, expectedChanges: { Pricebook2Id: null }, verified,
    verificationRecordIds: verified && ownedId ? [ownedId] : [], ownedRecords:candidates, automaticSteps: ["Discover a live writable price-book parent", "Query an actual readable price book", "Create and read back an owned parent assigned to that book", "Invoke choosePricebook to remove the assignment", "Verify the actual null price-book field", "Delete the owned parent and verify absence"] } };
}
