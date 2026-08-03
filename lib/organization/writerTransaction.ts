import "server-only";

import { sql, type Transaction } from "kysely";
import { type AppCapability, roleAllowsApp } from "@/lib/auth/projectRoles";
import {
	AppProjectChangedError,
	CommitReauthError,
	RunHolderLostError,
} from "@/lib/db/commitGuard";
import { LEASE_COLUMNS, leaseView } from "@/lib/db/leaseView";
import { type AppDatabase, notifyAppOrganization } from "@/lib/db/pg";
import { projectRoleForInTransaction } from "@/lib/db/projectMembership";
import { exactRunHolderMatches } from "@/lib/db/runHolderWrites";
import { runLeaseState } from "@/lib/db/runLiveness";
import { OrganizationError } from "./errors";
import { parseOrganizationRevision } from "./schema";
import type { OrganizationRevision, OrganizationScope } from "./types";

/**
 * The one lock / revision / notify protocol every organization writer shares.
 *
 * **Lock order, and why it is not a new prefix.** Every write here takes the
 * APP ROW first, exactly as every run, commit, and thread write already does,
 * and only then the organization state row and the location rows. That is a
 * continuation of `lib/db`'s existing app-first prefix, not a fourth one — so
 * a level removal inside a blueprint commit (which holds the app row `FOR
 * UPDATE` and then reads `app_locations`) and a concurrent location insert at
 * that level serialize on the app row instead of racing. Lookup writers take
 * Project state before their table and never take an app lock at all, so
 * neither prefix ever holds a lock the other takes first.
 *
 * **Why `FOR SHARE` is the default and `FOR UPDATE` an argument.** An
 * ordinary location write changes no blueprint, so it only has to prove the
 * app exists, is live, and has not moved Projects — a share lock does that
 * while letting an unrelated blueprint commit proceed. A write that ALSO
 * changes the document (the archive cascade rewrites persona assignments)
 * must take the exclusive lock, because it is going to perform a guarded
 * commit on the same transaction.
 */
export interface LockedOrganization {
	readonly revision: OrganizationRevision;
	readonly locationCount: number;
}

export async function lockOrganizationForWrite(
	tx: Transaction<AppDatabase>,
	scope: OrganizationScope,
	options: {
		readonly capability: AppCapability;
		/** `true` when this transaction will also commit a blueprint batch. */
		readonly exclusiveApp?: boolean;
	},
): Promise<LockedOrganization> {
	const app = await (options.exclusiveApp === true
		? tx
				.selectFrom("apps")
				.select(["project_id", "deleted_at", ...LEASE_COLUMNS])
				.where("id", "=", scope.appId)
				.forUpdate()
				.executeTakeFirst()
		: tx
				.selectFrom("apps")
				.select(["project_id", "deleted_at", ...LEASE_COLUMNS])
				.where("id", "=", scope.appId)
				.forShare()
				.executeTakeFirst());

	// A missing app, a soft-deleted app, and an app that moved out from under
	// the caller's authorized snapshot all collapse to one shape. The Project
	// comparison is the same guarantee `expectedProjectId` gives a blueprint
	// commit: an authorization decided before this lock is worthless if the
	// app changed tenant in between.
	if (app === undefined || app.deleted_at !== null || app.project_id === null) {
		if (scope.chatRunHolder !== undefined) {
			throw new CommitReauthError("App not found.");
		}
		throw new OrganizationError(
			"not_found",
			"This app's organization isn't available. It may have been deleted or moved to another project — reload to get the latest state.",
		);
	}
	if (app.project_id !== scope.projectId) {
		if (scope.chatRunHolder !== undefined) throw new AppProjectChangedError();
		throw new OrganizationError(
			"not_found",
			"This app's organization isn't available. It may have been deleted or moved to another project — reload to get the latest state.",
		);
	}

	// Re-authorize against the FRESHLY LOCKED Project rather than trusting the
	// role the scope was built with. A membership removed between the read and
	// the write must stop the write, and the membership gate inside this helper
	// is what serializes against Better Auth's own membership DML.
	const role = await projectRoleForInTransaction(
		tx,
		scope.actorUserId,
		app.project_id,
	);
	if (role === null || !roleAllowsApp(role, options.capability)) {
		if (scope.chatRunHolder !== undefined) {
			throw new CommitReauthError(
				"You no longer have edit access to this app's Project.",
			);
		}
		throw new OrganizationError(
			"not_found",
			"This app's organization isn't available. It may have been deleted, moved, or you may no longer have access to it.",
		);
	}

	// A chat tool's user membership is necessary but not sufficient authority:
	// the exact run generation must still own the app. The app lock makes this
	// check a fence for the rest of the transaction, so a successor cannot take
	// over between the comparison and a location/Blueprint write. MCP and
	// browser actions omit the token and continue to use actor authorization.
	if (scope.chatRunHolder !== undefined) {
		const lease = runLeaseState(leaseView(app));
		if (!exactRunHolderMatches(lease.holderIdentity, scope.chatRunHolder)) {
			throw new RunHolderLostError(lease.present ? "superseded" : "released");
		}
	}

	await tx
		.insertInto("app_organization_state")
		.values({ app_id: scope.appId })
		.onConflict((conflict) => conflict.column("app_id").doNothing())
		.execute();
	const state = await tx
		.selectFrom("app_organization_state")
		.select(["revision", "location_count"])
		.where("app_id", "=", scope.appId)
		.forUpdate()
		.executeTakeFirst();
	if (state === undefined) {
		throw new Error(
			"App organization state disappeared after its locked upsert.",
		);
	}
	return {
		revision: parseOrganizationRevision(state.revision),
		locationCount: state.location_count,
	};
}

