"use client";

import { createAuthClient } from "better-auth/react";
import { ssoClient } from "@better-auth/sso/client";

// Side-effect-free TYPE imports of the ROOT packages. The client type below is
// inferred, and that inference reaches into `better-auth` and `@better-auth/sso`
// — modules this file otherwise only touches via subpaths. Without these,
// declaration emit cannot name them and fails with TS2742 ("cannot be named
// without a reference to …/node_modules/.pnpm/…"), which is stable locally and
// breaks on a fresh `pnpm install` where the build runs from a temp store path.
// `tsc --noCheck` does not help: TS2742 is an emit error, not a check error.
import type {} from "better-auth";
import type {} from "@better-auth/sso";

/**
 * Browser auth client factory. `ssoClient()` adds `authClient.signIn.sso(...)` and
 * the SSO registration helpers. Same-origin by default (baseURL resolves to
 * window.location), so each app gets a client scoped to its own origin/cookie.
 */
/**
 * INFERRED on purpose. Every attempt to spell this type out loses the plugin:
 * `ReturnType<typeof createAuthClient>` drops `signIn.sso`, and so does
 * parameterising it as `createAuthClient<{ plugins: [...] }>` — better-auth
 * derives the client surface from the actual options object, not from an
 * explicit type argument. Both compile here and break every consumer with
 * "Property 'sso' does not exist", which is what happened to web and admin.
 *
 * So the type stays inferred and TS2742 is solved at the import site above
 * instead. The guard below is what keeps this honest.
 */
export function createBrowserAuthClient() {
  return createAuthClient({
    plugins: [ssoClient()],
  });
}

/**
 * Compile-time guard: the SSO plugin's methods must survive into the PUBLIC
 * type, not just the runtime object.
 *
 * Widening the annotation to the bare `ReturnType<typeof createAuthClient>`
 * compiles perfectly well here and quietly strips `signIn.sso`, so the break
 * only shows up in consumers as "Property 'sso' does not exist" — which is how
 * it reached web and admin. This turns that into a failure of THIS package's
 * `types:check`, next to the code that causes it.
 */
type _AssertSsoSurvives = ReturnType<typeof createBrowserAuthClient>["signIn"]["sso"] extends (
  ...args: never[]
) => unknown
  ? true
  : { ERROR: "BrowserAuthClient lost signIn.sso — consumers will not compile" };
const _ssoGuard: _AssertSsoSurvives = true;
void _ssoGuard;
