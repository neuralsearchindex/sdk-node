import type { BaseCache } from "@langchain/core/caches";
import { embeddings } from "../../embeddings/index.js";

import { MilvusSemanticCache } from "./milvus-semantic-cache.js";
import { OpenSearchSemanticCache } from "./opensearch-semantic-cache.js";
import { PgVectorSemanticCache } from "./pgvector-semantic-cache.js";
import type {
  BaseSemanticCache,
  ClearByQueriesOptions,
  QuerySuggestion,
} from "./semantic-cache.js";

/**
 * Env-gated singleton for the semantic model cache, mirroring the
 * `getCache()` / `setCache()` seam of the generic key/value cache. Read once
 * from env at module load (like the rest of the agent's config).
 *
 * This is a SEMANTIC LLM cache and is DIFFERENT from the exact-hash key/value
 * cache in `@neuralsearchindex/cache` — the two layers are independent and can both be on.
 *
 *   MODEL_CACHE_ENABLED               "false" turns it off (default ON).
 *   MODEL_CACHE_BACKEND               vector store: "milvus" (default) | "postgresql" | "opensearch" (alias: "pgvector").
 *   MODEL_CACHE_COLLECTION            collection / table / index name (default "llm_semantic_cache").
 *   MODEL_CACHE_SIMILARITY_THRESHOLD  min COSINE similarity for a hit (default 0.95).
 *   MODEL_CACHE_MAX_EMBED_CHARS       truncate the user message before embedding (default 8000).
 *   MODEL_CACHE_NAMESPACE_BY_LLMKEY   scope hits to same model+schema (default on).
 *
 *   # backend connections (reuse the repo's existing env vars):
 *   MILVUS_URL / MILVUS_ADDRESS       Milvus endpoint "host:port" (docker sets MILVUS_ADDRESS).
 *   MILVUS_TOKEN                      optional Milvus auth (empty for local docker Milvus).
 *   DATABASE_URL                     Postgres URL (required for backend=postgresql).
 *   OPENSEARCH_URL                   OpenSearch endpoint (required for backend=opensearch).
 *   OPENSEARCH_USERNAME / _PASSWORD  optional OpenSearch basic auth.
 */

const ENABLED =
  (process.env.MODEL_CACHE_ENABLED ?? "true").toLowerCase() === "true";
const BACKEND = (process.env.MODEL_CACHE_BACKEND ?? "milvus").toLowerCase();
const COLLECTION = process.env.MODEL_CACHE_COLLECTION || "llm_semantic_cache";
const THRESHOLD =
  Number.parseFloat(process.env.MODEL_CACHE_SIMILARITY_THRESHOLD ?? "") || 0.9;
const MAX_CHARS =
  Number.parseInt(process.env.MODEL_CACHE_MAX_EMBED_CHARS ?? "", 10) || 8000;
const NAMESPACE_BY_LLMKEY =
  (process.env.MODEL_CACHE_NAMESPACE_BY_LLMKEY ?? "true").toLowerCase() !==
  "false";

// Backend connections.
const MILVUS_URL =
  process.env.MILVUS_URL || process.env.MILVUS_ADDRESS || "localhost:19530";
const MILVUS_TOKEN = process.env.MILVUS_TOKEN || undefined;
const DATABASE_URL = process.env.DATABASE_URL || undefined;
const OPENSEARCH_URL = process.env.OPENSEARCH_URL || "http://localhost:9200";
const OPENSEARCH_USERNAME = process.env.OPENSEARCH_USERNAME || undefined;
const OPENSEARCH_PASSWORD = process.env.OPENSEARCH_PASSWORD || undefined;

// undefined = not built yet, null = disabled or failed to init, instance = active.
let active: BaseCache | null | undefined;

/** Options for {@link buildSemanticCache} — `collection` is the one knob that separates caches. */
export interface BuildSemanticCacheOptions {
  /** Backend collection / table / index name. */
  collection: string;
  /** Vector store: "milvus" (default) | "postgresql" | "opensearch" (alias: "pgvector"). */
  backend?: string;
  /** Min COSINE similarity (0..1) for a hit. Default 0.9. */
  similarityThreshold?: number;
  /** Truncate the user message to this many chars before embedding. Default 8000. */
  maxEmbedChars?: number;
  /** Scope hits to a same-model+schema namespace via an llmkey hash. Default true. */
  namespaceByLlmKey?: boolean;
}

/**
 * Build a semantic cache on the env-selected backend for an ARBITRARY collection.
 * The connection (Milvus / Postgres / OpenSearch) comes from the shared env; the
 * caller owns the returned instance. The model cache and any other semantic cache
 * (e.g. an intent cache) are just instances of this with a different collection.
 */
export function buildSemanticCache(
  opts: BuildSemanticCacheOptions,
): BaseSemanticCache {
  const backend = (opts.backend ?? BACKEND).toLowerCase();
  const shared = {
    embeddings,
    name: opts.collection,
    similarityThreshold: opts.similarityThreshold ?? 0.9,
    maxEmbedChars: opts.maxEmbedChars ?? 8000,
    namespaceByLlmKey: opts.namespaceByLlmKey ?? true,
  };

  switch (backend) {
    // "postgresql" matches the storage SEARCH_BACKEND naming; "pgvector" is kept
    // as a back-compat alias for the same Postgres/pgvector-backed store.
    case "postgresql":
    case "pgvector": {
      if (!DATABASE_URL)
        throw new Error("DATABASE_URL is required when backend=postgresql");
      return new PgVectorSemanticCache({
        ...shared,
        connectionString: DATABASE_URL,
      });
    }
    case "opensearch":
      return new OpenSearchSemanticCache({
        ...shared,
        url: OPENSEARCH_URL,
        username: OPENSEARCH_USERNAME,
        password: OPENSEARCH_PASSWORD,
      });
    case "milvus":
      return new MilvusSemanticCache({
        ...shared,
        url: MILVUS_URL,
        token: MILVUS_TOKEN,
      });
    default:
      throw new Error(`Unknown semantic cache backend: ${backend}`);
  }
}

