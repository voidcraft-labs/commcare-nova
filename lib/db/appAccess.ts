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

import type { Transaction } from "kysely";
import { getAuthDb } from "@/lib/auth/db";
import { type AppCapability, roleAllowsApp } from "@/lib/auth/projectRoles";
import { loadApp, loadAppInTransaction, loadAppProjectId } from "./apps";
import { safePersistedSequence } from "./persistedJson";
import type { AppDatabase } from "./pg";
import { withAppTx } from "./pg";
import {
	projectRoleFor,
	projectRoleForInTransaction,
} from "./projectMembership";
import {
	type AppDoc,
	type AppLifecycleStatus,
	parsePersistedAppLifecycleStatus,
} from "./types";

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

/**
 * An app scope resolved while the app row and membership decision remain in one
 * transaction lock set. `baseSeq` is read from the locked app row, so stream
 * registration and full-document snapshots can use it as their exact cursor.
 */
export interface TransactionalAppScope extends ProjectAccess {
	readonly canEdit: boolean;
	readonly baseSeq: number;
	/** The locked app row's run-lifecycle status. The SSE relay projects it to
	 *  connected tabs as `app-status` frames (connect + its reauthorization
	 *  cadence), which is how a tab not attached to a run's chat stream learns
	 *  a build finished. */
	readonly status: AppLifecycleStatus;
}

/**
 * The complete builder/reload snapshot: authorization metadata and the app doc
 * assembled under the same app-row + membership lock set.
 */
export interface AuthorizedAppSnapshot extends AppAccess {
	readonly canEdit: boolean;
	readonly baseSeq: number;
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
 * second app-row read). Throws {@link AppAccessError} on any denial.
 */
export async function resolveAppAccess(
	appId: string,
	userId: string,
	required: AppCapability,
	opts?: { app?: AppDoc },
): Promise<AppAccess> {
	const app = opts?.app ?? (await loadApp(appId));
	if (!app) throw new AppAccessError("not_found");
	const role = await projectRoleFor(userId, app.project_id);
	assertCapability(role, required);
	return { app, projectId: app.project_id, role, actorUserId: userId };
}

/**
 * Resolve an app's current Project, role, edit capability, and mutation cursor
 * on the caller's transaction.
 *
 * Lock order is deliberate: `apps FOR SHARE` first, then the shared
 * Project-membership advisory gate inside `projectRoleForInTransaction`, then
 * the exact membership row `FOR SHARE`. A Project move or blueprint commit
 * takes the conflicting app-row lock, while Better Auth membership DML takes
 * the conflicting advisory lock. The returned tuple therefore represents one
 * serial winner, including when the membership row is absent.
 */
export async function resolveAppScopeInTransaction(
	tx: Transaction<AppDatabase>,
	appId: string,
	userId: string,
	required: AppCapability = "view",
): Promise<TransactionalAppScope> {
	const app = await tx
		.selectFrom("apps")
		.select(["project_id", "mutation_seq", "deleted_at", "status"])
		.where("id", "=", appId)
		.forShare()
		.executeTakeFirst();
	if (!app || app.deleted_at !== null) {
		throw new AppAccessError("not_found");
	}

	const role = await projectRoleForInTransaction(tx, userId, app.project_id);
	assertCapability(role, required);
	return {
		projectId: app.project_id,
		role,
		canEdit: roleAllowsApp(role, "edit"),
		baseSeq: safePersistedSequence(
			app.mutation_seq,
			`apps.mutation_seq for app ${appId}`,
		),
		status: parsePersistedAppLifecycleStatus(app.status),
		actorUserId: userId,
	};
}

/**
 * Load the authoritative app snapshot used by initial builder hydration and
 * reload GETs. Both authorization and blueprint assembly happen before one
 * transaction releases its app-row and membership locks, so `projectId`,
 * `role`, `canEdit`, `blueprint`, and `baseSeq` cannot straddle a commit.
 */
export async function resolveAuthorizedAppSnapshot(
	appId: string,
	userId: string,
	required: AppCapability = "view",
): Promise<AuthorizedAppSnapshot> {
	return withAppTx(async (tx) => {
		const scope = await resolveAppScopeInTransaction(
			tx,
			appId,
			userId,
			required,
		);
		const app = await loadAppInTransaction(tx, appId);
		if (!app) throw new AppAccessError("not_found");
		if (
			app.project_id !== scope.projectId ||
			app.mutation_seq !== scope.baseSeq
		) {
			throw new Error("Authorized app snapshot lock invariant was violated.");
		}
		return { app, ...scope };
	});
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
	const lookup = await loadAppProjectId(appId);
	if (lookup.kind === "not-found") throw new AppAccessError("not_found");
	const role = await projectRoleFor(userId, lookup.projectId);
	assertCapability(role, required);
	return { projectId: lookup.projectId, role, actorUserId: userId };
}

/**
 * Authorize a Project directly (no app yet) — for new-app creation, where the
 * caller must hold `required` on the target Project. The wire collapses every
 * denial to not-found either way; the reasons exist for the audit log, where
 * a typo'd Project id (`not_found`) must not read as a cross-tenant probe
 * (`not_member`) — so a missing membership checks whether the Project exists
 * at all before choosing. The existence read runs only on the denial path.
 */
export async function resolveProjectAccess(
	userId: string,
	projectId: string,
	required: AppCapability,
): Promise<ProjectAccess> {
	const role = await projectRoleFor(userId, projectId);
	if (role === null) {
		const db = await getAuthDb();
		const org = await db
			.selectFrom("auth_organization")
			.select("id")
			.where("id", "=", projectId)
			.executeTakeFirst();
		throw new AppAccessError(org === undefined ? "not_found" : "not_member");
	}
	assertCapability(role, required);
	return { projectId, role, actorUserId: userId };
}

/**
 * Boolean form of {@link resolveProjectAccess} — does `userId` hold `required`
 * in `projectId`? For the media read/list sites, which authorize an asset by
 * its `project_id` (Project membership) and want a 404-vs-serve decision, not a
 * throw. Only an `AppAccessError` reads as "no"; any other error propagates.
 */
export async function userInProject(
	userId: string,
	projectId: string,
	required: AppCapability,
): Promise<boolean> {
	try {
		await resolveProjectAccess(userId, projectId, required);
		return true;
	} catch (err) {
		if (err instanceof AppAccessError) return false;
		throw err;
	}
}

/** Fresh serialized Project/role/capability snapshot for cadence or migration. */
export async function reauthorizeStreamScope(
	appId: string,
	userId: string,
): Promise<TransactionalAppScope> {
	return withAppTx((tx) =>
		resolveAppScopeInTransaction(tx, appId, userId, "view"),
	);
}
