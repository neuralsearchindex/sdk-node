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
 * Derive a stable cache key from an ordered list of parts. Strings are used
 * verbatim; anything else is deterministically stringified (stable key order).
 * The whole thing is hashed so the key length stays fixed regardless of input.
 *
 *   cacheKey("bge-m3:v1", text)             // one namespace + one payload
 *   cacheKey(model, sha256(query), docHash) // pre-hashed components
 */
export function cacheKey(...parts: unknown[]): string {
  return sha256(
    parts.map((p) => (typeof p === "string" ? p : stableStringify(p))).join("-"),
  );
}
