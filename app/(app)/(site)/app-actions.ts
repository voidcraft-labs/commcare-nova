/**
 * Server Actions for the home-page app list — soft-delete, restore, and the
 * temporary Project-placement policy boundary.
 *
 * Mirrors the discriminated-union pattern in `settings/oauth-actions.ts`:
 * never throws, always returns a structured result. Next surfaces
 * unhandled Server Action errors as full-page error boundaries, which
 * would tear down the per-card state machine mid-flight.
 *
 * Delete and restore follow the same path: session → input validation → one
 * app-locked, freshly authorized write → `revalidatePath("/")`. The revalidate is the primary refresh
 * mechanism — it re-runs the home page's RSC, both lists re-fetch, and
 * the row drops out of (or into) the appropriate list naturally. No
 * client-side optimistic moves to coordinate.
 */

"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth-utils";
import { AppAccessError, resolveAppAccess } from "@/lib/db/appAccess";
import { restoreApp as restoreAppDoc, softDeleteApp } from "@/lib/db/apps";
import { CommitReauthError } from "@/lib/db/commitGuard";
import {
	AppBusyError,
	CaseDataStrandedError,
	CrossProjectAppMoveBlockedError,
	moveAppToProject,
} from "@/lib/db/moveAppToProject";
import { log } from "@/lib/logger";
import {
	appProjectMovePolicy,
	type CROSS_PROJECT_MOVE_UNAVAILABLE_CODE,
} from "@/lib/projects/moveTargets";

// ── Types ──────────────────────────────────────────────────────────

/** Result of `deleteApp`. Carries the recovery deadline on success so the UI can surface it. */
export type DeleteAppResult =
	| { success: true; recoverableUntil: string }
	| { success: false; error: string };

/** Result of `restoreApp`. */
export type RestoreAppResult =
	| { success: true }
	| { success: false; error: string };

export type MoveAppErrorCode =
	| "unauthenticated"
	| "invalid_input"
	| "not_found"
	| typeof CROSS_PROJECT_MOVE_UNAVAILABLE_CODE
	| "busy"
	| "case_sync_failed"
	| "internal_error";

/** Result of the temporary S01 `moveApp` boundary. A true move is unavailable;
 * the sole success is an idempotent same-Project case-data reconciliation. */
export type MoveAppResult =
	| { success: true; kind: "same_project_recovered" }
	| { success: false; code: MoveAppErrorCode; error: string };

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Discriminated authorization result. Returns the same `App not found`
 * message whether the row is genuinely missing or owned by another user
 * — surfacing a different message on cross-tenant probes would leak
 * existence information about other users' apps.
 */
type AuthResult = { ok: true } | { ok: false; error: string };

/**
 * Input gate that both actions share. Authorization deliberately belongs to
 * the app-row transaction in `softDeleteApp` / `restoreApp`; an earlier read
 * must never decide a later write. Returns a tagged input failure so each
 * action can map malformed Server Action payloads without throwing.
 *
 * Server Actions deserialize JSON and the `string` annotation alone
 * does NOT enforce shape at runtime — a malformed client could send
 * anything — so the trim guard is real, not theatre.
 */
function validateAppMutationInput(appId: string): AuthResult {
	if (typeof appId !== "string" || !appId.trim()) {
		return { ok: false, error: "Missing app identifier." };
	}
	return { ok: true };
}

// ── Actions ────────────────────────────────────────────────────────

/**
 * Soft-delete an app the user may administer. Wraps `softDeleteApp` (which sets
 * `deleted_at` + `recoverable_until` and leaves lifecycle status
 * untouched) with the standard auth pre-flight, and surfaces the
 * recovery deadline back to the UI for the "permanently deletes on
 * DATE" copy.
 */
