import type { CachePlugin } from "./cache-plugin.js";

/**
 * Generic in-memory cache backend (a `Map`). Non-persistent — used by tests and
 * the `"memory"` backend. Values are cloned on read/write so callers can't
 * mutate stored state (they are JSON-serializable by design).
 *
 * @typeParam V - the stored value type (defaults to `unknown`).
 */
export class InMemoryCachePlugin<V = unknown> implements CachePlugin<V> {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<V | undefined> {
    const raw = this.store.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as V);
  }

  async set(key: string, value: V): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}
