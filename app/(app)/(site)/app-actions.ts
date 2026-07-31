/**
 * Server Actions for the home-page app list — soft-delete, restore, and the
 * Project-placement boundary.
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
import {
	BlueprintCommitRejectedError,
	CommitReauthError,
} from "@/lib/db/commitGuard";
import {
	AppBusyError,
	AppRunStateCorruptError,
	moveAppToProject,
} from "@/lib/db/moveAppToProject";
import { log } from "@/lib/logger";
import { appProjectMovePolicy } from "@/lib/projects/moveTargets";

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
	| "busy"
	| "run_state_corrupt"
	| "stale_client"
	| "move_rejected"
	| "not_permitted"
	| "internal_error";

/** Result of the `moveApp` boundary: either the app changed Projects, or an
 * exact same-Project call reconciled its case data idempotently. */
export type MoveAppResult =
	| { success: true; kind: "moved" | "same_project_recovered" }
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
 * Project-move boundary. Source authorization happens before the policy
 * response, so a caller cannot use a refusal message to distinguish another
 * tenant's app from a missing id. The move switch is read here for
 * person-readable copy; the move transaction re-reads it `FOR SHARE` and is the
 * authority. An exact same-Project call is not a move at all — it is the
 * atomic, app-locked case-tenancy repair path.
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

		await moveAppToProject({
			appId,
			fromProjectId: access.projectId,
			toProjectId,
			actorUserId: session.user.id,
		});
		revalidatePath("/");
		return {
			success: true,
			kind:
				policy.kind === "cross_project_move"
					? "moved"
					: "same_project_recovered",
		};
	} catch (err) {
		if (err instanceof AppBusyError) {
			return {
				success: false,
				code: "busy",
				error:
					"This app is being generated right now. Try again once it finishes.",
			};
		}
		/* The move transaction's own refusals already carry person-readable copy —
		 * an app that references lookup tables, out-of-sync edges, a destination
		 * role the actor lacks, a source Owner who is not a member there. Passing
		 * them through keeps an ordinary expected outcome out of Sentry and off
		 * the "try again" path, which would never succeed. */
		if (err instanceof BlueprintCommitRejectedError) {
			return { success: false, code: "move_rejected", error: err.message };
		}
		if (err instanceof CommitReauthError) {
			return { success: false, code: "not_permitted", error: err.message };
		}
		if (err instanceof AppRunStateCorruptError) {
			return {
				success: false,
				code: "run_state_corrupt",
				error:
					"This app's last Solutions Architect run left an inconsistent record, so it can't move yet. Contact support.",
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
