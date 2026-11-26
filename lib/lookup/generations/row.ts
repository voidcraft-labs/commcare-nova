import { createHash } from "node:crypto";
import { v7 } from "uuid";
import type { LookupTableId } from "@/lib/domain/lookupIds";

export interface InventoryRow {
	sourceId: string;
	sortKey?: number;
	attributes: Readonly<Record<string, string>>;
	fields: Readonly<
		Record<
			string,
			readonly { value: string; properties: Readonly<Record<string, string>> }[]
		>
	>;
}

export const LOOKUP_CHUNK_BYTES = 32 * 1024;

/** Every part is legal UTF-8. Keep large fields out of an intermediate JSON
 * string; a client can follow a row across arbitrarily many byte ranges. */
function* quoted(value: string) {
	yield '"';
	for (let start = 0; start < value.length; ) {
		let end = Math.min(start + 4096, value.length);
		if (
			end < value.length &&
			value.charCodeAt(end - 1) >= 0xd800 &&
			value.charCodeAt(end - 1) <= 0xdbff
		)
			end--;
		yield JSON.stringify(value.slice(start, end)).slice(1, -1);
		start = end;
	}
	yield '"';
}

function* object<T>(
	record: Readonly<Record<string, T>>,
	spellValue: (value: T) => Iterable<string>,
): Generator<string> {
	yield "{";
	let first = true;
	for (const key of Object.keys(record).sort()) {
		if (!first) yield ",";
		first = false;
		yield* quoted(key);
		yield ":";
		yield* spellValue(record[key]);
	}
	yield "}";
}

function* fields(values: InventoryRow["fields"][string]) {
	yield "[";
	for (const [i, item] of values.entries()) {
		if (i) yield ",";
		yield '{"value":';
		yield* quoted(item.value);
		yield ',"properties":';
		yield* object(item.properties, quoted);
		yield "}";
	}
	yield "]";
}

function* rowJson(row: InventoryRow) {
	yield '{"sourceId":';
	yield* quoted(row.sourceId);
	if (row.sortKey !== undefined) yield `,"sortKey":${row.sortKey}`;
	yield ',"attributes":';
	yield* object(row.attributes, quoted);
	yield ',"fields":';
	yield* object(row.fields, fields);
	yield "}";
}

export function* inventoryChunks(row: InventoryRow) {
	let chunk = Buffer.allocUnsafe(LOOKUP_CHUNK_BYTES);
	let length = 0;
	for (const text of rowJson(row)) {
		const bytes = Buffer.from(text);
		let pos = 0;
		while (pos < bytes.length) {
			let end = Math.min(bytes.length, pos + chunk.length - length);
			while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
			bytes.copy(chunk, length, pos, end);
			length += end - pos;
			pos = end;
			if (length === chunk.length || pos < bytes.length) {
				yield chunk.subarray(0, length);
				chunk = Buffer.allocUnsafe(LOOKUP_CHUNK_BYTES);
				length = 0;
			}
		}
	}
	if (length) yield chunk.subarray(0, length);
}

export function inventoryRowId(
	tableId: LookupTableId,
	sourceId: string,
	origin: readonly string[],
) {
	return v7({
		msecs: Number.parseInt(tableId.replaceAll("-", "").slice(0, 12), 16),
		random: createHash("sha256")
			.update(
				JSON.stringify(["lookup-source-row-1", tableId, ...origin, sourceId]),
			)
			.digest()
			.subarray(0, 16),
	});
}

export function measureInventoryRow(row: InventoryRow) {
	const hash = createHash("sha256");
	let bytes = 0;
	for (const part of inventoryChunks(row)) {
		bytes += part.length;
		hash.update(part);
	}
	return { bytes, digest: hash.digest("hex") };
}
