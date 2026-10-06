import { describe, expect, it } from 'bun:test';
import { assessNativeActionOutcome, nativeActionSucceeded } from './action-outcome';

describe('native Actions execution outcomes', () => {
  it('requires HTTP success and a nonempty explicit native success result', () => {
    for (const [status, body] of [[200, []], [200, null], [200, {}], [200, '[{"isSuccess":true}]'],
      [500, [{ isSuccess: true }]], [200, [{ isSuccess: false }]]] as const)
      expect(nativeActionSucceeded(status, body)).toBe(false);
    expect(nativeActionSucceeded(200, [{ isSuccess: true, errors: null, outputValues: null }])).toBe(true);
  });
  it('rejects any failed batch member or appended Salesforce serialization error', () => {
    expect(nativeActionSucceeded(200, [{ isSuccess: true }, { isSuccess: false }])).toBe(false);
    expect(nativeActionSucceeded(200, [{ isSuccess: true }, { errorCode: 'JSON_PARSER_ERROR' }])).toBe(false);
  });
  it('rejects explicit nested Flow and tool failure envelopes', () => {
    expect(nativeActionSucceeded(200, [{ isSuccess: true, outputValues: {
      result: { isSuccess: false, errors: [{ statusCode: 'REQUIRED_FIELD_MISSING' }] },
    } }])).toBe(false);
    expect(nativeActionSucceeded(200, [{ isSuccess: true, outputValues: {
      response: { results: [{ isSuccess: false, outputValues: { errorMessage: 'Dependency unavailable' } }] },
    } }])).toBe(false);
  });
  it('rejects declared output failure, unsuccessful HTTP response codes and malformed errors', () => {
    for (const outputValues of [{ isSuccess: false }, { isVerified: false }, { responseCode: 403 },
      { responseCode: '200' }, { errorMessage: 'Failed to execute' }, { errors: { statusCode: 'FAILURE' } }])
      expect(nativeActionSucceeded(200, [{ isSuccess: true, outputValues }])).toBe(false);
    expect(nativeActionSucceeded(200, [{ isSuccess: true, outputValues: { responseCode: 200, errors: [] } }])).toBe(true);
  });
  it('does not treat returned business-record fields as execution errors', () => {
    const record = { Status: 'Failed', status: 'error', isSuccess: false, isVerified: false,
      errors: ['a historical business-record error'], errorMessage: 'Historical error', responseCode: 404 };
    expect(nativeActionSucceeded(200, [{ isSuccess: true, outputValues: { records: [record], record } }])).toBe(true);
    expect(nativeActionSucceeded(200, [{ isSuccess: true, outputValues: { results: [{ Status: 'Failed', errors: ['history'] }] } }])).toBe(true);
  });
  it('accepts successful nested execution envelopes without requiring domain-specific output', () => {
    expect(nativeActionSucceeded(200, [{ isSuccess: true, outputValues: {
      result: { isSuccess: true, errors: [], outputValues: { records: [] } },
    } }])).toBe(true);
  });
  it('bounds depth and rejects cyclic execution envelopes', () => {
    const cyclic: Record<string, unknown> = { isSuccess: true, errors: [] }; cyclic.outputValues = cyclic;
    expect(nativeActionSucceeded(200, [cyclic])).toBe(false);
    let result: unknown = { isSuccess: true, errors: [] };
    for (let depth = 0; depth < 15; depth++) result = { isSuccess: true, outputValues: { result } };
    expect(nativeActionSucceeded(200, [result])).toBe(false);
  });
  it('rejects accepted envelopes carrying a managed action-element fault message', () => {
    const fault = 'An error occurred while retrieving CI details: We couldn\u2019t execute the \u201cGetCmdbCiDetails\u201d action element of the getCmdbCiDetails type. Review your action name and version and try again.';
    expect(assessNativeActionOutcome(200, [{ isSuccess: true, errors: null,
      outputValues: { ciIdOutput: null, ciMessage: fault, ciData: '', Flow__InterviewStatus: 'Finished' } }]))
      .toEqual({ success: false, code: 'FLOW_ACTION_ELEMENT_UNRESOLVED' });
    expect(nativeActionSucceeded(200, [{ isSuccess: true, errors: null,
      outputValues: { ciMessage: 'CI details retrieved.', ciData: 'payload' } }])).toBe(true);
    expect(nativeActionSucceeded(200, [{ isSuccess: true, errors: null,
      outputValues: { note: 'Partial failure text without the element shape' } }])).toBe(true);
  });
  it('rejects accepted envelopes carrying a Spanish-locale action-element fault message', () => {
    const fault = 'No hemos podido ejecutar el elemento de acción "GetCmdbCiDetails" del tipo getCmdbCiDetails. Revise el nombre y la versión de su acción e inténtelo de nuevo.';
    expect(assessNativeActionOutcome(200, [{ isSuccess: true, errors: null,
      outputValues: { ciIdOutput: null, ciMessage: fault, ciData: '', Flow__InterviewStatus: 'Finished' } }]))
      .toEqual({ success: false, code: 'FLOW_ACTION_ELEMENT_UNRESOLVED' });
  });
  it('provides stable failure diagnostics without upstream messages or record values', () => {
    expect(assessNativeActionOutcome(200, [{ isSuccess: true, outputValues: { errorMessage: 'private upstream data' } }]))
      .toEqual({ success: false, code: 'ACTION_OUTPUT_ERROR' });
    expect(assessNativeActionOutcome(200, [{ isSuccess: true, outputValues: {
      result: { isSuccess: false, errors: [{ message: 'private upstream data' }] },
    } }])).toEqual({ success: false, code: 'ACTION_EXECUTION_REJECTED' });
    expect(assessNativeActionOutcome(200, [{ isSuccess: true }])).toEqual({ success: true, code: null });
  });
});
