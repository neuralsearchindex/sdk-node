import os from "node:os";
import path from "node:path";

import type { CachePlugin } from "./cache-plugin.js";
import { SqliteCachePlugin } from "./sqlite-cache-plugin.js";
import { InMemoryCachePlugin } from "./memory-cache-plugin.js";
import { RedisCachePlugin } from "./redis-cache-plugin.js";

export type { CachePlugin } from "./cache-plugin.js";
export {
  SqliteCachePlugin,
  type SqliteCacheOptions,
} from "./sqlite-cache-plugin.js";
export { InMemoryCachePlugin } from "./memory-cache-plugin.js";
export {
  RedisCachePlugin,
  type RedisCacheOptions,
} from "./redis-cache-plugin.js";
export { cacheKey, sha256, stableStringify } from "./hash.js";

/**
 * A generic key → value cache, built on the replaceable {@link CachePlugin}
 * backend. Everything here is domain-agnostic: {@link cached} is a read-through
 * memoizer with TTL and in-flight coalescing, keyed by whatever string the
 * caller derives (see {@link cacheKey}). The plugins themselves know nothing
 * about the values they hold.
 *
 * Config (read once, from env):
 *   CACHE_ENABLED   "false" disables caching entirely (default on).
 *   CACHE_BACKEND   "sqlite" (default) | "memory" | "redis".
 *   CACHE_DB        sqlite database file path (default below).
 *   CACHE_REDIS_URL redis connection string, used when CACHE_BACKEND=redis.
 *   CACHE_TTL_MS    default entry age (ms) after which a hit is reloaded (default: no expiry).
 */

/**
 * A stored value plus the wall-clock time it was written, so the read-through
 * layer can enforce a TTL uniformly across every backend. Redis also expires
 * the key natively; SQLite/memory rely solely on this timestamp.
 *
 * @typeParam V - the wrapped value type.
 */
export interface CacheEntry<V = unknown> {
  /** The cached value. */
  v: V;
  /** Epoch milliseconds when the entry was written. */
  t: number;
}

const CACHE_ENABLED =
  (process.env.CACHE_ENABLED ?? "true").toLowerCase() !== "false";

/** Default SQLite location — matches the `~/.cache/...` convention. */
const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  ".cache",
  "llm-cache",
  "cache.sqlite",
);

/** Default entry age (ms) after which a hit is discarded, or `undefined` for no expiry. */
const DEFAULT_TTL_MS = (() => {
  const raw = process.env.CACHE_TTL_MS;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
})();

let activePlugin: CachePlugin<CacheEntry> | undefined;

/** Build the plugin selected by `CACHE_BACKEND` for the default cache. */
function createPluginFromEnv(): CachePlugin<CacheEntry> {
  const backend = (process.env.CACHE_BACKEND ?? "sqlite").toLowerCase();
  if (backend === "memory") return new InMemoryCachePlugin<CacheEntry>();
  if (backend === "redis")
    return new RedisCachePlugin<CacheEntry>({
      url: process.env.CACHE_REDIS_URL,
    });
  const dbPath = process.env.CACHE_DB ?? DEFAULT_DB_PATH;
  return new SqliteCachePlugin<CacheEntry>(dbPath);
}

/** The active default cache backend (lazily created, cached as a singleton). */
export function getCache(): CachePlugin<CacheEntry> {
  if (!activePlugin) activePlugin = createPluginFromEnv();
  return activePlugin;
}

/**
 * Swap the active default cache backend. Enables replacing the SQLite default
 * with any other {@link CachePlugin} at runtime (used by tests). Pass
 * `undefined` to reset back to the env-selected default on the next
 * {@link getCache}.
 */
export function setCache(plugin: CachePlugin<CacheEntry> | undefined): void {
  activePlugin = plugin;
}

export interface CachedOptions<V> {
  /** Entry age (ms) after which a hit is discarded and reloaded. Defaults to `CACHE_TTL_MS`. */
  ttlMs?: number;
  /** Return `false` to skip caching a computed value (e.g. a failure). Default: cache anything non-nullish. */
  cacheIf?: (value: V) => boolean;
  /** Cache backend to use. Defaults to the env-selected singleton from {@link getCache}. */
  plugin?: CachePlugin<CacheEntry>;
}

/**
 * In-flight loads, keyed by cache key. Coalesces concurrent identical misses
 * (request "single-flight") so a cold key hit by a fan-out drives exactly one
 * `loader()` call; the rest await its result. Process-global on purpose;
 * entries are removed as soon as the load settles, so this never caches — the
 * durable {@link CachePlugin} handles reuse across ticks.
 */
const inFlight = new Map<string, Promise<unknown>>();

function isExpired(entry: CacheEntry, ttlMs: number | undefined): boolean {
  if (ttlMs === undefined) return false;
  return Date.now() - entry.t > ttlMs;
}

/**
 * Read-through cache: return the stored value for `key`, or run `loader`, store
 * its result, and return it. Fail-open — a backend error is treated as a miss.
 * Concurrent identical keys share one `loader` call (see {@link inFlight}).
 */
export async function cached<V>(
  key: string,
  loader: () => Promise<V>,
  options: CachedOptions<V> = {},
): Promise<V> {
  if (!CACHE_ENABLED) return loader();

  const plugin = (options.plugin ?? getCache()) as CachePlugin<CacheEntry<V>>;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const cacheIf = options.cacheIf ?? ((v: V) => v !== null && v !== undefined);

  const hit = await plugin.get(key).catch(() => undefined);
  if (hit && !isExpired(hit, ttlMs)) return hit.v;

  const existing = inFlight.get(key);
  if (existing) return existing as Promise<V>;

  const flight = (async () => {
    const value = await loader();
    if (cacheIf(value)) {
      await plugin.set(key, { v: value, t: Date.now() }, ttlMs).catch(() => {});
    }
    return value;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, flight);
  return flight;
}
