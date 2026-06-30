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
 * data), so it is reserved to the OWNER — mirroring the owner being the one
 * member an admin can't remove, an admin must not be able to strip the owner from
 * an app by relocating it. You always own your personal Project, so your own apps
 * move freely; the server `moveApp` action enforces the same bar.
 */
export function canMoveAppsFrom(role: string): boolean {
	return roleIsOwner(role);
}

/**
 * The Projects an app may be moved INTO: every Project the user can create apps
 * in (editor or higher — the capability a new app requires), except the one the
 * app already lives in. The user's personal Project IS eligible (they're its
 * owner), which doubles as the path to take a shared app private again.
 */
export function eligibleMoveTargets(
	projects: readonly ProjectSummary[],
	activeProjectId: string,
): MoveTarget[] {
	return projects
		.filter((p) => p.id !== activeProjectId && roleAllowsApp(p.role, "edit"))
		.map((p) => ({ id: p.id, name: p.name }));
}
