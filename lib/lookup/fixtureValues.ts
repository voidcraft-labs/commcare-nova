import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import {
	type LookupRowId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupMemberIdSchema,
} from "@/lib/domain/lookupIds";
import { LookupError } from "./errors";
import type { LookupValueSlot } from "./largeValues/input";
import { valueBytes } from "./largeValues/value";
import type { LookupFixtureRow } from "./types";

/** Browser and App Test memory admission. Large artifacts use the streaming
 * carrier instead. Count authorized rows only, including non-inline atoms. */
export const DEVICE_FIXTURE_BYTES = 32 * 1024 * 1024;
export function chargeDeviceFixture(
	bytes: number,
	remaining: { bytes: number },
) {
	if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > remaining.bytes)
		throw new LookupError(
			"storage_limit",
			"The complete lookup data exceeds this device’s capacity. You can use a worker with a smaller assignment or open Project data to inspect the table.",
		);
	remaining.bytes -= bytes;
}

export function slotFromStoragePath(path: readonly string[]): LookupValueSlot {
	if (path[0] === "attribute" && path.length === 2)
		return {
			kind: "attribute",
			attributeId: lookupMemberIdSchema.parse(path[1]),
		};
	const columnId = lookupColumnIdSchema.parse(path[1]);
	if (path[0] === "cell" && path.length === 2)
		return { kind: "cell", columnId };
	const index = Number(path[2]);
	if (Number.isSafeInteger(index) && index >= 0) {
		if (path[0] === "occurrence" && path.length === 3)
			return { kind: "occurrence", columnId, index };
		if (path[0] === "property" && path.length === 4)
			return {
				kind: "property",
				columnId,
				index,
				propertyId: lookupMemberIdSchema.parse(path[3]),
			};
	}
	throw new Error("A stored lookup value has an invalid slot.");
}
interface Atom {
	row_id: LookupRowId;
	slot: string[];
	value_id: string;
	digest: string;
	total_bytes: string;
}

/** Read only cells selected by the worker grant. The caller owns the
 * repeatable-read snapshot for the rows, refs, and immutable byte segments. */
export async function hydrateFixtureRows(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	rows: readonly LookupFixtureRow[],
	remaining: { bytes: number },
) {
	const selected = new Map(rows.map((row) => [row.id, row]));
	for (let index = 0; index < rows.length; index += 128) {
		const ids = rows.slice(index, index + 128).map((row) => row.id);
		const refs =
			await sql<Atom>`SELECT row_id,slot,value_id,digest,total_bytes::text FROM lookup_cell_value_refs WHERE project_id=${projectId} AND table_id=${tableId} AND row_id=ANY(${ids}::uuid[]) ORDER BY row_id,slot`.execute(
				tx,
			);
		for (const ref of refs.rows) {
			const row = selected.get(ref.row_id);
			if (!row) throw new Error("A lookup value belongs to another row.");
			const slot = slotFromStoragePath(ref.slot);
			const length = Number(ref.total_bytes);
			chargeDeviceFixture(length, remaining);
			const decoder = new TextDecoder("utf-8", {
				fatal: true,
				ignoreBOM: true,
			});
			const parts: string[] = [];
			const hash = createHash("sha256");
			for await (const chunk of valueBytes(
				tx,
				{ projectId, tableId, rowId: row.id, slot },
				{ ...ref, data_type: "text" },
				0,
				length,
			)) {
				hash.update(chunk);
				parts.push(decoder.decode(chunk, { stream: true }));
			}
			parts.push(decoder.decode());
			if (hash.digest("hex") !== ref.digest)
				throw new Error(
					"The stored lookup bytes no longer match their recorded digest.",
				);
			const text = parts.join("");
			if (slot.kind === "cell") row.values[slot.columnId] = text;
			else if (slot.kind === "attribute" && row.attributes)
				row.attributes[slot.attributeId] = text;
			else if (slot.kind === "occurrence" || slot.kind === "property") {
				const item = row.occurrences?.[slot.columnId]?.[slot.index];
				if (!item)
					throw new Error(
						"The stored value no longer belongs to an occurrence.",
					);
				if (slot.kind === "occurrence") item.text = text;
				else item.properties[slot.propertyId] = text;
			} else
				throw new Error("The stored value no longer belongs to a row detail.");
		}
	}
}
