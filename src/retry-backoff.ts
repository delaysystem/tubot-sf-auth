/** One shared exponential-backoff-with-jitter helper for Salesforce polling.
 *
 * Every retry loop in this worker (metadata reads, settle polls, approval
 * propagation, inbox delivery, permission probes) must spread its retries
 * instead of hammering a failing upstream on a fixed cadence, and must stay
 * bounded so a slow upstream cannot stall a worker past its budget.
 */

// Backoff shape.
// Origin of the scheme: "Exponential Backoff And Jitter" (AWS Architecture
// Blog) — binary exponential growth with equal jitter (half of each delay is
// fixed, half is random) so concurrent workers desynchronize their retries.
// Origin of the cap: this module — growth stops at twice the call site's
// pre-existing fixed delay, so worst-case wall stays near ~1.5x the
// historical fixed-cadence budget instead of exploding over many attempts.
export const BACKOFF_GROWTH_FACTOR = 2;
export const BACKOFF_FIXED_SHARE = 0.5;
export const BACKOFF_CAP_MULTIPLE = 2;

/** Delay before retry `attempt` (0-based: 0 is the first wait). `baseMs` is
 * the call site's pre-existing fixed delay, kept as the growth seed. A
 * non-positive base yields 0 (callers probing with delay 0 stay instant).
 * `random` is injectable for deterministic tests; defaults to Math.random. */
export function backoffDelayMs(
  attempt: number, baseMs: number, random: () => number = Math.random,
): number {
  if (!(baseMs > 0)) return 0;
  const step = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const grown = Math.min(
    baseMs * BACKOFF_GROWTH_FACTOR ** step,
    baseMs * BACKOFF_CAP_MULTIPLE,
  );
  return Math.floor(grown * BACKOFF_FIXED_SHARE + random() * grown * (1 - BACKOFF_FIXED_SHARE));
}
