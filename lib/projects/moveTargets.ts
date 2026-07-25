// lib/projects/moveTargets.ts
//
// Pure policy behind the home-page Project-placement affordance. Keep the
// policy dependency-free so the Server Action, database orchestrator, and UI
// share one contract.

import { roleAllowsApp } from "@/lib/auth/projectRoles";

/**
 * What a move carries with it. Shown before the move, not after: an app's
 * conversations and the files attached in them are part of the app, so they
 * become visible to the destination Project's members.
 */
export const CROSS_PROJECT_MOVE_DISCLOSURE =
	"The app's case data, media, and chat history — including files attached in chat — move with it. Everyone in the destination Project will be able to see them.";

export type AppProjectMovePolicy =
	| { kind: "same_project_recovery" }
	| { kind: "cross_project_move" };

/**
 * Whether a member holding `role` may manage app placement. Moving an app is a
 * governance act, so it is tied to the Project's `delete` capability
 * (admin/owner) — and the database requires it in BOTH Projects.
 */
export function canManageAppPlacement(role: string): boolean {
	return roleAllowsApp(role, "delete");
}

/**
 * Classify a requested Project change. Exact equality is not a move at all: it
 * is the idempotent case-tenancy repair entry point.
 */
export function appProjectMovePolicy(
	fromProjectId: string,
	toProjectId: string,
): AppProjectMovePolicy {
	if (fromProjectId === toProjectId) {
		return { kind: "same_project_recovery" };
	}
	return { kind: "cross_project_move" };
}
