// lib/projects/moveTargets.ts
//
// Pure helpers behind the home-page "Move to Project" affordance: who may move an
// app out of a Project, and which Projects it may move into. Kept dependency-free
// (only the client-safe role helpers) so the page can compute the destinations
// server-side and the rules can be unit-tested without a DB or a DOM.

import { roleAllowsApp } from "@/lib/auth/projectRoles";
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
 * The CANDIDATE destination Projects: every Project the caller is admin/owner of
 * (receiving an app injects its data into the Project, so the destination bar is
 * also `delete`, not merely editor) except the one the app already lives in.
 *
 * This is the membership-only filter the caller can compute purely. The move's
 * owner-PROTECTION rule (a non-owner of the source may only target a destination
 * the source owner also belongs to) needs the source owner's destination
 * membership — a DB read — so the page applies it on top of this list, mirroring
 * the Server Action's authoritative check.
 */
export function eligibleMoveTargets(
	projects: readonly ProjectSummary[],
	activeProjectId: string,
): MoveTarget[] {
	return projects
		.filter((p) => p.id !== activeProjectId && roleAllowsApp(p.role, "delete"))
		.map((p) => ({ id: p.id, name: p.name }));
}
