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
import { getSession } from "@/lib/auth-utils";
import {
	loadApp,
	restoreApp as restoreAppDoc,
	softDeleteApp,
} from "@/lib/db/apps";
import { log } from "@/lib/logger";

// ── Types ──────────────────────────────────────────────────────────

/** Result of `deleteApp`. Carries the recovery deadline on success so the UI can surface it. */
export type DeleteAppResult =
	| { success: true; recoverableUntil: string }
	| { success: false; error: string };

/** Result of `restoreApp`. */
export type RestoreAppResult =
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
	const app = await loadApp(appId);
	if (!app || app.owner !== userId) {
		return { ok: false, error: "App not found." };
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
