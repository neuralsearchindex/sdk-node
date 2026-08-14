import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { initChatModel } from "langchain/chat_models/universal";
import { getModelCache } from "@local-llm/cache/semantic";

export interface LoadChatModelOptions {
  /** See note above — default OFF. */
  semanticCache?: boolean;
  /**
   * Disable reasoning/thinking traces. Sends both the OpenAI-native
   * `reasoning_effort` and the vLLM/SGLang `chat_template_kwargs` toggle,
   * since our base URL may point at either. Unknown fields are ignored by
   * OpenAI-compatible servers, so sending both is safe.
   */
  disableThinking?: boolean;
  /** Escape hatch: merged into the raw request body verbatim. */
  modelKwargs?: Record<string, unknown>;
  /** Standard sampling params, passed through to initChatModel. */
  temperature?: number;
  maxTokens?: number;
  /** Set when OPENAI_API_BASE_URL points at vLLM/SGLang rather than OpenAI. */
  selfHosted?: boolean;
  /**
   * OpenAI prompt-cache routing key. Caching itself is automatic (prefixes
   * >~1024 tokens); this only biases requests sharing a key toward the same
   * backend, which raises hit rate above ~15 req/min on a given prefix.
   * Bump the version suffix whenever the stable prefix changes, so stale
   * entries aren't kept warm. Skipped when selfHosted — vLLM 400s on it.
   */
  promptCacheKey?: string;
}

const OPENAI_HOSTS = ["api.openai.com"];

function isOpenAIProper(): boolean {
  const base = process.env.OPENAI_API_BASE_URL;
  if (!base) return true; // SDK default is api.openai.com
  try {
    return OPENAI_HOSTS.includes(new URL(base).hostname);
  } catch {
    return false;
  }
}

/**
 * Version suffix for all prompt cache keys. Bump on any deploy that changes
 * a stable prompt prefix, so stale entries aren't kept warm by routing.
 */
const PROMPT_CACHE_VERSION = process.env.PROMPT_CACHE_VERSION ?? "v1";

/**
 * Default routing key. Model-scoped rather than global: the key only helps
 * when requests sharing it also share a prefix, and different models never
 * do. Call sites with a distinct system prompt should pass their own.
 */
function defaultPromptCacheKey(model: string): string {
  return `${model.replace(/[^a-zA-Z0-9._-]/g, "-")}-${PROMPT_CACHE_VERSION}`;
}

/**
 * Load a chat model from a fully specified name.
 *
 * @param fullySpecifiedName - String in the format 'provider/model' or 'provider/account/provider/model'.
 * @param options.semanticCache - Opt IN to the Milvus semantic LLM cache
 *   (when MODEL_CACHE_ENABLED=true). Default OFF: the cache keys on the
 *   semantic similarity of the user message, and the extraction tools all
 *   run different structured-output schemas over the SAME page content — a
 *   near-identical prompt with a different schema returns the wrong
 *   generation (observed: a measurements parse served a property-listing JSON).
 *   Only long-form conversational calls (chat agent, RAG respond) should
 *   opt in.
 * @returns A Promise that resolves to a BaseChatModel instance.
 */
export async function loadChatModel(
  fullySpecifiedName: string,
  options?: LoadChatModelOptions,
): Promise<BaseChatModel> {
  const {
    semanticCache = false,
    disableThinking = true,
    selfHosted = !isOpenAIProper(),
    promptCacheKey,
    modelKwargs = {},
    ...rest
  } = options ?? {};

  // NOTE: first "/" only — "bedrock/us.anthropic/claude/v2" must keep the
  // trailing segments in the model name. Do not change to lastIndexOf.
  const index = fullySpecifiedName.indexOf("/");
  const provider =
    index === -1 ? undefined : fullySpecifiedName.slice(0, index);
  const model =
    index === -1 ? fullySpecifiedName : fullySpecifiedName.slice(index + 1);

  // Exactly one of these is ever sent: OpenAI 400s on chat_template_kwargs,
  // vLLM ignores reasoningEffort unless the chat template implements it.
  const thinkingKwargs =
    disableThinking && selfHosted
      ? { chat_template_kwargs: { enable_thinking: false } }
      : {};
  // const thinkingTop =
  //   disableThinking && !selfHosted ? { reasoningEffort: "minimal" as const } : {};

  // OpenAI-only. `promptCacheKey: null` opts out explicitly.
  const resolvedKey =
    promptCacheKey === null
      ? undefined
      : (promptCacheKey ?? defaultPromptCacheKey(model));
  const cacheKwargs =
    resolvedKey && !selfHosted ? { prompt_cache_key: resolvedKey } : {};

  const config = {
    apiKey: process.env.OPENAI_API_KEY,
    // LangChain-level cache — skips the HTTP call entirely. Orthogonal to
    // provider prompt caching, which still calls but discounts the prefix.
    cache: semanticCache ? getModelCache() : undefined,
    // ...thinkingTop,
    modelKwargs: { ...thinkingKwargs, ...cacheKwargs, ...modelKwargs },
    configuration: {
      baseURL: process.env.OPENAI_API_BASE_URL,
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    },
    ...rest,
  };

  // `initChatModel` returns a `ConfigurableModel` (for runtime `.withConfig`
  // model switching), which @langchain/core 1.x no longer types as assignable
  // to `BaseChatModel` (added message-structure generics). We always load a
  // fully-specified model and use it as a plain chat model — no caller does
  // runtime reconfiguration — so we surface the documented `BaseChatModel`
  // contract. The runtime object is a working chat model either way.
  const chatModel = provider
    ? await initChatModel(model, { modelProvider: provider, ...config })
    : await initChatModel(model, config);
  return chatModel as unknown as BaseChatModel;
}
