/**
 * OAuth scope constants + claim parsing for the MCP surface.
 *
 * Scope enforcement happens at the verify layer (the route handler
 * declares required scopes per tool-mount; an access token missing the
 * required scope is rejected before any adapter runs). This module
 * exposes the scope vocabulary and a small parser for the JWT's
 * space-separated `scope` claim.
 *
 * `nova.read` covers read-only operations and the dynamic-agent prompt
 * fetch used by the plugin skills. `nova.write` covers every mutation
 * and any operation that creates, deletes, or uploads an app.
 */

/**
 * Canonical scope identifiers. Using `as const` locks the object shape
 * so `Scope` below resolves to the literal union
 * `"nova.read" | "nova.write"` rather than `string`.
 */
export const SCOPES = {
	read: "nova.read",
	write: "nova.write",
} as const;

/**
 * Union of the scope string literals. Adapter registration sites and the
 * verify-layer config both reference this — the route handler's
 * `verifyAccessToken({ scopes })` accepts `Scope[]`, so a typo in a
 * required-scope list is a compile error rather than a silent grant.
 */
export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/**
 * Parse a space-delimited OAuth `scope` claim into an array of tokens.
 *
 * Takes the raw string (or `undefined`) rather than the full claim
 * object so the data dependency is explicit — the parser only needs
 * one string, and coupling it to a composed claim type would hide
 * that.
 *
 * Return type is `string[]`, not `Scope[]`, because a token's scope
 * claim carries third-party scopes (`openid`, `profile`,
 * `offline_access`) that Nova doesn't own but must preserve alongside
 * its own (`nova.read`, `nova.write`). Consumers that check for
 * Nova-specific scopes do `scopes.includes(SCOPES.write)` against the
 * string array; those constants already carry the correct literal
 * types.
 *
 * Missing or empty input returns `[]`. Whitespace tokens are filtered.
 * Per RFC 6749 the claim is space-delimited; splitting on any
 * whitespace run is defensive against the occasional CR/LF an upstream
 * token server emits.
 */
export function parseScopes(scope: string | undefined): string[] {
	return (scope ?? "").split(/\s+/).filter(Boolean);
}
