import { Redis } from "ioredis";

import type { CachePlugin } from "./cache-plugin.js";

export interface RedisCacheOptions {
  /**
   * Connection string (`redis://…`). Ignored when {@link RedisCacheOptions.client}
   * is given. Defaults to `redis://127.0.0.1:6379`.
   */
  url?: string;
  /**
   * Reuse an existing `ioredis` client instead of opening one. The plugin never
   * closes a client it did not create.
   */
  client?: Redis;
  /**
   * Key prefix, so several independent caches can share one Redis instance and
   * `clear()` only wipes this cache's keys. Defaults to `"cache:"`.
   */
  prefix?: string;
}

/**
 * Redis-backed cache (via `ioredis`, already in the dependency tree). Stores
 * each value as one JSON-encoded string and honours the `ttlMs` hint natively
 * with `SET … PX`, so entries expire without any read-side age check.
 *
 * Like the other plugins it is **fail-open**: any error (connection, command,
 * parse) degrades to a miss (get) or a silent no-op (set) so the cache can
 * never break its caller. Intended for a *dedicated* Redis instance — `clear()`
 * only deletes keys under {@link RedisCacheOptions.prefix}, never `FLUSHDB`.
 *
 * @typeParam V - the stored value type (defaults to `unknown`).
 */
export class RedisCachePlugin<V = unknown> implements CachePlugin<V> {
  private readonly client: Redis;
  private readonly ownsClient: boolean;
  private readonly prefix: string;

  constructor(options: RedisCacheOptions = {}) {
    if (options.client) {
      this.client = options.client;
      this.ownsClient = false;
    } else {
      this.client = new Redis(options.url ?? "redis://127.0.0.1:6379", {
        // A cache read must never hang a request; fail fast to a miss instead.
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: false,
      });
      // Swallow connection errors — the plugin degrades to misses on its own.
      this.client.on("error", () => {});
      this.ownsClient = true;
    }
    this.prefix = options.prefix ?? "cache:";
  }

  private k(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string): Promise<V | undefined> {
    try {
      const raw = await this.client.get(this.k(key));
      return raw === null ? undefined : (JSON.parse(raw) as V);
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: V, ttlMs?: number): Promise<void> {
    try {
      const payload = JSON.stringify(value);
      if (ttlMs && ttlMs > 0) {
        await this.client.set(this.k(key), payload, "PX", Math.floor(ttlMs));
      } else {
        await this.client.set(this.k(key), payload);
      }
    } catch {
      // Fail-open: a failed write just means the next call recomputes the value.
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.del(this.k(key));
    } catch {
      // ignore
    }
  }

  /** Drop every entry owned by this cache (its prefix only — never the whole DB). */
  async clear(): Promise<void> {
    try {
      const stream = this.client.scanStream({
        match: `${this.prefix}*`,
        count: 500,
      });
      for await (const keys of stream) {
        if ((keys as string[]).length > 0)
          await this.client.del(...(keys as string[]));
      }
    } catch {
      // ignore
    }
  }

  /** Close the client if this plugin opened it. Mainly for tests. */
  async close(): Promise<void> {
    if (this.ownsClient) {
      try {
        await this.client.quit();
      } catch {
        // ignore
      }
    }
  }
}
