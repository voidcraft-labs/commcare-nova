import "server-only";
import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { ownRecordValue } from "@/lib/domain/records";
import { LOOKUP_MAX_CELL_BYTES, LOOKUP_MAX_ROW_BYTES } from "../constants";
import { LookupError } from "../errors";
import { storeLookupValueSpan } from "../largeValues/assemble";
import { iterateBalancedKeys } from "../orderKeys";
import { hasUnpairedUtf16Surrogate } from "../schema";
import type { LookupTableDefinition } from "../types";
import type { InventoryRow } from "./row";

type Tx = Transaction<AppDatabase>;
type Target = {
	projectId: string;
	tableId: LookupTableId;
	generationId: string;
};
const moved = () =>
	new LookupError(
		"conflict",
		"The stored inventory changed before the transfer finished. You can refresh it and review the table again.",
	);

interface SourcePiece {
	ordinal: string;
	byte_offset: string;
	byte_length: string;
	source_id: string;
	row_id: string;
	body: Buffer;
}

/** Immutable chunks were written from bounded HQ responses. Release each completed
 * row before advancing, and keep a separate cap on one decoder's private work. */
async function* inventoryRows(
	tx: Tx,
	{ projectId, tableId, generationId }: Target,
	count: number,
) {
	let ordinal = 0,
		offset = 0;
	let parts: string[] = [];
	for (;;) {
		const page =
			await sql<SourcePiece>`SELECT r.ordinal,c.byte_offset,r.byte_length,r.source_id,r.row_id,b.body
            FROM lookup_generation_chunks c
            JOIN lookup_generation_rows r USING(project_id,table_id,generation_id,ordinal)
            JOIN lookup_generation_blobs b ON b.project_id=c.project_id AND b.id=c.blob_id
            WHERE c.project_id=${projectId} AND c.table_id=${tableId} AND c.generation_id=${generationId}
                AND (c.ordinal,c.byte_offset)>=(${ordinal},${offset})
            ORDER BY c.ordinal,c.byte_offset LIMIT 32`.execute(tx);
		if (!page.rows.length) break;
		for (const piece of page.rows) {
			if (
				Number(piece.ordinal) !== ordinal ||
				Number(piece.byte_offset) !== offset
			)
				throw moved();
			const length = Number(piece.byte_length);
			if (length > 64 * 1024 * 1024)
				throw new LookupError(
					"storage_limit",
					"One source row exceeds the transfer decoder’s capacity. Its inventory is still available in Project data.",
				);
			parts.push(piece.body.toString("utf8"));
			offset += piece.body.length;
			if (offset > length || ordinal >= count) throw moved();
			if (offset === length) {
				const row = JSON.parse(parts.join("")) as InventoryRow;
				if (row.sourceId !== piece.source_id) throw moved();
				parts = [];
				ordinal++;
				offset = 0;
				yield { row, rowId: piece.row_id };
			}
		}
	}
	if (ordinal !== count || offset) throw moved();
}

type ExternalSlot = { slot: string[]; text: string };

function editorRow(row: InventoryRow, definition: LookupTableDefinition) {
	const external: ExternalSlot[] = [];
	let inline = 0;
	function value(slot: string[], text: string) {
		if (text.includes("\0") || hasUnpairedUtf16Surrogate(text)) throw moved();
		const bytes = Buffer.byteLength(text);
		if (
			bytes &&
			(bytes > LOOKUP_MAX_CELL_BYTES || inline + bytes > LOOKUP_MAX_ROW_BYTES)
		) {
			external.push({ slot, text });
			return "";
		}
		inline += bytes;
		return text;
	}
	const attributes: Record<string, string> = {};
	for (const member of definition.attributes ?? []) {
		const text = ownRecordValue(row.attributes, member.wireName);
		if (text === undefined) throw moved();
		attributes[member.id] = value(["attribute", member.id], text);
	}
	if (Object.keys(row.attributes).length !== Object.keys(attributes).length)
		throw moved();
	const values: Record<string, string> = {};
	const occurrences: Record<
		string,
		{ text: string; properties: Record<string, string> }[]
	> = {};
	let found = 0;
	for (const column of definition.columns) {
		const items = ownRecordValue(row.fields, column.wireName);
		if (!items) continue; // A retained gone column and an absent source field carry no authored value.
		found++;
		if (column.dataType !== "text") throw moved();
		if (!column.repeated) {
			if (items.length !== 1 || Object.keys(items[0].properties).length)
				throw moved();
			values[column.id] = value(["cell", column.id], items[0].value);
			continue;
		}
		const ids = new Map(
			column.properties?.map((member) => [member.wireName, member.id]),
		);
		occurrences[column.id] = items.map((item, index) => {
			const props: Record<string, string> = {};
			for (const [name, text] of Object.entries(item.properties)) {
				const id = ids.get(name);
				if (!id) throw moved();
				props[id] = value(["property", column.id, String(index), id], text);
			}
			return {
				text: value(["occurrence", column.id, String(index)], item.value),
				properties: props,
			};
		});
	}
	if (found !== Object.keys(row.fields).length) throw moved();
	const content = {
		...(Object.keys(attributes).length ? { attributes } : {}),
		...(Object.keys(occurrences).length ? { occurrences } : {}),
	};
	return { values, content, external };
}

