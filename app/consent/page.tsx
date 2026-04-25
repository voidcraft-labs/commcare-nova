/**
 * OAuth consent page (server component).
 *
 * The `oauth-provider` plugin redirects authenticated users here with the
 * original OAuth authorization-request query (`client_id`, `scope`,
 * `redirect_uri`, `state`, `response_type`, `code_challenge`, …) plus an
 * `exp` timestamp and a `sig` HMAC covering the full query. The plugin
 * uses the signature to prove the query passed through the authorize
 * handler and hasn't been forged or tampered with; the signature is the
 * real validity signal — raw `client_id` + `scope` on their own are
 * trivially URL-forgeable.
 *
 * We render the client name + scope list, then hand the accept/deny
 * decision to a client form that calls `authClient.oauth2.consent(...)`.
 * The `oauthProviderClient()` plugin reads `window.location.search`
 * client-side and injects the signed query into the POST body as
 * `oauth_query`, so the server can match the decision back to the
 * in-flight authorization request. No `consent_code` is involved — that
 * was an `oidc-provider` concept this plugin doesn't share.
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
 * on any failure (unknown client_id, upstream shape drift, transient
 * network issue, session-middleware rejection) so the consent page can
 * fall back to a generic "An application" label.
 *
 * The plugin currently gates `/oauth2/public-client` with its session
 * middleware — the upstream has an open issue discussing whether to drop
 * that gate, so treat "auth required" as a current implementation detail
 * rather than a stable contract. Either way is fine here: this helper
 * runs AFTER the page-level session gate, so a session is always present.
 *
 * Failures are logged to the server console with enough context to
 * diagnose — silently degrading to "An application" on a user-facing
 * trust signal is worse than a loud log, because the user can't tell
 * the difference between "Nova doesn't know this client" and "Nova is
 * broken." The UI still degrades gracefully; the signal just isn't eaten.
 */
async function fetchClientPublicInfo(
	auth: ReturnType<typeof getAuth>,
	clientId: string,
	hdrs: Headers,
): Promise<{ clientName?: string; clientUri?: string } | undefined> {
	/* Better Auth's handler requires a parseable absolute URL. The origin
	 * is discarded by the handler — only the pathname + search are read —
	 * so any syntactically valid origin works. `http://internal` reads
	 * clearer than `http://localhost`, which suggests a real target. */
	const url = new URL("/api/auth/oauth2/public-client", "http://internal");
	url.searchParams.set("client_id", clientId);
	try {
		const res = await auth.handler(new Request(url, { headers: hdrs }));
		if (!res.ok) {
			const body = await res.text();
			console.warn(
				`[consent] /oauth2/public-client returned ${res.status} for client_id=${clientId}: ${body.slice(0, 200)}`,
			);
			return undefined;
		}
		const body = (await res.json()) as {
			client_name?: string;
			client_uri?: string;
		};
		return {
			clientName: body.client_name,
			clientUri: body.client_uri,
		};
	} catch (err) {
		console.warn(
			`[consent] /oauth2/public-client threw for client_id=${clientId}:`,
			err,
		);
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

	const clientId = typeof sp.client_id === "string" ? sp.client_id : undefined;
	const scopes = parseScopes(sp.scope);
	const sig = typeof sp.sig === "string" ? sp.sig : undefined;
	const redirectUri =
		typeof sp.redirect_uri === "string" ? sp.redirect_uri : undefined;

	/* `sig` is the HMAC the authorize handler appends to the full query
	 * before redirecting here; its presence is the only trustworthy signal
	 * that the user landed on the consent page via the plugin's own flow
	 * rather than by typing the URL or following a forged link. `client_id`
	 * and `scope` are load-bearing for display; the plugin itself rejects
	 * stale or forged signatures at the POST, so surfacing an error branch
	 * client-side is a UX concession, not a security boundary. */
	const requestValid = Boolean(clientId && scopes.length > 0 && sig);
	const clientInfo =
		requestValid && clientId
			? await fetchClientPublicInfo(auth, clientId, hdrs)
			: undefined;
	const clientName = clientInfo?.clientName ?? "An application";

	return (
		<main className="relative isolate flex min-h-full items-center justify-center overflow-hidden px-5 py-6 sm:py-10">
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
					redirectUri={redirectUri}
					clientUri={clientInfo?.clientUri}
					trustedClient={false}
				/>
			</div>
		</main>
	);
}
