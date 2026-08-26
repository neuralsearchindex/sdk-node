/**
 * Subpath shim (`@neuralsearchindex/sdk-node/schemas/url`).
 *
 * The wire contract has no dedicated url module — listing URLs live on the
 * `sourceUrl` / `imageUrls` fields of the listing. This module re-exports the
 * type that carries them so consumers can import it via the documented subpath.
 */
export type { PropertyListing } from "./listing.js";
