import { EntitySchema } from "@mikro-orm/core";

/**
 * MikroORM entities for better-auth's tables.
 *
 * `better-auth-mikro-orm` does NOT generate schema and can't use `@better-auth/cli`,
 * so we hand-define the core schema (user/session/account/verification) plus the SSO
 * plugin's `ssoProvider`, and create the tables via a MikroORM SchemaGenerator
 * (see `runAuthMigrate` in ./provider).
 *
 * The adapter resolves a better-auth model name to an entity via the naming strategy:
 * `getEntityName(classToTableName(model))`. With the default UnderscoreNamingStrategy
 * that maps `user→User`, `session→Session`, `account→Account`, `verification→Verification`,
 * `ssoProvider→SsoProvider` — so the `name` values below MUST stay exactly these. Columns
 * are snake_case (email_verified, user_id, created_at, …); the adapter looks up properties
 * by their camelCase NAME, which is what better-auth passes.
 *
 * `id` is a plain string PK populated by better-auth (we keep better-auth's id generator).
 * userId is modelled as a scalar string (no FK relation) — simplest supported shape.
 *
 * This schema is the single source of truth shared by every app that authenticates
 * against the `matching` Postgres (apps/web, apps/admin). Both apps' tables are
 * identical rows in the same DB; app-specific concerns (which realm/provider, which
 * baseURL) live in each app's `createAuth(...)` call, not here.
 */

export interface UserRow {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const User = new EntitySchema<UserRow>({
  name: "User",
  tableName: "user",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
    email: { type: "string", unique: true },
    emailVerified: { type: "boolean", default: false },
    image: { type: "string", nullable: true },
    createdAt: { type: "Date" },
    updatedAt: { type: "Date" },
  },
});

export interface SessionRow {
  id: string;
  expiresAt: Date;
  token: string;
  createdAt: Date;
  updatedAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
  userId: string;
}

export const Session = new EntitySchema<SessionRow>({
  name: "Session",
  tableName: "session",
  properties: {
    id: { type: "string", primary: true },
    expiresAt: { type: "Date" },
    token: { type: "string", unique: true },
    createdAt: { type: "Date" },
    updatedAt: { type: "Date" },
    ipAddress: { type: "string", nullable: true },
    userAgent: { type: "string", nullable: true },
    userId: { type: "string" },
  },
});

export interface AccountRow {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  // SSO-linked accounts carry the IdP issuer (better-auth's @better-auth/sso plugin
  // writes it on the OIDC/SAML callback). Nullable — password/credential accounts
  // have no issuer.
  issuer?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  idToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  refreshTokenExpiresAt?: Date | null;
  scope?: string | null;
  password?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const Account = new EntitySchema<AccountRow>({
  name: "Account",
  tableName: "account",
  properties: {
    id: { type: "string", primary: true },
    accountId: { type: "string" },
    providerId: { type: "string" },
    userId: { type: "string" },
    issuer: { type: "string", nullable: true },
    accessToken: { type: "text", nullable: true },
    refreshToken: { type: "text", nullable: true },
    idToken: { type: "text", nullable: true },
    accessTokenExpiresAt: { type: "Date", nullable: true },
    refreshTokenExpiresAt: { type: "Date", nullable: true },
    scope: { type: "string", nullable: true },
    password: { type: "string", nullable: true },
    createdAt: { type: "Date" },
    updatedAt: { type: "Date" },
  },
});

export interface VerificationRow {
  id: string;
  identifier: string;
  value: string;
  expiresAt: Date;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export const Verification = new EntitySchema<VerificationRow>({
  name: "Verification",
  tableName: "verification",
  properties: {
    id: { type: "string", primary: true },
    identifier: { type: "string" },
    value: { type: "text" },
    expiresAt: { type: "Date" },
    createdAt: { type: "Date", nullable: true },
    updatedAt: { type: "Date", nullable: true },
  },
});

export interface SsoProviderRow {
  id: string;
  issuer: string;
  oidcConfig?: string | null;
  samlConfig?: string | null;
  userId?: string | null;
  providerId: string;
  organizationId?: string | null;
  domain: string;
  domainVerified?: boolean | null;
}

export const SsoProvider = new EntitySchema<SsoProviderRow>({
  name: "SsoProvider",
  tableName: "sso_provider",
  properties: {
    id: { type: "string", primary: true },
    issuer: { type: "string" },
    // oidcConfig/samlConfig are stored by the plugin as serialized JSON strings.
    oidcConfig: { type: "text", nullable: true },
    samlConfig: { type: "text", nullable: true },
    userId: { type: "string", nullable: true },
    providerId: { type: "string", unique: true },
    organizationId: { type: "string", nullable: true },
    domain: { type: "string" },
    domainVerified: { type: "boolean", nullable: true },
  },
});

export const authEntities = [User, Session, Account, Verification, SsoProvider];
