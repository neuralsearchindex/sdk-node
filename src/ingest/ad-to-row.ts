// Ported from engine `search/shared/domain/ad-to-row.ts`. Builds the
// `property_ads` `_source` document (row) from a validated PropertyAd + ingest
// enrichment. Owns the canonical ImageStruct / SparseVector types re-exported by
// the ingest barrel.
import { type LatLon, pointWkt } from "../geo/index.js";

import { listingId } from "./listing-id.js";
import type { PropertyAd } from "./property-ad.js";
import { canonicalizeUrl } from "./url.js";

export interface SparseVector {
  [index: number]: number;
}

export interface ImageStruct {
  url: string;
  /**
   * CLIP embedding of the photo. OMITTED (not `[]`) when the encoder couldn't
   * fetch/embed the image: an empty array is an invalid `knn_vector` value and
   * fails the bulk write, whereas an absent field indexes the doc text-only with
   * the URL preserved — the intended "blind photo" behaviour.
   */
  image_vector?: number[];
  /**
   * 0-based display order after aesthetic sorting (best photo first). Stamped by
   * the ingestion-pipeline `order-images` step. Absent ⇒ position in the array is
   * the order (back-compat).
   */
  order?: number;
  /** CLIP-cosine aesthetic score in [0,1]; higher = more attractive photo. */
  aesthetic_score?: number;
  /**
   * Photo category (exterior/interior/floor-plan/other). Populated once the
   * siglip classifier is wired into ingestion; absent until then.
   */
  type?: string;
}

export interface TextChunk {
  /** The chunk's source markdown (stored, `index: false`). */
  text: string;
  /**
   * Dense embedding of the chunk. OMITTED (not `[]`) when the text encoder is
   * off/unreachable — the "blind chunk" analogue of a blind photo: the chunk text
   * is still stored, but no invalid empty `knn_vector` is written.
   */
  chunk_vector?: number[];
}

export function adId(ad: PropertyAd): string {
  const raw = ad.sourceUrl?.trim();
  const seed = (raw && (canonicalizeUrl(raw) ?? raw)) || `${ad.referenceNumber ?? ""}:${ad.name ?? ""}`;
  return listingId(seed);
}

function sourceDomain(url?: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.slice(0, 250);
  } catch {
    return "";
  }
}

function renovationYear(latest: unknown): number {
  if (typeof latest === "number") return latest;
  if (Array.isArray(latest) && latest.length > 0) {
    const nums = latest.filter((n): n is number => typeof n === "number");
    if (nums.length > 0) return Math.max(...nums);
  }
  return -1;
}

const s = (v: unknown, max: number): string => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);

function featuresFromEquipment(equipment: unknown): Array<{ label: string; value?: string }> {
  if (!equipment || typeof equipment !== "object") return [];
  const out: Array<{ label: string; value?: string }> = [];
  for (const [key, value] of Object.entries(equipment as Record<string, unknown>)) {
    if (value === true) out.push({ label: key });
    else if (typeof value === "string" && value.trim()) out.push({ label: key, value: value.trim() });
    else if (typeof value === "number") out.push({ label: key, value: String(value) });
    else if (value && typeof value === "object" && "value" in (value as object)) {
      const v = (value as { value?: unknown }).value;
      if (v != null) out.push({ label: key, value: String(v) });
    }
  }
  return out;
}

export function propertyAdToRow(
  ad: PropertyAd,
  geo: LatLon | null,
  chunks: TextChunk[],
  sparse: SparseVector | null,
  images: ImageStruct[],
  scrapedAt: number,
  textHash?: string | null,
  imageHash?: string | null
): Record<string, unknown> {
  const address = ad.address ?? {};
  const f = ad.fundamentals;
  const rent = ad.rent ?? {};
  const agency = ad.agent?.agency ?? {};
  const agent = ad.agent?.agent ?? {};

  return {
    id: adId(ad),
    name: s(ad.name, 500),
    description: s(ad.description, 4000),
    additional_information: s(ad.additionalInformation, 2000),
    language: s(ad.language, 8),
    reference_number: s(ad.referenceNumber, 128),
    source_url: s(ad.sourceUrl, 1000),
    published_at: s(ad.publishedAt, 64),
    updated_at: s(ad.updatedAt, 64),
    listing_type: s(ad.listingType, 8),
    property_type_category: s(ad.propertyTypeCategory, 32),
    property_type_subcategory: s(ad.propertyTypeSubcategory, 48),

    address_street: s(address.street, 256),
    address_house_number: s(address.houseNumber, 16),
    address_postal_code: s(address.postalCode, 16),
    address_city: s(address.city, 128),
    address_state: s(address.state, 128),
    address_country: s(address.country, 8),
    address_display_name: s(address.displayName, 512),

    price_amount: f?.price?.amount ?? -1,
    price_currency: s(f?.price?.currency ?? "", 8),
    price_on_request: f?.price?.amount == null,
    available_from: s(f?.availableFrom, 64),
    living_space: f?.livingSpace?.value ?? -1,
    usable_area: f?.usableArea?.value ?? -1,
    land_area: f?.landArea?.value ?? -1,
    floor: f?.floor ?? -1,
    number_of_floors: f?.numberOfFloors ?? -1,
    rooms: f?.rooms ?? -1,
    bedrooms: -1,
    bathrooms: -1,
    year_of_construction: f?.yearOfConstruction ?? -1,
    renovation_year: renovationYear(f?.latestRenovations),
    condition: s(f?.condition, 64),

    rent_net: rent.netRent?.amount ?? -1,
    rent_additional: rent.additionalCosts?.amount ?? -1,
    rent_gross: rent.grossRent?.amount ?? -1,

    agency_name: s(agency.name, 256),
    agency_phone: s(agency.phoneNumber, 64),
    agency_email: s(agency.emailAddress, 128),
    agent_name: s(agent.name, 128),
    agent_phone: s(agent.phoneNumber, 64),
    agent_email: s(agent.emailAddress, 128),

    features: featuresFromEquipment(ad.equipment),
    nearby_amenities: [],

    source_domain: sourceDomain(ad.sourceUrl),
    search_query: "",
    scraped_at: scrapedAt,
    // Embedding-input hashes for next-run skip-if-unchanged. _source-only fields.
    ...(textHash ? { text_hash: textHash } : {}),
    ...(imageHash ? { image_hash: imageHash } : {}),
    location: geo ? pointWkt(geo.lat, geo.lon) : null,
    // Nested per-chunk text vectors (the text analogue of nested per-photo image
    // vectors). Omit the field entirely when there are no chunks; per chunk, omit
    // chunk_vector when the text encoder was off (blind chunk) — an empty
    // knn_vector is an invalid write; keeping the text still indexes it lexically.
    ...(chunks.length
      ? {
          page_content_chunks: chunks.map((c) =>
            c.chunk_vector && c.chunk_vector.length
              ? { text: s(c.text, 4000), chunk_vector: c.chunk_vector }
              : { text: s(c.text, 4000) }
          )
        }
      : {}),
    // Best-effort: omit the sparse field entirely when unavailable rather than
    // writing an empty/zero vector. Stores treat its absence as "no sparse leg".
    ...(sparse ? { sparse_vector: sparse } : {}),
    images
  };
}