export async function deleteApp(appId: string): Promise<DeleteAppResult> {
	try {
		const session = await getSession();
		if (!session) {
			return { success: false, error: "Authentication required." };
		}

		const auth = validateAppMutationInput(appId);
		if (!auth.ok) return { success: false, error: auth.error };

		const recoverableUntil = await softDeleteApp(appId, session.user.id);
		revalidatePath("/");
		return { success: true, recoverableUntil };
	} catch (err) {
		if (err instanceof CommitReauthError) {
			return { success: false, error: "App not found." };
		}
		log.error("[home/delete-app] error", err);
		return {
			success: false,
			error: "Could not delete. Please try again.",
		};
	}
}

/**
 * Restore a soft-deleted app the user may administer. Inverse of `deleteApp` —
 * clears the two soft-delete fields without touching lifecycle status,
 * so a deleted `error` app comes back as `error`. Cross-tenant restore
 * probes hit the same `App not found` branch as unknown ids.
 */
export async function restoreApp(appId: string): Promise<RestoreAppResult> {
	try {
		const session = await getSession();
		if (!session) {
			return { success: false, error: "Authentication required." };
		}

		const auth = validateAppMutationInput(appId);
		if (!auth.ok) return { success: false, error: auth.error };

		await restoreAppDoc(appId, session.user.id);
		revalidatePath("/");
		return { success: true };
	} catch (err) {
		if (err instanceof CommitReauthError) {
			return { success: false, error: "App not found." };
		}
		log.error("[home/restore-app] error", err);
		return {
			success: false,
			error: "Could not restore. Please try again.",
		};
	}
}

/**
 * Temporary S01 Project-move boundary. Source authorization happens before the
 * policy response, so a caller cannot use the unavailable-operation message to
 * distinguish another tenant's app from a missing id. Every authorized true
 * cross-Project request is then refused without resolving or touching the target
 * Project. An exact same-Project call remains available only as the idempotent
 * recovery path that reconciles case rows after a historical partial move.
 */
export async function moveApp(
	appId: string,
	toProjectId: string,
): Promise<MoveAppResult> {
	try {
		const session = await getSession();
		if (!session) {
			return {
				success: false,
				code: "unauthenticated",
				error: "Authentication required.",
			};
		}

		/* Server Actions deserialize JSON; the `string` annotation is not a runtime
		 * guarantee, so the trim guards are real (mirrors `authorizeAppMutation`). */
		if (
			typeof appId !== "string" ||
			!appId.trim() ||
			typeof toProjectId !== "string" ||
			!toProjectId.trim()
		) {
			return {
				success: false,
				code: "invalid_input",
				error: "Missing app or Project identifier.",
			};
		}

		let access: Awaited<ReturnType<typeof resolveAppAccess>>;
		try {
			access = await resolveAppAccess(appId, session.user.id, "delete");
		} catch (err) {
			if (err instanceof AppAccessError) {
				return {
					success: false,
					code: "not_found",
					error: "App not found.",
				};
			}
			throw err;
		}

		const policy = appProjectMovePolicy(access.projectId, toProjectId);
		if (policy.kind === "cross_project_blocked") {
			return {
				success: false,
				code: policy.code,
				error: policy.message,
			};
		}

		await moveAppToProject({
			appId,
			fromProjectId: access.projectId,
			toProjectId,
			actorUserId: session.user.id,
		});
		revalidatePath("/");
		return { success: true, kind: "same_project_recovered" };
	} catch (err) {
		if (err instanceof CrossProjectAppMoveBlockedError) {
			return {
				success: false,
				code: err.code,
				error: err.message,
			};
		}
		if (err instanceof AppBusyError) {
			return {
				success: false,
				code: "busy",
				error:
					"This app is being generated right now. Try again once it finishes.",
			};
		}
		if (err instanceof CaseDataStrandedError) {
			return {
				success: false,
				code: "case_sync_failed",
				error:
					"Couldn't finish syncing this app's case data in its current Project. The data is safe. Try again shortly; if it keeps failing, contact support.",
			};
		}
		log.error("[home/move-app] error", err);
		return {
			success: false,
			code: "internal_error",
			error: "Could not check this app's Project. Try again.",
		};
	}
}
