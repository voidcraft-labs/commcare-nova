// lib/projects/moveTargets.ts
//
// Pure policy behind the home-page Project-placement affordance. Cross-Project
// moves are runtime-switched, so the caller supplies the current enablement and
// this module decides nothing else. Keep the policy dependency-free so the
// Server Action, database orchestrator, and UI share one contract.

import { roleAllowsApp } from "@/lib/auth/projectRoles";

export const CROSS_PROJECT_MOVE_UNAVAILABLE_CODE =
	"cross_project_move_unavailable" as const;

export const CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE =
	"Moving apps between Projects is switched off right now. This app and its shared data will stay in the current Project.";

/**
 * What a move carries with it. Shown before the move, not after: an app's
 * conversations and the files attached in them are part of the app, so they
 * become visible to the destination Project's members.
 */
export const CROSS_PROJECT_MOVE_DISCLOSURE =
	"The app's case data, media, and chat history — including files attached in chat — move with it. Everyone in the destination Project will be able to see them.";

export type AppProjectMovePolicy =
	| { kind: "same_project_recovery" }
	| { kind: "cross_project_move" }
	| {
			kind: "cross_project_blocked";
			code: typeof CROSS_PROJECT_MOVE_UNAVAILABLE_CODE;
			message: typeof CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE;
	  };

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
 * is the idempotent case-tenancy repair entry point, and stays available even
 * while cross-Project moves are switched off.
 */
export function appProjectMovePolicy(
	fromProjectId: string,
	toProjectId: string,
	movesEnabled: boolean,
): AppProjectMovePolicy {
	if (fromProjectId === toProjectId) {
		return { kind: "same_project_recovery" };
	}
	return movesEnabled
		? { kind: "cross_project_move" }
		: {
				kind: "cross_project_blocked",
				code: CROSS_PROJECT_MOVE_UNAVAILABLE_CODE,
				message: CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE,
			};
}
