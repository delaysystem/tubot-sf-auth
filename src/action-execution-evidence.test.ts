import { describe, expect, test } from 'bun:test';
import { assessActionExecution } from './action-execution-evidence';

const accepted = [{ isSuccess: true, errors: [], outputValues: {} }];
describe('execution evidence shared by all action families', () => {
  test('cleanup failure rejects an otherwise accepted result without leaking the diagnostic', () => {
    const result = assessActionExecution(200, accepted, { cleanupError: 'private record details' });
    expect(result.success).toBe(false);
    expect(result.code).toBe('ACTION_CLEANUP_UNVERIFIED');
    expect(result.message).not.toContain('private record');
  });
  test('owned mutations require actual verified context, including future discovered actions', () => {
    for (const contextSchema of [undefined, {}, { verified: false }, { verified: 'true' }]) {
      expect(assessActionExecution(200, accepted, { contextRequired: true, contextSchema }).success).toBe(false);
    }
    expect(assessActionExecution(200, accepted, { contextRequired: true, contextSchema: { verified: true } }).success).toBe(true);
  });
  test('target evidence cannot override a rejected native outcome', () => {
    expect(assessActionExecution(200, [{ isSuccess: false }], { contextRequired: true, contextSchema: { verified: true } }).success).toBe(false);
    expect(assessActionExecution(403, accepted, { contextSchema: { verified: true } }).success).toBe(false);
  });
  test('ordinary read actions do not require mutation context', () => {
    expect(assessActionExecution(200, accepted).success).toBe(true);
  });
});
