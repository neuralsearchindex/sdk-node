import type { DocumentInterface } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PgVectorSemanticCache } from "../src/semantic/pgvector-semantic-cache.js";
import type { SemanticVectorStore } from "../src/semantic/semantic-cache.js";

/**
 * Exercises the user-facing record management surface (`listRecords`,
 * `deleteRecord`'s namespace ownership guard, and `addRecord`'s dedupe) via the
 * pgvector binding — its `listByNamespace` reads the raw `store.pool.query`, so
 * the fake store below implements both the vector-store slice AND a `pool`. No
 * Postgres, no embeddings endpoint. Namespaces are hashed internally to `llmkey`,
 * so seeding through `storeRecord` keeps the hashing consistent for free.
 */

type Record = { id: string; llmkey: string; content: string };

class FakeStore implements SemanticVectorStore {
  records: Record[] = [];
  private nextId = 1;

  // pgvector's listByNamespace() calls this raw handle.
  pool = {
    query: async (
      _sql: string,
      params: unknown[],
    ): Promise<{ rows: { id: string; content: string }[] }> => {
      const [llmkey, limit] = params as [string, number];
      const rows = this.records
        .filter((r) => r.llmkey === llmkey)
        .slice(0, limit)
        .map((r) => ({ id: r.id, content: r.content }));
      return { rows };
    },
  };

  async similaritySearchWithScore(
    query: string,
    k: number,
    filter?: Record | { llmkey?: string },
  ): Promise<[DocumentInterface, number][]> {
    const key = (filter as { llmkey?: string } | undefined)?.llmkey;
    // Model "near-dupe" as an exact-content match within the namespace.
    return this.records
      .filter((r) => (!key || r.llmkey === key) && r.content === query)
      .slice(0, k)
      .map((r) => [
        { pageContent: r.content, metadata: {}, id: r.id } as unknown as DocumentInterface,
        0, // cosine distance 0 → similarity 1 after normalizeScore
      ]);
  }

  async addDocuments(docs: DocumentInterface[]): Promise<void> {
    for (const d of docs) {
      this.records.push({
        id: String(this.nextId++),
        llmkey: String((d.metadata as { llmkey?: string }).llmkey ?? ""),
        content: d.pageContent,
      });
    }
  }

  async delete({ ids }: { ids?: string[] }): Promise<void> {
    const removed = ids ?? [];
    this.records = this.records.filter((r) => !removed.includes(r.id));
  }
}

function makeCache(store: FakeStore) {
  const embeddings = {
    embedQuery: async () => [0],
    embedDocuments: async (t: string[]) => t.map(() => [0]),
  } as unknown as EmbeddingsInterface;
  return new PgVectorSemanticCache({
    embeddings,
    name: "user_facts",
    similarityThreshold: 0.9,
    maxEmbedChars: 1000,
    namespaceByLlmKey: true,
    connectionString: "postgres://unused",
    store,
  });
}

describe("record management (list / delete / add)", () => {
  it("lists only the namespace's own records", async () => {
    const store = new FakeStore();
    const cache = makeCache(store);
    await cache.storeRecord("userA", "likes gardens");
    await cache.storeRecord("userA", "has two kids");
    await cache.storeRecord("userB", "wants a garage");

    const a = await cache.listRecords("userA");
    assert.deepEqual(
      a.map((r) => r.text).sort(),
      ["has two kids", "likes gardens"],
    );
    const b = await cache.listRecords("userB");
    assert.deepEqual(b.map((r) => r.text), ["wants a garage"]);
  });

  it("deleteRecord removes an owned id and refuses a foreign one", async () => {
    const store = new FakeStore();
    const cache = makeCache(store);
    await cache.storeRecord("userA", "likes gardens");
    await cache.storeRecord("userB", "wants a garage");

    const bId = (await cache.listRecords("userB"))[0].id;
    // userA cannot delete userB's record even knowing its id.
    assert.equal(await cache.deleteRecord("userA", bId), false);
    assert.equal((await cache.listRecords("userB")).length, 1);

    const aId = (await cache.listRecords("userA"))[0].id;
    assert.equal(await cache.deleteRecord("userA", aId), true);
    assert.equal((await cache.listRecords("userA")).length, 0);
  });

  it("addRecord stores new text and skips a near-duplicate", async () => {
    const store = new FakeStore();
    const cache = makeCache(store);

    assert.equal(await cache.addRecord("userA", "likes gardens"), true);
    assert.equal((await cache.listRecords("userA")).length, 1);
    // Same text again → deduped, not stored twice.
    assert.equal(await cache.addRecord("userA", "likes gardens"), false);
    assert.equal((await cache.listRecords("userA")).length, 1);
    // Blank → ignored.
    assert.equal(await cache.addRecord("userA", "   "), false);
    assert.equal((await cache.listRecords("userA")).length, 1);
  });
});
