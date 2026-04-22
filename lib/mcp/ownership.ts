/**
 * Per-request ownership check for MCP tool adapters.
 *
 * Every adapter that takes an `app_id` runs this before dispatching to
 * the shared tool's execute. The check distinguishes "no such app" from
 * "you aren't the owner" so the caller-side error serializer can choose
 * whether to expose the distinction.
 *
 * Why two reasons, not one boolean: the route handler logs forbidden
 * attempts with their reason so admins can tell accidental typos in an
 * app id ("not_found") apart from genuine cross-tenant probes
 * ("not_owner"). Collapsing to a single bucket would hide that signal.
 */

import { loadAppOwner } from "@/lib/db/apps";

/**
 * Thrown by `requireOwnedApp` when an MCP caller targets an app they
 * cannot access. Narrower than a raw `Error` so the MCP error serializer
 * can short-circuit `classifyError` and surface a deterministic
 * `error_type` in the tool result's `_meta`.
 */
export class McpForbiddenError extends Error {
	constructor(public readonly reason: "not_found" | "not_owner") {
		super(reason);
		this.name = "McpForbiddenError";
	}
}

/**
 * Assert the authenticated user owns `appId` before running any
 * blueprint-touching work. Resolves cleanly on success; throws
 * `McpForbiddenError` with a precise `reason` on failure. Never returns
 * the owner userId — callers that need owner identity for something
 * other than the gate should call `loadAppOwner` directly.
 */
export async function requireOwnedApp(
	userId: string,
	appId: string,
): Promise<void> {
	const owner = await loadAppOwner(appId);
	if (!owner) throw new McpForbiddenError("not_found");
	if (owner !== userId) throw new McpForbiddenError("not_owner");
}
