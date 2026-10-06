export type ContextField = {
  name: string; type: string; createable?: boolean; nillable?: boolean;
  defaultedOnCreate?: boolean; calculated?: boolean; autoNumber?: boolean;
  filterable?: boolean; length?: number; nameField?: boolean; referenceTo?: string[];
};
export type ContextSchema = {
  name: string; createable?: boolean; queryable?: boolean; deletable?: boolean; fields: ContextField[];
};
export type ContextNode = {
  objectName: string; markerField: string; values: Record<string, unknown>;
  references: Array<{ field: string; objectName: string; source: 'owned' | 'retained'; id?: string }>;
};
export type ContextPlanIssue = {
  code: string; objectName: string; field?: string; targets?: string[]; dependencyPath: string[];
};
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value);
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(value);

/** Plan disposable dependencies from the active tenant's schemas before any write.
 * Retained anchors are caller-authorized identities, never arbitrary first rows.
 * A plan does not assert that Scheduler/Commerce domain availability is configured.
 */
export async function planOwnedContext(input: {
  roots: string[];
  describe: (objectName: string) => Promise<ContextSchema | undefined>;
  values?: Record<string, Record<string, unknown>>;
  retained?: Record<string, string>;
  referenceTargets?: Record<string, string>;
  maxNodes?: number;
  markerLength?: number;
}): Promise<{ ok: true; nodes: ContextNode[]; cleanupOrder: string[] } | { ok: false; issue: ContextPlanIssue }> {
  const nodes: ContextNode[] = [], done = new Set<string>(), visiting = new Set<string>();
  const maximum = input.maxNodes ?? 8, markerLength = input.markerLength ?? 48;
  const reject = (code: string, objectName: string, dependencyPath: string[], field?: string, targets?: string[]): never => {
    throw { code, objectName, dependencyPath, ...(field ? { field } : {}), ...(targets ? { targets } : {}) } satisfies ContextPlanIssue;
  };
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 25 || !Number.isInteger(markerLength) || markerLength < 1 ||
    !input.roots.length || input.roots.some(name => !identifier(name))) {
    return { ok: false, issue: { code: 'OWNED_CONTEXT_PLAN_INVALID', objectName: '', dependencyPath: [] } };
  }
  const visit = async (name: string, path: string[]): Promise<void> => {
    const dependencyPath = [...path, name];
    if (visiting.has(name)) reject('OWNED_CONTEXT_REFERENCE_CYCLE', name, dependencyPath);
    if (done.has(name)) return;
    if (done.size + visiting.size >= maximum) reject('OWNED_CONTEXT_GRAPH_LIMIT', name, dependencyPath);
    visiting.add(name);
    let schema: ContextSchema | undefined;
    try { schema = await input.describe(name); } catch { reject('OWNED_CONTEXT_SCHEMA_UNAVAILABLE', name, dependencyPath); }
    if (!schema || schema.name !== name || !Array.isArray(schema.fields)) reject('OWNED_CONTEXT_SCHEMA_UNAVAILABLE', name, dependencyPath);
    if (!schema!.createable || !schema!.queryable || !schema!.deletable) reject('OWNED_CONTEXT_LIFECYCLE_ACCESS_REQUIRED', name, dependencyPath);
    const markers = schema!.fields.filter(field => identifier(field.name) && field.type === 'string' && field.createable &&
      field.filterable && !field.calculated && !field.autoNumber && (field.length ?? 0) >= markerLength);
    const marker = markers.find(field => field.nameField) ?? markers.find(field => field.nillable === false) ?? markers[0];
    if (!marker) reject('OWNED_CONTEXT_MARKER_UNAVAILABLE', name, dependencyPath);
    const values = { ...input.values?.[name] }, references: ContextNode['references'] = [];
    for (const field of schema!.fields) {
      if (field.type !== 'reference' || field.nillable !== false || field.defaultedOnCreate || field.calculated || field.autoNumber) continue;
      if (!identifier(field.name) || !field.createable) reject('OWNED_CONTEXT_REFERENCE_NOT_WRITABLE', name, dependencyPath, field.name);
      const targets = [...new Set(field.referenceTo?.filter(identifier) ?? [])];
      if (Object.hasOwn(values, field.name)) {
        const retainedTargets = targets.filter(target => input.retained?.[target] === values[field.name]);
        if (!identity(values[field.name]) || retainedTargets.length !== 1) reject('OWNED_CONTEXT_REFERENCE_NOT_SCOPED', name, dependencyPath, field.name, targets);
        references.push({ field: field.name, objectName: retainedTargets[0], source: 'retained', id: values[field.name] as string });
        continue;
      }
      const selected = input.referenceTargets?.[`${name}.${field.name}`];
      const target = selected && targets.includes(selected) ? selected : !selected && targets.length === 1 ? targets[0] : undefined;
      if (!target) reject('OWNED_CONTEXT_REFERENCE_AMBIGUOUS', name, dependencyPath, field.name, targets);
      const anchor = input.retained?.[target!];
      if (anchor !== undefined) {
        if (!identity(anchor)) reject('OWNED_CONTEXT_ANCHOR_INVALID', name, dependencyPath, field.name, [target!]);
        values[field.name] = anchor;
        references.push({ field: field.name, objectName: target!, source: 'retained', id: anchor });
      } else {
        await visit(target!, dependencyPath);
        references.push({ field: field.name, objectName: target!, source: 'owned' });
      }
    }
    visiting.delete(name); done.add(name);
    nodes.push({ objectName: name, markerField: marker!.name, values, references });
  };
  try {
    for (const root of input.roots) await visit(root, []);
    return { ok: true, nodes, cleanupOrder: nodes.map(node => node.objectName).reverse() };
  } catch (issue) {
    return { ok: false, issue: issue as ContextPlanIssue };
  }
}
