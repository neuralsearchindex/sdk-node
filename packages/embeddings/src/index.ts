import { CohereEmbeddings } from "@langchain/cohere";
import { OpenAIEmbeddings } from "@langchain/openai";
import type { Embeddings } from "@langchain/core/embeddings";

function makeTextEmbeddings(modelName: string): Embeddings {
  /**
   * Connect to the configured text encoder. The model name may be prefixed
   * with a provider (e.g. "cohere/embed-english-v3.0"); when no provider is
   * included we assume OpenAI, targeting the local OpenAI-compatible server.
   */
  const index = modelName.indexOf("/");
  let provider: string;
  let model: string;
  if (index === -1) {
    model = modelName;
    provider = "openai"; // Assume openai if no provider included
  } else {
    provider = modelName.slice(0, index);
    model = modelName.slice(index + 1);
  }

  switch (provider) {
    case "openai":
      return new OpenAIEmbeddings({
        apiKey: process.env.OPENAI_API_KEY,
        model,
        configuration: {
          // Prefer a dedicated bge-m3-embeddings endpoint; fall back to the
          // shared OpenAI base URL when unset.
          baseURL:
            process.env.BGE_M3_BASE_URL ??
            process.env.OPENAI_API_BASE_URL,
          // Force native fetch (undici); node-fetch@2 breaks on Brotli under Node 24.
          fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
        },
      });
    case "cohere":
      return new CohereEmbeddings({ apiKey: process.env.COHERE_API_KEY, model });
    default:
      throw new Error(`Unsupported embedding provider: ${provider}`);
  }
}

/**
 * Embeddings shared by the browser and content tools. Defaults to the local
 * OpenAI-compatible server (e.g. LM Studio) used by the rest of the agent.
 * Override with EMBEDDINGS_MODEL, optionally prefixing a provider, e.g.
 * "cohere/embed-english-v3.0".
 */
export const embeddings = makeTextEmbeddings(
  process.env.EMBEDDINGS_MODEL ?? "text-embedding-3-small",
);
