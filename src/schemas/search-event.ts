import type { PropertyListing } from "./listing.js";
import type { ScoreComponents, ScoredListing } from "./scored-listing.js";
import type { SearchIntent } from "./search-intent.js";

export interface PhaseTiming {
  phase: string;
  durationMs: number;
}

/**
 * The search graph's custom-event stream. Listings are no longer streamed — the
 * engine materializes the reranked result and the final assistant message
 * carries the invocationId; these events are progress/status only.
 */
export type SearchEvent =
  | { type: "intent"; intent: SearchIntent }
  | {
      // `phase` is a stable KEY the client renders to localized labels; the
      // graph no longer sends localized text. `durationMs`/`total` stay structured.
      type: "status";
      phase:
        | "intent-parsing"
        | "searching"
        | "semantic-scoring"
        | "image-ordering"
        | "image-scoring"
        | "aesthetic-scoring"
        | "ranking";
      durationMs?: number;
      total?: number;
    }
  // One rerank phase's order is ready to fetch. Fires per phase (search-results,
  // semantic-scored, …, reranked-results); `final` marks the last one.
  | { type: "results"; invocationId: string; phase: string; total: number; tookMs?: number; final: boolean }
  // The conversational hand-off text, streamed CUMULATIVELY (each event carries
  // the full text so far) so clients can type it into the live turn beside the
  // results chip instead of waiting for the run to finish.
  | { type: "framing"; invocationId: string; text: string }
  // No message — clients show their own generic localized error. `retryable`
  // drives the retry affordance.
  | { type: "search_error"; retryable: boolean };

const SEARCH_EVENT_TYPES: ReadonlySet<string> = new Set([
  "intent",
  "status",
  "results",
  "framing",
  "search_error",
]);

/**
 * Guard for the search custom-event channel: other tools write plain strings to
 * the same channel, so consumers must narrow with this before handling.
 */
export function isSearchEvent(value: unknown): value is SearchEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    SEARCH_EVENT_TYPES.has((value as { type: unknown }).type as string)
  );
}

/**
 * A page of listings from `GET /api/listings?invocationId&page&limit` — the
 * server re-runs the invocation's stored query with a fresh window. Each item
 * carries its reranked relevance score (null when the backend score isn't
 * normalized).
 */
export interface PaginatedListings {
  items: { listing: PropertyListing; score: number | null; components?: ScoreComponents }[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  /** Which rerank phase's order this page came from. */
  phase: string;
  /** Whether that phase is the final reranked order. */
  final: boolean;
}

/** The graph's state shape as seen through `streamMode: "values"`. */
export interface SearchStateValues {
  query?: string;
  intent?: SearchIntent;
  /** The engine invocation whose materialized order this run produced. */
  invocationId?: string;
  totalMatches?: number;
  urls?: string[];
  listings?: PropertyListing[];
  failures?: { url: string; error: string }[];
  ranked?: ScoredListing[];
}
