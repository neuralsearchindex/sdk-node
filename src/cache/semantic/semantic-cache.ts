import {
  BaseCache,
  deserializeStoredGeneration,
  serializeGeneration,
} from "@langchain/core/caches";
import type { DocumentInterface } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { Generation } from "@langchain/core/outputs";

import { keyId } from "../hash.js";

/**
 * Backend-agnostic **semantic** cache for LLM generations — the shared core of
 * the Milvus / pgvector / OpenSearch caches. It is the vector-store analogue of
 * LangChain's built-in caches, and a generalization of the reference
 * `PGVectorSemanticCache`.
 *
 * Where the repo's `cached()`/`CachePlugin` layer caches a value under an
 * **exact hash** of its input, this caches a *model call* under the **cosine
 * similarity** of its user message: a call is served from a prior call whose
 * prompt is close enough (>= {@link SemanticCacheOptions.similarityThreshold}).
 * It plugs into any `BaseChatModel` via the `cache` option.
 *
 * Contract (mirrors {@link CachePlugin}): **fail-open**. Every vector-store /
 * embedding error in `lookup`/`update` degrades to a miss / no-op and never
 * breaks the LLM call. Each backend subclass **lazily imports** its heavy driver
 * (`@zilliz/milvus2-sdk-node`, `pg`, `@opensearch-project/opensearch`, …) inside
 * {@link buildStore}, so importing this module (e.g. via the cache barrel) costs
 * nothing when the cache is disabled — which is the default.
 *
 * Subclasses implement the four seams that differ per backend: {@link buildStore},
 * {@link buildFilter} (native filter shape for llmkey namespacing),
 * {@link normalizeScore} (native score → cosine similarity in `[0,1]`), and
 * optionally {@link ensureReady} / {@link maxPayloadBytes}.
 */
export interface SemanticCacheOptions {
  /** Embeddings used to vectorize the user message. Reuse the shared `@neuralsearchindex/embeddings` instance. */
  embeddings: EmbeddingsInterface;
  /** Backend collection / table / index name that stores `(vector, user message, generations, llmkey)` rows. */
  name: string;
  /** Minimum COSINE similarity (0..1) for a hit. High on purpose (semantic ≠ identical). */
  similarityThreshold: number;
  /** Truncate the user message to this many characters before embedding (token-cap guard). */
  maxEmbedChars: number;
  /**
   * Scope hits to the same model+schema by filtering on a hash of the LLM key.
   * Recommended: the parse tools all embed the *same* cleaned markdown, so without
   * this a `location`-parse lookup could return a `price`-parse generation.
   */
  namespaceByLlmKey: boolean;
  /** Injected vector store — for tests. When set, the real store is never built and pre-creation is skipped. */
  store?: SemanticVectorStore;
}

/**
 * The slice of a LangChain vector store this cache actually uses (keeps tests
 * hermetic). `TFilter` is the backend's native filter shape: a string expression
 * for Milvus, a metadata object for pgvector / OpenSearch.
 */
export interface SemanticVectorStore<TFilter = unknown> {
  similaritySearchWithScore(
    query: string,
    k: number,
    filter?: TFilter,
  ): Promise<[DocumentInterface, number][]>;
  addDocuments(documents: DocumentInterface[]): Promise<void>;
  /**
   * Optional: delete rows by store id (LangChain's pgvector store exposes this).
   * The default {@link BaseSemanticCache.deleteByIds} path uses it; backends
   * without it (Milvus, OpenSearch) override `deleteByIds` to use their client.
   */
  delete?(params: { ids?: string[] }): Promise<void>;
}

/** A past user query similar to some input text, for autocomplete. */
export interface QuerySuggestion {
  /** The stored user message (a prior query). */
  text: string;
  /** Cosine similarity (0..1) of the stored message to the input. */
  similarity: number;
}

/** Options for {@link BaseSemanticCache.suggest}. */
export interface SuggestOptions {
  /** Top-k stored entries to inspect. */
  k: number;
  /** Minimum cosine similarity (0..1) for an entry to be suggested. */
  threshold: number;
  /** Drop stored entries longer than this many characters (oversized parse inputs). */
  maxTextChars?: number;
}

