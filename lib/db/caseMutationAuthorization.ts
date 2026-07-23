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
