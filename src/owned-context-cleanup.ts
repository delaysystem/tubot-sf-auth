import { grantFamilyForCleanupDenial } from './permission-denial-grants';

type RecordValue = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
export type OwnedRecord = { objectName: string; id: string };
export type OwnershipScope = {
  objectName: string;
  /** Exact marker/relationship fields read independently from the target. */
  equals: Record<string, unknown>;
  /** References must point to another independently proven owned record. */
  ownedParents?: Array<{ field: string; objectName: string }>;
};
/** Machine-readable delete-phase diagnosis for planners (grant mapping,
 * dashboards). Prose stays the human surface; this never applies grants.
 * Delete-denied entries are consumed by `cleanupDenialGrantNotes`, which
 * names their grant family in the recorded cleanup error. */
export type CleanupDiagnosis = {
  objectName: string;
  /** delete-denied: the DELETE leg was refused (permission gap).
   * absence-unverified: DELETE was accepted but the record still reads
   * back after a bounded re-read (lag or residue). */
  kind: 'delete-denied' | 'absence-unverified';
  /** Numeric platform status of the failing leg, when one was returned. */
  status?: number;
};

/** Planner-only grant-family notes for delete-denied diagnosis entries,
 * one per object. Absence-unverified entries are not denials and yield
 * nothing; malformed entries and invalid object names are skipped. */
const recordEntry = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function cleanupDenialGrantNotes(diagnosis: unknown): string[] {
  if (!Array.isArray(diagnosis)) return [];
  const seen = new Set<string>(), notes: string[] = [];
  for (const entry of diagnosis) {
    if (!recordEntry(entry) || entry.kind !== 'delete-denied' || typeof entry.objectName !== 'string') continue;
    if (seen.has(entry.objectName)) continue;
    const grant = grantFamilyForCleanupDenial(entry.objectName);
    if (!grant) continue;
    seen.add(entry.objectName);
    notes.push(`Planner grant family ${grant.family} for ${entry.objectName}: ${grant.requirement}`);
  }
  return notes;
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value);
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(value);
const key = (record: OwnedRecord) => `${record.objectName}:${record.id}`;

/** Creation envelopes are candidates, never deletion authority. Prove ownership
 * with fresh target reads before deleting, including on failed action paths.
 * Caller recovers lost writes via its unique marker/owned-parent queries first.
 */
