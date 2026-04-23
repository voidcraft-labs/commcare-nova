/**
 * Shared MCP types.
 *
 * Single source of truth for request-scoped types that flow from the MCP
 * route handler into every tool adapter. Kept in a separate module so
 * adapter files can import without creating a cycle with lib/mcp/server.ts
 * (which depends on them).
 */

/**
 * Per-request context the MCP route handler materializes from the verified
 * JWT claims. Passed to each adapter's `register<Tool>(server, ctx)` call
 * so adapter closures can resolve the authenticated user without
 * re-parsing the token. Scopes are already checked at the verify layer
 * via the plugin's `verifyAccessToken({ scopes })` — this context carries
 * them for informational use only.
 */
export interface ToolContext {
	/** Better Auth user id, from the JWT `sub` claim. */
	userId: string;
	/**
	 * Scopes granted on the caller's access token, post-verification.
	 * Typed as `readonly string[]` not `Scope[]` because the claim
	 * carries third-party scopes (`openid`, `profile`, `offline_access`)
	 * Nova doesn't own but must preserve alongside its own. Tool bodies
	 * that need to branch on a Nova scope check
	 * `scopes.includes(SCOPES.write)` against the string array. No tool
	 * reads this field today — scope enforcement happens at the route
	 * layer's `verifyAccessToken` — but the field is threaded through
	 * so future scope-conditional tool behavior doesn't need a context
	 * refactor.
	 */
	scopes: readonly string[];
}

/**
 * JWT claim shape the route handler receives post-verification.
 *
 * Only the two claims Nova reads downstream are modeled — `sub` (the
 * authenticated user id) and `scope` (space-delimited granted scopes).
 * `aud` is pinned at the verify layer via `verifyOptions.audience` and
 * has no consumer inside tool code, so it isn't part of this narrowed
 * shape.
 */
export interface JwtClaims {
	sub: string;
	scope?: string;
}
