// Ported from engine `search/domains/types.ts`, adapted for the SDK ingest
// contract with the required renames:
//   - `IngestGeoHint`         -> `LocationHint`
//   - DomainIngest.`geoHint`  -> `locationHint`
//   - DomainIngest.`toRow`    -> `toDocument`
//   - added DomainIngest.`indexMapping()` (was the descriptor's `indexBody()`)
// The engine-only descriptor fields (`indexBody`, `rowToListing`) that belong to
// the read/search path are dropped — this package is the INGEST contract only.
import type { GeocodableAddress, LatLon } from "../geo/index.js";

import type { Domain } from "../schemas/domain.js";
import type { ImageStruct, SparseVector } from "./ad-to-row.js";

/**
 * Where a scraped ad's coordinates come from: an explicit `coords` on the ad
 * wins; otherwise `address` is handed to the geocoder. Both null ⇒ no location.
 * Kept pure (no I/O) so the ingest service owns the geocode call + its pooling.
 */
export interface LocationHint {
  coords: LatLon | null;
  address: GeocodableAddress | null;
}

/** Per-ad enrichment the ingest service has computed before mapping to a document. */
export interface IngestContext {
  geo: LatLon | null;
  /** Best-effort: null/empty when the text encoder is off/unreachable. Document
   *  builders omit the dense_vector field entirely in that case (text-only). */
  dense: number[] | null;
  /** Best-effort: null when the embedding provider has no sparse route. Document
   *  builders omit the sparse field entirely in that case (dense-only). */
  sparse: SparseVector | null;
  images: ImageStruct[];
  /** Ingest timestamp (epoch ms) — the document's `scraped_at`. */
  now: number;
}

/**
 * A domain's ingest mappers: how a raw scraped ad becomes an index document. The
 * ingest service is domain-neutral — it validates, geocodes, embeds and bulk
 * writes, delegating every domain-specific decision to these hooks. The ad is
 * typed structurally (`Record<string, unknown>`) so heterogeneous descriptors
 * live in one registry; each implementation casts to its concrete ad type.
 */
export interface DomainIngest {
  /** Validate a raw ad; return the parsed ad, or null when it fails the schema. */
  parse(raw: unknown): Record<string, unknown> | null;
  /** Stable document id for the ad (dedupes re-scrapes of the same listing). */
  id(ad: Record<string, unknown>): string;
  /** The text to embed (dense + sparse) for this ad. */
  text(ad: Record<string, unknown>): string;
  /** Image URLs to CLIP-embed. */
  imageUrls(ad: Record<string, unknown>): string[];
  /** Coordinates / address for geocoding. */
  locationHint(ad: Record<string, unknown>): LocationHint;
  /** Map the validated ad + enrichment into the store's `_source` document. */
  toDocument(ad: Record<string, unknown>, ctx: IngestContext): Record<string, unknown>;
  /** OpenSearch-style create-index body (`{ settings, mappings }`) for this domain. */
  indexMapping(): Record<string, unknown>;
}

/**
 * A domain's ingest-side facts: which index/collection holds its documents and
 * how to ingest a scraped ad into it. Retrieval (intent → DSL, rerank legs) and
 * row→listing hydration are read-path concerns owned by other services, so they
 * are NOT part of this descriptor.
 */
export interface DomainDescriptor {
  id: Domain;
  /** The store index / collection name for this domain (e.g. "property_ads"). */
  indexName: string;
  /** Domain-specific ingest mappers (scraped ad → index document). */
  ingest: DomainIngest;
}
