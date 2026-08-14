export interface GeoResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface GeoFetchInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface GeoFetcher {
  fetch(url: string, init?: GeoFetchInit): Promise<GeoResponse>;
}

const nativeFetcher: GeoFetcher = {
  fetch: (url, init) => globalThis.fetch(url, init as RequestInit) as unknown as Promise<GeoResponse>
};

let fetcher: GeoFetcher = nativeFetcher;

export function setGeoFetcher(next: GeoFetcher): void {
  fetcher = next;
}

function nominatimBase(): string {
  return (process.env.OPENSTREETMAPS_ENDPOINT ?? "https://nominatim.openstreetmap.org/").replace(/\/$/, "");
}

function overpassEndpoint(): string {
  return process.env.OPENSTREETMAPS_OVERPASS_API_ENDPOINT ?? "https://overpass-api.de/api/interpreter";
}

function userAgent(): string {
  return process.env.SCRAPER_USER_AGENT || "local-llm/1.0";
}

const RETRYABLE_HTTP = /HTTP (408|429|5\d\d)\b/;

async function withRetries<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseDelayMs = 1000 }: { attempts?: number; baseDelayMs?: number } = {}
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const transient = RETRYABLE_HTTP.test(message) || /fetch failed|network|timeout|aborted/i.test(message);
      if (!transient || attempt === attempts) throw error;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

async function getJson<T>(url: string, init?: { method?: string; body?: string }): Promise<T> {
  const res = await fetcher.fetch(url, {
    method: init?.method ?? "GET",
    ...(init?.body ? { body: init.body } : {}),
    headers: {
      "User-Agent": userAgent(),
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
    }
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  }
  return (await res.json()) as T;
}

// --- forward geocoding ------------------------------------------------------

export interface GeocodeResult {
  lat: number;
  lon: number;
  displayName: string;
}

export interface LatLon {
  lat: number;
  lon: number;
}

interface NominatimPlace {
  lat: string;
  lon: string;
  display_name: string;
}

type NominatimSearchParams = {
  q?: string;
  street?: string;
  city?: string;
  state?: string;
  country?: string;
  postalcode?: string;
  countryCodes?: string[];
};

async function nominatimSearchRaw(params: NominatimSearchParams, limit: number): Promise<GeocodeResult[]> {
  const search = new URLSearchParams({
    format: "jsonv2",
    limit: String(Math.min(Math.max(limit, 1), 10)),
    addressdetails: "0"
  });
  for (const key of ["q", "street", "city", "state", "country", "postalcode"] as const) {
    const value = params[key]?.trim();
    if (value) search.set(key, value);
  }
  if (params.countryCodes?.length) {
    search.set("countrycodes", params.countryCodes.join(",").toLowerCase());
  }
  const places = await withRetries(() => getJson<NominatimPlace[]>(`${nominatimBase()}/search?${search}`));
  return places.map((p) => ({
    lat: Number(p.lat),
    lon: Number(p.lon),
    displayName: p.display_name
  }));
}

export async function nominatimSearch(query: string, limit: number): Promise<GeocodeResult[]> {
  return nominatimSearchRaw({ q: query }, limit);
}

export interface GeocodableAddress {
  query?: string | null;
  street?: string | null;
  houseNumber?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  postalCode?: string | null;
  displayName?: string | null;
}

export interface GeocodeAttempt {
  label: string;
  params: NominatimSearchParams;
}

export function* geocodeAttempts(address: GeocodableAddress): Generator<GeocodeAttempt> {
  const street = [address.street?.trim(), address.houseNumber?.trim()].filter(Boolean).join(" ");
  const hasStructured = Boolean(street || address.city?.trim() || address.postalCode?.trim());

  if (hasStructured) {
    yield {
      label: "structured",
      params: {
        street: street || undefined,
        city: address.city?.trim() || undefined,
        state: address.state?.trim() || undefined,
        country: address.country?.trim() || undefined,
        postalcode: address.postalCode?.trim() || undefined
      }
    };
  }

  const query = address.query?.trim() || address.displayName?.trim();
  if (query) yield { label: "freeform-query", params: { q: query } };

  if (street) {
    if (street !== query) yield { label: "freeform-street", params: { q: street } };
    const head = street.split(",")[0]?.trim();
    if (head && head !== street) {
      yield { label: "freeform-street-head", params: { q: head } };
    }
  }

  const composed = [address.postalCode, address.city, address.country]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(", ");
  if (composed && composed !== query) {
    yield { label: "freeform-composed", params: { q: composed } };
  }
}

export async function geocodeWithFallbacks(
  address: GeocodableAddress,
  limit: number,
  onAttempt?: (attempt: GeocodeAttempt) => void
): Promise<{ results: GeocodeResult[]; strategy: string }> {
  const countryCodes = address.country?.trim() ? [address.country.trim()] : undefined;

  let lastLabel = "none";
  for (const attempt of geocodeAttempts(address)) {
    onAttempt?.(attempt);
    const results = await nominatimSearchRaw({ ...attempt.params, countryCodes }, limit);
    if (results.length > 0) return { results, strategy: attempt.label };
    lastLabel = attempt.label;
  }
  return { results: [], strategy: lastLabel };
}

const CACHE_MAX = 500;
const cache = new Map<string, LatLon | null>();

function cacheKey(a: GeocodableAddress): string {
  return JSON.stringify([a.street, a.houseNumber, a.postalCode, a.city, a.state, a.country, a.displayName, a.query]);
}

export async function geocodeAddress(address: GeocodableAddress): Promise<LatLon | null> {
  const key = cacheKey(address);
  if (cache.has(key)) {
    const hit = cache.get(key) ?? null;
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  let result: LatLon | null = null;
  try {
    const { results } = await geocodeWithFallbacks(address, 1);
    const best = results[0];
    if (best && Number.isFinite(best.lat) && Number.isFinite(best.lon)) {
      result = { lat: best.lat, lon: best.lon };
    }
  } catch {
    result = null;
  }

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, result);
  return result;
}

// --- reverse geocoding ------------------------------------------------------

export interface ReverseGeocodeResult {
  city: string | null;
  country: string | null;
  displayName: string;
}

interface NominatimReversePlace {
  display_name?: string;
  address?: {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    country?: string;
  };
  error?: string;
}

export async function nominatimReverse(lat: number, lon: number): Promise<ReverseGeocodeResult> {
  const url =
    `${nominatimBase()}/reverse?` +
    new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
      format: "jsonv2"
    });
  const place = await withRetries(() => getJson<NominatimReversePlace>(url));
  if (place.error) throw new Error(place.error);
  const address = place.address ?? {};
  return {
    city: address.city ?? address.town ?? address.village ?? address.municipality ?? null,
    country: address.country ?? null,
    displayName: place.display_name ?? ""
  };
}

