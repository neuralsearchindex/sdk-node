import {
  BaseSemanticCache,
  type SemanticCacheOptions,
  type SemanticVectorStore,
} from "./semantic-cache.js";

/**
 * An OpenSearch-backed **semantic** cache for LLM generations. The OpenSearch
 * binding of {@link BaseSemanticCache}: it namespaces via a metadata term filter
 * and reads OpenSearch's k-NN `_score`, which {@link normalizeScore} converts back
 * into a cosine similarity.
 *
 * The heavy `@opensearch-project/opensearch` + `@langchain/community` modules are
 * **lazily imported** on first use, so importing this file costs nothing when the
 * cache is disabled. The k-NN index is auto-created (with the dimension inferred
 * from the first insert) on the first write, so a lookup before any write fails
 * open to a miss — same as the Milvus first-run path.
 */
export interface OpenSearchSemanticCacheOptions extends SemanticCacheOptions {
  /** OpenSearch HTTP endpoint, e.g. `http://localhost:9200`. */
  url: string;
  /** Optional basic-auth username. */
  username?: string;
  /** Optional basic-auth password. */
  password?: string;
}

/** OpenSearch metadata filter — `{ [field]: value }` becomes a `term` on `metadata.field`. */
type MetadataFilter = Record<string, unknown>;

export class OpenSearchSemanticCache extends BaseSemanticCache<MetadataFilter> {
  private readonly osOpts: OpenSearchSemanticCacheOptions;

  constructor(opts: OpenSearchSemanticCacheOptions) {
    super(opts);
    this.osOpts = opts;
  }

  protected buildFilter(llmKeyHash: string): MetadataFilter {
    // A hyphenless uuidv5 is a single lowercase hex token, so a `term` on the
    // analyzed `metadata.llmkey` text field matches it exactly (a standard
    // hyphenated UUID would be split apart by the analyzer).
    return { llmkey: llmKeyHash };
  }

  // Delete every document, keeping the index (mapping intact) via a `match_all`
  // delete_by_query. A never-written index doesn't exist yet → nothing to clear.
  async clearAll(): Promise<number> {
    const store = (await this.getStore()) as unknown as {
      client: {
        deleteByQuery(params: {
          index: string;
          body: { query: { match_all: Record<string, never> } };
          refresh?: boolean;
        }): Promise<{ body?: { deleted?: number } }>;
      };
      indexName: string;
    };
    try {
      const resp = await store.client.deleteByQuery({
        index: store.indexName,
        body: { query: { match_all: {} } },
        refresh: true,
      });
      return resp.body?.deleted ?? 0;
    } catch (err) {
      const e = err as {
        statusCode?: number;
        meta?: { statusCode?: number };
        body?: { error?: { type?: string } };
      };
      const status = e.statusCode ?? e.meta?.statusCode;
      if (status === 404 || e.body?.error?.type === "index_not_found_exception")
        return 0;
      throw err;
    }
  }

  // Metadata scan (no query vector): a `term` on `metadata.llmkey` returning each
  // hit's `_id` + stored `text`, for the memory manager. A never-written index
  // (404) means nothing stored → empty.
  protected async listByNamespace(
    llmKeyHash: string,
    limit: number,
  ): Promise<{ id: string; text: string }[]> {
    const store = (await this.getStore()) as unknown as {
      client: {
        search(params: { index: string; body: unknown }): Promise<{
          body?: {
            hits?: { hits?: { _id: string; _source?: { text?: string } }[] };
          };
        }>;
      };
      indexName: string;
    };
    try {
      const resp = await store.client.search({
        index: store.indexName,
        body: {
          size: limit,
          query: { term: { "metadata.llmkey": llmKeyHash } },
          _source: ["text"],
        },
      });
      const hits = resp.body?.hits?.hits ?? [];
      return hits.map((h) => ({ id: h._id, text: h._source?.text ?? "" }));
    } catch (err) {
      const e = err as {
        statusCode?: number;
        meta?: { statusCode?: number };
        body?: { error?: { type?: string } };
      };
      const status = e.statusCode ?? e.meta?.statusCode;
      if (status === 404 || e.body?.error?.type === "index_not_found_exception")
        return [];
      throw err;
    }
  }

  // Store-wide scan (no llmkey filter): a paged `match_all` search.
  protected async listAllRecords(
    limit: number,
    offset: number,
  ): Promise<{ id: string; text: string }[]> {
    const store = (await this.getStore()) as unknown as {
      client: {
        search(params: { index: string; body: unknown }): Promise<{
          body?: {
            hits?: { hits?: { _id: string; _source?: { text?: string } }[] };
          };
        }>;
      };
      indexName: string;
    };
    try {
      const resp = await store.client.search({
        index: store.indexName,
        body: {
          from: offset,
          size: limit,
          query: { match_all: {} },
          _source: ["text"],
        },
      });
      const hits = resp.body?.hits?.hits ?? [];
      return hits.map((h) => ({ id: h._id, text: h._source?.text ?? "" }));
    } catch (err) {
      const e = err as {
        statusCode?: number;
        meta?: { statusCode?: number };
        body?: { error?: { type?: string } };
      };
      const status = e.statusCode ?? e.meta?.statusCode;
      if (status === 404 || e.body?.error?.type === "index_not_found_exception")
        return [];
      throw err;
    }
  }

  // The LangChain OpenSearch store has no delete-by-id; drop matched hits via the
  // raw client's `delete_by_query` (an `ids` query), keeping the index in place.
  protected async deleteByIds(ids: string[]): Promise<number> {
    const store = (await this.getStore()) as unknown as {
      client: {
        deleteByQuery(params: {
          index: string;
          body: { query: { ids: { values: string[] } } };
          refresh?: boolean;
        }): Promise<{ body?: { deleted?: number } }>;
      };
      indexName: string;
    };
    const resp = await store.client.deleteByQuery({
      index: store.indexName,
      body: { query: { ids: { values: ids } } },
      refresh: true,
    });
    return resp.body?.deleted ?? ids.length;
  }

  /**
   * OpenSearch k-NN with the `lucene` engine + `cosinesimil` space returns
   * `_score = (1 + cos) / 2`, so `cos = 2 * score - 1` (identical → score 1 → cos 1;
   * orthogonal → score 0.5 → cos 0; opposite → score 0 → cos -1). NB: this differs
   * from nmslib's `1/(2 - cos)` — the score normalization is engine-dependent, so if
   * you switch engine/space, revisit this formula (see the OpenSearch k-NN score table).
   */
  protected normalizeScore(score: number): number {
    return 2 * score - 1;
  }

  protected async buildStore(): Promise<SemanticVectorStore<MetadataFilter>> {
    const { Client } = await import("@opensearch-project/opensearch");
    const client = new Client({
      node: this.osOpts.url,
      ...(this.osOpts.username && this.osOpts.password
        ? {
            auth: {
              username: this.osOpts.username,
              password: this.osOpts.password,
            },
          }
        : {}),
    });

    const { OpenSearchVectorStore } =
      await import("@langchain/community/vectorstores/opensearch");
    const store = new OpenSearchVectorStore(this.osOpts.embeddings, {
      client,
      indexName: this.osOpts.name,
      // `lucene` (built-in) — nmslib is deprecated and rejected for new-index creation
      // in OpenSearch 3.0+. lucene supports cosinesimil; see normalizeScore for the
      // engine-specific score formula.
      vectorSearchOptions: { engine: "lucene", spaceType: "cosinesimil" },
    });
    return store as unknown as SemanticVectorStore<MetadataFilter>;
  }
}
