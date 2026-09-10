import "server-only";

import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { sso } from "@better-auth/sso";
import { mikroOrmAdapter } from "better-auth-mikro-orm";

import { getORM } from "./db.js";

export interface CreateAuthOptions {
  /** Public base URL of THIS app (callback origin). e.g. http://localhost:3000 (web) / :3100 (admin). */
  baseURL: string;
  /** better-auth signing secret (BETTER_AUTH_SECRET). Shared across apps on the same DB. */
  secret?: string;
  /** Extra trusted origins (the OIDC issuer origin is a common one). */
  trustedOrigins?: string[];
  /** Passed through to better-auth's `user` config (e.g. `{ deleteUser: { enabled: true } }`). */
  user?: BetterAuthOptions["user"];
  /**
   * Cookie name prefix (better-auth's `advanced.cookiePrefix`). Cookies are NOT
   * isolated by port, so multiple better-auth apps on the same host (web :3000 +
   * admin :3100, both `localhost`) MUST use distinct prefixes — otherwise their
   * session/OAuth-state cookies collide and SSO fails with `state_mismatch`.
   * Defaults to better-auth's `"better-auth"` when unset.
   */
  cookiePrefix?: string;
  /**
   * App-specific plugins appended AFTER the shared `sso()` plugin — e.g. web adds
   * `i18n(...)` for localized error codes. The SSO plugin itself is always included
   * so every app can drive `authClient.signIn.sso({ providerId })`.
   */
  extraPlugins?: BetterAuthPlugin[];
}

/**
 * Build a better-auth server instance bound to the shared `matching` Postgres.
 *
 * Provider-agnostic and app-agnostic: the actual OIDC provider is a `sso_provider`
 * row seeded per app/realm (see ./provider `upsertSsoProvider`), and everything
 * app-specific (baseURL, callbackURL used at call sites, i18n) is passed in by the
 * caller. This is what lets apps/web (app realm) and apps/admin (admin realm) share
 * one auth stack without duplicating the entities/adapter wiring.
 *
 * Async because it resolves the shared MikroORM instance; callers use top-level await:
 *   export const auth = await createAuth({ ... });
 */
// The declared return type is deliberately the WIDE `Auth<BetterAuthOptions>`.
// betterAuth() actually returns a plugin-parameterised `Auth<{plugins: [...]}>`
// which is not assignable to it (generic invariance), and letting TypeScript
// infer the precise type instead fails differently: TS2742/TS7056, because the
// inferred type references zod's internals and exceeds the serialisation limit.
// So: keep the portable declared type and cast at the return.
export async function createAuth(
  options: CreateAuthOptions,
): Promise<ReturnType<typeof betterAuth>> {
  const orm = await getORM();

  return betterAuth({
    database: mikroOrmAdapter(orm),
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: options.trustedOrigins,
    ...(options.user ? { user: options.user } : {}),
    ...(options.cookiePrefix ? { advanced: { cookiePrefix: options.cookiePrefix } } : {}),
    // Federate to an external OIDC provider (Keycloak today). Provider-agnostic:
    // registered at runtime by issuer, so nothing here is Keycloak-specific.
    plugins: [sso(), ...(options.extraPlugins ?? [])],
  }) as unknown as ReturnType<typeof betterAuth>;
}
