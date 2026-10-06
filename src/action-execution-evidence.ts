import { assessNativeActionOutcome } from './action-outcome';

export type ExecutionEvidence = {
  cleanupError?: string | null;
  contextRequired?: boolean;
  contextSchema?: unknown;
};

/** A native result and its required target verification must agree before saving success. */
export function assessActionExecution(status: number, body: unknown, evidence: ExecutionEvidence = {}) {
  if (evidence.cleanupError) return {
    success: false, category: 'fixture_cleanup_failed', code: 'ACTION_CLEANUP_UNVERIFIED',
    message: 'Owned execution context cleanup could not be verified in Salesforce.',
  };
  const outcome = assessNativeActionOutcome(status, body);
  if (!outcome.success) return { ...outcome, category: 'action_rejected', message: null };
  if (evidence.contextRequired && (!evidence.contextSchema || typeof evidence.contextSchema !== 'object' ||
      Array.isArray(evidence.contextSchema) || (evidence.contextSchema as Record<string, unknown>).verified !== true)) {
    return { success: false, category: 'mutation_unverified', code: 'ACTION_CONTEXT_UNVERIFIED',
      message: 'The native action outcome has no verified target context or mutation readback.' };
  }
  return { success: true, category: null, code: null, message: null };
}
