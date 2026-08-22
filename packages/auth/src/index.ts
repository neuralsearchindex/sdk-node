/**
 * @local-llm/auth — shared better-auth stack for every app that authenticates
 * against the `matching` Postgres.
 *
 * The root entry re-exports only the SIDE-EFFECT-FREE surface (entities + Node
 * bootstrap helpers) so it is safe to import from any context. Runtime instances
 * are behind explicit subpaths whose module-level directives must be preserved:
 *   - `@local-llm/auth/server`  → `createAuth(...)`   ("server-only")
 *   - `@local-llm/auth/client`  → `createBrowserAuthClient()` ("use client")
 *   - `@local-llm/auth/db`      → `getORM()`          ("server-only")
 */
export * from "./entities";
export * from "./provider";
