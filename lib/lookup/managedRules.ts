/**
 * The rules of a lookup table CommCare HQ manages that need no store: the
 * caps a candidate table is judged against, a column's label, and what
 * `lib/lookup` reads of the canonical value `lib/deployment` stores for the
 * table's last refresh.
 *
 * Pure: nothing here reaches Postgres, CommCare HQ or the bucket, so the
 * findings of a reading and the writers in `managed.ts` judge one table the
 * same way.
 */

import { z } from "zod";
import type { LookupColumnId } from "@/lib/domain/lookupIds";
import {
	LOOKUP_MAX_CELL_BYTES,
	LOOKUP_MAX_COLUMN_LABEL_LENGTH,
	LOOKUP_MAX_COLUMNS,
	LOOKUP_MAX_ROW_BYTES,
	LOOKUP_MAX_ROWS,
	LOOKUP_MAX_TABLE_BYTES,
} from "./constants";
import { formatLookupBytes, formatLookupBytesOverCap } from "./format";
import { utf8ByteLength } from "./schema";
import type { LookupHqOrigin, LookupManifestHqOrigin } from "./types";

/** What Postgres measured of a table's candidate rows. */
export interface LookupRowsMeasure {
	readonly dataBytes: number;
	readonly largestRowBytes: number;
}

/** CommCare HQ's columns and rows of one table, as a copy takes them. */
export interface ManagedLookupContent {
	/** CommCare HQ's field names in its order; each passes `lookupWireNameSchema`. */
	readonly fields: readonly string[];
	/** Rows in CommCare HQ's order: field name to the cell's string. */
	readonly rows: readonly Readonly<Record<string, string>>[];
}

/** What lib/lookup reads of the stored state. */
export const managedCanonicalSchema = z.looseObject({
	digest: z.string().regex(/^[0-9a-f]{64}$/),
	fields: z.array(z.looseObject({ name: z.string() })),
});

function count(value: number): string {
	return value.toLocaleString("en-US");
}

/**
 * Each cap of the table below that the content is over, as that cap's phrase
 * without the tag and its colon, in the table's order; empty where it is
 * within all five. Pure.
 *
 * Rows, columns and cells are counted here; a row's and the table's stored
 * size are Postgres's measure (`managed.ts::measureLookupRows`), never a
 * guess. A cell of a field the definition does not name is not counted: no
 * device receives it.
 */
export function lookupCapExcess(
	content: ManagedLookupContent,
	measured: LookupRowsMeasure,
): readonly string[] {
	const phrases: string[] = [];
	if (content.rows.length > LOOKUP_MAX_ROWS) {
		phrases.push(
			`${count(content.rows.length)} rows (Nova takes ${count(LOOKUP_MAX_ROWS)})`,
		);
	}
	if (content.fields.length > LOOKUP_MAX_COLUMNS) {
		phrases.push(
			`${count(content.fields.length)} columns (Nova takes ${count(LOOKUP_MAX_COLUMNS)})`,
		);
	}
	let largestCellBytes = 0;
	for (const row of content.rows) {
		for (const field of content.fields) {
			if (!Object.hasOwn(row, field)) continue;
			const bytes = utf8ByteLength(row[field]);
			if (bytes > largestCellBytes) largestCellBytes = bytes;
		}
	}
	if (largestCellBytes > LOOKUP_MAX_CELL_BYTES) {
		phrases.push(
			`a value of ${formatLookupBytesOverCap(largestCellBytes)} (Nova takes ${formatLookupBytes(LOOKUP_MAX_CELL_BYTES)} in one cell)`,
		);
	}
	if (measured.largestRowBytes > LOOKUP_MAX_ROW_BYTES) {
		phrases.push(
			`a row of ${formatLookupBytesOverCap(measured.largestRowBytes)} (Nova takes ${formatLookupBytes(LOOKUP_MAX_ROW_BYTES)} in one row)`,
		);
	}
	if (measured.dataBytes > LOOKUP_MAX_TABLE_BYTES) {
		phrases.push(
			`${formatLookupBytesOverCap(measured.dataBytes)} of rows (Nova takes ${formatLookupBytes(LOOKUP_MAX_TABLE_BYTES)} in one table)`,
		);
	}
	return phrases;
}

