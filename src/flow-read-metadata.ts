const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A record output can come from a query. Only the complete active Flow metadata can prove that. */
export function isQueryOnlyFlowMetadata(metadata: unknown): boolean {
  if (!record(metadata) || metadata.status !== "Active" || metadata.processType !== "AutoLaunchedFlow" ||
      !Array.isArray(metadata.recordLookups) || metadata.recordLookups.length === 0) return false;
  return ["recordCreates", "recordUpdates", "recordDeletes", "actionCalls", "apexPluginCalls", "subflows", "screens", "waits"]
    .every(key => Array.isArray(metadata[key]) && metadata[key].length === 0);
}
