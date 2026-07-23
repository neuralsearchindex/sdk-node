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
  /** Persist `value` under `key`. Never throws. */
  set(key: string, value: V): Promise<void>;
  /** Optional: remove a single entry. */
  delete?(key: string): Promise<void>;
  /** Optional: drop every entry. */
  clear?(): Promise<void>;
}
