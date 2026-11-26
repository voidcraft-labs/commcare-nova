import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import type {
	LookupColumnId,
	LookupMemberId,
	LookupRowId,
	LookupTableId,
} from "@/lib/domain/lookupIds";
import type { LookupRowPatch } from "../types";
import { valueSlotPath } from "./input";

/** SQL relation with the same sort columns and public shape as ordinary row
 * fragments. Each blob is independently valid UTF-8; code-point and byte
 * coordinates survive a multibyte character at either side of a chunk. */
export function textParts(
	projectId: string,
	tableId: LookupTableId,
	rowId: LookupRowId,
	columns: readonly LookupColumnId[],
	attributes: readonly LookupMemberId[],
) {
	return sql`SELECT CASE r.slot[1] WHEN 'cell' THEN 0 WHEN 'attribute' THEN 1 ELSE 2 END AS group_n,
		r.slot[2] AS slot,coalesce(r.slot[3]::bigint,-2) AS nth, coalesce(r.slot[4],'') AS prop,
		(s.char_offset+n)::bigint AS pos,
		jsonb_strip_nulls(jsonb_build_object('kind',r.slot[1],'columnId',CASE WHEN r.slot[1]<>'attribute' THEN r.slot[2] END,
			'attributeId',CASE WHEN r.slot[1]='attribute' THEN r.slot[2] END,'index',r.slot[3]::bigint,'propertyId',r.slot[4],
			'offset',s.char_offset+n,'byteOffset',s.byte_offset+octet_length(left(text,n)),'totalBytes',r.total_bytes,
			'valueDigest',r.digest,'text',substr(text,n+1,4096))) AS part
	FROM lookup_cell_value_refs r JOIN lookup_cell_segments s USING(project_id,value_id)
	JOIN lookup_cell_blobs b ON b.project_id=s.project_id AND b.id=s.blob_id
	CROSS JOIN LATERAL (SELECT convert_from(b.body,'UTF8') AS text) x
	CROSS JOIN LATERAL generate_series(0,char_length(text)-1,4096) AS parts(n)
	WHERE r.project_id=${projectId} AND r.table_id=${tableId} AND r.row_id=${rowId}
		AND ((r.slot[1]='attribute' AND r.slot[2]=ANY(${attributes}::text[])) OR
			 (r.slot[1]<>'attribute' AND r.slot[2]=ANY(${columns}::text[])))`;
}

/** Search a leaf with enough following characters to find a match straddling
 * a chunk (even several short chunks). No combined table or leaf is loaded. */
export function externalTextMatch(
	query: string,
	projection?: readonly LookupColumnId[],
	attributes?: readonly LookupMemberId[],
) {
	return sql<boolean>`EXISTS (
		SELECT 1 FROM lookup_cell_value_refs r JOIN lookup_cell_segments s USING(project_id,value_id)
		JOIN lookup_cell_blobs b ON b.project_id=s.project_id AND b.id=s.blob_id
		WHERE (r.project_id,r.table_id,r.row_id)=(lookup_rows.project_id,lookup_rows.table_id,lookup_rows.id)
		AND ((r.slot[1]='attribute' AND (${attributes ?? null}::text[] IS NULL OR r.slot[2]=ANY(${attributes ?? null}::text[])))
		  OR (r.slot[1]<>'attribute' AND (${projection ?? null}::text[] IS NULL OR r.slot[2]=ANY(${projection ?? null}::text[]))))
		AND strpos(lower(convert_from(b.body,'UTF8') || coalesce((
			SELECT string_agg(left(convert_from(n.body,'UTF8'),char_length(${query})),'' ORDER BY t.byte_offset)
			FROM lookup_cell_segments t JOIN lookup_cell_blobs n ON n.project_id=t.project_id AND n.id=t.blob_id
			WHERE (t.project_id,t.value_id)=(s.project_id,s.value_id) AND t.byte_offset>s.byte_offset
			AND t.char_offset<s.char_offset+char_length(convert_from(b.body,'UTF8'))+char_length(${query})
		),'')),${query})>0
	)`;
}

export async function dropRowExternalRefs(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	rowId: LookupRowId,
	includeRich = true,
) {
	const result =
		await sql`DELETE FROM lookup_cell_value_refs WHERE project_id=${projectId} AND table_id=${tableId} AND row_id=${rowId}
		${includeRich ? sql`` : sql`AND slot[1]='cell'`}`.execute(tx);
	return Boolean(result.numAffectedRows);
}

export async function dropDefinitionExternalRefs(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	target:
		| { columnId: string }
		| { attributeId: string }
		| { columnId: string; propertyId: string },
) {
	const member =
		"attributeId" in target
			? sql`slot[1]='attribute' AND slot[2]=${target.attributeId}`
			: "propertyId" in target
				? sql`slot[1]='property' AND slot[2]=${target.columnId} AND slot[4]=${target.propertyId}`
				: sql`slot[1]<>'attribute' AND slot[2]=${target.columnId}`;
	const result = await sql<{
		removed: string;
	}>`WITH freed AS (DELETE FROM lookup_cell_value_refs WHERE project_id=${projectId} AND table_id=${tableId} AND ${member} RETURNING total_bytes) SELECT coalesce(sum(total_bytes),0)::text AS removed FROM freed`.execute(
		tx,
	);
	return Number(result.rows[0].removed);
}

export async function applyPatchToExternalRefs(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	rowId: LookupRowId,
	patch: LookupRowPatch,
) {
	const row = sql`project_id=${projectId} AND table_id=${tableId} AND row_id=${rowId}`;
	if (patch.kind === "list") {
		const removed =
			await sql`DELETE FROM lookup_cell_value_refs WHERE ${row} AND slot[1] IN ('occurrence','property') AND slot[2]=${patch.columnId}`.execute(
				tx,
			);
		return Boolean(removed.numAffectedRows);
	}
	if (patch.kind !== "insert" && patch.kind !== "remove") {
		const result =
			await sql`DELETE FROM lookup_cell_value_refs WHERE ${row} AND slot=${valueSlotPath(patch)}::text[]`.execute(
				tx,
			);
		return Boolean(result.numAffectedRows);
	}
	const leaves = sql`slot[1] IN ('occurrence','property') AND slot[2]=${patch.columnId}`;
	const deleted =
		patch.kind === "remove"
			? await sql`DELETE FROM lookup_cell_value_refs WHERE ${row} AND ${leaves} AND slot[3]::bigint=${patch.index}`.execute(
					tx,
				)
			: null;
	// The unique slot constraint is deferred, so a simultaneous ordinal shift
	// cannot collide with a neighbour's old coordinate.
	const shifted =
		await sql`UPDATE lookup_cell_value_refs SET slot[3]=(slot[3]::bigint+${patch.kind === "insert" ? 1 : -1})::text
		WHERE ${row} AND ${leaves} AND slot[3]::bigint >= ${patch.kind === "insert" ? patch.index : patch.index + 1}`.execute(
			tx,
		);
	return Boolean(deleted?.numAffectedRows) || Boolean(shifted.numAffectedRows);
}
