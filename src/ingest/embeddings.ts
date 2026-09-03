// Ingest-time embedding clients + geocoding helper.
//
// Ported from the engine's `embeddings/text-embedding.service.ts` and
// `embeddings/image-embedding.service.ts`, but STRIPPED of the engine's cache /
// DI / awilix wrappers (these are plain global-`fetch` clients) and with a
// DIFFERENT failure contract for the ingestion-pipeline:
//   - a NO-OP client (zero I/O, null vectors) when disabled or url-less;
//   - NEVER throws — an unreachable/erroring service yields `null` vectors after
//     a bounded low retry. Dense is NOT required (the engine threw on dense
//     failure; here it degrades to null like everything else);
//   - sparse stays best-effort (`null` when unsupported — never fabricated zeros);
//   - the image client returns `null` per-URL for a photo that fails and all-null
//     when the whole call fails.
import { type GeocodableAddress, type LatLon, geocodeAddress } from "../geo/index.js";

import type { SparseVector } from "./ad-to-row.js";
import { CLIP_DIM, DENSE_DIM } from "./index-schema.js";
import type { LocationHint } from "./types.js";

/** Long timeout — ingest batches can be large; matches the engine's window. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Bounded low retry: one extra attempt on a transport error / 5xx. */
const RETRY_ATTEMPTS = 2;

/**
 * OpenAI embeddings envelope. The dense route puts a float array in `embedding`;
 * the sparse route puts a `{vocab_id: weight}` map there.
 */
interface EmbeddingsResponse {
  data?: { embedding?: unknown }[];
}

export interface EmbeddingClientOptions {
  /**
   * Base URL of the OpenAI-compatible embedding service (…/v1). When falsy the
   * client is a NO-OP that returns `null` vectors with ZERO network calls.
   */
  url?: string | null;
  /** Capability-alias / model the gateway routes by (native services ignore it). */
  model?: string;
  /** Requested output dimension. Defaults to the domain mapping dim. */
  dim?: number;
  /** Master switch. When false the client is a NO-OP (null vectors, no I/O). */
  enabled?: boolean;
  /** Optional gateway bearer (virtual key). Defaults to `process.env.OPENAI_API_KEY`. */
  apiKey?: string;
}

export interface TextEmbeddingResult {
  /** Dense leg, or `null` when the service is disabled / unreachable / errored. */
  dense: number[] | null;
  /** Best-effort sparse leg: `null` when the provider has no sparse route. */
  sparse: SparseVector | null;
}

export interface TextEmbeddingClient {
  embedTextDocuments(texts: string[]): Promise<TextEmbeddingResult[]>;
}

export interface ImageEmbeddingClient {
  embedImages(urls: string[]): Promise<(number[] | null)[]>;
}

