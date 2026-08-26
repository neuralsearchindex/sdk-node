/**
 * Subpath shim (`@neuralsearchindex/sdk-node/schemas/property-type`).
 *
 * The wire contract has no dedicated property-type module — `propertyType` is a
 * free-form string field on both the listing and the search intent. This module
 * re-exports the types that carry it so consumers can import them via the
 * documented subpath.
 */
export type { PropertyListing } from "./listing.js";
export type { SearchIntent, RetrievalWeights } from "./search-intent.js";
