import { nativeActionSucceeded } from './action-outcome';
import { cleanupOwnedContext, type OwnedRecord } from './owned-context-cleanup';
import { denialGrantForRestOutcome } from './permission-denial-grants';
import { clampVerificationWindowMs } from './verification-window';

type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(value);
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Native create/update lifecycle. Returned IDs are candidates; fresh markers
 * authorize invocation and cleanup. Recover lost writes before every cleanup. */
export async function invokeOwnedRecordAction(input: {
  root: string; route: string; target: string; update: boolean; markerField: string; marker: string;
  markerLength: number; values: Value; verificationWindowMs?: number;
  request: (path: string, method?: string, body?: any) => Promise<Result>;
}) {
  const { root, target, markerField, marker, request } = input;
  if (!/^\/services\/data\/v\d+(?:\.\d+)?$/.test(root) || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(target) ||
      !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(markerField) || !/^[A-Za-z0-9 _-]{1,128}$/.test(marker) ||
      input.route !== `${root}/actions/standard/${input.update ? 'updateRecord' : 'createRecord'}` ||
      input.values[markerField] !== marker || !Number.isSafeInteger(input.markerLength) || input.markerLength < marker.length)
    return { status: 422, ok: false, body: { errorCode: 'RECORD_ACTION_OWNERSHIP_PLAN_INVALID',
      message: 'A native record route and uniquely marked ownership plan are required.' } };
  const expectedChanges: Value = input.update ? { [markerField]: `${marker} changed`.slice(0, input.markerLength) } : {};
  const markers = [...new Set([marker, ...(input.update ? [expectedChanges[markerField]] : [])])];
  const candidates: OwnedRecord[] = [];
  const capture = (id: unknown) => { if (identity(id) && !candidates.some(record => record.id === id)) candidates.push({ objectName: target, id }); };
  const fail = (code: string, message: string): Result => ({ status: 422, ok: false, body: { errorCode: code, message } });
  let outcome: Result = fail('RECORD_ACTION_CONTEXT_UNVERIFIED', 'The owned context failed readback verification.');
  let cleanupError: string | undefined, verified = false, writeAttempted = false, ownedId: string | undefined;
  let ownedRecords: OwnedRecord[] = [];
  const verificationRecordIds: string[] = [];
  const recover = async (): Promise<string[]> => {
    const found = await request(root + '/query?q=' + encodeURIComponent(`SELECT Id FROM ${target} WHERE ${markerField} IN (${markers.map(value => `'${value}'`).join(',')}) LIMIT 65`));
    if (!found.ok || !Array.isArray(found.body?.records) || found.body.records.length > 64 || found.body.records.some((record: any) => !identity(record?.Id))) {
      cleanupError = 'Owned record action write recovery was unavailable or exceeded its bounded ownership scope.';
      return [];
    }
    const proven: string[] = [];
    for (const record of found.body.records) {
      capture(record.Id);
      const actual = await request(`${root}/sobjects/${target}/${record.Id}`);
      if (actual.ok && object(actual.body) && actual.body.Id === record.Id && markers.includes(actual.body[markerField])) proven.push(record.Id);
      else if (actual.status !== 404) cleanupError = 'Recovered record action ownership could not be verified.';
    }
    return proven;
  };
  try {
    let ready = true;
    if (input.update) {
      writeAttempted = true;
      const created = await request(`${root}/sobjects/${target}`, 'POST', input.values);
      capture(created.body?.id);
      if (!created.ok || !identity(created.body?.id)) { outcome = created; ready = false; }
      else {
        const before = await request(`${root}/sobjects/${target}/${created.body.id}`);
        if (!before.ok || before.body?.Id !== created.body.id || before.body?.[markerField] !== marker) ready = false;
        else ownedId = created.body.id;
      }
    }
    if (ready) {
      writeAttempted = true;
      const args = { objectApiName: target, recordData: input.update ? expectedChanges : input.values,
        ...(ownedId ? { recordId: ownedId } : {}) };
      outcome = await request(input.route, 'POST', { inputs: [args] });
      if (!input.update) {
        const recovered = await recover();
        if (recovered.length === 1) ownedId = recovered[0];
      }
      if (ownedId) {
        const actual = await request(`${root}/sobjects/${target}/${ownedId}`);
        const outputMatches = (Array.isArray(outcome.body) ? outcome.body : [outcome.body]).every((item: any) =>
          item?.outputValues?.recordId === undefined || item.outputValues.recordId === ownedId);
        verified = nativeActionSucceeded(outcome.status, outcome.body) && outputMatches && actual.ok &&
          actual.body?.Id === ownedId && actual.body?.[markerField] === (input.update ? expectedChanges[markerField] : marker);
        if (verified) verificationRecordIds.push(ownedId);
        if (input.verificationWindowMs) await new Promise(resolve => setTimeout(resolve, clampVerificationWindowMs(input.verificationWindowMs)));
      }
    }
  } catch {
    outcome = { status: 502, ok: false, body: { errorCode: 'RECORD_ACTION_UPSTREAM_UNAVAILABLE',
      message: 'Salesforce execution failed; owned record write recovery and cleanup will still run.' } };
  } finally {
    if (writeAttempted) {
      try { await recover(); } catch { cleanupError = 'Owned record action lost-write recovery failed.'; }
      const cleanup = await cleanupOwnedContext({ root, records: candidates, order: [target],
        scopes: markers.map(value => ({ objectName: target, equals: { [markerField]: value } })), request });
      ownedRecords = cleanup.ownedRecords;
      if (cleanup.cleanupError) cleanupError = [cleanupError, cleanup.cleanupError].filter(Boolean).join(' ');
    }
  }
  // Upstream REST denials map to planner-only grant-family requirements;
  // non-denial outcomes (successes included) attach nothing. Grants are
  // never applied here.
  const denialGrant = nativeActionSucceeded(outcome.status, outcome.body)
    ? null : denialGrantForRestOutcome(outcome.status, outcome.body);
  const grantExtra = denialGrant ? { denialGrant } : {};
  const contextSchema = { source: 'salesforce_live_record_action', targetObject: target, markerField, marker,
    mutationKind: input.update ? 'update' : 'create', changedFields: Object.keys(expectedChanges),
    ...(input.update ? { expectedChanges } : {}), verified, verificationRecordIds, ownedRecords,
    automaticSteps: ['Describe the live record action and selected object', 'Build required fields from live schema',
      ...(input.update ? ['Create and freshly verify a uniquely marked update context'] : []),
      'Invoke the native record action', 'Read back the actual mutation',
      'Recover lost writes through unique ownership markers', 'Prove fresh ownership before deleting', 'Verify target absence'],
    ...grantExtra };
  if (nativeActionSucceeded(outcome.status, outcome.body) && !verified) return { ...fail('RECORD_ACTION_MUTATION_UNVERIFIED',
    'Salesforce accepted the action but no verified owned record mutation was observed.'), contextSchema, ...(cleanupError ? { cleanupError } : {}) };
  return { ...outcome, contextSchema, ...grantExtra, ...(cleanupError ? { cleanupError } : {}) };
}
