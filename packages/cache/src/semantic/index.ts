/**
 * `@local-llm/cache/semantic` — the semantic cache module: a LangChain `BaseCache`
 * with pluggable vector-store backends (Milvus, pgvector, OpenSearch), a generic
 * `buildSemanticCache` factory, and the env-gated model-cache instance built on it.
 *
 * Lives behind the `./semantic` subpath so the heavy driver chains
 * (`@zilliz/milvus2-sdk-node`, `pg`, `@opensearch-project/opensearch`,
 * `@langchain/community`) never reach consumers of the exact-hash `@local-llm/cache`
 * root — the two layers are independent.
 */
export {
  BaseSemanticCache,
  extractUserMessage,
  stripMessageId,
  type SemanticCacheOptions,
  type SemanticVectorStore,
  type ClearByQueriesOptions,
  type SuggestOptions,
  type QuerySuggestion,
} from "./semantic-cache.js";
export {
  MilvusSemanticCache,
  type MilvusSemanticCacheOptions,
} from "./milvus-semantic-cache.js";
export {
  PgVectorSemanticCache,
  type PgVectorSemanticCacheOptions,
} from "./pgvector-semantic-cache.js";
export {
  OpenSearchSemanticCache,
  type OpenSearchSemanticCacheOptions,
} from "./opensearch-semantic-cache.js";
export {
  buildSemanticCache,
  type BuildSemanticCacheOptions,
  clearSemanticCacheByQueries,
  clearSemanticCacheAll,
  listSemanticCache,
  deleteSemanticCacheEntries,
  getModelCache,
  setModelCache,
  buildModelCache,
  clearModelCache,
  clearModelCacheAll,
  suggestFromModelCache,
  suggestFromSemanticCache,
} from "./model-cache.js";
