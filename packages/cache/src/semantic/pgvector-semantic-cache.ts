import {
  BaseSemanticCache,
  type SemanticCacheOptions,
  type SemanticVectorStore,
} from "./semantic-cache.js";

/**
 * A pgvector-backed **semantic** cache for LLM generations. The Postgres binding
 * of {@link BaseSemanticCache}: it namespaces via a jsonb metadata filter and
 * reads a cosine **distance** from pgvector's `<=>` operator, which
 * {@link normalizeScore} flips back into a cosine similarity.
 *
 * The heavy `pg` + `@langchain/community` modules are **lazily imported** on first
 * use, so importing this file costs nothing when the cache is disabled.
 */
export interface PgVectorSemanticCacheOptions extends SemanticCacheOptions {
  /** Postgres connection URL, e.g. `postgres://user:pass@host:5432/db`. */
  connectionString: string;
}

/** pgvector metadata is jsonb — filter with `{ [field]: value }`. */
type MetadataFilter = Record<string, unknown>;

export class PgVectorSemanticCache extends BaseSemanticCache<MetadataFilter> {
  private readonly pgOpts: PgVectorSemanticCacheOptions;

  constructor(opts: PgVectorSemanticCacheOptions) {
    super(opts);
    this.pgOpts = opts;
  }

  protected buildFilter(llmKeyHash: string): MetadataFilter {
    // PGVectorStore turns this into `metadata->>'llmkey' = $n`.
    return { llmkey: llmKeyHash };
  }

  // Delete every row, keeping the table (schema intact). getStore() has already
  // run PGVectorStore.initialize, so the table exists. The table name is config,
  // not user input, but sanitize the identifier defensively.
  async clearAll(): Promise<number> {
    const store = (await this.getStore()) as unknown as {
      pool: { query(sql: string): Promise<{ rowCount?: number | null }> };
    };
    const table = this.pgOpts.name.replace(/[^A-Za-z0-9_]/g, "_");
    const resp = await store.pool.query(`DELETE FROM "${table}"`);
    return resp.rowCount ?? 0;
  }

  // Metadata scan (no query vector): every row whose jsonb `llmkey` matches, for
  // the memory manager. getStore() ran PGVectorStore.initialize, so the table
  // exists. Table name is config, not user input, but sanitize defensively.
  protected async listByNamespace(
    llmKeyHash: string,
    limit: number,
  ): Promise<{ id: string; text: string }[]> {
    const store = (await this.getStore()) as unknown as {
      pool: {
        query(
          sql: string,
          params: unknown[],
        ): Promise<{ rows: { id: string | number; content: string }[] }>;
      };
    };
    const table = this.pgOpts.name.replace(/[^A-Za-z0-9_]/g, "_");
    const resp = await store.pool.query(
      `SELECT id, content FROM "${table}" WHERE metadata->>'llmkey' = $1 LIMIT $2`,
      [llmKeyHash, limit],
    );
    return resp.rows.map((r) => ({ id: String(r.id), text: r.content }));
  }

  // pgvector's `<=>` under the cosine strategy returns a cosine *distance*
  // (0 = identical, 2 = opposite). Flip it to a similarity in [-1, 1].
  protected normalizeScore(distance: number): number {
    return 1 - distance;
  }

  protected async buildStore(): Promise<SemanticVectorStore<MetadataFilter>> {
    // Create our own pool so we can guarantee the `vector` extension exists before
    // LangChain tries to create the table against it.
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: this.pgOpts.connectionString });
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

    const { PGVectorStore } = await import("@langchain/community/vectorstores/pgvector");
    // `initialize` creates the table (content text, metadata jsonb, vector) if it
    // is missing, so no separate `ensureReady` schema step is needed.
    const store = await PGVectorStore.initialize(this.pgOpts.embeddings, {
      pool,
      tableName: this.pgOpts.name,
      distanceStrategy: "cosine",
      columns: {
        idColumnName: "id",
        vectorColumnName: "vector",
        contentColumnName: "content",
        metadataColumnName: "metadata",
      },
    });
    return store as unknown as SemanticVectorStore<MetadataFilter>;
  }
}
