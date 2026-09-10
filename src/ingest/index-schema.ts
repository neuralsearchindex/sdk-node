// Ported from engine `search/shared/domain/index-schema.ts`. The `property_ads`
// OpenSearch create-index body (settings + mappings). NOTE: the engine's local
// `ImageStruct` (required image_vector) is intentionally NOT re-declared here —
// the canonical ImageStruct (with OPTIONAL image_vector, the "blind photo"
// contract) lives in `./ad-to-row.ts` and is the one the barrel exports.
import { MAX_TEXT_CHUNKS } from "./chunk.js";

export const PROPERTY_AD_INDEX = "property_ads";

export const DENSE_DIM = Number(process.env.TEXT_EMBEDDING_DIM) || 1024;
/** Image-vector dimension. Honors the deployment's IMAGE_EMBEDDING_DIM profile
 *  (prod Jina 2048 / self-hosted CLIP 512); the knn mapping below and the image
 *  embedding client default (see `./embeddings.ts`) agree on this value. The
 *  fallback is 2048 to match the deployed profile. It was 512, which silently
 *  disagreed with the running deployment: the index field and the embedding size
 *  have to be equal, and an existing index cannot be re-dimensioned in place. */
export const CLIP_DIM = Number(process.env.IMAGE_EMBEDDING_DIM) || 2048;
export const MAX_IMAGES = 16;
export const MAX_QUERY_WINDOW = 16384;

const knnVector = (dimension: number) => ({
  type: "knn_vector" as const,
  dimension,
  method: {
    name: "hnsw",
    engine: "faiss",
    space_type: "cosinesimil",
    parameters: { m: 16, ef_construction: 100 }
  }
});

/**
 * The nested `images` mapping, shared across every domain so all indices carry the
 * same per-photo shape: the URL, its CLIP vector, and the persisted aesthetic
 * ordering fields (`order`/`aesthetic_score`/`type`) stamped at ingest. `dim` is
 * the image-vector dimension for the domain; `maxCapacity` caps indexed nested docs
 * (omitted ⇒ no cap).
 */
export const imagesNested = (dim: number, maxCapacity?: number) => ({
  type: "nested" as const,
  ...(maxCapacity ? { max_capacity: maxCapacity } : {}),
  properties: {
    url: { type: "keyword" },
    image_vector: knnVector(dim),
    order: { type: "integer" },
    aesthetic_score: { type: "float" },
    type: { type: "keyword" }
  }
});

export function propertyAdIndexMapping(): Record<string, unknown> {
  return {
    properties: {
      id: { type: "keyword" },

      name: { type: "keyword" },
      description: { type: "keyword" },
      additional_information: { type: "keyword" },
      language: { type: "keyword" },
      reference_number: { type: "keyword" },
      source_url: { type: "keyword" },
      published_at: { type: "keyword" },
      updated_at: { type: "keyword" },
      listing_type: { type: "keyword" },
      property_type_category: { type: "keyword" },
      property_type_subcategory: { type: "keyword" },

      address_street: { type: "keyword" },
      address_house_number: { type: "keyword" },
      address_postal_code: { type: "keyword" },
      address_city: { type: "keyword" },
      address_state: { type: "keyword" },
      address_country: { type: "keyword" },
      address_display_name: { type: "keyword" },

      price_amount: { type: "double" },
      price_currency: { type: "keyword" },
      price_on_request: { type: "boolean" },
      available_from: { type: "keyword" },
      living_space: { type: "double" },
      usable_area: { type: "double" },
      land_area: { type: "double" },
      floor: { type: "long" },
      number_of_floors: { type: "long" },
      rooms: { type: "double" },
      bedrooms: { type: "double" },
      bathrooms: { type: "double" },
      year_of_construction: { type: "long" },
      renovation_year: { type: "long" },
      condition: { type: "keyword" },

      rent_net: { type: "double" },
      rent_additional: { type: "double" },
      rent_gross: { type: "double" },

      agency_name: { type: "keyword" },
      agency_phone: { type: "keyword" },
      agency_email: { type: "keyword" },
      agent_name: { type: "keyword" },
      agent_phone: { type: "keyword" },
      agent_email: { type: "keyword" },

      features: { type: "object", enabled: false },
      nearby_amenities: { type: "object", enabled: false },

      source_domain: { type: "keyword" },
      search_query: { type: "keyword" },
      scraped_at: { type: "long" },

      // Embedding-input hashes (skip-if-unchanged). Only ever read back via _source,
      // never queried/aggregated — no inverted index or doc-values overhead.
      text_hash: { type: "keyword", index: false, doc_values: false },
      image_hash: { type: "keyword", index: false, doc_values: false },

      location: { type: "geo_point" },

      // Nested per-chunk text vectors (the text analogue of nested per-photo image
      // vectors). Queried with a nested kNN + score_mode:"max" — best-matching
      // chunk wins. Replaces the former single `dense_vector`, removing MAX_TEXT_CHARS.
      page_content_chunks: {
        type: "nested",
        max_capacity: MAX_TEXT_CHUNKS,
        properties: {
          text: { type: "text", index: false },
          chunk_vector: knnVector(DENSE_DIM)
        }
      },
      sparse_vector: { type: "rank_features" },
      images: imagesNested(CLIP_DIM, MAX_IMAGES)
    }
  };
}

export function propertyAdIndexSettings(): Record<string, unknown> {
  return {
    index: {
      knn: true,
      number_of_shards: 1,
      number_of_replicas: 0,
      max_result_window: MAX_QUERY_WINDOW
    }
  };
}

export function propertyAdIndexBody(): Record<string, unknown> {
  return { settings: propertyAdIndexSettings(), mappings: propertyAdIndexMapping() };
}
