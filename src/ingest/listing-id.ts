import { v5 as uuidv5 } from "uuid";

/**
 * Fixed project namespace for deterministic listing/ad ids. Generated once and
 * hardcoded on purpose — computing it at runtime would make ids unstable across
 * runs and break upsert idempotency. Any valid UUID works as a namespace.
 */
export const LISTING_ID_NAMESPACE = "6f1e8b7a-2c3d-5e4f-9a0b-1c2d3e4f5a6b";

/**
 * Deterministic document id (UUIDv5) for a stable seed — usually the
 * canonicalized listing URL. Same seed always yields the same UUID, so
 * re-indexing the same listing upserts instead of duplicating.
 */
export function listingId(seed: string): string {
  return uuidv5(seed, LISTING_ID_NAMESPACE);
}
