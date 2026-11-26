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
import {
	chargeDeviceFixture,
	DEVICE_FIXTURE_BYTES,
	hydrateFixtureRows,
} from "./fixtureValues";
import { type LocalWorkerScope, workerRowPredicate } from "./rowAssignments";
import { lookupRowContentSchema, storedLookupRowValuesSchema } from "./schema";
import {
	inlineLookupInventoryAvailable,
	requiresLookupProjection,
} from "./source";
import type { LookupFixtureDataSnapshot, LookupFixtureRow } from "./types";

interface StoredFixtureRow {
	table_id: string;
	row_id: string;
	values: unknown;
	content: unknown;
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
	purpose:
		| "device"
		| "archive"
		| "download-archive"
		| "project-editor"
		| LocalWorkerScope = "device",
	remaining = { bytes: DEVICE_FIXTURE_BYTES },
): Promise<LookupFixtureDataSnapshot> {
	const archive = purpose === "archive" || purpose === "download-archive";
	const definitions = await readLookupDefinitionsInTransaction(
		tx,
		projectId,
		tableIdsInput,
		archive || purpose === "project-editor",
	);
	let presentIds = definitions.definitions
		.filter(
			(definition) =>
				(purpose === "project-editor" &&
					inlineLookupInventoryAvailable(definition.hq)) ||
				(!requiresLookupProjection(definition.hq) &&
					(definition.workerAccess !== "assigned" ||
						(typeof purpose === "object" && !purpose.remoteAssignments))),
		)
		.map((definition) => definition.id);
	// A global archive may walk a table over many transactions. Only its
	// metadata enters the inline snapshot. A private table always uses its own
	// permission and distribution boundary, and a source-managed table whose
	// copy is not complete here is never in `presentIds`. A downloadable app
	// walks a complete copy of a table CommCare HQ manages as it walks Nova's
	// own: it embeds every table the same way. The HQ carriers keep such a
	// copy inline, because each writes it by its own rule (left alone in the
	// project space that manages it, or in that project space's own workbook).
	const streamedTables = new Map<LookupTableId, { rowCount: number }>();
	if (archive && presentIds.length) {
		const present = new Set(presentIds);
		const ordinary = definitions.definitions
			.filter(
				(t) =>
					present.has(t.id) &&
					(purpose === "download-archive" ||
						t.hq?.managedBy !== "commcare-hq") &&
					t.workerAccess !== "assigned" &&
					t.hq?.source?.distribution !== "assigned",
			)
			.map((t) => t.id);
		const sizes = await sql<{
			id: LookupTableId;
			row_count: number;
			bytes: string;
			external: boolean;
		}>`SELECT t.id,t.row_count,
			t.data_bytes::text AS bytes,EXISTS(SELECT 1 FROM lookup_cell_value_refs v WHERE (v.project_id,v.table_id)=(t.project_id,t.id)) AS external
			FROM lookup_tables t WHERE t.project_id=${projectId} AND t.id=ANY(${ordinary}::uuid[]) ORDER BY t.id`.execute(
			tx,
		);
		const shapes = new Map(
			definitions.definitions.map((t) => [
				t.id,
				3 +
					(t.attributes?.length ?? 0) +
					t.columns.reduce(
						(n, c) =>
							n +
							1 +
							(c.properties?.length ?? 0) +
							(c.index === "indexed" ? 1 : 0),
						0,
					),
			]),
		);
		let inlineRows = 0,
			inlineBytes = 0,
			inlineCells = 0;
		for (const t of sizes.rows) {
			const bytes = Number(t.bytes) + t.row_count * 96;
			const cells = (t.row_count + 2) * (shapes.get(t.id) ?? 0);
			if (
				t.external ||
				t.row_count > 1000 - inlineRows ||
				bytes > 1048576 - inlineBytes ||
				cells > 32768 - inlineCells
			)
				streamedTables.set(t.id, { rowCount: t.row_count });
			else {
				inlineRows += t.row_count;
				inlineBytes += bytes;
				inlineCells += cells;
			}
		}
		presentIds = presentIds.filter((id) => !streamedTables.has(id));
	}
	const rowsByTable = new Map<LookupTableId, LookupFixtureRow[]>(
		presentIds.map((tableId) => [tableId, []]),
	);
	if (presentIds.length > 0) {
		// Bound the existing in-memory adapter before one large inline row can be
		// decoded. These are only the complete, authorized tables above.
		const visibility =
			typeof purpose === "object"
				? sql`AND (table_id <> ALL(${definitions.definitions.filter((d) => d.workerAccess === "assigned").map((d) => d.id)}::uuid[]) OR ${workerRowPredicate(projectId, purpose)})`
				: sql``;
		const admitted = await sql<{
			bytes: string;
		}>`SELECT coalesce(sum(value_bytes+96),0)::text AS bytes FROM lookup_rows WHERE project_id=${projectId} AND table_id=ANY(${presentIds}::uuid[]) ${visibility}`.execute(
			tx,
		);
		chargeDeviceFixture(Number(admitted.rows[0]?.bytes ?? 0), remaining);
		const result = await sql<StoredFixtureRow>`
			SELECT
				table_id::text AS table_id,
				id::text AS row_id,
				values, content
			FROM lookup_rows
			WHERE project_id = ${projectId}
				AND table_id = ANY(${presentIds}::uuid[])
				${visibility}
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
				values: storedLookupRowValuesSchema.parse(row.values),
				...lookupRowContentSchema.parse(row.content),
			});
		}
	}
	for (const [tableId, rows] of rowsByTable)
		await hydrateFixtureRows(tx, projectId, tableId, rows, remaining);
	return {
		...definitions,
		rowsByTable,
		...(streamedTables.size > 0 && { streamedTables }),
	};
}
