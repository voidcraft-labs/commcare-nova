// lib/projects/moveTargets.ts
//
// Pure policy behind the home-page Project-placement affordance. S01 temporarily
// blocks every true cross-Project move while lookup data is Project-scoped but
// not yet reference-aware. Keep the policy dependency-free so the Server Action,
// database orchestrator, and explanatory UI share one exact contract.

import { roleAllowsApp } from "@/lib/auth/projectRoles";

export const CROSS_PROJECT_MOVE_UNAVAILABLE_CODE =
	"cross_project_move_unavailable" as const;

export const CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE =
	"Apps can't move between Projects yet. This app and its shared data will stay in the current Project.";

export type AppProjectMovePolicy =
	| { kind: "same_project_recovery" }
	| {
			kind: "cross_project_blocked";
			code: typeof CROSS_PROJECT_MOVE_UNAVAILABLE_CODE;
			message: typeof CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE;
	  };

/**
 * Whether a member holding `role` would manage app placement. The temporary S01
 * block still shows those members an informational affordance rather than
 * hiding the previously available operation. Moving an app is a governance act,
 * so this remains tied to the Project's `delete` capability (admin/owner).
 */
export function canManageAppPlacement(role: string): boolean {
	return roleAllowsApp(role, "delete");
}

/**
 * Classify a requested Project change. Exact equality is intentionally the only
 * permitted branch: it is not a move, but the idempotent recovery entry point
 * that reconciles case rows after an older partially completed move.
 */
export function appProjectMovePolicy(
	fromProjectId: string,
	toProjectId: string,
): AppProjectMovePolicy {
	if (fromProjectId === toProjectId) {
		return { kind: "same_project_recovery" };
	}
	return {
		kind: "cross_project_blocked",
		code: CROSS_PROJECT_MOVE_UNAVAILABLE_CODE,
		message: CROSS_PROJECT_MOVE_UNAVAILABLE_MESSAGE,
	};
}