/** JSON object keys are strings; sparse vectors want numeric indices. */
function toSparseVector(value: unknown): SparseVector | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: SparseVector = {};
  for (const [key, weight] of Object.entries(value as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || typeof weight !== "number") return null;
    out[index] = weight;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function authHeaderFor(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/**
 * POST JSON with a bounded low retry. Returns the `Response` (even non-2xx, so
 * callers can branch on status — e.g. a 404 latches "sparse unsupported"), or
 * `null` when the transport failed on every attempt. NEVER throws.
 */
async function postWithRetry(
  endpoint: string,
  body: unknown,
  headers: Record<string, string>
): Promise<Response | null> {
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      // A 5xx is worth one bounded retry; any other status is returned as-is.
      if (res.status >= 500 && res.status < 600 && attempt < RETRY_ATTEMPTS) continue;
      return res;
    } catch {
      // Network error / timeout-abort — retry within the bound, else give up.
      if (attempt >= RETRY_ATTEMPTS) return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Text embedding client for INGEST. Returns dense (may be `null`) + best-effort
 * sparse (may be `null`) per input, order-preserved. A no-op returning all-null
 * with zero network calls when `enabled === false` or `url` is falsy.
 */
export function makeTextEmbeddingClient(options: EmbeddingClientOptions = {}): TextEmbeddingClient {
  const { url, enabled = true, apiKey = process.env.OPENAI_API_KEY } = options;
  const model = options.model ?? "";
  const dim = options.dim ?? DENSE_DIM;
  const active = Boolean(enabled && url);
  const authHeader = authHeaderFor(apiKey);
  // Latched once a provider proves it can't do sparse, so we stop asking.
  let sparseUnsupported = false;

  async function fetchDense(texts: string[]): Promise<(number[] | null)[]> {
    const res = await postWithRetry(`${url}/embeddings`, { model, input: texts, dimensions: dim }, authHeader);
    if (!res || !res.ok) return texts.map(() => null);
    let body: EmbeddingsResponse;
    try {
      body = (await res.json()) as EmbeddingsResponse;
    } catch {
      return texts.map(() => null);
    }
    if (!Array.isArray(body.data) || body.data.length !== texts.length) return texts.map(() => null);
    return texts.map((_, i) => {
      const vec = body.data?.[i]?.embedding;
      return Array.isArray(vec) && vec.length > 0 ? (vec as number[]) : null;
    });
  }

  /**
   * Per-input sparse vectors, or `null` for the whole batch when unavailable.
   * A 404/501/400 means the provider has no sparse route, so we latch it off for
   * the process lifetime; any other failure degrades just this batch.
   */
  async function fetchSparse(texts: string[]): Promise<(SparseVector | null)[] | null> {
    const res = await postWithRetry(`${url}/sparse/embeddings`, { input: texts }, authHeader);
    if (!res) return null;
    if (res.status === 404 || res.status === 501 || res.status === 400) {
      sparseUnsupported = true;
      return null;
    }
    if (!res.ok) return null;
    let body: EmbeddingsResponse;
    try {
      body = (await res.json()) as EmbeddingsResponse;
    } catch {
      return null;
    }
    if (!Array.isArray(body.data) || body.data.length !== texts.length) return null;
    return texts.map((_, i) => toSparseVector(body.data?.[i]?.embedding));
  }

  async function embedTextDocuments(texts: string[]): Promise<TextEmbeddingResult[]> {
    if (texts.length === 0) return [];
    if (!active) return texts.map(() => ({ dense: null, sparse: null }));

    const [dense, sparse] = await Promise.all([
      fetchDense(texts),
      sparseUnsupported ? Promise.resolve<(SparseVector | null)[] | null>(null) : fetchSparse(texts)
    ]);

    return texts.map((_, i) => ({
      dense: dense[i] ?? null,
      sparse: sparse ? (sparse[i] ?? null) : null
    }));
  }

  return { embedTextDocuments };
}

/**
 * Image (CLIP) embedding client for INGEST. Returns one entry per URL (order
 * preserved): a vector, or `null` where an image could not be embedded, or all
 * `null` when the whole call fails / the client is disabled. A no-op with zero
 * network calls when `enabled === false` or `url` is falsy. The default `dim`
 * (CLIP_DIM = 512) agrees with the nested `image_vector` knn mapping dimension.
 */
export function makeImageEmbeddingClient(options: EmbeddingClientOptions = {}): ImageEmbeddingClient {
  const { url, enabled = true, apiKey = process.env.OPENAI_API_KEY } = options;
  const model = options.model ?? "";
  const dim = options.dim ?? CLIP_DIM;
  const active = Boolean(enabled && url);
  const authHeader = authHeaderFor(apiKey);

  async function embedImages(urls: string[]): Promise<(number[] | null)[]> {
    if (urls.length === 0) return [];
    if (!active) return urls.map(() => null);

    const res = await postWithRetry(`${url}/embeddings`, { model, input: urls, dimensions: dim }, authHeader);
    if (!res || !res.ok) return urls.map(() => null);
    let body: EmbeddingsResponse;
    try {
      body = (await res.json()) as EmbeddingsResponse;
    } catch {
      return urls.map(() => null);
    }
    if (!Array.isArray(body.data)) return urls.map(() => null);
    return urls.map((_, i) => {
      const vec = body.data?.[i]?.embedding;
      return Array.isArray(vec) && vec.length > 0 ? (vec as number[]) : null;
    });
  }

  return { embedImages };
}

/**
 * Resolve a {@link LocationHint} to coordinates: explicit finite `coords` win;
 * otherwise the `address` is forward-geocoded via the SDK geo module (Nominatim).
 * Returns `null` when neither yields a location. Never throws.
 */
export async function resolveGeo(hint: LocationHint): Promise<LatLon | null> {
  const coords = hint.coords;
  if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)) {
    return { lat: coords.lat, lon: coords.lon };
  }
  if (hint.address) return geocodeAddress(hint.address as GeocodableAddress);
  return null;
}
