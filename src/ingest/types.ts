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
import type { ImageStruct, SparseVector, TextChunk } from "./ad-to-row.js";

/** Which text a listing's DENSE chunk vectors are built from (admin-selectable per pipeline).
 *  The SPARSE/lexical leg always uses the description composite, regardless of this. */
export type TextEmbeddingSource = "description" | "pageContent";

/** Per-run ingest options resolved from the pipeline config. */
export interface IngestOptions {
  /** Source for the dense chunk vectors. Defaults to `"description"`. */
  textEmbeddingSource?: TextEmbeddingSource;
  /** Cap on the number of chunks per listing. Defaults to `MAX_TEXT_CHUNKS` (20). */
  maxTextChunks?: number;
}

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
  /** The listing's dense text chunks (each with its own vector). A chunk whose
   *  vector is absent is a "blind chunk" (text encoder off/unreachable) — the row
   *  builder keeps its text but omits the vector, indexing the doc text-only. An
   *  empty array ⇒ no dense leg at all. Replaces the former single `dense` vector. */
  chunks: TextChunk[];
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
  /** The description composite — the SPARSE (lexical) leg's source. Always the
   *  structured composite, independent of `textEmbeddingSource`. */
  text(ad: Record<string, unknown>): string;
  /** The DENSE chunk texts for this ad, split from the source-selected text
   *  (`description` composite or full `pageContent`) and capped by `maxTextChunks`. */
  textChunks(ad: Record<string, unknown>, opts?: IngestOptions): Promise<string[]>;
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
