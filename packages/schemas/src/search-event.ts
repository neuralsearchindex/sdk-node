/**
 * The typed custom-event protocol the search graph streams to the frontend (over
 * the LangGraph custom-stream channel). Pure types + a runtime guard — no
 * LangGraph dependency — so both the agents (which emit these) and the web app
 * (which consumes them via `useStream`'s `onCustomEvent`) share ONE definition.
 * The agents' `emit()` helper (LangGraph-coupled) stays in the search graph.
 */
import { type PropertyListing } from "./listing.js";
import { type ScoreComponents, type ScoredListing } from "./scored-listing.js";
import { type SearchIntent } from "./search-intent.js";

/** One entry of the final ranking: which listing, how relevant, and why. */
export interface RankedEntry {
  id: string;
  /** 0..1 relevance — the authoritative final score for this listing. */
  score: number;
  components?: ScoreComponents;
  /**
   * This listing's gallery REORDERED for the query, best-matching photo first.
   *
   * Present only when image reranking ran and the listing has more than one
   * photo. Replaces `listing.imageUrls`, which streamed in stored order on the
   * `listing` event — first paint shows the portal's order, and this reshuffles
   * it once the ranking lands. Absent means "keep what you have", never "the
   * gallery is empty".
   */
  imageUrls?: string[];
}

export type SearchEvent =
  | { type: "intent"; intent: SearchIntent }
  | {
      type: "status";
      phase: "parsing" | "searching" | "scraping" | "ranking";
      message: string;
      urlsFound?: number;
      scraped?: number;
      total?: number;
    }
  | {
      type: "listing";
      listing: PropertyListing;
      /** True when served from the Milvus index (warm hit), not a live scrape. */
      cached?: boolean;
      /**
       * 0..1 relevance, when known AT EMIT TIME. Warm hits carry their retrieval
       * score; freshly scraped listings stream before any ranking has run, so
       * they carry none — hence optional. Treat it as PROVISIONAL: `done` may
       * supersede it (it does whenever live scraping ran, since reranking then
       * rescores the combined set). NOTE 0 is a legitimate value (least-relevant
       * of the set), so consumers must test `score != null`, never truthiness.
       */
      score?: number;
      components?: ScoreComponents;
    }
  | {
      type: "done";
      total: number;
      /**
       * Final ranking, best-first: id + the authoritative 0..1 score. The order
       * is the ranking, and each entry carries the score the UI renders. The
       * listings themselves already streamed via `listing` events, so only ids
       * ride here.
       *
       * Where the score comes from depends on the run. With live scraping it is
       * the rerank blend (`semantic`/`structured`/`visual`) over warm hits and
       * fresh scrapes together. Warm-only, it is Milvus's fused retrieval score
       * (`fusion`) unchanged — every candidate was already ranked by the index,
       * so nothing re-ranks them. Either way THIS is the authoritative score.
       */
      ranked: RankedEntry[];
      /** Listing pages that could not be scraped/extracted. */
      failed: number;
    }
  | {
      /**
       * Just-in-time provider coverage for this search: which portals the
       * rotation targeted and how much of the inventory we've touched/scraped
       * overall. Informational — the UI can show progress; safe to ignore.
       */
      type: "coverage";
      /** Providers ever searched (searchedCount ≥ 1). */
      touched: number;
      /** Total providers in the inventory. */
      total: number;
      /** Total distinct listings indexed across all providers. */
      scrapedListings: number;
      /** The provider domains this search issued `site:` queries against. */
      selected: string[];
    }
  | { type: "search_error"; message: string; retryable: boolean };

const SEARCH_EVENT_TYPES: ReadonlySet<string> = new Set([
  "intent",
  "status",
  "listing",
  "done",
  "coverage",
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

/** The graph's state shape as seen through `streamMode: "values"`. */
export interface SearchStateValues {
  query?: string;
  intent?: SearchIntent;
  urls?: string[];
  listings?: PropertyListing[];
  failures?: { url: string; error: string }[];
  ranked?: ScoredListing[];
}
