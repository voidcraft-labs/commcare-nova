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
	/* Disable automatic session refetch on window focus. Better Auth's default
	 * (refetchOnWindowFocus: true) causes useSession() to briefly transition
	 * through { data: null, isPending: false, isRefetching: true } on every
	 * tab switch — any client-side auth check that reads `data` during this
	 * window sees a false "unauthenticated" state. The server layout already
	 * validates the session cookie before the page renders, and individual API
	 * routes verify ownership on every request, so client-side revalidation
	 * on focus adds no security value. */
	sessionOptions: {
		refetchOnWindowFocus: false,
	},
});
