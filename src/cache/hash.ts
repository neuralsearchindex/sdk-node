import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";

/**
 * Fixed namespace for deriving deterministic cache-key UUIDs (uuidv5). A stable
 * arbitrary constant — changing it re-keys (invalidates) every derived key.
 */
const CACHE_KEY_NAMESPACE = "9f2c7e10-4b3a-4c8e-bf1a-0d6e5a7c9b21";

/**
 * Deterministic cache-key id for an arbitrary string, via uuidv5. Returned
 * hyphen-stripped (32 lowercase hex chars) so it stays a SINGLE token — the
 * OpenSearch semantic namespace filter matches `metadata.llmkey` with a `term`
 * on the analyzed field, which would split a standard hyphenated UUID apart.
 */
export function keyId(input: string): string {
  return uuidv5(input, CACHE_KEY_NAMESPACE).replace(/-/g, "");
}

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
 *   cacheKey(model, query, docHash)         // components
 */
export function cacheKey(...parts: unknown[]): string {
  return keyId(
    parts.map((p) => (typeof p === "string" ? p : stableStringify(p))).join("-"),
  );
}
