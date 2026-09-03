// Ported from engine `search/domains/index.ts` (the resolver half). The live
// ingest domain registry: both packs are always present; a caller selects its
// domain per-ingest. Adding a domain = one entry here + its descriptor file.
import { Domain } from "../schemas/domain.js";

import { realEstateDomain } from "./real-estate.js";
import type { DomainDescriptor } from "./types.js";
import { vehiclesDomain } from "./vehicles.js";

const REGISTRY: Record<Domain, DomainDescriptor> = {
  [Domain.RealEstate]: realEstateDomain,
  [Domain.Vehicles]: vehiclesDomain
};

/** Used when a request omits `domain` (back-compat with the single-index era). */
export const DEFAULT_DOMAIN = Domain.RealEstate;

export const ALL_DOMAINS: readonly DomainDescriptor[] = Object.values(REGISTRY);

export function isDomain(value: unknown): value is Domain {
  return typeof value === "string" && value in REGISTRY;
}

/** Resolve a domain descriptor; falls back to the default when `domain` is omitted. */
export function resolveDomain(domain?: string): DomainDescriptor {
  if (domain === undefined || domain === "") return REGISTRY[DEFAULT_DOMAIN];
  if (!isDomain(domain)) throw new Error(`unknown domain: ${domain}`);
  return REGISTRY[domain];
}

/**
 * Reverse lookup: find the domain that owns a given index name. Returns the
 * default domain if the index matches none, so callers still map sensibly.
 */
export function resolveDomainByIndex(indexName: string): DomainDescriptor {
  return ALL_DOMAINS.find((d) => d.indexName === indexName) ?? REGISTRY[DEFAULT_DOMAIN];
}
