import { planOwnedContext, type ContextNode, type ContextPlanIssue, type ContextSchema } from './owned-context-plan';

type Result = { status: number; ok: boolean; body: any };

const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

/**
 * Setup/config no identity can owned-mint, safe read-only retain.
 * Evidence only: BusinessHours (Case schedule ref; creatable but
 * deletable=false); WorkType (FSL agent flows; create w/o delete);
 * ServiceResource (FSL notification context; createable + queryable,
 * deletable=false; substituting a fixtureable object faults the flow's
 * own lookup, verified on FSAA__AA_Custom_NotificationFlow).
 * Never written/deleted.
 */
export const SETUP_REFERENCE_OBJECTS: ReadonlySet<string> = new Set(['BusinessHours', 'ServiceResource', 'WorkType']);

export function isSetupReferenceObject(n: unknown): boolean {
  return typeof n === 'string' && SETUP_REFERENCE_OBJECTS.has(n);
}

export async function readSetupReferenceRow(input: {
  root: string;
  objectName: string;
  request: (p: string, m?: string, b?: any) => Promise<Result>;
  describe: (o: string) => Promise<ContextSchema | undefined>;
}): Promise<string | null> {
  const { root, request, objectName } = input;
  if (!isSetupReferenceObject(objectName) || !IDENTIFIER.test(objectName)) return null;
  let s: ContextSchema | undefined;
  try {
    s = await input.describe(objectName);
  } catch {
    return null;
  }
  if (!s || s.queryable !== true) return null;
  if (s.createable === true && s.deletable === true) return null;
  let f: Result;
  try {
    f = await request(`${root}/query?q=${encodeURIComponent(`SELECT Id FROM ${objectName} LIMIT 1`)}`);
  } catch {
    return null;
  }
  const rows = f.ok && f.body !== null && typeof f.body === 'object' && Array.isArray((f.body as { records?: unknown }).records)
    ? (f.body as { records: Array<{ Id?: unknown }> }).records
    : [];
  if (rows.length !== 1 || typeof rows[0]?.Id !== 'string' || !SF_ID.test(rows[0].Id as string)) return null;
  return rows[0].Id as string;
}

/**
 * Retry lifecycle refusal with retained anchor (non-root setup refs only).
 * Null keeps caller verdict.
 */
export async function retryPlanWithRetainedSetup(input: {
  issue: ContextPlanIssue;
  roots: string[];
  maxNodes: number;
  markerLength: number;
  root: string;
  request: (p: string, m?: string, b?: any) => Promise<Result>;
  describe: (o: string) => Promise<ContextSchema | undefined>;
}): Promise<{ ok: true; nodes: ContextNode[]; cleanupOrder: string[] } | null> {
  const { issue } = input;
  if (!issue || issue.code !== 'OWNED_CONTEXT_LIFECYCLE_ACCESS_REQUIRED' || !Array.isArray(issue.dependencyPath) || issue.dependencyPath.length <= 1) {
    return null;
  }
  if (!isSetupReferenceObject(issue.objectName)) return null;
  const a = await readSetupReferenceRow({ root: input.root, objectName: issue.objectName, request: input.request, describe: input.describe });
  if (!a) return null;
  try {
    const r = await planOwnedContext({
      roots: input.roots,
      maxNodes: input.maxNodes,
      markerLength: input.markerLength,
      describe: input.describe,
      retained: { [issue.objectName]: a },
    });
    return r.ok ? r : null;
  } catch {
    return null;
  }
}