// --- Overpass nearby amenities ----------------------------------------------

export const AMENITY_VALUES = [
  "school",
  "kindergarten",
  "university",
  "college",
  "library",
  "cafe",
  "restaurant",
  "fast_food",
  "bar",
  "pub",
  "pharmacy",
  "doctors",
  "hospital",
  "clinic",
  "dentist",
  "veterinary",
  "bus_station",
  "taxi",
  "fuel",
  "charging_station",
  "bank",
  "atm",
  "post_office",
  "police",
  "fire_station",
  "marketplace",
  "parking",
  "bicycle_parking",
  "bicycle_rental",
  "place_of_worship",
  "theatre",
  "cinema",
  "community_centre",
  "sports_centre",
  "swimming_pool",
  "playground",
  "park",
  "supermarket",
  "parcel_locker"
] as const;

export type AmenityValue = (typeof AMENITY_VALUES)[number];

const AMENITY_TAG_OVERRIDES: Partial<Record<AmenityValue, [key: string, value: string]>> = {
  supermarket: ["shop", "supermarket"],
  park: ["leisure", "park"],
  playground: ["leisure", "playground"],
  sports_centre: ["leisure", "sports_centre"],
  swimming_pool: ["leisure", "swimming_pool"]
};

export interface GeoNearbyAmenity {
  name: string;
  type: string;
  lat: number;
  lon: number;
}

interface OverpassElement {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export async function overpassNearby(options: {
  lat: number;
  lon: number;
  radius: number;
  amenities: AmenityValue[];
  limit: number;
}): Promise<GeoNearbyAmenity[]> {
  const { lat, lon, radius, amenities, limit } = options;
  const around = `(around:${Math.min(Math.max(radius, 50), 5000)},${lat},${lon})`;

  const clauses = amenities
    .flatMap((slug) => {
      const [key, value] = AMENITY_TAG_OVERRIDES[slug] ?? ["amenity", slug];
      const selector = `["${key}"="${value}"]`;
      return [`node${selector}${around};`, `way${selector}${around};`];
    })
    .join("\n");

  const query = `[out:json][timeout:25];\n(\n${clauses}\n);\nout center ${Math.min(limit * amenities.length * 2, 200)};`;

  const data = await withRetries(() =>
    getJson<{ elements: OverpassElement[] }>(overpassEndpoint(), {
      method: "POST",
      body: `data=${encodeURIComponent(query)}`
    })
  );

  const perType = new Map<string, number>();
  const results: GeoNearbyAmenity[] = [];
  for (const el of data.elements) {
    const elLat = el.lat ?? el.center?.lat;
    const elLon = el.lon ?? el.center?.lon;
    if (elLat == null || elLon == null) continue;
    const tags = el.tags ?? {};
    const type = tags.amenity ?? tags.shop ?? tags.leisure ?? "unknown";
    const seen = perType.get(type) ?? 0;
    if (seen >= limit) continue;
    perType.set(type, seen + 1);
    results.push({
      name: tags.name || tags["name:de"] || tags.operator || "Unnamed",
      type,
      lat: elLat,
      lon: elLon
    });
  }
  return results;
}

export function pointWkt(lat: number, lon: number): string {
  return `POINT (${lon} ${lat})`;
}
