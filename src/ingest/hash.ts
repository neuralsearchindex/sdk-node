// Content hashes of a listing's EMBEDDING INPUTS, used to skip re-embedding an
// unchanged listing. The ingestion-pipeline stamps these on the document (see
// `ad-to-row` / `vehicles`), and on a later run compares the freshly-computed
// hash against the stored one: an identical hash + already-present vectors means
// the expensive embed step can be skipped entirely and only the scalar fields
// patched. A changed hash re-embeds and fully re-indexes, so edits are never stale.
import { createHash } from "node:crypto";

/**
 * Stable hash of a listing's DENSE+SPARSE text inputs. Both text legs derive only
 * from the sparse composite `text` and the source-selected dense `chunks`, so this
 * one hash covers both — if either input changes the hash changes and we re-embed.
 */
export function textEmbeddingHash(text: string, chunks: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ t: text, c: chunks }))
    .digest("hex");
}

/** Stable hash of the capped, ordered image URL list (the CLIP inputs). */
export function imageEmbeddingHash(urls: string[]): string {
  return createHash("sha256").update(JSON.stringify(urls)).digest("hex");
}
