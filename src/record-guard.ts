/** One shared record type-guard for owned-context modules.
 *
 * Dozens of *-context.ts files carried byte-identical `record`/`object`/
 * `isRecord` copies. New code imports this; the copies migrate file by file
 * (CPL remainder plan). Only the `Record<string, any>` flavor lives here:
 * `Record<string, unknown>` flavors keep their local guard until their call
 * sites are audited, since swapping unknown-safety for any-safety is a
 * type-level behavior change.
 */

/** Plain-object record with untyped values (matches the `Value` alias used by most context modules). */
export type RecordValue = Record<string, any>;

/** True for non-null, non-array objects. Origin: the identical local guards. */
export function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
