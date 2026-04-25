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
 *      `upload_app_to_hq`) call `requireScope` at the top of their
 *      handler; a token lacking the HQ scope gets a structured
 *      `scope_missing` envelope back, but can still call non-HQ tools.
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

import type { McpErrorPayload, McpToolErrorResult } from "./errors";

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
 * `requireScope` (or `scopes.includes(SCOPES.hqWrite)` directly) against
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
 * Per-tool scope guard. Returns `null` when the access token carries
 * `required`, or a structured `scope_missing` error envelope otherwise.
 *
 * Pattern at the call site:
 *
 *   const scopeError = requireScope(ctx.scopes, SCOPES.hqRead, "get_hq_connection");
 *   if (scopeError) return scopeError;
 *
 * The check should run *before* any data read so a missing-scope token
 * can't probe whether a record exists — same defensive ordering as the
 * ownership pre-gate in `upload_app_to_hq`.
 *
 * Returns rather than throws because scope failure is an *expected*
 * client-handling case (the MCP client should prompt the user to
 * re-authorize), not an exceptional one — the wire envelope is
 * structurally indistinguishable from any other gate rejection in the
 * `error_type` taxonomy.
 *
 * `toolName` rides into the human-readable `message` so the user sees
 * which capability they need to grant; `required_scope` rides into a
 * sibling field so a programmatic MCP client can show a precise
 * re-authorization prompt without parsing the message.
 *
 * `appId` rides through when the calling tool already knows the target
 * app at the gate site — keeping the wire shape uniform with the
 * tool's other failure envelopes (e.g. `upload_app_to_hq`'s
 * `hq_not_configured` / `hq_upload_failed` / `not_found` all carry
 * `app_id`). Tools without an app-id concept at the gate site
 * (`get_hq_connection`) omit the parameter; the field is dropped from
 * the payload rather than emitted as `null`.
 */
export function requireScope(
	scopes: readonly string[],
	required: Scope,
	toolName: string,
	appId?: string,
): McpToolErrorResult | null {
	if (scopes.includes(required)) return null;
	/* `satisfies McpErrorPayload` enforces that any drift between the
	 * wire taxonomy (`McpErrorType` in `./errors`) and what this helper
	 * emits is a compile error — same pattern `UPLOAD_ERROR_TAGS` in
	 * `uploadAppToHq.ts:75` uses for its own tool-specific tags.
	 * Conditional spread for `app_id` mirrors `toMcpErrorResult`'s
	 * handling of the same field — present only when the caller knows
	 * the target app, absent otherwise (no `null`-as-sentinel on the
	 * wire). */
	const payload = {
		error_type: "scope_missing",
		message: `Tool "${toolName}" requires the "${required}" OAuth scope, which was not granted on this access token. Re-authorize the connecting client to grant this permission.`,
		required_scope: required,
		...(appId !== undefined && { app_id: appId }),
	} satisfies McpErrorPayload;
	return {
		isError: true,
		content: [{ type: "text", text: JSON.stringify(payload) }],
	};
}
