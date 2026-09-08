// Ported from engine `search/domains/vehicles.ts`. Self-contained vehicles ingest
// descriptor: index mapping, document builder, stable id and embed-text all live
// here. The engine's `vehicleRowToListing` (read/hydration path) is intentionally
// NOT ported. Renamed hooks (`geoHint`->`locationHint`, `toRow`->`toDocument`)
// and an `indexMapping()` method returning the create-index body.
import { type LatLon, pointWkt } from "../geo/index.js";

import { Domain } from "../schemas/domain.js";
import type { ImageStruct, SparseVector } from "./ad-to-row.js";
import { MAX_TEXT_CHUNKS, splitMarkdown } from "./chunk.js";
import { listingId } from "./listing-id.js";
import type { DomainDescriptor, DomainIngest, IngestContext, IngestOptions } from "./types.js";
import { canonicalizeUrl } from "./url.js";
import { type VehicleAd, vehicleAdSchema } from "./vehicle-ad.js";

/**
 * Vehicles domain — the second vertical, proving ingest is domain-generic. Its
 * index schema mirrors the property-ad shape (dense + sparse + nested image legs)
 * but with vehicle fields, so the same hybrid-search + rerank pipeline runs
 * unchanged against `vehicle_ads`.
 */
export const VEHICLE_AD_INDEX = "vehicle_ads";

const DENSE_DIM = Number(process.env.TEXT_EMBEDDING_DIM) || 1024;
// Honors the deployment's IMAGE_EMBEDDING_DIM (dev CLIP 512 / prod Jina 2048);
// was hardcoded 512, which broke the prod 2048 profile.
const IMAGE_DIM = Number(process.env.IMAGE_EMBEDDING_DIM) || 512;
const MAX_QUERY_WINDOW = 16384;

const knnVector = (dimension: number) => ({
  type: "knn_vector" as const,
  dimension,
  method: {
    name: "hnsw",
    engine: "faiss",
    space_type: "cosinesimil",
    parameters: { m: 16, ef_construction: 100 }
  }
});

export function vehicleAdIndexMapping(): Record<string, unknown> {
  return {
    properties: {
      id: { type: "keyword" },
      title: { type: "keyword" },
      description: { type: "keyword" },
      make: { type: "keyword" },
      model: { type: "keyword" },
      variant: { type: "keyword" },
      body_type: { type: "keyword" },
      year: { type: "long" },
      mileage_km: { type: "double" },
      power_hp: { type: "double" },
      transmission: { type: "keyword" },
      fuel_type: { type: "keyword" },

      // classification / identity
      listing_type: { type: "keyword" }, // buy | lease | rent
      condition: { type: "keyword" }, // new | used | demo | certified
      seller_type: { type: "keyword" }, // private | dealer
      vin: { type: "keyword" },
      reference_number: { type: "keyword" },

      // powertrain
      drivetrain: { type: "keyword" }, // fwd | rwd | awd | 4x4
      power_kw: { type: "double" },
      engine_displacement_cc: { type: "long" },
      cylinders: { type: "long" },
      torque_nm: { type: "double" },
      gears: { type: "long" },

      // EV / hybrid
      battery_kwh: { type: "double" },
      electric_range_km: { type: "double" },

      // body / interior
      doors: { type: "long" },
      seats: { type: "long" },
      color: { type: "keyword" },
      interior_color: { type: "keyword" },
      interior_material: { type: "keyword" },
      finish: { type: "keyword" }, // metallic | matte | …

      // history / condition / emissions
      first_registration: { type: "keyword" },
      previous_owners: { type: "long" },
      service_book: { type: "boolean" },
      accident_free: { type: "boolean" },
      co2_gpkm: { type: "double" },
      emission_class: { type: "keyword" }, // euro6d | …
      fuel_consumption_lp100: { type: "double" },
      electric_consumption_kwhp100: { type: "double" },

      // pricing / leasing
      price_amount: { type: "double" },
      price_currency: { type: "keyword" },
      price_net: { type: "double" },
      vat_deductible: { type: "boolean" },
      monthly_rate: { type: "double" },
      down_payment: { type: "double" },
      contract_months: { type: "long" },
      annual_mileage_limit_km: { type: "long" },

      // location (mirrors real estate)
      address_city: { type: "keyword" },
      address_state: { type: "keyword" },
      address_country: { type: "keyword" },
      address_display_name: { type: "keyword" },
      location: { type: "geo_point" },

      // seller (dealer/agency + individual) — stored, not indexed
      agent: { type: "object", enabled: false },

      // equipment
      features: { type: "object", enabled: false }, // full equipment map (not indexed)
      feature_keywords: { type: "keyword" }, // filterable equipment slugs

      source_url: { type: "keyword" },
      source_domain: { type: "keyword" },
      search_query: { type: "keyword" },
      published_at: { type: "keyword" },
      updated_at: { type: "keyword" },
      scraped_at: { type: "long" },

      page_content_chunks: {
        type: "nested",
        max_capacity: MAX_TEXT_CHUNKS,
        properties: {
          text: { type: "text", index: false },
          chunk_vector: knnVector(DENSE_DIM)
        }
      },
      sparse_vector: { type: "rank_features" },
      images: {
        type: "nested",
        properties: {
          url: { type: "keyword" },
          image_vector: knnVector(IMAGE_DIM)
        }
      }
    }
  };
}

