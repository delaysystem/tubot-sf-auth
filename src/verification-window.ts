/** Central verification-window bound for owned-context settle waits.
 *
 * Dozens of owned-context lifecycles sleep `verificationWindowMs` between a
 * Salesforce mutation and its readback. This module is the single source of
 * truth for the admissible range: RPC entrypoints validate with
 * `isVerificationWindowMs` (rejecting out-of-range values at the boundary)
 * and every sleep site clamps with `clampVerificationWindowMs` (defense in
 * depth for internal callers that bypass the boundary).
 */

// Settle-wait bounds in milliseconds.
// Origin: the approval-owned-context.ts validation (integer 0..15000); the
// ceiling is the worker wall-clock budget shared by all owned-context
// lifecycles, the floor keeps "no wait" expressible.
export const VERIFICATION_WINDOW_MIN_MS = 0;
export const VERIFICATION_WINDOW_MAX_MS = 15_000;

/** True for an integer settle wait inside the RPC-admissible bound. */
export function isVerificationWindowMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= VERIFICATION_WINDOW_MIN_MS && value <= VERIFICATION_WINDOW_MAX_MS;
}

/** Defense-in-depth clamp for sleep sites. Non-finite values become "no wait"
 * (matching the historical falsy/NaN skip and timer-overflow behavior);
 * out-of-range finite values pin to the bound so a caller bug can neither
 * stall a worker past its budget nor pass a fractional/negative delay to the
 * timer. Identity on valid inputs. */
export function clampVerificationWindowMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return VERIFICATION_WINDOW_MIN_MS;
  return Math.min(Math.max(Math.floor(value), VERIFICATION_WINDOW_MIN_MS), VERIFICATION_WINDOW_MAX_MS);
}
