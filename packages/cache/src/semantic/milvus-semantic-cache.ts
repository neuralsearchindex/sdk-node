import type {
  ConsistencyLevelEnum,
  MilvusClient,
  SearchSimpleReq,
} from "@zilliz/milvus2-sdk-node";

import {
  BaseSemanticCache,
  type SemanticCacheOptions,
  type SemanticVectorStore,
} from "./semantic-cache.js";

/**
 * A Milvus-backed **semantic** cache for LLM generations. The Milvus binding of
 * {@link BaseSemanticCache}: it namespaces via a Milvus filter expression, reads
 * COSINE similarity directly (Milvus returns it, no normalization), and
 * pre-creates the collection with an explicit `generations VarChar(65535)`.
 *
 * The heavy `@zilliz/milvus2-sdk-node` + `@langchain/community` modules are
 * **lazily imported** on first use, so importing this file costs nothing when the
 * cache is disabled — which is the default.
 */
export interface MilvusSemanticCacheOptions extends SemanticCacheOptions {
  /** Milvus endpoint, `"host:port"`. */
  url: string;
  /** Optional Milvus/Zilliz auth token. */
  token?: string;
}

/** Milvus VarChar hard limit (bytes); also the ceiling we give the `generations` field. */
const MAX_VARCHAR = 65535;

/** LangChain's default Milvus primary-key field name; the store may override it. */
const PRIMARY_FIELD = "langchain_primaryid";

export class MilvusSemanticCache extends BaseSemanticCache<string> {
  private readonly milvusOpts: MilvusSemanticCacheOptions;
  private ensured?: Promise<void>;

  constructor(opts: MilvusSemanticCacheOptions) {
    super(opts);
    this.milvusOpts = opts;
  }

  protected buildFilter(llmKeyHash: string): string {
    return `llmkey == "${llmKeyHash}"`;
  }

  // LangChain's Milvus store drops the `autoId` primary key from its search
  // output, so query the client directly to get `(primaryId, cosineScore)`.
  protected async searchIds(
    userMessage: string,
    k: number,
  ): Promise<{ id: string; similarity: number }[]> {
    const store = (await this.getStore()) as unknown as {
      client: MilvusClient;
      primaryField?: string;
    };
    const name = this.milvusOpts.name;
    const primaryField = store.primaryField ?? PRIMARY_FIELD;
    await store.client.loadCollectionSync({ collection_name: name });
    const vector = await this.milvusOpts.embeddings.embedQuery(userMessage);
    const req: SearchSimpleReq = {
      collection_name: name,
      data: vector,
      limit: k,
      metric_type: "COSINE",
      // The pk is NOT returned as `id` — it comes back under its own field name,
      // and only when requested. Without this the ids are all `undefined` and the
      // delete silently matches nothing (a clear that reports 0 forever). Asking
      // for just the pk also keeps the 1024-dim vector and the generations blob
      // off the wire.
      output_fields: [primaryField],
      // A clear must see every write that has landed, including one made moments
      // ago; the default bounded staleness could hide it. The SDK types this as a
      // numeric enum but the gRPC layer also accepts the level's name — and the
      // enum's runtime value isn't reachable from a type-only import, which is
      // what keeps the heavy driver out of this module's graph.
      consistency_level: "Strong" as unknown as ConsistencyLevelEnum,
    };
    const resp = await store.client.search(req);
    // Milvus COSINE search returns similarity as `score`.
    const out: { id: string; similarity: number }[] = [];
    for (const r of resp.results ?? []) {
      const id = (r as Record<string, unknown>)[primaryField] ?? r.id;
      if (id !== undefined && id !== null)
        out.push({ id: String(id), similarity: r.score });
    }
    return out;
  }

  // Delete every row, keeping the collection (and its schema/index) — the local
  // Milvus build can fail to recreate a dropped collection, so a filter-delete is
  // the safe "clear all". The autoId Int64 primary key is always >= 0, so this
  // matches everything.
  async clearAll(): Promise<number> {
    const store = (await this.getStore()) as unknown as {
      client: MilvusClient;
      primaryField?: string;
    };
    const client = store.client;
    const name = this.milvusOpts.name;

    const has = await client.hasCollection({ collection_name: name });
    if (!has.value) return 0;

    const primaryField = store.primaryField ?? PRIMARY_FIELD;
    const resp = await client.delete({
      collection_name: name,
      filter: `${primaryField} >= 0`,
    });
    const cnt = Number((resp as { delete_cnt?: string | number }).delete_cnt);
    return Number.isFinite(cnt) ? cnt : 0;
  }