export function vehicleAdIndexSettings(): Record<string, unknown> {
  return {
    index: {
      knn: true,
      number_of_shards: 1,
      number_of_replicas: 0,
      max_result_window: MAX_QUERY_WINDOW
    }
  };
}

export function vehicleAdIndexBody(): Record<string, unknown> {
  return { settings: vehicleAdIndexSettings(), mappings: vehicleAdIndexMapping() };
}

// --- Ingest: scraped VehicleAd → `vehicle_ads` document (mirrors property `ad-to-row`) ---

const MAX_TEXT_CHARS = 8000;
const s = (v: unknown, max: number): string => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);
/** Lowercased keyword (enums are keyword-typed and matched via lowercased `term`). */
const kw = (v: unknown, max: number): string => s(v, max).toLowerCase();
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const b = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

function vehicleImageUrls(ad: VehicleAd): string[] {
  return (Array.isArray(ad.images) ? ad.images : [])
    .map((img) => (typeof img === "string" ? img : img?.url))
    .filter((u): u is string => typeof u === "string" && u.length > 0);
}

function vehicleFeatureKeywords(ad: VehicleAd): string[] {
  const explicit = Array.isArray(ad.featureKeywords) ? ad.featureKeywords : [];
  const fromMap =
    ad.features && typeof ad.features === "object"
      ? Object.entries(ad.features as Record<string, unknown>)
          .filter(([, value]) => value === true || (typeof value === "string" && value.trim()))
          .map(([key]) => key)
      : [];
  return [...new Set([...explicit, ...fromMap].map((f) => f.trim().toLowerCase()).filter(Boolean))];
}

function vehicleSourceDomain(url?: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.slice(0, 250);
  } catch {
    return "";
  }
}

/** Stable id: canonical source URL, else VIN / reference / make+model+year. */
export function vehicleAdId(ad: VehicleAd): string {
  const raw = ad.sourceUrl?.trim();
  const seed =
    (raw && (canonicalizeUrl(raw) ?? raw)) ||
    ad.vin?.trim() ||
    `${ad.referenceNumber ?? ""}:${ad.make ?? ""}:${ad.model ?? ""}:${ad.year ?? ""}`;
  return listingId(seed);
}

/** The text embedded (dense + sparse) for a car — identity, specs, colour, location, equipment. */
export function vehicleAdText(ad: VehicleAd): string {
  const address = ad.address ?? {};
  const location =
    s(address.displayName, 256) ||
    [address.city, address.state, address.country]
      .map((v) => s(v, 64))
      .filter(Boolean)
      .join(", ");

  const specs: string[] = [];
  if (ad.year != null) specs.push(`${ad.year}`);
  if (ad.mileageKm != null) specs.push(`${ad.mileageKm} km`);
  if (ad.fuelType) specs.push(s(ad.fuelType, 32));
  if (ad.transmission) specs.push(s(ad.transmission, 32));
  if (ad.drivetrain) specs.push(s(ad.drivetrain, 16));
  if (ad.powerHp != null) specs.push(`${ad.powerHp} hp`);
  if (ad.bodyType) specs.push(s(ad.bodyType, 32));
  if (ad.color) specs.push(s(ad.color, 32));
  if (ad.condition) specs.push(s(ad.condition, 16));
  if (ad.price?.amount != null) specs.push(`${ad.price.amount} ${s(ad.price.currency ?? "", 8)}`.trim());

  return [
    [s(ad.make, 64), s(ad.model, 64), s(ad.variant, 64)].filter(Boolean).join(" "),
    s(ad.title, 200),
    location,
    specs.join(", "),
    vehicleFeatureKeywords(ad).join(", "),
    s(ad.description, 4000)
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TEXT_CHARS);
}

/** Dense-chunk source for a car: full `pageContent` when selected, else the composite. */
export function vehicleAdDenseSource(ad: VehicleAd, opts?: IngestOptions): string {
  if (opts?.textEmbeddingSource === "pageContent") {
    const page = typeof ad.pageContent === "string" ? ad.pageContent.trim() : "";
    if (page) return page;
  }
  return vehicleAdText(ad);
}

/** Markdown-aware dense chunks for a car, capped by `opts.maxTextChunks`. */
export function vehicleAdTextChunks(ad: VehicleAd, opts?: IngestOptions): Promise<string[]> {
  return splitMarkdown(vehicleAdDenseSource(ad, opts), opts?.maxTextChunks);
}

