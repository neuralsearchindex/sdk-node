"use client";

import { createAuthClient } from "better-auth/react";
import { ssoClient } from "@better-auth/sso/client";

/**
 * Browser auth client factory. `ssoClient()` adds `authClient.signIn.sso(...)` and
 * the SSO registration helpers. Same-origin by default (baseURL resolves to
 * window.location), so each app gets a client scoped to its own origin/cookie.
 */
// Return type annotated, not inferred. The inferred type names the resolved
// @better-auth/sso and better-auth paths inside node_modules, which are stable
// locally but a temp store path during a fresh `pnpm install` — so declaration
// emit fails with TS2742 ("cannot be named without a reference to …"). `tsc
// --noCheck` does NOT suppress it, because it is an emit error rather than a
// check error. That broke every clean install of any repo depending on this
// package by git ref, since `prepare` builds on install.
export function createBrowserAuthClient(): ReturnType<typeof createAuthClient> {
  return createAuthClient({
    plugins: [ssoClient()],
  }) as unknown as ReturnType<typeof createAuthClient>;
}
