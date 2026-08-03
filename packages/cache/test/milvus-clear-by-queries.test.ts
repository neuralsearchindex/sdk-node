import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MilvusSemanticCache } from "../src/semantic/milvus-semantic-cache.js";
import type { SemanticVectorStore } from "../src/semantic/semantic-cache.js";

/**
 * Covers the Milvus `searchIds` / `deleteByIds` overrides, which the base-class
 * suite (clear-by-queries.test.ts) cannot reach.
 *
 * Regression: Milvus does NOT return the primary key as `id` on a search hit —
 * it comes back under the pk's own field name, and only when listed in
 * `output_fields`. Reading `r.id` yielded `String(undefined)` for every hit, so
 * the delete matched nothing and every clear reported 0 while the cache kept
 * serving hits. The fake client below mimics that shape.
 */

type Row = { pk: string; similarity: number };

const PK = "langchain_primaryid";

function makeCache(rows: Row[], threshold = 0.9) {
  const calls = { search: [] as Record<string, unknown>[], deleted: [] as string[][] };

  const client = {
    async loadCollectionSync() {},
    async search(req: Record<string, unknown>) {
      calls.search.push(req);
      const fields = (req.output_fields as string[]) ?? [];
      const limit = (req.limit as number) ?? rows.length;
      return {
        results: rows.slice(0, limit).map((r) => ({
          score: r.similarity,
          // Only echo the pk when it was actually requested — exactly what
          // Milvus does, and the crux of the bug.
          ...(fields.includes(PK) ? { [PK]: r.pk } : {}),
        })),
      };
    },
    async delete({ ids }: { ids?: string[] }) {
      const removed = ids ?? [];
      calls.deleted.push(removed);
      rows = rows.filter((r) => !removed.includes(r.pk));
      return { delete_cnt: String(removed.length) };
    },
  };

  // The injected store doubles as the client holder: the Milvus overrides reach
  // through `store.client`, and injecting a store also skips collection creation.
  const store = { client, primaryField: PK } as unknown as SemanticVectorStore<string>;

  const cache = new MilvusSemanticCache({
    embeddings: {
      embedQuery: async () => [0.1, 0.2],
      embedDocuments: async () => [],
    } as unknown as EmbeddingsInterface,
    name: "test_cache",
    similarityThreshold: threshold,
    maxEmbedChars: 8000,
    namespaceByLlmKey: false,
    url: "unused:19530",
    store,
  });

  return { cache, calls };
}

describe("MilvusSemanticCache.clearByQueries", () => {
  it("reads the primary key from its field name and deletes matching rows", async () => {
    const { cache, calls } = makeCache([
      { pk: "468045395740026240", similarity: 1 },
      { pk: "468045395740026241", similarity: 0.5459 },
    ]);

    const removed = await cache.clearByQueries(["Cheapest apartments in Basel"], {
      threshold: 0.9,
      k: 100,
    });

    assert.equal(removed, 1);
    assert.deepEqual(calls.deleted, [["468045395740026240"]]);
  });

  it("requests the primary key so hits carry an id", async () => {
    const { cache, calls } = makeCache([{ pk: "1", similarity: 0.99 }]);

    await cache.clearByQueries(["q"], { threshold: 0.9, k: 25 });

    assert.equal(calls.search.length, 1);
    assert.deepEqual(calls.search[0].output_fields, [PK]);
    assert.equal(calls.search[0].limit, 25);
    assert.equal(calls.search[0].metric_type, "COSINE");
  });

  it("skips hits with no usable id rather than deleting 'undefined'", async () => {
    // A backend that returns a score but no pk at all — the pre-fix shape.
    const deleted: string[][] = [];
    const idless = {
      async loadCollectionSync() {},
      async search() {
        return { results: [{ score: 0.99 }] };
      },
      async delete({ ids }: { ids?: string[] }) {
        deleted.push(ids ?? []);
        return { delete_cnt: String((ids ?? []).length) };
      },
    };
    const store = { client: idless } as unknown as SemanticVectorStore<string>;
    const cacheNoPk = new MilvusSemanticCache({
      embeddings: {
        embedQuery: async () => [0.1],
        embedDocuments: async () => [],
      } as unknown as EmbeddingsInterface,
      name: "test_cache",
      similarityThreshold: 0.9,
      maxEmbedChars: 8000,
      namespaceByLlmKey: false,
      url: "unused:19530",
      store,
    });

    assert.equal(await cacheNoPk.clearByQueries(["q"]), 0);
    assert.equal(deleted.length, 0);
  });
});
