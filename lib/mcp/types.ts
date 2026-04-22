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
	/** Scopes granted on this token, post-verification. */
	scopes: readonly string[];
}

/**
 * JWT claim shape the route handler receives post-verification.
 */
export interface JwtClaims {
	sub: string;
	scope?: string;
	aud?: string | string[];
}
