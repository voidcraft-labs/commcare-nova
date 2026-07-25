// Pure derivations for the Project data workspace.
//
// Everything here is a function of its arguments — no React, no store, no
// network — so the workspace's decisions are unit-testable without mounting
// a grid. The rule the workspace follows: a derivation that decides what an
// author sees (a size, a capacity phrase, a conflict verdict) lives here, and
// the components only render it.

import {
	LOOKUP_MAX_ROWS,
	LOOKUP_MAX_TABLE_BYTES,
} from "@/lib/lookup/constants";
import type {
	LookupCellValue,
	LookupColumn,
	LookupDataType,
	LookupRow,
	LookupRowValues,
} from "@/lib/lookup/types";

/**
 * A stored size in the units a person reads, from exact bytes.
 *
 * Binary units, because every cap in `lib/lookup/constants` is binary
 * (8 MiB is 8 × 1024²) — reporting a 8,388,608-byte ceiling as "8.4 MB"
 * beside a limit written as "8 MB" is the kind of mismatch that makes a
 * refusal look wrong. One decimal place above a kilobyte; bytes are exact.
 */
export function formatStorageSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "an unknown size";
	if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
	const kib = bytes / 1024;
	if (kib < 1024) return `${roundToOneDecimal(kib)} KB`;
	return `${roundToOneDecimal(kib / 1024)} MB`;
}

