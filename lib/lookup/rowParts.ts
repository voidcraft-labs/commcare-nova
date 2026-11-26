import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import type {
	LookupColumnId,
	LookupMemberId,
	LookupRowId,
	LookupTableId,
} from "@/lib/domain/lookupIds";
import { textParts } from "./largeValues/projection";
import type { LookupRowPart } from "./types";

/** A very large row stays inside Postgres. Project only the ordered values
 * addressed by this read. Text offsets count Unicode code points. One extra
 * part answers whether the next cursor must continue inside this row. */
export async function readLookupRowParts(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	rowId: LookupRowId,
	columns: readonly LookupColumnId[],
	attributes: readonly LookupMemberId[],
	offset: number,
) {
	const result = await sql<{ part: LookupRowPart }>`
		WITH row_source AS MATERIALIZED (
			SELECT "values",content FROM lookup_rows WHERE project_id=${projectId} AND table_id=${tableId}::uuid AND id=${rowId}::uuid
		), lists AS (
			SELECT k AS col_id,list FROM row_source CROSS JOIN LATERAL jsonb_each(content->'occurrences') f(k,list)
			WHERE k=ANY(${columns}::text[])
		), items AS (
			SELECT col_id,pos-1 AS nth,item FROM lists CROSS JOIN LATERAL jsonb_array_elements(list) WITH ORDINALITY t(item,pos)
		), backed AS MATERIALIZED (
			SELECT slot FROM lookup_cell_value_refs WHERE project_id=${projectId} AND table_id=${tableId}::uuid AND row_id=${rowId}::uuid
		), leaves AS (
			SELECT 0 AS group_n, k AS slot, -2::bigint AS nth, ''::text AS prop,
				CASE WHEN jsonb_typeof(v)='number' THEN jsonb_build_object('kind','number','columnId',k,'value',v) ELSE jsonb_build_object('kind','cell','columnId',k) END AS coords,
				CASE WHEN jsonb_typeof(v)='string' THEN v#>>'{}' END AS lexical
			FROM row_source CROSS JOIN LATERAL jsonb_each("values") f(k,v) WHERE k=ANY(${columns}::text[])
			UNION ALL SELECT 1,k,-2,'',jsonb_build_object('kind','attribute','attributeId',k),v
				FROM row_source CROSS JOIN LATERAL jsonb_each_text(content->'attributes') a(k,v) WHERE k=ANY(${attributes}::text[])
			UNION ALL SELECT 2,col_id,-1,'',jsonb_build_object('kind','occurrences','columnId',col_id,'count',jsonb_array_length(list)),NULL FROM lists
			UNION ALL SELECT 2,col_id,nth,'',jsonb_build_object('kind','occurrence','columnId',col_id,'index',nth),item->>'text' FROM items
			UNION ALL SELECT 2,col_id,nth,k,jsonb_build_object('kind','property','columnId',col_id,'index',nth,'propertyId',k),v
				FROM items CROSS JOIN LATERAL jsonb_each_text(item->'properties') p(k,v)
		), inline_leaves AS MATERIALIZED (
			SELECT l.*, octet_length(lexical) AS bytes,
				encode(sha256(convert_to(lexical,'UTF8')),'hex') AS digest
			FROM leaves l WHERE NOT EXISTS (
				SELECT 1 FROM backed b WHERE b.slot = CASE coords->>'kind'
					WHEN 'cell' THEN ARRAY['cell',l.slot]
					WHEN 'attribute' THEN ARRAY['attribute',l.slot]
					WHEN 'occurrence' THEN ARRAY['occurrence',l.slot,l.nth::text]
					WHEN 'property' THEN ARRAY['property',l.slot,l.nth::text,l.prop] END
			)
		), parts AS (
			SELECT group_n,slot,nth,prop,pos,
				CASE WHEN lexical IS NULL THEN coords ELSE coords || jsonb_build_object(
					'offset',pos,'byteOffset',octet_length(left(lexical,pos)),'totalBytes',bytes,'valueDigest',digest,
					'text',substring(lexical FROM pos+1 FOR 4096)) END AS part
			FROM inline_leaves CROSS JOIN LATERAL generate_series(0,greatest(0,char_length(lexical)-1),4096) s(pos)
			UNION ALL ${textParts(projectId, tableId, rowId, columns, attributes)}
		)
		SELECT part FROM parts ORDER BY group_n,slot COLLATE "C",nth,prop COLLATE "C",pos OFFSET ${offset} LIMIT 17
	`.execute(tx);
	return {
		parts: result.rows.slice(0, 16).map((row) => row.part),
		complete: result.rows.length <= 16,
	};
}
