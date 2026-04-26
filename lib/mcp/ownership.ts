/**
 * Per-request ownership check for MCP tool adapters.
 *
 * Every adapter that takes an `app_id` runs this before dispatching to
 * the shared tool's execute. The check distinguishes "no such app" from
 * "you aren't the owner" internally — both collapse to the same
 * `"not_found"` envelope on the wire (see the IDOR-hardening note in
 * `./errors.ts`) so a probing client cannot enumerate existing app
 * ids; the internal distinction exists only so server-side logs can
 * tell accidental typos (`not_found`) apart from cross-tenant probes
 * (`not_owner`) that admins alert on.
 */

import { loadAppOwner } from "@/lib/db/apps";

/**
 * Two-value union of INTERNAL ownership-gate rejection reasons. Kept
 * internal-only: `"not_owner"` never appears on the wire — it collapses
 * to `"not_found"` in `toMcpErrorResult` to close the IDOR enumeration
 * channel, with the original reason landing in the server-side audit
 * log for admin alerting. `McpAccessError.reason` narrows through this
 * union so every server-internal switch on it (including the log-branch
 * in the error serializer) gets exhaustiveness checking at compile time.
 */
export type AccessErrorReason = "not_found" | "not_owner";

/**
 * Thrown when an MCP caller targets an app they cannot access.
 *
 * Two reasons:
 * - `not_found` — the app row does not exist (typo or stale id).
 * - `not_owner` — the row exists but is owned by another user; the
 *   caller is never told the app is present under a different owner.
 *
 * Narrower than a raw `Error` so the MCP error serializer can
 * short-circuit `classifyError` and surface a deterministic
 * `error_type` (one of the two reasons above) in the tool result's
 * content payload.
 */
export class McpAccessError extends Error {
	constructor(public readonly reason: AccessErrorReason) {
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
