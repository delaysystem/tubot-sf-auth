type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
type Request = (path: string, method?: string, body?: any) => Promise<Result>;
const id = (v: any): v is string => typeof v === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);

export type ProvisionedStorefront = { storeId: string; networkId: string };
export type BuyerChainIds = { accountId: string; buyerAccountId: string; contactId?: string; memberId: string };
export type BuyerGroupAttempt = { groupId: string; status: number; errorCode?: string };
export type ProvisionedSubstrate = ProvisionedStorefront & {
  groupId: string; groupIds: string[]; pricebookId: string; catalogId: string; categoryId: string | null; policyId: string | null; catalogLinkId: string | null;
  schemas: Record<string, Value>;
};

/** First-column id from a live SOQL query, or null on any failure. Never throws. */
async function firstId(request: Request, root: string, soql: string, field: string): Promise<string | null> {
  try {
    const result = await request(root + '/query?q=' + encodeURIComponent(soql));
    const row = Array.isArray(result.body?.records) ? result.body.records[0] : undefined;
    return result.ok && id(row?.[field]) ? row[field] : null;
  } catch { return null; }
}

/** One composite call for many independent GETs: reuse discovery must cost
 * single subrequests or long lifecycles starve their own cleanup past the
 * invocation subrequest cap. Sub-failures resolve to {ok:false}, never throw. */
