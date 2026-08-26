/**
 * @neuralsearchindex/sdk-node — consolidated shared SDK.
 *
 * The root barrel re-exports the platform-NEUTRAL modules as a FLAT namespace.
 * Node-only (`auth/server`, `auth/db`) and browser-only (`auth/client`) surfaces
 * are intentionally NOT re-exported here — import them from their subpaths.
 */
export * from "../packages/logger/src/index.js";
export * from "../packages/cache/src/index.js";
export * from "../packages/embeddings/src/index.js";
export * from "../packages/geo/src/index.js";
export * from "../packages/http/src/index.js";
export * from "../packages/llm/src/index.js";
export * from "../packages/preferences/src/index.js";
export * from "../packages/schemas/src/index.js";

// From auth, only the platform-neutral parts (entities + provider helpers).
export * from "../packages/auth/src/entities.js";
export * from "../packages/auth/src/provider.js";
