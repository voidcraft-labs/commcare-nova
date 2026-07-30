/**
 * Timestamp-owned Project lookup-definition snapshot for the canonical
 * identity cutover.
 *
 * Scanner, repair, and migration callers invoke this only through their
 * already-owned transaction. The returned rows-free context is therefore
 * consistent with the Blueprint candidate and suffix rows validated in that
 * same transaction.
 */

import { type Kysely, sql } from "kysely";
import type {
	FrozenLookupTableDefinition,
	FrozenLookupValidationContext,
} from "./frozenPersistableBlueprintValidator.generated.mjs";

const FROZEN_LOOKUP_UUID_V7 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FROZEN_LOOKUP_DATA_TYPES = new Set([
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
]);
const FROZEN_LOOKUP_REVISION_MAX = BigInt("9223372036854775807");

function frozenLookupRevision(value: string): string {
	if (
		!/^(?:0|[1-9][0-9]*)$/.test(value) ||
		BigInt(value) > FROZEN_LOOKUP_REVISION_MAX
	) {
		throw new Error("Frozen lookup revision is invalid.");
	}
	return value;
}

export async function readFrozenProjectLookupContext<DB>(
	tx: Kysely<DB>,
	projectId: string,
): Promise<FrozenLookupValidationContext> {
	if (projectId.trim().length === 0) {
		throw new Error("Frozen lookup definition scope is invalid.");
	}
	const rows = await sql<{
		project_revision: string;
		table_id: string | null;
		table_name: string | null;
		table_tag: string | null;
		definition_revision: string | null;
		column_table_id: string | null;
		column_id: string | null;
		column_wire_name: string | null;
		column_label: string | null;
		column_data_type: string | null;
	}>`
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
		) AS table_row ON TRUE
		LEFT JOIN lookup_columns AS column_row
		  ON column_row.project_id = ${projectId}
		 AND column_row.table_id = table_row.id
		ORDER BY table_row.id NULLS LAST,
			column_row.order_key NULLS LAST,
			column_row.id NULLS LAST
	`.execute(tx);
	const definitions = new Map<
		string,
		FrozenLookupTableDefinition & {
			columns: Array<FrozenLookupTableDefinition["columns"][number]>;
		}
	>();
	for (const row of rows.rows) {
		if (row.table_id === null) continue;
		if (
			!FROZEN_LOOKUP_UUID_V7.test(row.table_id) ||
			row.table_name === null ||
			row.table_tag === null ||
			row.definition_revision === null
		) {
			throw new Error("Frozen lookup definition table is partial.");
		}
		let definition = definitions.get(row.table_id);
		if (definition === undefined) {
			definition = {
				id: row.table_id,
				name: row.table_name,
				tag: row.table_tag,
				definitionRevision: frozenLookupRevision(row.definition_revision),
				columns: [],
			};
			definitions.set(row.table_id, definition);
		}
		if (row.column_id === null) continue;
		if (
			row.column_table_id !== row.table_id ||
			!FROZEN_LOOKUP_UUID_V7.test(row.column_id) ||
			row.column_wire_name === null ||
			row.column_label === null ||
			row.column_data_type === null ||
			!FROZEN_LOOKUP_DATA_TYPES.has(row.column_data_type)
		) {
			throw new Error("Frozen lookup definition column is partial.");
		}
		definition.columns.push({
			id: row.column_id,
			wireName: row.column_wire_name,
			label: row.column_label,
			dataType: row.column_data_type as
				| "text"
				| "int"
				| "decimal"
				| "date"
				| "time"
				| "datetime",
		});
	}
	return Object.freeze({
		kind: "available",
		projectId,
		projectRevision: frozenLookupRevision(
			rows.rows[0]?.project_revision ?? "0",
		),
		definitions: Object.freeze(
			[...definitions.values()].map((definition) =>
				Object.freeze({
					...definition,
					columns: Object.freeze([...definition.columns]),
				}),
			),
		),
	});
}