  // Milvus deletes by primary id; the LangChain store has no id-delete helper.
  protected async deleteByIds(ids: string[]): Promise<number> {
    const store = (await this.getStore()) as unknown as { client: MilvusClient };
    const resp = await store.client.delete({
      collection_name: this.milvusOpts.name,
      ids,
    });
    const cnt = Number((resp as { delete_cnt?: string | number }).delete_cnt);
    return Number.isFinite(cnt) ? cnt : ids.length;
  }

  // Milvus COSINE metric → similaritySearchWithScore returns the raw similarity
  // (higher = closer), so use it directly. Unlike the PGVector reference, which
  // returns a distance.
  protected normalizeScore(raw: number): number {
    return raw;
  }

  protected get maxPayloadBytes(): number {
    return MAX_VARCHAR;
  }

  protected async buildStore(): Promise<SemanticVectorStore<string>> {
    const { Milvus } = await import("@langchain/community/vectorstores/milvus");
    return new Milvus(this.milvusOpts.embeddings, {
      collectionName: this.milvusOpts.name,
      url: this.milvusOpts.url,
      clientConfig: this.milvusOpts.token
        ? { address: this.milvusOpts.url, token: this.milvusOpts.token }
        : undefined,
      // We pre-create the collection ourselves, but set COSINE here too because
      // it also drives the metric used at SEARCH time.
      indexCreateOptions: { index_type: "HNSW", metric_type: "COSINE" },
      autoId: true,
    }) as unknown as SemanticVectorStore<string>;
  }

  /**
   * Pre-create the collection with an explicit `generations VarChar(65535)`.
   *
   * LangChain's Milvus store, left to auto-create on the first insert, sizes each
   * metadata VarChar to the longest value *in that first batch* — so the first
   * cached generation would freeze the field length and larger later generations
   * would overflow. Creating the schema up front avoids that (and, as a bonus,
   * sidesteps the "all documents must share metadata keys" check, since LangChain
   * only auto-creates when the collection is missing — which it never is here).
   */
  protected ensureReady(): Promise<void> {
    if (this.usesInjectedStore) return Promise.resolve();
    if (!this.ensured) {
      this.ensured = this.createCollectionIfMissing().catch((err) => {
        this.ensured = undefined; // allow a later retry (e.g. cross-process race)
        throw err;
      });
    }
    return this.ensured;
  }

  private async createCollectionIfMissing(): Promise<void> {
    const store = (await this.getStore()) as unknown as { client: MilvusClient };
    const client = store.client;
    const name = this.milvusOpts.name;

    const has = await client.hasCollection({ collection_name: name });
    if (has.value) return;

    const { DataType } = await import("@zilliz/milvus2-sdk-node");
    // Probe the real embedding dimension (endpoint/model-accurate).
    const dim = (await this.milvusOpts.embeddings.embedQuery("dimension probe")).length;

    await client.createCollection({
      collection_name: name,
      fields: [
        {
          name: "langchain_primaryid",
          description: "Primary key",
          data_type: DataType.Int64,
          is_primary_key: true,
          autoID: true,
        },
        {
          name: "langchain_text",
          description: "Embedded user message",
          data_type: DataType.VarChar,
          type_params: { max_length: String(MAX_VARCHAR) },
        },
        {
          name: "langchain_vector",
          description: "User-message embedding",
          data_type: DataType.FloatVector,
          type_params: { dim: String(dim) },
        },
        {
          name: "generations",
          description: "Serialized LLM generations (JSON)",
          data_type: DataType.VarChar,
          type_params: { max_length: String(MAX_VARCHAR) },
        },
        {
          name: "llmkey",
          description: "sha256 of the model+schema key (namespacing)",
          data_type: DataType.VarChar,
          type_params: { max_length: "64" },
        },
      ],
    });

    await client.createIndex({
      collection_name: name,
      field_name: "langchain_vector",
      extra_params: {
        index_type: "HNSW",
        metric_type: "COSINE",
        params: JSON.stringify({ M: 8, efConstruction: 64 }),
      },
    });
  }
}
