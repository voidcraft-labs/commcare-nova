/**
 * Cross-store authorization fence for actor-authored case mutations.
 *
 * App state, Better Auth membership rows, and case data share one physical
 * Postgres database. The case-store injects this callback into every actor
 * write so the fresh app Project, membership role, and case rows are decided
 * by one transaction and one lock set.
 */

import type { Transaction } from "kysely";
import type { Database as CaseDatabase } from "@/lib/case-store/sql/database";
import { AppAccessError, resolveAppScopeInTransaction } from "./appAccess";
import type { AppDatabase } from "./pg";

export async function authorizeCaseMutationInTransaction(
	caseTx: Transaction<CaseDatabase>,
	args: {
		readonly appId: string;
		readonly projectId: string;
		readonly actorUserId: string;
	},
): Promise<void> {
	// This is a type-only table-map join: both views are the exact same Kysely
	// transaction and physical connection. No second checkout or nested
	// transaction occurs.
	const appTx = caseTx as unknown as Transaction<AppDatabase>;
	const scope = await resolveAppScopeInTransaction(
		appTx,
		args.appId,
		args.actorUserId,
		"edit",
	);
	if (scope.projectId !== args.projectId) {
		// A store bound before a Project move is stale. Collapse the mismatch to
		// the same IDOR-safe denial as an absent/foreign app.
		throw new AppAccessError("not_found");
	}
}

/**
 * Fence an actor-free, app-scoped schema write against Project moves.
 *
 * Schema maintenance has no requesting user or tenant filter, but it still
 * belongs to one live app. Taking `apps FOR SHARE` as the first operation in
 * the schema transaction makes that app's current Project placement stable
 * until the schema/data phase commits. A concurrent Project move takes the
 * conflicting app-row lock, so the two operations have an unambiguous winner.
 */
export async function authorizeSystemSchemaMutationInTransaction(
	caseTx: Transaction<CaseDatabase>,
	args: { readonly appId: string },
): Promise<{ readonly projectId: string }> {
	const appTx = caseTx as unknown as Transaction<AppDatabase>;
	const app = await appTx
		.selectFrom("apps")
		.select(["project_id", "deleted_at"])
		.where("id", "=", args.appId)
		.forShare()
		.executeTakeFirst();
	if (!app?.project_id || app.deleted_at !== null) {
		throw new AppAccessError("not_found");
	}
	return { projectId: app.project_id };
}
