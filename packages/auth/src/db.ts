import "server-only";

import { MikroORM } from "@mikro-orm/postgresql";

import { authEntities } from "./entities.js";

/**
 * A single MikroORM instance for better-auth's tables, against the SAME shared
 * `matching` Postgres the engine + LangGraph checkpoints use (DATABASE_URL).
 *
 * Cached on globalThis so Next's dev HMR / route-module re-evaluation reuses one
 * pool instead of leaking connections. `allowGlobalContext` is on because the
 * better-auth adapter uses `orm.em` directly (no per-request fork).
 *
 * The cache key is scoped so that if two better-auth-backed apps ever share a
 * process (they don't today — web and admin are separate Next servers), each still
 * resolves the same single instance against the same DATABASE_URL.
 */
const globalForOrm = globalThis as unknown as { __authOrm?: Promise<MikroORM> };

export function getORM(): Promise<MikroORM> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for better-auth (MikroORM adapter).");
  }
  globalForOrm.__authOrm ??= MikroORM.init({
    clientUrl: process.env.DATABASE_URL,
    entities: authEntities,
    // Entities are listed explicitly (EntitySchema), so no filesystem discovery.
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: true,
  });
  return globalForOrm.__authOrm;
}
