/** Derive creation assignments from live Flow metadata, including collection assembly. */
export type FlowCreationField = { field: string; inputName?: string; inputField?: string; collection?: boolean; literal?: unknown };
export type FlowCreationRecipe = { objectName: string; fields: FlowCreationField[] };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(v);
export function flowCreationRecipes(metadata: unknown): FlowCreationRecipe[] {
  if (!record(metadata) || !Array.isArray(metadata.variables) || !Array.isArray(metadata.recordCreates) ||
    ["recordUpdates", "recordDeletes", "actionCalls", "subflows", "apexPluginCalls"].some(key => Array.isArray(metadata[key]) && metadata[key].length)) return [];
  const variables = metadata.variables.filter(record);
  const inputs = variables.filter(item => item.isInput === true && identifier(item.name));
  const loops = Array.isArray(metadata.loops) ? metadata.loops.filter(record) : [];
  const items = Array.isArray(metadata.assignments) ? metadata.assignments.filter(record)
    .flatMap(item => Array.isArray(item.assignmentItems) ? item.assignmentItems.filter(record) : []) : [];
  const source = (field: unknown, value: unknown): FlowCreationField | undefined => {
    if (!identifier(field) || !record(value)) return;
    if (typeof value.elementReference === "string") {
      const [name, inputField, extra] = value.elementReference.split(".");
      if (extra || inputField && !identifier(inputField)) return;
      const variable = inputs.find(item => item.name === name);
      if (variable) return { field, inputName: name, ...(inputField ? { inputField } : {}), ...(variable.isCollection === true ? { collection: true } : {}) };
      const loop = loops.find(item => item.name === name && inputs.some(input => input.name === item.collectionReference));
      if (loop && inputField && typeof loop.collectionReference === "string") return { field, inputName: loop.collectionReference, inputField, collection: true };
      return;
    }
    for (const key of ["stringValue", "numberValue", "booleanValue", "dateValue", "dateTimeValue"]) {
      if (value[key] !== undefined && value[key] !== null) return { field, literal: value[key] };
    }
  };
  const result: FlowCreationRecipe[] = [];
  for (const creation of metadata.recordCreates.filter(record)) {
    if (creation.doesUpsert === true) return [];
    let objectName = creation.object;
    let assignments = Array.isArray(creation.inputAssignments) ? creation.inputAssignments.filter(record).map(item => ({ field: item.field, value: item.value })) : [];
    if (!objectName && typeof creation.inputReference === "string") {
      const variable = variables.find(item => item.name === creation.inputReference);
      objectName = variable?.objectType;
      let recordName = creation.inputReference;
      if (variable?.isCollection === true) {
        const additions = items.filter(item => item.assignToReference === recordName && item.operator === "Add" && record(item.value));
        if (additions.length !== 1 || !record(additions[0].value) || !identifier(additions[0].value.elementReference)) return [];
        recordName = additions[0].value.elementReference;
      }
      assignments = items.filter(item => item.operator === "Assign" && typeof item.assignToReference === "string" && item.assignToReference.startsWith(`${recordName}.`))
        .map(item => ({ field: String(item.assignToReference).slice(recordName.length + 1), value: item.value }));
    }
    if (!identifier(objectName) || !assignments.length) return [];
    const fields = assignments.map(item => source(item.field, item.value));
    if (fields.some(field => !field)) return [];
    result.push({ objectName, fields: fields as FlowCreationField[] });
  }
  return result.length <= 3 ? result : [];
}
