/**
 * Shared query/write core for the case-lifecycle status scan-then-migrate
 * pair. The former `CaseStore.close()` stamped `closed_on` but only wrote
 * status when a caller supplied the optional argument. Nova's preview caller
 * did not, leaving durable rows shaped like `closed_on != null, status = open`.
 *
 * Keep this repair below the CaseStore API: it is a fleet-wide historical
 * convergence over every Project, while a tenant-bound CaseStore is required
 * to stay inside one Project. The predicate is exact and idempotent; neither
 * the closure timestamp nor `modified_on` changes because the original close
 * already stamped the event time correctly.
 */

import type { Kysely } from "kysely";
import type { Database } from "../../lib/case-store/sql/database";

export interface ClosedStatusMismatchGroup {
	readonly appId: string;
	readonly caseType: string;
	readonly storedStatus: string | null;
	readonly rowCount: number;
}

export interface CaseLifecycleStatusScope {
	readonly appId?: string;
}

/** Read-only census of closed rows whose built-in lifecycle status is stale. */
export async function scanClosedStatusMismatches(
	db: Kysely<Database>,
	scope: CaseLifecycleStatusScope = {},
): Promise<ReadonlyArray<ClosedStatusMismatchGroup>> {
	let query = db
		.selectFrom("cases")
		.select(["app_id", "case_type", "status"])
		.select((eb) => eb.fn.countAll<number>().as("row_count"))
		.where("closed_on", "is not", null)
		.where("status", "is distinct from", "closed")
		.groupBy(["app_id", "case_type", "status"])
		.orderBy("app_id", "asc")
		.orderBy("case_type", "asc")
		.orderBy("status", "asc");
	if (scope.appId !== undefined) {
		query = query.where("app_id", "=", scope.appId);
	}
	const rows = await query.execute();
	return rows.map((row) => ({
		appId: row.app_id,
		caseType: row.case_type,
		storedStatus: row.status,
		// node-postgres returns COUNT as an int8 string even when Kysely's
		// expression type is numeric. Normalize at this diagnostic boundary.
		rowCount: Number(row.row_count),
	}));
}

/**
 * Converge the exact historical mismatch. Intentionally preserves
 * `closed_on` and `modified_on`: this finishes the status half of the already
 * recorded close event rather than manufacturing a new lifecycle event.
 */
export async function migrateClosedStatusMismatches(
	db: Kysely<Database>,
	scope: CaseLifecycleStatusScope = {},
): Promise<number> {
	let update = db
		.updateTable("cases")
		.set({ status: "closed" })
		.where("closed_on", "is not", null)
		.where("status", "is distinct from", "closed");
	if (scope.appId !== undefined) {
		update = update.where("app_id", "=", scope.appId);
	}
	const result = await update.executeTakeFirst();
	return Number(result.numUpdatedRows);
}
