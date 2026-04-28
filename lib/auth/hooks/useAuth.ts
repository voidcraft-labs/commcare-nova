/**
 * useAuth — thin wrapper around Better Auth's client-side session state.
 *
 * Provides a stable interface for components that need to know the current
 * auth state (authenticated user, pending check, sign-in/sign-out methods).
 * The `role` field comes from Better Auth's admin plugin — stored on the
 * auth user in `auth_users`, arrives as `session.user.role`.
 */
"use client";
import { authClient } from "@/lib/auth-client";

/** The authenticated user's profile. Mirrors Better Auth's user shape. */
export type AuthUser = NonNullable<
	NonNullable<ReturnType<typeof authClient.useSession>["data"]>["user"]
>;

export function useAuth() {
	const { data: session, isPending, error } = authClient.useSession();

	const signIn = () =>
		authClient.signIn.social({
			provider: "google",
			callbackURL: "/",
			/* Errors raised inside Better Auth's OAuth callback (notably the
			 * email-domain rejection from `databaseHooks.user.create.before` in
			 * `lib/auth.ts`, but also any state/code/network failure) redirect
			 * to `errorCallbackURL` with `?error=…` appended. Pointing it at
			 * `/` keeps rejected users on the landing page where the message
			 * surfaces inline, instead of Better Auth's default `${baseURL}/error`
			 * — a route that does not exist in this app and would 404. */
			errorCallbackURL: "/",
		});

	const signOut = () =>
		authClient.signOut({
			fetchOptions: { onSuccess: () => window.location.assign("/") },
		});

	return {
		/** The authenticated user, or null if not signed in. */
		user: session?.user ?? null,
		/** Whether the user is currently authenticated. */
		isAuthenticated: !!session,
		/** Whether the user has the admin role. False while session is loading
		 * and during impersonation (admin routes are server-blocked anyway). */
		isAdmin:
			session?.user?.role === "admin" && !session?.session?.impersonatedBy,
		/** Whether the current session is an admin impersonation session. */
		isImpersonating: !!session?.session?.impersonatedBy,
		/** Whether the initial session check is still in flight. */
		isPending,
		/** Any error from the session check. */
		error,
		/** Initiate Google OAuth sign-in flow. */
		signIn,
		/** Sign out and redirect to landing page. */
		signOut,
	};
}
