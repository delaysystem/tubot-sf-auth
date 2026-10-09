import { batchGet } from "./commerce-provisioned-context";
type Result = { status: number; ok: boolean; body: any };
/** Learn the input literal from active Flow calls rather than guessing state names. */
export async function discoverFlowActionScalarInput(root: string, actionName: string, inputName: string, request: (path: string, method?: string, body?: any) => Promise<Result>): Promise<string | null> {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(actionName) || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(inputName)) return null;
  const stem = actionName.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ")[0];
  const found = await request(root + "/tooling/query?q=" + encodeURIComponent("SELECT Id FROM Flow WHERE Status='Active' AND MasterLabel LIKE '%" + stem + "%' LIMIT 12"));
  if (!found.ok || !Array.isArray(found.body?.records)) return null;
  const ids = found.body.records.map((row:any)=>row.Id).filter((id:unknown)=>typeof id === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(id)).slice(0,12);
  const flows = await batchGet(request, root, ids.map((id:string)=>'/tooling/sobjects/Flow/'+id));
  for (const flow of flows) {
    const metadata = flow.body?.Metadata;
    if (!flow.ok || !Array.isArray(metadata?.actionCalls)) continue;
    for (const call of metadata.actionCalls.filter((call: any) => call?.actionName === actionName)) {
      const input = call.inputParameters?.find((entry: any) => entry?.name === inputName);
      const reference = input?.value?.elementReference;
      const value = input?.value?.stringValue ?? (typeof reference === "string" ? [...(metadata.variables ?? []), ...(metadata.constants ?? [])].find((entry: any) => entry?.name === reference)?.value?.stringValue : null);
      if (typeof value === "string" && value.length > 0 && value.length <= 30) return value;
    }
  }
  return null;
}
