/**
 * Shared bootstrap helpers for provisioning better-auth against Keycloak.
 *
 * Used by each app's thin CLI scripts (apps/web, apps/admin) which load their own
 * env and call these. Pure Node (no `server-only`, no Next) so `tsx` can run them.
 * Everything app/realm-specific — issuer, client id/secret, providerId, domain — is
 * passed in; nothing here is web- or admin-specific.
 */
import { randomUUID } from "node:crypto";

import { MikroORM } from "@mikro-orm/postgresql";

import { authEntities, SsoProvider } from "./entities.js";
import { pgSslOptions } from "./pg-ssl.js";

function strip(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

export interface KeycloakOidcInput {
  /** Public issuer — browser-facing (authorization redirect + token `iss`). */
  issuer: string;
  /**
   * Backchannel issuer — the URL the SERVER uses for token/jwks/userinfo. In a
   * dockerized app it must be container-reachable (host.docker.internal:8080),
   * while the browser still uses `issuer`. Defaults to `issuer` for host dev.
   */
  tokenIssuer?: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Produce the exact serialized `oidcConfig` JSON the @better-auth/sso plugin
 * persists on a `sso_provider` row. Keycloak endpoint paths are standard, computed
 * per-context so browser vs. server reach the right host.
 */
export function buildKeycloakOidcConfig(input: KeycloakOidcInput): string {
  const { issuer, clientId, clientSecret } = input;
  const tokenIssuer = input.tokenIssuer ?? issuer;
  const pub = strip(issuer);
  const back = strip(tokenIssuer);

  return JSON.stringify({
    issuer, // public — must equal the token `iss`
    clientId,
    clientSecret,
    authorizationEndpoint: `${pub}/protocol/openid-connect/auth`, // browser
    tokenEndpoint: `${back}/protocol/openid-connect/token`, // server backchannel
    tokenEndpointAuthentication: "client_secret_basic",
    jwksEndpoint: `${back}/protocol/openid-connect/certs`, // server backchannel
    pkce: true,
    discoveryEndpoint: `${pub}/.well-known/openid-configuration`,
    mapping: { id: "sub", email: "email", emailVerified: "email_verified", name: "name", image: "picture" },
    scopes: ["openid", "email", "profile"],
    userInfoEndpoint: `${back}/protocol/openid-connect/userinfo`, // server backchannel
    overrideUserInfo: false,
  });
}

/**
 * Create/patch better-auth's tables (user, session, account, verification,
 * sso_provider) in the shared Postgres. The MikroORM adapter doesn't generate
 * schema, so we drive the SchemaGenerator over ONLY the auth entities — it never
 * touches Keycloak / engine / LangGraph tables in the same public schema.
 * `safe: true` never drops columns/tables. Idempotent.
 */
export async function runAuthMigrate(databaseUrl: string): Promise<void> {
  const orm = await MikroORM.init({
    ...pgSslOptions(databaseUrl),
    entities: authEntities,
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: true,
  });
  try {
    const generator = orm.getSchemaGenerator();
    const sql = await generator.getUpdateSchemaSQL({ safe: true });
    if (!sql.trim()) {
      console.log("[auth-migrate] schema already up to date.");
    } else {
      console.log("[auth-migrate] applying:\n" + sql);
      await generator.updateSchema({ safe: true });
      console.log("[auth-migrate] done.");
    }
  } finally {
    await orm.close(true);
  }
}

export interface UpsertSsoProviderInput {
  databaseUrl: string;
  providerId: string;
  issuer: string;
  domain: string;
  oidcConfig: string;
}

/**
 * Idempotently seed (or update) a single `sso_provider` row so
 * `authClient.signIn.sso({ providerId })` works on first run without a
 * pre-existing session (the plugin's register endpoint is session-protected,
 * which is circular for an SSO-only bootstrap).
 */
export async function upsertSsoProvider(input: UpsertSsoProviderInput): Promise<void> {
  const { databaseUrl, providerId, issuer, domain, oidcConfig } = input;
  const orm = await MikroORM.init({
    ...pgSslOptions(databaseUrl),
    entities: authEntities,
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: true,
  });
  try {
    const em = orm.em.fork();
    const existing = await em.findOne(SsoProvider, { providerId });
    if (existing) {
      existing.issuer = issuer;
      existing.oidcConfig = oidcConfig;
      existing.domain = domain;
      await em.flush();
      console.log(`[sso:register] updated provider "${providerId}" (issuer ${issuer}).`);
    } else {
      const provider = em.create(SsoProvider, {
        id: randomUUID(),
        providerId,
        issuer,
        domain,
        domainVerified: false,
        oidcConfig,
        samlConfig: null,
        userId: null,
        organizationId: null,
      });
      await em.persistAndFlush(provider);
      console.log(`[sso:register] registered provider "${providerId}" (issuer ${issuer}).`);
    }
  } finally {
    await orm.close(true);
  }
}
