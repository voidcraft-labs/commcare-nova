/**
 * Definitions-plus-rows lookup projection for caller-owned transactions.
 *
 * The compile boundary embeds complete tables into the exported archive, so
 * one snapshot must carry the definitions it validates against AND the exact
 * ordered row bodies it emits. Reading rows in a second transaction could pair
 * generation N definitions with generation N+1 rows; this leaf keeps both
 * reads inside the one caller-owned snapshot.
 *
 * Like `definitionSnapshot.ts`, this leaf carries no `server-only` runtime
 * marker so plain `tsx` inspectors can import through the service module.
 */

import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import {
	type LookupTableId,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { readLookupDefinitionsInTransaction } from "./definitionSnapshot";
import { lookupRowValuesSchema } from "./schema";
import type { LookupFixtureDataSnapshot, LookupFixtureRow } from "./types";

interface StoredFixtureRow {
	table_id: string;
	row_id: string;
	values: unknown;
}

/**
 * Read the requested table definitions plus every present table's complete
 * ordered rows in one caller-owned snapshot. Missing and foreign ids are
 * absent from both `definitions` and `rowsByTable`; every present definition
 * has a rows entry, empty for a table with no rows. Rows preserve the
 * authored `(order_key, id)` order under `C` collation.
 */
export async function readLookupFixtureDataInTransaction(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableIdsInput: readonly LookupTableId[],
): Promise<LookupFixtureDataSnapshot> {
	const definitions = await readLookupDefinitionsInTransaction(
		tx,
		projectId,
		tableIdsInput,
	);
	const presentIds = definitions.definitions.map((definition) => definition.id);
	const rowsByTable = new Map<LookupTableId, LookupFixtureRow[]>(
		presentIds.map((tableId) => [tableId, []]),
	);
	if (presentIds.length > 0) {
		const result = await sql<StoredFixtureRow>`
			SELECT
				table_id::text AS table_id,
				id::text AS row_id,
				values
			FROM lookup_rows
			WHERE project_id = ${projectId}
				AND table_id = ANY(${presentIds}::uuid[])
			ORDER BY table_id ASC, order_key ASC, id ASC
		`.execute(tx);
		for (const row of result.rows) {
			const tableId = lookupTableIdSchema.parse(row.table_id);
			const rows = rowsByTable.get(tableId);
			if (rows === undefined) {
				throw new Error("Lookup fixture query returned a mis-scoped row.");
			}
			rows.push({
				id: lookupRowIdSchema.parse(row.row_id),
				values: lookupRowValuesSchema.parse(row.values),
			});
		}
	}
	return { ...definitions, rowsByTable };
}
