// Ported from engine `search/domains/real-estate.ts`. Real-estate ingest
// descriptor — reuses the property-ad document schema. Renamed hooks
// (`geoHint`->`locationHint`, `toRow`->`toDocument`) and an `indexMapping()`
// method returning the same body the engine descriptor's `indexBody()` did.
import { Domain } from "../schemas/domain.js";

import { adId, propertyAdToRow } from "./ad-to-row.js";
import { PROPERTY_AD_INDEX, propertyAdIndexBody } from "./index-schema.js";
import type { PropertyAd } from "./property-ad.js";
import { propertyAdSchema } from "./property-ad.js";
import { propertyAdText, propertyAdTextChunks } from "./text.js";
import type { DomainDescriptor, DomainIngest } from "./types.js";

/** Ingest mappers for the property vertical — the original single-domain flow, now behind the seam. */
const ingest: DomainIngest = {
  parse: (raw) => {
    const result = propertyAdSchema.safeParse(raw);
    return result.success ? (result.data as unknown as Record<string, unknown>) : null;
  },
  id: (ad) => adId(ad as unknown as PropertyAd),
  text: (ad) => propertyAdText(ad as unknown as PropertyAd),
  textChunks: (ad, opts) => propertyAdTextChunks(ad as unknown as PropertyAd, opts),
  imageUrls: (ad) =>
    (Array.isArray((ad as PropertyAd).images) ? (ad as PropertyAd).images! : [])
      .map((img) => img?.url)
      .filter((u): u is string => typeof u === "string"),
  locationHint: (ad) => {
    const address = (ad as PropertyAd).address ?? {};
    const coords = address.coordinates;
    if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)) {
      return { coords: { lat: coords.lat as number, lon: coords.lon as number }, address: null };
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
  toDocument: (ad, ctx) =>
    propertyAdToRow(
      ad as unknown as PropertyAd,
      ctx.geo,
      ctx.chunks,
      ctx.sparse,
      ctx.images,
      ctx.now,
      ctx.textHash,
      ctx.imageHash
    ),
  indexMapping: propertyAdIndexBody
};

/** Real-estate domain — the original vertical; reuses the property-ad index schema. */
export const realEstateDomain: DomainDescriptor = {
  id: Domain.RealEstate,
  indexName: PROPERTY_AD_INDEX,
  ingest
};
