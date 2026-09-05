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

/**
 * The umbrella chart ships `global.gateway.ip: "127.0.0.1"` as a placeholder and the
 * gateway-ip-sync CronJob overlays the real LB IP ~2min later. A pod that booted on
 * the placeholder derives `<svc>.127.0.0.1.nip.io` hosts from it.
 *
 * Keycloak's realm import is already gated on the real IP (await-gateway-ip
 * initContainer), but the `sso_provider` row was not: whichever pod finished its
 * start-up registration LAST won, and a stale-env pod riding out a not-yet-ready
 * Postgres could overwrite a correct row minutes later. The endpoints live in a PVC,
 * so no pod restart or helm upgrade ever corrected them and SSO failed permanently
 * with `discovery_private_host` ("tokenEndpoint host resolves to a
 * non-publicly-routable address").
 *
 * Refuse to persist those hosts. `*.127.0.0.1.nip.io` is unambiguously the
 * unresolved placeholder — a real deployment never produces it — so this is safe to
 * reject outright. Plain `localhost` / `127.0.0.1` issuers are NOT rejected: those
 * are legitimate for local development.
 */
const GATEWAY_IP_PLACEHOLDER_HOST = /(^|\.)127\.0\.0\.1\.nip\.io$/i;

export function assertResolvedIssuer(issuer: string): void {
  let host: string;
  try {
    host = new URL(issuer).hostname;
  } catch {
    throw new Error(`[sso:register] issuer is not a valid URL: ${issuer}`);
  }
  if (GATEWAY_IP_PLACEHOLDER_HOST.test(host)) {
    throw new Error(
      `[sso:register] refusing to register issuer "${issuer}": the host still carries the ` +
        `chart's 127.0.0.1 gateway placeholder, so every persisted OIDC endpoint would be ` +
        `unreachable and SSO would fail with discovery_private_host. Wait for the ` +
        `gateway-ip-sync CronJob to publish the real LoadBalancer IP (nsi-gateway-ip ` +
        `ConfigMap), then retry — the caller's retry loop handles this.`,
    );
  }
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
  // Never persist the chart's unresolved gateway placeholder (see assertResolvedIssuer).
  // Throwing here is deliberate: the caller's start-up retry loop re-runs until the
  // real IP lands, which is strictly better than booting on a poisoned row that
  // nothing later corrects.
  assertResolvedIssuer(issuer);
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
