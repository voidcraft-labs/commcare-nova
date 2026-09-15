/**
 * The one 503 the MCP route returns when it cannot DECIDE a request: the
 * database pool timed out on acquire, the verifier threw, a revocation read
 * failed, the request could not even be handed to the auth router. RFC
 * 6750's `401 invalid_token` names a bad credential, and a client that
 * receives it discards the key or token it holds and starts over; an outage
 * is not that. A 503 with `Retry-After` says what is true, the server could
 * not answer just now, and Claude Code treats it as transient and retries.
 * No `WWW-Authenticate`: nothing about the credential is being challenged.
 * The body speaks to the person reading a raw response.
 */
export function mcpUnavailableResponse(): Response {
	return new Response(
		"Nova could not reach its own database while checking this request, so nothing was decided about your credentials and nothing was rejected. Please try again in a few seconds. This clears on its own once the database answers again.",
		{
			status: 503,
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Retry-After": "5",
			},
		},
	);
}
