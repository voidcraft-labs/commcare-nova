/**
 * Rows-free lookup-definition projection for caller-owned transactions.
 *
 * This leaf deliberately has no `server-only` runtime marker: authoritative
 * app writers are also imported by Nova's plain `tsx` inspectors. The caller
 * still owns a server-side Postgres transaction, so the type boundary keeps
 * browser code out without making script imports throw during module loading.
 */

import { sql, type Transaction } from "kysely";
import type { AppDatabase, LookupColumnsTable } from "@/lib/db/pg";
import {
	type LookupTableId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { parseLookupRevision } from "./schema";
import type {
	LookupColumn,
	LookupDefinitionsSnapshot,
	LookupTableDefinition,
} from "./types";

interface StoredDefinitionRow {
	project_revision: string;
	table_id: string | null;
	table_name: string | null;
	table_tag: string | null;
	definition_revision: string | null;
	column_table_id: string | null;
	column_id: string | null;
	column_wire_name: string | null;
	column_label: string | null;
	column_data_type: LookupColumnsTable["data_type"] | null;
}

function compareAscii(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function parseTableIds(value: unknown): LookupTableId[] {
	const ids = lookupTableIdSchema.array().parse(value);
	return [...new Set(ids)].sort(compareAscii);
}

/**
 * Read exactly the requested table definitions and the Project clock in one
 * SQL-statement snapshot. Empty requests still read the Project clock; missing
 * and foreign ids are intentionally absent from `definitions`.
 */
export async function readLookupDefinitionsInTransaction(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableIdsInput: readonly LookupTableId[],
): Promise<LookupDefinitionsSnapshot> {
	if (typeof projectId !== "string" || projectId.length === 0) {
		throw new Error("Lookup definition reader received an invalid Project id.");
	}
	const tableIds = parseTableIds(tableIdsInput);
	const result = await sql<StoredDefinitionRow>`
		WITH project_snapshot AS (
			SELECT COALESCE(
				(
					SELECT revision::text
					FROM lookup_project_state
					WHERE project_id = ${projectId}
				),
				'0'
			) AS project_revision
		)
		SELECT
			project_snapshot.project_revision,
			table_row.id::text AS table_id,
			table_row.name AS table_name,
			table_row.tag AS table_tag,
			table_row.definition_revision::text AS definition_revision,
			column_row.table_id::text AS column_table_id,
			column_row.id::text AS column_id,
			column_row.wire_name AS column_wire_name,
			column_row.label AS column_label,
			column_row.data_type AS column_data_type
		FROM project_snapshot
		LEFT JOIN LATERAL (
			SELECT id, name, tag, definition_revision
			FROM lookup_tables
			WHERE project_id = ${projectId}
				AND id = ANY(${tableIds}::uuid[])
		) AS table_row ON TRUE
		LEFT JOIN lookup_columns AS column_row
			ON column_row.project_id = ${projectId}
			AND column_row.table_id = table_row.id
		ORDER BY table_row.id ASC NULLS LAST,
			column_row.order_key ASC NULLS LAST,
			column_row.id ASC NULLS LAST
	`.execute(tx);
	const projectRevision = parseLookupRevision(
		result.rows[0]?.project_revision ?? "0",
	);
	const definitionsById = new Map<
		LookupTableId,
		LookupTableDefinition & { columns: LookupColumn[] }
	>();
	for (const row of result.rows) {
		if (row.table_id === null) continue;
		const tableId = lookupTableIdSchema.parse(row.table_id);
		let definition = definitionsById.get(tableId);
		if (!definition) {
			if (
				row.table_name === null ||
				row.table_tag === null ||
				row.definition_revision === null
			) {
				throw new Error("Lookup definition query returned a partial table.");
			}
			definition = {
				id: tableId,
				name: row.table_name,
				tag: row.table_tag,
				definitionRevision: parseLookupRevision(row.definition_revision),
				columns: [],
			};
			definitionsById.set(tableId, definition);
		}
		if (row.column_id === null) continue;
		if (
			row.column_table_id === null ||
			row.column_wire_name === null ||
			row.column_label === null ||
			row.column_data_type === null
		) {
			throw new Error("Lookup definition query returned a partial column.");
		}
		const columnTableId = lookupTableIdSchema.parse(row.column_table_id);
		if (columnTableId !== tableId) {
			throw new Error("Lookup definition query returned a mis-scoped column.");
		}
		definition.columns.push({
			id: lookupColumnIdSchema.parse(row.column_id),
			wireName: row.column_wire_name,
			label: row.column_label,
			dataType: row.column_data_type,
		});
	}

	return {
		projectId,
		projectRevision,
		definitions: [...definitionsById.values()],
	};
}
