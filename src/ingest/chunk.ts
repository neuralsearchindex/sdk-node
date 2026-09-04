// Markdown-aware text chunking for the dense-embedding leg. A listing's text
// (the description composite, or the full cleaned `pageContent`) is split into
// bounded chunks, each embedded into its own dense vector and stored as one
// element of the nested `page_content_chunks` field — the text analogue of the
// nested per-photo `images.image_vector`. This is what removes the old single
// truncated-at-MAX_TEXT_CHARS dense vector: a listing now contributes 1..N chunk
// vectors instead of one.
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

/** Target characters per chunk. */
export const CHUNK_SIZE = 1000;
/** Overlap between adjacent chunks (keeps context across boundaries). */
export const CHUNK_OVERLAP = 150;
/** DEFAULT cap on chunks per listing; overridden per-pipeline by the admin (mirrors maxImages). */
export const MAX_TEXT_CHUNKS = 20;

const splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
  chunkSize: CHUNK_SIZE,
  chunkOverlap: CHUNK_OVERLAP
});

/**
 * Markdown-aware split of `text` into at most `maxChunks` chunks. Returns `[]`
 * for empty/blank input (⇒ a text-only doc with no chunk vectors, the same
 * "embeddings-off" contract as a listing with no dense vector today).
 */
export async function splitMarkdown(text: string, maxChunks: number = MAX_TEXT_CHUNKS): Promise<string[]> {
  const t = (text ?? "").trim();
  if (!t) return [];
  const docs = await splitter.splitText(t);
  return docs.slice(0, Math.max(1, maxChunks));
}