async function persistSlot(
	tx: Tx,
	target: Target,
	rowId: string,
	{ slot, text }: ExternalSlot,
) {
	const { projectId, tableId } = target;
	const data = Buffer.from(text);
	const {
		rows: [{ id }],
	} = await sql<{
		id: string;
	}>`INSERT INTO lookup_cell_values(project_id) VALUES (${projectId}) RETURNING id`.execute(
		tx,
	);
	const { bytes } = await storeLookupValueSpan(tx, projectId, id, data, {
		bytes: 0,
		characters: 0,
	});
	const digest = createHash("sha256").update(data).digest("hex");
	await sql`INSERT INTO lookup_cell_value_refs(project_id,table_id,row_id,slot,value_id,total_bytes,digest)
        VALUES(${projectId},${tableId},${rowId},${slot}::text[],${id},${bytes},${digest})`.execute(
		tx,
	);
}

/** The table and reviewed source generation are held for the entire transfer. Every
 * write, including actual physical quota settlement and row value refs, rolls back
 * if source scope, native proof, membership or the final ownership change fails. */
export async function materializeGeneration(
	tx: Tx,
	target: Target,
	actorId: string,
	definition: LookupTableDefinition,
	count: number,
) {
	const { projectId, tableId, generationId } = target;
	await sql`DELETE FROM lookup_cell_value_refs WHERE project_id=${projectId} AND table_id=${tableId}`.execute(
		tx,
	);
	await sql`DELETE FROM lookup_rows r WHERE project_id=${projectId} AND table_id=${tableId}
        AND NOT EXISTS(SELECT 1 FROM lookup_generation_rows g WHERE (g.project_id,g.table_id,g.row_id)=(r.project_id,r.table_id,r.id)
            AND g.generation_id=${generationId})`.execute(tx);
	const order = iterateBalancedKeys(null, null, count);
	const inserts: ReturnType<typeof sql>[] = [];
	const external: { rowId: string; part: ExternalSlot }[] = [];
	let bytes = 0;
	const write = async () => {
		if (!inserts.length) return;
		await sql`INSERT INTO lookup_rows(project_id,table_id,id,order_key,"values",content,hq_row_id,hq_sort_key,created_by,updated_by)
            VALUES ${sql.join(inserts)} ON CONFLICT(project_id,table_id,id) DO UPDATE SET
            order_key=excluded.order_key,"values"=excluded."values",content=excluded.content,hq_row_id=excluded.hq_row_id,
            hq_sort_key=excluded.hq_sort_key,updated_at=now(),updated_by=excluded.updated_by`.execute(
			tx,
		);
		for (const part of external)
			await persistSlot(tx, target, part.rowId, part.part);
		inserts.length = 0;
		external.length = 0;
		bytes = 0;
	};
	for await (const { row, rowId } of inventoryRows(tx, target, count)) {
		const { values, content, external: large } = editorRow(row, definition);
		const key = order.next();
		if (key.done) throw moved();
		const fields = JSON.stringify(values),
			details = JSON.stringify(content);
		inserts.push(
			sql`(${projectId},${tableId},${rowId},${key.value},${fields}::jsonb,${details}::jsonb,${row.sourceId},${row.sortKey ?? null},${actorId},${actorId})`,
		);
		for (const part of large) external.push({ rowId, part });
		bytes += Buffer.byteLength(fields) + Buffer.byteLength(details);
		if (inserts.length >= 100 || bytes >= 512 * 1024 || external.length)
			await write();
	}
	await write();
	const total = await sql<{
		bytes: string;
		count: string;
	}>`SELECT count(*) AS count,coalesce(sum(value_bytes+external_bytes),0)::bigint AS bytes
        FROM lookup_rows WHERE project_id=${projectId} AND table_id=${tableId}`.execute(
		tx,
	);
	if (Number(total.rows[0].count) !== count) throw moved();
	return total.rows[0].bytes;
}
