/**
 * Classifies a failed OAuth authorize response into the reason Nova's
 * connection-issue page explains.
 *
 * The authorize endpoint reports a request it cannot trust in the BROWSER,
 * never to the MCP client: a redirect to Better Auth's `errorURL` (`/`) with
 * `?error=…`, or a bare JSON 4xx / 429 when a client's metadata address can't
 * be read. This module turns either shape into one of a closed set of reasons.
 * The provider's raw code and `error_description` stop here: the destination
 * carries the reason alone, so nothing the requester wrote (or the provider
 * phrased) reaches the page.
 *
 * Pure and dependency-free so the route handler, the page, and the tests all
 * read the same vocabulary.
 */

export const AUTHORIZE_ISSUE_REASONS = [
	"unknown-client",
	"client-unavailable",
	"try-again-shortly",
	"request-problem",
] as const;

export type AuthorizeIssueReason = (typeof AUTHORIZE_ISSUE_REASONS)[number];

/** Path of the public page that explains an authorize failure. */
export const CONNECTION_ISSUE_PATH = "/connection-issue";

const FALLBACK_REASON: AuthorizeIssueReason = "request-problem";

/**
 * Read the page's `reason` query value. Anything outside the closed set,
 * including a hand-typed URL, reads as the generic reason rather than an
 * error: the page always has something true to say.
 */
export function parseAuthorizeIssueReason(
	raw: string | null | undefined,
): AuthorizeIssueReason {
	return (
		AUTHORIZE_ISSUE_REASONS.find((reason) => reason === raw) ?? FALLBACK_REASON
	);
}

/** Relative destination for a reason. Relative, like Better Auth's own
 * `errorURL` redirect, so the browser resolves it against the public host
 * rather than whatever origin the server saw. */
export function connectionIssueUrl(reason: AuthorizeIssueReason): string {
	return `${CONNECTION_ISSUE_PATH}?reason=${reason}`;
}

/** What the route handler can observe without consuming a body it may still
 * have to return. */
export interface AuthorizeResponseFacts {
	status: number;
	/** The response's `Location` header, when it has one. */
	location: string | null;
	/** The authorize request's URL: resolves a relative `Location` and carries
	 * the `client_id`. A POSTed authorize form keeps its `client_id` in a body
	 * this module never reads, so it classifies as an opaque id. */
	requestUrl: string;
	/** The parsed JSON body of a non-redirect 4xx, read from a clone. */
	body?: unknown;
}

/** A Client ID Metadata Document id is an https URL; a registered client's id
 * is an opaque string. The two fail for different reasons. */
function isHttpsUrl(value: string | null | undefined): boolean {
	if (!value) return false;
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

function reasonForCode(
	code: string,
	clientId: string | null | undefined,
): AuthorizeIssueReason {
	if (code === "invalid_client") {
		return isHttpsUrl(clientId) ? "client-unavailable" : "unknown-client";
	}
	if (code === "temporarily_unavailable") return "try-again-shortly";
	return FALLBACK_REASON;
}

function errorCodeOfBody(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return null;
	const code = (body as { error?: unknown }).error;
	return typeof code === "string" ? code : null;
}

/**
 * The reason a failed authorize response should be explained with, or `null`
 * when the response is not an authorize failure Nova owns and must pass
 * through untouched: the sign-in redirect to `/`, the consent redirect, an
 * error delivered to the client's own `redirect_uri`, any success, any 5xx.
 */
export function classifyAuthorizeResponse(
	facts: AuthorizeResponseFacts,
): AuthorizeIssueReason | null {
	const { status, location, requestUrl, body } = facts;
	let request: URL;
	try {
		request = new URL(requestUrl);
	} catch {
		return null;
	}
	const clientId = request.searchParams.get("client_id");

	if (status >= 300 && status < 400) {
		if (!location) return null;
		let target: URL;
		try {
			target = new URL(location, request);
		} catch {
			return null;
		}
		if (target.origin !== request.origin || target.pathname !== "/") {
			return null;
		}
		const code = target.searchParams.get("error");
		return code ? reasonForCode(code, clientId) : null;
	}

	if (status === 429) return "try-again-shortly";

	if (status >= 400 && status < 500) {
		const code = errorCodeOfBody(body);
		return code ? reasonForCode(code, clientId) : null;
	}

	return null;
}