/**
 * Compare the caller's optimistic token against the locked clock.
 *
 * Callers pass the revision the displayed organization was read at. A
 * mismatch means someone else changed the tree, and the rejection carries the
 * current revision so the client can re-read rather than guess.
 */
export function assertExpectedOrganizationRevision(
	locked: LockedOrganization,
	expectedRevision: OrganizationRevision | undefined,
): void {
	if (expectedRevision === undefined) return;
	if (locked.revision === expectedRevision) return;
	throw new OrganizationError(
		"conflict",
		"This app's organization changed since you loaded it. Reload to get the latest places, then try again.",
		{ currentRevision: locked.revision },
	);
}

/**
 * Advance the clock, update the maintained count, and poke subscribers — the
 * closing three steps of every write that actually changed something.
 *
 * A rejected or semantically empty write must NOT call this: an advancing
 * revision with no change invalidates every client's snapshot for nothing,
 * which is the difference between an invalidation cursor and a change log.
 */
export async function commitOrganizationChange(
	tx: Transaction<AppDatabase>,
	scope: OrganizationScope,
	countDelta: number,
): Promise<OrganizationRevision> {
	return advanceOrganizationRevision(tx, scope.appId, countDelta);
}

/** Advance the organization clock from a transaction that already owns the
 * app-row serialization prefix, including blueprint commits that shed saved
 * place values without entering the ordinary organization writer. */
export async function advanceOrganizationRevision(
	tx: Transaction<AppDatabase>,
	appId: string,
	countDelta: number,
): Promise<OrganizationRevision> {
	await tx
		.insertInto("app_organization_state")
		.values({ app_id: appId })
		.onConflict((conflict) => conflict.column("app_id").doNothing())
		.execute();
	const row = await tx
		.updateTable("app_organization_state")
		.set({
			revision: sql<string>`revision + 1`,
			location_count: sql<number>`location_count + ${countDelta}`,
			updated_at: new Date(),
		})
		.where("app_id", "=", appId)
		.returning("revision")
		.executeTakeFirst();
	if (row === undefined) {
		throw new Error(
			"App organization state disappeared while advancing its revision.",
		);
	}
	const revision = parseOrganizationRevision(row.revision);
	await notifyAppOrganization(tx, appId, revision);
	return revision;
}
