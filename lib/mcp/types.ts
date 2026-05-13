/**
 * Shared MCP types.
 *
 * Single source of truth for request-scoped types that flow from the MCP
 * route handler into every tool adapter. Kept in a separate module so
 * adapter files can import without creating a cycle with lib/mcp/server.ts
 * (which depends on them).
 */

/**
 * How the caller authenticated. Stamped onto `ToolContext` so
 * per-tool error messages — notably `McpScopeError` in `./scopes` —
 * can name the right surface for the user to fix scope problems
 * (`/settings → API keys` for `"api-key"` vs re-authorization for
 * `"oauth"`). The two-value union covers Nova's full auth surface;
 * if a third path ever lands, extending the union and the
 * remediation map is one symmetric change.
 */
export type AuthKind = "oauth" | "api-key";

/**
 * Per-request context the MCP route handler materializes from the
 * verified credential. Passed to each adapter's
 * `register<Tool>(server, ctx)` call so adapter closures can resolve
 * the authenticated user without re-parsing the credential.
 *
 * The route's verify layer checks the floor scopes (`nova.read`,
 * `nova.write`) before any handler runs; orthogonal scopes
 * (`nova.hq.read`, `nova.hq.write`) layer on top via per-tool
 * `assertScope` calls inside the HQ handlers. This context carries
 * the full scope set so those per-tool checks can read it without
 * re-parsing the credential, plus an `authKind` tag so
 * `McpScopeError` can land the user on the right "where do I fix
 * this?" surface.
 */
export interface ToolContext {
	/** Better Auth user id, from the JWT `sub` claim or the API-key row's `referenceId`. */
	userId: string;
	/**
	 * Scopes granted on the caller's credential, post-verification.
	 * Typed as `readonly string[]` not `Scope[]` because OAuth tokens
	 * may carry third-party scopes (`openid`, `profile`,
	 * `offline_access`) Nova doesn't own but must preserve alongside
	 * its own. Bespoke MCP-only tool register functions (e.g.
	 * `get_hq_connection`, `upload_app_to_hq`) call `assertScope`
	 * against this list at the top of their handler to gate
	 * orthogonal scopes like `nova.hq.read` / `nova.hq.write`. Shared
	 * SA tools never see scopes — the route's verify layer already
	 * enforced the floor (`nova.read`, `nova.write`) before any tool
	 * body runs.
	 */
	scopes: readonly string[];
	/**
	 * Tag identifying which auth path produced this context. Drives
	 * the remediation sentence in `McpScopeError`'s message — "Edit
	 * the API key's scopes in Nova settings" for `"api-key"` vs
	 * "Re-authorize the connecting client" for `"oauth"`.
	 */
	authKind: AuthKind;
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
