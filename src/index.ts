/**
 * @neuralsearchindex/sdk-node — consolidated shared SDK.
 *
 * The root barrel re-exports the platform-NEUTRAL modules as a FLAT namespace.
 * Node-only (`auth/server`, `auth/db`) and browser-only (`auth/client`) surfaces
 * are intentionally NOT re-exported here — import them from their subpaths.
 */
export * from "./logger/index.js";
export * from "./cache/index.js";
export * from "./embeddings/index.js";
export * from "./geo/index.js";
export * from "./http/index.js";
export * from "./llm/index.js";
export * from "./preferences/index.js";
export * from "./schemas/index.js";

// From auth, only the platform-neutral parts (entities + provider helpers).
export * from "./auth/entities.js";
export * from "./auth/provider.js";