function roundToOneDecimal(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** A count with its noun, so call sites never hand-assemble "1 rows". */
export function formatCount(count: number, singular: string): string {
	return `${count.toLocaleString()} ${count === 1 ? singular : `${singular}s`}`;
}

/**
 * How full a table is against the two caps that can actually stop a write.
 *
 * Both are reported, because they bind independently: 5,000 short rows hit
 * the row cap with bytes to spare, and 400 long ones hit the byte cap with
 * rows to spare. A surface that shows only one leaves the author guessing
 * which limit refused them.
 */
export interface TableCapacity {
	readonly rowCount: number;
	readonly rowLimit: number;
	readonly dataBytes: number;
	readonly byteLimit: number;
	/** The larger of the two utilizations, 0–1, for one at-a-glance meter. */
	readonly fullness: number;
	/** True once either cap is reached — no further row can be added. */
	readonly full: boolean;
}

export function tableCapacity(table: {
	readonly rowCount: number;
	readonly dataBytes: number;
}): TableCapacity {
	const byRows = table.rowCount / LOOKUP_MAX_ROWS;
	const byBytes = table.dataBytes / LOOKUP_MAX_TABLE_BYTES;
	return {
		rowCount: table.rowCount,
		rowLimit: LOOKUP_MAX_ROWS,
		dataBytes: table.dataBytes,
		byteLimit: LOOKUP_MAX_TABLE_BYTES,
		fullness: Math.min(1, Math.max(byRows, byBytes)),
		full:
			table.rowCount >= LOOKUP_MAX_ROWS ||
			table.dataBytes >= LOOKUP_MAX_TABLE_BYTES,
	};
}

/**
 * Why a table cannot take another row, in the author's words, or
 * `undefined` when it can. Names the measured size against the limit rather
 * than saying "full", so the author knows which one to act on.
 */
export function rowAdditionRefusal(
	capacity: TableCapacity,
): string | undefined {
	if (capacity.rowCount >= capacity.rowLimit) {
		return `This table already holds its limit of ${capacity.rowLimit.toLocaleString()} rows. Remove a row, or split the data across two tables.`;
	}
	if (capacity.dataBytes >= capacity.byteLimit) {
		return `This table already holds ${formatStorageSize(capacity.dataBytes)}, which is its limit of ${formatStorageSize(capacity.byteLimit)}. Shorten some values, remove a row, or split the data across two tables.`;
	}
	return undefined;
}

/** The author-facing name of a column's type, in the workspace's vocabulary. */
export const COLUMN_TYPE_LABELS: Readonly<Record<LookupDataType, string>> = {
	text: "Text",
	int: "Whole number",
	decimal: "Decimal number",
	date: "Date",
	time: "Time",
	datetime: "Date and time",
};

/**
 * One cell as text for display.
 *
 * A missing UUID key is a missing cell, and a missing cell is not the empty
 * string — the wire treats both as blank at evaluation, but an author
 * reading a grid needs to see which rows never had a value. The caller
 * decides how to render `undefined`; this function never invents "".
 */
export function cellText(
	values: LookupRowValues,
	column: LookupColumn,
): string | undefined {
	const raw: LookupCellValue | undefined = values[column.id];
	if (raw === undefined) return undefined;
	return typeof raw === "number" ? String(raw) : raw;
}

/**
 * How many rows one page of the grid shows.
 *
 * Matched to the running case list's own page size so the two row surfaces
 * behave alike rather than each picking a number.
 */
export const ROWS_PER_PAGE = 50;

/**
 * The rows whose displayed text contains `query`, in authored order.
 *
 * Matching runs over the SAME text `cellText` renders, so a row a person can
 * see is a row they can find — searching stored values instead would miss a
 * number the grid shows as text, and a missing cell would silently match the
 * empty string. Case-insensitive and whitespace-trimmed; an empty query
 * matches everything rather than nothing.
 */
export function filterRows<Row extends { readonly values: LookupRowValues }>(
	rows: readonly Row[],
	columns: readonly LookupColumn[],
	query: string,
): readonly Row[] {
	const needle = query.trim().toLocaleLowerCase();
	if (needle === "") return rows;
	return rows.filter((row) =>
		columns.some((column) =>
			cellText(row.values, column)?.toLocaleLowerCase().includes(needle),
		),
	);
}

/**
 * Whether two rows carry the same stored cells.
 *
 * This is the question the conflict policy turns on: an optimistic-revision
 * mismatch means SOMETHING in the table changed, and comparing the row the
 * author started from against the row the server now holds is what separates
 * "a co-member edited a different row" from "a co-member edited this one".
 * Key order is irrelevant — the stored object is a UUID-keyed map.
 */
export function rowValuesEqual(
	left: LookupRowValues,
	right: LookupRowValues,
): boolean {
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	return leftKeys.every(
		(key) =>
			Object.hasOwn(right, key) &&
			left[key as keyof LookupRowValues] ===
				right[key as keyof LookupRowValues],
	);
}

/**
 * What the workspace does with a write the server refused on revision drift.
 *
 * A lookup table's optimistic token is `max(definitionRevision, rowsRevision)`,
 * so ANY concurrent change to the table invalidates it — including one to a
 * row the author never touched. Treating every drift as a conflict a human
 * must resolve would put a dialog in front of edits that do not conflict at
 * all; silently retrying every drift would let one author's save overwrite a
 * co-member's edit to the same row. The rule is the middle: retry
 * automatically only when the fresh state proves the author's edit is still
 * the same edit, and otherwise show both values and let them choose.
 */
export type ConflictVerdict =
	/** Nobody touched what this write is about — resend against the fresh
	 *  revision. The author sees a save that took a moment longer. */
	| { readonly kind: "retry" }
	/** The write's subject changed underneath. The author's draft is kept and
	 *  presented beside the stored value. */
	| { readonly kind: "ask"; readonly reason: ConflictReason }
	/** The write's subject is gone. There is nothing to overwrite and nothing
	 *  to compare, so the draft is offered as a new row instead. */
	| { readonly kind: "gone" };

export type ConflictReason =
	| "row-changed"
	| "columns-changed"
	| "table-replaced";

/**
 * Decide what to do about a refused single-row write.
 *
 * `baseline` is the row as it stood when the author began editing; `current`
 * is the row the freshly re-read table now holds. `columnsChanged` covers the
 * definition axis — a retype or a removed column changes what the author's
 * draft even means, so it is never resent without asking.
 */
export function rowWriteConflictVerdict(args: {
	readonly baseline: LookupRowValues;
	readonly current: LookupRow | undefined;
	readonly columnsChanged: boolean;
}): ConflictVerdict {
	if (args.current === undefined) return { kind: "gone" };
	if (args.columnsChanged) {
		return { kind: "ask", reason: "columns-changed" };
	}
	return rowValuesEqual(args.baseline, args.current.values)
		? { kind: "retry" }
		: { kind: "ask", reason: "row-changed" };
}

/**
 * Decide what to do about a refused whole-table replacement (a CSV import).
 *
 * Never `retry`. A replacement discards every existing row by definition, so
 * "the table changed underneath" is exactly the case where resending would
 * destroy the change. The author re-confirms against what the table now
 * holds.
 */
export function replacementConflictVerdict(): ConflictVerdict {
	return { kind: "ask", reason: "table-replaced" };
}

/** Whether two column lists are the same definition, in the same order. */
export function columnsEqual(
	left: readonly LookupColumn[],
	right: readonly LookupColumn[],
): boolean {
	return (
		left.length === right.length &&
		left.every((column, index) => {
			const other = right[index];
			return (
				column.id === other.id &&
				column.wireName === other.wireName &&
				column.label === other.label &&
				column.dataType === other.dataType
			);
		})
	);
}