/** Options for {@link BaseSemanticCache.clearByQueries}. */
export interface ClearByQueriesOptions {
  /**
   * Minimum cosine similarity (0..1) a stored entry must reach a query to be
   * deleted. Defaults to the cache's own {@link SemanticCacheOptions.similarityThreshold}
   * — i.e. "delete anything that would have been a cache hit for this query".
   */
  threshold?: number;
  /** Max stored entries to inspect per query (top-k). Default 50. */
  k?: number;
}

/**
 * Extract just the user (Human) turn from the `getBufferString`-style prompt
 * LangChain passes to the cache (`"System: …\nHuman: …"`), then truncate it so
 * the embedding stays under the model's token cap. Embedding only the user turn
 * keeps the cache key focused and small.
 */
export function extractUserMessage(prompt: string, maxChars: number): string {
  const marker = "\nHuman: ";
  const idx = prompt.lastIndexOf(marker);
  const msg =
    idx !== -1
      ? prompt.slice(idx + marker.length)
      : prompt.startsWith("Human: ")
        ? prompt.slice("Human: ".length)
        : prompt;
  return msg.length > maxChars ? msg.slice(0, maxChars) : msg;
}

/**
 * Clear the `id` of a cached chat generation's message.
 *
 * A cache HIT returns the *same* serialized AIMessage — including its original
 * `id` — on every hit. LangGraph's `messagesStateReducer` dedupes state messages
 * by `id`: a returned message whose id already exists in the thread's state
 * OVERWRITES that message in place instead of appending. So within a thread that
 * already contains the original (miss) answer, a later cache hit would silently
 * replace the old turn and no new answer would appear ("nothing happens"), while
 * a fresh thread — not yet holding that id — works. Dropping the id makes the
 * reducer assign a new uuid per hit, so every hit appends. Harmless for non-chat
 * generations (no `message`).
 */
export function stripMessageId(generation: Generation): Generation {
  const message = (
    generation as { message?: { id?: string; lc_kwargs?: { id?: string } } }
  ).message;
  if (message) {
    message.id = undefined;
    if (message.lc_kwargs) message.lc_kwargs.id = undefined;
  }
  return generation;
}

export abstract class BaseSemanticCache<TFilter = unknown> extends BaseCache {
  protected readonly opts: SemanticCacheOptions;
  protected readonly usesInjectedStore: boolean;
  private storePromise?: Promise<SemanticVectorStore<TFilter>>;

  constructor(opts: SemanticCacheOptions) {
    super();
    this.opts = opts;
    this.usesInjectedStore = opts.store !== undefined;
  }

  /** Build the backend vector store, lazily importing its driver. Called once, then memoized. */
  protected abstract buildStore(): Promise<SemanticVectorStore<TFilter>>;

  /** Native namespace filter for a given llmkey hash, or `undefined` for no filter. */
  protected abstract buildFilter(llmKeyHash: string): TFilter | undefined;

  /**
   * Convert the backend's raw similarity score into a cosine similarity in `[0,1]`
   * so the single {@link SemanticCacheOptions.similarityThreshold} keeps its meaning
   * across backends. Default: identity (backend already returns cosine similarity).
   */
  protected normalizeScore(raw: number): number {
    return raw;
  }