/** Build the model cache from the `MODEL_CACHE_*` env (a specific {@link buildSemanticCache}). */
function buildCache(): BaseSemanticCache {
  return buildSemanticCache({
    collection: COLLECTION,
    backend: BACKEND,
    similarityThreshold: THRESHOLD,
    maxEmbedChars: MAX_CHARS,
    namespaceByLlmKey: NAMESPACE_BY_LLMKEY,
  });
}

/**
 * The active semantic model cache, or `undefined` when disabled. Passing
 * `undefined` as a model's `cache` is a genuine no-op (`BaseChatModel` runs
 * uncached), so callers can wire this in unconditionally.
 */
export function getModelCache(): BaseCache | undefined {
  if (!ENABLED) return undefined;
  if (active === undefined) {
    try {
      active = buildCache();
    } catch {
      active = null; // never throw out of the model loader (bad config, unknown backend, …)
    }
  }
  return active ?? undefined;
}

/** Swap the active cache (tests). Pass `undefined` to reset to the env-selected default. */
export function setModelCache(cache: BaseCache | undefined): void {
  active = cache;
}

/**
 * Build the env-selected semantic cache **regardless of `MODEL_CACHE_ENABLED`**,
 * for admin/maintenance use (e.g. clearing). Unlike {@link getModelCache} this is
 * not gated and not memoized — the caller owns the returned instance. Throws on
 * bad config (unknown backend / missing `DATABASE_URL`).
 */
export function buildModelCache(): BaseSemanticCache {
  return buildCache();
}

/**
 * Semantically purge a collection by example prompt: delete every stored entry a
 * query would have hit (cosine similarity `>= threshold`), keeping the collection.
 * Works for ANY semantic cache (model, intent, …). Returns the number removed.
 */
export async function clearSemanticCacheByQueries(
  collection: string,
  queries: string[],
  options?: ClearByQueriesOptions,
): Promise<number> {
  return buildSemanticCache({ collection }).clearByQueries(queries, options);
}

/**
 * Purge an ENTIRE collection — every stored row — keeping the schema. Works for
 * any semantic cache. Not fail-open: a backend error propagates.
 */
export async function clearSemanticCacheAll(
  collection: string,
): Promise<number> {
  return buildSemanticCache({ collection }).clearAll();
}

/**
 * List stored entries (id + cached prompt text) in a collection, across all
 * namespaces, paged — the store-wide read path for admin inspection. Works for any
 * semantic cache backend. Not fail-open: a backend error propagates.
 */
export async function listSemanticCache(
  collection: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ id: string; text: string }[]> {
  return buildSemanticCache({ collection }).listAll(
    options.limit ?? 100,
    options.offset ?? 0,
  );
}

/**
 * Delete specific entries from a collection by their store id (as returned by
 * {@link listSemanticCache}). Returns the number of rows removed.
 */
export async function deleteSemanticCacheEntries(
  collection: string,
  ids: string[],
): Promise<number> {
  return buildSemanticCache({ collection }).deleteEntries(ids);
}

/** {@link clearSemanticCacheByQueries} pinned to the model-cache collection. */
export async function clearModelCache(
  queries: string[],
  options?: ClearByQueriesOptions,
): Promise<number> {
  return clearSemanticCacheByQueries(COLLECTION, queries, options);
}

/** {@link clearSemanticCacheAll} pinned to the model-cache collection. */
export async function clearModelCacheAll(): Promise<number> {
  return clearSemanticCacheAll(COLLECTION);
}

// Memoized read-only instances per collection for autocomplete — separate from
// the `active` write cache above, and un-gated so they read the collection
// regardless of MODEL_CACHE_ENABLED. Built once per collection (autocomplete is a
// hot path); the backend driver is imported lazily on first search inside each.
const readCaches = new Map<string, BaseSemanticCache>();

/**
 * Autocomplete suggestions drawn from ANY semantic cache collection: the top
 * `limit` stored user messages whose cosine similarity to `query` is `>= threshold`,
 * deduped by text with oversized entries dropped. Over-fetches (`k`) to survive
 * that filtering, then slices to `limit`. Reads the collection even when the cache
 * is disabled for writes. **Fail-open**: blank input or any backend / config error
 * yields `[]`, never a throw. `suggest()` never filters by `llmkey`, so the built
 * instance's `namespaceByLlmKey` is irrelevant here.
 */
export async function suggestFromSemanticCache(
  collection: string,
  query: string,
  opts: { limit?: number; threshold?: number; maxTextChars?: number } = {},
): Promise<QuerySuggestion[]> {
  const { limit = 10, threshold = 0.5, maxTextChars = 200 } = opts;
  if (!query.trim()) return [];
  try {
    let read = readCaches.get(collection);
    if (!read) {
      read = buildSemanticCache({ collection });
      readCaches.set(collection, read);
    }
    const k = Math.max(limit * 4, 20);
    const hits = await read.suggest(query, { k, threshold, maxTextChars });
    return hits.slice(0, limit);
  } catch (error) {
    console.log("[semantic cache]", error);
    return [];
  }
}

/** {@link suggestFromSemanticCache} pinned to the model-cache collection. */
export async function suggestFromModelCache(
  query: string,
  opts: { limit?: number; threshold?: number; maxTextChars?: number } = {},
): Promise<QuerySuggestion[]> {
  return suggestFromSemanticCache(COLLECTION, query, opts);
}
