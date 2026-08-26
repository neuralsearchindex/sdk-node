/**
 * A generic, replaceable key → value cache backend.
 *
 * The interface is deliberately domain-agnostic — it stores arbitrary
 * JSON-serializable values under string keys and knows nothing about tools.
 * The tool-result layer (`./index.ts`) is one consumer; other subsystems can
 * reuse the same plugins with their own value type via the `V` parameter.
 *
 * It mirrors the repo's "interface + default impl + factory" convention (see
 * `tools/robots.ts`: `RobotsChecker` / `ALLOW_ALL` / `loadRobots`). The default
 * implementation is `SqliteCachePlugin`; `InMemoryCachePlugin` is a
 * non-persistent alternative used by tests and the `"memory"` backend.
 *
 * Implementations MUST be fail-open: a read or write error should never
 * propagate out of `get`/`set` — callers treat a failure as a cache miss and
 * recompute the value.
 *
 * @typeParam V - the stored value type (defaults to `unknown`).
 */
export interface CachePlugin<V = unknown> {
  /** Return the value for `key`, or `undefined` on miss / any read failure. */
  get(key: string): Promise<V | undefined>;
  /**
   * Persist `value` under `key`. Never throws. `ttlMs`, when given, is a hint
   * that the entry may be dropped after that many milliseconds — backends that
   * support native expiry (Redis) honour it; others ignore it and rely on the
   * read-through layer's own age check.
   */
  set(key: string, value: V, ttlMs?: number): Promise<void>;
  /** Optional: remove a single entry. */
  delete?(key: string): Promise<void>;
  /**
   * Optional: remove several exact keys in one pass. Returns how many entries
   * were actually removed. Never throws (fail-open, like every other method).
   */
  deleteMany?(keys: string[]): Promise<number>;
  /**
   * Optional: remove every key matching a glob `pattern` (`*` = any run, `?` =
   * any single char). Returns how many entries were removed. Backends translate
   * the glob to their native matcher (Redis `SCAN MATCH`, SQLite `GLOB`, an
   * anchored `RegExp` in memory). Never throws.
   */
  deletePattern?(pattern: string): Promise<number>;
  /** Optional: drop every entry. */
  clear?(): Promise<void>;
}

/**
 * Translate a `*`/`?` glob into an anchored, case-sensitive {@link RegExp}. Only
 * `*` and `?` are treated as wildcards; every other character (including `[`)
 * is matched literally, so a key is never accidentally interpreted as a class.
 * Used by backends without a native glob matcher (the in-memory plugin).
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}
