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

import type { AppCapability } from "@/lib/auth/projectRoles";
import { AppAccessError, resolveAppScope } from "@/lib/db/appAccess";

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
 * Assert the caller has the `required` capability on `appId`'s Project before
 * running any blueprint-touching work — membership-based, replacing the old
 * owner-equality check. Resolves cleanly on success; throws `McpAccessError`
 * on failure, collapsing the resolver's three denial reasons onto the two-value
 * MCP taxonomy (both surface as `not_found` on the wire). Defaults to `"view"`;
 * mutating callers pass `"edit"` and destructive ones `"delete"`.
 */
export async function requireOwnedApp(
	userId: string,
	appId: string,
	required: AppCapability = "view",
): Promise<void> {
	try {
		await resolveAppScope(appId, userId, required);
	} catch (err) {
		if (err instanceof AppAccessError) {
			throw new McpAccessError(
				err.reason === "not_found" ? "not_found" : "not_owner",
			);
		}
		throw err;
	}
}
