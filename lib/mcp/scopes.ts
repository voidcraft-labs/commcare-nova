import { NOVA_MCP_SCOPE_LABELS } from "@/lib/auth-public";
import type { AuthKind } from "./types";

/**
 * Scope constants + claim parsing + per-tool guard for the MCP surface.
 *
 * Two enforcement layers exist, picked by where each scope sits in the
 * authorization model:
 *
 *   1. **Verify-layer (route-wide).** `nova.read` and `nova.write` are
 *      required as the floor on both auth paths, sourced from
 *      `lib/auth-public.ts::NOVA_MCP_FLOOR_SCOPES`. The JWT path
 *      passes them to `mcpHandler`'s `verifyAccessToken({ scopes })`
 *      config in `app/api/mcp/jwt-auth.ts`, which produces a clean
 *      403 on failure. The API-key path checks them locally in
 *      `app/api/mcp/api-key-auth.ts::handleApiKeyMcp` after
 *      `verifyApiKey` succeeds, surfacing the same 403 +
 *      `insufficient_scope` shape (RFC 6750 §3) — verifying without
 *      passing `permissions` to the plugin lets us emit a distinct
 *      "missing scope" error instead of the indistinguishable
 *      "key invalid" the plugin would otherwise return.
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
 * Thrown when the caller's credential lacks a scope a specific tool
 * requires. Parallel to `McpAccessError` and `McpInvalidInputError`:
 * `toMcpErrorResult` short-circuits the generic classifier and emits
 * a deterministic `scope_missing` envelope carrying the required
 * scope so MCP clients can show a precise prompt to grant it.
 *
 * Two pieces of bearer-shape-aware copy come together here:
 *
 *   - **Friendly label.** The message names the scope by the label
 *     the user sees in the UI ("HQ Read") rather than the raw
 *     literal (`nova.hq.read`). The settings checkboxes and OAuth
 *     consent rows both use the friendly label; leaking the raw
 *     literal forces the user to translate.
 *   - **Path-aware remediation.** The fix sentence branches on
 *     `authKind` — "Re-authorize the connecting client" for OAuth,
 *     "Edit the API key's scopes in Nova settings" for API keys. The
 *     error knows which path produced the call (route handlers stamp
 *     `authKind` onto `ToolContext`), so we point the user at the
 *     surface they actually have access to instead of listing both
 *     and making them figure out which applies.
 *
 * The wire payload's `required_scope` field keeps the raw literal
 * for programmatic consumers; only the human-readable `message`
 * field uses the friendly label.
 *
 * `app_id` is uniformly stamped onto the wire envelope by the error
 * serializer (via `ctx.appId`), so callers don't need to thread it
 * through this throw — they just call `assertScope(ctx,
 * SCOPES.hqWrite, "upload_app_to_hq")` from inside their `try`
 * block.
 */
export class McpScopeError extends Error {
	constructor(
		public readonly requiredScope: Scope,
		public readonly toolName: string,
		public readonly authKind: AuthKind,
	) {
		const label = NOVA_MCP_SCOPE_LABELS[requiredScope];
		const remediation =
			authKind === "api-key"
				? "Edit the API key's scopes in Nova settings to grant it."
				: "Re-authorize the connecting client to grant it.";
		super(
			`Tool "${toolName}" requires the "${label}" permission, which isn't granted on this credential. ${remediation}`,
		);
		this.name = "McpScopeError";
	}
}

/**
 * Per-tool scope guard. Throws `McpScopeError` when the credential
 * lacks `required`; resolves cleanly otherwise. The catch block
 * wrapping the tool body routes the throw through `toMcpErrorResult`,
 * which builds a `scope_missing` envelope with `app_id` stamped from
 * `ctx.appId` — uniform with every other access-failure on the wire.
 *
 * Takes the full `ToolContext` (not just the scope array) so the
 * thrown error can read `ctx.authKind` and emit the path-specific
 * remediation sentence. The wire payload's `required_scope` field
 * stays the same shape across both paths; only the human-readable
 * message branches.
 *
 * Pattern at the call site:
 *
 *   assertScope(ctx, SCOPES.hqRead, "get_hq_connection");
 *
 * The check should run BEFORE any data read so a missing-scope
 * credential can't probe whether a record exists — same defensive
 * ordering as the ownership pre-gate in `upload_app_to_hq`.
 */
export function assertScope(
	ctx: { scopes: readonly string[]; authKind: AuthKind },
	required: Scope,
	toolName: string,
): void {
	if (!ctx.scopes.includes(required)) {
		throw new McpScopeError(required, toolName, ctx.authKind);
	}
}
