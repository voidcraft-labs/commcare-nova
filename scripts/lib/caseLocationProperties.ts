/**
 * Shared query/write core for the case-location scan-then-migrate pair.
 *
 * A case's `location_id` is the row's own location column
 * (`lib/case-store/migrations/20261208030000_cases_location_id.ts`), never a
 * key of its JSONB property document: CommCare HQ keeps a written
 * `location_id` as the case's column (`update_strategy.py::
 * SqlCaseUpdateStrategy._apply_update_action`), and every case-store reader
 * now reads the name from the column. Before the column, no form could write
 * the key, but a catalog could declare a property of that name, so sample
 * data, an App Test's records or an import could leave it in the document,
 * where no reader would see it any more and the next update would shed it.
 *
 * The repair moves each such value into the column where the column holds
 * none, and removes the key from the document either way: a column a form
 * wrote since the deploy is the newer value. `modified_on` stays as it is,
 * since no case changed. Below the CaseStore API, as a fleet-wide historical
 * convergence over every Project; the predicate is exact and idempotent.
 */

import { type Kysely, sql } from "kysely";
import type { Database } from "../../lib/case-store/sql/database";

export interface CaseLocationPropertyGroup {
	readonly appId: string;
	readonly caseType: string;
	readonly rowCount: number;
	/** Rows whose column already holds a location, which the repair keeps. */
	readonly columnHeld: number;
}

export interface CaseLocationPropertyScope {
	readonly appId?: string;
}

/** Read-only census of rows whose property document holds `location_id`. */
export async function scanCaseLocationProperties(
	db: Kysely<Database>,
	scope: CaseLocationPropertyScope = {},
): Promise<ReadonlyArray<CaseLocationPropertyGroup>> {
	let query = db
		.selectFrom("cases")
		.select(["app_id", "case_type"])
		.select((eb) => eb.fn.countAll<number>().as("row_count"))
		.select(
			sql<number>`count(*) FILTER (WHERE location_id IS NOT NULL)`.as(
				"column_held",
			),
		)
		.where(sql<boolean>`properties ? 'location_id'`)
		.groupBy(["app_id", "case_type"])
		.orderBy("app_id", "asc")
		.orderBy("case_type", "asc");
	if (scope.appId !== undefined)
		query = query.where("app_id", "=", scope.appId);
	const rows = await query.execute();
	return rows.map((row) => ({
		appId: row.app_id,
		caseType: row.case_type,
		// node-postgres returns COUNT as an int8 string.
		rowCount: Number(row.row_count),
		columnHeld: Number(row.column_held),
	}));
}

/** Move each document's `location_id` into the row's column. */
export async function migrateCaseLocationProperties(
	db: Kysely<Database>,
	scope: CaseLocationPropertyScope = {},
): Promise<number> {
	let update = db
		.updateTable("cases")
		.set({
			location_id: sql<
				string | null
			>`COALESCE(location_id, properties->>'location_id')`,
			properties: sql`properties - 'location_id'`,
		})
		.where(sql<boolean>`properties ? 'location_id'`);
	if (scope.appId !== undefined)
		update = update.where("app_id", "=", scope.appId);
	const result = await update.executeTakeFirst();
	return Number(result.numUpdatedRows);
}
