import type { PropertyListing } from "./listing.js";

/**
 * Per-engine breakdown of `score`, for explainability ("why 74%?").
 *
 * Every field is optional and present ONLY when that engine actually measured
 * the listing.
 */
export interface ScoreComponents {
  /** Cross-encoder query-listing-text relevance, sigmoid(logit). Absolute. */
  semantic?: number;
  /** Best CLIP cosine of the visual query against any of the listing's photos. */
  visual?: number;
  /** Milvus retrieval score, min-max over the result set. */
  fusion?: number;
}

export interface ScoredListing {
  listing: PropertyListing;
  /** Relevance in [0,1]. Render as `Math.round(score * 100)`%. */
  score: number;
  components?: ScoreComponents;
}
