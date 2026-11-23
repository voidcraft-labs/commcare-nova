import { createHash } from "node:crypto";
import { sql } from "kysely";
import { coerceLookupCell } from "../coercion";
import { LOOKUP_MAX_CELL_BYTES } from "../constants";
import { VALUE_CHUNK_BYTES } from "./input";
import {
	type CellTarget,
	invalidValue,
	type ValueTx,
	valueBytes,
	valueMetadata,
} from "./value";

export interface CellEdit {
	project_id: string;
	id: string;
	actor_id: string;
	binding: string;
	review_digest: string;
	expected_revision: string;
	base_digest: string;
	base_bytes: string;
	start_byte: string;
	end_byte: string;
	replacement_bytes: string;
	replacement_digest: string;
	next_offset: string;
	state: "staging" | "complete" | "cancelled";
	result_revision: string | null;
	live: boolean;
	slot: string[];
	row_id: CellTarget["rowId"];
}

async function* replacement(tx: ValueTx, edit: CellEdit) {
	const hash = createHash("sha256");
	let offset = 0;
	while (offset < Number(edit.next_offset)) {
		const result = await sql<{
			body: Buffer;
		}>`SELECT body FROM lookup_cell_inputs WHERE project_id=${edit.project_id} AND operation_id=${edit.id} AND byte_offset=${offset}`.execute(
			tx,
		);
		const body = result.rows[0]?.body;
		if (!body?.length)
			throw new Error("A staged lookup replacement is missing a byte range.");
		offset += body.length;
		hash.update(body);
		yield body;
	}
	if (
		offset !== Number(edit.replacement_bytes) ||
		hash.digest("hex") !== edit.replacement_digest
	)
		return invalidValue(
			"The replacement doesn't match its reviewed length and digest. You can cancel and start again.",
		);
}

/** Validate each independent span through the final byte. Joining raw bytes
 * first would allow two invalid UTF-8 boundaries to manufacture a character. */
async function* decoded(source: AsyncIterable<Buffer>) {
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	function decode(body?: Buffer) {
		let text: string;
		try {
			text = decoder.decode(body, { stream: body !== undefined });
		} catch {
			return invalidValue(
				"The change splits a character or contains invalid UTF-8. You can choose complete characters and retry.",
			);
		}
		if (/[^\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(text))
			return invalidValue(
				"This text contains a character that a form cannot read. You can replace that character.",
			);
		return text;
	}
	for await (const bytes of source) {
		const text = decode(bytes);
		if (text) yield text;
	}
	const end = decode();
	if (end) yield end;
}

export async function storeLookupValueSpan(
	tx: ValueTx,
	projectId: string,
	id: string,
	buffer: Buffer,
	start: { bytes: number; characters: number },
) {
	let { bytes, characters } = start;
	for (let pos = 0; pos < buffer.length; ) {
		let end = Math.min(pos + VALUE_CHUNK_BYTES, buffer.length);
		while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
		const chunk = buffer.subarray(pos, end);
		const blob = createHash("sha256").update(chunk).digest("hex");
		await sql`INSERT INTO lookup_cell_blobs(project_id,id,body) VALUES(${projectId},${blob},${chunk}) ON CONFLICT DO NOTHING`.execute(
			tx,
		);
		await sql`INSERT INTO lookup_cell_segments(project_id,value_id,byte_offset,char_offset,byte_length,blob_id)
					VALUES(${projectId},${id},${bytes},${characters},${chunk.length},${blob})`.execute(
			tx,
		);
		bytes += chunk.length;
		characters += Array.from(chunk.toString("utf8")).length;
		pos = end;
	}
	return { bytes, characters };
}

export async function assembleValue(
	tx: ValueTx,
	target: CellTarget,
	edit: CellEdit,
) {
	const meta = await valueMetadata(tx, target);
	if (meta.digest !== edit.base_digest || meta.total_bytes !== edit.base_bytes)
		return invalidValue(
			"The original value changed. You can reopen it before editing.",
		);
	const total =
		Number(meta.total_bytes) -
		Number(edit.end_byte) +
		Number(edit.start_byte) +
		Number(edit.replacement_bytes);
	const external = total > LOOKUP_MAX_CELL_BYTES;
	if (external && meta.data_type !== "text")
		return invalidValue(
			"This column needs a value that matches its data type.",
		);
	const id = external
		? (
				await sql<{
					id: string;
				}>`INSERT INTO lookup_cell_values(project_id) VALUES (${target.projectId}) RETURNING id`.execute(
					tx,
				)
			).rows[0].id
		: null;
	const digest = createHash("sha256");
	let bytes = 0,
		characters = 0;
	const small: string[] = [];
	for (const span of [
		valueBytes(tx, target, meta, 0, Number(edit.start_byte)),
		replacement(tx, edit),
		valueBytes(
			tx,
			target,
			meta,
			Number(edit.end_byte),
			Number(meta.total_bytes),
		),
	]) {
		for await (const text of decoded(span)) {
			const buffer = Buffer.from(text);
			digest.update(buffer);
			if (!id) {
				small.push(text);
				bytes += buffer.length;
				continue;
			}
			const end = await storeLookupValueSpan(tx, target.projectId, id, buffer, {
				bytes,
				characters,
			});
			bytes = end.bytes;
			characters = end.characters;
		}
	}
	if (total !== bytes)
		throw new Error("Lookup replacement changed its UTF-8 byte length.");
	const spelling = id ? "" : small.join("");
	const typed = coerceLookupCell(meta.data_type, spelling, "csv");
	if (!typed.success) return invalidValue(typed.message);
	return { id, total, digest: digest.digest("hex"), value: typed.value };
}
