/**
 * Domain ids + result markers. Values MUST match the engine/agents
 * (`Domain`/`ResultMarker`) — they are the cross-process wire contract. The
 * URL/assistant slug is the hyphenated form (`real-estate`).
 */
export enum Domain {
  RealEstate = "real_estate",
  Vehicles = "vehicles",
}

export enum ResultMarker {
  RealEstate = "real_estate_property_ads",
  Vehicles = "vehicle_ads",
}

/**
 * Map a result-marker `type` on the assistant message to its domain. Returns
 * undefined for a non-marker content block.
 */
const MARKER_TO_DOMAIN: Record<string, Domain> = {
  [ResultMarker.RealEstate]: Domain.RealEstate,
  [ResultMarker.Vehicles]: Domain.Vehicles,
};

export function domainOf(markerType: string | undefined): Domain | undefined {
  return markerType ? MARKER_TO_DOMAIN[markerType] : undefined;
}

/** Every marker `type` string we treat as a result marker (for scanning messages). */
export const RESULT_MARKER_TYPES: ReadonlySet<string> = new Set(Object.keys(MARKER_TO_DOMAIN));

/** Narrow a raw domain value (e.g. from a `results` event) to the Domain enum. */
export function toDomain(value: string | undefined): Domain | undefined {
  return value === Domain.RealEstate || value === Domain.Vehicles ? (value as Domain) : undefined;
}

/** real_estate → real-estate (URL segment + `${slug}:listing-chat` assistant id). */
export const slugOf = (d: Domain): string => d.replace(/_/g, "-");

/** real-estate → real_estate (parse a URL `[domain]` segment back to the enum). */
export function domainFromSlug(slug: string): Domain | undefined {
  const value = slug.replace(/-/g, "_");
  return value === Domain.RealEstate || value === Domain.Vehicles ? (value as Domain) : undefined;
}
