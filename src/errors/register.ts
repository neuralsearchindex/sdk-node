/**
 * Side-effect entrypoint: initialises error tracking from the environment.
 *
 *     import "@neuralsearchindex/sdk-node/errors/register";  // FIRST import
 *
 * This module exists because ordering matters and ES imports are hoisted —
 * see the note on `initErrors`. Putting the call in its own module is the only
 * way to guarantee it runs before the entrypoint's other imports are
 * evaluated. It is the same shape as the `import "./sentry"` line the engine
 * has always had, moved somewhere every service can share it.
 *
 * A no-op when SENTRY_DSN is unset, which is the normal state on a cluster
 * before the GlitchTip bootstrap has run.
 */
import { initErrors } from "./init.js";

initErrors();
