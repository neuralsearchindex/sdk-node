import type { DocumentInterface } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PgVectorSemanticCache } from "../src/semantic/pgvector-semantic-cache.js";
import type { SemanticVectorStore } from "../src/semantic/semantic-cache.js";

/**
 * Exercises the backend-agnostic `clearByQueries` logic (threshold gate + dedupe
 * + delete) via the pgvector binding, which uses the base `searchIds`/`deleteByIds`
 * seams (hit `id` + `store.delete({ ids })`). An injected fake store keeps it
 * hermetic — no Postgres, no embeddings endpoint.
 */

type Row = { id: string; similarity: number };

class FakeStore implements SemanticVectorStore {
  deleteCalls: string[][] = [];
  constructor(private rows: Row[]) {}

  // pgvector returns a cosine *distance*; the cache's normalizeScore flips it
  // back to a similarity via `1 - distance`, so emit `1 - similarity` here.
  async similaritySearchWithScore(
    _query: string,
    k: number,
  ): Promise<[DocumentInterface, number][]> {
    return this.rows
      .slice(0, k)
      .map((r) => [
        {
          pageContent: "",
          metadata: {},
          id: r.id,
        } as unknown as DocumentInterface,
        1 - r.similarity,
      ]);
  }

  async addDocuments(): Promise<void> {}

  async delete({ ids }: { ids?: string[] }): Promise<void> {
    const removed = ids ?? [];
    this.deleteCalls.push(removed);
    this.rows = this.rows.filter((r) => !removed.includes(r.id));
  }
}

function makeCache(rows: Row[], threshold = 0.9) {
  const store = new FakeStore(rows);
  const embeddings = {
    embedQuery: async () => [],
    embedDocuments: async () => [],
  } as unknown as EmbeddingsInterface;
  const cache = new PgVectorSemanticCache({
    embeddings,
    name: "test_cache",
    similarityThreshold: threshold,
    maxEmbedChars: 8000,
    namespaceByLlmKey: false,
    connectionString: "postgres://unused",
    store,
  });
  return { cache, store };
}

describe("BaseSemanticCache.clearByQueries", () => {
  it("deletes only entries at/above the threshold", async () => {
    const { cache, store } = makeCache([
      { id: "a", similarity: 0.97 },
      { id: "b", similarity: 0.8 },
      { id: "c", similarity: 0.999 },
    ]);

    const removed = await cache.clearByQueries(["find me a home"], {
      threshold: 0.9,
    });

    assert.equal(removed, 2);
    assert.deepEqual(store.deleteCalls, [["a", "c"]]);
  });

  it("dedupes ids matched by multiple queries into one delete", async () => {
    const { cache, store } = makeCache([
      { id: "a", similarity: 0.97 },
      { id: "b", similarity: 0.95 },
    ]);

    const removed = await cache.clearByQueries(["q1", "q2", "q3"], {
      threshold: 0.9,
    });

    assert.equal(removed, 2);
    assert.equal(store.deleteCalls.length, 1);
    assert.deepEqual([...store.deleteCalls[0]].sort(), ["a", "b"]);
  });

  it("falls back to the cache's own similarityThreshold", async () => {
    const { cache, store } = makeCache(
      [
        { id: "a", similarity: 0.9 },
        { id: "b", similarity: 0.7 },
      ],
      0.85,
    );

    const removed = await cache.clearByQueries(["q"]);

    assert.equal(removed, 1);
    assert.deepEqual(store.deleteCalls, [["a"]]);
  });

  it("does nothing (no delete) with no queries or no matches", async () => {
    const { cache, store } = makeCache([{ id: "a", similarity: 0.5 }]);

    assert.equal(await cache.clearByQueries([]), 0);
    assert.equal(await cache.clearByQueries(["q"], { threshold: 0.9 }), 0);
    assert.equal(store.deleteCalls.length, 0);
  });
});