export async function cleanupOwnedContext(input: {
  root: string; records: OwnedRecord[]; scopes: OwnershipScope[]; order: string[];
  request: (path: string, method?: string, body?: any) => Promise<Result>;
}): Promise<{ ownedRecords: OwnedRecord[]; cleanupError?: string; cleanupDiagnosis?: CleanupDiagnosis[] }> {
  const records = [...new Map(input.records.map(record => [key(record), record])).values()];
  const errors = new Set<string>(), actual = new Map<string, RecordValue>(), proven = new Set<string>();
  const diagnosis: CleanupDiagnosis[] = [];
  const statusText = (value: unknown): string => typeof value === 'number' ? String(value) : 'no response';
  const absent = new Set<string>();
  if (!/^\/services\/data\/v\d+\.\d+$/.test(input.root) || records.length > 64 || records.some(record => !identifier(record.objectName) || !identity(record.id)) ||
    input.scopes.some(scope => !identifier(scope.objectName) || !Object.keys(scope.equals).length || Object.keys(scope.equals).some(field => !identifier(field)) ||
      scope.ownedParents?.some(parent => !identifier(parent.field) || !identifier(parent.objectName))) || records.some(record => !input.order.includes(record.objectName))) {
    return { ownedRecords: [], cleanupError: 'Owned context cleanup plan is invalid or exceeds its bounded lifecycle.' };
  }
  const url = (record: OwnedRecord) => input.root.replace(/^\/services\/data\//, '') + '/sobjects/' + record.objectName + '/' + record.id;
  for (let offset = 0; offset < records.length; offset += 25) {
    const chunk = records.slice(offset, offset + 25);
    let result: Result;
    try { result = await input.request(input.root + '/composite/batch', 'POST', { haltOnError: false, batchRequests: chunk.map(record => ({ method: 'GET', url: url(record) })) }); }
    catch { errors.add('Owned context ownership readback failed.'); continue; }
    if (!result.ok || !Array.isArray(result.body?.results) || result.body.results.length !== chunk.length) { errors.add('Owned context ownership readback was incomplete.'); continue; }
    chunk.forEach((record, index) => {
      const read = result.body.results[index];
      if (read?.statusCode === 404) absent.add(key(record));
      else if (read?.statusCode === 200 && read.result?.Id === record.id) actual.set(key(record), read.result);
      else errors.add(`Owned ${record.objectName} ownership readback failed.`);
    });
  }
  // Parent-marker proof must precede child-relationship proof, independent of
  // the caller's deletion order. Never infer ownership from the returned ID.
  for (let pass = 0; pass < records.length; pass++) {
    let changed = false;
    for (const record of records) {
      if (proven.has(key(record))) continue;
      const read = actual.get(key(record));
      if (!read) continue;
      const scope = input.scopes.find(scope => scope.objectName === record.objectName &&
        Object.entries(scope.equals).every(([field, value]) => read[field] === value) &&
        (scope.ownedParents ?? []).every(parent => identity(read[parent.field]) && proven.has(`${parent.objectName}:${read[parent.field]}`)));
      if (scope) { proven.add(key(record)); changed = true; }
    }
    if (!changed) break;
  }
  for (const record of records) if (!proven.has(key(record)) && !absent.has(key(record))) errors.add(`Owned ${record.objectName} identity could not be proven; deletion was withheld.`);
  const ownedRecords = records.filter(record => proven.has(key(record)));
  const ordered = input.order.flatMap(name => ownedRecords.filter(record => record.objectName === name));
  const reread: OwnedRecord[] = [];
  for (let offset = 0; offset < ordered.length; offset += 12) {
    const chunk = ordered.slice(offset, offset + 12);
    let result: Result;
    try { result = await input.request(input.root + '/composite/batch', 'POST', { haltOnError: false,
      batchRequests: chunk.flatMap(record => ['DELETE', 'GET'].map(method => ({ method, url: url(record) }))) }); }
    catch { errors.add('Owned context cleanup batch failed.'); continue; }
    if (!result.ok || !Array.isArray(result.body?.results) || result.body.results.length !== chunk.length * 2) { errors.add('Owned context cleanup target readbacks were incomplete.'); continue; }
    chunk.forEach((record, index) => {
      // Split the two verification legs: a delete denial (403/400/...) is a
      // permission gap, while a 404-miss after a good delete is an absence
      // mismatch (lag or residue). Both fail closed; only the diagnosis
      // differs. Object names are identifier-validated, statuses numeric.
      const deleted = result.body.results[index * 2]?.statusCode;
      const absent = result.body.results[index * 2 + 1]?.statusCode;
      if (![204, 404].includes(deleted)) {
        errors.add(`Owned ${record.objectName} cleanup deletion returned ${statusText(deleted)}; absence was not verified.`);
        diagnosis.push({ objectName: record.objectName, kind: 'delete-denied', ...(typeof deleted === 'number' ? { status: deleted } : {}) });
      } else if (absent !== 404) reread.push(record);
    });
  }
  // Absence mismatches get exactly one bounded re-read: transient lag
  // verifies on the second read, while residue or a persistent mismatch
  // keeps the fail-closed error. The re-read never deletes.
  for (let offset = 0; offset < reread.length; offset += 25) {
    const chunk = reread.slice(offset, offset + 25);
    let result: Result;
    try { result = await input.request(input.root + '/composite/batch', 'POST', { haltOnError: false,
      batchRequests: chunk.map(record => ({ method: 'GET', url: url(record) })) }); }
    catch { for (const record of chunk) failAbsence(record, undefined); continue; }
    if (!result.ok || !Array.isArray(result.body?.results) || result.body.results.length !== chunk.length) {
      for (const record of chunk) failAbsence(record, undefined);
      continue;
    }
    chunk.forEach((record, index) => {
      const absent = result.body.results[index]?.statusCode;
      if (absent !== 404) failAbsence(record, absent);
    });
  }
  function failAbsence(record: OwnedRecord, status: unknown) {
    errors.add(`Owned ${record.objectName} cleanup deletion verified but absence readback returned ${statusText(status)}.`);
    diagnosis.push({ objectName: record.objectName, kind: 'absence-unverified', ...(typeof status === 'number' ? { status } : {}) });
  }
  for (const note of cleanupDenialGrantNotes(diagnosis)) errors.add(note);
  return { ownedRecords, ...(errors.size ? { cleanupError: [...errors].join(' ') } : {}), ...(diagnosis.length ? { cleanupDiagnosis: diagnosis } : {}) };
}
