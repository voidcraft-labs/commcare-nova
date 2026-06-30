/**
 * Server Actions for the home-page app list — soft-delete and restore.
 *
 * Mirrors the discriminated-union pattern in `settings/oauth-actions.ts`:
 * never throws, always returns a structured result. Next surfaces
 * unhandled Server Action errors as full-page error boundaries, which
 * would tear down the per-card state machine mid-flight.
 *
 * Both actions follow the same pre-flight: session → ownership → write
 * → `revalidatePath("/")`. The revalidate is the primary refresh
 * mechanism — it re-runs the home page's RSC, both lists re-fetch, and
 * the row drops out of (or into) the appropriate list naturally. No
 * client-side optimistic moves to coordinate.
 */

"use server";

import { revalidatePath } from "next/cache";
import { roleIsOwner } from "@/lib/auth/projectRoles";
import { getSession } from "@/lib/auth-utils";
import {
	AppAccessError,
	resolveAppAccess,
	resolveAppScope,
	resolveProjectAccess,
} from "@/lib/db/appAccess";
import { restoreApp as restoreAppDoc, softDeleteApp } from "@/lib/db/apps";
import { AppBusyError, moveAppToProject } from "@/lib/db/moveAppToProject";
import { log } from "@/lib/logger";
import { projectIsPersonal } from "@/lib/projects/membership";

// ── Types ──────────────────────────────────────────────────────────

/** Result of `deleteApp`. Carries the recovery deadline on success so the UI can surface it. */
export type DeleteAppResult =
	| { success: true; recoverableUntil: string }
	| { success: false; error: string };

/** Result of `restoreApp`. */
export type RestoreAppResult =
	| { success: true }
	| { success: false; error: string };

/** Result of `moveApp`. */
export type MoveAppResult =
	| { success: true }
	| { success: false; error: string };

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Discriminated authorization result. Returns the same `App not found`
 * message whether the row is genuinely missing or owned by another user
 * — surfacing a different message on cross-tenant probes would leak
 * existence information about other users' apps.
 */
type AuthResult = { ok: true } | { ok: false; error: string };

/**
 * Pre-flight that both actions share. Validates `appId` survived JSON
 * deserialization as a non-empty string and the caller actually owns
 * the row. Session validation is the caller's responsibility — `userId`
 * is passed in already trusted. Returns a tagged failure rather than
 * throwing so each action can map directly to its result type without
 * a try/catch around the gate itself.
 *
 * Server Actions deserialize JSON and the `string` annotation alone
 * does NOT enforce shape at runtime — a malformed client could send
 * anything — so the trim guard is real, not theatre.
 */
async function authorizeAppMutation(
	appId: string,
	userId: string,
): Promise<AuthResult> {
	if (typeof appId !== "string" || !appId.trim()) {
		return { ok: false, error: "Missing app identifier." };
	}
	/* Soft-delete / restore require the `delete` capability (admin/owner).
	 * Every denial collapses to the same "App not found" so a cross-Project
	 * probe can't tell a real app apart from a missing one. */
	try {
		await resolveAppScope(appId, userId, "delete");
	} catch (err) {
		if (err instanceof AppAccessError) {
			return { ok: false, error: "App not found." };
		}
		throw err;
	}
	return { ok: true };
}

// ── Actions ────────────────────────────────────────────────────────

/**
 * Soft-delete the user's own app. Wraps `softDeleteApp` (which sets
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

		const auth = await authorizeAppMutation(appId, session.user.id);
		if (!auth.ok) return { success: false, error: auth.error };

		const recoverableUntil = await softDeleteApp(appId);
		revalidatePath("/");
		return { success: true, recoverableUntil };
	} catch (err) {
		log.error("[home/delete-app] error", err);
		return {
			success: false,
			error: "Could not delete. Please try again.",
		};
	}
}

/**
 * Restore a soft-deleted app the user owns. Inverse of `deleteApp` —
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

		const auth = await authorizeAppMutation(appId, session.user.id);
		if (!auth.ok) return { success: false, error: auth.error };

		await restoreAppDoc(appId);
		revalidatePath("/");
		return { success: true };
	} catch (err) {
		log.error("[home/restore-app] error", err);
		return {
			success: false,
			error: "Could not restore. Please try again.",
		};
	}
}

/**
 * Move an app into another Project the caller helps run. Moving an app is a
 * governance act on BOTH Projects — it removes the app (and its case data) from
 * the source for everyone there, and injects it into the destination's shared
 * space — so both bars are admin/owner (`delete`): admin/owner of the source to
 * release it, admin/owner of the destination to accept it. The orchestrator
 * re-tenants the app's case data + media to match (`moveAppToProject`).
 *
 * One extra guard closes the "pocket someone else's app" hole: moving an app into
 * a PERSONAL Project requires OWNING the source. You're always owner of your own
 * personal Project, so the destination bar alone wouldn't stop an admin from
 * relocating a shared app into their solo space and cutting off the owner — this
 * does.
 *
 * Every authorization denial collapses to a not-found-shaped message — the source
 * to the same `App not found` as a missing row, the destination to one generic
 * line that neither confirms nor denies an arbitrary `toProjectId` exists — so a
 * crafted request can't probe either side.
 */
export async function moveApp(
	appId: string,
	toProjectId: string,
): Promise<MoveAppResult> {
	try {
		const session = await getSession();
		if (!session) {
			return { success: false, error: "Authentication required." };
		}

		/* Server Actions deserialize JSON; the `string` annotation is not a runtime
		 * guarantee, so the trim guards are real (mirrors `authorizeAppMutation`). */
		if (
			typeof appId !== "string" ||
			!appId.trim() ||
			typeof toProjectId !== "string" ||
			!toProjectId.trim()
		) {
			return { success: false, error: "Missing app or Project identifier." };
		}

		// Source: admin/owner of the app's current Project.
		let access: Awaited<ReturnType<typeof resolveAppAccess>>;
		try {
			access = await resolveAppAccess(appId, session.user.id, "delete");
		} catch (err) {
			if (err instanceof AppAccessError) {
				return { success: false, error: "App not found." };
			}
			throw err;
		}

		if (access.projectId === toProjectId) {
			return { success: false, error: "This app is already in that Project." };
		}

		// Destination: admin/owner of the destination (the mirror of releasing it
		// from the source — accepting an app injects its data into the Project).
		try {
			await resolveProjectAccess(session.user.id, toProjectId, "delete");
		} catch (err) {
			if (err instanceof AppAccessError) {
				return {
					success: false,
					error: "Couldn't move the app to that Project.",
				};
			}
			throw err;
		}

		// Taking an app into a personal Project is owner-only on the source — you're
		// always owner of your own personal Project, so without this an admin could
		// pocket a shared app into their solo space and cut off the owner.
		if ((await projectIsPersonal(toProjectId)) && !roleIsOwner(access.role)) {
			return {
				success: false,
				error: "Couldn't move the app to that Project.",
			};
		}

		await moveAppToProject({
			appId,
			fromProjectId: access.projectId,
			toProjectId,
			actorUserId: session.user.id,
			app: access.app,
		});
		revalidatePath("/");
		return { success: true };
	} catch (err) {
		if (err instanceof AppBusyError) {
			return {
				success: false,
				error:
					"This app is being generated right now — try again once it finishes.",
			};
		}
		log.error("[home/move-app] error", err);
		return { success: false, error: "Could not move. Please try again." };
	}
}
