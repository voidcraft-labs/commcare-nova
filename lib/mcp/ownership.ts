/**
 * Per-request access checks for MCP tool adapters.
 *
 * Every adapter that takes an `app_id` runs {@link requireOwnedApp} (and
 * Project-targeted adapters {@link requireProjectAccess}) before
 * dispatching to the shared tool's execute. The check distinguishes "no
 * such row" from "not yours" internally — both collapse to the same
 * `"not_found"` envelope on the wire (see the IDOR-hardening note in
 * `./errors.ts`) so a probing client cannot enumerate existing app or
 * Project ids; the internal distinction exists only so server-side logs
 * can tell accidental typos (`not_found`) apart from cross-tenant probes
 * (`not_owner`) that admins alert on.
 */

import type { AppCapability } from "@/lib/auth/projectRoles";
import {
	AppAccessError,
	type ProjectAccess,
	resolveAppScope,
	resolveProjectAccess,
} from "@/lib/db/appAccess";
import { ProjectPermissionError } from "@/lib/projects/manage";

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
 * Which resource kind an access denial targeted. Decides only the wire
 * TEXT of the collapsed not-found envelope ("App not found." vs
 * "Project not found.") — the collapse rule itself is identical for
 * both, and every pre-existing call site defaults to `"app"`.
 */
export type McpAccessResource = "app" | "project";

/**
 * Thrown when an MCP caller targets an app or Project they cannot access.
 *
 * Two reasons:
 * - `not_found` — the row does not exist (typo or stale id).
 * - `not_owner` — the row exists but the caller isn't a member of its
 *   Project; the caller is never told the resource is present.
 *
 * Narrower than a raw `Error` so the MCP error serializer can
 * short-circuit `classifyError` and surface a deterministic
 * `error_type` (one of the two reasons above) in the tool result's
 * content payload.
 */
export class McpAccessError extends Error {
	constructor(
		public readonly reason: AccessErrorReason,
		public readonly resource: McpAccessResource = "app",
	) {
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
		rethrowAsMcpAccess(err);
	}
}

/**
 * Map a `lib/db/appAccess` `AppAccessError` onto the two-value MCP taxonomy and
 * throw it (re-throwing anything else unchanged). Shared by `requireOwnedApp`
 * and `loadAppBlueprint` so the collapse rule lives in exactly one place — both
 * `not_owner` and `not_found` then surface as `not_found` on the wire.
 */
export function rethrowAsMcpAccess(err: unknown): never {
	if (err instanceof AppAccessError) {
		throw new McpAccessError(
			err.reason === "not_found" ? "not_found" : "not_owner",
		);
	}
	throw err;
}

/**
 * Assert the caller holds the `required` capability on `projectId` and return
 * the resolved access (their role rides along for response text). The Project
 * twin of {@link requireOwnedApp}, with one deliberate asymmetry: a NON-member
 * still collapses to the not-found envelope (a probing key can't distinguish
 * existence), but a MEMBER whose role is short of `required` gets an explicit
 * permission message — a member legitimately knows the Project exists, so the
 * not-found collapse would only mislead them. Pass `insufficientRole` when the
 * call site can say something more useful than the generic denial.
 */
export async function requireProjectAccess(
	userId: string,
	projectId: string,
	required: AppCapability,
	insufficientRole?: string,
): Promise<ProjectAccess> {
	try {
		return await resolveProjectAccess(userId, projectId, required);
	} catch (err) {
		rethrowAsMcpProjectAccess(err, insufficientRole);
	}
}

/**
 * Map a `lib/db/appAccess` `AppAccessError` from a PROJECT-targeted check onto
 * the MCP error vocabulary and throw it (re-throwing anything else unchanged).
 * `not_found` / `not_member` become the Project-flavored {@link McpAccessError}
 * (both collapse to "Project not found." on the wire); `insufficient_role`
 * becomes a {@link ProjectPermissionError} — with the call site's
 * `insufficientRole` message when it has one (it knows what the caller was
 * trying to do), or the generic denial when it doesn't.
 */
export function rethrowAsMcpProjectAccess(
	err: unknown,
	insufficientRole?: string,
): never {
	if (err instanceof AppAccessError) {
		if (err.reason === "insufficient_role") {
			throw new ProjectPermissionError(
				insufficientRole ??
					"Your role in this Project doesn't allow this action. Ask a Project admin or owner to do it, or to raise your role.",
			);
		}
		throw new McpAccessError(
			err.reason === "not_found" ? "not_found" : "not_owner",
			"project",
		);
	}
	throw err;
}
