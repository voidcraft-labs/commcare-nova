/**
 * OAuth scope constants + claim parsing + per-tool guard for the MCP surface.
 *
 * Two enforcement layers exist, picked by where each scope sits in the
 * authorization model:
 *
 *   1. **Verify-layer (route-wide).** `nova.read` and `nova.write` are
 *      required by `mcpHandler`'s `verifyAccessToken({ scopes })` config
 *      in `app/api/mcp/route.ts`. A token missing either is rejected
 *      with a 403 before any adapter runs — these are the "you can use
 *      Nova at all" floor.
 *   2. **Per-tool (handler-internal).** `nova.hq.read` and
 *      `nova.hq.write` are *orthogonal* to read/write — they gate access
 *      to a separate third-party system (CommCare HQ), not Nova-internal
 *      operations. Tools that touch HQ (`get_hq_connection`,
 *      `upload_app_to_hq`) call `assertScope` at the top of their
 *      handler; a token lacking the HQ scope produces a structured
 *      `scope_missing` envelope through the shared error serializer,
 *      but can still call non-HQ tools.
 *
 * The orthogonal split is why HQ scopes can't live at the verify layer:
 * adding them there would mandate HQ access for *any* MCP request,
 * collapsing the very split we're modeling. Mount-point splitting
 * doesn't fit either — it works for comparable scopes (read vs write),
 * but HQ access cuts across that axis and would require a 4-way mount
 * cross-product. Per-tool checks are the right tool for orthogonal
 * scope dimensions.
 *
 * `parseScopes` below splits the raw space-delimited `scope` claim into
 * the array `ToolContext.scopes` carries.
 */

/**
 * Canonical scope identifiers. Using `as const` locks the object shape
 * so `Scope` below resolves to a literal-string union rather than
 * `string` — adapter registration sites and the verify-layer config
 * both reference this, so a typo in a required-scope list becomes a
 * compile error rather than a silent grant.
 *
 * `read` / `write` cover Nova-internal operations (Firestore-backed app
 * blueprints). `hqRead` / `hqWrite` cover delegated access to CommCare
 * HQ via the user's stored API key — a distinct authorization grant
 * because HQ is a separate platform the user authenticated to outside
 * Nova's OAuth flow.
 */
export const SCOPES = {
	read: "nova.read",
	write: "nova.write",
	hqRead: "nova.hq.read",
	hqWrite: "nova.hq.write",
} as const;

/** Union of the scope literals derived from `SCOPES`. */
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
 * its own. Consumers that check for a Nova-specific scope use
 * `assertScope` (or `scopes.includes(SCOPES.hqWrite)` directly) against
 * the string array; those constants already carry the correct literal
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

/**
 * Thrown when the caller's access token lacks an OAuth scope a specific
 * tool requires. Parallel to `McpAccessError` and `McpInvalidInputError`:
 * `toMcpErrorResult` short-circuits the generic classifier and emits
 * a deterministic `scope_missing` envelope carrying the required scope
 * so MCP clients can show a precise re-authorization prompt.
 *
 * `app_id` is uniformly stamped onto the wire envelope by the error
 * serializer (via `ctx.appId`), so callers don't need to thread it
 * through this throw — they just `throw new McpScopeError(SCOPES.hqWrite,
 * "upload_app_to_hq")` from inside their `try` block.
 */
export class McpScopeError extends Error {
	constructor(
		public readonly requiredScope: Scope,
		public readonly toolName: string,
	) {
		super(
			`Tool "${toolName}" requires the "${requiredScope}" OAuth scope, which was not granted on this access token. Re-authorize the connecting client to grant this permission.`,
		);
		this.name = "McpScopeError";
	}
}

/**
 * Per-tool scope guard. Throws `McpScopeError` when the token lacks
 * `required`; resolves cleanly otherwise. The catch block wrapping the
 * tool body routes the throw through `toMcpErrorResult`, which builds
 * a `scope_missing` envelope with `app_id` stamped from `ctx.appId` —
 * uniform with every other access-failure on the wire.
 *
 * Pattern at the call site:
 *
 *   assertScope(ctx.scopes, SCOPES.hqRead, "get_hq_connection");
 *
 * The check should run BEFORE any data read so a missing-scope token
 * can't probe whether a record exists — same defensive ordering as the
 * ownership pre-gate in `upload_app_to_hq`.
 */
export function assertScope(
	scopes: readonly string[],
	required: Scope,
	toolName: string,
): void {
	if (!scopes.includes(required)) {
		throw new McpScopeError(required, toolName);
	}
}
