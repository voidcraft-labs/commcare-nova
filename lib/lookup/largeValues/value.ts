import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import type { LookupRowId, LookupTableId } from "@/lib/domain/lookupIds";
import { LookupError } from "../errors";
import type { LookupDataType } from "../types";
import {
	type LookupValueSlot,
	VALUE_CHUNK_BYTES,
	valueSlotPath,
} from "./input";

export type ValueTx = Transaction<AppDatabase>;
export interface CellTarget {
	projectId: string;
	tableId: LookupTableId;
	rowId: LookupRowId;
	slot: LookupValueSlot;
}
export function invalidValue(message: string): never {
	throw new LookupError("invalid_input", message);
}

export function storagePath(slot: LookupValueSlot) {
	switch (slot.kind) {
		case "cell":
			return { column: sql.ref("values"), path: [slot.columnId] };
		case "attribute":
			return {
				column: sql.ref("content"),
				path: ["attributes", slot.attributeId],
			};
		case "occurrence":
			return {
				column: sql.ref("content"),
				path: ["occurrences", slot.columnId, String(slot.index), "text"],
			};
		case "property":
			return {
				column: sql.ref("content"),
				path: [
					"occurrences",
					slot.columnId,
					String(slot.index),
					"properties",
					slot.propertyId,
				],
			};
	}
}

interface ValueMeta {
	digest: string;
	total_bytes: string;
	value_id: string | null;
	data_type: LookupDataType;
}
export async function valueMetadata(tx: ValueTx, target: CellTarget) {
	const { projectId, tableId, rowId, slot } = target;
	const { column, path } = storagePath(slot);
	const lexical = sql`(${column} #>> ${path}::text[])`;
	const result =
		await sql<ValueMeta>`SELECT coalesce(f.digest,encode(sha256(convert_to(${lexical},'UTF8')),'hex')) AS digest,
		coalesce(f.total_bytes,octet_length(${lexical}))::text AS total_bytes,f.value_id,
		${slot.kind === "cell" ? sql`c.data_type` : sql`'text'`} AS data_type
	FROM lookup_rows r LEFT JOIN lookup_cell_value_refs f ON (r.project_id,r.table_id,r.id)=(f.project_id,f.table_id,f.row_id) AND f.slot=${valueSlotPath(slot)}::text[]
	${slot.kind === "cell" ? sql`JOIN lookup_columns c ON (c.project_id,c.table_id)=(r.project_id,r.table_id) AND c.id=${slot.columnId} AND NOT c.repeated` : sql``}
	WHERE (r.project_id,r.table_id,r.id)=(${projectId},${tableId},${rowId}) AND ${lexical} IS NOT NULL`.execute(
			tx,
		);
	if (!result.rows[0])
		return invalidValue(
			"This value is no longer present in the row. You can reopen the row.",
		);
	const meta = result.rows[0];
	if (meta.value_id)
		await sql`SELECT 1 FROM lookup_cell_values WHERE project_id=${projectId} AND id=${meta.value_id} FOR KEY SHARE`.execute(
			tx,
		);
	return meta;
}

/** Raw ranges are never returned to an author until checked at both character
 * boundaries. Paginate with exact byte positions and a single bounded blob. */
export async function* valueBytes(
	tx: ValueTx,
	target: CellTarget,
	meta: ValueMeta,
	from: number,
	to: number,
) {
	const { projectId, tableId, rowId } = target;
	const { column, path } = storagePath(target.slot);
	for (let offset = from; offset < to; ) {
		let chunk: Buffer | undefined;
		if (meta.value_id) {
			const piece = await sql<{
				body: Buffer;
			}>`SELECT substr(b.body,1+(${offset}::bigint-s.byte_offset)::integer,
				least(${to - offset}::bigint,s.byte_length)::integer) AS body
			FROM lookup_cell_segments s JOIN lookup_cell_blobs b ON (b.project_id,b.id)=(s.project_id,s.blob_id)
			WHERE s.project_id=${projectId} AND s.value_id=${meta.value_id} AND s.byte_offset<=${offset}
			AND s.byte_offset+s.byte_length>${offset} ORDER BY s.byte_offset DESC LIMIT 1`.execute(
				tx,
			);
			chunk = piece.rows[0]?.body;
		} else {
			const piece = await sql<{
				body: Buffer;
			}>`SELECT substr(convert_to(${column}#>>${path}::text[],'UTF8'),
				${offset + 1}::integer,${Math.min(to - offset, VALUE_CHUNK_BYTES)}::integer) AS body
				FROM lookup_rows WHERE (project_id,table_id,id)=(${projectId},${tableId},${rowId})`.execute(
				tx,
			);
			chunk = piece.rows[0]?.body;
		}
		if (!chunk?.length)
			throw new Error("A lookup value is missing a committed byte range.");
		offset += chunk.length;
		yield chunk;
	}
}

export async function readValueRange(
	tx: ValueTx,
	target: CellTarget,
	meta: ValueMeta,
	byteOffset: number,
) {
	const totalBytes = Number(meta.total_bytes);
	if (byteOffset > totalBytes)
		return invalidValue("That position is past the end of the value.");
	// One byte of lookahead distinguishes a clipped code point at the end from
	// an illegal start. Existing SQL text and every stored segment are valid UTF-8.
	const end = Math.min(totalBytes, byteOffset + 8192 + 1);
	const pieces = [];
	for await (const chunk of valueBytes(tx, target, meta, byteOffset, end))
		pieces.push(chunk);
	const body = Buffer.concat(pieces);
	let length = Math.min(body.length, 8192);
	while (length < body.length && (body[length] & 0xc0) === 0x80) length--;
	if (body.length && (body[0] & 0xc0) === 0x80)
		return invalidValue(
			"This position splits a character. You can choose a position at a character boundary.",
		);
	const text = new TextDecoder("utf-8", {
		fatal: true,
		ignoreBOM: true,
	}).decode(body.subarray(0, length));
	return {
		valueDigest: meta.digest,
		totalBytes,
		byteOffset,
		text,
		nextByteOffset:
			byteOffset + length < totalBytes ? byteOffset + length : null,
	};
}
