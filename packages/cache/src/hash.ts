import { createHash } from "node:crypto";

/**
 * Deterministically serialize a value so the cache key does not depend on
 * object key order. Keys are sorted recursively; arrays keep their order.
 * `undefined` values (and functions) are dropped like `JSON.stringify` would.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortDeep(record[key]);
        return acc;
      }, {});
  }
  return value;
}

/** sha256 hex digest of an arbitrary string. */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Cache key for a tool invocation: sha256 over the tool name and a stable
 * stringification of its input args. `config` is deliberately excluded — it
 * carries run-specific, non-deterministic data (e.g. `config.writer`).
 */
export function hashToolCall(toolName: string, input: unknown): string {
  return sha256(`${toolName}${stableStringify(input)}`);
}