  /**
   * Pre-create the collection / table / index if the backend needs an explicit
   * schema before the first search. Default: no-op (the store auto-creates on first
   * write, and a lookup before any write fails open to a miss).
   */
  protected ensureReady(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Upper bound (bytes) on the serialized `generations` payload, or `undefined` for
   * no limit. Milvus VarChar caps at 65535; jsonb-backed stores are effectively
   * unbounded. A too-large generation just isn't cached (the next call recomputes).
   */
  protected get maxPayloadBytes(): number | undefined {
    return undefined;
  }

  async lookup(prompt: string, llmKey: string): Promise<Generation[] | null> {
    try {
      await this.ensureReady();
      const store = await this.getStore();
      const userMessage = extractUserMessage(prompt, this.opts.maxEmbedChars);
      const filter = this.opts.namespaceByLlmKey
        ? this.buildFilter(keyId(llmKey))
        : undefined;

      const results = await store.similaritySearchWithScore(
        userMessage,
        1,
        filter,
      );
      if (results.length === 0) return null;

      const [doc, raw] = results[0];
      const similarity = this.normalizeScore(raw);
      if (similarity < this.opts.similarityThreshold) {
        console.log(`[model cache MISS] best=${similarity.toFixed(4)}`);
        return null;
      }

      // Some stores (e.g. Milvus) auto-parse JSON string metadata on read, so
      // `generations` may come back already parsed (array) or, from other writers,
      // as a string.
      const stored = parseGenerations(
        (doc.metadata as Record<string, unknown>).generations,
      );
      console.log(`[model cache HIT] similarity=${similarity.toFixed(4)}`);
      return stored.map((g) =>
        stripMessageId(deserializeStoredGeneration(g as never)),
      );
    } catch (error) {
      console.log("[model cache]", error);
      // fail-open: collection-not-found (first run), embed overflow, store down, …
      return null;
    }
  }

  async update(
    prompt: string,
    llmKey: string,
    generations: Generation[],
  ): Promise<void> {
    try {
      await this.ensureReady();
      const store = await this.getStore();
      const userMessage = extractUserMessage(prompt, this.opts.maxEmbedChars);
      const generationsJson = JSON.stringify(
        generations.map(serializeGeneration),
      );

      // Don't attempt an insert the backend will reject; a too-large generation just
      // isn't cached (the next identical call recomputes it).
      const cap = this.maxPayloadBytes;
      if (cap !== undefined && Buffer.byteLength(generationsJson, "utf8") > cap)
        return;

      await store.addDocuments([
        {
          pageContent: userMessage,
          // `llmkey` is a schema field for some backends, so it MUST always be
          // present (empty when namespacing is off) — Milvus's `addVectors` throws
          // on any missing schema field.
          metadata: {
            generations: generationsJson,
            llmkey: this.opts.namespaceByLlmKey ? keyId(llmKey) : "",
          },
        },
      ]);
      console.log("[model cache STORE]");
    } catch (error) {
      console.log("[model cache]", error);
      // fail-open: a failed write just means the next call recomputes.
    }
  }

  /**
   * Semantically purge cached generations: for each query, embed it, find every
   * stored entry whose cosine similarity is `>= threshold`, and delete those
   * rows — keeping the collection / table / index itself (schema untouched).
   *
   * This is the query-driven analogue of an exact-key purge: you don't need the
   * stored keys, only example prompts — anything a query would have *hit* is
   * removed. Returns the number of rows deleted (best effort). **Fail-open**:
   * any embedding / store error yields `0`, never a throw. Unlike a key purge it
   * needs the embeddings endpoint (each query is embedded to search).
   */
  async clearByQueries(
    queries: string[],
    options: ClearByQueriesOptions = {},
  ): Promise<number> {
    const threshold = options.threshold ?? this.opts.similarityThreshold;
    const k = options.k ?? 50;
    if (queries.length === 0) return 0;
    try {
      await this.ensureReady();
      const ids = new Set<string>();
      for (const query of queries) {
        const userMessage = extractUserMessage(query, this.opts.maxEmbedChars);
        for (const match of await this.searchIds(userMessage, k)) {
          if (match.similarity >= threshold) ids.add(match.id);
        }
      }
      if (ids.size === 0) return 0;
      return await this.deleteByIds([...ids]);
    } catch (error) {
      console.log("[model cache]", error);
      return 0;
    }
  }

  /**
   * Delete EVERY cached entry, keeping the collection / table / index (schema
   * intact) so the next write needn't recreate it — which matters on backends
   * where recreation is fragile. Backend-specific: each store overrides this with
   * its native "delete all" (Milvus filter-delete, pgvector `DELETE FROM`,
   * OpenSearch `delete_by_query match_all`). Returns the number of rows removed.
   *
   * Unlike {@link clearByQueries} this is NOT fail-open: an admin/maintenance
   * clear should surface a backend error rather than silently report 0.
   */
  async clearAll(): Promise<number> {
    throw new Error(`clearAll is not implemented for ${this.constructor.name}`);
  }

  /**
   * Top-k past user messages whose cosine similarity to `query` is
   * `>= threshold`, for autocomplete. Draws from **all namespaces** (no llmkey
   * filter) — the corpus of every prior query, not one model+schema — then
   * dedupes by text (case-insensitive) and drops empty / oversized entries
   * (e.g. cleaned-markdown parse inputs). Similarity order is preserved.
   *
   * **Fail-open** like {@link lookup} / {@link clearByQueries}: any embedding /
   * store error yields `[]`, never a throw.
   */
  async suggest(
    query: string,
    options: SuggestOptions,
  ): Promise<QuerySuggestion[]> {
    const { k, threshold, maxTextChars } = options;
    try {
      await this.ensureReady();
      const store = await this.getStore();
      const userMessage = extractUserMessage(query, this.opts.maxEmbedChars);
      // No filter: autocomplete draws from every namespace, not one llmkey.
      const results = await store.similaritySearchWithScore(userMessage, k);

      const out: QuerySuggestion[] = [];
      const seen = new Set<string>();
      for (const [doc, raw] of results) {
        const similarity = this.normalizeScore(raw);
        if (similarity < threshold) continue;
        const text = (doc.pageContent ?? "").trim();
        if (!text) continue;
        if (maxTextChars && text.length > maxTextChars) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ text, similarity });
      }
      return out;
    } catch (error) {
      console.log("[model cache]", error);
      return [];
    }
  }

  /**
   * Store a free-form text RECORD in a per-namespace collection, reusing this
   * cache's vector-store plumbing (`buildStore`/`buildFilter`/`normalizeScore`).
   * The `namespace` (e.g. a user id) is hashed into the same `llmkey` field the
   * LLM cache uses for scoping, so records stay isolated per namespace. This is
   * the generic seam durable "fact" collections build on — separate from the
   * prompt→generation cache semantics (`lookup`/`update`). **Fail-open**: any
   * embedding / store error is a no-op, never a throw.
   *
   * Use a DEDICATED collection for records so they never mix with cached
   * generations. Requires `namespaceByLlmKey` on so `searchRecords` can filter.
   */
  async storeRecord(namespace: string, text: string): Promise<void> {
    try {
      await this.ensureReady();
      const store = await this.getStore();
      await store.addDocuments([
        {
          pageContent: text,
          // `generations` is a schema field on some backends (Milvus) so it must
          // be present; records don't use it. `llmkey` carries the namespace.
          metadata: { generations: "[]", llmkey: keyId(namespace) },
        },
      ]);
    } catch (error) {
      console.log("[semantic record]", error);
    }
  }

  /**
   * Top-k stored RECORDS in `namespace` whose cosine similarity to `query` is
   * `>= threshold`, deduped by text (case-insensitive), similarity order
   * preserved. The counterpart to {@link storeRecord}. **Fail-open** → `[]`.
   */
  async searchRecords(
    namespace: string,
    query: string,
    options: SuggestOptions,
  ): Promise<QuerySuggestion[]> {
    const { k, threshold, maxTextChars } = options;
    if (!query.trim()) return [];
    try {
      await this.ensureReady();
      const store = await this.getStore();
      const filter = this.buildFilter(keyId(namespace));
      const results = await store.similaritySearchWithScore(query, k, filter);

      const out: QuerySuggestion[] = [];
      const seen = new Set<string>();
      for (const [doc, raw] of results) {
        const similarity = this.normalizeScore(raw);
        if (similarity < threshold) continue;
        const text = (doc.pageContent ?? "").trim();
        if (!text) continue;
        if (maxTextChars && text.length > maxTextChars) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ text, similarity });
      }
      return out;
    } catch (error) {
      console.log("[semantic record]", error);
      return [];
    }
  }

  /**
   * Candidate `(id, cosineSimilarity)` pairs for a user message — the seam
   * {@link clearByQueries} filters by threshold. Default: the shared vector
   * store's `similaritySearchWithScore` plus the hit's `id`, which works for the
   * pgvector / OpenSearch stores (they return the primary id on each document).
   * Milvus overrides this — LangChain drops the `autoId` primary key from its
   * search output, so it must query the client directly.
   */
  protected async searchIds(
    userMessage: string,
    k: number,
  ): Promise<{ id: string; similarity: number }[]> {
    const store = await this.getStore();
    const results = await store.similaritySearchWithScore(userMessage, k);
    const out: { id: string; similarity: number }[] = [];
    for (const [doc, raw] of results) {
      const id = (doc as { id?: string | number }).id;
      if (id !== undefined && id !== null)
        out.push({ id: String(id), similarity: this.normalizeScore(raw) });
    }
    return out;
  }

  /** Delete rows by store id (backend-specific). Returns the number removed. */
  protected async deleteByIds(ids: string[]): Promise<number> {
    const store = await this.getStore();
    if (store.delete) {
      await store.delete({ ids });
      return ids.length;
    }
    return 0;
  }

  /**
   * List stored RECORDS in `namespace` as `(id, text)` WITHOUT a query vector —
   * a metadata scan by the namespace's llmkey hash. The read side of a user-facing
   * memory manager (the counterpart to {@link storeRecord}). Does NOT `ensureReady`
   * so a mere list never CREATES a collection/index — each backend's
   * {@link listByNamespace} treats a missing store as "empty". NOT fail-open:
   * surfaces backend errors so the caller can report them.
   */
  async listRecords(
    namespace: string,
    options: { limit?: number } = {},
  ): Promise<{ id: string; text: string }[]> {
    return this.listByNamespace(keyId(namespace), options.limit ?? 100);
  }

  /**
   * Delete a single stored record by id, but ONLY if it belongs to `namespace`
   * (guards against deleting another namespace's record by guessing an id).
   * Returns true iff a row was removed. NOT fail-open.
   */
  async deleteRecord(namespace: string, id: string): Promise<boolean> {
    const owned = await this.listByNamespace(keyId(namespace), 1000);
    if (!owned.some((r) => r.id === id)) return false;
    return (await this.deleteByIds([id])) > 0;
  }

  /**
   * Add a durable record to `namespace`, skipping near-duplicates (an existing
   * record with cosine similarity `>= dedupeThreshold`). Returns true iff stored.
   * Uses the {@link storeRecord} write path (fail-open) — the caller should
   * re-list to confirm; a store error therefore surfaces as "didn't appear".
   */
  async addRecord(
    namespace: string,
    text: string,
    options: { dedupeThreshold?: number } = {},
  ): Promise<boolean> {
    const clean = text.trim();
    if (!clean) return false;
    const dupes = await this.searchRecords(namespace, clean, {
      k: 3,
      threshold: options.dedupeThreshold ?? 0.92,
    });
    if (dupes.length > 0) return false;
    await this.storeRecord(namespace, clean);
    return true;
  }

  /**
   * Backend-specific: list `(id, text)` for every record matching `llmKeyHash`,
   * up to `limit`, via a metadata scan with NO query vector. Overridden per
   * backend (raw SQL SELECT / Milvus `client.query` / OpenSearch term search). A
   * missing collection/index returns `[]`. Default throws (like {@link clearAll}).
   */
  protected async listByNamespace(
    _llmKeyHash: string,
    _limit: number,
  ): Promise<{ id: string; text: string }[]> {
    throw new Error(
      `listByNamespace is not implemented for ${this.constructor.name}`,
    );
  }

  /**
   * List up to `limit` stored records (id + text) across ALL namespaces, starting
   * at `offset` — the store-wide counterpart to {@link listRecords}, for admin
   * inspection of a whole collection. No query vector (a metadata/primary scan).
   * A missing collection returns `[]`. NOT fail-open: surfaces backend errors.
   */
  async listAll(
    limit = 100,
    offset = 0,
  ): Promise<{ id: string; text: string }[]> {
    return this.listAllRecords(limit, offset);
  }

  /**
   * Backend-specific store-wide scan (no `llmkey` filter). Overridden per backend
   * (Milvus `client.query` / pgvector `SELECT` / OpenSearch `match_all`). A missing
   * collection returns `[]`. Default throws (like {@link listByNamespace}).
   */
  protected async listAllRecords(
    _limit: number,
    _offset: number,
  ): Promise<{ id: string; text: string }[]> {
    throw new Error(
      `listAllRecords is not implemented for ${this.constructor.name}`,
    );
  }

  /**
   * Delete stored records by store id — no namespace guard (unlike
   * {@link deleteRecord}). For admin invalidation of entries surfaced by
   * {@link listAll}. Returns the number of rows removed.
   */
  async deleteEntries(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return this.deleteByIds(ids);
  }

  /** Lazily build (and memoize) the vector store, importing the backend driver only on first use. */
  protected getStore(): Promise<SemanticVectorStore<TFilter>> {
    if (this.opts.store)
      return Promise.resolve(this.opts.store as SemanticVectorStore<TFilter>);
    if (!this.storePromise) {
      this.storePromise = this.buildStore().catch((err) => {
        this.storePromise = undefined; // allow a later retry
        throw err;
      });
    }
    return this.storePromise;
  }
}

/** Read the stored `generations` metadata, tolerating either a JSON string or an already-parsed array. */
function parseGenerations(raw: unknown): unknown[] {
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as unknown[];
}
