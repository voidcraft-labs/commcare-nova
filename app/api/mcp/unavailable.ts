/**
 * The one 503 the MCP route returns when it cannot DECIDE a request: the
 * database pool timed out on acquire, the verifier threw, a revocation read
 * failed. RFC 6750's `401 invalid_token` names a bad credential, and a
 * client that receives it discards the key or token it holds and starts
 * over; an outage is not that. A 503 with `Retry-After` says what is true —
 * the server could not answer just now — and Claude Code treats it as
 * transient and retries. No `WWW-Authenticate`: nothing about the
 * credential is being challenged.
 */
export function mcpUnavailableResponse(): Response {
	return new Response(null, {
		status: 503,
		headers: { "Retry-After": "5" },
	});
}
