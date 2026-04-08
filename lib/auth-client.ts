/**
 * Better Auth — client-side authentication instance.
 *
 * Provides React hooks (useSession) and methods (signIn, signOut) for
 * interacting with the Better Auth server. The `inferAdditionalFields`
 * plugin infers session `additionalFields` (like `isAdmin`) from the
 * server auth config for type-safe client access.
 */

import { inferAdditionalFields } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import type { Auth } from "./auth";

export const authClient = createAuthClient({
	plugins: [inferAdditionalFields<Auth>()],
});
