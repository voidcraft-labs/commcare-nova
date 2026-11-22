import {
	requireScopes,
	type ScopeChallengeHandler,
} from "@modelcontextprotocol/server";
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
 *      passes them to the protected-request handler's `requiredScopes`
 *      config in `app/api/mcp/jwt-auth.ts`, which produces a clean
 *      403 on failure. The API-key path checks them locally in
 *      `app/api/mcp/api-key-auth.ts::handleApiKeyMcp` after
 *      `verifyApiKey` succeeds, surfacing the same 403 +
 *      `insufficient_scope` shape (RFC 6750 §3) — verifying without
 *      passing `permissions` to the plugin lets us emit a distinct
 *      "missing scope" error instead of the indistinguishable
 *      "key invalid" the plugin would otherwise return.
 *   2. **Per-tool.** `nova.hq.read` / `nova.hq.write` / `nova.hq.import`
 *      and `nova.projects.read` / `nova.projects.write` are *orthogonal*
 *      to read/write. The HQ scopes gate access to a separate third-party
 *      system (CommCare HQ): its connection and publishing (read, write),
 *      and reading its apps and data with the person's key and bringing
 *      them into a Project (import); the Projects pair gates Project
 *      membership and sharing (member lists, invitations, role changes,
 *      cross-Project app moves) — outward-facing acts that grant other
 *      people access, a materially different power than editing the
 *      caller's own apps. `TOOL_SCOPES` below names every tool that needs
 *      one, and `scopedTool.ts::registerScopedTool` is the one way such a
 *      tool registers: it declares the SDK scope challenge, so an OAuth
 *      client is asked for incremental consent before execution, and
 *      checks every scope before the handler runs, so a credential lacking
 *      one gets a structured `scope_missing` envelope (an API key's owner
 *      is told to edit the key) and nothing behind the gate is reached.
 *
 * A scope string never means more than the consent row it was granted
 * under (`lib/oauth/capabilities.ts`): new authority is a new scope, which a
 * standing grant or key lacks until a person approves it.
 *
 * The orthogonal split is why these scopes can't live at the verify
 * layer: adding them there would mandate HQ or Projects access for
 * *any* MCP request, collapsing the very split we're modeling.
 * Mount-point splitting doesn't fit either — it works for comparable
 * scopes (read vs write), but the orthogonal pairs cut across that axis
 * and would require a mount cross-product. Per-tool checks are the
 * right tool for orthogonal scope dimensions.
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
 * `read` / `write` cover Nova-internal operations (Postgres-backed app
 * blueprints). `hqRead` / `hqWrite` cover delegated access to CommCare
 * HQ via the user's stored API key — a distinct authorization grant
 * because HQ is a separate platform the user authenticated to outside
 * Nova's OAuth flow. `projectsRead` / `projectsWrite` cover Project
 * membership and sharing — distinct because managing who can reach the
 * caller's Projects is an outward-facing grant of access to other
 * people, not an edit to the caller's own data.
 */
export const SCOPES = {
	read: "nova.read",
	write: "nova.write",
	hqRead: "nova.hq.read",
	hqWrite: "nova.hq.write",
	hqImport: "nova.hq.import",
	previewSearchRead: "nova.preview.search.read",
	previewSearchWrite: "nova.preview.search.write",
	projectsRead: "nova.projects.read",
	projectsWrite: "nova.projects.write",
} as const;

/** Union of the scope literals derived from `SCOPES`. */
export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/**
 * Every MCP tool that needs a scope beyond the floor, and each scope it needs.
 * A tool's scopes follow what its answers carry, never only where its writes
 * land: every tool whose answer (a stop, a refusal and a changed review
 * included) can carry what CommCare HQ holds of an app or its data needs
 * `nova.hq.import`. Publish may report the drift it would overwrite under HQ
 * Write, and a deployment status can report what Nova already recorded.
 * A publish that copies managed tables or places, and a kept-settings refresh,
 * also check HQ Import before making that read.
 * `set_lookup_table_management` needs both HQ scopes: managing a table in
 * Nova decides what later publishes write there, and handing it back copies
 * CommCare HQ's rows in.
 */
export const TOOL_SCOPES = {
	get_preview_search_settings: [SCOPES.previewSearchRead],
	set_preview_search_settings: [
		SCOPES.previewSearchRead,
		SCOPES.previewSearchWrite,
	],
	get_hq_connection: [SCOPES.hqRead],
	check_project_space_compatibility: [SCOPES.hqRead],
	get_deployment: [SCOPES.hqRead],
	upload_app_to_hq: [SCOPES.hqWrite],
	refresh_deployment: [SCOPES.hqWrite],
	withdraw_deployment_confirmation: [SCOPES.hqWrite],
	get_entry_point_link: [SCOPES.hqWrite],
	provision_workers: [SCOPES.hqWrite],
	stop_publishing: [SCOPES.hqWrite],
	list_hq_apps: [SCOPES.hqImport],
	read_hq_app: [SCOPES.hqImport],
	bring_in_hq_app: [SCOPES.hqImport],
	read_hq_changes: [SCOPES.hqImport],
	bring_in_hq_changes: [SCOPES.hqImport],
	refresh_managed_data: [SCOPES.hqImport],
	set_lookup_table_management: [SCOPES.hqWrite, SCOPES.hqImport],
	list_members: [SCOPES.projectsRead],
	create_project: [SCOPES.projectsWrite],
	invite_member: [SCOPES.projectsWrite],
	update_member_role: [SCOPES.projectsWrite],
	move_app: [SCOPES.projectsWrite],
} as const satisfies Record<string, readonly [Scope, ...Scope[]]>;

/** A tool `TOOL_SCOPES` names. */
export type ScopedToolName = keyof typeof TOOL_SCOPES;

export function isScopedToolName(name: string): name is ScopedToolName {
	return Object.hasOwn(TOOL_SCOPES, name);
}

/** Scopes knowable from the request before consulting the app. A normal
 * deployment refresh only observes the build; the kept-settings mode imports
 * the target's settings. A publish checks its managed-data dependency at the
 * point the service discovers it. */
export function requiredToolScopes(
	name: ScopedToolName,
	args: unknown,
): readonly [Scope, ...Scope[]] {
	if (
		name === "refresh_deployment" &&
		typeof args === "object" &&
		args !== null &&
		"kept_values" in args &&
		args.kept_values === true
	)
		return [...TOOL_SCOPES.refresh_deployment, SCOPES.hqImport];
	return TOOL_SCOPES[name];
}

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
 * `registerScopedTool` throws nothing: it hands this error to the shared
 * serializer and answers its envelope before the handler runs.
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
 * A tool may also check a scope for an optional operation it performs. For
 * the scopes required by every call, `scopedTool.ts::registerScopedTool` checks a
 * tool's scopes before its handler runs, so a missing-scope credential
 * can't probe whether a record exists.
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

/** OAuth clients can request the missing grants before a handler runs. Preserve
 * existing grants in the challenge so incremental consent never narrows access.
 * Static API keys retain the tool error directing their owner to settings.
 * The handler's own check (`scopedTool.ts`) stays authoritative for non-HTTP
 * SDK consumers. */
export function oauthScopeChallenge(
	ctx: { scopes: readonly string[]; authKind: AuthKind },
	required: readonly [Scope, ...Scope[]],
): ScopeChallengeHandler | undefined {
	if (ctx.authKind !== "oauth") return undefined;
	const [first, ...rest] = required;
	return requireScopes(
		first,
		...rest,
		...ctx.scopes.filter(
			(scope) => !(required as readonly string[]).includes(scope),
		),
	);
}
