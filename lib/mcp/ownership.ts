/**
 * Per-request ownership check for MCP tool adapters.
 *
 * Every adapter that takes an `app_id` runs this before dispatching to
 * the shared tool's execute. The check distinguishes "no such app" from
 * "you aren't the owner" so the caller-side error serializer can choose
 * whether to expose the distinction.
 *
 * Why two reasons, not one boolean: the route handler logs access
 * failures with their reason so admins can tell accidental typos in an
 * app id (`not_found`) apart from genuine cross-tenant probes
 * (`not_owner`). Collapsing to a single bucket would hide that signal.
 */

import { loadAppOwner } from "@/lib/db/apps";

/**
 * Thrown when an MCP caller targets an app they cannot access.
 *
 * Two reasons:
 * - `not_found` — the app row genuinely does not exist (typo, stale
 *   id, hard-deleted out from under a running tool call).
 * - `not_owner` — the row exists but is owned by another user; the
 *   caller is never told the app is present under a different owner.
 *
 * Narrower than a raw `Error` so the MCP error serializer can
 * short-circuit `classifyError` and surface a deterministic
 * `error_type` (one of the two reasons above) in the tool result's
 * `_meta`.
 */
export class McpAccessError extends Error {
	constructor(public readonly reason: "not_found" | "not_owner") {
		super(reason);
		this.name = "McpAccessError";
	}
}

/**
 * Assert the authenticated user owns `appId` before running any
 * blueprint-touching work. Resolves cleanly on success; throws
 * `McpAccessError` with a precise `reason` on failure. Never returns
 * the owner userId — callers that need owner identity for something
 * other than the gate should call `loadAppOwner` directly.
 */
export async function requireOwnedApp(
	userId: string,
	appId: string,
): Promise<void> {
	const owner = await loadAppOwner(appId);
	// Empty string and null both count as "no owner" — a blank value would
	// violate invariants even if Firestore permitted it.
	if (!owner) throw new McpAccessError("not_found");
	if (owner !== userId) throw new McpAccessError("not_owner");
}