/** Map a validated VehicleAd + enrichment into the `vehicle_ads` `_source` document. */
export function vehicleAdToRow(ad: VehicleAd, ctx: IngestContext): Record<string, unknown> {
  const { geo, chunks, sparse, images, now } = ctx;
  const address = ad.address ?? {};
  const price = ad.price ?? {};

  return {
    id: vehicleAdId(ad),
    title: s(ad.title, 500),
    description: s(ad.description, 4000),
    make: kw(ad.make, 64),
    model: kw(ad.model, 64),
    variant: s(ad.variant, 128),
    body_type: kw(ad.bodyType, 32),
    year: n(ad.year),
    mileage_km: n(ad.mileageKm),
    power_hp: n(ad.powerHp),
    transmission: kw(ad.transmission, 16),
    fuel_type: kw(ad.fuelType, 16),

    listing_type: kw(ad.listingType, 8),
    condition: kw(ad.condition, 16),
    seller_type: kw(ad.sellerType, 16),
    vin: s(ad.vin, 32),
    reference_number: s(ad.referenceNumber, 128),

    drivetrain: kw(ad.drivetrain, 8),
    power_kw: n(ad.powerKw),
    engine_displacement_cc: n(ad.engineDisplacementCc),
    cylinders: n(ad.cylinders),
    torque_nm: n(ad.torqueNm),
    gears: n(ad.gears),

    battery_kwh: n(ad.batteryKwh),
    electric_range_km: n(ad.electricRangeKm),

    doors: n(ad.doors),
    seats: n(ad.seats),
    color: kw(ad.color, 32),
    interior_color: kw(ad.interiorColor, 32),
    interior_material: kw(ad.interiorMaterial, 32),
    finish: kw(ad.finish, 32),

    first_registration: s(ad.firstRegistration, 32),
    previous_owners: n(ad.previousOwners),
    service_book: b(ad.serviceBook),
    accident_free: b(ad.accidentFree),
    co2_gpkm: n(ad.co2Gpkm),
    emission_class: kw(ad.emissionClass, 32),
    fuel_consumption_lp100: n(ad.fuelConsumptionLp100),
    electric_consumption_kwhp100: n(ad.electricConsumptionKwhp100),

    price_amount: n(price.amount),
    price_currency: s(price.currency, 8),
    price_net: n(price.net),
    vat_deductible: b(price.vatDeductible),
    monthly_rate: n(price.monthlyRate),
    down_payment: n(price.downPayment),
    contract_months: n(price.contractMonths),
    annual_mileage_limit_km: n(price.annualMileageLimitKm),

    address_city: kw(address.city, 128),
    address_state: kw(address.state, 128),
    address_country: kw(address.country, 8),
    address_display_name: s(address.displayName, 512),
    location: geo ? pointWkt(geo.lat, geo.lon) : null,

    agent: ad.agent ?? null,

    features: ad.features ?? {},
    feature_keywords: vehicleFeatureKeywords(ad),

    source_url: s(ad.sourceUrl, 1000),
    source_domain: vehicleSourceDomain(ad.sourceUrl),
    search_query: s(ad.searchQuery, 500),
    published_at: s(ad.publishedAt, 64),
    updated_at: s(ad.updatedAt, 64),
    scraped_at: now,

    // Nested per-chunk text vectors (text analogue of nested image vectors).
    // Per chunk, omit chunk_vector when the encoder was off (blind chunk); omit
    // the whole field when there are no chunks.
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
    ...(sparse ? { sparse_vector: sparse as SparseVector } : {}),
    images: images as ImageStruct[]
  };
}

const ingest: DomainIngest = {
  parse: (raw) => {
    const result = vehicleAdSchema.safeParse(raw);
    return result.success ? (result.data as Record<string, unknown>) : null;
  },
  id: (ad) => vehicleAdId(ad as VehicleAd),
  text: (ad) => vehicleAdText(ad as VehicleAd),
  textChunks: (ad, opts) => vehicleAdTextChunks(ad as VehicleAd, opts),
  imageUrls: (ad) => vehicleImageUrls(ad as VehicleAd),
  locationHint: (ad) => {
    const address = (ad as VehicleAd).address ?? {};
    const coords = address.coordinates;
    if (coords && typeof coords.lat === "number" && typeof coords.lon === "number") {
      return { coords: { lat: coords.lat, lon: coords.lon } as LatLon, address: null };
    }
    if (!address.street && !address.city && !address.postalCode && !address.displayName) {
      return { coords: null, address: null };
    }
    return {
      coords: null,
      address: {
        street: address.street,
        houseNumber: address.houseNumber,
        city: address.city,
        state: address.state,
        country: address.country,
        postalCode: address.postalCode,
        displayName: address.displayName
      }
    };
  },
  toDocument: (ad, ctx) => vehicleAdToRow(ad as VehicleAd, ctx),
  indexMapping: vehicleAdIndexBody
};

export const vehiclesDomain: DomainDescriptor = {
  id: Domain.Vehicles,
  indexName: VEHICLE_AD_INDEX,
  ingest
};
