type Result = { status: number; ok: boolean; body: any };
type Values = Record<string, unknown>;
const fail = (message: string): { failure: Result } => ({ failure: { status: 422, ok: false, body: { errorCode: "COMMERCE_OWNED_BUYER_UNVERIFIED", message } } });
/** A plain Account can hold a cart but cannot enter checkout. Enable only the
 * disposable Account and prove the buyer relationship and active state.
 */
export async function provisionOwnedBuyerAccount(input: {
  root: string; accountId: string; marker: string;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (objectName: string, marker: string, values: Values) => Promise<{ values: Values } | { failure: Result }>;
  capture: (objectName: string, id: string) => void;
}): Promise<{ id: string } | { failure: Result }> {
  const schema = await input.request(input.root + "/sobjects/BuyerAccount/describe");
  if (!schema.ok || !Array.isArray(schema.body?.fields)) return fail("BuyerAccount create and read access is required for owned checkout.");
  const active = schema.body.fields.find((field: any) => field.name === "BuyerStatus")?.picklistValues?.find((value: any) => value.active === true && /^active$/i.test(value.value))?.value;
  const type = schema.body.fields.find((field: any) => field.name === "CommerceType")?.picklistValues?.find((value: any) => value.active === true && /^buyer$/i.test(value.value))?.value;
  if (!active || !type) return fail("The live buyer schema exposes no active buyer status and commerce type.");
  const built = await input.build("BuyerAccount", input.marker, { Name: input.marker, BuyerId: input.accountId, IsActive: true, BuyerStatus: active, CommerceType: type });
  if ("failure" in built) return built;
  if (built.values.Name !== input.marker || built.values.BuyerId !== input.accountId) return fail("The owned buyer marker and Account relationship could not be bound.");
  const made = await input.request(input.root + "/sobjects/BuyerAccount", "POST", built.values);
  const id = made.body?.id;
  if (!made.ok || typeof id !== "string" || !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(id)) return { failure: made };
  input.capture("BuyerAccount", id);
  const read = await input.request(input.root + "/sobjects/BuyerAccount/" + id);
  if (!read.ok || read.body?.Name !== input.marker || read.body?.BuyerId !== input.accountId || read.body?.IsActive !== true || read.body?.BuyerStatus !== active) return fail("The disposable Account was not verified as an active buyer.");
  return { id };
}
