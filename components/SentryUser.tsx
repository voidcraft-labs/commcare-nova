"use client";

/**
 * Attaches the signed-in user to the Sentry browser scope so client-side
 * errors — error-boundary catches, unhandled rejections, the replay session
 * — are attributed to a person (name + email) rather than just an IP.
 *
 * Mounted once alongside `ErrorReporter` in the authenticated app layout.
 * Renders nothing — a pure side-effect component. The browser SDK runs with
 * `sendDefaultPii: true` (see `instrumentation-client.ts`), so it already
 * attaches IP-based attribution; this adds the durable identity on top.
 *
 * Mirrors the server side: `lib/auth-utils.ts` sets the same user on each
 * request's isolation scope. The session resolves asynchronously here, so
 * the user is set once it arrives and cleared on sign-out — a stale identity
 * must not linger on the scope after the user signs out within the same tab.
 */

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth/hooks/useAuth";

export function SentryUser() {
	const { user } = useAuth();

	useEffect(() => {
		if (!user) {
			Sentry.setUser(null);
			return;
		}
		Sentry.setUser({
			id: user.id,
			email: user.email,
			username: user.name,
		});
	}, [user]);

	/* Pure side effect — no UI output. */
	return null;
}