/** The sentence a writer of a managed copy refuses with when the table is over a cap. */
export function managedLookupCapRefusal(
	tag: string,
	phrases: readonly string[],
): string {
	return `The lookup table ${tag} has ${phrases.join(" and ")} in CommCare HQ, so Nova can't hold a copy of it.`;
}

/**
 * A column's label for a field of CommCare HQ's: the name's first 120
 * characters. The wire name carries the whole name; a label longer than 120
 * would fail `lookup_columns`' label check. PostgreSQL counts Unicode scalars.
 */
export function columnLabelFor(name: string): string {
	return [...name].slice(0, LOOKUP_MAX_COLUMN_LABEL_LENGTH).join("");
}

/** The origin columns of a stored table, as every reader selects them. */
export interface StoredLookupHqColumns {
	readonly hq_server: string | null;
	readonly hq_domain: string | null;
	readonly hq_remote_id: string | null;
	readonly hq_canonical: unknown;
	readonly hq_brought_in_at: Date | null;
	readonly hq_refreshed_at: Date | null;
	readonly hq_taken_over_at: Date | null;
	readonly hq_taken_over_by: string | null;
}

function partOfAnOrigin(): never {
	throw new Error(
		"A lookup table's CommCare HQ origin was stored only in part.",
	);
}

/**
 * A stored table's origin as the manifest carries it, or undefined for a
 * table made in Nova. It leaves out the day of the last refresh, which a
 * refresh that changed nothing stamps without advancing the Project
 * revision.
 */
export function lookupManifestHqOriginOf(
	table: StoredLookupHqColumns,
): LookupManifestHqOrigin | undefined {
	if (table.hq_server === null) return undefined;
	if (
		table.hq_domain === null ||
		table.hq_remote_id === null ||
		table.hq_brought_in_at === null ||
		table.hq_refreshed_at === null
	) {
		partOfAnOrigin();
	}
	return {
		server: table.hq_server,
		domain: table.hq_domain,
		remoteId: table.hq_remote_id,
		managedBy: table.hq_taken_over_at === null ? "commcare-hq" : "nova",
		broughtInAt: table.hq_brought_in_at.toISOString(),
		takenOverAt: table.hq_taken_over_at?.toISOString() ?? null,
		takenOverBy: table.hq_taken_over_by,
	};
}

/**
 * A stored table's origin, or undefined for a table made in Nova. While
 * CommCare HQ manages the table, `goneColumnIds` is every column whose wire
 * name is in no field of CommCare HQ's table at the last refresh. A table
 * Nova manages has none: its stored copy of CommCare HQ's table is not read
 * again while Nova manages it, so a column added or renamed in Nova would
 * otherwise read as gone from CommCare HQ though it was never there.
 */
export function lookupHqOriginOf(
	table: StoredLookupHqColumns,
	columns: readonly {
		readonly id: LookupColumnId;
		readonly wireName: string;
	}[],
): LookupHqOrigin | undefined {
	const origin = lookupManifestHqOriginOf(table);
	if (origin === undefined) return undefined;
	if (table.hq_refreshed_at === null) partOfAnOrigin();
	const goneColumnIds: LookupColumnId[] = [];
	if (origin.managedBy === "commcare-hq") {
		const canonical = managedCanonicalSchema.parse(table.hq_canonical);
		const fields = new Set(canonical.fields.map((field) => field.name));
		for (const column of columns) {
			if (!fields.has(column.wireName)) goneColumnIds.push(column.id);
		}
	}
	return {
		...origin,
		refreshedAt: table.hq_refreshed_at.toISOString(),
		goneColumnIds,
	};
}
