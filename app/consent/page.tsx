/**
 * OAuth consent page (server component).
 *
 * The oauth-provider plugin redirects authenticated users here with three
 * query parameters: consent_code, client_id, and scope. We render the
 * client name + scope list, then hand the accept/deny decision to a
 * client form that calls authClient.oauth2.consent({ accept }).
 *
 * The form's `accept` POST carries the user's session cookie back to
 * /api/auth/oauth2/consent, which uses the consent_code stashed by the
 * plugin to complete the authorization-code flow and redirect the user
 * back to the OAuth client.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import { ConsentForm } from "./ConsentForm";

interface ConsentPageProps {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Parse the space-separated `scope` query param into a deduped list. */
function parseScopes(raw: string | string[] | undefined): string[] {
	if (!raw) return [];
	const flat = Array.isArray(raw) ? raw.join(" ") : raw;
	return Array.from(new Set(flat.split(/\s+/).filter(Boolean)));
}

/**
 * Best-effort fetch of the OAuth client's public name. Returns `undefined`
 * if the client_id is unknown or the plugin endpoint shape changes —
 * the consent page falls back to a generic "An application" label.
 *
 * The plugin's `/oauth2/public-client` endpoint requires an active session;
 * that's fine here because the page redirects unauthenticated users away
 * before this helper ever runs.
 */
async function fetchClientName(
	auth: ReturnType<typeof getAuth>,
	clientId: string,
	hdrs: Headers,
): Promise<string | undefined> {
	try {
		const url = new URL("http://localhost/api/auth/oauth2/public-client");
		url.searchParams.set("client_id", clientId);
		const res = await auth.handler(new Request(url, { headers: hdrs }));
		if (!res.ok) return undefined;
		const body = (await res.json()) as { client_name?: string };
		return body.client_name;
	} catch {
		return undefined;
	}
}

export default async function ConsentPage({ searchParams }: ConsentPageProps) {
	const sp = await searchParams;
	const auth = getAuth();
	const hdrs = await headers();

	/* Nova's sign-in surface lives at `/` (the landing page's Google OAuth
	 * button) — there is no `/sign-in` route. An unauthenticated user who
	 * lands here gets bounced to landing to sign in, which is the same UX
	 * as any other protected page in the app. */
	const session = await auth.api.getSession({ headers: hdrs });
	if (!session) redirect("/");

	const consentCode =
		typeof sp.consent_code === "string" ? sp.consent_code : undefined;
	const clientId = typeof sp.client_id === "string" ? sp.client_id : undefined;
	const scopes = parseScopes(sp.scope);

	/* The query params are required for a valid consent request. Missing or
	 * tampered params mean the user landed here outside an OAuth flow —
	 * surface that to the form so it can render a clear error instead of a
	 * mystery accept button. */
	const requestValid = Boolean(consentCode && clientId && scopes.length > 0);
	const clientName =
		requestValid && clientId
			? ((await fetchClientName(auth, clientId, hdrs)) ?? "An application")
			: "An application";

	return (
		<main className="relative isolate flex min-h-full items-center justify-center overflow-hidden px-5 py-12 sm:py-16">
			{/* Atmosphere — cosmic violet blurs that signal "you are still inside
			 *   Nova, this is a real screen from us." Matches the landing page's
			 *   unauthenticated sign-in surface so the OAuth flow reads as one
			 *   continuous product experience across sign-in → consent → redirect.
			 *   Rendered at the page level (not inside the form) so both the happy
			 *   path and the invalid-link branch share the same atmosphere.
			 *   `pointer-events-none` keeps the blurs out of click and tab paths;
			 *   `-z-10` via isolate puts them behind content without escaping the
			 *   stacking context established by `main`. */}
			<div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
				<div className="absolute left-1/2 top-[15%] h-[620px] w-[620px] -translate-x-1/2 rounded-full bg-nova-violet/[0.06] blur-[120px]" />
				<div className="absolute bottom-[-10%] left-[20%] h-[480px] w-[480px] rounded-full bg-nova-violet/[0.04] blur-[100px]" />
			</div>

			<div className="w-full max-w-[28rem]">
				<ConsentForm
					clientName={clientName}
					scopes={scopes}
					redirectMismatch={!requestValid}
				/>
			</div>
		</main>
	);
}
