// lib/projects/moveTargets.ts
//
// Pure policy behind the home-page Project-placement affordance. The dormant
// move protocol is implemented, but true moves remain closed until the S07
// compatibility cutover activates them. Keep the policy dependency-free so the
// Server Action, database orchestrator, and explanatory UI share one contract.

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
 * Whether a member holding `role` would manage app placement. The staged block
 * still shows those members an informational affordance rather than
 * hiding the previously available operation. Moving an app is a governance act,
 * so this remains tied to the Project's `delete` capability (admin/owner).
 */
export function canManageAppPlacement(role: string): boolean {
	return roleAllowsApp(role, "delete");
}

/**
 * Classify a requested Project change. Until S07 activation, exact equality is
 * intentionally the only permitted branch: it is not a move, but the idempotent
 * case-tenancy repair entry point.
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