export async function batchGet(request: Request, root: string, paths: string[]): Promise<Array<{ ok: boolean; body: any }>> {
  const empty = paths.map(() => ({ ok: false as boolean, body: null as any }));
  try {
    const prefix = root.replace(/^\/services\/data\//, '');
    const result = await request(root + '/composite/batch', 'POST',
      { haltOnError: false, batchRequests: paths.map(path => ({ method: 'GET', url: prefix + path })) });
    if (!result.ok || !Array.isArray(result.body?.results) || result.body.results.length !== paths.length) return empty;
    return result.body.results.map((entry: any) =>
      entry?.statusCode === 200 ? { ok: true, body: entry.result } : { ok: false, body: null });
  } catch { return empty; }
}

/** Object + action describes in one composite call: ten sequential describes
 * cost a fifth of the invocation subrequest budget, starving long lifecycles.
 * Null when any describe subrequest fails; callers validate the bodies. */
export async function batchDescribe(
  request: Request, root: string, objects: string[], actions: string[],
): Promise<{ schemas: Record<string, Value>; descriptors: Record<string, Value> } | null> {
  const specs = [...objects.map(name => ({ kind: 'object' as const, name })),
    ...actions.map(name => ({ kind: 'action' as const, name }))];
  const entries = await batchGet(request, root, specs.map(spec =>
    spec.kind === 'object' ? `/sobjects/${spec.name}/describe` : `/actions/standard/${spec.name}`));
  const schemas: Record<string, Value> = {}, descriptors: Record<string, Value> = {};
  for (let i = 0; i < specs.length; i++) {
    if (!entries[i].ok) return null;
    (specs[i].kind === 'object' ? schemas : descriptors)[specs[i].name] = entries[i].body;
  }
  return { schemas, descriptors };
}

/** Full provisioned substrate in three composite calls: live-linked store,
 * buyer group, pricebook, catalog (+link/category/policy tail) and the reuse
 * object schemas. Null on any gap: the caller keeps its mint path. */
export async function discoverProvisionedSubstrate(request: Request, root: string): Promise<ProvisionedSubstrate | null> {
  const REUSE_OBJECTS = ['BuyerAccount', 'BuyerGroupMember', 'Contact', 'WebStoreCatalog', 'ProductCategoryProduct', 'CommerceEntitlementProduct'];
  const phaseA = await batchGet(request, root, [
    '/query?q=' + encodeURIComponent('SELECT WebStoreId,NetworkId FROM WebStoreNetwork ORDER BY WebStoreId,NetworkId LIMIT 200'),
    '/query?q=' + encodeURIComponent("SELECT Id FROM Network WHERE Status='Live' ORDER BY Id LIMIT 200"),
    ...REUSE_OBJECTS.map(name => `/sobjects/${name}/describe`),
  ]);
  const schemas: Record<string, Value> = {};
  for (let i = 0; i < REUSE_OBJECTS.length; i++) {
    const schema = phaseA[2 + i];
    if (!schema.ok || !schema.body?.queryable || !schema.body?.deletable || !schema.body?.createable) return null;
    schemas[REUSE_OBJECTS[i]] = schema.body;
  }
  if (!phaseA[0].ok || !phaseA[1].ok || !Array.isArray(phaseA[0].body?.records) || !Array.isArray(phaseA[1].body?.records)) return null;
  const liveIds = new Set(phaseA[1].body.records.filter((row: Value) => id(row?.Id)).map((row: Value) => row.Id));
  const hit = phaseA[0].body.records.find((row: Value) => id(row?.WebStoreId) && id(row?.NetworkId) && liveIds.has(row.NetworkId));
  if (!hit) return null;
  const storeId = hit.WebStoreId as string;
  const phaseB = await batchGet(request, root, [
    '/query?q=' + encodeURIComponent(`SELECT BuyerGroupId FROM WebStoreBuyerGroup WHERE WebStoreId='${storeId}' ORDER BY BuyerGroupId LIMIT 10`),
    '/query?q=' + encodeURIComponent(`SELECT Pricebook2Id FROM WebStorePricebook WHERE WebStoreId='${storeId}' AND IsActive=true LIMIT 1`),
    '/query?q=' + encodeURIComponent('SELECT Id FROM ProductCatalog LIMIT 1'),
  ]);
  const groupRows: Value[] = phaseB[0].ok && Array.isArray(phaseB[0].body?.records) ? phaseB[0].body.records.filter((row: Value) => id(row?.BuyerGroupId)) : [];
  const groupIds: string[] = [...new Set<string>(groupRows.map((row) => row.BuyerGroupId as string))].slice(0, 10);
  const groupId = groupIds[0] ?? null;
  const pricebookId = phaseB[1].ok && id(phaseB[1].body?.records?.[0]?.Pricebook2Id) ? phaseB[1].body.records[0].Pricebook2Id : null;
  const catalogId = phaseB[2].ok && id(phaseB[2].body?.records?.[0]?.Id) ? phaseB[2].body.records[0].Id : null;
  if (!groupId || !pricebookId || !catalogId) return null;
  const phaseC = await batchGet(request, root, [
    '/query?q=' + encodeURIComponent(`SELECT Id FROM WebStoreCatalog WHERE SalesStoreId='${storeId}' ORDER BY Id LIMIT 1`),
    '/query?q=' + encodeURIComponent(`SELECT Id FROM ProductCategory WHERE CatalogId='${catalogId}' ORDER BY Id LIMIT 1`),
    '/query?q=' + encodeURIComponent(`SELECT PolicyId FROM CommerceEntitlementBuyerGroup WHERE BuyerGroupId='${groupId}' ORDER BY PolicyId LIMIT 1`),
  ]);
  const pick = (entry: { ok: boolean; body: any }, field: string) =>
    entry.ok && id(entry.body?.records?.[0]?.[field]) ? entry.body.records[0][field] as string : null;
  return {
    storeId, networkId: hit.NetworkId as string, groupId, groupIds, pricebookId, catalogId,
    catalogLinkId: pick(phaseC[0], 'Id'), categoryId: pick(phaseC[1], 'Id'), policyId: pick(phaseC[2], 'PolicyId'), schemas,
  };
}

/** A UI-provisioned store<->site pair is the only hostname substrate Salesforce
 * accepts (one store per site): discover a live-linked store for reuse. The
 * link queries are ORDER BY-pinned so the first live-linked pick is
 * deterministic. Transport failures return null (the caller keeps its mint
 * path); only the request calls are guarded, so row-shaping bugs propagate
 * loudly instead of masquerading as "no storefront". */
export async function discoverProvisionedStorefront(request: Request, root: string): Promise<ProvisionedStorefront | null> {
  let links: Result;
  let live: Result;
  try {
    [links, live] = await Promise.all([
      request(root + '/query?q=' + encodeURIComponent('SELECT WebStoreId,NetworkId FROM WebStoreNetwork ORDER BY WebStoreId,NetworkId LIMIT 200')),
      request(root + '/query?q=' + encodeURIComponent("SELECT Id FROM Network WHERE Status='Live' ORDER BY Id LIMIT 200")),
    ]);
  } catch { return null; }
  if (!links.ok || !live.ok || !Array.isArray(links.body?.records) || !Array.isArray(live.body?.records)) return null;
  const liveIds = new Set(live.body.records.filter((row: Value) => id(row?.Id)).map((row: Value) => row.Id));
  const hit = links.body.records.find((row: Value) => id(row?.WebStoreId) && id(row?.NetworkId) && liveIds.has(row.NetworkId));
  return hit ? { storeId: hit.WebStoreId, networkId: hit.NetworkId } : null;
}

export const discoverStoreBuyerGroup = (request: Request, root: string, storeId: string) =>
  firstId(request, root, `SELECT BuyerGroupId FROM WebStoreBuyerGroup WHERE WebStoreId='${storeId}' ORDER BY BuyerGroupId LIMIT 1`, 'BuyerGroupId');

/** Every buyer group linked to a provisioned store, id-validated and capped.
 * BuyerGroup exposes no account-based discriminator (live-verified: only
 * Name/Description/Role), so membership itself is the ground truth and the
 * chain ladders candidates until one accepts the owned buyer. */
export async function discoverStoreBuyerGroups(request: Request, root: string, storeId: string): Promise<string[]> {
  let result: Result;
  try {
    result = await request(root + '/query?q=' + encodeURIComponent(`SELECT BuyerGroupId FROM WebStoreBuyerGroup WHERE WebStoreId='${storeId}' ORDER BY BuyerGroupId LIMIT 10`));
  } catch { return []; }
  if (!result.ok || !Array.isArray(result.body?.records)) return [];
  const rows: Value[] = result.body.records.filter((row: Value) => id(row?.BuyerGroupId));
  return [...new Set<string>(rows.map((row) => row.BuyerGroupId as string))].slice(0, 10);
}

/** B2B buyer chain on a provisioned store: Account -> active BuyerAccount ->
 * optional Contact -> BuyerGroupMember of the store's group. Returns the
 * minted ids (all owned) or a failure; partial writes are reported for cleanup. */
export async function provisionBuyerChain(input: {
  root: string; marker: string; groupIds: string[];
  request: Request;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }>;
  capture: (objectName: string, value: string) => void;
}): Promise<{ ids: BuyerChainIds; memberAttempts: BuyerGroupAttempt[] } | { failure: Result; partial: Array<{ objectName: string; id: string }>; memberAttempts: BuyerGroupAttempt[] }> {
  const { root, request, marker } = input, partial: Array<{ objectName: string; id: string }> = [];
  const memberAttempts: BuyerGroupAttempt[] = [];
  const candidates: string[] = [...new Set<string>((input.groupIds ?? []).filter((v: string) => id(v)))].slice(0, 10);
  const keep = (objectName: string, value: string) => { partial.push({ objectName, id: value }); input.capture(objectName, value); };
  if (!candidates.length) return { failure: { status: 422, ok: false, body: { errorCode: 'CART_BUYER_GROUP_UNAVAILABLE', message: 'No candidate buyer group is linked to the provisioned store.' } }, partial, memberAttempts };
  const buyer = await input.build('Account', marker, { Name: marker });
  if ('failure' in buyer) return { failure: buyer.failure, partial, memberAttempts };
  const createdBuyer = await request(root + '/sobjects/Account', 'POST', buyer.values);
  if (!createdBuyer.ok || !id(createdBuyer.body?.id)) return { failure: createdBuyer, partial, memberAttempts };
  keep('Account', createdBuyer.body.id);
  const accountId = createdBuyer.body.id;
  const buyerRead = await request(root + '/sobjects/Account/' + accountId);
  if (!buyerRead.ok || buyerRead.body?.Name !== marker)
    return { failure: { status: 422, ok: false, body: { errorCode: 'CART_BUYER_UNVERIFIED', message: 'Actual owned buyer readback failed.' } }, partial, memberAttempts };
  const enabled = await input.build('BuyerAccount', marker, { BuyerId: accountId, Name: marker, CommerceType: 'Buyer', BuyerStatus: 'Active', IsActive: true });
  if ('failure' in enabled) return { failure: enabled.failure, partial, memberAttempts };
  const createdEnabled = await request(root + '/sobjects/BuyerAccount', 'POST', enabled.values);
  if (!createdEnabled.ok || !id(createdEnabled.body?.id)) return { failure: createdEnabled, partial, memberAttempts };
  keep('BuyerAccount', createdEnabled.body.id);
  const contact = await input.build('Contact', marker, { AccountId: accountId, LastName: marker });
  let contactId: string | undefined;
  if (!('failure' in contact)) {
    const createdContact = await request(root + '/sobjects/Contact', 'POST', contact.values);
    if (createdContact.ok && id(createdContact.body?.id)) { contactId = createdContact.body.id; keep('Contact', createdContact.body.id); }
  }
  // Membership is the only account-based ground truth: ladder the linked
  // groups until one accepts the owned buyer. Client refusals (HTTP 400,
  // e.g. "select an account-based buyer group") fall through; anything
  // else (transport/auth/systemic) stops honest with per-group evidence.
  let memberId: string | undefined, lastFailure: Result | undefined;
  for (const candidate of candidates) {
    const member = await input.build('BuyerGroupMember', marker, { BuyerGroupId: candidate, BuyerId: accountId });
    if ('failure' in member) return { failure: member.failure, partial, memberAttempts };
    const createdMember = await request(root + '/sobjects/BuyerGroupMember', 'POST', member.values);
    const bodies = Array.isArray(createdMember.body) ? createdMember.body : [createdMember.body];
    const errorCode = bodies.map((entry: Value) => entry?.errorCode ?? entry?.errors?.[0]?.errorCode)
      .find((code: unknown): code is string => typeof code === 'string' && code.length > 0)?.slice(0, 64);
    memberAttempts.push({ groupId: candidate, status: createdMember.status, ...(errorCode ? { errorCode } : {}) });
    if (createdMember.ok && id(createdMember.body?.id)) { memberId = createdMember.body.id; break; }
    lastFailure = createdMember;
    if (createdMember.status !== 400) break;
  }
  if (memberId === undefined) {
    return { failure: lastFailure ?? { status: 422, ok: false, body: { errorCode: 'CART_BUYER_GROUP_UNAVAILABLE', message: 'No linked buyer group accepted the owned buyer.' } }, partial, memberAttempts };
  }
  keep('BuyerGroupMember', memberId);
  return { ids: { accountId, buyerAccountId: createdEnabled.body.id, ...(contactId ? { contactId } : {}), memberId }, memberAttempts };
}
