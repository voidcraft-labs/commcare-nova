// lib/projects/moveTargets.ts
//
// Pure helpers behind the home-page "Move to Project" affordance: who may move an
// app out of a Project, and which Projects it may move into. Kept dependency-free
// (only the client-safe role helpers) so the page can compute the destinations
// server-side and the rules can be unit-tested without a DB or a DOM.

import { roleAllowsApp, roleIsOwner } from "@/lib/auth/projectRoles";
import type { ProjectSummary } from "./membership";

/** A Project an app can be moved into — just what the picker needs to render. */
export interface MoveTarget {
	id: string;
	name: string;
}

/**
 * Whether a member holding `role` may move apps OUT of that Project. Moving an
 * app removes it from the Project for everyone in it (and relocates its case
 * data) — a governance act on the Project's contents — so it needs the `delete`
 * capability (admin/owner), the same bar `deleteApp` uses.
 */
export function canMoveAppsFrom(role: string): boolean {
	return roleAllowsApp(role, "delete");
}

/**
 * The Projects an app may be moved INTO. Receiving an app injects it (and its
 * case data + media) into the Project's shared space, exposing it to every member
 * and handing governance to the Project's owner — the mirror of moving one out —
 * so the destination bar is also admin/owner (`delete`), not merely editor.
 *
 * A PERSONAL Project is offered as a destination only when the caller owns the
 * SOURCE (`sourceRole`): you can take your OWN app private, but an admin can't
 * pocket someone else's app into their solo space and strip the owner. (You're
 * always owner of your personal Project, so the destination bar alone wouldn't
 * stop that — this guard does.)
 */
export function eligibleMoveTargets(
	projects: readonly ProjectSummary[],
	activeProjectId: string,
	sourceRole: string,
): MoveTarget[] {
	const sourceIsOwner = roleIsOwner(sourceRole);
	return projects
		.filter(
			(p) =>
				p.id !== activeProjectId &&
				roleAllowsApp(p.role, "delete") &&
				(!p.personal || sourceIsOwner),
		)
		.map((p) => ({ id: p.id, name: p.name }));
}
