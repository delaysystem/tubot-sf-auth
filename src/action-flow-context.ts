/** Resolve Flow lookup inputs from live metadata, never from tenant-specific names. */
export type FlowLookupBinding = { objectName: string; fieldName: string; inputName: string };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(v);
export function flowLookupBindings(metadata: unknown): FlowLookupBinding[] {
  if (!record(metadata) || !Array.isArray(metadata.variables) || !Array.isArray(metadata.recordLookups)) return [];
  const inputs = new Set(metadata.variables.filter(record).filter(v => v.isInput === true && identifier(v.name)).map(v => v.name));
  const result: FlowLookupBinding[] = [];
  for (const lookup of metadata.recordLookups.filter(record)) {
    if (!identifier(lookup.object) || !Array.isArray(lookup.filters)) continue;
    for (const filter of lookup.filters.filter(record)) {
      const name = record(filter.value) ? filter.value.elementReference : null;
      if (filter.operator === "EqualTo" && identifier(filter.field) && identifier(name) && inputs.has(name)) {
        result.push({ objectName: lookup.object, fieldName: filter.field, inputName: name });
      }
    }
  }
  return result;
}
export function flowFixtureValue(field: Record<string, unknown>, nonce: string): unknown {
  if (field.createable !== true || field.calculated === true || field.autoNumber === true) return undefined;
  switch (String(field.type).toLowerCase()) {
    case "email": return `action-probe-${nonce}@example.invalid`;
    case "phone": return "+15550100123";
    case "url": return "https://example.invalid/action-searcher";
    case "string": case "textarea": case "encryptedstring": return `ActionProbe${nonce}`.slice(0, typeof field.length === "number" && field.length > 0 ? field.length : 80);
    case "boolean": return false;
    case "int": case "double": case "currency": case "percent": return 1;
    case "date": return new Date().toISOString().slice(0, 10);
    case "datetime": return new Date().toISOString();
    case "time": return `${new Date().toISOString().slice(11, 23)}Z`;
    case "base64": return "QWN0aW9uUHJvYmU=";
    case "picklist": {
      const choice = Array.isArray(field.picklistValues) ? field.picklistValues.filter(record).find(v => v.active === true) : null;
      return choice?.value;
    }
    case "combobox": {
      // Combobox accepts free text with picklist suggestions: prefer a live
      // active choice, otherwise fall back to the length-bounded probe text.
      const choice = Array.isArray(field.picklistValues) ? field.picklistValues.filter(record).find(v => v.active === true) : null;
      if (typeof choice?.value === "string") return choice.value;
      return `ActionProbe${nonce}`.slice(0, typeof field.length === "number" && field.length > 0 ? field.length : 80);
    }
    default: return undefined;
  }
}
/** Input names whose lookup binding filters on the object id field (the created fixture id binds them, never a synthesized value). */
export function lookupIdBindings(bindings: FlowLookupBinding[], objectName: string): string[] {
  if (!Array.isArray(bindings) || !identifier(objectName)) return [];
  const names: string[] = [];
  for (const binding of bindings) {
    if (!record(binding) || binding.objectName !== objectName) continue;
    if (typeof binding.fieldName !== "string" || binding.fieldName.toLowerCase() !== "id") continue;
    if (!identifier(binding.inputName)) continue;
    names.push(binding.inputName);
  }
  return names;
}
/**
 * Comma-structured retry value for opaque flow faults over fixture-bound
 * record inputs: vendors that split a scalar and index past its parts
 * fault on unstructured text, so a part-less string retries as a four-part
 * comma join of itself (street/city/state/zip shapes and generic indexed
 * splits alike). Non-strings and already-structured values pass through.
 */
export function commaStructuredProbeValue(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || value.includes(",")) return value;
  return `${value},${value},${value},${value}`;
}
