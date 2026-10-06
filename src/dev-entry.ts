/**
 * Local-dev entry shim (used only via `wrangler dev -c wrangler.dev.jsonc`).
 *
 * Same local-workerd constraint as the searcher shim: named non-function
 * exports break local boot, so only the default export and the RPC
 * entrypoint class are re-exported. Unit tests import ./index directly.
 */
import worker, { TubotSfAuthEntrypoint } from "./index";

export { TubotSfAuthEntrypoint };
export default worker;
