import os from "node:os";
import path from "node:path";

import { tool } from "@langchain/core/tools";

import type { CachePlugin } from "./cache-plugin.js";
import { SqliteCachePlugin } from "./sqlite-cache-plugin.js";
import { InMemoryCachePlugin } from "./memory-cache-plugin.js";
import { hashToolCall, sha256, stableStringify } from "./hash.js";

export type { CachePlugin } from "./cache-plugin.js";
export { SqliteCachePlugin, type SqliteCacheOptions } from "./sqlite-cache-plugin.js";
export { InMemoryCachePlugin } from "./memory-cache-plugin.js";
export { hashToolCall, sha256, stableStringify } from "./hash.js";

/**
 * Tool-result caching, wired on top of the generic {@link CachePlugin}. This
 * module owns everything tool-specific (the entry shape, the key derivation,
 * the "don't cache failures" rule); the plugins themselves stay domain-agnostic
 * so they can be reused for other caches.
 *
 * Every tool is created with `cachedTool(func, fields)` — a drop-in for
 * LangChain's `tool(func, fields)` that memoizes successful results keyed by
 * `hashToolCall(name, input)`. Because it wraps the handler before `tool()`
 * builds the tool object, it transparently covers both call paths: the graph's
 * `ToolNode` (agent → tool) and the direct `someTool.invoke(...)` calls made
 * from inside other tools (tool → tool).
 *
 * Config (read once, from env — mirrors how `tools/browser.ts` reads its own):
 *   TOOL_CACHE_ENABLED   "false" disables caching entirely (default on).
 *   TOOL_CACHE_BACKEND   "sqlite" (default) | "memory".
 *   TOOL_CACHE_DB        sqlite database file path (default below).
 *   TOOL_CACHE_TTL_MS    entries older than this are re-fetched (default: no expiry).
 */

/** A cached tool invocation — the value {@link cachedTool} stores in the cache. */
export interface ToolCacheEntry {
  /** The `name` of the tool that produced this result. */
  toolName: string;
  /** The lookup hash: sha256 over the tool name + canonical input args. */
  key: string;
  /** The original (parsed) input args — kept for inspection/debugging. */
  input: unknown;
  /** The tool's return value. Every tool returns a JSON string today. */
  result: unknown;
  /** sha256 of the serialized result (content hash of the result itself). */
  resultHash: string;
  /** ISO-8601 timestamp of when the entry was written (used for TTL checks). */
  createdAt: string;
}

const CACHE_ENABLED =
  (process.env.TOOL_CACHE_ENABLED ?? "true").toLowerCase() !== "false";

/** Default SQLite location — matches the `~/.cache/...` convention in browser.ts. */
const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  ".cache",
  "tool-result-cache",
  "cache.sqlite",
);

/** Entry age (ms) after which a hit is discarded, or `undefined` for no expiry. */
const TTL_MS = (() => {
  const raw = process.env.TOOL_CACHE_TTL_MS;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
})();

let activePlugin: CachePlugin<ToolCacheEntry> | undefined;

/** Build the plugin selected by `TOOL_CACHE_BACKEND` for the tool-result cache. */
function createPluginFromEnv(): CachePlugin<ToolCacheEntry> {
  const backend = (process.env.TOOL_CACHE_BACKEND ?? "sqlite").toLowerCase();
  if (backend === "memory") return new InMemoryCachePlugin<ToolCacheEntry>();
  const dbPath = process.env.TOOL_CACHE_DB ?? DEFAULT_DB_PATH;
  return new SqliteCachePlugin<ToolCacheEntry>(dbPath);
}

/** The active tool-result cache backend (lazily created, cached as a singleton). */
export function getCachePlugin(): CachePlugin<ToolCacheEntry> {
  if (!activePlugin) activePlugin = createPluginFromEnv();
  return activePlugin;
}

/**
 * Swap the active tool-result cache backend. Enables replacing the SQLite
 * default with any other {@link CachePlugin} at runtime (used by tests). Pass
 * `undefined` to reset back to the env-selected default on the next
 * `getCachePlugin()`.
 */
export function setCachePlugin(
  plugin: CachePlugin<ToolCacheEntry> | undefined,
): void {
  activePlugin = plugin;
}

/**
 * Whether a tool's return value should be cached. Excludes the `"Error: …"`
 * strings that `extract_content_tool` / `web_search_tool` / `extract_images_tool`
 * / `web_crawl_tool` return on failure (thrown errors never reach here). Also
 * skips `null`/`undefined`.
 */
export function isCacheableResult(result: unknown): boolean {
  if (result === null || result === undefined) return false;
  if (typeof result === "string" && result.startsWith("Error:")) return false;
  return true;
}

function isExpired(entry: ToolCacheEntry): boolean {
  if (TTL_MS === undefined) return false;
  const created = Date.parse(entry.createdAt);
  if (Number.isNaN(created)) return true; // unreadable timestamp → force re-fetch
  return Date.now() - created > TTL_MS;
}

function resultHashOf(result: unknown): string {
  return sha256(typeof result === "string" ? result : stableStringify(result));
}

/**
 * In-flight tool executions, keyed by `hashToolCall(name, input)`. Coalesces
 * concurrent identical calls (request "single-flight") so a cache MISS doesn't
 * stampede: when the page graph fans out and its 10 facet nodes each call
 * `extract_content_tool` with the same args in the same tick, they all miss the
 * durable cache (nothing is stored yet) and would each drive a separate
 * `loadPage` of the SAME url. Sharing one promise collapses them to a single
 * fetch; the rest await its result. Process-global on purpose — two unrelated
 * runs asking for the same url+args at once also share the one fetch. Entries
 * are removed as soon as the execution settles, so this never caches; the
 * durable {@link CachePlugin} still handles reuse across ticks.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Drop-in replacement for `tool()` that adds read-through caching plus in-flight
 * request coalescing. Typed as the `tool` factory itself so call sites keep
 * identical inference and the tool remains a `DynamicStructuredTool` for
 * `bindTools`/`ToolNode`.
 */
export const cachedTool = ((func: any, fields: any) => {
  // When disabled, hand back an unwrapped tool — a genuine zero-cost no-op.
  if (!CACHE_ENABLED) return tool(func, fields);

  const toolName: string = fields?.name ?? "";

  const wrapped = async (input: any, config: any) => {
    const key = hashToolCall(toolName, input);
    const plugin = getCachePlugin();

    const hit = await plugin.get(key).catch(() => undefined);
    if (hit && !isExpired(hit)) return hit.result;

    // Join an already-running identical call rather than launching a duplicate.
    // No `await` between this read and the `set` below, so the check-and-store is
    // atomic and only the first caller creates the flight.
    const existing = inFlight.get(key);
    if (existing) return existing;

    const flight = (async () => {
      // A thrown error propagates to every awaiter and is never cached.
      const result = await func(input, config);

      if (isCacheableResult(result)) {
        const entry: ToolCacheEntry = {
          toolName,
          key,
          input,
          result,
          resultHash: resultHashOf(result),
          createdAt: new Date().toISOString(),
        };
        await plugin.set(key, entry).catch(() => {});
      }

      return result;
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, flight);
    return flight;
  };

  return tool(wrapped, fields);
}) as typeof tool;
