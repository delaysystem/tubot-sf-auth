type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: ObjectValue, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const present = (value: unknown) => value !== undefined && value !== null && value !== '';

// These are execution containers, not arbitrary fields on returned business records.
const EXECUTION_CONTAINERS = ['outputValues', 'result', 'results', 'response', 'responses', 'actionResults'];
function resultEnvelope(value: ObjectValue): boolean {
  return own(value, 'isSuccess') && ['outputValues', 'errors', 'errorCode', 'errorMessage', 'actionName', 'flowInterviewId']
    .some(key => own(value, key));
}

/** Verifies the native Actions result contract. Record mutation/readback verification is separate. */
export function assessNativeActionOutcome(status: number, body: unknown): { success: boolean; code: string | null } {
  let code: string | null = null;
  const fail = (reason: string): false => { code ??= reason; return false; };
  if (!Number.isInteger(status) || status < 200 || status >= 300) return { success: false, code: 'ACTION_HTTP_ERROR' };
  const outcomes = Array.isArray(body) ? body : [body];
  if (outcomes.length === 0 || outcomes.length > 256) return { success: false, code: 'ACTION_OUTCOME_MISSING_OR_OVERSIZED' };
  let visited = 0;
  const seen = new Set<object>();
  const check = (value: ObjectValue, boundary: 'action' | 'output' | 'container', depth: number): boolean => {
    if (++visited > 256 || depth > 12 || seen.has(value)) return fail('ACTION_OUTCOME_TRAVERSAL_LIMIT');
    seen.add(value);
    if (boundary === 'action' && value.isSuccess !== true) return fail('ACTION_EXECUTION_REJECTED');
    if (boundary !== 'container' || resultEnvelope(value)) {
      if (value.isSuccess === false || value.isVerified === false) return fail('ACTION_OUTPUT_REJECTED');
      if (own(value, 'errors') && value.errors !== null && value.errors !== undefined &&
          (!Array.isArray(value.errors) || value.errors.length > 0)) return fail('ACTION_OUTPUT_ERRORS');
      if (present(value.errorCode) || present(value.errorMessage)) return fail('ACTION_OUTPUT_ERROR');
      // Managed Flow action elements report backend resolution failures as
      // message outputs inside an accepted envelope (ciMessage, promptMessage,
      // deleteMessage). The exact platform phrasing is unambiguous evidence
      // the operation failed; no true success contains it.
      if (boundary === 'output') {
        for (const entry of Object.values(value)) {
          if (typeof entry !== 'string' || entry.length === 0 || entry.length > 4000) continue;
          const fault = /couldn.t execute the ["\u201c\u201d]([^""\u201c\u201d]{1,128})["\u201c\u201d] action element of the ([A-Za-z][A-Za-z0-9_]{1,127}) type/i.exec(entry);
          if (fault && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(fault[1].trim())) return fail('FLOW_ACTION_ELEMENT_UNRESOLVED');
          // Spanish-locale variant ("No hemos podido ejecutar el elemento de
          // acción "X" del tipo Y."). Without this, Spanish-org faults
          // falsely convert while English orgs park.
          const spanishFault = /no hemos podido ejecutar el elemento de acci[oó]n ["\u201c\u201d]([^""\u201c\u201d]{1,128})["\u201c\u201d] del tipo ([A-Za-z][A-Za-z0-9_]{1,127})/i.exec(entry);
          if (spanishFault && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(spanishFault[1].trim())) return fail('FLOW_ACTION_ELEMENT_UNRESOLVED');
        }
      }
      if (own(value, 'responseCode') && (typeof value.responseCode !== 'number' ||
          !Number.isInteger(value.responseCode) || value.responseCode < 200 || value.responseCode >= 300)) return fail('ACTION_OUTPUT_HTTP_ERROR');
    }
    for (const key of EXECUTION_CONTAINERS) {
      const child = value[key];
      if (child === undefined || child === null) continue;
      const items = Array.isArray(child) ? child : [child];
      if (items.length > 256) return fail('ACTION_OUTCOME_TRAVERSAL_LIMIT');
      for (const item of items) {
        if (!object(item)) continue;
        // outputValues is itself a declared execution boundary. Other container contents
        // are inspected only when they declare an execution envelope or another container.
        if (key === 'outputValues' || resultEnvelope(item) || EXECUTION_CONTAINERS.some(name => own(item, name))) {
          if (!check(item, key === 'outputValues' ? 'output' : resultEnvelope(item) ? 'action' : 'container', depth + 1)) return false;
        }
      }
    }
    seen.delete(value);
    return true;
  };
  const success = outcomes.every(value => object(value) ? check(value, 'action', 0) : fail('ACTION_OUTCOME_INVALID'));
  return { success, code };
}

export function nativeActionSucceeded(status: number, body: unknown): boolean {
  return assessNativeActionOutcome(status, body).success;
}
