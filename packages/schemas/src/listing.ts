/**
 * The lightweight property listing model: what one LLM call extracts from a
 * listing page (id/source added in code). Deliberately NOT a projection of the
 * canonical `propertyAdSchema` — that schema is strict, CHF-only and shaped for
 * the 10-facet page graph, while a listing needs a handful of tolerant fields
 * that one structured-output call can fill for listings in any market/currency.
 *
 * NOTE: `apps/web/src/features/search/types.ts` mirrors these types for the
 * frontend (the apps share no import paths). Keep both in sync.
 */
import { z } from "zod";
import { createHash } from "node:crypto";

import { canonicalizeUrl } from "./url.js";

/** The fields the LLM extracts from a listing page (id/source added in code). */
export const extractedListingSchema = z.object({
  title: z.string().describe("Listing title"),
  price: z
    .number()
    .nonnegative()
    .nullable()
    .describe("Price amount; null when unknown or on request"),
  currency: z
    .string()
    .min(3)
    .max(3)
    .nullable()
    .describe("ISO 4217 currency code, e.g. CHF, EUR"),
  priceOnRequest: z
    .boolean()
    .default(false)
    .describe("True when the price is only available on request"),
  listingType: z.enum(["rent", "buy"]).nullable(),
  propertyType: z
    .string()
    .nullable()
    .describe("e.g. apartment, house, villa, penthouse, studio"),
  city: z.string().nullable(),
  address: z
    .string()
    .nullable()
    .describe("Street address or display location as shown on the page"),
  bedrooms: z.number().nonnegative().nullable(),
  rooms: z
    .number()
    .nonnegative()
    .nullable()
    .describe("Total rooms (Swiss half-rooms allowed, e.g. 3.5)"),
  bathrooms: z.number().nonnegative().nullable(),
  livingArea: z.number().nonnegative().nullable().describe("Living area in m²"),
  lotArea: z.number().nonnegative().nullable().describe("Lot/land area in m²"),
  renovationYear: z
    .number()
    .int()
    .min(1000)
    .max(2100)
    .nullable()
    .default(null)
    .describe("Year of the most recent renovation, only when explicitly stated"),
  // OpenAI strict structured outputs require nullable over bare defaults;
  // the listing tool normalizes null back to []/"" after parsing.
  imageUrls: z
    .array(z.string())
    .nullable()
    .default([])
    .describe("Absolute URLs of listing photos, best first"),
  description: z
    .string()
    .max(400)
    .nullable()
    .default("")
    .describe("Short plain-text summary of the listing (max 400 chars)"),
  agency: z.string().nullable().describe("Listing agency or agent name"),
});

export type ExtractedListing = z.infer<typeof extractedListingSchema>;

export const propertyListingSchema = extractedListingSchema.extend({
  id: z.string(),
  sourceUrl: z.string(),
  sourceDomain: z.string(),
  // Listings are normalized: null collections from the LLM become empty values.
  imageUrls: z.array(z.string()).default([]),
  description: z.string().max(400).default(""),
});

export type PropertyListing = z.infer<typeof propertyListingSchema>;

/**
 * Stable listing id: sha256 of the CANONICAL source URL, so re-scrapes upsert
 * cleanly even when the same listing is reached with a different host case,
 * trailing slash or query string (see {@link canonicalizeUrl}). Falls back to
 * the raw URL when it can't be parsed.
 */
export function listingIdForUrl(url: string): string {
  return createHash("sha256")
    .update(canonicalizeUrl(url) ?? url)
    .digest("hex");
}
