// Ported from engine `search/shared/domain/text.ts`. Builds the text a property
// ad is dense/sparse-embedded from. The engine's `listingText(PropertyListing)`
// helper is intentionally NOT ported — it belongs to the read/hydration path, not
// the ingest contract, and would pull in the listing schema needlessly.
import { splitMarkdown } from "./chunk.js";
import type { PropertyAd } from "./property-ad.js";
import type { IngestOptions } from "./types.js";

export const MAX_TEXT_CHARS = 8000;

const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));

export function propertyAdText(ad: PropertyAd): string {
  const address = ad.address ?? {};
  const addressLine =
    clean(address.displayName) ||
    [address.street, address.postalCode, address.city, address.state, address.country]
      .map(clean)
      .filter(Boolean)
      .join(", ");

  const f = ad.fundamentals;
  const facts: string[] = [];
  if (f?.rooms != null) facts.push(`${f.rooms} rooms`);
  if (f?.livingSpace?.value != null) facts.push(`${f.livingSpace.value} m² living space`);
  if (f?.landArea?.value != null) facts.push(`${f.landArea.value} m² land`);
  if (f?.price?.amount != null) facts.push(`${f.price.amount} ${f.price.currency ?? "CHF"}`);
  if (f?.yearOfConstruction != null) facts.push(`built ${f.yearOfConstruction}`);
  if (f?.condition) facts.push(String(f.condition));

  const equipmentKeywords: string[] = [];
  const equipment = (ad.equipment ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(equipment)) {
    if (value === true) equipmentKeywords.push(key);
    else if (typeof value === "string" && value.trim()) equipmentKeywords.push(`${key}: ${value.trim()}`);
    else if (typeof value === "number") equipmentKeywords.push(`${key}: ${String(value)}`);
    else if (value && typeof value === "object" && "value" in (value as object)) {
      const v = (value as { value?: unknown }).value;
      if (v != null) equipmentKeywords.push(`${key}: ${String(v)}`);
    }
  }

  return [
    clean(ad.name),
    clean(ad.propertyTypeSubcategory) || clean(ad.propertyTypeCategory),
    addressLine,
    clean(ad.description),
    facts.join(", "),
    equipmentKeywords.join(", "),
    clean(ad.additionalInformation),
    Array.isArray(ad.tags) ? ad.tags.map(clean).filter(Boolean).join(", ") : ""
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TEXT_CHARS);
}

/**
 * The text the DENSE chunk vectors are built from: the full cleaned `pageContent`
 * when the pipeline selects `pageContent` (and it is non-empty), else the same
 * description composite the sparse leg uses. No MAX_TEXT_CHARS cap here — chunking
 * bounds the size instead.
 */
export function propertyAdDenseSource(ad: PropertyAd, opts?: IngestOptions): string {
  if (opts?.textEmbeddingSource === "pageContent") {
    const page = clean((ad as { pageContent?: unknown }).pageContent);
    if (page) return page;
  }
  return propertyAdText(ad);
}

/** Markdown-aware dense chunks for a property ad, capped by `opts.maxTextChunks`. */
export function propertyAdTextChunks(ad: PropertyAd, opts?: IngestOptions): Promise<string[]> {
  return splitMarkdown(propertyAdDenseSource(ad, opts), opts?.maxTextChunks);
}
