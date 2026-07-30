/**
 * Read-only storage impact for one already-admitted app-wide case-property
 * rename relation.
 *
 * The caller owns the surrounding transaction so its authoritative Blueprint,
 * mutation sequence, authorization decision, and these counts all belong to
 * one request snapshot. This module deliberately exposes no write token and
 * shares no implementation with the rename writer: authoritative Phase A
 * rechecks every row under its own locks before committing.
 */

import { sql, type Transaction } from "kysely";
import type { Database } from "./sql/database";

export interface CasePropertyRenameStoragePreflightEntry {
	readonly caseType: string;
	readonly from: string;
	readonly to: string;
}

export interface CasePropertyRenameStoragePreflightByRename
	extends CasePropertyRenameStoragePreflightEntry {
	readonly rowsWithSource: number;
	readonly parkedValuesWithSource: number;
}

export interface CasePropertyRenameStoragePreflightConflict {
	readonly caseType: string;
	readonly property: string;
	readonly carrier: "case-row" | "parked-value";
	readonly count: number;
}

export interface CasePropertyRenameStoragePreflight {
	/** Distinct live case rows carrying at least one moving source key. */
	readonly renamedRows: number;
	/** Parked-value rows whose property is one of the moving sources. */
	readonly renamedParkedValues: number;
	readonly byRename: readonly CasePropertyRenameStoragePreflightByRename[];
	readonly conflicts: readonly CasePropertyRenameStoragePreflightConflict[];
}

interface StoredPreflightRow {
	readonly ordinal: string;
	readonly case_type: string;
	readonly source_property: string;
	readonly destination_property: string;
	readonly rows_with_source: string;
	readonly parked_values_with_source: string;
	readonly renamed_rows: string;
	readonly renamed_parked_values: string;
	readonly destination_case_rows: string;
	readonly destination_parked_values: string;
}

function count(value: string, label: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(
			`Case-property rename preflight returned an invalid ${label} count.`,
		);
	}
	return parsed;
}

/**
 * Count the exact app-wide storage population for one simultaneous relation.
 *
 * There is intentionally no Project, owner, hold, or dismissal predicate:
 * `app_id` is the rename scope, every case owner participates, held cases are
 * still live rows, and dismissed parked values remain preserved user data.
 * PostgreSQL's JSONB `?` operator tests own-key presence, so a destination
 * containing null, an empty string, or another blank value is occupied.
 */
export async function readCasePropertyRenameStoragePreflightInTransaction(
	tx: Transaction<Database>,
	args: {
		readonly appId: string;
		readonly entries: readonly CasePropertyRenameStoragePreflightEntry[];
	},
): Promise<CasePropertyRenameStoragePreflight> {
	if (args.entries.length === 0) {
		throw new Error(
			"Case-property rename storage preflight requires a nonempty relation.",
		);
	}

	const relation = args.entries.map((entry) => ({
		case_type: entry.caseType,
		source_property: entry.from,
		destination_property: entry.to,
	}));
	const result = await sql<StoredPreflightRow>`
		WITH renames AS (
			SELECT
				input.value ->> 'case_type' AS case_type,
				input.value ->> 'source_property' AS source_property,
				input.value ->> 'destination_property' AS destination_property,
				input.ordinal
			FROM jsonb_array_elements(${JSON.stringify(relation)}::jsonb)
				WITH ORDINALITY AS input(value, ordinal)
		),
		moving_sources AS (
			SELECT case_type, source_property
			FROM renames
		),
		totals AS (
			SELECT
				(
					SELECT count(DISTINCT cases.case_id)::text
					FROM cases
					INNER JOIN renames AS moving
						ON moving.case_type = cases.case_type
						AND cases.properties ? moving.source_property
					WHERE cases.app_id = ${args.appId}
				) AS renamed_rows,
				(
					SELECT count(DISTINCT parked_case_values.id)::text
					FROM parked_case_values
					INNER JOIN renames AS moving
						ON moving.case_type = parked_case_values.case_type
						AND moving.source_property = parked_case_values.property
					WHERE parked_case_values.app_id = ${args.appId}
				) AS renamed_parked_values
		)
		SELECT
			renames.ordinal::text AS ordinal,
			renames.case_type,
			renames.source_property,
			renames.destination_property,
			(
				SELECT count(*)::text
				FROM cases
				WHERE cases.app_id = ${args.appId}
					AND cases.case_type = renames.case_type
					AND cases.properties ? renames.source_property
			) AS rows_with_source,
			(
				SELECT count(*)::text
				FROM parked_case_values
				WHERE parked_case_values.app_id = ${args.appId}
					AND parked_case_values.case_type = renames.case_type
					AND parked_case_values.property = renames.source_property
			) AS parked_values_with_source,
			totals.renamed_rows,
			totals.renamed_parked_values,
			CASE
				WHEN EXISTS (
					SELECT 1
					FROM moving_sources
					WHERE moving_sources.case_type = renames.case_type
						AND moving_sources.source_property = renames.destination_property
				)
				THEN '0'
				ELSE (
					SELECT count(*)::text
					FROM cases
					WHERE cases.app_id = ${args.appId}
						AND cases.case_type = renames.case_type
						AND cases.properties ? renames.destination_property
				)
			END AS destination_case_rows,
			CASE
				WHEN EXISTS (
					SELECT 1
					FROM moving_sources
					WHERE moving_sources.case_type = renames.case_type
						AND moving_sources.source_property = renames.destination_property
				)
				THEN '0'
				ELSE (
					SELECT count(*)::text
					FROM parked_case_values
					WHERE parked_case_values.app_id = ${args.appId}
						AND parked_case_values.case_type = renames.case_type
						AND parked_case_values.property = renames.destination_property
				)
			END AS destination_parked_values
		FROM renames
		CROSS JOIN totals
		ORDER BY renames.ordinal
	`.execute(tx);

	if (result.rows.length !== args.entries.length) {
		throw new Error(
			"Case-property rename preflight did not preserve the complete relation.",
		);
	}

	const first = result.rows[0];
	if (first === undefined) {
		throw new Error(
			"Case-property rename preflight returned no relation rows.",
		);
	}

	const byRename = result.rows.map((row) => ({
		caseType: row.case_type,
		from: row.source_property,
		to: row.destination_property,
		rowsWithSource: count(row.rows_with_source, "source case-row"),
		parkedValuesWithSource: count(
			row.parked_values_with_source,
			"source parked-value",
		),
	}));
	const conflicts: CasePropertyRenameStoragePreflightConflict[] = [];
	for (const row of result.rows) {
		const caseRows = count(row.destination_case_rows, "destination case-row");
		if (caseRows > 0) {
			conflicts.push({
				caseType: row.case_type,
				property: row.destination_property,
				carrier: "case-row",
				count: caseRows,
			});
		}
		const parkedValues = count(
			row.destination_parked_values,
			"destination parked-value",
		);
		if (parkedValues > 0) {
			conflicts.push({
				caseType: row.case_type,
				property: row.destination_property,
				carrier: "parked-value",
				count: parkedValues,
			});
		}
	}

	return {
		renamedRows: count(first.renamed_rows, "total case-row"),
		renamedParkedValues: count(
			first.renamed_parked_values,
			"total parked-value",
		),
		byRename,
		conflicts,
	};
}
