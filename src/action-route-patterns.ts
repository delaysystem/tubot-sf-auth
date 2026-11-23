/** One shared module for action/route name patterns.
 *
 * The platform name shapes below are Salesforce protocol vocabulary shared
 * by every context module; they were copied into a dozen files. New code
 * imports this; the copies migrate file by file (CPL remainder plan). Shapes
 * that intentionally differ (commerce-lifecycle-context.ts allows dots in
 * action names) keep their local pattern — only byte-identical copies
 * migrate.
 */

/** Action/class names: letter-led, letters/digits/underscores, max 128 chars. */
export const ACTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

/** Standard-action routes with the (version, action) captures. */
export const STANDARD_ROUTE = /^\/services\/data\/(v\d+(?:\.\d+)?)\/actions\/standard\/([A-Za-z][A-Za-z0-9_]{0,127})$/;
