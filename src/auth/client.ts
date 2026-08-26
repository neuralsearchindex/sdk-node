"use client";

import { createAuthClient } from "better-auth/react";
import { ssoClient } from "@better-auth/sso/client";

/**
 * Browser auth client factory. `ssoClient()` adds `authClient.signIn.sso(...)` and
 * the SSO registration helpers. Same-origin by default (baseURL resolves to
 * window.location), so each app gets a client scoped to its own origin/cookie.
 */
export function createBrowserAuthClient() {
  return createAuthClient({
    plugins: [ssoClient()],
  });
}
