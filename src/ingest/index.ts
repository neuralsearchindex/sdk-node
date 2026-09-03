/**
 * `@neuralsearchindex/sdk-node/ingest` — the shared INGEST contract.
 *
 * One source of truth, imported by both the engine and the ingestion-pipeline,
 * for turning a raw scraped ad into an index document: per-domain validation
 * schemas, the text / image / location extraction hooks, the create-index
 * mapping, the document (row) builder, plus ingest-time embedding clients and a
 * geocoding helper. This is a SUBPATH export only — it is intentionally NOT part
 * of the root barrel (like `./geo`).
 */

// Domain enums (the cross-process wire contract) — reused from the SDK's schemas.
export { Domain, ResultMarker } from "../schemas/domain.js";

// The ingest contract types.
export type { DomainIngest, DomainDescriptor, IngestContext, LocationHint } from "./types.js";

// The domain registry / resolvers (each descriptor keeps `.indexName`).
export { resolveDomain, resolveDomainByIndex, DEFAULT_DOMAIN, ALL_DOMAINS, isDomain } from "./registry.js";
export { realEstateDomain } from "./real-estate.js";
export { vehiclesDomain } from "./vehicles.js";

// Canonical document value types (ImageStruct: OPTIONAL image_vector = "blind photo").
export type { ImageStruct, SparseVector } from "./ad-to-row.js";
export { adId, propertyAdToRow } from "./ad-to-row.js";

// Per-domain validation schemas + inferred types.
export {
  propertyAdSchema,
  addressSchema,
  fundamentalsSchema,
  equipmentSchema,
  agentSchema,
  rentSchema,
  propertyAdImageSchema
} from "./property-ad.js";
export type {
  PropertyAd,
  Address,
  Fundamentals,
  Equipment,
  Agent,
  Rent,
  PropertyAdImage,
  NearbyAmenity
} from "./property-ad.js";
export { vehicleAdSchema, vehicleAddressSchema, vehiclePriceSchema, vehicleAgentSchema } from "./vehicle-ad.js";
export type { VehicleAd, VehicleAddress } from "./vehicle-ad.js";

// Create-index bodies + dimensions (the same values each descriptor's
// `ingest.indexMapping()` returns), for callers that create the indices.
export {
  PROPERTY_AD_INDEX,
  DENSE_DIM,
  CLIP_DIM,
  MAX_IMAGES,
  MAX_QUERY_WINDOW,
  propertyAdIndexMapping,
  propertyAdIndexSettings,
  propertyAdIndexBody
} from "./index-schema.js";
export {
  VEHICLE_AD_INDEX,
  vehicleAdIndexMapping,
  vehicleAdIndexSettings,
  vehicleAdIndexBody,
  vehicleAdId,
  vehicleAdText,
  vehicleAdToRow
} from "./vehicles.js";
export { propertyAdText, MAX_TEXT_CHARS } from "./text.js";

// Stable id + url canonicalization.
export { listingId, LISTING_ID_NAMESPACE } from "./listing-id.js";
export { canonicalizeUrl } from "./url.js";

// Ingest-time embedding clients + geocoding helper.
export {
  makeTextEmbeddingClient,
  makeImageEmbeddingClient,
  resolveGeo
} from "./embeddings.js";
export type {
  EmbeddingClientOptions,
  TextEmbeddingResult,
  TextEmbeddingClient,
  ImageEmbeddingClient
} from "./embeddings.js";
