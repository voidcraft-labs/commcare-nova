import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import type {
	LookupColumnId,
	LookupRowId,
	LookupTableId,
} from "@/lib/domain/lookupIds";
import { coerceLookupCell } from "./coercion";
import {
	LOOKUP_MAX_CELL_BYTES,
	LOOKUP_MAX_VALIDATION_DETAILS,
} from "./constants";
import type { LookupDataType } from "./types";

/** Read only the cell being retyped. A reference-backed value's inline
 * marker carries no lexical evidence. Its real text is read only within
 * the destination scalar type's admitted byte bound. */
export async function checkLookupRetype(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	columnId: LookupColumnId,
	dataType: LookupDataType,
) {
	let after: LookupRowId | null = null;
	let checkedCells = 0;
	let incompatibleRowCount = 0;
	const incompatibleRowIds: LookupRowId[] = [];
	while (true) {
		const result = await sql<{
			id: LookupRowId;
			value: unknown;
			external: boolean;
			oversized: boolean;
		}>`
			SELECT r.id,v.value_id IS NOT NULL AS external,
				coalesce(v.total_bytes > ${LOOKUP_MAX_CELL_BYTES},false) AS oversized,
				CASE WHEN v.value_id IS NULL THEN r."values"->${columnId}::text
					WHEN v.total_bytes<=${LOOKUP_MAX_CELL_BYTES} AND ${dataType}::text NOT IN ('int','decimal','text') THEN to_jsonb((
						SELECT string_agg(convert_from(b.body,'UTF8'),'' ORDER BY s.byte_offset)
						FROM lookup_cell_segments s JOIN lookup_cell_blobs b ON b.project_id=s.project_id AND b.id=s.blob_id
						WHERE s.project_id=v.project_id AND s.value_id=v.value_id))
				END AS value
			FROM lookup_rows r LEFT JOIN lookup_cell_value_refs v ON
				(v.project_id,v.table_id,v.row_id)=(r.project_id,r.table_id,r.id) AND v.slot=ARRAY['cell',${columnId}::text]
			WHERE r.project_id=${projectId} AND r.table_id=${tableId}::uuid AND r."values" ? ${columnId}::text
				AND (${after}::uuid IS NULL OR r.id>${after}::uuid)
			ORDER BY r.id LIMIT 25`.execute(tx);
		for (const row of result.rows) {
			checkedCells++;
			if (row.external && dataType === "text") continue;
			if (
				row.oversized ||
				!coerceLookupCell(dataType, row.value, "typed").success
			) {
				incompatibleRowCount++;
				if (incompatibleRowIds.length < LOOKUP_MAX_VALIDATION_DETAILS)
					incompatibleRowIds.push(row.id);
			}
		}
		if (result.rows.length < 25) break;
		after = result.rows[result.rows.length - 1].id;
	}
	return { checkedCells, incompatibleRowCount, incompatibleRowIds };
}
