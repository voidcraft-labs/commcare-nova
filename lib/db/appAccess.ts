// Project-membership authorization for apps — the ONE resolver that replaces
// the scattered `app.owner === userId` checks. Given an app (or a Project) and
// a user, it reads the user's role in the owning Project (`auth_member`) and
// answers whether they hold the required app capability.
//
// Every wire surface collapses all three denial reasons to a not-found-shaped
// failure (404 / notFound() / `not_found`) — the IDOR-hardening posture the MCP
// ownership gate has always used. The `reason` is internal only, for audit logs
// that distinguish a typo (`not_found`) from a cross-tenant probe (`not_member`)
// or an under-privileged member (`insufficient_role`).
//
// Lives in `lib/db` (next to `loadApp`) and reads `auth_member` directly through
// `getAuthDb`, the same cross-store pattern `lib/db/api-keys.ts` already uses.

import { getAuthDb } from "@/lib/auth/db";
import { type AppCapability, roleAllowsApp } from "@/lib/auth/projectRoles";
import { ensurePersonalProject } from "@/lib/auth/provisionProject";
import { loadApp, loadAppProjectId } from "./apps";
import type { AppDoc } from "./types";

export type AppAccessReason = "not_found" | "not_member" | "insufficient_role";

/**
 * Thrown when a caller can't access an app/Project at the required capability.
 * `readonly name` initializer so the class name survives bundler transforms
 * (matches the case-store error classes).
 */
export class AppAccessError extends Error {
	readonly name = "AppAccessError";
	constructor(readonly reason: AppAccessReason) {
		super(reason);
	}
}

/** A resolved, authorized app access — the app doc plus the caller's role. */
export interface AppAccess {
	readonly app: AppDoc;
	readonly projectId: string;
	readonly role: string;
	/** The acting user — billing/attribution key, never the tenant. */
	readonly actorUserId: string;
}

/** A resolved, authorized Project access (no specific app). */
export interface ProjectAccess {
	readonly projectId: string;
	readonly role: string;
	readonly actorUserId: string;
}

/** The caller's role in `organizationId`, or null if they aren't a member. */
async function projectRoleFor(
	userId: string,
	organizationId: string,
): Promise<string | null> {
	const db = await getAuthDb();
	const row = await db
		.selectFrom("auth_member")
		.select("role")
		.where("userId", "=", userId)
		.where("organizationId", "=", organizationId)
		.executeTakeFirst();
	return row?.role ?? null;
}

/** Throws unless `userId` holds `required` on `projectId`. */
function assertCapability(
	role: string | null,
	required: AppCapability,
): asserts role is string {
	if (role === null) throw new AppAccessError("not_member");
	if (!roleAllowsApp(role, required)) {
		throw new AppAccessError("insufficient_role");
	}
}

/**
 * Resolve + authorize access to `appId` at the `required` capability. Pass a
 * pre-loaded `opts.app` to reuse a doc the caller already fetched (avoids a
 * second Firestore read). Throws {@link AppAccessError} on any denial.
 */
export async function resolveAppAccess(
	appId: string,
	userId: string,
	required: AppCapability,
	opts?: { app?: AppDoc },
): Promise<AppAccess> {
	const app = opts?.app ?? (await loadApp(appId));
	if (!app) throw new AppAccessError("not_found");
	if (!app.project_id) return legacyOwnerFallback(app, userId);
	const role = await projectRoleFor(userId, app.project_id);
	assertCapability(role, required);
	return { app, projectId: app.project_id, role, actorUserId: userId };
}

/**
 * TRANSITION fallback — remove in the post-backfill contract step. An app that
 * predates the `project_id` backfill carries no tenancy key yet, so authorize it
 * by the legacy owner-equality rule: this keeps every existing app reachable by
 * its creator the instant the membership read-switch deploys, BEFORE the backfill
 * runs (merge-to-main auto-deploys, so there is no manual gap). The creator maps
 * to owner capability; the Project is their personal one — the backfill target.
 */
async function legacyOwnerFallback(
	app: AppDoc,
	userId: string,
): Promise<AppAccess> {
	if (app.owner !== userId) throw new AppAccessError("not_member");
	const projectId = await ensurePersonalProject(app.owner);
	return { app, projectId, role: "owner", actorUserId: userId };
}

/**
 * Lightweight twin of {@link resolveAppAccess} for surfaces that need only the
 * gate + the resolved Project/role, not the full blueprint (the threads route,
 * the MCP ownership gate). Reads only `project_id` via `loadAppProjectId`.
 */
export async function resolveAppScope(
	appId: string,
	userId: string,
	required: AppCapability = "view",
): Promise<ProjectAccess> {
	const projectId = await loadAppProjectId(appId);
	if (projectId !== null) {
		const role = await projectRoleFor(userId, projectId);
		assertCapability(role, required);
		return { projectId, role, actorUserId: userId };
	}
	/* Null project_id means the app is absent OR predates the backfill. Load the
	 * full doc to tell them apart, then apply the same legacy owner-equality
	 * fallback as `resolveAppAccess`. Only the transitional path pays the full
	 * read; once backfilled, the light path above always wins. */
	const app = await loadApp(appId);
	if (!app) throw new AppAccessError("not_found");
	if (app.project_id) {
		const role = await projectRoleFor(userId, app.project_id);
		assertCapability(role, required);
		return { projectId: app.project_id, role, actorUserId: userId };
	}
	const fallback = await legacyOwnerFallback(app, userId);
	return {
		projectId: fallback.projectId,
		role: fallback.role,
		actorUserId: userId,
	};
}

/**
 * Authorize a Project directly (no app yet) — for new-app creation, where the
 * caller must hold `required` on the target Project. Membership-missing throws
 * `not_member`; the wire collapses it like every other denial.
 */
export async function resolveProjectAccess(
	userId: string,
	projectId: string,
	required: AppCapability,
): Promise<ProjectAccess> {
	const role = await projectRoleFor(userId, projectId);
	assertCapability(role, required);
	return { projectId, role, actorUserId: userId };
}
