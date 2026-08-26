/**
 * The canonical property-listing shape shared across TypeScript clients (web +
 * mobile). The engine/agents are the source of truth for the wire values; this
 * mirrors them for typed consumers. Pure types — no browser/Node deps, RN-safe.
 */
export interface PropertyListing {
  title: string;
  price: number | null;
  currency: string | null;
  priceOnRequest: boolean;
  listingType: "rent" | "buy" | null;
  propertyType: string | null;
  city: string | null;
  address: string | null;
  bedrooms: number | null;
  rooms: number | null;
  bathrooms: number | null;
  livingArea: number | null;
  lotArea: number | null;
  renovationYear: number | null;
  imageUrls: string[];
  description: string;
  agency: string | null;
  id: string;
  sourceUrl: string;
  sourceDomain: string;
}
