import { type RawBuilder, sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { LookupError } from "./errors";
import type { LookupColumn, LookupMember, LookupScope } from "./types";

/** Apply a definition edit in PostgreSQL. The authoring process receives
 * only row IDs and the aggregate delta, regardless of row or table size. */
export async function changeLookupRowShape(
	tx: Transaction<AppDatabase>,
	scope: LookupScope,
	tableId: LookupTableId,
	attributes: readonly LookupMember[],
	before?: LookupColumn,
	after?: LookupColumn,
) {
	const tenant = sql`project_id=${scope.projectId} AND table_id=${tableId}::uuid`;
	let cells: RawBuilder<unknown> = sql.ref("values");
	let body: RawBuilder<unknown> = sql.ref("content");
	let relevant: RawBuilder<boolean> = sql`true`;
	if (!before) {
		const ids = attributes.map((member) => member.id);
		body = ids.length
			? sql`jsonb_set(content,'{attributes}',(SELECT jsonb_object_agg(id, coalesce(content->'attributes'->>id,'')) FROM unnest(${ids}::text[]) a(id)))`
			: sql`content-'attributes'`;
	} else {
		const col = sql`${before.id}::text`;
		const root = sql`coalesce(content->'occurrences','{}'::jsonb)`;
		const list = sql`(${root}->${col})`;
		const clearList = sql`CASE WHEN ${root} - ${col}='{}'::jsonb THEN content-'occurrences' ELSE jsonb_set(content,'{occurrences}',${root} - ${col}) END`;
		const setList = (next: RawBuilder<unknown>) =>
			sql`jsonb_set(content,'{occurrences}',jsonb_set(${root},ARRAY[${col}],${next}))`;
		if (!after) {
			relevant = sql`("values" ? ${col} OR ${root} ? ${col})`;
			cells = sql`"values" - ${col}`;
			body = clearList;
		} else if (!before.repeated && after.repeated) {
			relevant = sql`"values" ? ${col}`;
			cells = sql`"values"-${col}`;
			body = setList(
				sql`jsonb_build_array(jsonb_build_object('text',"values"->>${col},'properties','{}'::jsonb))`,
			);
		} else if (before.repeated && !after.repeated) {
			relevant = sql`${root} ? ${col}`;
			const held =
				await sql`SELECT 1 FROM lookup_rows WHERE ${tenant} AND ${relevant} AND
				(jsonb_array_length(${list})<>1 OR ${list}->0->'properties'<>'{}'::jsonb) LIMIT 1`.execute(
					tx,
				);
			if (held.rows.length)
				throw new LookupError(
					"invalid_input",
					"A row has multiple values, an empty list, or value details. You can keep it repeated or supply replacement rows.",
				);
			cells = sql`jsonb_set("values",ARRAY[${col}],${list}->0->'text')`;
			body = clearList;
		} else {
			const nextIds = new Set(after.properties?.map((property) => property.id));
			const removed =
				before.properties
					?.filter((property) => !nextIds.has(property.id))
					.map((property) => property.id) ?? [];
			if (!removed.length) return { changed: false, delta: 0 };
			relevant = sql`${root} ? ${col}`;
			body =
				setList(sql`(SELECT coalesce(jsonb_agg(jsonb_set(item,'{properties}',(item->'properties')-${removed}::text[]) ORDER BY pos),'[]'::jsonb)
				FROM jsonb_array_elements(${list}) WITH ORDINALITY f(item,pos))`);
		}
		if (after && Boolean(before.repeated) !== Boolean(after.repeated)) {
			const from = before.repeated
				? ["occurrence", before.id, "0"]
				: ["cell", before.id];
			const to = after.repeated
				? ["occurrence", before.id, "0"]
				: ["cell", before.id];
			await sql`UPDATE lookup_cell_value_refs SET slot=${to}::text[] WHERE ${tenant} AND slot=${from}::text[]`.execute(
				tx,
			);
		}
	}
	const {
		rows: [totals],
	} = await sql<{ changed: boolean; delta: string }>`
		WITH edits AS (SELECT id,value_bytes AS old_bytes,${cells} AS cells,${body} AS body FROM lookup_rows WHERE ${tenant} AND ${relevant}),
		updated AS (UPDATE lookup_rows r SET "values"=e.cells,content=e.body,updated_by=${scope.actorId},updated_at=now()
			FROM edits e WHERE r.project_id=${scope.projectId} AND r.table_id=${tableId} AND r.id=e.id
			AND (r."values" IS DISTINCT FROM e.cells OR r.content IS DISTINCT FROM e.body) RETURNING r.value_bytes-e.old_bytes AS delta)
		SELECT count(*)>0 AS changed,coalesce(sum(delta),0)::text AS delta FROM updated`.execute(
		tx,
	);
	return { changed: totals.changed, delta: Number(totals.delta) };
}
